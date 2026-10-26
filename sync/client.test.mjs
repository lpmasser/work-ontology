import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Client, context } from './client.mjs';
import { git, value, save, json, run, DRAFT_PREFIX, sha256, iso } from './git.mjs';
import { scanDrafts } from '../server/drafts.mjs';
import { validateCommit } from './validate.mjs';
import { concerns, status } from './command.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const repoRoot = path.resolve(import.meta.dirname, '..');
async function until(fn, message, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  throw new Error(`Timeout: ${message}`);
}
async function fixture(t, idleSeconds = 3600) {
  const home = await mkdtemp(path.join(tmpdir(), 'infohub-sync-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bare = path.join(home, 'remote.git'), a = path.join(home, 'a'), b = path.join(home, 'b'), server = path.join(home, 'server');
  await git(home, ['init', '--bare', '--initial-branch=main', bare]);
  await git(home, ['clone', bare, a]);
  await git(a, ['config', 'user.name', 'Sync Test']); await git(a, ['config', 'user.email', 'sync@test.local']);
  await writeFile(path.join(a, '.gitattributes'), '* text=auto eol=lf\n');
  await mkdir(path.join(a, 'ontology')); await mkdir(path.join(a, 'docs'));
  await writeFile(path.join(a, 'ontology/ontology.json'), JSON.stringify({
    folders: ['ontology', 'docs'], primaryKey: 'ontology_id',
    properties: { ontology_id: {type:'text',required:true}, ontology_type: {type:'text',required:true}, title: {type:'text',required:true} },
    objectTypes: { project: {properties:{}}, work_item: {properties:{requirement:{type:'text',required:true},progress:{type:'text',required:true}}} }, relations: {}
  }));
  await writeFile(path.join(a, 'docs/project.md'), '---\nontology_id: project-1\nontology_type: project\ntitle: Test Project\n---\n');
  await writeFile(path.join(a, 'shared.txt'), '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n');
  await writeFile(path.join(a, 'one.txt'), 'base\n'); await writeFile(path.join(a, 'two.txt'), 'base\n');
  await git(a, ['add', '.']); await git(a, ['commit', '-m', 'base']); await git(a, ['push', 'origin', 'main']);
  await git(home, ['clone', bare, b]);
  await git(b, ['config', 'user.name', 'Peer']); await git(b, ['config', 'user.email', 'peer@test.local']);
  const client = await Client.open(a, { fetchSeconds: .1, draftSeconds: .1, idleSeconds });
  await scanDrafts(bare, server); await client.tick();
  return { home, bare, a, b, server, client };
}
async function peer(f, file, content) {
  await writeFile(path.join(f.b, file), content); await git(f.b, ['add', '.']); await git(f.b, ['commit', '-m', 'peer edit']); await git(f.b, ['push', 'origin', 'main']);
}
const evidence = (scenario, details) => console.log(JSON.stringify({ at: iso(), scenario, ...details }));

test('a repository under a Chinese path with spaces resolves through native Git paths', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'InfoHub 中文 路径-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await git(home, ['init', '--initial-branch=main']);
  await mkdir(path.join(home, 'nested'));
  const ctx = await context(path.join(home, 'nested', '..'));
  assert.equal(await value(ctx.root, ['rev-parse', '--is-inside-work-tree']), 'true');
  assert.equal(ctx.home, path.join(ctx.dir, 'infohub-sync'));
});

test('fast-forward updates independent files; dirty overlap, local commits and ongoing operations are skipped', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.a, 'one.txt'), 'local dirty\n');
  await peer(f, 'two.txt', 'remote update\n');
  const started = Date.now(); await f.client.tick();
  assert.equal(await readFile(path.join(f.a, 'two.txt'), 'utf8'), 'remote update\n');
  assert.equal(await readFile(path.join(f.a, 'one.txt'), 'utf8'), 'local dirty\n');
  evidence('remote-fast-forward-with-independent-dirty-file', { elapsedMs: Date.now() - started });
  await peer(f, 'one.txt', 'remote overlap\n');
  const head = await value(f.a, ['rev-parse', 'HEAD']);
  await f.client.tick();
  assert.equal(await value(f.a, ['rev-parse', 'HEAD']), head);
  assert.equal(await readFile(path.join(f.a, 'one.txt'), 'utf8'), 'local dirty\n');
  assert.match(f.client.state.pending.pull, /脏文件/);
  assert.ok((await concerns(f.a)).some(s => s.includes('脏文件')));
  evidence('dirty-overlap-visible', { pending: f.client.state.pending });
  await git(f.a, ['add', '.']); await git(f.a, ['commit', '-m', 'agent local commit']);
  await f.client.tick(); assert.match(f.client.state.pending.pull, /未推送/);
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    const target = path.join(f.a, '.git', marker);
    if (marker.includes('rebase') || marker === 'sequencer') await mkdir(target); else await writeFile(target, head);
    const before = await value(f.a, ['rev-parse', 'HEAD']); await f.client.tick();
    assert.match(f.client.state.pending.git, /进行中/); assert.equal(await value(f.a, ['rev-parse', 'HEAD']), before);
    await rm(target, { recursive: true });
  }
});

