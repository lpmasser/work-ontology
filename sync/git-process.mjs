// OS facilities live here; the synchronization state machine is platform-neutral.
import { readFile, readlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../core/process.mjs';

const within = (base, child) => { const rel = path.relative(base, child); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
const inRepo = (cwd, root, dir) => within(root, cwd) || within(dir, cwd);

export async function activeGit(root, dir, signal) {
  if (process.platform === 'darwin') {
    const result = await run('lsof', ['-a', '-c', 'git', '-d', 'cwd', '-Fpn'], { allowFailure: true, signal, timeoutMs: 10000, processGroup: true });
    if (result.code > 1 || result.stderr.trim()) throw new Error(`无法检查活动 Git 进程: ${result.stderr}`);
    let pid;
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('p')) pid = line.slice(1);
      if (line.startsWith('n') && inRepo(line.slice(1), root, dir)) return { reason: `git 进程运行中: PID ${pid}`, inRepo: true };
    }
  } else if (process.platform === 'linux') {
    for (const pid of await readdir('/proc')) {
      signal?.throwIfAborted();
      if (!/^\d+$/.test(pid)) continue;
      try {
        if (!/^git(?:-|$)/.test((await readFile(`/proc/${pid}/comm`, 'utf8')).trim())) continue;
        const cwd = await readlink(`/proc/${pid}/cwd`);
        if (inRepo(cwd, root, dir)) return { reason: `git 进程运行中: PID ${pid}`, inRepo: true };
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ESRCH') continue;
        // A process whose cwd cannot be inspected must not silently disappear.
        if (e.code === 'EACCES') return { reason: `无法检查 Git 进程目录: PID ${pid}`, inRepo: false };
        throw e;
      }
    }
  } else if (process.platform === 'win32') {
    // Windows exposes no supported cwd query for another process. Pause for all
    // visible Git processes, including commits waiting inside hooks/editors.
    const result = await run('tasklist.exe', ['/FI', 'IMAGENAME eq git.exe', '/FO', 'CSV', '/NH'], { signal, timeoutMs: 10000, processGroup: true });
    const row = result.stdout.split(/\r?\n/).find(line => /^"git\.exe",/i.test(line));
    if (row) return { reason: 'Git 进程运行中（Windows 无法按仓库目录区分）', inRepo: false };
  } else throw new Error(`不支持的平台: ${process.platform}`);
  return null;
}
