import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from './git.mjs';

test('concurrent requests for one clone wait for the prior Git child to exit', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'infohub-serial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '--initial-branch=main']);
  const script = path.join(root, 'work.cjs');
  await writeFile(script, `const fs=require('node:fs');fs.mkdirSync('active');setTimeout(()=>{fs.rmdirSync('active');console.log('done')},100);`);
  const quote = s => "'" + s.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
  const alias = '!' + quote(process.execPath) + ' ' + quote(script);
  const results = await Promise.all(Array.from({length: 5}, () => git(root, ['-c', 'alias.work='+alias, 'work'])));
  assert.deepEqual(results.map(result => result.stdout.trim()), ['done','done','done','done','done']);
});
