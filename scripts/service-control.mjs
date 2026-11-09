import { createConnection } from 'node:net';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { alive } from '../sync/git.mjs';

export const servicePipe = id => process.platform === 'win32' ? `\\\\.\\pipe\\infohub-sync-${id}` : path.join('/tmp', `infohub-sync-${id}.sock`);
export async function waitStopped(root, timeoutMs = 30000) {
  const file = path.join(root, '.git/infohub-sync/daemon.pid'), deadline = Date.now() + timeoutMs;
  while (true) {
    let pid;
    try { pid = Number(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return; }
    if (!pid || !alive(pid)) return;
    if (Date.now() >= deadline) throw new Error('同步尚未安全退出；未删除应用或强杀进程，请核对 sync status 后重跑');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
export async function requestServiceStop(id) {
  await new Promise((resolve, reject) => {
    const socket = createConnection(servicePipe(id));
    socket.setTimeout(5000, () => socket.destroy(new Error('服务停止请求超时')));
    socket.once('connect', () => socket.end('stop\n'));
    socket.once('error', reject); socket.once('close', resolve);
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    if (process.argv[2] !== '--root' || !process.argv[3]) throw new Error('用法: node scripts/service-control.mjs --root <InfoHub目录>（安全停止 Windows 任务）');
    const root = path.resolve(process.argv[3]);
    const identity = JSON.parse(await readFile(path.join(root, '.git/infohub-sync/identity.json'), 'utf8'));
    if (!/^[a-f0-9-]{36}$/.test(identity.id)) throw new Error('同步身份无效');
    await requestServiceStop(identity.id); await waitStopped(root);
    console.log('同步计划任务已安全停止；用任务计划程序或重跑安装器重新启动');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
