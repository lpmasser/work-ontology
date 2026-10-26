#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { lstat, readlink, mkdir, symlink, writeFile, readFile, realpath } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { npm } from './npm.mjs';
import { installCommand } from './install-command.mjs';
import { cleanupLegacySync } from './cleanup-legacy-sync.mjs';
import { git, ensureInfoHub, installWorkbench } from './install-source.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillDir = path.join(repoRoot, 'skill');
const SKILL_TARGETS = [
  ['.codex', '.codex/skills'], ['.claude', '.claude/skills'],
  ['.config/opencode', '.config/opencode/skills'], ['.gemini', '.gemini/config/skills'],
  ['.dsh', '.dsh/skills'], ['.pi/agent', '.pi/agent/skills'], ['.zcode', '.zcode/skills'],
];

// 常驻指令的唯一来源是 InfoHub《InfoHub使用入口》的"常驻指令"一节，安装时写入各 harness 的用户级指令文件。
const RESIDENT_SOURCE = path.join('AI开发工程化', 'InfoHub使用入口.md');
const RESIDENT_TARGETS = [
  '.codex/AGENTS.md', '.claude/CLAUDE.md', '.config/opencode/AGENTS.md',
  '.gemini/GEMINI.md', '.dsh/AGENTS.md', '.pi/agent/AGENTS.md', '.zcode/AGENTS.md'
];
const RESIDENT_HEADING = '\n## 常驻指令\n';

