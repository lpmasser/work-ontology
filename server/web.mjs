import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { configureRuntime } from '../core/runtime.mjs';
import { loadVault } from '../core/vault.mjs';
import { buildOverview } from '../core/overview.mjs';
import { queryFind, queryGet, queryAround } from '../core/query.mjs';
import { status } from '../sync/command.mjs';
import { Sessions, validHash } from './web-auth.mjs';
import { Files, HttpError, etag, contentType, safePath } from './web-files.mjs';
import { WorkspaceEvents } from './web-events.mjs';
import { serveStatic } from './web-static.mjs';

const MAX_BODY = 32 * 1024 * 1024;
const VERSION = /^"sha256-[a-f0-9]{64}"$/;
async function body(req, limit = MAX_BODY) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new HttpError(413, 'BODY_TOO_LARGE', '请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req) {
  try {
    const value = JSON.parse((await body(req, 16384)).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'INVALID_JSON', '请求体必须是 JSON 对象'); }
}
function send(res, code, value, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(value));
}
function onlyWorkspace(source) {
  if (source !== 'workspace') throw new HttpError(403, 'READ_ONLY_SOURCE', '此操作只支持 workspace 来源');
}
function expectedVersion(req, allowCreate = false) {
  const expected = req.headers['if-match'], none = req.headers['if-none-match'];
  if (allowCreate && none === '*' && expected === undefined) return { create: true };
  if (!expected && !none) throw new HttpError(428, 'VERSION_REQUIRED', '必须提供版本条件');
  if (!VERSION.test(expected || '') || none !== undefined) throw new HttpError(400, 'INVALID_VERSION', '需要单个强 ETag；新建用 If-None-Match: *');
  return { expected, create: false };
}
function treeEntries(files) {
  const dirs = new Set();
  for (const file of files) {
    const parts = file.path.split('/'); parts.pop();
    while (parts.length) { dirs.add(parts.join('/')); parts.pop(); }
  }
  return [...dirs].map(path => ({ path, type: 'directory' })).concat(files.map(f => ({ ...f, type: 'file' }))).sort((a, b) => a.path.localeCompare(b.path));
}