test('draft includes untracked/deleted/renamed files and local commits without changing the real index, HEAD or worktree', async t => {
  const f = await fixture(t);
  // Windows forbids newline characters in filenames; keep that case on POSIX.
  const unusualName = process.platform === 'win32' ? '中文 name.txt' : '中文 name\n.txt';
  await writeFile(path.join(f.a, 'one.txt'), 'staged\n'); await git(f.a, ['add', 'one.txt']);
  await writeFile(path.join(f.a, 'one.txt'), 'unstaged\n');
  await git(f.a, ['mv', 'two.txt', 'renamed.txt']); await writeFile(path.join(f.a, unusualName), 'new\n');
  const before = { head: await value(f.a, ['rev-parse', 'HEAD']), index: sha256(await readFile(path.join(f.a, '.git', 'index'))), status: (await git(f.a, ['status', '--porcelain=v1', '-z'])).stdout };
  await f.client.tick();
  const ref = `${DRAFT_PREFIX}${f.client.id.id}`;
  assert.equal(await value(f.bare, ['show', `${ref}:one.txt`]), 'unstaged');
  assert.equal(await value(f.bare, ['show', `${ref}:${unusualName}`]), 'new');
  assert.notEqual((await git(f.bare, ['show', `${ref}:two.txt`], { allowFailure: true })).code, 0);
  assert.equal(await value(f.bare, ['show', `${ref}:renamed.txt`]), 'base');
  assert.equal(await value(f.a, ['rev-parse', 'HEAD']), before.head);
  assert.equal(sha256(await readFile(path.join(f.a, '.git', 'index'))), before.index);
  assert.equal((await git(f.a, ['status', '--porcelain=v1', '-z'])).stdout, before.status);
  const reopened = await Client.open(f.a); assert.equal(reopened.id.id, f.client.id.id);
  const other = await Client.open(f.b); assert.notEqual(other.id.id, f.client.id.id);
  const commit = await value(f.bare, ['rev-parse', ref]);
  await sleep(150); await f.client.tick(); assert.equal(await value(f.bare, ['rev-parse', ref]), commit);
  evidence('draft-index-head-worktree-preserved', { ref, head: before.head, indexSha256: before.index, draftCommit: commit });
});

test('idle automatically commits all changes and pushes; server cleans content included in main', async t => {
  const f = await fixture(t, .15);
  await writeFile(path.join(f.a, 'one.txt'), 'idle modification\n'); await writeFile(path.join(f.a, 'new.txt'), 'idle untracked\n');
  await f.client.tick(); const draft = f.client.state.draft;
  await sleep(200); await f.client.tick();
  assert.equal(await value(f.bare, ['show', 'main:new.txt']), 'idle untracked');
  assert.equal(await value(f.a, ['status', '--porcelain']), '');
  assert.match(await value(f.bare, ['log', '-1', '--format=%B', 'main']), /自动提交/);
  const s = await scanDrafts(f.bare, f.server); assert.equal(s.drafts.length, 0);
  assert.notEqual((await git(f.bare, ['rev-parse', '--verify', draft.ref], { allowFailure: true })).code, 0);
  evidence('idle-pushed-and-draft-cleaned', { main: await value(f.bare, ['rev-parse', 'main']), lastPush: f.client.state.lastPush, cleaned: s.cleaned });
});

