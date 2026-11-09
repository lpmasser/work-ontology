import { searchAround } from './engine.js';
import { withObjectUrl } from './links.mjs';

export function resolveObjectId(index, target) {
  target = target.replaceAll('\\', '/');
  if (target.endsWith('.md')) return [...index.objects.values()].find(o => o.path === target)?.id ?? null;
  return index.objects.has(target) ? target : null;
}

export function resolveProject(index, target) {
  const projects = [...index.objects.values()].filter(o => o.type === 'project');
  const found = projects.find(p => p.id === target || p.title === target);
  if (found) return found;
  throw new Error(`找不到项目 "${target}"。可用项目:\n${projects.map(p => `  ${p.id}  ${p.title}`).join('\n') || '  (无项目)'}`);
}

export function filterObjects(vault, { type, projectId, whereClauses = [], excludedClauses = [], requiredFields = [], text } = {}) {
  const bodies = new Map(vault.notes.map(n => [n.path, n.body]));
  const matches = (fm, [key, val]) => Array.isArray(fm[key]) ? fm[key].some(v => String(v) === val) : fm[key] != null && String(fm[key]) === val;
  return [...vault.index.objects.values()].filter(obj => {
    const fm = obj.frontmatter;
    return (!type || obj.type === type) && (!projectId || fm.project_id === projectId)
      && whereClauses.every(c => matches(fm, c)) && !excludedClauses.some(c => matches(fm, c))
      && !requiredFields.some(k => Array.isArray(fm[k]) ? fm[k].length === 0 : !fm[k])
      && (!text || (obj.title ?? '').toLowerCase().includes(text.toLowerCase()) || (bodies.get(obj.path) || '').toLowerCase().includes(text.toLowerCase()));
  });
}

export function queryFind(vault, args, { webUrl } = {}) {
  const options = { whereClauses: [], excludedClauses: [], requiredFields: [] }, words = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') { json = true; continue; }
    if (['--type', '--project', '--has', '--where', '--where-not'].includes(arg)) {
      if (i + 1 >= args.length) throw new Error(`${arg} 缺少参数`);
      const val = args[++i];
      if (arg === '--type') options.type = val;
      if (arg === '--project') options.projectId = resolveProject(vault.index, val).id;
      if (arg === '--has') options.requiredFields.push(val);
      if (arg === '--where' || arg === '--where-not') {
        const eq = val.indexOf('=');
        if (eq === -1) throw new Error(`--where 参数格式必须为 字段=值: ${val}`);
        options[arg === '--where' ? 'whereClauses' : 'excludedClauses'].push([val.slice(0, eq), val.slice(eq + 1)]);
      }
    } else if (arg.startsWith('--')) throw new Error(`未知 find 选项: ${arg}`);
    else words.push(arg);
  }
  options.text = words.join(' ');
  if (!options.type && !options.projectId && !options.whereClauses.length && !options.excludedClauses.length && !options.requiredFields.length && !options.text) throw new Error('find 命令必须至少提供一个条件（文本、--type、--project、--where）');
  return { json, snapshot: { version: 1, objects: filterObjects(vault, options).map(object => withObjectUrl(object, webUrl)), issues: vault.index.issues } };
}

export function queryGet(vault, target, { webUrl } = {}) {
  if (!target) throw new Error('get 命令缺少 ID 或路径参数');
  const id = resolveObjectId(vault.index, target);
  if (!id) throw new Error(`找不到对象: ${target}`);
  return { version: 1, object: withObjectUrl(vault.index.objects.get(id), webUrl), issues: vault.index.issues };
}

export function queryAround(vault, args, { webUrl } = {}) {
  const targets = [];
  let relation, direction = 'both';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') continue;
    if (arg === '--relation' || arg === '--direction') {
      if (i + 1 >= args.length) throw new Error(`${arg} 缺少参数`);
      const val = args[++i];
      if (arg === '--relation') relation = val;
      else {
        if (!['outgoing', 'incoming'].includes(val)) throw new Error(`--direction 只能是 outgoing 或 incoming，当前为: ${val}`);
        direction = val === 'outgoing' ? 'out' : 'in';
      }
    } else if (arg.startsWith('--')) throw new Error(`未知 around 选项: ${arg}`);
    else targets.push(arg);
  }
  if (!targets.length) throw new Error('around 命令缺少起点 ID 或路径');
  const ids = targets.map(target => {
    const id = resolveObjectId(vault.index, target);
    if (!id) throw new Error(`找不到起点对象: ${target}`);
    return id;
  });
  const result = searchAround(vault.index, vault.model, { ids, relation, direction });
  return { version: 1, ...result, from: result.from.map(object => withObjectUrl(object, webUrl)),
    groups: result.groups.map(group => ({ ...group, objects: group.objects.map(object => withObjectUrl(object, webUrl)) })) };
}
