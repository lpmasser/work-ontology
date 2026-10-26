import { existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Invoke npm's JavaScript entrypoint, never a .cmd file through a shell.
export function npm(args, options = {}) {
  const bin = path.dirname(process.execPath);
  const candidates = [process.env.npm_execpath,
    path.join(bin, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const executable = path.join(dir, 'npm');
    if (existsSync(executable)) candidates.push(realpathSync(executable));
    candidates.push(path.join(dir, 'node_modules/npm/bin/npm-cli.js'));
  }
  const cli = candidates.find(p => p?.endsWith('npm-cli.js') && existsSync(p));
  if (!cli) throw new Error('找不到 npm-cli.js；请安装包含 npm 的 Node.js 并将其加入 PATH');
  return execFileSync(process.execPath, [cli, ...args], { ...options, windowsHide: true });
}
