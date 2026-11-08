import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import path from 'node:path';
import { createWebServer } from './web.mjs';
import { hashPassword } from './web-auth.mjs';
import { Client } from '../sync/client.mjs';
import { git, value, save, sha256 } from '../sync/git.mjs';
import { withWorkspaceLock } from '../sync/workspace-lock.mjs';
import { run } from '../core/process.mjs';

const origin = 'http://localhost';
const original = Buffer.from('\uFEFF---\r\n# comment\r\nunknown: "value"\r\nblock: |\r\n  untouched\r\n---\r\n你好 café\r\n');
const evidence = (scenario, data) => console.log(JSON.stringify({ scenario, ...data }));
async function fixture(t, twoUsers = false, withStatic = false) {
  const home = await mkdtemp(path.join(tmpdir(), 'infohub-web-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const remote = path.join(home, 'remote.git'), workspace = path.join(home, 'workspace'), peer = path.join(home, 'peer');
  await git(home, ['init', '--bare', '--initial-branch=main', remote]);
  await git(home, ['clone', remote, workspace]);
  await git(workspace, ['config', 'user.name', 'Fixture']); await git(workspace, ['config', 'user.email', 'fixture@test.local']);
  await git(workspace, ['config', 'core.autocrlf', 'false']);
  await mkdir(path.join(workspace, 'ontology')); await mkdir(path.join(workspace, 'docs'));
  await writeFile(path.join(workspace, 'ontology/ontology.json'), JSON.stringify({
    folders: ['ontology', 'docs'], primaryKey: 'ontology_id',
    properties: { ontology_id: { type: 'text', required: true }, ontology_type: { type: 'text', required: true }, title: { type: 'text', required: true } },
    objectTypes: { project: { properties: {} }, work_item: { properties: { project_id: { type: 'id', required: true }, requirement: { type: 'text', required: true }, progress: { type: 'text', required: true } } } },
    relations: { belongs_to: { sourceTypes: ['work_item'], sourceField: 'project_id', targetTypes: ['project'], targetField: 'ontology_id', cardinality: 'many-to-one', outgoingLabel: '项目', incomingLabel: '工作' } },
  }));
  await writeFile(path.join(workspace, 'docs/project.md'), '---\nontology_id: project-1\nontology_type: project\ntitle: Project\n---\nSearch needle\n');
  await writeFile(path.join(workspace, 'docs/work.md'), '---\nontology_id: work-1\nontology_type: work_item\ntitle: Work\nproject_id: project-1\nrequirement: 已明确\nprogress: 实施中\n---\n');
  await writeFile(path.join(workspace, 'raw.txt'), original);
  await writeFile(path.join(workspace, 'image.png'), Buffer.from([137, 80, 78, 71, 0, 255, 1]));
  await git(workspace, ['add', '.']); await git(workspace, ['commit', '-m', 'initial']); await git(workspace, ['push', 'origin', 'main']);
  await git(home, ['clone', remote, peer]);
  await git(peer, ['config', 'user.name', 'Peer']); await git(peer, ['config', 'user.email', 'peer@test.local']);
  await save(path.join(workspace, '.git/infohub-sync/config.json'), { workspaceLock: true, identity: { user: 'lpmasser', machine: '网页/netcup' }, idleSeconds: 3600, draftSeconds: .1, fetchSeconds: .1 });
  const client = await Client.open(workspace); await client.tick();
  const password = 'test-only-password', passwordHash = await hashPassword(password);
  const users = [{ username: 'lpmasser', passwordHash, workspace }];
  if (twoUsers) {
    const second = path.join(home, 'second');
    await git(home, ['clone', remote, second]);
    await save(path.join(second, '.git/infohub-sync/config.json'), { workspaceLock: true });
    await writeFile(path.join(second, 'private.txt'), 'second user only');
    users.push({ username: 'second', passwordHash, workspace: second });
  }
  let staticDir;
  if (withStatic) {
    staticDir = path.join(home, 'static'); await mkdir(path.join(staticDir, 'assets'), { recursive: true });
    await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Static fixture</title><script type="module" src="/assets/app.js"></script>');
    await writeFile(path.join(staticDir, 'assets/app.js'), 'console.log("version one");\n');
    await writeFile(path.join(staticDir, 'assets/app.css'), 'body { color: blue; }\n');
  }
  const app = await createWebServer({ version: 1, origin, users, ...(staticDir ? { staticDir } : {}) }, { eventIntervalMs: 100 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ username: 'lpmasser', password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (url, options = {}) => fetch(base + url, { ...options, headers: { Cookie: cookie, Origin: origin, ...options.headers } });
  return { home, remote, workspace, peer, client, app, base, cookie, request, staticDir };
}
const fileURL = name => `/api/file?source=workspace&path=${encodeURIComponent(name)}`;

test('HTTP versions protect raw bytes, concurrent writes, delete/move/create, and read-only snapshots', async t => {
  const f = await fixture(t), get = await f.request(fileURL('raw.txt')), version = get.headers.get('etag');
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), original);
  const before = await value(f.workspace, ['status', '--porcelain']);
  const saved = await f.request(fileURL('raw.txt'), { method: 'PUT', headers: { 'If-Match': version }, body: original });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).unchanged, true);
  assert.equal(await value(f.workspace, ['status', '--porcelain']), before);
  assert.deepEqual(await readFile(path.join(f.workspace, 'raw.txt')), original);
  evidence('raw-byte-no-op', { status: 200, sha256: sha256(original), gitDiff: before });
  const missingCondition = await f.request(fileURL('raw.txt'), { method: 'PUT', body: 'bad' }); assert.equal(missingCondition.status, 428);
  const first = await f.request(fileURL('raw.txt'), { method: 'PUT', headers: { 'If-Match': version }, body: Buffer.from([0, 255, 10, 13]) });
  assert.equal(first.status, 200); const current = first.headers.get('etag');
  for (const method of ['PUT', 'DELETE']) {
    const stale = await f.request(fileURL('raw.txt'), { method, headers: { 'If-Match': version }, ...(method === 'PUT' ? { body: 'overwrite' } : {}) });
    assert.equal(stale.status, 409); assert.equal((await stale.json()).error.currentVersion, current);
  }
  const staleMove = await f.request('/api/move?source=workspace', { method: 'POST', headers: { 'If-Match': version }, body: JSON.stringify({ path: 'raw.txt', destination: 'renamed.txt', destinationVersion: null }) });
  assert.equal(staleMove.status, 409);
  assert.deepEqual(await readFile(path.join(f.workspace, 'raw.txt')), Buffer.from([0, 255, 10, 13]));
  evidence('stale-conditions-do-not-overwrite', { put: 409, delete: 409, move: 409, current });
  const created = await f.request(fileURL('new/path.txt'), { method: 'PUT', headers: { 'If-None-Match': '*' }, body: 'new\r\n' }); assert.equal(created.status, 201);
  assert.equal((await f.request(fileURL('new/path.txt'), { method: 'PUT', headers: { 'If-None-Match': '*' }, body: 'bad' })).status, 409);
  const moveConflict = await f.request('/api/move?source=workspace', { method: 'POST', headers: { 'If-Match': current }, body: JSON.stringify({ path: 'raw.txt', destination: 'new/path.txt', destinationVersion: null }) }); assert.equal(moveConflict.status, 409);
  const moved = await f.request('/api/move?source=workspace', { method: 'POST', headers: { 'If-Match': current }, body: JSON.stringify({ path: 'raw.txt', destination: 'renamed.txt', destinationVersion: null }) }); assert.equal(moved.status, 200);
  assert.equal((await f.request(fileURL('renamed.txt'), { method: 'DELETE', headers: { 'If-Match': current } })).status, 200);
  const main = await f.request('/api/file?source=main&path=raw.txt'); assert.deepEqual(Buffer.from(await main.arrayBuffer()), original);
  const ro = await f.request('/api/file?source=main&path=raw.txt', { method: 'PUT', headers: { 'If-Match': version }, body: 'bad' }); assert.equal(ro.status, 403);
  await f.client.tick(); await f.client.tick();
  const sources = await (await f.request('/api/sources')).json(), draft = sources.sources.find(s => s.id.startsWith('draft:'));
  assert.ok(draft);
  const draftRead = await f.request(`/api/file?source=${draft.id}&path=new/path.txt`); assert.equal(await draftRead.text(), 'new\r\n');
  const png = await f.request(fileURL('image.png')); assert.equal(png.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await png.arrayBuffer()), Buffer.from([137, 80, 78, 71, 0, 255, 1]));
  const parallelVersion = (await f.request(fileURL('new/path.txt'))).headers.get('etag');
  await writeFile(path.join(f.workspace, '.git/infohub-sync/workspace.pid'), '2147483647');
  const results = await Promise.all(['one', 'two'].map(body => f.request(fileURL('new/path.txt'), { method: 'PUT', headers: { 'If-Match': parallelVersion }, body })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
});

test('SSE sees actual sync fast-forward; stale browser save loses no remote bytes; configured author and identity', async t => {
  const f = await fixture(t), old = (await f.request(fileURL('raw.txt'))).headers.get('etag');
  const abort = new AbortController();
  const stream = await f.request('/api/events', { signal: abort.signal });
  const reader = stream.body.getReader(), decoder = new TextDecoder(); let events = '';
  const waitFor = async pattern => {
    const deadline = Date.now() + 8000;
    while (!pattern.test(events)) {
      if (Date.now() > deadline) throw new Error('SSE timeout');
      const { value, done } = await reader.read(); if (done) throw new Error('SSE ended'); events += decoder.decode(value);
    }
  };
  try {
    await waitFor(/event: ready/);
    await writeFile(path.join(f.peer, 'raw.txt'), 'remote fast-forward\r\n');
    await git(f.peer, ['add', '.']); await git(f.peer, ['commit', '-m', 'remote change']); await git(f.peer, ['push', 'origin', 'main']);
    await f.client.tick();
    await waitFor(/event: files\ndata: .*"path":"raw.txt"/);
    assert.equal(await readFile(path.join(f.workspace, 'raw.txt'), 'utf8'), 'remote fast-forward\r\n');
    const stale = await f.request(fileURL('raw.txt'), { method: 'PUT', headers: { 'If-Match': old }, body: original });
    assert.equal(stale.status, 409); assert.equal(await readFile(path.join(f.workspace, 'raw.txt'), 'utf8'), 'remote fast-forward\r\n');
    evidence('sync-fast-forward-sse-and-stale-save', { lastPull: f.client.state.lastPull, sse: events.split('\n').filter(line => line.startsWith('event:') || line.includes('raw.txt')), staleSave: 409 });
    let release; const gate = new Promise(resolve => { release = resolve; }); let entered;
    const acquired = new Promise(resolve => { entered = resolve; });
    const holding = withWorkspaceLock(f.workspace, async () => { entered(); await gate; await writeFile(path.join(f.workspace, 'raw.txt'), 'changed while locked\n'); }); await acquired;
    const current = (await f.request(fileURL('raw.txt'))).headers.get('etag');
    const pendingWrite = f.request(fileURL('raw.txt'), { method: 'PUT', headers: { 'If-Match': current }, body: 'local protected\n' });
    await Promise.race([pendingWrite.then(() => { throw new Error('write bypassed workspace lock'); }), new Promise(resolve => setTimeout(resolve, 50))]);
    release(); await holding; assert.equal((await pendingWrite).status, 409);
    const refreshed = (await f.request(fileURL('raw.txt'))).headers.get('etag');
    assert.equal((await f.request(fileURL('raw.txt'), { method: 'PUT', headers: { 'If-Match': refreshed }, body: 'local protected\n' })).status, 200);
    f.client.settings.idleSeconds = .001;
    await f.client.tick(); await new Promise(resolve => setTimeout(resolve, 20)); await f.client.tick();
    assert.equal(await value(f.workspace, ['log', '-1', '--format=%an']), 'lpmasser');
    assert.match(await value(f.workspace, ['log', '-1', '--format=%B']), /lpmasser@网页\/netcup/);
    assert.deepEqual([f.client.id.user, f.client.id.machine], ['lpmasser', '网页/netcup']);
    const normal = await Client.open(f.peer); assert.equal(normal.id.machine, hostname()); assert.equal(normal.id.user, userInfo().username);
    evidence('configured-sync-author-and-default-identity', { author: 'lpmasser', source: f.client.id.machine, defaultMachine: normal.id.machine, defaultUser: normal.id.user });
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
});

test('authentication, path boundary, full text and JSON query parity with CLI', async t => {
  const f = await fixture(t, true);
  const secondLogin = await fetch(f.base + '/api/login', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ username: 'second', password: 'test-only-password' }) });
  const secondCookie = secondLogin.headers.get('set-cookie').split(';')[0];
  assert.equal(await (await fetch(f.base + fileURL('private.txt'), { headers: { Cookie: secondCookie } })).text(), 'second user only');
  assert.equal((await f.request(fileURL('private.txt') + '&username=second&workspace=' + encodeURIComponent(path.join(f.home, 'second')))).status, 404);
  assert.equal((await fetch(f.base + '/api/tree?source=workspace')).status, 401);
  assert.equal((await fetch(f.base + '/api/login', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ username: 'lpmasser', password: 'wrong' }) })).status, 401);
  assert.equal((await f.request(fileURL('raw.txt'), { method: 'PUT', headers: { Origin: 'https://other.example', 'If-None-Match': '*' }, body: 'bad' })).status, 403);
  for (const name of ['.git/config', '../secret', 'docs/../../secret', 'C:\\secret']) assert.equal((await f.request(fileURL(name))).status, 400);
  if (process.platform !== 'win32') {
    await symlink(f.home, path.join(f.workspace, 'escape'));
    assert.equal((await f.request(fileURL('escape/remote.git/config'))).status, 403);
  }
  const search = await (await f.request('/api/search?source=main&q=needle')).json();
  assert.deepEqual(search.matches, [{ path: 'docs/project.md', line: 6, snippet: 'Search needle' }]);
  const tree = await (await f.request('/api/tree?source=workspace')).json(); assert.ok(tree.entries.some(e => e.path === 'docs' && e.type === 'directory'));
  for (const [route, cliArgs] of [
    ['/api/find?source=workspace&arg=--type&arg=work_item', ['find', '--type', 'work_item', '--json']],
    ['/api/get?source=workspace&target=work-1', ['get', 'work-1', '--json']],
    ['/api/around?source=workspace&arg=work-1', ['around', 'work-1', '--json']],
    ['/api/overview?source=workspace', ['overview']],
    ['/api/sync/status?source=workspace', ['sync', 'status']],
  ]) {
    const api = await f.request(route); assert.equal(api.status, 200);
    const cli = await run('node', [path.resolve(import.meta.dirname, '../cli/infohub.mjs'), '--root', f.workspace, ...cliArgs]);
    assert.deepEqual(await api.json(), JSON.parse(cli.stdout));
  }
  evidence('http-cli-json-parity', { queries: ['find v1', 'get v1', 'around v1', 'overview v3', 'sync status v1'], unauthenticated: 401 });
  assert.equal((await f.request('/api/logout', { method: 'POST' })).status, 200);
  assert.equal((await f.request('/api/session')).status, 401);
});


