#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { configureRuntime, readConfig } from '../core/runtime.mjs';
import { loadVault } from '../core/vault.mjs';
import { buildOverview } from '../core/overview.mjs';
import { isUnfinishedWork } from '../core/engine.js';
import { resolveProject, filterObjects, queryFind, queryGet, queryAround } from '../core/query.mjs';
import { checkPaths, selectIssues } from '../core/validation.mjs';
import { command as syncCommand, concerns } from '../sync/command.mjs';

const USAGE = `用法: infohub <命令> [参数...]

命令:
  brief <项目>                                              获取项目开工说明（项目 ID 或 title）
  find [文本] [--type <类>] [--project <项目>] [--where <k=v>]... 查找对象
  overview                                                 工作台汇总（JSON，同一次文档库快照）
  around <ID或路径>... [--relation <关系>] [--direction outgoing|incoming] 查询关联对象
  get <ID或路径>                                             获取对象路径与全部属性
  check [路径...]                                           校验对象与模型（有错误退出码 1）
  sync run|status|logs                               运行同步本体或查看状态（托管由工作台 / Docker 负责）
  help                                                     显示帮助信息

选项:
  --root <目录>                                             指定 InfoHub 根目录（覆盖配置文件）
  find/get/around --json                                    输出带 version 的查询 JSON
  find --where-not <k=v> [--has <字段>]                     排除匹配值；要求字段非空，可重复
`;

function parseCliArgs(argv) {
  let root = null;
  const filtered = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      if (i + 1 >= argv.length) {
        throw new Error('--root 参数缺少目录路径');
      }
      root = argv[++i];
    } else {
      filtered.push(argv[i]);
    }
  }
  return { root, args: filtered };
}

async function handleBrief(vault, target, root) {
  if (!target) {
    throw new Error('brief 命令缺少 <项目> 参数');
  }

  const project = resolveProject(vault.index, target);
  const projectId = project.id;

  // 属于该项目的对象集合
  const projectMemberIds = new Set();
  for (const obj of vault.index.objects.values()) {
    if (obj.frontmatter.project_id === projectId) {
      projectMemberIds.add(obj.id);
    }
  }

  const output = [];
  output.push(`项目入口: ${project.path}`);

  // 规范与方法的相关规则：project_id 是该项目，或 applies_to 包含该项目或属于该项目的对象
  const relatedOfType = type => [...vault.index.objects.values()].filter(obj => obj.type === type
    && (obj.frontmatter.project_id === projectId
      || (obj.frontmatter.applies_to ?? []).some(id => id === projectId || projectMemberIds.has(id))));

  // 规范与方法都按"何时读"列出，Agent 只读这次用得上的；use_when 缺失时提示补写
  const pushWithUseWhen = (heading, objects) => {
    output.push(`\n${heading}:`);
    if (!objects.length) {
      output.push('无');
      return;
    }
    for (const obj of objects) {
      output.push(`${obj.title} — ${obj.frontmatter.use_when || '未写何时使用'} — ${obj.path}`);
    }
  };
  pushWithUseWhen('适用规范', relatedOfType('standard'));
  pushWithUseWhen('工作方法', relatedOfType('method'));

  // 知识按项目归属几乎全部命中，列进开工说明只会淹没上面两节；要查现成判断用 find --type knowledge

  const workItems = filterObjects(vault, { projectId }).filter(isUnfinishedWork);

  output.push('\n进行中的工作:');
  if (workItems.length) {
    for (const w of workItems) {
      output.push(`${w.title} [${w.frontmatter.requirement}/${w.frontmatter.progress}] — ${w.path}`);
    }
  } else {
    output.push('无');
  }

  // 4. 需关注: 该项目所有对象中 attention 非空者，每行 title：attention — 路径
  const attentionObjects = [...vault.index.objects.values()].filter(obj => {
    if (obj.frontmatter.project_id !== projectId && obj.id !== projectId) return false;
    return Boolean(obj.frontmatter.attention);
  });

  output.push('\n需关注:');
  const syncConcerns = await concerns(root);
  if (attentionObjects.length || syncConcerns.length) {
    output.push(...syncConcerns);
    for (const a of attentionObjects) {
      output.push(`${a.title}：${a.frontmatter.attention} — ${a.path}`);
    }
  } else {
    output.push('无');
  }

  console.log(output.join('\n'));
}

