import { readFile, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Client, context, config, defaults } from './client.mjs';
import { value, json, save, lease, alive, iso } from './git.mjs';

// Status is a read-only filesystem snapshot: it must not look like Git activity.
export async function status(root) {
  const result = {
    version: 1, manager: process.env.INFOHUB_SYNC_MANAGER === 'docker' ? 'docker' : 'workbench', backoff: {}, running: false, installed: null, pid: null, settings: null,
    log: null, clone: null, startedAt: null, checkedAt: null, finishedAt: null,
    idleSince: null, lastFetch: null, lastPull: null, lastDraft: null,
    lastCommit: null, lastPush: null, lastDraftCleanup: null,
    draft: null, cleanedDraft: null, dirtyFiles: [], blockedFiles: [], server: null, pending: {},
  };
  try {
    const dir = path.join(await realpath(root), '.git');
    // Only an absent configuration is "not enabled". Invalid repositories and
    // unreadable/corrupt state are errors, never an empty healthy snapshot.
    if (!(await stat(dir)).isDirectory()) throw new Error('后台同步只支持普通 Git 副本');
    const home = path.join(dir, 'infohub-sync');
    const absent = Symbol('absent');
    const settings = await json(path.join(home, 'config.json'), absent);
    result.installed = settings === absent ? false : null;
    if (settings !== absent) {
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('后台配置必须是对象');
      result.installed = true;
      result.settings = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, settings[key] ?? fallback]));
      if (Object.values(result.settings).some(value => !Number.isFinite(value) || value <= 0)) throw new Error('后台周期必须是正数');
    }
    const state = await json(path.join(home, 'state.json'), {});
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('后台状态必须是对象');
    if (state.pending != null && (typeof state.pending !== 'object' || Array.isArray(state.pending) || Object.values(state.pending).some(value => typeof value !== 'string'))) throw new Error('后台 pending 格式无效');
    for (const key of ['log', 'startedAt', 'checkedAt', 'finishedAt', 'idleSince', 'lastFetch', 'lastPull', 'lastDraft', 'lastCommit', 'lastPush', 'lastDraftCleanup', 'draft', 'cleanedDraft']) result[key] = state[key] ?? null;
    if (['docker', 'workbench'].includes(state.manager)) result.manager = state.manager;
    result.backoff = state.backoff || {};
    if (state.clone) {
      const { id, machine, user, root } = state.clone;
      result.clone = { id, machine, user, root };
    }
    result.dirtyFiles = state.dirtyFiles ?? [];
    result.blockedFiles = state.blockedFiles ?? [];
    result.pending = state.pending ?? {};
    if (state.server) {
      const { checkedAt, main, drafts } = state.server;
      result.server = { checkedAt, main, drafts };
    }
    let pid;
    try { pid = Number(await readFile(path.join(home, 'daemon.pid'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0)) throw new Error('后台 PID 文件无效');
    result.running = Boolean(pid && alive(pid));
    result.pid = result.running ? pid : null;
  } catch (error) { result.pending.status = error.message; }
  return result;
}

export async function concerns(root) {
  const s = await status(root);
  const lines = Object.entries(s.pending || {}).map(([kind, reason]) => `InfoHub 同步/${kind}：${reason}`);
  if (!s.running) lines.push(s.manager === 'docker' ? 'InfoHub 同步：未运行，请检查 infohub-sync 容器' : 'InfoHub 同步：未运行，请启动 InfoHub Workbench');
  if (s.running && Date.now() - Date.parse(s.finishedAt || s.startedAt) > 120000) lines.push('InfoHub 同步：本机状态超过 2 分钟未更新，请检查日志');
  const seenOverlaps = new Set();
  for (const d of s.server?.drafts || []) {
    for (const overlap of d.overlaps || []) {
      const pair = [d.ref, overlap.ref].sort().join('\0');
      if (seenOverlaps.has(pair)) continue;
      seenOverlaps.add(pair);
      lines.push(`InfoHub 草稿 ${d.source || d.id} 与 ${overlap.source || overlap.ref}：共同改动路径 ${overlap.paths.join(', ')}；${overlap.error ? `试合并失败: ${overlap.error}` : overlap.mergeable ? 'Git 试合并无文本冲突' : `Git 冲突: ${overlap.conflicts.join(', ') || '未返回路径'}`} — ${d.ref} / ${overlap.ref}`);
    }
    if (d.conflicts?.length || d.error || d.stale) lines.push(`InfoHub 草稿 ${d.source || d.id}：${d.error || (d.conflicts?.length ? `与 main 冲突: ${d.conflicts.join(', ')}` : '')}${d.stale ? '；长期搁置，请交用户决定合入或丢弃' : ''} — ${d.ref}`);
  }
  return lines;
}
export async function command(root, args) {
  const action = args[0] || 'status';
  if (action === 'status') { console.log(JSON.stringify(await status(root), null, 2)); return; }
  if (action === 'logs') { console.log((await status(root)).log || '同步在前台输出日志；桌面请查看工作台日志，服务器请使用 docker logs infohub-sync'); return; }
  if (action !== 'run') throw new Error('用法: infohub sync run|status|logs。桌面由 InfoHub Workbench 托管，服务器由 Docker 托管。');
  const overrides = {}; let includeExisting = false, parentStdio = false;
  for (let i = 1; i < args.length; i++) {
    const key = { '--fetch-seconds': 'fetchSeconds', '--draft-seconds': 'draftSeconds', '--idle-seconds': 'idleSeconds' }[args[i]];
    if (args[i] === '--include-existing') includeExisting = true;
    else if (args[i] === '--parent-stdio') parentStdio = true;
    else if (key && args[i + 1]) overrides[key] = Number(args[++i]);
    else throw new Error(`未知选项或缺少值: ${args[i]}`);
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  if (parentStdio) { process.stdin.on('end', stop); process.stdin.on('data', stop); process.stdin.resume(); }
  let release;
  try {
    const ctx = await context(root, abort.signal);
    await mkdir(ctx.home, { recursive: true });
    release = await lease(path.join(ctx.home, 'daemon.pid'));
    const settings = await config(ctx, overrides);
    if (!await json(path.join(ctx.home, 'config.json')) && !includeExisting
      && await value(ctx, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('首次启用检测到未提交内容；确认允许闲置自动提交后，用 sync run --include-existing 完成首次启用');
    await save(path.join(ctx.home, 'config.json'), settings);
    const client = await Client.open(root, settings, abort.signal);
    client.state.manager = process.env.INFOHUB_SYNC_MANAGER === 'docker' ? 'docker' : 'workbench';
    client.state.log = process.env.INFOHUB_SYNC_LOG || null;
    await save(path.join(ctx.home, 'state.json'), client.state);
    while (!abort.signal.aborted) {
      await client.tick();
      if (!abort.signal.aborted) await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, settings.fetchSeconds * 1000);
        abort.signal.addEventListener('abort', finish, { once: true });
      });
    }
  } catch (error) { if (!abort.signal.aborted) throw error; }
  finally {
    if (release) await release();
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    if (parentStdio) { process.stdin.removeListener('end', stop); process.stdin.removeListener('data', stop); process.stdin.pause(); }
  }
}
