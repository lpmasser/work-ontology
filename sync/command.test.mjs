import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { status } from './command.mjs';

test('status uses only files, distinguishes absent configuration from errors, and exposes a versioned projection', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'infohub-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, '.git/infohub-sync');
  await mkdir(home, { recursive: true });
  // No Git repository or executable is needed to read an absent configuration.
  const first = await status(root);
  assert.equal(first.installed, false);
  assert.deepEqual(first.pending, {});
  assert.equal(first.version, 1);
  await writeFile(path.join(home, 'config.json'), '{');
  const invalid = await status(root);
  assert.equal(invalid.installed, null);
  assert.ok(invalid.pending.status);
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ fetchSeconds: 5, draftSeconds: 180, idleSeconds: 1800, remote: 'obsolete' }));
  await writeFile(path.join(home, 'state.json'), JSON.stringify({ pushError: 'private', rejectedHead: 'private', pending: {}, server: { checkedAt: 'now', main: 'sha', drafts: [], cleaned: ['private'] } }));
  const projected = await status(root);
  assert.equal(projected.installed, true);
  assert.ok(!('pushError' in projected));
  assert.ok(!('rejectedHead' in projected));
  assert.ok(!('remote' in projected.settings));
  assert.ok(!('cleaned' in projected.server));
  await writeFile(path.join(home, 'state.json'), JSON.stringify({ pending: 'invalid' }));
  assert.ok((await status(root)).pending.status);
  await writeFile(path.join(home, 'config.json'), 'null');
  const nullConfig = await status(root);
  assert.equal(nullConfig.installed, null);
  assert.ok(nullConfig.pending.status);
  await writeFile(path.join(home, 'config.json'), '{}');
  await writeFile(path.join(home, 'state.json'), '{');
  assert.ok((await status(root)).pending.status);
  assert.ok((await status(path.join(root, 'missing'))).pending.status);
});

test('stopped guidance is produced by status manager metadata', async t => {
  const { concerns } = await import('./command.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'infohub-manager-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, '.git/infohub-sync');
  await mkdir(home, { recursive: true });
  assert.equal((await status(root)).manager, 'workbench');
  assert.ok((await concerns(root)).some(s => s.includes('请启动 InfoHub Workbench')));
  await writeFile(path.join(home, 'state.json'), JSON.stringify({ manager: 'docker', pending: {} }));
  assert.equal((await status(root)).manager, 'docker');
  assert.ok((await concerns(root)).some(s => s.includes('请检查 infohub-sync 容器')));
});