export function renderResident(markdown, root) {
  markdown = markdown.replaceAll('\r\n', '\n');
  const start = markdown.indexOf(RESIDENT_HEADING);
  if (start < 0) throw new Error(`${RESIDENT_SOURCE} 缺少"## 常驻指令"一节`);
  const bodyStart = start + RESIDENT_HEADING.length;
  const end = markdown.indexOf('\n## ', bodyStart);
  const body = markdown.slice(bodyStart, end < 0 ? undefined : end).trim();
  return '<!-- 由 work-ontology 的 scripts/install.mjs 从 InfoHub《InfoHub使用入口》生成；要修改请改 InfoHub 原文后重新运行安装 -->\n\n'
    + body.replaceAll('{{INFOHUB_ROOT}}', root).replace(/^### /gm, '# ') + '\n';
}

// 只写本机已安装的 harness（其配置目录存在），不为没装的 harness 建目录。
async function writeResident(root, userHome) {
  const text = renderResident(await readFile(path.join(root, RESIDENT_SOURCE), 'utf8'), root);
  for (const rel of RESIDENT_TARGETS) {
    const target = path.join(userHome, rel);
    if (!existsSync(path.dirname(target))) {
      console.log(`未安装，跳过常驻指令: ${target}`);
      continue;
    }
    await writeFile(target, text, 'utf8');
    console.log(`已写入常驻指令: ${target}`);
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = { '--root': 'root', '--infohub-url': 'infohubUrl' }[argv[i]];
    if (key && argv[i + 1] && !argv[i + 1].startsWith('--')) options[key] = argv[++i];
    else throw new Error(`未知选项或缺少值：${argv[i]}。用法：node scripts/install.mjs [--root <目录>] [--infohub-url <SSH地址>]`);
  }
  return options;
}

async function linkSkill(source, target) {
  await mkdir(path.dirname(target), { recursive: true });

  let stats = null;
  try {
    stats = await lstat(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (stats) {
    if (stats.isSymbolicLink()) {
      const linkDest = await readlink(target);
      const resolved = path.resolve(path.dirname(target), linkDest);
      if (await realpath(target) === await realpath(source)) {
        console.log(`链接已存在且指向同处，跳过: ${target}`);
        return;
      }
      throw new Error(`目标已存在且指向其他路径 (${resolved})，中止: ${target}`);
    }
    throw new Error(`目标已存在且不是符号链接，中止: ${target}`);
  }

  const linkType = platform() === 'win32' ? 'junction' : 'dir';
  await symlink(source, target, linkType);
  console.log(`已创建链接: ${target} -> ${source}`);
}

export async function installCli(rootArg, userHome = homedir(), repository) {
  // npm owns the platform-specific global shims. Keep them outside Node's
  // version directory so changing mise/nvm versions cannot remove the command.
  npm(['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: repoRoot, stdio: 'inherit' });
  const command = await installCommand(repoRoot, userHome);

  const root = path.resolve(rootArg);

  // 2. 常驻指令（在链接 Skill 之前，以免链接步骤建出的目录被误当成已安装的 harness）
  await writeResident(root, userHome);

  // 3. 两个 Skill 使用同一机制，只链接已安装的 harness。
  const netcattySkill = path.join(root, 'skills/netcatty-ssh');
  npm(['ci', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'], { cwd: netcattySkill, stdio: 'inherit' });
  const skills = [['infohub', skillDir], ['netcatty-ssh', netcattySkill]];
  for (const [harness, directory] of SKILL_TARGETS) {
    if (!existsSync(path.join(userHome, harness))) continue;
    for (const [name, source] of skills) await linkSkill(source, path.join(userHome, directory, name));
  }
  const config = path.join(userHome, '.config/netcatty-ssh/config.json');
  if (!existsSync(config)) console.log(`netcatty-ssh 凭据尚未配置（不影响接入）：请创建 ${config}，填写 endpoint、username、password、vaultPassword。说明：${path.join(netcattySkill, 'SKILL.md')}`);

  // 4. 写 ~/.config/infohub/config.json
  const configDir = path.join(userHome, '.config', 'infohub');
  const configFile = path.join(configDir, 'config.json');
  await mkdir(configDir, { recursive: true });
  let prior = {};
  try { prior = JSON.parse(await readFile(configFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const runtime = { node: command.node, git: command.git, cli: path.join(repoRoot, 'cli', 'infohub.mjs') };
  await writeFile(configFile, JSON.stringify({ root, runtime, repository: repository || prior.repository }, null, 2) + '\n', 'utf8');
  console.log(`已更新配置: ${configFile}`);
  return runtime;
}

export async function install(argv = process.argv.slice(2)) {
  let step = '检查运行环境';
  try {
    const options = parseArgs(argv);
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 24 || (major === 24 && minor < 11)) throw new Error('请安装 Node.js 24 LTS（24.11+）或以上（包含 npm）');
    const version = git(['--version']).match(/(\d+)\.(\d+)/);
    if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 38)) throw new Error('请安装 Git 2.38 或以上');
    const userHome = homedir();
    let prior = {};
    try { prior = JSON.parse(await readFile(path.join(userHome, '.config/infohub/config.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const infohubUrl = options.infohubUrl || prior.repository;
    if (!infohubUrl) throw new Error('首次接入请用 --infohub-url <InfoHub Git 地址> 指定内容仓库；以后从用户配置读取，不从工具仓库推算。');
    const root = path.resolve(options.root || prior.root || path.join(repoRoot, '..', 'InfoHub'));
    step = '读取或克隆 InfoHub'; console.log(`\n[1/4] ${step}`);
    await ensureInfoHub(root, infohubUrl);
    step = '安装 CLI、Skill 和常驻指令'; console.log(`\n[2/4] ${step}`);
    await installCli(root, userHome, infohubUrl);
    step = '清理旧同步托管'; console.log(`\n[3/4] ${step}`);
    await cleanupLegacySync(root, userHome);
    step = '首次安装工作台'; console.log(`\n[4/4] ${step}`);
    await installWorkbench();
    console.log(`\n接入已配置。InfoHub：${root}；工作台启动后托管同步。`);
  } catch (e) {
    throw new Error(`[${step}] ${e.message}\n修正后重跑同一 install 命令即可；已有副本和同步配置不会被覆盖。工作台启动后托管同步；首次已有未提交内容时按同步提示确认。`);
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await install();
  } catch (err) {
    console.error(`安装失败: ${err.message}`);
    process.exit(1);
  }
}
