import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanupLegacySync } from './cleanup-legacy-sync.mjs';

test('legacy cleanup only removes the owning clone tasks and never installs a supervisor', async t => {
  // This test exercises the Darwin adapter on every OS; Windows has no getuid.
  const uidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 1000 });
  t.after(() => {
    if (uidDescriptor) Object.defineProperty(process, 'getuid', uidDescriptor);
    else delete process.getuid;
  });
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'infohub-legacy-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'InfoHub'), id = '11111111-1111-4111-8111-111111111111';
  await mkdir(path.join(root, '.git/infohub-sync'), { recursive: true });
  await writeFile(path.join(root, '.git/infohub-sync/identity.json'), JSON.stringify({ id, root }));
  const calls = [];
  t.mock.method(childProcess, 'spawn', (program, args) => {
    calls.push([program, ...args]);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    process.nextTick(() => child.emit('close', 0));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await cleanupLegacySync(root, home, 'darwin');
  await cleanupLegacySync(root, home, 'win32');
  const unit = path.join(home, '.config/systemd/user', `de.eloyzh.infohub-sync.${id}.service`);
  await mkdir(path.dirname(unit), { recursive: true }); await writeFile(unit, 'old unit');
  await cleanupLegacySync(root, home, 'linux');
  assert.ok(calls.some(call => call.includes('bootout')));
  assert.ok(calls.some(call => call.includes('/Delete')));
  assert.ok(calls.some(call => call.includes('disable') && call.includes('--now')));
  assert.ok(!calls.some(call => call.some(arg => ['bootstrap', '/Create', 'enable', '/Run'].includes(arg))));
  const other = path.join(home, 'original'); await mkdir(path.join(other, '.git'), { recursive: true });
  await writeFile(path.join(root, '.git/infohub-sync/identity.json'), JSON.stringify({ id, root: other }));
  const before = calls.length; await cleanupLegacySync(root, home, 'win32');
  assert.equal(calls.length, before, 'copied metadata cannot stop the original clone');
});
