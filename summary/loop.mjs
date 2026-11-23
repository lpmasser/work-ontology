import { spawn } from 'node:child_process';
import { open, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadVault } from '../core/vault.mjs';
import { currentRuntime } from '../core/runtime.mjs';
import { json, save, lease, alive, iso } from '../sync/git.mjs';
import { subscriptions, plan, digest, fingerprint, summaryText, threadId } from '../core/summary.mjs';
import { listChildren, watchedIds, send } from './codexhost.mjs';

export const TICK_MS = 60_000;
// 一小时没有任何在跑的会话就退出，下一次 brief/check 再拉起。
export const IDLE_EXIT_MS = 60 * 60_000;

export async function summaryHome(root) {
  return path.join(await realpath(root), '.git/infohub-summary');
}

export async function readOptOut(root) {
  return json(path.join(await summaryHome(root), 'optout.json'), {});
}

// 退订记在当时的负责会话名下：换了负责会话，新人自动订上。
export async function setSubscription(root, work, subscribed) {
  const file = path.join(await summaryHome(root), 'optout.json');
  const optOut = await json(file, {});
  if (subscribed) delete optOut[work.id];
  else optOut[work.id] = work.owner;
  await save(file, optOut);
}

async function isRunning(dir) {
  const pid = Number(await readFile(path.join(dir, 'summary.pid'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }));
  return Boolean(pid && alive(pid));
}

export async function ensureSummary(root, { cli }) {
  if (!cli) return;
  const dir = await summaryHome(root);
  if (await isRunning(dir)) return;
  await mkdir(dir, { recursive: true });
  const log = await open(path.join(dir, 'summary.log'), 'a', 0o600);
  try {
    const child = spawn(currentRuntime()?.node || process.execPath,
      [path.resolve(import.meta.dirname, '../cli/infohub.mjs'), '--root', root, 'summary', 'run'], {
        cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
        env: { ...process.env, INFOHUB_SUMMARY_CLI: cli },
      });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
    child.unref();
  } finally { await log.close(); }
}

// 看一次：新订上的（含换了负责会话的）马上发一份，其余每 15 分钟看一次、有变化才发。
// 这台机器第一次跑时只记下现状、不发，免得把所有进行中工作的负责会话都叫醒一遍。
export async function tick(root, cli, state, now) {
  const vault = await loadVault(root);
  const works = subscriptions(vault.index, await readOptOut(root));
  const bootstrap = !state.entries;
  const { entries, due } = plan(works, state.entries ?? {}, now);
  let active = false, pending = false;
  if (due.length) {
    const watched = await watchedIds(cli);
    for (const { work, entry, first } of due) {
      let facts;
      try {
        const lists = await Promise.all([entry.owner, ...entry.previous].map(owner => listChildren(cli, threadId(owner))));
        facts = digest(lists.flat(), watched, entry.checkedAt);
      } catch (error) {
        console.log(`${iso()} ${work.id} 这次没看成：${error.message}`);
        entry.checkedAt = now.toISOString();
        continue;
      }
      if (facts.running.length) active = true;
      const print = fingerprint(work, facts);
      if (!bootstrap && (first || print !== entry.fingerprint)) {
        // 对方正忙：不插话，下一分钟再试。
        if (!await send(cli, threadId(work.owner), summaryText(work, facts, { first }))) { pending = true; continue; }
      }
      entry.checkedAt = now.toISOString();
      entry.fingerprint = print;
    }
  }
  return { entries, pending, lastActiveAt: active || !state.lastActiveAt ? now.toISOString() : state.lastActiveAt };
}

async function holdsLease(file) {
  return await readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  }) === String(process.pid);
}

function pause(ms, signal) {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export async function runSummary(root, { cli = process.env.INFOHUB_SUMMARY_CLI, tickMs = TICK_MS, now = () => new Date(), signal } = {}) {
  if (!cli) throw new Error('没有 codexhost CLI，工作汇总未启用');
  const dir = await summaryHome(root);
  const pidFile = path.join(dir, 'summary.pid'), stateFile = path.join(dir, 'state.json');
  const release = await lease(pidFile, { ifBusy: true });
  if (!release) return;
  try {
    while (!signal?.aborted) {
      if (!await holdsLease(pidFile)) return;
      const at = now();
      try {
        const next = await tick(root, cli, await json(stateFile, {}), at);
        await save(stateFile, next);
        if (!next.pending && at.getTime() - Date.parse(next.lastActiveAt) >= IDLE_EXIT_MS) {
          console.log(`${iso()} 一小时没有在跑的会话，退出工作汇总`);
          return;
        }
      } catch (error) {
        console.log(`${iso()} 这一次没看成：${error.message}`);
      }
      await pause(tickMs, signal);
    }
  } finally { await release(); }
}
