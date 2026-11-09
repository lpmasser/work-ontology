import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=15',
  } }).trim();
}
export function checkAccess(url) {
  try { git(['ls-remote', '--exit-code', url, 'HEAD']); }
  catch (e) { throw new Error(`无法读取 ${url}。请检查网络、Git 凭据及仓库权限，然后重跑安装。\n${String(e.stderr || e.message).trim()}`); }
}
export async function ensureInfoHub(root, url) {
  checkAccess(url);
  if (existsSync(root)) {
    if (!existsSync(path.join(root, '.git')) || !existsSync(path.join(root, 'ontology/ontology.json'))) throw new Error(`目录已存在且不是 InfoHub Git 副本：${root}；请选择 --root <目录>，不会覆盖已有内容。`);
    console.log(`使用已有 InfoHub：${root}`); return;
  }
  await mkdir(path.dirname(root), { recursive: true });
  git(['clone', '--', url, root]);
  console.log(`已克隆 InfoHub：${root}`);
}
