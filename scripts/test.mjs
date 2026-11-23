import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const files = [];
for (const dir of ['core', 'cli', 'server', 'hooks', 'scripts', 'sync', 'summary']) {
  for (const file of await readdir(path.join(root, dir), { recursive: true })) {
    if (/\.test\.(mjs|js)$/.test(file)) files.push(path.join(dir, file));
  }
}
// Windows cannot obtain another Git process's cwd; its conservative detector
// pauses for any Git process. Keep independent fixtures from blocking each other.
const home = await mkdtemp(path.join(tmpdir(), 'infohub-test-home-'));
try {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=120000', ...files], {
    cwd: root, stdio: 'inherit',
    env: {
      ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      // 测试不接本机真实的 codexhost 会话身份，也不拉起真实的工作汇总：
      // CLI 入口显式置空，解析时连 PATH 都不再看。
      CODEXHOST_CLI_PATH: '', CODEXHOST_THREAD_ID: '', INFOHUB_SUMMARY_CLI: '',
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  // 用例失败也可能留下分离进程：凡是还挂在本次临时 HOME 下的都结束掉。
  const leftovers = await processesUnder(home);
  for (const pid of leftovers) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  if (leftovers.length) console.error(`已结束 ${leftovers.length} 个遗留的测试后台进程：${leftovers.join(', ')}`);
  await rm(home, { recursive: true, force: true });
}

// 只认命令行里带着本次临时目录、并且是我们自己的 CLI 的进程，别的进程一概不碰。
function processesUnder(dir) {
  if (process.platform === 'win32') return [];
  const listing = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout || '';
  const pids = [];
  for (const line of listing.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match || Number(match[1]) === process.pid) continue;
    if (!match[2].includes(dir) || !match[2].includes('cli/infohub.mjs')) continue;
    pids.push(Number(match[1]));
  }
  return pids;
}