const invalidDoc = '---\nontology_id: work_item-1\nontology_type: work_item\ntitle: Unfinished\n---\n';
const validDoc = invalidDoc.replace('title: Unfinished', 'title: Unfinished\nrequirement: ready\nprogress: active');
async function validator(t, f) {
  const listener = net.createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r)); const port = listener.address().port; await new Promise(r => listener.close(r));
  const service = spawn(process.execPath, [path.join(repoRoot, 'server/main.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  t.after(() => service.kill()); await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 'validator');
  await copyFile(path.join(repoRoot, 'hooks/pre-receive'), path.join(f.bare, 'hooks/pre-receive')); await chmod(path.join(f.bare, 'hooks/pre-receive'), 0o755);
  const url = `http://127.0.0.1:${port}/validate`;
  await git(f.bare, ['config', 'infohub.validateUrl', url]);
  return url;
}

test('invalid idle draft is rejected before add/commit, matches server validation, and does not block unrelated incoming updates', async t => {
  const f = await fixture(t, .15); await validator(t, f);
  await writeFile(path.join(f.a, 'docs/unfinished.md'), invalidDoc);
  const before = await value(f.a, ['rev-parse', 'HEAD']), index = sha256(await readFile(path.join(f.a, '.git/index')));
  await f.client.tick(); await sleep(200); await f.client.tick();
  assert.equal(await value(f.a, ['rev-parse', 'HEAD']), before);
  assert.equal(sha256(await readFile(path.join(f.a, '.git/index'))), index);
  assert.match(f.client.state.pending.validation, /requirement.*progress/);
  assert.equal(await value(f.bare, ['show', `${f.client.state.draft.ref}:docs/unfinished.md`]), invalidDoc.trim());
  // The exact same frozen candidate is rejected by the actual receive hook too.
  const server = await git(f.a, ['push', 'origin', `${f.client.state.draft.commit}:refs/heads/main`], { allowFailure: true });
  assert.notEqual(server.code, 0); assert.match(server.stderr, /requirement.*progress/);
  assert.equal(await value(f.bare, ['rev-parse', 'main']), before);
  await peer(f, 'two.txt', 'incoming while invalid draft waits\n'); await f.client.tick();
  assert.equal(await readFile(path.join(f.a, 'two.txt'), 'utf8'), 'incoming while invalid draft waits\n');
  assert.equal(await value(f.a, ['rev-parse', 'HEAD']), await value(f.bare, ['rev-parse', 'main']));
  assert.ok((await concerns(f.a)).some(s => s.includes('提交前校验')));
  evidence('precommit-validation-preserves-head-and-incoming', { previousHead: before, head: await value(f.a, ['rev-parse', 'HEAD']), indexBefore: index, pending: f.client.state.pending });
  await writeFile(path.join(f.a, 'docs/unfinished.md'), validDoc); await f.client.tick(); await sleep(200); await f.client.tick();
  assert.equal(await value(f.bare, ['show', 'main:docs/unfinished.md']), validDoc.trim());
  assert.equal(f.client.state.pending.validation, undefined);
});

test('server detects conflicts for both clients and lists stale drafts; merged content cleanup works without draft ancestry', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.a, 'one.txt'), 'draft change\n'); await f.client.tick();
  await peer(f, 'one.txt', 'remote conflict\n');
  let report = await scanDrafts(f.bare, f.server, { staleSeconds: .01 });
  assert.deepEqual(report.drafts[0].conflicts, ['one.txt']);
  await sleep(30); report = await scanDrafts(f.bare, f.server, { staleSeconds: .01 }); assert.equal(report.drafts[0].stale, true);
  const other = await Client.open(f.b); await f.client.tick(); await other.tick();
  assert.ok((await concerns(f.a)).some(s => s.includes('冲突'))); assert.ok((await concerns(f.b)).some(s => s.includes('冲突')));
  evidence('server-conflicts-and-stale-visible-to-both', { draft: report.drafts[0] });
  await peer(f, 'one.txt', 'draft change\n');
  report = await scanDrafts(f.bare, f.server); assert.equal(report.drafts.length, 0);
});

test('an Agent commit pauses inside its hook: daemon skips and preserves staged/working changes', async t => {
  const f = await fixture(t, .05);
  await writeFile(path.join(f.a, 'one.txt'), 'agent staged\n'); await git(f.a, ['add', 'one.txt']);
  await writeFile(path.join(f.a, 'one.txt'), 'agent unstaged\n');
  const hook = path.join(f.a, '.git/hooks/pre-commit');
  await writeFile(hook, '#!/bin/sh\nprintf ready > .git/agent-ready\nwhile [ ! -f .git/agent-release ]; do sleep 0.05; done\n'); await chmod(hook, 0o755);
  // This is another actor, outside the synchronizer's per-clone Git queue.
  const agent = run('git', ['commit', '-m', 'agent commit'], { cwd: f.a, timeoutMs: 30000, processGroup: true });
  await until(async () => { try { return await readFile(path.join(f.a, '.git/agent-ready'), 'utf8'); } catch { return false; } }, 'agent lock');
  const before = sha256(await readFile(path.join(f.a, '.git/index')));
  try {
    await f.client.tick(); assert.match(f.client.state.pending.git, /进程|锁/);
    assert.equal(sha256(await readFile(path.join(f.a, '.git/index'))), before);
  } finally { await writeFile(path.join(f.a, '.git/agent-release'), 'go'); await agent; }
  assert.equal(await value(f.a, ['show', 'HEAD:one.txt']), 'agent staged');
  assert.equal(await readFile(path.join(f.a, 'one.txt'), 'utf8'), 'agent unstaged\n');
  await git(f.a, ['fsck', '--no-dangling']);
  evidence('concurrent-agent-commit-preserved', { pending: f.client.state.pending, head: await value(f.a, ['rev-parse', 'HEAD']) });
});

