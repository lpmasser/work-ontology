import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadVault } from './vault.mjs';

export const needsValidation = paths => paths.some(p => p.endsWith('.md') || p === 'ontology/ontology.json');
export const selectIssues = (issues, paths) => paths.includes('ontology/ontology.json')
  ? issues : issues.filter(issue => paths.includes(issue.path));

export async function validateTree(dir, changedPaths) {
  if (!needsValidation(changedPaths)) return [];
  const { index } = await loadVault(dir);
  return selectIssues(index.issues, changedPaths);
}

// CLI paths use the caller's cwd; Git manifests already use vault-relative paths.
export async function checkPaths(root, paths, model) {
  root = await realpath(root);
  return Promise.all(paths.map(async input => {
    const absolute = await realpath(path.resolve(input));
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error(`路径不在库内: ${input}`);
    if (!model.folders.some(folder => relative.startsWith(`${folder}/`))) throw new Error(`路径不在模型目录里: ${input}`);
    if (!(await stat(absolute)).isFile()) throw new Error(`校验路径必须是文件: ${input}`);
    return relative;
  }));
}
