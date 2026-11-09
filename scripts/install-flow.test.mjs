import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = (args, cwd, env = process.env) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();

test('Linux installer safely retires desktop and reuses one sync service on repeated install', { skip: process.platform !== 'linux' ? 'Linux user-service boundary; other platforms use native tests' : false }, async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'InfoHub 接入-'));
  t.after(async () => {
    try { process.kill(Number(await readFile(path.join(base, 'home/fixture-service.pid'), 'utf8')), 'SIGTERM'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
    await rm(base, { recursive: true, force: true });
  });
  const home = path.join(base, 'home');
  const bin = path.join(home, 'shims');
  const remotes = path.join(base, 'remotes');
  await mkdir(bin, { recursive: true });
  await mkdir(remotes);
  await mkdir(path.join(home, '.codex'));
  // Git URL rewriting keeps real clone/branch/hash behavior without credentials.
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: [bin, process.env.PATH].join(path.delimiter),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    npm_config_prefix: path.join(home, '.local'), NPM_CONFIG_PREFIX: path.join(home, '.local') };
  run(['config', '--global', 'user.name', 'Install test'], base, env);
  run(['config', '--global', 'user.email', 'install-test@infohub.local'], base, env);
  run(['config', '--global', `url.file://${remotes}/.insteadOf`, 'ssh://git@fixture/'], base, env);
  await symlink(process.execPath, path.join(bin, 'node'));
  await symlink(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'));
  const boundary = path.join(bin, 'boundary');
  await writeFile(boundary, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(process.env.HOME+'/calls.jsonl',JSON.stringify(process.argv)+'\\n');\n`, { mode: 0o755 });
  for (const cmd of ['open', 'xdg-open']) await symlink(boundary, path.join(bin, cmd));
  const serviceShim = path.join(bin, 'systemctl');
  await writeFile(serviceShim, `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const file = path.join(process.env.HOME, 'fixture-service.pid'), args = process.argv.slice(2);
let pid; try { pid=Number(fs.readFileSync(file,'utf8')); } catch {}
if(args.includes('is-active')) { try { process.kill(pid,0); process.exit(0); } catch { process.exit(3); } }
if(args.includes('disable')) { if(pid) { try { process.kill(pid,'SIGTERM'); } catch {} } process.exit(0); }
if(args.includes('enable')) {
 const c=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.config/infohub/config.json'),'utf8'));
 const child=cp.spawn(c.runtime.node,[c.runtime.cli,'--root',c.root,'sync','run'],{detached:true,stdio:'ignore',env:{...process.env,INFOHUB_SYNC_MANAGER:'systemd'}});
 fs.writeFileSync(file,String(child.pid)); child.unref();
}
`, { mode: 0o755 });
  const rootSource = path.join(remotes, 'InfoHub.git');
  await mkdir(rootSource); run(['init', '--initial-branch=main'], rootSource, env);
  await mkdir(path.join(rootSource, 'ontology')); await writeFile(path.join(rootSource, 'ontology/ontology.json'), '{}');
  await mkdir(path.join(rootSource, 'AI开发工程化'));
  await writeFile(path.join(rootSource, 'AI开发工程化/InfoHub使用入口.md'), '\n## 常驻指令\n\n### 测试\n\n{{INFOHUB_ROOT}}\n\n## 维护与接入\n');
  const skill = path.join(rootSource, 'skills/netcatty-ssh');
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '# Netcatty fixture\n');
  await writeFile(path.join(skill, 'package.json'), '{"name":"skill-fixture","version":"1.0.0","private":true}');
  await writeFile(path.join(skill, 'package-lock.json'), '{"name":"skill-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"skill-fixture","version":"1.0.0"}}}');
  run(['add', '.'], rootSource, env); run(['commit', '-m', 'fixture'], rootSource, env);
  const app = path.join(home, '.local/share/infohub/workbench/InfoHubWorkbench.AppImage');
  await mkdir(path.dirname(app), { recursive: true }); await writeFile(app, 'already installed');
  const root = path.join(home, 'InfoHub');
  const entry = path.join(base, 'install.mjs');
  await symlink(path.join(import.meta.dirname, 'install.mjs'), entry);
  const invoke = (withUrl = true) => spawnSync(process.execPath, [entry, '--root', root,
    ...(withUrl ? ['--infohub-url', 'ssh://git@fixture/InfoHub.git'] : [])], { env, encoding: 'utf8' });
  const missing = invoke(false); assert.equal(missing.status, 1); assert.match(missing.stderr, /--infohub-url/);
  const first = invoke(); assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(await realpath(path.join(home, '.codex/skills/netcatty-ssh')), await realpath(path.join(root, 'skills/netcatty-ssh')));
  assert.match(first.stdout, /netcatty-ssh.*凭据尚未配置/);
  const config = await readFile(path.join(home, '.config/infohub/config.json'), 'utf8');
  const resident = await readFile(path.join(home, '.codex/AGENTS.md'), 'utf8');
  assert.equal(JSON.parse(config).repository, 'ssh://git@fixture/InfoHub.git');
  const second = invoke(false); assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(await readFile(path.join(home, '.config/infohub/config.json'), 'utf8'), config);
  assert.equal(await readFile(path.join(home, '.codex/AGENTS.md'), 'utf8'), resident);
  assert.equal(run(['status', '--porcelain'], root, env), '');
  await assert.rejects(readFile(app), { code: 'ENOENT' });
  const daemonBefore = await readFile(path.join(root, '.git/infohub-sync/daemon.pid'), 'utf8');
  const third = invoke(false); assert.equal(third.status, 0, third.stdout + third.stderr);
  assert.equal(await readFile(path.join(root, '.git/infohub-sync/daemon.pid'), 'utf8'), daemonBefore);
  assert.equal(JSON.parse(await readFile(path.join(root, '.git/infohub-sync/service.json'), 'utf8')).manager, 'systemd');
  await assert.rejects(readFile(path.join(home, 'calls.jsonl')), { code: 'ENOENT' });
});