test('real daemon receives remote content in seconds and resumes after SIGKILL', async t => {
  const f = await fixture(t);
  await save(path.join(f.a, '.git/infohub-sync/config.json'), { fetchSeconds: 1, draftSeconds: .2, idleSeconds: 3600 });
  let child;
  const launch = () => { child = spawn(process.execPath, [path.join(repoRoot, 'cli/infohub.mjs'), '--root', f.a, 'sync', 'run'], { stdio: 'ignore' }); return child; };
  t.after(() => child?.kill()); launch();
  await until(async () => (await status(f.a)).running, 'daemon starts');
  const start = Date.now(); await peer(f, 'two.txt', 'live remote\n');
  await until(async () => (await readFile(path.join(f.a, 'two.txt'), 'utf8')) === 'live remote\n', 'remote arrival');
  const latency = Date.now() - start;
  // Wait for the completed tick to be persisted before forcing the parent down.
  await until(async () => Boolean((await status(f.a)).lastPull), 'pull tick completed');
  const previousDraft = (await status(f.a)).draft?.commit;
  const exit = new Promise(r => child.on('exit', r)); child.kill('SIGKILL'); await exit;
  await writeFile(path.join(f.a, 'after-kill.txt'), 'saved after restart\n');
  launch(); await until(async () => (await status(f.a)).running, 'restart');
  const ref = `${DRAFT_PREFIX}${f.client.id.id}`;
  // Poll the file-only status API. Repeated git-show probes can themselves
  // keep Windows' conservative any-Git-process guard busy and starve the daemon.
  let resumed;
  await until(async () => {
    resumed = await status(f.a);
    return resumed.draft && resumed.draft.commit !== previousDraft;
  }, 'resumed draft').catch(error => { throw new Error(`${error.message}: ${JSON.stringify(resumed?.pending)}`); });
  assert.equal(await value(f.bare, ['show', `${ref}:after-kill.txt`]), 'saved after restart');
  assert.equal(await value(f.a, ['status', '--porcelain']), '?? after-kill.txt');
  evidence('daemon-kill-restart', { remoteLatencyMs: latency, restartedPid: child.pid, ref });
  const end = new Promise(r => child.on('exit', r)); child.kill(); await end; child = null;
});


test('unpublished Agent commits are preserved in the draft ancestry and idle push', async t => {
  const f = await fixture(t, .15);
  await writeFile(path.join(f.a, 'agent.txt'), 'agent local commit\n');
  await git(f.a, ['add', '.']); await git(f.a, ['commit', '-m', 'not yet pushed']);
  const agentHead = await value(f.a, ['rev-parse', 'HEAD']);
  await writeFile(path.join(f.a, 'pending.txt'), 'idle working change\n');
  await f.client.tick();
  assert.equal(await value(f.bare, ['show', `${f.client.state.draft.ref}:agent.txt`]), 'agent local commit');
  assert.equal(await value(f.bare, ['rev-parse', `${f.client.state.draft.ref}^`]), agentHead);
  await sleep(200); await f.client.tick();
  assert.equal(await value(f.bare, ['show', 'main:pending.txt']), 'idle working change');
  assert.equal(await value(f.bare, ['show', 'main:agent.txt']), 'agent local commit');
});


test('preflight validates the frozen commit even when the live worktree has different content', async t => {
  const f = await fixture(t);
  const base = await value(f.a, ['rev-parse', 'HEAD']);
  await writeFile(path.join(f.a, 'docs/frozen.md'), validDoc); await git(f.a, ['add', '.']); await git(f.a, ['commit', '-m', 'valid candidate']);
  const valid = await value(f.a, ['rev-parse', 'HEAD']);
  await writeFile(path.join(f.a, 'docs/frozen.md'), invalidDoc);
  await validateCommit(f.a, base, valid, f.client.ctx.home);
  await git(f.a, ['add', '.']); await git(f.a, ['commit', '-m', 'invalid candidate']);
  const invalid = await value(f.a, ['rev-parse', 'HEAD']);
  await writeFile(path.join(f.a, 'docs/frozen.md'), validDoc);
  await assert.rejects(validateCommit(f.a, base, invalid, f.client.ctx.home), /requirement.*progress/);
});

