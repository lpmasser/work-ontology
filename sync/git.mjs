import { run } from '../core/process.mjs';
import { activeGit } from './git-process.mjs';
export { run } from '../core/process.mjs';
import { readFile, writeFile, rename, mkdir, readdir, stat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const DRAFT_PREFIX = 'refs/heads/infohub-drafts/';
export const STATUS_REF = 'refs/heads/infohub-status';
export const REMOTE_PREFIX = 'refs/infohub/remote/';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const iso = () => new Date().toISOString();


const queues = new Map();
const rootPath = root => typeof root === 'string' ? root : root.root;

// Every synchronization Git command for a clone waits for the preceding child
// (and its terminated descendants) to exit. Different clones remain independent.
export function git(subject, args, options = {}) {
  const root = rootPath(subject);
  const prior = queues.get(root) || Promise.resolve();
  const task = prior.catch(() => {}).then(() => run('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
    signal: subject.signal, timeoutMs: args.some(a => ['fetch', 'push'].includes(a)) ? 60000 : 120000,
    processGroup: true, ...options, cwd: root,
    env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectionAttempts=1 -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2', ...options.env }
  }));
  const done = task.finally(() => { if (queues.get(root) === done) queues.delete(root); });
  queues.set(root, done);
  return done;
}

export async function value(root, args, options) { return (await git(root, args, options)).stdout.trim(); }
export async function json(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function save(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}
export async function exists(file) {
  try { await stat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// Only this application's lease is reclaimed. Git's locks are never removed.
export async function lease(file) {
  await mkdir(path.dirname(file), { recursive: true });
  for (let n = 0; n < 2; n++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => { if ((await readFile(file, 'utf8')) === String(process.pid)) await unlink(file); };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(await readFile(file, 'utf8'));
      if (!pid || alive(pid)) throw new Error(`后台实例仍在运行或锁未写完: ${file}`);
      await unlink(file);
    }
  }
  throw new Error(`无法取得后台锁: ${file}`);
}
export async function gitBusy(root) {
  const dir = await value(root, ['rev-parse', '--absolute-git-dir']);
  const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG'];
  for (const name of markers) if (await exists(path.join(dir, name))) return { reason: `git 操作进行中: ${name}`, inRepo: true };
  async function locks(folder) {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    for (const entry of entries) {
      if (entry.name.endsWith('.lock')) return `git 锁存在: ${path.relative(dir, path.join(folder, entry.name))}`;
      if (entry.isDirectory() && (folder !== dir || entry.name === 'refs')) {
        const found = await locks(path.join(folder, entry.name));
        if (found) return found;
      }
    }
    return null;
  }
  const locked = await locks(dir);
  if (locked) return { reason: locked, inRepo: true };
  return activeGit(rootPath(root), dir, root.signal);
}
export async function isAncestor(root, a, b) {
  const r = await git(root, ['merge-base', '--is-ancestor', a, b], { allowFailure: true });
  if (r.code > 1) throw new Error(r.stderr);
  return r.code === 0;
}