export async function createWebServer(config, { eventIntervalMs = 30000 } = {}) {
  if (config.version !== 1 || !Array.isArray(config.users) || !config.users.length) throw new Error('Web 配置需要 version: 1 和非空 users');
  const origin = new URL(config.origin).origin;
  if (origin !== config.origin || !['https:', 'http:'].includes(new URL(origin).protocol)) throw new Error('origin 必须是完整且不带路径的 HTTP(S) 来源');
  if (config.sessionTtlSeconds !== undefined && (!Number.isFinite(config.sessionTtlSeconds) || config.sessionTtlSeconds < 60 || config.sessionTtlSeconds > 604800)) throw new Error('sessionTtlSeconds 必须在 60 到 604800 之间');
  const users = [], roots = new Set(), names = new Set();
  for (const entry of config.users) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(entry.username || '') || !validHash(entry.passwordHash) || !path.isAbsolute(entry.workspace || '')) throw new Error('用户需要有效 username、scrypt passwordHash 和绝对 workspace');
    const workspace = await realpath(entry.workspace);
    if (names.has(entry.username) || [...roots].some(r => r === workspace || r.startsWith(workspace + path.sep) || workspace.startsWith(r + path.sep))) throw new Error('用户和工作区必须唯一且不能嵌套');
    if (!(await stat(path.join(workspace, '.git'))).isDirectory()) throw new Error('Web 工作区必须是普通 Git clone');
    const syncConfig = JSON.parse(await readFile(path.join(workspace, '.git/infohub-sync/config.json'), 'utf8'));
    if (syncConfig.workspaceLock !== true) throw new Error('Web 工作区必须先配置 workspaceLock: true');
    roots.add(workspace); names.add(entry.username); users.push({ ...entry, workspace });
  }
  let staticDir;
  if (config.staticDir !== undefined) {
    if (typeof config.staticDir !== 'string' || !path.isAbsolute(config.staticDir)) throw new Error('staticDir 必须是绝对目录路径');
    staticDir = await realpath(config.staticDir);
    if (!(await stat(staticDir)).isDirectory() || [...roots].some(root => root === staticDir || root.startsWith(staticDir + path.sep) || staticDir.startsWith(root + path.sep))) throw new Error('静态目录必须独立于所有用户工作区');
  }
  const sessions = new Sessions(users, { ttlSeconds: config.sessionTtlSeconds, secure: origin.startsWith('https:') });
  const workspaces = new Map();
  try {
    for (const user of users) {
      const files = new Files(user.workspace), events = new WorkspaceEvents(files, sessions, eventIntervalMs);
      workspaces.set(user.username, { files, events }); await events.start();
    }
  } catch (error) { await Promise.all([...workspaces.values()].map(w => w.events.close())); throw error; }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      const url = new URL(req.url, origin), route = url.pathname;
      if (req.method === 'GET' && route === '/health') { send(res, 200, { ok: true }); return; }
      const isAPI = route === '/api' || route.startsWith('/api/');
      if (req.method === 'GET' && !isAPI && staticDir) { await serveStatic(staticDir, route, req, res); return; }
      if (req.method === 'GET' && route === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
        res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>InfoHub</title><h1>InfoHub</h1><p>Web API 已部署。网页界面将在批次 2 接入。</p>'); return;
      }
      if (!isAPI) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) throw new HttpError(403, 'ORIGIN_REJECTED', '写请求需要匹配的 Origin');
      if (route === '/api/login' && req.method === 'POST') {
        const { username, password } = await jsonBody(req);
        if (typeof username !== 'string' || username.length > 64 || typeof password !== 'string' || password.length > 1024) throw new HttpError(400, 'INVALID_LOGIN', '用户名或密码格式无效');
        const login = await sessions.login(username, password, req.socket.remoteAddress);
        if (!login.user) throw new HttpError(login.limited ? 429 : 401, login.limited ? 'LOGIN_RATE_LIMITED' : 'INVALID_CREDENTIALS', login.limited ? '登录尝试过多，请稍后重试' : '用户名或密码错误');
        send(res, 200, { version: 1, username: login.user.username, expiresAt: new Date(login.expires).toISOString() }, { 'Set-Cookie': login.cookie }); return;
      }
      const session = sessions.get(req);
      if (!session) throw new HttpError(401, 'UNAUTHENTICATED', '请登录');
      const { files, events } = workspaces.get(session.user.username);
      if (route === '/api/session' && req.method === 'GET') { send(res, 200, { version: 1, username: session.user.username, expiresAt: new Date(session.expires).toISOString() }); return; }
      if (route === '/api/logout' && req.method === 'POST') { send(res, 200, { version: 1, ok: true }, { 'Set-Cookie': sessions.logout(req) }); return; }
      if (route === '/api/events' && req.method === 'GET') { events.subscribe(req, res); return; }
      if (route === '/api/sources' && req.method === 'GET') { send(res, 200, { version: 1, sources: await files.listSources(await status(files.root)) }); return; }
      const source = url.searchParams.get('source');
      if (!source) throw new HttpError(400, 'SOURCE_REQUIRED', '必须指定 source');
      if (['/api/overview', '/api/sync/status', '/api/find', '/api/get', '/api/around'].includes(route) && req.method === 'GET') {
        onlyWorkspace(source);
        if (route === '/api/sync/status') { send(res, 200, await status(files.root)); return; }
        const model = JSON.parse((await files.read({ source: 'workspace' }, 'ontology/ontology.json')).toString('utf8'));
        if (!Array.isArray(model.folders)) throw new HttpError(400, 'INVALID_MODEL', '模型 folders 无效');
        for (const folder of model.folders) await safePath(files.root, folder);
        const vault = await loadVault(files.root);
        try {
          const output = route === '/api/overview' ? buildOverview(vault.index) : route === '/api/find' ? queryFind(vault, url.searchParams.getAll('arg')).snapshot
            : route === '/api/get' ? queryGet(vault, url.searchParams.get('target')) : queryAround(vault, url.searchParams.getAll('arg'));
          send(res, 200, output); return;
        } catch (error) { throw new HttpError(400, 'QUERY_ERROR', error.message); }
      }
      if (route === '/api/file' && ['PUT', 'DELETE'].includes(req.method)) {
        onlyWorkspace(source);
        const condition = expectedVersion(req, req.method === 'PUT');
        const bytes = req.method === 'PUT' ? await body(req) : undefined;
        const result = await files.mutate({ method: req.method, relative: url.searchParams.get('path'), ...condition, bytes });
        const { version: fileVersion, ...details } = result;
        send(res, condition.create ? 201 : 200, { version: 1, ...details, etag: fileVersion }, fileVersion ? { ETag: fileVersion } : {}); return;
      }
      if (route === '/api/move' && req.method === 'POST') {
        onlyWorkspace(source); const condition = expectedVersion(req);
        const move = await jsonBody(req);
        if (move.destinationVersion !== null && !VERSION.test(move.destinationVersion || '')) throw new HttpError(400, 'INVALID_VERSION', 'destinationVersion 必须是 ETag 或 null（目标不存在）');
        const result = await files.mutate({ method: 'MOVE', relative: move.path, destination: move.destination, destinationExpected: move.destinationVersion, ...condition });
        const { version: fileVersion, ...details } = result;
        send(res, 200, { version: 1, ...details, etag: fileVersion }, { ETag: fileVersion }); return;
      }
      const selected = await files.source(source);
      if (route === '/api/tree' && req.method === 'GET') { send(res, 200, { version: 1, ...selected, entries: treeEntries(await files.tree(selected)) }); return; }
      if (route === '/api/file' && req.method === 'GET') {
        const relative = url.searchParams.get('path'), bytes = await files.read(selected, relative), version = etag(bytes);
        const headers = { ETag: version, 'Content-Type': contentType(relative), 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:", 'Content-Length': bytes.length };
        if (req.headers['if-none-match'] === version) { res.writeHead(304, { ETag: version }); res.end(); }
        else { res.writeHead(200, headers); res.end(bytes); }
        return;
      }
      if (route === '/api/search' && req.method === 'GET') {
        const q = url.searchParams.get('q'), limit = Number(url.searchParams.get('limit') || 100);
        if (!q || q.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, 'INVALID_SEARCH', 'q 长度须为 1 到 200，limit 须为 1 到 500');
        const matches = [], skipped = []; let truncated = false;
        search: for await (const file of files.contents(selected, 5 * 1024 * 1024)) {
          if (file.bytes === null) { skipped.push(file.path); continue; }
          let text;
          try { if (file.bytes.includes(0)) { skipped.push(file.path); continue; } text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); }
          catch (error) { if (error instanceof TypeError) { skipped.push(file.path); continue; } throw error; }
          const lines = text.split(/\r\n|\n|\r/);
          for (let i = 0; i < lines.length; i++) {
            const at = lines[i].toLowerCase().indexOf(q.toLowerCase());
            if (at < 0) continue;
            if (matches.length === limit) { truncated = true; break search; }
            const start = Math.max(0, at - 80);
            matches.push({ path: file.path, line: i + 1, snippet: lines[i].slice(start, start + 240) });
          }
        }
        send(res, 200, { version: 1, ...selected, matches, truncated, skipped }); return;
      }
      throw new HttpError(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const code = error.status || (error.code === 'WORKSPACE_BUSY' ? 503 : error.code === 'ENOTDIR' || error.code === 'EISDIR' ? 400 : 500);
      send(res, code, { version: 1, error: { code: error.code || 'INTERNAL_ERROR', message: code === 500 ? '服务器无法完成请求' : error.message, ...(error.details || {}) } }, error.details?.currentVersion ? { ETag: error.details.currentVersion } : {});
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  return {
    server,
    async close() {
      await Promise.all([...workspaces.values()].map(w => w.events.close()));
      server.closeIdleConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    await configureRuntime(null);
    const file = process.env.INFOHUB_WEB_CONFIG;
    if (!file) throw new Error('INFOHUB_WEB_CONFIG 未设置');
    const config = JSON.parse(await readFile(file, 'utf8'));
    const app = await createWebServer(config);
    app.server.listen(config.port || 3000, config.host || '0.0.0.0', () => console.log('infohub-web listening'));
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch (error) { console.error(`infohub-web: ${error.message}`); process.exitCode = 1; }
}
