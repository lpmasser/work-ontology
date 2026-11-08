import { readdir, lstat, readFile, mkdir, writeFile, rename, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { executable } from '../core/runtime.mjs';
import { sha256, REMOTE_PREFIX, gitBusy } from '../sync/git.mjs';
import { withWorkspaceLock } from '../sync/workspace-lock.mjs';

const exec = promisify(execFile);
export class HttpError extends Error {
  constructor(status, code, message, details = {}) { super(message); Object.assign(this, { status, code, details }); }
}
export const etag = bytes => `"sha256-${sha256(bytes)}"`;
export function filePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[\0-\x1f\x7f]/.test(value) || value.split('/').some(p => !p || p.startsWith('.')) || path.isAbsolute(value)) throw new HttpError(400, 'INVALID_PATH', '路径必须是非隐藏的相对文件路径');
  return value;
}
async function gitBytes(root, args) {
  try {
    return (await exec(executable('git'), ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
      cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 15000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    })).stdout;
  } catch { throw new HttpError(503, 'SOURCE_UNAVAILABLE', '无法读取 Git 来源，请稍后重试'); }
}
export async function safePath(root, relative) {
  filePath(relative);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new HttpError(403, 'UNSAFE_PATH', '不支持符号链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
export class Files {
  constructor(root) { this.root = root; }
  async source(source) {
    if (source === 'workspace') return { source, commit: null };
    const refs = await this.refs();
    const ref = source === 'main' ? refs.find(r => r.ref === `${REMOTE_PREFIX}main`)
      : /^draft:[a-zA-Z0-9_-]+$/.test(source || '') ? refs.find(r => r.ref === `${REMOTE_PREFIX}infohub-drafts/${source.slice(6)}`) : null;
    if (!ref) throw new HttpError(404, 'SOURCE_NOT_FOUND', '来源不存在或尚未同步');
    return { source, commit: ref.commit };
  }
  async refs() {
    const output = await gitBytes(this.root, ['for-each-ref', '--format=%(refname) %(objectname)', REMOTE_PREFIX]);
    return output.toString('utf8').trim().split('\n').filter(Boolean).map(line => { const [ref, commit] = line.split(' '); return { ref, commit }; });
  }
  async listSources(sync) {
    const refs = await this.refs();
    return [
      { id: 'workspace', writable: true, label: '我的工作区' },
      ...refs.filter(r => r.ref === `${REMOTE_PREFIX}main`).map(r => ({ id: 'main', writable: false, label: 'main', commit: r.commit })),
      ...refs.filter(r => r.ref.startsWith(`${REMOTE_PREFIX}infohub-drafts/`)).map(r => {
        const id = r.ref.slice(`${REMOTE_PREFIX}infohub-drafts/`.length);
        const report = sync.server?.drafts?.find(d => d.id === id);
        return { id: `draft:${id}`, writable: false, label: report?.source || id, commit: r.commit, draft: report || null };
      }),
    ];
  }
  async tree(selected) {
    if (selected.commit) {
      const output = await gitBytes(this.root, ['ls-tree', '-r', '-z', '-l', selected.commit]);
      return output.toString('utf8').split('\0').filter(Boolean).flatMap(record => {
        const tab = record.indexOf('\t'), [mode, type, , size] = record.slice(0, tab).trim().split(/\s+/), name = record.slice(tab + 1);
        if (type !== 'blob' || !['100644', '100755'].includes(mode) || name.split('/').some(p => p.startsWith('.'))) return [];
        return [{ path: name, size: Number(size) }];
      }).sort((a, b) => a.path.localeCompare(b.path));
    }
    const files = [];
    const walk = async relative => {
      let entries;
      try { entries = await readdir(path.join(this.root, relative), { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(name);
        else if (entry.isFile()) {
          try { files.push({ path: name, size: (await lstat(await safePath(this.root, name))).size }); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
    };
    await walk('');
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
  async read(selected, relative) {
    filePath(relative);
    if (selected.commit) {
      // Tree membership also excludes symlinks and Git's special pathspec syntax.
      if (!(await this.tree(selected)).some(f => f.path === relative)) throw new HttpError(404, 'FILE_NOT_FOUND', '文件不存在');
      return gitBytes(this.root, ['cat-file', 'blob', `${selected.commit}:${relative}`]);
    }
    const full = await safePath(this.root, relative);
    try {
      if (!(await lstat(full)).isFile()) throw new HttpError(400, 'NOT_FILE', '目标不是普通文件');
      return await readFile(full);
    } catch (error) { if (error.code === 'ENOENT') throw new HttpError(404, 'FILE_NOT_FOUND', '文件不存在'); throw error; }
  }
  async current(relative) {
    try { return etag(await this.read({ source: 'workspace' }, relative)); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }
  async mutate({ method, relative, expected, create, bytes, destination, destinationExpected }) {
    filePath(relative);
    if (method === 'MOVE') { filePath(destination); if (destination === relative) throw new HttpError(400, 'INVALID_MOVE', '源和目标路径相同'); }
    return withWorkspaceLock(this.root, async () => {
      if (await gitBusy(this.root)) throw new HttpError(503, 'WORKSPACE_BUSY', 'Git 正在更新工作区，请重试');
      const currentVersion = await this.current(relative);
      if (create ? currentVersion !== null : expected !== currentVersion || currentVersion === null) throw new HttpError(409, 'VERSION_CONFLICT', '文件已变化，请重新读取', { path: relative, currentVersion });
      const full = await safePath(this.root, relative);
      if (method === 'DELETE') { await unlink(full); return { path: relative, version: null }; }
      if (method === 'MOVE') {
        const currentDestinationVersion = await this.current(destination);
        if (destinationExpected !== currentDestinationVersion) throw new HttpError(409, 'VERSION_CONFLICT', '目标文件已变化，请重新读取', { path: destination, currentVersion: currentDestinationVersion });
        const target = await safePath(this.root, destination);
        await mkdir(path.dirname(target), { recursive: true });
        await rename(full, target);
        return { path: destination, version: currentVersion, previousPath: relative };
      }
      if (currentVersion === etag(bytes)) return { path: relative, version: currentVersion, unchanged: true };
      await mkdir(path.dirname(full), { recursive: true });
      const temp = path.join(path.dirname(full), `.infohub-save-${randomUUID()}`);
      try {
        const mode = currentVersion ? (await lstat(full)).mode & 0o777 : 0o644;
        await writeFile(temp, bytes, { flag: 'wx', mode });
        await rename(temp, full);
      } finally { await rm(temp, { force: true }); }
      return { path: relative, version: etag(bytes), unchanged: false };
    });
  }
}

export const contentType = name => ({
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
  '.yaml': 'text/yaml; charset=utf-8', '.yml': 'text/yaml; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8',
}[path.extname(name).toLowerCase()] || 'application/octet-stream');
