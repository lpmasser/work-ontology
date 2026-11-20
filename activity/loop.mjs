import { spawn } from 'node:child_process';
import { open, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadVault } from '../core/vault.mjs';
import { currentRuntime } from '../core/runtime.mjs';
import { json, save, lease, alive, iso } from '../sync/git.mjs';
import { judgeActivity, describeWork, threadId, SUMMARY_INTERVAL_MS } from '../core/activity.mjs';
import { observeActivity } from './observe.mjs';
import { send } from './codexhost.mjs';

export const ACTIVITY_INTERVAL_MS = 60_000;

export async function activityHome(root) {
  return path.join(await realpath(root), '.git/infohub-activity');
}

// 后台每轮把判断结果写在这里：循环在跑且结果在一个检查间隔的两倍以内时，查询直接读它，
// 不必再读一遍所有会话。
export async function readActivityResult(root) {
  const state = await readActivityState(root);
  if (!state.running) return { state, result: null };
  const result = await json(path.join(await activityHome(root), 'result.json'), null);
  const fresh = result && Date.now() - Date.parse(result.observedAt) <= ACTIVITY_INTERVAL_MS * 2;
  return { state, result: fresh ? result : null };
}

export async function readActivityState(root) {
  const dir = await activityHome(root);
  const state = await json(path.join(dir, 'state.json'), {});
  const pid = Number(await readFile(path.join(dir, 'activity.pid'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }));
  return { ...state, running: Boolean(pid && alive(pid)) };
}

// 已启用的活动检查在这里继续跑；空闲时退出，下一次 brief/check 再拉起。
export async function ensureActivity(root, { cli }) {
  if (!cli) return;
  if ((await readActivityState(root)).running) return;
  const dir = await activityHome(root);
  await mkdir(dir, { recursive: true });
  const logFile = path.join(dir, 'activity.log');
  const log = await open(logFile, 'a', 0o600);
  try {
    const child = spawn(currentRuntime()?.node || process.execPath,
      [path.resolve(import.meta.dirname, '../cli/infohub.mjs'), '--root', root, 'activity', 'run'], {
        cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
        env: { ...process.env, INFOHUB_ACTIVITY_CLI: cli },
      });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
    child.unref();
  } finally { await log.close(); }
}

const excerpt = (text, size = 120) => text.length > size ? `${text.slice(0, size)}…` : text;
const clock = value => value.slice(11, 16);

function reminderText(index, exception) {
  const work = describeWork(index, exception.workId);
  const who = `${exception.executor.title}〔${exception.link}〕第 ${exception.turnNumber} 轮`;
  const ask = {
    deliver: '已结束五分钟，请读该轮结论接着做',
    escalate: `交付后，接手人 ${exception.primary} 提醒后五分钟仍未动，请接手或另派`,
    question: `停在提问框（interaction ${exception.interactionId}），请回答或找能裁决的人：${exception.detail}`,
    failure: `${exception.detail}，请决定续做或换人`,
    streak: `${exception.detail}，请判断原因`,
  }[exception.kind];
  return `${work.title} \`${work.id}\`，${who}${ask}。全貌见 \`infohub activity ${work.id}\`。`;
}

function summaryText(index, workId, rounds, conclusions, result) {
  const work = describeWork(index, workId);
  const from = result.works.find(entry => entry.id === workId)?.from;
  const lines = [`${work.title} \`${work.id}\` ${from ? clock(from) : '未观察'}–${clock(result.observedAt)}`];
  for (const round of rounds) lines.push(`当前轮 ${round.executor.title} #${round.turnNumber} 正在${round.progress ? `处理：${excerpt(round.progress)}` : '运行'}〔${round.link}〕`);
  for (const conclusion of conclusions) lines.push(`新增结论 ${conclusion.executor.title} #${conclusion.turnNumber}〔执行者报告〕“${excerpt(conclusion.text)}”〔${conclusion.link}〕`);
  lines.push(`全貌见 \`infohub activity ${work.id}\``);
  return lines.join('\n');
}

async function deliver(cli, recipient, text) {
  try {
    await send(cli, threadId(recipient), text);
    return true;
  } catch (error) {
    // 忙时保留变化供下个窗口一起看，其余 Host 错误照常暴露。
    if (/THREAD_BUSY/.test(error.message)) return false;
    throw error;
  }
}