test('a server failure after successful preflight retains the draft and rejection reason', async t => {
  const f = await fixture(t, .15), url = await validator(t, f);
  await writeFile(path.join(f.a, 'docs/valid.md'), validDoc);
  const hook = path.join(f.a, '.git/hooks/pre-push');
  await writeFile(hook, `#!/bin/sh\nwhile read local_ref local_sha remote_ref remote_sha; do\n  if [ "$remote_ref" = "refs/heads/main" ]; then git --git-dir='${f.bare}' config infohub.validateUrl '${url}-unavailable'; fi\ndone\n`); await chmod(hook, 0o755);
  const before = await value(f.bare, ['rev-parse', 'main']);
  await f.client.tick(); await sleep(200); await f.client.tick();
  assert.equal(f.client.state.pending.validation, undefined);
  assert.match(f.client.state.pending.push, /校验/);
  assert.equal(await value(f.bare, ['rev-parse', 'main']), before);
  assert.notEqual(await value(f.a, ['rev-parse', 'HEAD']), before);
  assert.equal(await value(f.bare, ['show', `${f.client.state.draft.ref}:docs/valid.md`]), validDoc.trim());
  await f.client.tick(); assert.match(f.client.state.pending.push, /校验/);
  evidence('post-preflight-server-rejection-preserved', { ref: f.client.state.draft.ref, pending: f.client.state.pending });
});

test('a real push race preserves both histories and the draft; no automatic merge is performed', async t => {
  const f = await fixture(t, .15);
  await writeFile(path.join(f.b, 'two.txt'), 'racing remote\n'); await git(f.b, ['add', '.']); await git(f.b, ['commit', '-m', 'racing peer']);
  const peerHead = await value(f.b, ['rev-parse', 'HEAD']);
  const hook = path.join(f.a, '.git/hooks/pre-push');
  await writeFile(hook, `#!/bin/sh\nwhile read local_ref local_sha remote_ref remote_sha; do\n  if [ "$remote_ref" = "refs/heads/main" ]; then git -C '${f.b}' push origin main; fi\ndone\n`); await chmod(hook, 0o755);
  await writeFile(path.join(f.a, 'one.txt'), 'idle local\n');
  await f.client.tick(); await sleep(200); await f.client.tick();
  const localHead = await value(f.a, ['rev-parse', 'HEAD']);
  assert.equal(await value(f.bare, ['rev-parse', 'main']), peerHead);
  assert.notEqual(localHead, peerHead); assert.ok(f.client.state.pending.push);
  assert.equal(await value(f.a, ['status', '--porcelain']), '');
  await f.client.tick();
  assert.equal((await git(f.a, ['merge-tree', '--write-tree', localHead, peerHead], { allowFailure: true })).code, 0); await sleep(200); await f.client.tick();
  assert.equal(await value(f.a, ['rev-parse', 'HEAD']), localHead);
  assert.match(f.client.state.pending.push, /需 Agent 合并/);
  assert.equal(await value(f.bare, ['show', `${f.client.state.draft.ref}:one.txt`]), 'idle local');
  await git(f.a, ['fsck', '--no-dangling']);
  evidence('push-race-no-unapproved-merge', { localHead, remoteHead: peerHead, mergeTreeClean: true, pending: f.client.state.pending });
});

