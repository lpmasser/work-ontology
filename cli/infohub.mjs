#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { configureRuntime, readConfig } from '../core/runtime.mjs';
import { loadVault } from '../core/vault.mjs';
import { buildOverview } from '../core/overview.mjs';
import { searchAround, isUnfinishedWork } from '../core/engine.js';
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
  find --json                                              输出 version、objects、issues，保留完整属性
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

function resolveObjectId(index, idOrPath) {
  idOrPath = idOrPath.replaceAll('\\', '/');
  if (idOrPath.endsWith('.md')) {
    for (const obj of index.objects.values()) {
      if (obj.path === idOrPath) return obj.id;
    }
    return null;
  }
  return index.objects.has(idOrPath) ? idOrPath : null;
}

function resolveProject(index, target) {
  const projects = [...index.objects.values()].filter(o => o.type === 'project');
  const found = projects.find(p => p.id === target || p.title === target);
  if (found) return found;

  const list = projects.map(p => `  ${p.id}  ${p.title}`).join('\n');
  throw new Error(`找不到项目 "${target}"。可用项目:\n${list || '  (无项目)'}`);
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

  // 相关知识：标题即结论，按与规范、方法相同的相关规则列出，让 Agent 开工时知道有哪些现成判断
  const knowledge = relatedOfType('knowledge');
  output.push('\n相关知识:');
  output.push(...(knowledge.length ? knowledge.map(k => `${k.title} — ${k.path}`) : ['无']));

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

function queryFind(vault, findArgs) {
  let type = null;
  let projectFilter = null;
  const whereClauses = [];
  const excludedClauses = [];
  const requiredFields = [];
  let json = false;
  const textWords = [];

  for (let i = 0; i < findArgs.length; i++) {
    const arg = findArgs[i];
    if (arg === '--type') {
      if (i + 1 >= findArgs.length) throw new Error('--type 缺少参数');
      type = findArgs[++i];
    } else if (arg === '--project') {
      if (i + 1 >= findArgs.length) throw new Error('--project 缺少参数');
      projectFilter = findArgs[++i];
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--has') {
      if (i + 1 >= findArgs.length) throw new Error('--has 缺少参数');
      requiredFields.push(findArgs[++i]);
    } else if (arg === '--where' || arg === '--where-not') {
      if (i + 1 >= findArgs.length) throw new Error(`${arg} 缺少参数`);
      const clause = findArgs[++i];
      const eqIdx = clause.indexOf('=');
      if (eqIdx === -1) throw new Error(`--where 参数格式必须为 字段=值: ${clause}`);
      (arg === '--where' ? whereClauses : excludedClauses).push([clause.slice(0, eqIdx), clause.slice(eqIdx + 1)]);
    } else if (arg.startsWith('--')) {
      throw new Error(`未知 find 选项: ${arg}`);
    } else {
      textWords.push(arg);
    }
  }

  const text = textWords.join(' ');
  if (!type && !projectFilter && whereClauses.length === 0 && excludedClauses.length === 0 && requiredFields.length === 0 && !text) {
    throw new Error('find 命令必须至少提供一个条件（文本、--type、--project、--where）');
  }

  const projectId = projectFilter ? resolveProject(vault.index, projectFilter).id : null;
  const results = filterObjects(vault, { type, projectId, whereClauses, excludedClauses, requiredFields, text });
  return { json, snapshot: { version: 1, objects: results, issues: vault.index.issues } };
}

function filterObjects(vault, { type, projectId, whereClauses = [], excludedClauses = [], requiredFields = [], text } = {}) {

  const bodiesByPath = new Map(vault.notes.map(n => [n.path, n.body]));
  const textLower = text ? text.toLowerCase() : null;

  const results = [];
  for (const obj of vault.index.objects.values()) {
    if (type && obj.type !== type) continue;
    if (projectId && obj.frontmatter.project_id !== projectId) continue;

    let whereMatch = true;
    for (const [key, val] of whereClauses) {
      const actual = obj.frontmatter[key];
      if (Array.isArray(actual)) {
        if (!actual.some(item => String(item) === val)) {
          whereMatch = false;
          break;
        }
      } else if (actual == null || String(actual) !== val) {
        whereMatch = false;
        break;
      }
    }
    if (!whereMatch) continue;
    if (excludedClauses.some(([key, val]) => {
      const actual = obj.frontmatter[key];
      return Array.isArray(actual) ? actual.some(item => String(item) === val) : actual != null && String(actual) === val;
    })) continue;
    if (requiredFields.some(key => {
      const actual = obj.frontmatter[key];
      return Array.isArray(actual) ? actual.length === 0 : !actual;
    })) continue;

    if (textLower) {
      const inTitle = (obj.title ?? '').toLowerCase().includes(textLower);
      const body = bodiesByPath.get(obj.path) || '';
      const inBody = body.toLowerCase().includes(textLower);
      if (!inTitle && !inBody) continue;
    }

    results.push(obj);
  }

  return results;
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
  const idsOrPaths = [];
  let relation = undefined;
  let direction = 'both';

  for (let i = 0; i < aroundArgs.length; i++) {
    const arg = aroundArgs[i];
    if (arg === '--relation') {
      if (i + 1 >= aroundArgs.length) throw new Error('--relation 缺少参数');
      relation = aroundArgs[++i];
    } else if (arg === '--direction') {
      if (i + 1 >= aroundArgs.length) throw new Error('--direction 缺少参数');
      const d = aroundArgs[++i];
      if (d === 'outgoing') direction = 'out';
      else if (d === 'incoming') direction = 'in';
      else throw new Error(`--direction 只能是 outgoing 或 incoming，当前为: ${d}`);
    } else {
      idsOrPaths.push(arg);
    }
  }

  if (idsOrPaths.length === 0) {
    throw new Error('around 命令缺少起点 ID 或路径');
  }

  const ids = idsOrPaths.map(item => {
    const resolved = resolveObjectId(vault.index, item);
    if (!resolved) throw new Error(`找不到起点对象: ${item}`);
    return resolved;
  });

  const res = searchAround(vault.index, vault.model, { ids, relation, direction });

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

async function handleGet(vault, target) {
  if (!target) {
    throw new Error('get 命令缺少 ID 或路径参数');
  }

  const id = resolveObjectId(vault.index, target);
  if (!id) {
    throw new Error(`找不到对象: ${target}`);
  }

  const obj = vault.index.objects.get(id);
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
      await handleGet(vault, args[1]);
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
