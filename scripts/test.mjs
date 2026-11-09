import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const files = [];
for (const dir of ['core', 'cli', 'server', 'hooks', 'scripts', 'sync']) {
  for (const file of await readdir(path.join(root, dir), { recursive: true })) {
    if (/\.test\.(mjs|js)$/.test(file)) files.push(path.join(dir, file));
  }
}
// Windows cannot obtain another Git process's cwd; its conservative detector
// pauses for any Git process. Keep independent fixtures from blocking each other.
const home = await mkdtemp(path.join(tmpdir(), 'infohub-test-home-'));
try {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { await rm(home, { recursive: true, force: true }); }
