import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = [];
for (const dir of ['core', 'cli', 'server', 'hooks', 'scripts', 'sync']) {
  for (const file of await readdir(path.join(root, dir), { recursive: true })) {
    if (/\.test\.(mjs|js)$/.test(file)) files.push(path.join(dir, file));
  }
}
// Windows cannot obtain another Git process's cwd; its conservative detector
// pauses for any Git process. Keep independent fixtures from blocking each other.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
