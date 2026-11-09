import { spawn } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Client, context, config } from './client.mjs';
import { status, ON_DEMAND_IDLE_SECONDS } from './command.mjs';
import { currentRuntime } from '../core/runtime.mjs';
import { json, lease, save, value, iso } from './git.mjs';

// Only the short opening refresh is bounded here; loop network backoff stays in Client.
export async function ensureOnDemand(root, { refresh = false, timeoutMs = 10000, exitSeconds = ON_DEMAND_IDLE_SECONDS } = {}) {
  let release;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let ctx, reason;
  try {
    const s = await status(root);
    if (s.manager === 'docker') return { reason: s.running ? null : '服务器同步由 Docker 托管，请检查同步容器' };
    if (s.running) return { reason: refresh ? '已有同步循环运行，本次跳过独占拉取，由该循环持续同步' : null };
    ctx = await context(root, abort.signal);
    release = await lease(path.join(ctx.home, 'daemon.pid'), { ifBusy: true });
    if (!release) return { reason: refresh ? '另一 Agent 正在同步，本次跳过独占拉取' : null };
    const settings = await config(ctx);
    if (!await json(path.join(ctx.home, 'config.json')) && await value(ctx, ['status', '--porcelain', '--untracked-files=all'])) {
      throw new Error('首次启用检测到未提交内容；确认允许闲置自动提交后，用 infohub sync run --include-existing 完成首次启用');
    }
    await save(path.join(ctx.home, 'config.json'), settings);
    if (refresh) {
      const client = await Client.open(root, settings, abort.signal);
      try {
        const result = await client.refresh();
        if (result) client.state.dirtyFiles = result.fp.files;
        reason = Object.entries(client.state.pending).filter(([kind]) => kind !== 'server').map(([, text]) => text).join('；');
        if (!result && !reason) reason = '本轮未拉取';
      } finally {
        client.state.manager = 'on-demand';
        client.state.finishedAt = iso();
        await save(path.join(ctx.home, 'state.json'), client.state);
      }
    }
  } catch (error) {
    reason = abort.signal.aborted ? `开工同步超过 ${timeoutMs / 1000} 秒，已跳过` : error.message;
    if (!ctx || !refresh || !abort.signal.aborted) return { reason };
  } finally {
    clearTimeout(timer);
    if (release) await release();
  }
  // Losing starters return through the same daemon PID lease in sync run.
  const logFile = path.join(ctx.home, 'sync.log');
  await mkdir(ctx.home, { recursive: true });
  const log = await open(logFile, 'a', 0o600);
  try {
    const child = spawn(currentRuntime()?.node || process.execPath, [path.resolve(import.meta.dirname, '../cli/infohub.mjs'), '--root', root, 'sync', 'run', '--on-demand', '--exit-after-seconds', String(exitSeconds)], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, INFOHUB_SYNC_MANAGER: 'on-demand', INFOHUB_SYNC_LOG: logFile },
    });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
    child.unref();
  } finally { await log.close(); }
  return { reason };
}
