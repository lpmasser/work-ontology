import { spawn } from 'node:child_process';
import { executable } from './runtime.mjs';

async function terminate(child, group) {
  if (!child.pid) return;
  if (process.platform === 'win32' && group) {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('close', resolve);
    });
  } else {
    const pid = group ? -child.pid : child.pid;
    try { process.kill(pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { return; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
}

export function run(command, args, { cwd, env = {}, input, allowFailure = false, signal, timeoutMs, processGroup = false } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable(command), args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: processGroup && process.platform !== 'win32' });
    const stdout = [], stderr = [];
    let interrupted, termination, timer;
    const cancel = code => {
      if (interrupted) return;
      interrupted = Object.assign(new Error(code === 'ABORT_ERR' ? '操作已取消' : `${command} 操作超时`), { code });
      termination = terminate(child, processGroup);
    };
    const abort = () => cancel('ABORT_ERR');
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    signal?.addEventListener('abort', abort, { once: true });
    if (timeoutMs) timer = setTimeout(() => cancel('ETIMEDOUT'), timeoutMs);
    child.stdout.on('data', b => stdout.push(b));
    child.stderr.on('data', b => stderr.push(b));
    child.stdin.on('error', () => {});
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', async code => {
      cleanup();
      try {
        await termination;
        if (interrupted) throw interrupted;
        const result = { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
        if (code !== 0 && !allowFailure) throw new Error(`${command} ${args[0]}: ${result.stderr.trim() || result.stdout.trim() || code}`);
        resolve(result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(input);
    if (signal?.aborted) abort();
  });
}
