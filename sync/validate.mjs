import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { git } from './git.mjs';
import { x } from 'tar';
import { validateTree, needsValidation } from '../core/validation.mjs';

// Validate the immutable candidate exported exactly as it will be on the server,
// not a live worktree which can change while checks run. Compare against remote
// main so unpublished Agent commits are included in the server's changed set.
export async function validateCommit(root, base, commit, tempParent) {
  const changed = (await git(root, ['diff', '--name-only', '-z', base, commit])).stdout.split('\0').filter(Boolean);
  if (!needsValidation(changed)) return;
  const temp = await mkdtemp(path.join(tempParent, 'validate-'));
  try {
    const tree = path.join(temp, 'tree'), archive = path.join(temp, 'tree.tar');
    await mkdir(tree);
    await git(root, ['archive', '--format=tar', `--output=${archive}`, commit]);
    await x({ file: archive, cwd: tree, strict: true });
    const issues = await validateTree(tree, changed);
    if (issues.length) throw new Error(issues.map(i => `${i.path}：${i.message}`).join('\n'));
  } finally { await rm(temp, { recursive: true, force: true }); }
}
