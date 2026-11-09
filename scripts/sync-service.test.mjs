import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { serviceLocation, serviceDefinition, ensureSyncService, stopService } from './sync-service.mjs';
import { retireWorkbench } from './retire-workbench.mjs';
import { requestServiceStop } from './service-control.mjs';
import { git, value, save, alive } from '../sync/git.mjs';
import { status } from '../sync/command.mjs';
import { findExecutable } from '../core/runtime.mjs';
import { run } from '../core/process.mjs';

const runtime = { node: process.execPath, git: findExecutable('git'), cli: path.resolve(import.meta.dirname, '../cli/infohub.mjs') };
async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'InfoHub 服务 中文-'));
  const cleanup = [];
  t.after(async () => { for (const action of cleanup) await action(); await rm(base, { recursive: true, force: true }); });
  const remote = path.join(base, 'remote.git'), root = path.join(base, 'root');
  await git(base, ['init', '--bare', '--initial-branch=main', remote]);
  await git(base, ['clone', remote, root]);
  await git(root, ['config', 'user.name', 'Test']); await git(root, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(path.join(root, 'test.txt'), 'no content changes\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'fixture']); await git(root, ['push', 'origin', 'main']);
  return { base, root, beforeCleanup: action => cleanup.unshift(action) };
}
async function until(fn, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('等待状态超时');
}

test('native definitions parse with platform tools, keep special paths and restart/login settings', async t => {
  const { base, root } = await fixture(t), id = '11111111-1111-4111-8111-111111111111';
  const loc = serviceLocation(id, base), log = path.join(root, '中文 log.log');
  const text = serviceDefinition(loc, root, runtime, log, homedir(), 'S-1-5-21-123');
  const file = path.join(base, loc.manager === 'launchd' ? 'job.plist' : loc.manager === 'systemd' ? 'job.service' : 'job.xml');
  await writeFile(file, loc.manager === 'task-scheduler' ? '\ufeff' + text : text, loc.manager === 'task-scheduler' ? 'utf16le' : 'utf8');
  if (process.platform === 'darwin') await run('plutil', ['-lint', file]);
  if (process.platform === 'linux') await run('systemd-analyze', ['verify', file]);
  if (process.platform === 'win32') await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[xml]$t=Get-Content -Raw -LiteralPath $env:INFOHUB_TEST_XML; if($t.Task.Settings.RestartOnFailure.Count -ne "999" -or $t.Task.Principals.Principal.LogonType -ne "S4U"){exit 1}',], { env: { INFOHUB_TEST_XML: file } });
});

test('desktop migration waits for safe exit and preserves user data; cancellation does not remove app', async t => {
  const { base, root } = await fixture(t), app = path.join(base, 'Old Workbench.app');
  await mkdir(app); await writeFile(path.join(app, 'infohub-workbench'), 'application');
  const data = path.join(base, 'preferences.json'); await writeFile(data, 'saved session');
  const calls = []; let running = true;
  const options = { home: base, platform: 'linux', locations: [{ app, binaries: [path.join(app, 'infohub-workbench')] }],
    processes: async () => running ? [{ pid: 1234, binary: path.join(app, 'infohub-workbench') }] : [],
    execute: async (cmd, args) => { calls.push([cmd, ...args]); if (args.includes('--quit')) running = false; return { code: 0, stdout: '' }; }, timeoutMs: 20 };
  await retireWorkbench(root, options);
  assert.ok(calls.some(call => call.includes('--quit')));
  await assert.rejects(access(app), { code: 'ENOENT' }); assert.equal(await readFile(data, 'utf8'), 'saved session');
  assert.equal(await value(root, ['status', '--porcelain']), '');
  await mkdir(app); running = true;
  options.execute = async () => ({ code: 0, stdout: '' });
  await assert.rejects(retireWorkbench(root, options), /安全退出/);
  await access(app); assert.equal(await value(root, ['status', '--porcelain']), '');
});

test('Windows task entry runs the shared foreground loop and drains it over IPC without leaving lease', async t => {
  const { root, beforeCleanup } = await fixture(t), id = '22222222-2222-4222-8222-222222222222';
  await save(path.join(root, '.git/infohub-sync/config.json'), { fetchSeconds: .2, idleSeconds: 3600 });
  const file = path.join(root, '.git/infohub-sync/service-runner.json');
  await save(file, { id, root, runtime, log: path.join(root, '.git/infohub-sync/service.log'), runnerLease: path.join(root, '.git/infohub-sync/runner.pid') });
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'service-runner.mjs'), file], { stdio: 'pipe', windowsHide: true });
  let output = ''; child.stderr.on('data', bytes => { output += bytes; });
  const done = new Promise(resolve => child.once('close', resolve));
  beforeCleanup(async () => { if (child.exitCode === null) { await requestServiceStop(id).catch(() => {}); await done; } });
  await until(async () => Boolean((await status(root)).lastFetch)).catch(e => { throw new Error(`${e.message}: ${output}`); });
  assert.equal((await status(root)).manager, 'task-scheduler');
  await requestServiceStop(id); assert.equal(await done, 0, output);
  assert.equal((await status(root)).running, false);
  await assert.rejects(access(path.join(root, '.git/infohub-sync/daemon.pid')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(root, '.git/infohub-sync/runner.pid')), { code: 'ENOENT' });
  assert.equal(await value(root, ['status', '--porcelain']), '');
});

test('real OS user service reuses PID on reinstall, restarts a failed loop, and stops gracefully', { skip: !process.env.INFOHUB_TEST_SERVICE ? 'run with INFOHUB_TEST_SERVICE=1 in native user session' : false, timeout: 210000 }, async t => {
  const { root, beforeCleanup } = await fixture(t);
  await save(path.join(root, '.git/infohub-sync/config.json'), { fetchSeconds: .2, idleSeconds: 3600 });
  beforeCleanup(async () => {
    let id;
    try { id = JSON.parse(await readFile(path.join(root, '.git/infohub-sync/identity.json'), 'utf8')).id; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (id) await stopService(serviceLocation(id), root);
  });
  const installed = await ensureSyncService(root, runtime);
  const before = await stat(installed.file), firstPid = installed.pid;
  const repeated = await ensureSyncService(root, runtime);
  assert.equal(repeated.pid, firstPid); assert.equal((await stat(installed.file)).mtimeMs, before.mtimeMs);
  // Only terminate our idle fixture daemon, never an active Git process.
  await until(async () => { const s = await status(root); return s.lastFetch && Date.now() - Date.parse(s.finishedAt) < 100; });
  if (process.platform === 'win32') await run('taskkill.exe', ['/PID', String(firstPid), '/F']);
  else process.kill(firstPid, 'SIGKILL');
  await until(async () => { const s = await status(root); return s.running && s.pid !== firstPid && Date.parse(s.lastFetch) >= Date.parse(s.startedAt); }, 100000);
  const restarted = await status(root); assert.ok(alive(restarted.pid));
  console.log(JSON.stringify({ scenario: 'native-user-service', manager: installed.manager, firstPid, repeatedPid: repeated.pid, restartedPid: restarted.pid, lastFetch: restarted.lastFetch }));
  assert.equal(await value(root, ['status', '--porcelain']), '');
});