test('optional static directory serves live assets and SPA routes while API remains authenticated', async t => {
  const f = await fixture(t, false, true);
  const index = await fetch(f.base + '/');
  assert.equal(index.status, 200); assert.match(index.headers.get('content-type'), /^text\/html/);
  const html = await index.text(); assert.match(html, /Static fixture/);
  for (const route of ['/projects/one', '/projects/one/', '/assets/missing.js']) {
    const response = await fetch(f.base + route); assert.equal(response.status, 200); assert.equal(await response.text(), html);
  }
  const js = await fetch(f.base + '/assets/app.js'), version = js.headers.get('etag');
  assert.match(js.headers.get('content-type'), /^text\/javascript/); assert.equal(await js.text(), 'console.log("version one");\n');
  assert.equal((await fetch(f.base + '/assets/app.js', { headers: { 'If-None-Match': version } })).status, 304);
  const css = await fetch(f.base + '/assets/app.css'); assert.match(css.headers.get('content-type'), /^text\/css/);
  await writeFile(path.join(f.staticDir, 'assets/app.js'), 'console.log("version two");\n');
  const updated = await fetch(f.base + '/assets/app.js'); assert.equal(await updated.text(), 'console.log("version two");\n'); assert.notEqual(updated.headers.get('etag'), version);
  assert.equal((await fetch(f.base + '/api/tree?source=workspace')).status, 401);
  assert.equal((await fetch(f.base + '/api')).status, 401);
  const unknownAPI = await f.request('/api/no-such-route?source=workspace'); assert.equal(unknownAPI.status, 404); assert.equal((await unknownAPI.json()).error.code, 'NOT_FOUND');
  assert.deepEqual(await (await fetch(f.base + '/health')).json(), { ok: true });
  for (const route of ['/assets/%2e%2e%2fsecret', '/assets/%5csecret', '/.env']) assert.equal((await fetch(f.base + route)).status, 400);
  if (process.platform !== 'win32') {
    await symlink(path.join(f.home, 'workspace'), path.join(f.staticDir, 'escape'));
    assert.equal((await fetch(f.base + '/escape/raw.txt')).status, 403);
  }
  await rm(path.join(f.staticDir, 'index.html'));
  assert.equal((await fetch(f.base + '/missing-spa-route')).status, 404);
  console.log(JSON.stringify({ scenario: 'live-static-SPA', root: 200, asset: 200, fallback: 200, conditional: 304, liveAssetUpdate: true, protectedAPI: 401, apiFallback: false }));
});

test('omitting staticDir retains the placeholder and non-root 404', async t => {
  const f = await fixture(t);
  const root = await fetch(f.base + '/'); assert.equal(root.status, 200); assert.match(await root.text(), /Web API/);
  assert.equal((await fetch(f.base + '/projects/one')).status, 404);
});
