import { open, readFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { alive } from './git.mjs';

// Opted-in server clones share this short-lived lock with the HTTP writer.
// Host PID namespace is required when the two owners run in separate containers.
export async function withWorkspaceLock(root, action, { signal, timeoutMs = 5000 } = {}) {
  const folder = path.join(root, '.git', 'infohub-sync');
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, 'workspace.pid');
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    signal?.throwIfAborted();
    try {
      handle = await open(file, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = Number(await readFile(file, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (pid && !alive(pid)) {
        // Reapers serialize too: two callers must never unlink a newly acquired
        // lock after both observed the same dead owner. A crashed reaper fails closed.
        let reaper;
        try {
          reaper = await open(`${file}.reaper`, 'wx', 0o600);
          const current = Number(await readFile(file, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; return ''; }));
          if (current && !alive(current)) await unlink(file);
        } catch (e) { if (!['EEXIST', 'ENOENT'].includes(e.code)) throw e; }
        finally { if (reaper) { await reaper.close(); await unlink(`${file}.reaper`); } }
      }
      if (Date.now() >= deadline) throw Object.assign(new Error('工作区正在更新，请重试'), { code: 'WORKSPACE_BUSY' });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await action(); }
  finally { await handle.close(); await unlink(file); }
}
