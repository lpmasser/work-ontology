import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { npm } from './npm.mjs';
import { configureCommandPath } from './install-environment.mjs';
import { stableTool, minimalPath, findExecutable } from '../core/runtime.mjs';

export function commandLocation(home, platform = process.platform, appData = process.env.APPDATA) {
  const prefix = platform === 'win32' ? path.join(appData || path.join(home, 'AppData/Roaming'), 'npm') : path.join(home, '.local');
  return { prefix, bin: platform === 'win32' ? prefix : path.join(prefix, 'bin') };
}

export async function installCommand(repoRoot, home) {
  const { prefix, bin } = commandLocation(home);
  const runtime = { node: stableTool('node'), git: stableTool('git') };
  const runtimeEnv = { ...process.env, PATH: minimalPath(runtime) };
  const nodeMajor = Number(execFileSync(runtime.node, ['-p', 'process.versions.node.split(".")[0]'], { env: runtimeEnv, encoding: 'utf8', windowsHide: true }).trim());
  if (nodeMajor < 22) throw new Error('InfoHub 需要 Node.js 22 或以上；请在版本管理器中设置默认版本');
  execFileSync(runtime.git, ['--version'], { env: runtimeEnv, stdio: 'pipe', windowsHide: true });
  const oldPrefix = npm(['prefix', '-g'], { encoding: 'utf8' }).trim();
  // Do not change the user's npm configuration: nvm owns its own prefix.
  const env = { ...process.env, npm_config_prefix: prefix, NPM_CONFIG_PREFIX: prefix };
  npm(['link', '--no-audit', '--no-fund'], { cwd: repoRoot, env, stdio: 'inherit' });
  for (const old of [oldPrefix]) {
    if (path.resolve(old) === path.resolve(prefix)) continue;
    const pkg = path.join(old, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'work-ontology');
    // Only remove the obsolete installation if it belongs to this checkout.
    if (existsSync(pkg) && await realpath(pkg) === await realpath(repoRoot)) {
      npm(['uninstall', '-g', 'work-ontology', '--no-audit', '--no-fund'], {
        cwd: repoRoot, env: { ...process.env, npm_config_prefix: old, NPM_CONFIG_PREFIX: old }, stdio: 'inherit'
      });
      console.log(`已移除 Node 版本目录中的旧入口: ${old}`);
    }
  }
  const mise = findExecutable('mise');
  if (mise && /[\\/]mise[\\/]installs[\\/]/.test(oldPrefix)) {
    execFileSync(mise, ['reshim'], { stdio: 'inherit', windowsHide: true });
  }
  await configureCommandPath(home, bin, minimalPath(runtime));
  console.log(`全局命令: ${path.join(bin, 'infohub')}（独立于 Node 版本）`);
  return { prefix, bin, ...runtime };
}
