import { realpath, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectMarkdown } from './annotations.mjs';
import { loadVault } from './vault.mjs';

export const needsValidation = paths => paths.some(p => p.endsWith('.md') || p === 'ontology/ontology.json');
export const selectIssues = (issues, paths) => paths.includes('ontology/ontology.json')
  ? issues : issues.filter(issue => paths.includes(issue.path));

export async function annotationIssuesOutsideModel(root, paths, model) {
  const issues = [];
  for (const relative of new Set(paths)) {
    if (!relative.endsWith('.md') || model.folders.some(folder => relative.startsWith(`${folder}/`))) continue;
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(path.resolve(root) + path.sep) || relative.split('/').some(part => part.startsWith('.'))) continue;
    try { issues.push(...inspectMarkdown(await readFile(absolute, 'utf8'), relative).issues.filter(issue => issue.line !== undefined)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return issues;
}

export async function validateTree(dir, changedPaths) {
  if (!needsValidation(changedPaths)) return [];
  const { index, model } = await loadVault(dir);
  return [...selectIssues(index.issues, changedPaths), ...await annotationIssuesOutsideModel(dir, changedPaths, model)];
}

// CLI paths use the caller's cwd; Git manifests already use vault-relative paths.
export async function checkPaths(root, paths, model) {
  root = await realpath(root);
  return Promise.all(paths.map(async input => {
    const absolute = await realpath(path.resolve(input));
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error(`路径不在库内: ${input}`);
    if (!model.folders.some(folder => relative.startsWith(`${folder}/`)) && (!relative.endsWith('.md') || relative.split('/').some(part => part.startsWith('.')))) throw new Error(`路径不在模型目录里，且不是可校验批注的 Markdown: ${input}`);
    if (!(await stat(absolute)).isFile()) throw new Error(`校验路径必须是文件: ${input}`);
    return relative;
  }));
}
