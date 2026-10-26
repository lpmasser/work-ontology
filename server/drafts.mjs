import path from 'node:path';
import { git, value, json, save, iso, DRAFT_PREFIX, STATUS_REF, isAncestor } from '../sync/git.mjs';

export async function scanDrafts(repo, stateDir, { staleSeconds = 7 * 86400 } = {}) {
  const previous = await json(path.join(stateDir, 'status.json'), { drafts: [] });
  const main = await value(repo, ['rev-parse', 'refs/heads/main']);
  const mainTree = await value(repo, ['rev-parse', `${main}^{tree}`]);
  const refs = (await value(repo, ['for-each-ref', '--format=%(refname) %(objectname)', DRAFT_PREFIX])).split('\n').filter(Boolean);
  const drafts = [];
  for (const line of refs) {
    const [ref, commit] = line.split(' '), id = ref.slice(DRAFT_PREFIX.length);
    const old = previous.drafts.find(d => d.ref === ref);
    const d = { ref, id, commit, updatedAt: old?.commit === commit ? old.updatedAt : iso() };
    d.stale = Date.now() - Date.parse(d.updatedAt) >= staleSeconds * 1000;
    try {
      d.source = await value(repo, ['show', '-s', '--format=%b', commit]);
      // Include unpublished local commits as well as the snapshot's working changes.
      d.base = await value(repo, ['merge-base', main, commit]);
      d.changedPaths = (await git(repo, ['diff', '--no-renames', '--name-only', '-z', d.base, commit])).stdout.split('\0').filter(Boolean);
      const result = await git(repo, ['merge-tree', '--write-tree', '--name-only', '-z', main, commit], { allowFailure: true });
      const parts = result.stdout.split('\0');
      if (result.code > 1) throw new Error(result.stderr || result.stdout);
      const tree = parts.shift();
      d.conflicts = [];
      if (result.code === 1) { for (const file of parts) { if (!file) break; d.conflicts.push(file); } }
      const included = result.code === 0 && (tree === mainTree || await isAncestor(repo, commit, main));
      if (included && await value(repo, ['rev-parse', 'refs/heads/main']) === main) {
        // A new upload cannot be deleted by an older scan.
        await git(repo, ['update-ref', '-d', ref, commit]); continue;
      }
    } catch (e) { d.error = e.message; }
    drafts.push(d);
  }
  // Compare only drafts whose actual changed paths overlap. Preserve the
  // difference between an overlap warning and a Git-confirmed merge conflict.
  for (const d of drafts) d.overlaps = [];
  for (let i = 0; i < drafts.length; i++) {
    for (let j = i + 1; j < drafts.length; j++) {
      const a = drafts[i], b = drafts[j];
      const paths = new Set();
      for (const x of a.changedPaths || []) for (const y of b.changedPaths || []) {
        if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) { paths.add(x); paths.add(y); }
      }
      if (!paths.size) continue;
      const result = await git(repo, ['merge-tree', '--write-tree', '--name-only', '-z', a.commit, b.commit], { allowFailure: true });
      const conflicts = [];
      if (result.code === 1) for (const file of result.stdout.split('\0').slice(1)) { if (!file) break; conflicts.push(file); }
      const comparison = { paths: [...paths].sort(), conflicts, mergeable: result.code === 0 };
      if (result.code > 1) comparison.error = result.stderr || result.stdout;
      a.overlaps.push({ ref: b.ref, source: b.source || b.id, ...comparison });
      b.overlaps.push({ ref: a.ref, source: a.source || a.id, ...comparison });
    }
  }
  const report = { checkedAt: iso(), main, drafts };
  // Publish a heartbeat at most once a minute when the result is unchanged.
  const changed = JSON.stringify([main, drafts]) !== JSON.stringify([previous.main, previous.drafts]);
  if (!changed && Date.now() - Date.parse(previous.publishedAt || 0) < 60000) {
    report.publishedAt = previous.publishedAt;
    await save(path.join(stateDir, 'status.json'), report);
    return report;
  }
  report.publishedAt = iso();
  const env = { GIT_AUTHOR_NAME: 'InfoHub Drafts', GIT_AUTHOR_EMAIL: 'drafts@infohub.local', GIT_COMMITTER_NAME: 'InfoHub Drafts', GIT_COMMITTER_EMAIL: 'drafts@infohub.local' };
  const blob = await value(repo, ['hash-object', '-w', '--stdin'], { input: JSON.stringify(report) + '\n' });
  const tree = await value(repo, ['mktree'], { input: `100644 blob ${blob}\tstatus.json\n` });
  const commit = await value(repo, ['commit-tree', tree], { env, input: 'InfoHub draft status\n' });
  await git(repo, ['update-ref', STATUS_REF, commit]);
  await save(path.join(stateDir, 'status.json'), report);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const repo = process.env.INFOHUB_REPO, dir = process.env.INFOHUB_STATE_DIR;
  if (!repo || !dir) throw new Error('需要 INFOHUB_REPO 与 INFOHUB_STATE_DIR');
  // Compose owns the singleton process and restart lifecycle.
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; }); process.on('SIGINT', () => { stopping = true; });
  try {
    while (!stopping) {
      try { const s = await scanDrafts(repo, dir, { staleSeconds: Number(process.env.INFOHUB_STALE_SECONDS || 604800) }); console.log(`${s.checkedAt} drafts=${s.drafts.length} conflicts=${s.drafts.filter(d => d.conflicts?.length).length}`); }
      catch (e) { console.error(`${iso()} ${e.message}`); }
      if (!stopping) await new Promise(r => setTimeout(r, Number(process.env.INFOHUB_SCAN_SECONDS || 5) * 1000));
    }
  } finally { console.log(`${iso()} stopped`); }
}
