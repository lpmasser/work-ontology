import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { git, value, save } from './git.mjs';
import { status } from './command.mjs';
import { ensureOnDemand } from './on-demand.mjs';

async function until(fn, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'InfoHub 按需-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') };
  const root = path.join(home, 'clone'), remote = path.join(home, 'remote.git');
  await git(home, ['init', '--bare', '--initial-branch=main', remote]);
  await git(home, ['clone', remote, root]);
  await git(root, ['config', 'user.name', 'On demand test']);
  await git(root, ['config', 'user.email', 'test@infohub.local']);
  await writeFile(path.join(root, '.gitattributes'), '* text=auto eol=lf\n');
  await mkdir(path.join(root, 'ontology'));
  await writeFile(path.join(root, 'ontology/ontology.json'), JSON.stringify({ folders: ['ontology', 'docs'], primaryKey: 'ontology_id', properties: { ontology_id: { type: 'text', required: true }, ontology_type: { type: 'text', required: true }, title: { type: 'text', required: true } }, objectTypes: { project: { properties: {} } }, relations: {} }));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs/project.md'), '---\nontology_id: project-1\nontology_type: project\ntitle: Fixture\n---\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'fixture']); await git(root, ['push', 'origin', 'main']);
  await save(path.join(root, '.git/infohub-sync/config.json'), { fetchSeconds: .15, draftSeconds: .2, idleSeconds: .8 });
  t.after(async () => {
    // A failed assertion still leaves a finite idle interval, not a native host.
    await until(async () => !(await status(root)).running, 'fixture loop did not exit');
    await rm(home, { recursive: true, force: true });
  });
  return { home, root, remote, env };
}

test('opening refresh fast-forwards before returning, concurrent starts share one PID, clean idle exits', async t => {
  const f = await fixture(t);
  const peer = path.join(f.home, 'peer');
  await git(f.home, ['clone', f.remote, peer]);
  await git(peer, ['config', 'user.name', 'Peer']); await git(peer, ['config', 'user.email', 'peer@infohub.local']);
  await writeFile(path.join(peer, 'incoming.txt'), 'new remote content\n');
  await git(peer, ['add', '.']); await git(peer, ['commit', '-m', 'advance']); await git(peer, ['push', 'origin', 'main']);
  const started = Date.now();
  const first = await ensureOnDemand(f.root, { refresh: true, exitSeconds: 2 });
  assert.equal(first.reason, '');
  assert.equal(await readFile(path.join(f.root, 'incoming.txt'), 'utf8'), 'new remote content\n');
  await until(async () => (await status(f.root)).running, 'no detached loop');
  const pid = (await status(f.root)).pid;
  await Promise.all(Array.from({ length: 4 }, () => ensureOnDemand(f.root, { exitSeconds: 2 })));
  assert.equal((await status(f.root)).pid, pid);
  assert.equal((await status(f.root)).manager, 'on-demand');
  await until(async () => !(await status(f.root)).running, 'clean idle loop did not exit');
  assert.equal(await value(f.root, ['status', '--porcelain']), '');
  console.log(JSON.stringify({ scenario: 'refresh-concurrency-idle-exit', elapsedMs: Date.now() - started, pid }));
});

test('dirty content keeps the loop until backup, idle commit and push', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'unfinished.txt'), 'draft\n');
  const log = [];
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../cli/infohub.mjs'), '--root', f.root, 'sync', 'run', '--on-demand', '--exit-after-seconds', '.2'], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => log.push(data)); child.stderr.on('data', data => log.push(data));
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await until(async () => Boolean((await status(f.root)).lastDraft), 'no draft backup');
  const code = await done;
  assert.equal(code, 0, Buffer.concat(log).toString());
  const s = await status(f.root);
  assert.ok(s.lastCommit); assert.ok(s.lastPush);
  assert.equal(await value(f.root, ['rev-parse', 'HEAD']), await value(f.remote, ['rev-parse', 'main']));
  assert.equal(await value(f.root, ['status', '--porcelain']), '');
  console.log(JSON.stringify({ scenario: 'draft-commit-push-before-exit', lastDraft: s.lastDraft, lastCommit: s.lastCommit, lastPush: s.lastPush }));
});

test('offline opening explains the skip, still launches the loop and only exits after fetch recovers', async t => {
  const f = await fixture(t);
  await git(f.root, ['remote', 'set-url', 'origin', path.join(f.home, 'offline.git')]);
  const opened = await ensureOnDemand(f.root, { refresh: true, exitSeconds: .3 });
  assert.match(opened.reason, /git/);
  await until(async () => (await status(f.root)).running, 'offline brief did not launch a loop');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal((await status(f.root)).running, true);
  await git(f.root, ['remote', 'set-url', 'origin', f.remote]);
  await until(async () => !(await status(f.root)).running, 'loop did not exit after network recovery');
  assert.ok((await status(f.root)).lastFetch);
});