function handleFind(vault, findArgs) {
  const { json, snapshot } = queryFind(vault, findArgs);
  if (json) {
    console.log(JSON.stringify(snapshot));
    return;
  }
  for (const obj of snapshot.objects) {
    console.log(`${obj.id}  ${obj.type}  ${obj.title} — ${obj.path}`);
  }
  console.log(`共 ${snapshot.objects.length} 个对象`);
}

function handleOverview(vault) {
  console.log(JSON.stringify(buildOverview(vault.index)));
}

async function handleAround(vault, aroundArgs) {
  const res = queryAround(vault, aroundArgs);
  if (aroundArgs.includes('--json')) { console.log(JSON.stringify(res)); return; }

  const matchedGroups = res.groups.filter(g => g.total > 0);
  if (matchedGroups.length === 0) {
    console.log('暂无关联对象');
    return;
  }

  for (const group of matchedGroups) {
    console.log(`${group.label} (${group.total})`);
    for (const obj of group.objects) {
      console.log(`  ${obj.id}  ${obj.title} — ${obj.path}`);
    }
  }
}

async function handleGet(vault, target, json) {
  const snapshot = queryGet(vault, target);
  if (json) { console.log(JSON.stringify(snapshot)); return; }
  const obj = snapshot.object;
  console.log(`路径: ${obj.path}`);
  for (const [key, val] of Object.entries(obj.frontmatter)) {
    const displayVal = Array.isArray(val) ? val.join(', ') : val;
    console.log(`${key}: ${displayVal}`);
  }
}

async function handleCheck(vault, paths, root) {
  const targets = await checkPaths(root, paths, vault.model);
  const issues = paths.length ? selectIssues(vault.index.issues, targets) : vault.index.issues;

  if (issues.length === 0) {
    console.log('无问题');
    return 0;
  }

  for (const issue of issues) {
    console.log(`${issue.path}：${issue.message}`);
  }
  console.log(`共 ${issues.length} 个问题`);
  return 1;
}

export async function main(argv = process.argv.slice(2)) {
  const { root: cliRoot, args } = parseCliArgs(argv);
  const command = args[0];

  if (!command || command === 'help') {
    console.log(USAGE);
    return command === 'help' ? 0 : 1;
  }

  const config = await readConfig();
  if (!cliRoot && !config?.root) throw new Error('未指定 InfoHub 根目录；请使用 --root <dir> 或运行 scripts/install.mjs。');
  const root = path.resolve(cliRoot || config.root);
  await configureRuntime(config);
  if (command === 'sync') { await syncCommand(root, args.slice(1)); return 0; }
  const vault = await loadVault(root);

  switch (command) {
    case 'brief':
      await handleBrief(vault, args[1], root);
      return 0;
    case 'find':
      await handleFind(vault, args.slice(1));
      return 0;
    case 'overview':
      if (args.length !== 1) throw new Error('overview 命令不接受参数');
      handleOverview(vault);
      return 0;
    case 'around':
      await handleAround(vault, args.slice(1));
      return 0;
    case 'get':
      await handleGet(vault, args.slice(1).find(arg => arg !== '--json'), args.includes('--json'));
      return 0;
    case 'check':
      return await handleCheck(vault, args.slice(1), root);
    default:
      console.error(`未知命令: ${command}\n\n${USAGE}`);
      return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    const exitCode = await main();
    process.exitCode = exitCode;
  } catch (err) {
    console.error(`错误: ${err.message}`);
    process.exitCode = 1;
  }
}
