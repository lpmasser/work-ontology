import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { findExecutable } from '../core/runtime.mjs';

// Native user environment configuration, without replacing existing profiles.
export async function configureCommandPath(home, bin, runtimePath) {
  const current = process.env.PATH || '';
  const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const contains = value => value.split(path.delimiter).some(p => samePath(p, bin));
  const activeUser = samePath(path.resolve(home), path.resolve(userInfo().homedir));
  const envPath = [bin, runtimePath].join(path.delimiter);
  const mergePaths = value => [...new Set([...envPath.split(path.delimiter), ...value.split(path.delimiter).filter(Boolean)])].join(path.delimiter);
  if (process.platform === 'win32') {
    // A redirected HOME used by tests or offline provisioning must not update
    // the logged-in user's registry/session.
    if (activeUser) {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$p=[Environment]::GetEnvironmentVariable("Path","User"); foreach ($d in ($env:INFOHUB_COMMAND_DIRS -split ";")) { if (($p -split ";") -notcontains $d) { $p="$d;$p" } }; [Environment]::SetEnvironmentVariable("Path",$p,"User")'],
      { env: { ...process.env, INFOHUB_COMMAND_DIRS: [runtimePath.split(path.delimiter)[0], bin].join(';') }, stdio: 'inherit', windowsHide: true });
    }
  } else {
    const nodeDir = runtimePath.split(path.delimiter)[0];
    const quotedNodeDir = "'" + nodeDir.replaceAll("'", "'\\''") + "'";
    const block = `\n# InfoHub global command (independent of Node versions)\nexport PATH="$HOME/.local/bin":${quotedNodeDir}:"$PATH"\n`;
    // bash login chooses .bash_profile before .profile; zsh login uses .zprofile.
    for (const name of ['.profile', '.zprofile', ...['.bash_profile', '.bash_login'].filter(p => existsSync(path.join(home, p)))]) {
      const file = path.join(home, name);
      let content = '';
      try { content = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const prior = /\n# InfoHub global command[^\n]*\nexport PATH=[^\n]*\n/;
      await writeFile(file, prior.test(content) ? content.replace(prior, block) : content + block);
    }
    if (process.platform === 'linux') {
      const file = path.join(home, '.config/environment.d/60-infohub.conf');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `PATH=${bin}:${runtimePath}:\${PATH}\n`);
      if (activeUser) {
        const probe = findExecutable('systemctl');
        if (probe) {
          try {
            const managerEnv = execFileSync(probe, ['--user', 'show-environment'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            const managerPath = managerEnv.split('\n').find(line => line.startsWith('PATH='))?.slice(5) || '';
            execFileSync(probe, ['--user', 'import-environment', 'PATH'], { env: { ...process.env, PATH: mergePaths(managerPath) }, stdio: 'pipe' });
          }
          catch { console.log('当前没有 systemd 用户会话；桌面环境将在下次登录读取 environment.d'); }
        }
      }
    }
  }
  if (!contains(current)) console.log(`已配置用户 PATH: ${bin}；已运行进程保留旧环境，请重开未取得新 PATH 的终端或桌面应用`);
  return envPath;
}
