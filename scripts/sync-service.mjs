import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { run } from '../core/process.mjs';
import { minimalPath } from '../core/runtime.mjs';
import { context, config, identity } from '../sync/client.mjs';
import { json, save, value, lease, alive } from '../sync/git.mjs';
import { status } from '../sync/command.mjs';
import { waitStopped, requestServiceStop } from './service-control.mjs';

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const unitValue = value => '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"';
const unitArg = value => unitValue(String(value).replaceAll('$', '$$'));
const winArg = value => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
export function serviceLocation(id, home = homedir(), platform = process.platform) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('同步身份 UUID 无效');
  const name = `de.eloyzh.infohub-sync.${id}`;
  if (platform === 'darwin') return { id, manager: 'launchd', name, file: path.join(home, 'Library/LaunchAgents', name + '.plist'), target: `gui/${process.getuid?.() ?? 0}/${name}` };
  if (platform === 'linux') return { id, manager: 'systemd', name, file: path.join(home, '.config/systemd/user', name + '.service'), target: name + '.service' };
  if (platform === 'win32') return { id, manager: 'task-scheduler', name, file: path.join(home, '.config/infohub/tasks', name + '.xml'), target: name };
  throw new Error(`不支持的系统服务平台: ${platform}`);
}
export function serviceDefinition(loc, root, runtime, log, home, sid) {
  const argv = [runtime.node, runtime.cli, '--root', root, 'sync', 'run'];
  const env = { HOME: home, PATH: minimalPath(runtime), INFOHUB_SYNC_MANAGER: loc.manager, INFOHUB_SYNC_LOG: log };
  if (loc.manager === 'launchd') return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${loc.name}</string><key>ProgramArguments</key><array>${argv.map(v => `<string>${xml(v)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>ExitTimeOut</key><integer>30</integer><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`;
  if (loc.manager === 'systemd') return `[Unit]
Description=InfoHub synchronization (${loc.id})
StartLimitIntervalSec=0
[Service]
Type=simple
WorkingDirectory=${unitValue(root)}
ExecStart=${argv.map(unitArg).join(' ')}
${Object.entries(env).map(([k,v]) => `Environment=${unitValue(`${k}=${v}`)}`).join('\n')}
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=30
StandardOutput=${unitValue(`append:${log}`)}
StandardError=${unitValue(`append:${log}`)}
[Install]
WantedBy=default.target
`;
  const runner = path.resolve(import.meta.dirname, 'service-runner.mjs');
  const settings = path.join(root, '.git/infohub-sync/service-runner.json');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(sid)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(sid)}</UserId><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${xml(runtime.node)}</Command><Arguments>${xml([runner, settings].map(winArg).join(' '))}</Arguments><WorkingDirectory>${xml(root)}</WorkingDirectory></Exec></Actions></Task>\n`;
}
async function read(file) { try { return await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; } }
export async function serviceLoaded(loc, execute = run) {
  const [cmd, args] = loc.manager === 'launchd' ? ['launchctl', ['print', loc.target]] : loc.manager === 'systemd' ? ['systemctl', ['--user', 'is-active', loc.target]] : ['schtasks.exe', ['/Query', '/TN', loc.target, '/XML']];
  return (await execute(cmd, args, { allowFailure: true })).code === 0;
}
export async function stopService(loc, root, execute = run) {
  if (loc.manager === 'launchd') {
    if (await serviceLoaded(loc, execute)) await execute('launchctl', ['bootout', loc.target]);
  } else if (loc.manager === 'systemd') {
    await execute('systemctl', ['--user', 'disable', '--now', loc.target], { allowFailure: true });
  } else if (await serviceLoaded(loc, execute)) {
    // /End would kill Node before it reaps Git. Stop via the owned IPC first.
    const pid = Number(await read(path.join(root, '.git/infohub-sync/runner.pid')));
    if (pid && alive(pid)) {
      await requestServiceStop(loc.id);
      const deadline = Date.now() + 30000;
      while (alive(pid)) { if (Date.now() >= deadline) throw new Error('计划任务未安全退出，未执行强制 End'); await new Promise(r => setTimeout(r, 100)); }
    } else if (Number(await read(path.join(root, '.git/infohub-sync/daemon.pid'))) && (await status(root)).running) {
      throw new Error('发现不支持安全停止的旧 Windows 同步任务；请在原宿主中安全退出后重跑');
    }
    await execute('schtasks.exe', ['/Delete', '/TN', loc.target, '/F']);
  }
  await waitStopped(root);
  await rm(loc.file, { force: true });
  if (loc.manager === 'systemd') await execute('systemctl', ['--user', 'daemon-reload']);
}
export async function preflightSyncService(root, { platform = process.platform, execute = run } = {}) {
  const ctx = await context(root);
  await config(ctx);
  if (!await json(path.join(ctx.home, 'config.json')) && await value(ctx, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('首次启用检测到未提交内容；确认允许闲置自动提交后，先运行 infohub sync run --include-existing，再重跑安装器');
  if (platform === 'linux') await execute('systemctl', ['--user', 'show-environment']);
  else if (platform === 'darwin') await execute('launchctl', ['print', `gui/${process.getuid()}`]);
  else if (platform === 'win32') await execute('schtasks.exe', ['/Query']);
  else throw new Error(`不支持的系统服务平台: ${platform}`);
}
export async function ensureSyncService(root, runtime, { home = homedir(), platform = process.platform, execute = run, timeoutMs = 60000 } = {}) {
  const ctx = await context(root), release = await lease(path.join(ctx.home, 'manage.pid'));
  try {
    const settings = await config(ctx);
    if (!await json(path.join(ctx.home, 'config.json')) && await value(ctx, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('首次启用检测到未提交内容；确认允许闲置自动提交后，先运行 infohub sync run --include-existing，再重跑安装器');
    const id = await identity(ctx, settings.identity), loc = serviceLocation(id.id, home, platform);
    const log = path.join(ctx.home, 'service.log');
    const sid = loc.manager === 'task-scheduler' ? (await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'])).stdout.trim() : undefined;
    const definition = serviceDefinition(loc, ctx.root, runtime, log, home, sid);
    const runnerSettings = { id: id.id, root: ctx.root, runtime, log, runnerLease: path.join(ctx.home, 'runner.pid') };
    const runnerFile = path.join(ctx.home, 'service-runner.json');
    const sameRunner = loc.manager !== 'task-scheduler' || JSON.stringify(await json(runnerFile)) === JSON.stringify(runnerSettings);
    const current = await read(loc.file);
    const desired = loc.manager === 'task-scheduler' ? '\ufeff' + definition : definition;
    // Compare actual registered task as well as our cached XML; never reuse a
    // foreign or legacy registration merely because our file happens to match.
    let registered = true;
    if (loc.manager === 'task-scheduler' && await serviceLoaded(loc, execute)) {
      const query = await execute('schtasks.exe', ['/Query', '/TN', loc.target, '/XML']);
      registered = query.stdout.includes('S4U') && query.stdout.includes(xml(runtime.node)) && query.stdout.includes(xml(runnerFile));
    }
    const loaded = await serviceLoaded(loc, execute);
    const wasRunning = (await status(root)).running;
    const unchanged = current === desired && sameRunner && registered;
    if (!unchanged && (loaded || current)) await stopService(loc, root, execute);
    if (!loaded && wasRunning) throw new Error('此副本仍有其他宿主的同步循环；请先安全退出该宿主，未登记第二个服务');
    for (const oldId of id.previousIds || []) {
      const old = serviceLocation(oldId, home, platform);
      if (await read(old.file)) await stopService(old, root, execute);
    }
    await save(path.join(ctx.home, 'config.json'), settings);
    if (!unchanged || !loaded) {
      await mkdir(path.dirname(loc.file), { recursive: true });
      await writeFile(loc.file, desired, loc.manager === 'task-scheduler' ? 'utf16le' : 'utf8');
      if (loc.manager === 'task-scheduler') await save(runnerFile, runnerSettings);
      if (loc.manager === 'launchd') await execute('launchctl', ['bootstrap', `gui/${process.getuid()}`, loc.file]);
      else if (loc.manager === 'systemd') { await execute('systemctl', ['--user', 'daemon-reload']); await execute('systemctl', ['--user', 'enable', '--now', loc.target]); }
      else { await execute('schtasks.exe', ['/Create', '/TN', loc.target, '/XML', loc.file, '/NP', '/F']); await execute('schtasks.exe', ['/Run', '/TN', loc.target]); }
    } else if (!wasRunning && loc.manager === 'task-scheduler') await execute('schtasks.exe', ['/Run', '/TN', loc.target]);
    await save(path.join(ctx.home, 'service.json'), { manager: loc.manager, name: loc.name, file: loc.file, log });
    const deadline = Date.now() + timeoutMs;
    let s;
    do {
      s = await status(root);
      if (s.running && s.manager === loc.manager && Date.parse(s.lastFetch) >= Date.parse(s.startedAt)) {
        console.log(`系统同步服务已就绪: ${loc.manager} / ${loc.name}；日志: ${log}`); return { ...loc, log, pid: s.pid };
      }
      if (s.running && s.pending.fetch) throw new Error(`系统服务已启动但拉取失败：${s.pending.fetch}；检查非交互 SSH、known_hosts、密钥及批处理登录权限，Windows S4U 不支持依赖 EFS/DPAPI/交互代理的凭据`);
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (true);
    throw new Error(`系统服务未在 ${timeoutMs / 1000} 秒内完成首次拉取；日志: ${log}；${JSON.stringify(s?.pending)}`);
  } finally { await release(); }
}
