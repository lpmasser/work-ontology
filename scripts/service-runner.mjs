// Windows Task Scheduler owns restart/login policy. This entry only supplies
// logs and a stop channel; the same foreground CLI owns all sync behavior.
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { open, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { configureRuntime, minimalPath } from '../core/runtime.mjs';
import { lease } from '../sync/git.mjs';
import { servicePipe } from './service-control.mjs';

export async function serviceRunner(file) {
  const settings = JSON.parse(await readFile(file, 'utf8'));
  const release = await lease(settings.runnerLease);
  let child, stopping = false, ipc, log;
  const stop = () => { stopping = true; child?.stdin.end('stop\n'); };
  try {
    await configureRuntime({ runtime: settings.runtime });
    log = await open(settings.log, 'a', 0o600);
    ipc = createServer(socket => { socket.setTimeout(5000, () => socket.destroy()); socket.on('data', data => { if (data.toString().trim() === 'stop') stop(); socket.end(); }); socket.on('error', () => {}); });
    if (process.platform !== 'win32') await rm(servicePipe(settings.id), { force: true });
    await new Promise((resolve, reject) => { ipc.once('error', reject); ipc.listen(servicePipe(settings.id), resolve); });
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    if (stopping) return 0;
    child = spawn(settings.runtime.node, [settings.runtime.cli, '--root', settings.root, 'sync', 'run', '--parent-stdio'], {
      cwd: settings.root, windowsHide: true, stdio: ['pipe', log.fd, log.fd],
      env: { ...process.env, PATH: minimalPath(settings.runtime), INFOHUB_SYNC_MANAGER: 'task-scheduler', INFOHUB_SYNC_LOG: settings.log },
    });
    child.stdin.on('error', () => {});
    return await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(stopping ? 0 : code || 1)); });
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    if (ipc) await new Promise(resolve => ipc.close(resolve));
    if (process.platform !== 'win32') await rm(servicePipe(settings.id), { force: true });
    await log?.close(); await release();
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  try { process.exitCode = await serviceRunner(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
