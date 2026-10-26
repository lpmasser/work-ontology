import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stableTool, minimalPath } from './runtime.mjs';

test('configured tools run with only their own and OS directories, not the caller PATH', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'infohub-runtime-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, '.config/infohub'), { recursive: true });
  const runtime = { node: process.execPath, git: stableTool('git') };
  await writeFile(path.join(home, '.config/infohub/config.json'), JSON.stringify({ root: home, runtime }));
  const script = `import {configureRuntime} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'runtime.mjs')).href)};
import {run} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'process.mjs')).href)};
await configureRuntime(); const git = await run('git',['--version']); console.log(JSON.stringify({path:process.env.PATH,git:git.stdout}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: path.join(home, '.codex/tmp/node_modules/.bin') }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.path, minimalPath(runtime));
  assert.match(actual.git, /^git version /);
  assert.ok(!actual.path.includes('.codex/tmp'));
});
