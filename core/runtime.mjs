import { accessSync, constants } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export function systemDirectories(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const root = env.SystemRoot || 'C:\\Windows';
  return [path.join(root, 'System32'), root, path.join(root, 'System32/WindowsPowerShell/v1.0'), path.join(root, 'System32/OpenSSH')];
}

export function findExecutable(name, dirs = (process.env.PATH || '').split(path.delimiter)) {
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  return dirs.map(dir => path.join(dir, file)).find(candidate => {
    try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
  });
}

export function stableTool(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const stable = dirs.filter(dir => !/(?:[\\/]mise[\\/]installs[\\/]|[\\/]\.nvm[\\/]versions[\\/]|[\\/]fnm[\\/]node-versions[\\/]|[\\/]\.asdf[\\/]installs[\\/]|[\\/]Cellar[\\/]|[\\/]node_modules[\\/]\.bin(?:[\\/]|$)|[\\/]\.codex[\\/]tmp[\\/])/.test(dir));
  const candidates = [...stable.filter(dir => path.basename(dir) === 'shims')];
  if (name === 'node') {
    if (process.env.NVM_SYMLINK) candidates.push(process.env.NVM_SYMLINK);
    candidates.push(path.join(process.env.NVM_DIR || path.join(homedir(), '.nvm'), 'current/bin'));
  }
  candidates.push(...stable, ...systemDirectories());
  const result = findExecutable(name, candidates);
  if (!result) throw new Error(`找不到 ${name} 的稳定入口。请配置版本管理器 shim（nvm 可用 NVM_SYMLINK_CURRENT/current）或系统安装路径后重跑安装；不保存具体版本目录。`);
  return result;
}

export function minimalPath(runtime) {
  return [...new Set([path.dirname(runtime.node), path.dirname(runtime.git), ...systemDirectories()])].join(path.delimiter);
}

let active;
export const executable = name => active?.[name] || name;
export const currentRuntime = () => active;

// CLI owns Git and synchronization environments. The GUI only boots Node.
export async function readConfig() {
  try { return JSON.parse(await readFile(path.join(homedir(), '.config/infohub/config.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function configureRuntime(config) {
  if (config === undefined) config = await readConfig();
  active = config?.runtime;
  if (active && (!path.isAbsolute(active.node || '') || !path.isAbsolute(active.git || ''))) throw new Error('InfoHub 运行入口需要更新；请重跑 node scripts/install.mjs --root <InfoHub目录>');
  // Source/CI usage need not install user-level configuration.
  active ||= { node: process.execPath, git: findExecutable('git') };
  if (!active.git) throw new Error('找不到 Git 可执行文件');
  process.env.PATH = minimalPath(active);
  return active;
}
