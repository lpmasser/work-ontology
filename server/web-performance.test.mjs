import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Files, etag } from './web-files.mjs';
import { WorkspaceEvents } from './web-events.mjs';
import { Sessions, hashPassword } from './web-auth.mjs';
import { git, value } from '../sync/git.mjs';

async function repository(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'infohub-web-cost-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'Test']); await git(root, ['config', 'user.email', 'test@example.invalid']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await mkdir(path.join(root, 'docs'));
  return root;
}

test('unchanged SSE scans read zero content bytes; replacement/deletion preserve ETag semantics', async t => {
  const root = await repository(t);
  for (let i = 0; i < 100; i++) await writeFile(path.join(root, `docs/${i}.txt`), 'a'.repeat(4096));
  const files = new Files(root), read = files.read.bind(files);
  let bytesRead = 0;
  files.read = async (...args) => { const bytes = await read(...args); bytesRead += bytes.length; return bytes; };
  const events = new WorkspaceEvents(files, { get() { return {}; } });
  t.after(() => events.close());
  const emitted = []; events.emit = (type, data) => emitted.push({ type, data });
  await events.scan(); const baseline = bytesRead;
  assert.equal(baseline, 409600);
  emitted.length = 0; bytesRead = 0;
  await events.scan(); await events.scan();
  assert.equal(bytesRead, 0); assert.ok(!emitted.some(e => e.type === 'files'));
  const before = await stat(path.join(root, 'docs/1.txt'));
  const replacement = path.join(root, '.replacement');
  await writeFile(replacement, 'b'.repeat(4096)); await utimes(replacement, before.atime, before.mtime);
  await rename(replacement, path.join(root, 'docs/1.txt'));
  await rm(path.join(root, 'docs/2.txt'));
  await events.scan();
  assert.equal(bytesRead, 4096);
  const changes = emitted.filter(e => e.type === 'files').flatMap(e => e.data.changes);
  assert.deepEqual(changes, [{ path: 'docs/1.txt', version: etag(Buffer.from('b'.repeat(4096))) }, { path: 'docs/2.txt', version: null }]);
  bytesRead = 0; emitted.length = 0;
  const same = await stat(path.join(root, 'docs/1.txt'));
  await utimes(path.join(root, 'docs/1.txt'), same.atime, new Date(same.mtimeMs + 2000));
  await events.scan(); assert.equal(bytesRead, 4096); assert.ok(!emitted.some(e => e.type === 'files'));
  console.log(JSON.stringify({ scenario: 'SSE-stat-cache', files: 100, baselineBytes: baseline, unchangedScansBytes: 0, oneReplacementBytes: 4096, deletionVersion: null }));
});

test('commit content scan traverses one tree and reads bounded batches with binary fidelity', async t => {
  const root = await repository(t), expected = new Map();
  for (let i = 0; i < 100; i++) expected.set(`docs/file-${i}.txt`, Buffer.from('needle\r\n'.repeat(512)));
  for (let i = 0; i < 4; i++) expected.set(`docs/part-${i}.txt`, Buffer.alloc((i === 3 ? 2 : 5) * 1024 * 1024, 97 + i));
  expected.set('docs/中文 space.bin', Buffer.from([0, 255, 10, 13, 0]));
  expected.set('docs/empty.txt', Buffer.alloc(0));
  for (const [name, bytes] of expected) await writeFile(path.join(root, name), bytes);
  await writeFile(path.join(root, 'docs/oversize.bin'), Buffer.alloc(6 * 1024 * 1024));
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'batch fixture']);
  const commit = await value(root, ['rev-parse', 'HEAD']);
  const trace = path.join(root, '.trace.jsonl'), prior = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace.replaceAll('\\', '/');
  try {
    const files = new Files(root); let count = 0;
    for await (const file of files.contents({ commit }, 5 * 1024 * 1024)) {
      if (file.path === 'docs/oversize.bin') { assert.equal(file.bytes, null); continue; }
      assert.deepEqual(file.bytes, expected.get(file.path)); count++;
    }
    assert.equal(count, expected.size);
  } finally { if (prior === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = prior; }
  const starts = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(e => e.event === 'start');
  const trees = starts.filter(e => e.argv.includes('ls-tree')), batches = starts.filter(e => e.argv.includes('cat-file'));
  assert.equal(trees.length, 1); assert.equal(batches.length, 2); assert.equal(starts.length, 3);
  console.log(JSON.stringify({ scenario: 'commit-batched-read', files: expected.size + 1, lsTreeProcesses: trees.length, catFileProcesses: batches.length, bytesVerified: [...expected.values()].reduce((n, b) => n + b.length, 0), oversizeSkipped: true }));
});

test('full login-attempt cache cannot deny unrelated valid credentials and evicts oldest failed key', async () => {
  const users = [{ username: 'alice', passwordHash: await hashPassword('test-password') }];
  const sessions = new Sessions(users);
  for (let i = 0; i < 1000; i++) sessions.attempts.set(`remote:attacker${i}`, { count: 10, until: Date.now() + 60000 });
  assert.equal((await sessions.login('alice', 'test-password', 'remote')).user.username, 'alice');
  assert.deepEqual(await sessions.login('new-name', 'wrong', 'remote'), {});
  assert.equal(sessions.attempts.size, 1000); assert.equal(sessions.attempts.has('remote:attacker0'), false);
  assert.deepEqual(await sessions.login('attacker999', 'wrong', 'remote'), { limited: true });
  assert.equal((await sessions.login('alice', 'test-password', 'other-address')).user.username, 'alice');
  console.log(JSON.stringify({ scenario: 'bounded-login-attempts', records: sessions.attempts.size, unrelatedLoginSucceeded: true, oldestEvicted: true, existingLimitedKeyPreserved: true }));
});
