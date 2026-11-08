import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { safePath, contentType, etag, HttpError } from './web-files.mjs';

const assetType = name => ({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
}[path.extname(name).toLowerCase()] || contentType(name));

async function asset(root, relative) {
  const full = await safePath(root, relative);
  try { return (await lstat(full)).isFile() ? await readFile(full) : null; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

export async function serveStatic(root, route, req, res) {
  let relative;
  try { relative = decodeURIComponent(route).slice(1).replace(/\/+$/, '') || 'index.html'; }
  catch { throw new HttpError(400, 'INVALID_PATH', 'URL 路径编码无效'); }
  let bytes = await asset(root, relative);
  if (bytes === null && relative !== 'index.html') { relative = 'index.html'; bytes = await asset(root, relative); }
  if (bytes === null) throw new HttpError(404, 'NOT_FOUND', '静态入口 index.html 尚未部署');
  const version = etag(bytes);
  const headers = { 'Content-Type': assetType(relative), 'Cache-Control': 'no-cache', ETag: version };
  if (req.headers['if-none-match'] === version) { res.writeHead(304, headers); res.end(); return; }
  res.writeHead(200, { ...headers, 'Content-Length': bytes.length }); res.end(bytes);
}
