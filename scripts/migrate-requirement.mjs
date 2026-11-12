import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parse as parseYaml } from 'yaml';

const USAGE = '用法: node scripts/migrate-requirement.mjs --root <InfoHub目录> --mapping <json> [--dry-run]';

function parseArgs(argv) {
  let root, mappingPath, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = argv[++i];
    else if (argv[i] === '--mapping') mappingPath = argv[++i];
    else if (argv[i] === '--dry-run') dryRun = true;
    else throw new Error(`未知参数：${argv[i]}\n${USAGE}`);
  }
  if (!root || !mappingPath) throw new Error(USAGE);
  return { root: path.resolve(root), mappingPath: path.resolve(mappingPath), dryRun };
}

async function collectMarkdown(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectMarkdown(full));
    else if (entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

function splitDocument(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { header: null, body: text };
  return { header: match[1], body: match[2] };
}

const dropField = (header, field) => header.split('\n').filter(line => !line.startsWith(`${field}:`)).join('\n');

function insertAfter(header, afterField, line) {
  const lines = header.split('\n');
  const index = lines.findIndex(item => item.startsWith(`${afterField}:`));
  lines.splice(index + 1, 0, line);
  return lines.join('\n');
}

const relationPath = (fromDir, to) => path.relative(fromDir, to).split(path.sep).join('/')
  .replaceAll('%', '%25').replaceAll(' ', '%20').replaceAll('#', '%23');

function rewriteLinks(body, oldDir, finalDir, moves) {
  return body.replace(/\]\(([^)\n]+)\)/g, (whole, target) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('#')) return whole;
    const hash = target.indexOf('#');
    const pathPart = hash === -1 ? target : target.slice(0, hash);
    const suffix = hash === -1 ? '' : target.slice(hash);
    const resolved = path.resolve(oldDir, decodeURIComponent(pathPart));
    const finalTarget = moves.get(resolved)?.to ?? resolved;
    if (oldDir === finalDir && finalTarget === resolved) return whole;
    return `](${relationPath(finalDir, finalTarget)}${suffix})`;
  });
}

function requirementHeader(header, status) {
  const lines = [
    header.replace(/^ontology_type:.*$/m, 'ontology_type: "requirement"'),
  ];
  let edited = dropField(lines[0], 'requirement');
  edited = dropField(edited, 'progress');
  edited = dropField(edited, 'kind');
  return insertAfter(edited, 'project_id', `status: "${status}"`);
}

function planDocument(file, root, text, moves) {
  const { header, body } = splitDocument(text);
  const frontmatter = header === null ? null : parseYaml(header);
  const finalFile = moves.get(file)?.to ?? file;
  const newBody = rewriteLinks(body, path.dirname(file), path.dirname(finalFile), moves);
  let newHeader = header;
  if (frontmatter?.ontology_type === 'work_item') newHeader = moves.has(file)
    ? requirementHeader(header, moves.get(file).status)
    : dropField(dropField(header, 'kind'), 'requirement');
  const newText = newHeader === null ? newBody : `---\n${newHeader}\n---\n${newBody}`;
  return {
    file,
    finalFile,
    moved: moves.has(file),
    headerChanged: newHeader !== header,
    linksChanged: newBody !== body,
    changed: newText !== text,
    text: newText,
  };
}

function verifyWorkHeaders(documents) {
  const offenders = [];
  for (const document of documents) {
    const { header } = splitDocument(document.text);
    if (header === null || parseYaml(header).ontology_type !== 'work_item') continue;
    for (const line of header.split('\n')) {
      if (/^(?:kind|requirement):/.test(line)) offenders.push(`${path.relative(process.cwd(), document.finalFile)}：${line}`);
    }
  }
  return offenders;
}

async function main() {
  const { root, mappingPath, dryRun } = parseArgs(process.argv.slice(2));
  const { toRequirement } = JSON.parse(await readFile(mappingPath, 'utf8'));

  const files = await collectMarkdown(root);
  const documents = new Map();
  for (const file of files) {
    documents.set(file, { file, text: await readFile(file, 'utf8') });
  }

  const byId = new Map();
  for (const document of documents.values()) {
    const { header } = splitDocument(document.text);
    if (header === null) continue;
    const frontmatter = parseYaml(header);
    if (typeof frontmatter?.ontology_id === 'string') byId.set(frontmatter.ontology_id, document.file);
  }

  const moves = new Map();
  for (const [id, status] of Object.entries(toRequirement)) {
    const file = byId.get(id);
    if (!file) throw new Error(`映射中的对象不存在：${id}`);
    const relative = path.relative(root, file);
    const parts = relative.split(path.sep);
    const workIndex = parts.lastIndexOf('工作');
    if (workIndex < 0) throw new Error(`对象不在 工作/ 目录里：${relative}`);
    const target = path.join(root, ...parts.slice(0, workIndex), '需求', ...parts.slice(workIndex + 1));
    moves.set(file, { to: target, status });
  }

  const plans = [...documents.values()].map(document => planDocument(document.file, root, document.text, moves));
  const changed = plans.filter(plan => plan.changed);

  if (dryRun) console.log('[dry-run] 不写入文件');
  for (const plan of changed) {
    const actions = [
      plan.moved && '移动',
      plan.headerChanged && '改头',
      plan.linksChanged && '改链',
    ].filter(Boolean);
    const from = path.relative(root, plan.file);
    console.log(`${actions.join('+')}  ${from}${plan.moved ? ` → ${path.relative(root, plan.finalFile)}` : ''}`);
  }
  console.log(`共改动 ${changed.length} 个文件`);

  if (!dryRun) {
    for (const plan of changed.filter(item => item.moved)) {
      await mkdir(path.dirname(plan.finalFile), { recursive: true });
      await rename(plan.file, plan.finalFile);
    }
    for (const plan of changed) await writeFile(plan.finalFile, plan.text);
  }

  const offenders = verifyWorkHeaders(plans);
  if (offenders.length) {
    console.log(`核对失败：${offenders.length} 处 work_item 头部仍有 kind/requirement`);
    for (const offender of offenders) console.log(offender);
    process.exitCode = 1;
  } else {
    console.log('核对：全库 work_item 头部不再有 kind/requirement 行');
  }
}

await main();
