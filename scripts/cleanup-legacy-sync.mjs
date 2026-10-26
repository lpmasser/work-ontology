// One-way removal of the retired OS supervisors. Never installs or starts one.
import { readFile, rm, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { run } from '../core/process.mjs';
import { alive } from '../sync/git.mjs';

export async function cleanupLegacySync(root, home = homedir(), platform = process.platform) {
  const dir = path.join(await realpath(root), '.git/infohub-sync');
  let identity;
  try { identity = JSON.parse(await readFile(path.join(dir, 'identity.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // Copied .git directories do not own the original clone's live task.
  if (identity.root) {
    try { if (await realpath(path.join(identity.root, '.git')) !== await realpath(path.join(root, '.git'))) return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let removed = false;
  for (const id of new Set([identity.id, ...identity.previousIds || []])) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('旧同步身份格式无效；请核对后再清理任务');
    const name = `de.eloyzh.infohub-sync.${id}`;
    let file, present;
    if (platform === 'darwin') {
      file = path.join(home, 'Library/LaunchAgents', name + '.plist');
      present = (await run('launchctl', ['print', `gui/${process.getuid()}/${name}`], { allowFailure: true })).code === 0;
      if (present) await run('launchctl', ['bootout', `gui/${process.getuid()}/${name}`]);
    } else if (platform === 'win32') {
      file = path.join(home, '.config/infohub/tasks', name + '.xml');
      present = (await run('schtasks.exe', ['/Query', '/TN', name], { allowFailure: true })).code === 0;
      if (present) {
        await run('schtasks.exe', ['/End', '/TN', name], { allowFailure: true });
        await run('schtasks.exe', ['/Delete', '/TN', name, '/F']);
      }
    } else if (platform === 'linux') {
      file = path.join(home, '.config/systemd/user', name + '.service');
      try { await readFile(file); present = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (present) await run('systemctl', ['--user', 'disable', '--now', name + '.service']);
    }
    if (file) await rm(file, { force: true });
    if (platform === 'linux' && present) await run('systemctl', ['--user', 'daemon-reload']);
    if (present) { removed = true; console.log(`已移除旧托管 ${name}`); }
  }
  if (removed) {
    let pid;
    try { pid = Number(await readFile(path.join(dir, 'daemon.pid'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const deadline = Date.now() + 10000;
    while (pid && alive(pid)) {
      if (Date.now() >= deadline) throw new Error('旧托管已移除，但同步进程仍未退出；请核对旧任务权限与进程后重跑安装器。');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