async function remind(cli, index, result) {
  const nowMs = Date.parse(result.observedAt);
  const groups = new Map();
  for (const exception of result.exceptions) {
    if (exception.blocking || exception.reminded || exception.busy) continue;
    if (!groups.has(exception.recipient)) groups.set(exception.recipient, []);
    groups.get(exception.recipient).push(exception);
  }
  for (const items of groups.values()) {
    if (!await deliver(cli, items[0].recipient, items.map(item => reminderText(index, item)).join('\n'))) continue;
    for (const item of items) {
      // 记下发出提醒时对方读到哪儿：之后对方结束一轮提到执行者才算接住。
      const floor = result.state.threads?.[threadId(item.recipient)]?.seenThrough ?? 0;
      result.state.reminded.push({ key: item.key, recipient: item.recipient, at: result.observedAt, floor });
    }
  }

  for (const work of result.works) {
    if (!work.owner) continue;
    const fresh = result.conclusions.filter(conclusion => conclusion.workId === work.id && conclusion.isNew);
    if (!fresh.length) continue;
    const advance = () => {
      result.state.summary = { ...result.state.summary, [work.owner]: result.cursor[work.owner] ?? {} };
      result.state.summaryAt = { ...result.state.summaryAt, [work.owner]: result.summaryAt };
    };
    const since = result.state.summaryAt?.[work.owner];
    // 窗口从循环启动时开始：第一次只记位置，不把刚发生的轮次当成新变化叫醒负责会话。
    if (!since) { advance(); continue; }
    if (nowMs - Date.parse(since) < SUMMARY_INTERVAL_MS) continue;
    const rounds = result.rounds.filter(round => round.workId === work.id);
    if (!await deliver(cli, work.owner, summaryText(index, work.id, rounds, fresh, result))) continue;
    advance();
  }
}

async function tick(root, cli, state, clock, cache) {
  const vault = await loadVault(root);
  const snapshot = await observeActivity(cli, { index: vault.index, state, cache });
  const result = judgeActivity(vault.index, { threads: snapshot.threads, watches: snapshot.watches, now: clock(), state });
  result.state.threads = snapshot.positions;
  result.state.errors = snapshot.errors;
  // 这次观察成功了就不再显示上一次的失败。
  result.state.error = null;
  await remind(cli, vault.index, result);
  return result;
}

function pause(intervalMs, signal) {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, intervalMs);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export async function runActivity(root, { cli = process.env.INFOHUB_ACTIVITY_CLI, intervalMs = ACTIVITY_INTERVAL_MS, clock = () => new Date(), signal } = {}) {
  if (!cli) throw new Error('没有 codexhost CLI，活动检查未启用');
  const dir = await activityHome(root);
  await mkdir(dir, { recursive: true });
  const stateFile = path.join(dir, 'state.json'), resultFile = path.join(dir, 'result.json');
  const release = await lease(path.join(dir, 'activity.pid'), { ifBusy: true });
  if (!release) return;
  // 本进程内存里保留上一份会话快照：没变的会话不重复读。
  const cache = new Map();
  try {
    while (!signal?.aborted) {
      const state = await json(stateFile, {});
      let result;
      try {
        result = await tick(root, cli, state, clock, cache);
      } catch (error) {
        // 这一轮观察失败：写清错误，沿用上一份状态，下一个间隔照常再观察。
        const failures = (state.failures ?? 0) + 1;
        await save(stateFile, { ...state, failures, error: `第 ${failures} 次观察失败：${error.message}` });
        await pause(intervalMs, signal);
        continue;
      }
      result.state.lastSuccessAt = result.observedAt;
      result.state.failures = 0;
      await save(stateFile, result.state);
      await save(resultFile, {
        observedAt: result.observedAt, works: result.works,
        exceptions: result.exceptions, rounds: result.rounds, conclusions: result.conclusions,
      });
      if (result.settled) {
        console.log(`${iso()} 各轮已停且交件结清，退出活动检查`);
        return;
      }
      await pause(intervalMs, signal);
    }
  } finally { await release(); }
}