test('two uncommitted drafts warn both clients about overlap and distinguish conflicts from clean text merges', async t => {
  const f = await fixture(t), other = await Client.open(f.b, { draftSeconds: .01 });
  await writeFile(path.join(f.a, 'one.txt'), 'draft A\n'); await writeFile(path.join(f.b, 'one.txt'), 'draft B\n');
  await f.client.tick(); await other.tick();
  let report = await scanDrafts(f.bare, f.server);
  for (const d of report.drafts) { assert.equal(d.conflicts.length, 0); assert.deepEqual(d.overlaps[0].paths, ['one.txt']); assert.deepEqual(d.overlaps[0].conflicts, ['one.txt']); assert.equal(d.overlaps[0].mergeable, false); }
  await f.client.tick(); await other.tick();
  for (const root of [f.a, f.b]) {
    const lines = await concerns(root); assert.ok(lines.some(s => s.includes('共同改动路径 one.txt') && s.includes('Git 冲突')));
    const output = await run(process.execPath, [path.join(repoRoot, 'cli/infohub.mjs'), '--root', root, 'brief', 'project-1']);
    assert.match(output.stdout, /共同改动路径 one.txt/);
    const state = await status(root); assert.equal(state.server.drafts.length, 2);
  }
  evidence('draft-to-draft-conflict-both-visible', { drafts: report.drafts });
  await git(f.b, ['add', 'one.txt']); await git(f.b, ['commit', '-m', 'Agent commit still unpublished']);
  await other.tick(); report = await scanDrafts(f.bare, f.server);
  assert.ok(report.drafts.every(d => d.overlaps[0].paths.includes('one.txt')));
  // Same file, distant lines: warn about collaboration overlap without claiming a Git conflict.
  await writeFile(path.join(f.a, 'one.txt'), 'base\n'); await writeFile(path.join(f.b, 'one.txt'), 'base\n');
  await writeFile(path.join(f.a, 'shared.txt'), 'A\n2\n3\n4\n5\n6\n7\n8\n9\n10\n');
  await writeFile(path.join(f.b, 'shared.txt'), '1\n2\n3\n4\n5\n6\n7\n8\n9\nB\n');
  await f.client.tick(); await other.tick(); report = await scanDrafts(f.bare, f.server);
  for (const d of report.drafts) { assert.deepEqual(d.overlaps[0].paths, ['shared.txt']); assert.deepEqual(d.overlaps[0].conflicts, []); assert.equal(d.overlaps[0].mergeable, true); }
  evidence('draft-overlap-without-text-conflict', { drafts: report.drafts });
  // Move B's change to a different file: the warning must disappear for both.
  await writeFile(path.join(f.b, 'shared.txt'), '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n');
  await writeFile(path.join(f.b, 'two.txt'), 'independent B\n'); await other.tick(); report = await scanDrafts(f.bare, f.server);
  assert.ok(report.drafts.every(d => d.overlaps.length === 0));
});

test('Agent commit, rejected push, pull merge and later edits retire the owning clone draft even when main now conflicts with it', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.a, 'shared.txt'), 'local draft\n2\n3\n4\n5\n6\n7\n8\n9\n10\n');
  await peer(f, 'shared.txt', '1\n2\n3\n4\n5\n6\n7\n8\n9\nremote edit\n');
  await f.client.tick(); const draft = { ...f.client.state.draft };
  let report = await scanDrafts(f.bare, f.server);
  assert.deepEqual(report.drafts[0].conflicts, []);
  assert.match(f.client.state.pending.pull, /脏文件/);
  await git(f.a, ['add', '.']); await git(f.a, ['commit', '-m', 'Agent finishes draft']);
  assert.notEqual((await git(f.a, ['push', 'origin', 'main'], { allowFailure: true })).code, 0);
  await git(f.a, ['pull', '--no-rebase', '--no-edit']);
  await writeFile(path.join(f.a, 'shared.txt'), 'final after merge\n2\n3\n4\n5\n6\n7\n8\n9\nremote edit\n');
  await git(f.a, ['add', '.']); await git(f.a, ['commit', '-m', 'Agent updates merged content']); await git(f.a, ['push', 'origin', 'main']);
  const head = await value(f.a, ['rev-parse', 'HEAD']), index = sha256(await readFile(path.join(f.a, '.git/index')));
  report = await scanDrafts(f.bare, f.server);
  assert.deepEqual(report.drafts[0].conflicts, ['shared.txt']);
  evidence('superseded-draft-conflict-before-cleanup', { draft, main: head, serverDraft: report.drafts[0] });
  // Restart proves the deletion lease comes from the persisted successful upload.
  const restarted = await Client.open(f.a); await restarted.tick();
  assert.equal(await value(f.bare, ['for-each-ref', '--format=%(objectname)', draft.ref]), '');
  assert.equal(restarted.state.cleanedDraft.commit, draft.commit);
  assert.equal(restarted.state.draft, undefined);
  assert.equal(await value(f.a, ['rev-parse', 'HEAD']), head);
  assert.equal(sha256(await readFile(path.join(f.a, '.git/index'))), index);
  assert.equal(await value(f.a, ['status', '--porcelain']), '');
  report = await scanDrafts(f.bare, f.server); await restarted.tick();
  assert.equal(report.drafts.length, 0); assert.deepEqual((await status(f.a)).pending, {});
  const brief = await run(process.execPath, [path.join(repoRoot, 'cli/infohub.mjs'), '--root', f.a, 'brief', 'project-1']);
  assert.match(brief.stdout.split('需关注:')[1], /InfoHub Workbench/);
  assert.doesNotMatch(brief.stdout.split('需关注:')[1], /草稿/);
  evidence('superseded-draft-cleaned-by-owning-clone', { head, indexSha256: index, cleanedDraft: restarted.state.cleanedDraft, briefAttention: brief.stdout.split('需关注:')[1].trim() });
});

