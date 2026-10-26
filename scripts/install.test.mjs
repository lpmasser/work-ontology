import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderResident } from './install.mjs';
import { commandLocation } from './install-command.mjs';
import { npm } from './npm.mjs';

const ENTRY = `---
title: "InfoHub使用入口"
---

# InfoHub使用入口

说明。

## 常驻指令

### InfoHub

\`{{INFOHUB_ROOT}}\` 是上下文层。

### Agent 协作

- 规则。

## 维护与接入

不应出现在输出里。
`;

test('renderResident 只取常驻指令一节，替换路径并把三级标题提成一级', () => {
  const out = renderResident(ENTRY, '/data/InfoHub');
  assert.match(out, /^<!-- 由 work-ontology/);
  assert.match(out, /\n# InfoHub\n/);
  assert.match(out, /\n# Agent 协作\n/);
  assert.match(out, /`\/data\/InfoHub` 是上下文层/);
  assert.doesNotMatch(out, /维护与接入|不应出现|\{\{INFOHUB_ROOT\}\}/);
});

test('renderResident 缺少常驻指令一节时报错', () => {
  assert.throws(() => renderResident('# 空\n', '/x'), /常驻指令/);
});

test('安装全局命令并只给已安装的 harness 写常驻指令', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'infohub-home-'));
  const root = await mkdtemp(path.join(tmpdir(), 'infohub-root-'));
  t.after(() => Promise.all([home, root].map(p => rm(p, { recursive: true, force: true }))));
  await mkdir(path.join(root, 'AI开发工程化'), { recursive: true });
  await writeFile(path.join(root, 'AI开发工程化', 'InfoHub使用入口.md'), ENTRY);
  const netcatty = path.join(root, 'skills/netcatty-ssh');
  await mkdir(netcatty, { recursive: true });
  await writeFile(path.join(netcatty, 'SKILL.md'), '# Netcatty fixture\n');
  await writeFile(path.join(netcatty, 'package.json'), '{"name":"skill-fixture","version":"1.0.0","private":true}');
  await writeFile(path.join(netcatty, 'package-lock.json'), '{"name":"skill-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"skill-fixture","version":"1.0.0"}}}');
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await mkdir(path.join(home, '.gemini'), { recursive: true });
  const appData = path.join(home, 'AppData/Roaming');
  const oldPrefix = path.join(home, 'node-v1');
  const nextNodeBin = path.join(home, 'node-v2/bin');
  await mkdir(nextNodeBin, { recursive: true });
  const nextNode = path.join(nextNodeBin, process.platform === 'win32' ? 'node.exe' : 'node');
  if (process.platform === 'win32') await copyFile(process.execPath, nextNode);
  else await symlink(process.execPath, nextNode);
  const shims = path.join(home, 'shims');
  await symlink(path.dirname(process.execPath), shims, process.platform === 'win32' ? 'junction' : 'dir');
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appData, PATH: [shims, process.env.PATH].join(path.delimiter), npm_config_prefix: oldPrefix, NPM_CONFIG_PREFIX: oldPrefix };
  const repo = path.resolve(import.meta.dirname, '..');
  npm(['link', '--no-audit', '--no-fund'], { cwd: repo, env, stdio: 'pipe' });
  const script = new URL('./install.mjs', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const { installCli } = await import(${JSON.stringify(script)}); await installCli(process.argv[1]);`, root], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['.codex/AGENTS.md', '.gemini/GEMINI.md']) {
    assert.match(await readFile(path.join(home, f), 'utf8'), new RegExp('`' + root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '` 是上下文层'));
  }
  for (const f of ['.config/opencode/AGENTS.md', '.dsh/AGENTS.md', '.pi/agent/AGENTS.md', '.zcode/AGENTS.md']) {
    assert.equal(existsSync(path.join(home, f)), false, f);
  }
  assert.match(r.stdout, /未安装，跳过常驻指令/);
  assert.match(r.stdout, /netcatty-ssh.*凭据尚未配置/);
  for (const dir of ['.codex/skills', '.gemini/config/skills']) {
    assert.equal(await realpath(path.join(home, dir, 'netcatty-ssh')), await realpath(netcatty));
    assert.equal(await realpath(path.join(home, dir, 'infohub')), await realpath(path.join(repo, 'skill')));
  }
  assert.equal(existsSync(path.join(home, '.claude')), false, 'do not create an absent harness');
  const config = JSON.parse(await readFile(path.join(home, '.config/infohub/config.json'), 'utf8'));
  assert.equal(Object.hasOwn(config.runtime, 'path'), false);
  assert.equal(config.runtime.node, path.join(shims, process.platform === 'win32' ? 'node.exe' : 'node'));
  const { bin } = commandLocation(home, process.platform, appData);
  assert.equal(existsSync(path.join(oldPrefix, process.platform === 'win32' ? 'infohub.cmd' : 'bin/infohub')), false);
  await rm(oldPrefix, { recursive: true, force: true });
  // Simulate a version-manager upgrade removing the previous Node directory.
  // The caller now supplies a different Node bin; no package reinstallation.
  const cleanEnv = process.platform === 'win32'
    ? { USERPROFILE: home, APPDATA: appData, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT, PATH: [bin, nextNodeBin, path.join(process.env.SystemRoot, 'System32'), path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter) }
    : { HOME: home, PATH: [bin, nextNodeBin, '/usr/bin', '/bin'].join(path.delimiter) };
  const command = process.platform === 'win32' ? 'powershell.exe' : 'infohub';
  const args = process.platform === 'win32' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'infohub help'] : ['help'];
  const help = spawnSync(command, args, { env: cleanEnv, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /brief/, `global command produced no help: ${help.stderr}`);
  assert.equal(existsSync(path.join(home, '.codex/skills/infohub/infohub')), false);
});
