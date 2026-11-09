// One-time removal of the UUID-based registrations installed before on-demand sync.
// This module cannot register or start a service.
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../core/process.mjs';
import { context, belongsToMovedCopy } from '../sync/client.mjs';
import { json, alive, waitStopped, exists, lease } from '../sync/git.mjs';

export function serviceLocation(id, home, platform) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('旧同步身份 UUID 无效');
  const name = `de.eloyzh.infohub-sync.${id}`;
  if (platform === 'darwin') return { id, name, file: path.join(home, 'Library/LaunchAgents', name + '.plist'), target: `gui/${process.getuid?.() ?? 0}/${name}` };
  if (platform === 'linux') return { id, name, file: path.join(home, '.config/systemd/user', name + '.service'), target: name + '.service' };
  if (platform === 'win32') return { id, name, file: path.join(home, '.config/infohub/tasks', name + '.xml'), target: name };
  throw new Error(`不支持的平台: ${platform}`);
}
async function stopWindowsRunner(id) {
  await new Promise((resolve, reject) => {
    const socket = createConnection(`\\\\.\\pipe\\infohub-sync-${id}`);
    socket.setTimeout(5000, () => socket.destroy(new Error('旧同步服务停止请求超时')));
    socket.once('connect', () => socket.end('stop\n'));
    socket.once('error', reject); socket.once('close', resolve);
  });
}
export async function retireSyncService(root, { home = homedir(), platform = process.platform, execute = run, requestStop = stopWindowsRunner, timeoutMs = 30000 } = {}) {
  const ctx = await context(root);
  const id = await json(path.join(ctx.home, 'identity.json'));
  if (!id || (id.root !== ctx.root && !await belongsToMovedCopy(ctx, id.root))) return;
  const registration = await json(path.join(ctx.home, 'service.json'));
  const release = await lease(path.join(ctx.home, 'manage.pid'));
  try {
    for (const uuid of [id.id, ...id.previousIds || []]) {
      const loc = serviceLocation(uuid, home, platform);
      const present = await exists(loc.file);
      // Missing definitions need no native manager on macOS/Linux. Windows tasks
      // can outlive their cached XML, so query that exact UUID even without a file.
      if (!present && platform !== 'win32' && registration?.name !== loc.name) continue;
      if (platform === 'darwin') {
        const loaded = await execute('launchctl', ['print', loc.target], { allowFailure: true });
        if (loaded.code === 0) await execute('launchctl', ['bootout', loc.target]);
      } else if (platform === 'linux') {
        await execute('systemctl', ['--user', 'disable', '--now', loc.target]);
      } else {
        const task = await execute('schtasks.exe', ['/Query', '/TN', loc.target, '/XML'], { allowFailure: true });
        if (task.code === 0) {
          await execute('schtasks.exe', ['/Change', '/TN', loc.target, '/DISABLE']);
          const runnerPid = Number(await readFile(path.join(ctx.home, 'runner.pid'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; }));
          if (runnerPid && alive(runnerPid)) {
            await requestStop(uuid);
            const deadline = Date.now() + timeoutMs;
            while (alive(runnerPid)) {
              if (Date.now() >= deadline) throw new Error('旧计划任务未安全退出；未强杀，也未删除登记');
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
          await waitStopped(ctx.root, timeoutMs);
          await execute('schtasks.exe', ['/Delete', '/TN', loc.target, '/F']);
        }
      }
      await waitStopped(ctx.root, timeoutMs);
      await rm(loc.file, { force: true });
      if (platform === 'linux') await execute('systemctl', ['--user', 'daemon-reload']);
      console.log(`已安全停止并移除旧同步服务: ${loc.name}`);
    }
    await rm(path.join(ctx.home, 'service.json'), { force: true });
    await rm(path.join(ctx.home, 'service-runner.json'), { force: true });
  } finally { await release(); }
}