test('draft deletion uses the uploaded SHA lease and cannot delete an upload arriving during the push', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.a, 'one.txt'), 'old draft\n'); await f.client.tick(); const draft = { ...f.client.state.draft };
  await git(f.a, ['add', '.']); await git(f.a, ['commit', '-m', 'publish old draft']); await git(f.a, ['push', 'origin', 'main']);
  const head = await value(f.a, ['rev-parse', 'HEAD']);
  await git(f.b, ['pull', '--ff-only']);
  await writeFile(path.join(f.b, 'two.txt'), 'newer unpublished content\n');
  const other = await Client.open(f.b); await other.tick(); const newer = other.state.draft.commit;
  // The newer object is already on the server under the other fixture clone's ref.
  // Swap the tested ref after push advertisement, before the delete reaches receive-pack.
  const hook = path.join(f.a, '.git/hooks/pre-push');
  await writeFile(hook, `#!/bin/sh\nwhile read local_ref local_sha remote_ref remote_sha; do\n  if [ "$remote_ref" = "${draft.ref}" ]; then git --git-dir='${f.bare}' update-ref '${draft.ref}' '${newer}' '${draft.commit}'; fi\ndone\n`); await chmod(hook, 0o755);
  await f.client.tick();
  assert.equal(await value(f.bare, ['rev-parse', draft.ref]), newer);
  assert.ok(f.client.state.pending.cleanup);
  assert.equal(f.client.state.draft.commit, draft.commit);
  assert.equal(await value(f.a, ['rev-parse', 'HEAD']), head);
  await f.client.tick();
  assert.match(f.client.state.pending.cleanup, /远端草稿已更新/);
  assert.equal(await value(f.bare, ['rev-parse', draft.ref]), newer);
  assert.equal(await value(f.bare, ['show', `${draft.ref}:two.txt`]), 'newer unpublished content');
  evidence('cleanup-lease-preserves-newer-upload', { expected: draft.commit, actual: newer, pending: f.client.state.pending });
});

test('a dirty or unpublished clone retains its draft; an already deleted remote draft is acknowledged without a spurious error', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.a, 'one.txt'), 'pending work\n'); await f.client.tick(); const draft = { ...f.client.state.draft };
  await f.client.tick(); assert.equal(await value(f.bare, ['rev-parse', draft.ref]), draft.commit);
  await git(f.a, ['add', '.']); await git(f.a, ['commit', '-m', 'not published yet']);
  await f.client.tick(); assert.ok(await value(f.bare, ['rev-parse', draft.ref])); assert.equal(f.client.state.cleanedDraft, undefined);
  await git(f.a, ['push', 'origin', 'main']);
  await git(f.a, ['fetch', '--no-write-fetch-head', 'origin', '+refs/heads/*:refs/infohub/remote/*']);
  await git(f.a, ['remote', 'set-url', 'origin', path.join(f.home, 'offline.git')]);
  await f.client.tick();
  assert.ok(f.client.state.pending.fetch); assert.ok(f.client.state.draft);
  assert.ok(await value(f.bare, ['rev-parse', draft.ref]));
  await git(f.a, ['remote', 'set-url', 'origin', f.bare]);
  await scanDrafts(f.bare, f.server);
  assert.equal(await value(f.bare, ['for-each-ref', '--format=%(objectname)', draft.ref]), '');
  await until(async () => { await f.client.tick(); return f.client.state.draft === undefined; }, 'cleanup resumes after fetch backoff'); assert.equal(f.client.state.pending.cleanup, undefined);
  assert.equal(f.client.state.cleanedDraft.reason, '远端引用已不存在');
});

