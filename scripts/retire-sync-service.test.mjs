import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { retireSyncService, serviceLocation } from './retire-sync-service.mjs';
import { git, save } from '../sync/git.mjs';

const uuid = 'e84975ad-137e-46ea-a9dc-18c776f36707';
async function fixture(t, platform) {
  const home = await mkdtemp(path.join(tmpdir(), 'infohub-retirement-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'clone'); await mkdir(root);
  await git(root, ['init', '--initial-branch=main']);
  const sync = path.join(root, '.git/infohub-sync');
  await save(path.join(sync, 'identity.json'), { id: uuid, root: await realpath(root) });
  const loc = serviceLocation(uuid, home, platform);
  await mkdir(path.dirname(loc.file), { recursive: true });
  await writeFile(loc.file, 'old registration');
  await writeFile(path.join(root, '.git/index.lock'), 'untouched Git lock');
  return { home, root, sync, loc };
}
for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform}: removes only this clone registration after safe stop, never registers a host`, async t => {
    const f = await fixture(t, platform), calls = [];
    const execute = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; };
    await retireSyncService(f.root, { home: f.home, platform, execute });
    await assert.rejects(readFile(f.loc.file), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(f.root, '.git/index.lock'), 'utf8'), 'untouched Git lock');
    assert.ok(calls.some(call => call.includes(platform === 'darwin' ? 'bootout' : platform === 'linux' ? 'disable' : '/DISABLE')));
    assert.ok(!calls.flat().some(arg => ['bootstrap', 'enable', '/Create', '/Run', '/End', 'taskkill.exe', 'SIGKILL'].includes(arg)));
    if (platform === 'win32') assert.ok(calls.findIndex(call => call.includes('/DISABLE')) < calls.findIndex(call => call.includes('/Delete')));
  });
}
test('Windows IPC failure retains registration and surfaces the error without force', async t => {
  const f = await fixture(t, 'win32'), calls = [];
  await writeFile(path.join(f.sync, 'runner.pid'), String(process.pid));
  const execute = async (cmd, args) => { calls.push(args); return { code: 0, stdout: '' }; };
  await assert.rejects(retireSyncService(f.root, { home: f.home, platform: 'win32', execute, requestStop: async () => { throw new Error('stop cancelled'); } }), /stop cancelled/);
  assert.equal(await readFile(f.loc.file, 'utf8'), 'old registration');
  assert.ok(!calls.flat().includes('/Delete'));
});
test('identity copied from another live clone cannot claim that clone registration', async t => {
  const f = await fixture(t, 'darwin'), other = path.join(f.home, 'other');
  await mkdir(path.join(other, '.git'), { recursive: true });
  await save(path.join(f.sync, 'identity.json'), { id: uuid, root: other });
  await retireSyncService(f.root, { home: f.home, platform: 'darwin', execute: async () => { throw new Error('must not invoke native manager'); } });
  assert.equal(await readFile(f.loc.file, 'utf8'), 'old registration');
});
