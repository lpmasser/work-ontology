import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { run } from './process.mjs';

test('process boundary hides Windows consoles without changing streams, arguments or exit status', async t => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    assert.equal(command, 'git');
    assert.deepEqual(args, ['-C', '中文 & space', 'status']);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    process.nextTick(() => { child.stdout.end('output'); child.stderr.end('diagnostic'); child.emit('close', 37); });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await run('git', ['-C', '中文 & space', 'status'], { input: 'input', allowFailure: true });
  assert.equal(child.stdin.read().toString(), 'input');
  assert.deepEqual(result, { code: 37, stdout: 'output', stderr: 'diagnostic' });
});


test('cancellation waits for the entire owned process tree to exit', async t => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'infohub-cancel-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const pidFile = path.join(home, 'child.pid');
  const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);fs.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000);`;
  const abort = new AbortController();
  const result = run(process.execPath, ['-e', code, pidFile], { signal: abort.signal, processGroup: true });
  const rejected = assert.rejects(result, { code: 'ABORT_ERR' });
  let pid;
  for (let i=0; i<100; i++) {
    try { pid=Number(await fs.readFile(pidFile,'utf8')); break; } catch { await new Promise(r=>setTimeout(r,25)); }
  }
  assert.ok(pid);
  abort.abort();
  await rejected;
  for (let i=0;i<100;i++) {
    try { process.kill(pid,0); } catch { return; }
    await new Promise(r=>setTimeout(r,25));
  }
  assert.fail('descendant still alive after cancellation');
});