test('server still cleans a draft commit that main actually contains, even after a later content replacement', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.a, 'one.txt'), 'draft content\n'); await f.client.tick(); const draft = { ...f.client.state.draft };
  // Publish the actual draft commit from an independent clone, then supersede its content.
  await git(f.b, ['fetch', 'origin', `${draft.ref}:refs/remotes/origin/test-draft`]);
  await git(f.b, ['merge', '--ff-only', 'refs/remotes/origin/test-draft']);
  await peer(f, 'one.txt', 'later replacement\n');
  const report = await scanDrafts(f.bare, f.server);
  assert.equal(report.drafts.length, 0);
  assert.equal((await git(f.bare, ['rev-parse', '--verify', draft.ref], { allowFailure: true })).code, 128);
  // The originating clone still has local dirt; server used provable commit ancestry,
  // not a guess that old matching content somewhere in history is disposable.
  assert.equal(await readFile(path.join(f.a, 'one.txt'), 'utf8'), 'draft content\n');
  evidence('server-ancestry-cleans-superseded-content', { draft: draft.commit, main: report.main, remaining: report.drafts });
});

test('clean published copies clear stale push errors with or without a rejected commit', async t => {
  const f = await fixture(t);
  for (const rejectedHead of [undefined, '0'.repeat(40)]) {
    Object.assign(f.client.state, { pushError: 'obsolete rejection', rejectedHead });
    await f.client.tick();
    assert.equal(f.client.state.pushError, undefined);
    assert.equal(f.client.state.rejectedHead, undefined);
    assert.equal(f.client.state.pending.push, undefined);
  }
});

test('preflight model-only change validates untouched documents', async t => {
  const f = await fixture(t);
  const base = await value(f.a, ['rev-parse', 'HEAD']);
  const modelFile = path.join(f.a, 'ontology/ontology.json');
  const model = JSON.parse(await readFile(modelFile, 'utf8'));
  model.objectTypes.project.properties.owner = { type: 'text', required: true };
  await writeFile(modelFile, JSON.stringify(model));
  await git(f.a, ['add', '.']); await git(f.a, ['commit', '-m', 'require owner']);
  const candidate = await value(f.a, ['rev-parse', 'HEAD']);
  await assert.rejects(validateCommit(f.a, base, candidate, f.home), /docs\/project.md.*owner/);
});

test('moving a copy remembers the old task, copying it does not claim the original task', async t => {
  const { cp, rename } = await import('node:fs/promises');
  const { identity } = await import('./client.mjs');
  const f = await fixture(t);
  const original = await identity(await context(f.a));
  const copied = path.join(f.home, 'copy');
  await cp(f.a, copied, { recursive: true });
  const copiedId = await identity(await context(copied));
  assert.notEqual(copiedId.id, original.id);
  assert.deepEqual(copiedId.previousIds, []);
  const moved = path.join(f.home, 'moved');
  await rename(f.a, moved);
  const movedId = await identity(await context(moved));
  assert.ok(movedId.previousIds.includes(original.id));
});


test('network failures back off, persist across restart, coalesce concurrent ticks and recover', async t => {
  const f = await fixture(t);
  // Use the real default interval: a 200ms retry may elapse during Windows Git/process IO.
  f.client.settings.fetchSeconds = 5;
  await git(f.a, ['remote', 'set-url', 'origin', path.join(f.home, 'offline.git')]);
  await f.client.tick();
  const first = (await status(f.a)).backoff.fetch;
  assert.equal(first.failures, 1);
  await Promise.all(Array.from({length: 8}, () => f.client.tick()));
  assert.equal((await status(f.a)).backoff.fetch.failures, 1);
  f.client.state.backoff.fetch.retryAt = new Date(0).toISOString();
  await f.client.tick();
  const second = (await status(f.a)).backoff.fetch;
  assert.equal(second.failures, 2);
  assert.ok(Date.parse(second.retryAt) - Date.now() > 250);
  const restarted = await Client.open(f.a, f.client.settings);
  await git(f.a, ['remote', 'set-url', 'origin', f.bare]);
  const previousFetch = restarted.state.lastFetch;
  await restarted.tick();
  assert.equal(restarted.state.lastFetch, previousFetch);
  restarted.state.backoff.fetch.retryAt = new Date(0).toISOString();
  await restarted.tick();
  assert.equal(restarted.state.backoff.fetch, undefined);
  assert.ok(restarted.state.lastFetch > previousFetch);
  await git(f.a, ['remote', 'set-url', 'origin', path.join(f.home, 'offline.git')]);
  restarted.state.backoff.fetch = { failures: 30, retryAt: new Date(0).toISOString() };
  await restarted.tick();
  const delay = Date.parse(restarted.state.backoff.fetch.retryAt) - Date.now();
  assert.ok(delay > 299000 && delay <= 300000);
});
