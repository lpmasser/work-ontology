import { access, rm, realpath, readFile, readdir, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { run } from '../core/process.mjs';
import { waitStopped } from '../sync/git.mjs';

const products = ['InfoHub Workbench', 'Otterly'];
const executableName = /^(?:infohub-workbench|otterly|InfoHubWorkbench)(?:\.exe|\.AppImage)?$/i;
const exists = async file => { try { await access(file); return true; } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) throw e; return false; } };
export function desktopLocations(home = homedir(), platform = process.platform) {
  if (platform === 'darwin') return products.flatMap(name => ['/Applications', path.join(home, 'Applications')].map(dir => ({ app: path.join(dir, name + '.app'), binaries: ['infohub-workbench', 'otterly'].map(bin => path.join(dir, name + '.app/Contents/MacOS', bin)) })));
  if (platform === 'win32') return products.flatMap(name => [process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'), path.join(home, 'AppData/Local/Programs')].map(dir => ({ app: path.join(dir, name), binaries: ['infohub-workbench.exe', 'otterly.exe'].map(bin => path.join(dir, name, bin)) })));
  return [
    ...['InfoHubWorkbench.AppImage', 'Otterly.AppImage'].map(name => ({ app: path.join(home, '.local/share/infohub/workbench', name), binaries: [path.join(home, '.local/share/infohub/workbench', name)] })),
    ...['infohub-workbench', 'otterly'].map(name => ({ app: `/usr/bin/${name}`, binaries: [`/usr/bin/${name}`], packageManaged: true })),
  ];
}
export async function desktopProcesses(execute = run, platform = process.platform) {
  if (platform === 'win32') {
    const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $p=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('infohub-workbench.exe','otterly.exe') } | Where-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $sid } | Select-Object ProcessId,ExecutablePath); $j=ConvertTo-Json -InputObject $p -Compress; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))"]);
    const parsed = JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString('utf8'));
    return (Array.isArray(parsed) ? parsed : [parsed]).map(p => ({ pid: p.ProcessId, binary: p.ExecutablePath }));
  }
  if (platform === 'linux') {
    const processes = [];
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const name = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
        if (!/^(?:infohub-workben|otterly|InfoHubWorkben)/i.test(name)) continue;
        const owner = /Uid:\s+(\d+)/.exec(await readFile(`/proc/${pid}/status`, 'utf8'));
        if (Number(owner?.[1]) !== process.getuid()) continue;
        processes.push({ pid: Number(pid), binary: await readlink(`/proc/${pid}/exe`) });
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    return processes;
  }
  const isUserProcess = platform === 'win32' || process.getuid === undefined ? [] : ['-u', String(process.getuid())];
  const result = await execute('ps', [...isUserProcess, '-o', 'pid=,comm=']);
  return result.stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    return match && executableName.test(path.basename(match[2])) ? [{ pid: Number(match[1]), binary: match[2] }] : [];
  });
}
export async function retireWorkbench(root, { home = homedir(), platform = process.platform, execute = run, timeoutMs = 30000, locations = desktopLocations(home, platform), processes = () => desktopProcesses(execute, platform) } = {}) {
  const candidates = locations, installed = [];
  for (const item of candidates) if (await exists(item.app)) installed.push(item);
  const running = await processes();
  if (running.some(p => !p.binary)) throw new Error('无法确认旧工作台进程路径，请从其托盘安全退出后重跑安装器');
  for (const process of running) {
    const binary = process.binary;
    const appImage = installed.find(item => item.app.endsWith('.AppImage'))?.app;
    // Linux AppImage runs an extracted binary; invoke its installed image so
    // the single-instance plugin can deliver --quit to the live instance.
    const target = platform === 'linux' && appImage ? appImage : binary;
    await execute(target, [...(target.endsWith('.AppImage') ? ['--appimage-extract-and-run'] : []), '--quit'], { timeoutMs: 10000 });
  }
  const deadline = Date.now() + timeoutMs;
  while ((await processes()).length) {
    if (Date.now() >= deadline) throw new Error('工作台未完成安全退出（可能有保存/取消提示，或旧版不支持 --quit）；请在原应用中退出后重跑，未删除应用、未强杀进程');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (running.length) await waitStopped(root, timeoutMs);
  // Only remove known app autostart registrations, leaving other user jobs.
  if (platform === 'darwin') {
    for (const name of products) {
      const file = path.join(home, 'Library/LaunchAgents', name + '.plist');
      if (await exists(file)) {
        const probe = await execute('launchctl', ['print', `gui/${process.getuid()}/${name}`], { allowFailure: true });
        if (probe.code === 0) await execute('launchctl', ['bootout', `gui/${process.getuid()}/${name}`]);
        await rm(file);
      }
    }
  } else if (platform === 'linux') {
    for (const name of [...products, 'de.eloyzh.infohub-workbench', 'otterly']) {
      await rm(path.join(home, '.config/autostart', name + '.desktop'), { force: true });
      await rm(path.join(home, '.local/share/applications', name + '.desktop'), { force: true });
    }
  } else {
    for (const name of products) {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
      if ((await execute('reg.exe', ['query', key, '/v', name], { allowFailure: true })).code === 0) await execute('reg.exe', ['delete', key, '/v', name, '/f']);
    }
    // Keep application data explicitly; only registered product uninstallers
    // remove NSIS entries/shortcuts/associations instead of leaving stale shells.
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { $p=Get-ItemProperty $_.PSPath; if($p.DisplayName -in @('InfoHub Workbench','Otterly')) { $u=$p.UninstallString; if($u -match '^\"([^\"]+)\"'){ $u=$Matches[1] }; if(Test-Path -LiteralPath $u){ $p=Start-Process -FilePath $u -ArgumentList '/S','/KEEPAPPDATA' -PassThru -Wait; if($p.ExitCode -ne 0){throw '卸载工作台失败'} } } }"]);
  }
  const removed = [];
  for (const item of installed) {
    if (item.packageManaged) {
      const result = await execute('dpkg-query', ['-W', '-f=${Status}', 'info-hub-workbench'], { allowFailure: true });
      if (result.code === 0 && result.stdout.includes('install ok installed')) {
        await execute(process.getuid?.() === 0 ? 'dpkg' : 'sudo', process.getuid?.() === 0 ? ['--remove', 'info-hub-workbench'] : ['-n', 'dpkg', '--remove', 'info-hub-workbench']);
      } else if (await exists(item.app)) throw new Error(`系统安装的旧工作台需由原包管理器卸载：${item.app}；用户数据保留`);
    } else {
      // Never follow a link to delete its target or a workspace accidentally
      // placed in a product directory.
      const resolved = await realpath(item.app);
      if (resolved === await realpath(root) || await exists(path.join(item.app, '.git'))) throw new Error(`应用目录包含 Git 副本，拒绝删除：${item.app}`);
      await rm(item.app, { recursive: true, force: true });
    }
    removed.push(item.app);
  }
  console.log(`旧工作台已安全退出并移除：${removed.join('、') || '未安装'}；偏好、会话及 .git 内缓存保留`);
  return { removed, stopped: running.map(p => p.pid), data: 'preserved' };
}
