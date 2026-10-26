import { readFile, mkdir, mkdtemp, rm, lstat, realpath } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { git, value, json, save, sha256, iso, gitBusy, isAncestor, DRAFT_PREFIX, REMOTE_PREFIX } from './git.mjs';
import { validateCommit } from './validate.mjs';

export const defaults = { fetchSeconds: 5, draftSeconds: 180, idleSeconds: 1800 };
export async function context(root, signal) {
  root = await realpath(root);
  const subject = { root, signal };
  const dir = await value(subject, ['rev-parse', '--absolute-git-dir']);
  if (await realpath(await value(subject, ['rev-parse', '--show-toplevel'])) !== root) throw new Error('必须指定 Git 工作副本根目录');
  if (await value(subject, ['rev-parse', '--git-common-dir']) !== '.git') throw new Error('后台同步只支持普通副本，不支持 worktree');
  return { root, dir, home: path.join(dir, 'infohub-sync'), signal };
}
export async function belongsToMovedCopy(ctx, previousRoot) {
  if (!previousRoot) return false;
  try { return await realpath(path.join(previousRoot, '.git')) === ctx.dir; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
export async function identity(ctx) {
  const file = path.join(ctx.home, 'identity.json');
  let id = await json(file);
  if (!id) {
    await mkdir(ctx.home, { recursive: true });
    id = { id: randomUUID(), machine: hostname(), user: userInfo().username, root: ctx.root };
    // A copy of .git opened at another path receives a fresh clone identity.
    await save(file, { ...id, root: ctx.root });
  } else if (id.root !== ctx.root) {
    const previousIds = await belongsToMovedCopy(ctx, id.root) ? [...id.previousIds || [], id.id] : [];
    id = { id: randomUUID(), machine: hostname(), user: userInfo().username, root: ctx.root, previousIds };
    await save(file, id);
  }
  return id;
}
export async function config(ctx, overrides = {}) {
  const saved = await json(path.join(ctx.home, 'config.json'), {});
  const settings = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, overrides[key] ?? saved[key] ?? fallback]));
  for (const k of ['fetchSeconds', 'draftSeconds', 'idleSeconds']) {
    if (!Number.isFinite(settings[k]) || settings[k] <= 0) throw new Error(`${k} 必须是正数`);
  }
  await value(ctx, ['remote', 'get-url', 'origin']);
  return settings;
}
async function fingerprint(ctx) {
  const head = await value(ctx, ['rev-parse', 'HEAD']);
  const status = (await git(ctx, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout;
  const fields = status.split('\0').filter(Boolean), files = [];
  for (let i = 0; i < fields.length; i++) {
    files.push(fields[i].slice(3));
    if (/^[RC]|^.[RC]/.test(fields[i])) files.push(fields[++i]);
  }
  const stats = [];
  for (const file of files) {
    try {
      const s = await lstat(path.join(ctx.root, file), { bigint: true });
      stats.push(`${file}:${s.mtimeNs}:${s.ctimeNs}:${s.size}:${s.mode}:${s.ino}`);
    } catch (e) { if (e.code !== 'ENOENT') throw e; stats.push(`${file}:missing`); }
  }
  let index = '';
  try { index = sha256(await readFile(path.join(ctx.dir, 'index'))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { head, files, dirty: Boolean(status), key: sha256(JSON.stringify([head, status, index, stats])) };
}
async function snapshot(ctx, fp, id) {
  const temp = await mkdtemp(path.join(ctx.home, 'snapshot-'));
  const env = { GIT_INDEX_FILE: path.join(temp, 'index') };
  try {
    await git(ctx, ['read-tree', fp.head], { env });
    await git(ctx, ['add', '-A', '--', '.'], { env });
    const tree = await value(ctx, ['write-tree'], { env });
    // Never publish a snapshot assembled across a local Git/content change.
    if ((await fingerprint(ctx)).key !== fp.key || await gitBusy(ctx)) throw new Error('快照期间本地状态变化，下一轮重试');
    const commit = await value(ctx, ['commit-tree', tree, '-p', fp.head], {
      input: `InfoHub draft ${id.id}\n\nSource: ${id.user}@${id.machine}\n`,
      env: { GIT_AUTHOR_NAME: id.user, GIT_AUTHOR_EMAIL: `${id.id}@infohub.local`, GIT_COMMITTER_NAME: 'InfoHub Sync', GIT_COMMITTER_EMAIL: 'sync@infohub.local' }
    });
    return { tree, commit, base: fp.head };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
export class Client {
  constructor(ctx, settings, id, state) { Object.assign(this, { ctx, settings, id, state }); this.lastKey = null; this.changedAt = Date.now(); this.nextDraft = 0; }
  static async open(root, overrides, signal) {
    const ctx = await context(root, signal);
    const settings = await config(ctx, overrides), id = await identity(ctx);
    const state = await json(path.join(ctx.home, 'state.json'), {});
    return new Client(ctx, settings, id, { ...state, clone: id, startedAt: iso(), pending: {} });
  }
  tick() {
    if (!this.inFlight) this.inFlight = this.runTick().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async network(kind, args) {
    const backoff = this.state.backoff ||= {};
    const prior = backoff[kind];
    if (prior && Date.now() < Date.parse(prior.retryAt)) throw new Error(`${prior.error}；${prior.retryAt} 后重试`);
    try {
      const result = await git(this.ctx, args);
      delete backoff[kind];
      return result;
    } catch (error) {
      if (this.ctx.signal?.aborted) throw error;
      const failures = (prior?.failures || 0) + 1;
      const delay = Math.min(300000, this.settings.fetchSeconds * 1000 * 2 ** Math.min(failures, 20));
      backoff[kind] = { failures, retryAt: new Date(Date.now() + delay).toISOString(), error: error.message };
      throw new Error(`${error.message}；${backoff[kind].retryAt} 后重试`);
    }
  }
  async runTick() {
    const { ctx, state, settings, id } = this;
    const pending = {}; if (state.pushError) pending.push = state.pushError; if (state.validationError) pending.validation = state.validationError; state.pending = pending; state.checkedAt = iso();
    const fail = (name, error) => { if (!ctx.signal?.aborted) pending[name] = error.message || String(error); };
    try {
      const busy = await gitBusy(ctx);
      if (busy) { pending.git = busy.reason; if (busy.inRepo) this.changedAt = Date.now(); return; }
      if (await value(ctx, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true }) !== 'refs/heads/main') {
        pending.git = '当前不在 main，后台暂停'; this.changedAt = Date.now(); return;
      }
      let fetched = false;
      try {
        await this.network('fetch', ['fetch', '--no-write-fetch-head', '--no-tags', '--prune', 'origin', `+refs/heads/*:${REMOTE_PREFIX}*`]);
        state.lastFetch = iso(); fetched = true;
        const report = await git(ctx, ['show', `${REMOTE_PREFIX}infohub-status:status.json`], { allowFailure: true });
        state.server = report.code === 0 ? JSON.parse(report.stdout) : null;
        if (!state.server) pending.server = '服务器草稿状态尚未发布';
        else if (Date.now() - Date.parse(state.server.checkedAt) > 120000) pending.server = '服务器草稿状态超过 2 分钟未更新';
      } catch (e) { fail('fetch', e); }
      let fp = await fingerprint(ctx);
      const remote = `${REMOTE_PREFIX}main`;
      if (fetched) {
        if (!await isAncestor(ctx, fp.head, remote)) pending.pull = '本地有未推送提交或已分叉，本轮不快进';
        else if (await value(ctx, ['rev-parse', remote]) !== fp.head) {
          // Explicit overlap check also covers staged edits equal to the incoming blob.
          const paths = (await git(ctx, ['diff', '--name-only', '-z', fp.head, remote])).stdout.split('\0').filter(Boolean);
          const overlap = fp.files.filter(a => paths.some(b => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
          if (overlap.length) { pending.pull = `远端改动碰到本地脏文件: ${overlap.join(', ')}`; state.blockedFiles = overlap; }
          else {
            const busy = await gitBusy(ctx);
            if (busy) { pending.pull = busy.reason; if (busy.inRepo) this.changedAt = Date.now(); }
            else try {
              // Disable autostash even when the user's global config enables it.
              await git(ctx, ['-c', 'merge.autostash=false', 'merge', '--ff-only', '--no-edit', remote]);
              state.lastPull = iso(); state.blockedFiles = [];
              fp = await fingerprint(ctx);
            } catch (e) { fail('pull', e); }
          }
        } else state.blockedFiles = [];
      }
      if (fp.key !== this.lastKey) { this.lastKey = fp.key; this.changedAt = Date.now(); }
      state.idleSince = new Date(this.changedAt).toISOString(); state.dirtyFiles = fp.files;
      const remoteHead = await value(ctx, ['rev-parse', '--verify', remote], { allowFailure: true });
      const ahead = remoteHead && !await isAncestor(ctx, fp.head, remoteHead);
      if (!fp.dirty && remoteHead && !ahead) {
        delete state.pushError; delete state.rejectedHead; delete pending.push;
        delete state.validationError; delete pending.validation;
        // Only the owning clone knows that its formerly unpublished state has
        // been resolved. Content comparison alone cannot recognize superseded drafts.
        const draft = state.draft, ref = `${DRAFT_PREFIX}${id.id}`;
        if (fetched && remoteHead && draft?.ref === ref) {
          try {
            const uploaded = await value(ctx, ['rev-parse', '--verify', `${REMOTE_PREFIX}infohub-drafts/${id.id}`], { allowFailure: true });
            if (uploaded && uploaded !== draft.commit) throw new Error(`远端草稿已更新，保留新上传: ${uploaded}`);
            if (uploaded) {
              if (await gitBusy(ctx) || (await fingerprint(ctx)).key !== fp.key) throw new Error('清理前本地状态变化，保留草稿');
              await this.network('push', ['push', `--force-with-lease=${ref}:${draft.commit}`, 'origin', `:${ref}`]);
            }
            state.lastDraftCleanup = iso();
            state.cleanedDraft = { ref, commit: draft.commit, reason: uploaded ? '本副本干净且提交已发布' : '远端引用已不存在' };
            delete state.draft;
          } catch (e) { fail('cleanup', e); }
        }
        return;
      }
      if (await gitBusy(ctx)) { pending.git = 'Git 状态已变化，下一轮重试'; return; }
      const idle = Date.now() - this.changedAt >= settings.idleSeconds * 1000;
      let backedUp = false;
      if (fetched && (Date.now() >= this.nextDraft || idle)) {
        try {
          const retry = state.backoff?.push;
          if (retry && Date.now() < Date.parse(retry.retryAt)) throw new Error(`${retry.error}；${retry.retryAt} 后重试`);
          const draft = await snapshot(ctx, fp, id);
          if (state.draft?.base === draft.base && state.draft?.tree === draft.tree) draft.commit = state.draft.commit;
          const ref = `${DRAFT_PREFIX}${id.id}`;
          // A normal clone owns exactly one UUID ref. Never force main.
          await this.network('push', ['push', 'origin', `+${draft.commit}:${ref}`]);
          state.lastDraft = iso(); state.draft = { ...draft, ref }; backedUp = true;
          this.nextDraft = Date.now() + settings.draftSeconds * 1000;
        } catch (e) { fail('draft', e); }
      }
      if (backedUp && (idle || state.validationError)) {
        try {
          await validateCommit(ctx, remoteHead, state.draft.commit, ctx.home);
          delete state.validationError; delete pending.validation;
        } catch (e) {
          if (ctx.signal?.aborted) throw e;
          state.validationError = `提交前校验未通过，未自动提交，草稿已保留：${e.message}`;
          pending.validation = state.validationError; return;
        }
      }
      if (!idle) return;
      if (!fetched || !backedUp) { pending.push = '尚未取得本轮远端状态或草稿备份，暂不自动提交'; return; }
      if (!await isAncestor(ctx, remoteHead, fp.head)) { pending.push = '本地尚未包含远端 main，草稿已保留，需 Agent 合并'; return; }
      try {
        if (await gitBusy(ctx) || (await fingerprint(ctx)).key !== fp.key) throw new Error('自动提交前本地状态变化，下一轮重试');
        if (fp.dirty) {
          // Use ordinary Git commands so Git owns index/HEAD transactions and hooks.
          // A crash between add and commit leaves ordinary staged changes, never a rewritten HEAD/index pair.
          await git(ctx, ['add', '-A', '--', '.']);
          const staged = await fingerprint(ctx);
          if (staged.head !== fp.head || await gitBusy(ctx)) throw new Error('暂存后 Git 状态变化，保留暂存与草稿');
          // Match the backed-up tree; fresh editor changes remain pending for the next idle interval.
          if (await value(ctx, ['write-tree']) !== state.draft.tree) throw new Error('暂存内容与草稿不同，保留现场，重新观察闲置');
          await git(ctx, ['commit', '-m', `InfoHub 自动提交：${id.user}@${id.machine}\n\nClone: ${id.id}`]);
          state.lastCommit = iso();
        }
        const head = await value(ctx, ['rev-parse', 'HEAD']);
        if (await gitBusy(ctx)) throw new Error('推送前有 Git 操作，下一轮重试');
        await this.network('push', ['push', 'origin', `${head}:refs/heads/main`]);
        state.lastPush = iso(); delete pending.pull; delete pending.push; delete state.pushError; delete state.rejectedHead;
      } catch (e) { if (ctx.signal?.aborted) throw e; fail('push', e); state.pushError = e.message; const rejected = await value(ctx, ['rev-parse', 'HEAD']); if (rejected !== remoteHead) state.rejectedHead = rejected; }
    } catch (e) { fail('local', e); }
    finally {
      state.finishedAt = iso();
      await save(path.join(ctx.home, 'state.json'), state);
      const summary = JSON.stringify(state.pending);
      if (summary !== this.lastSummary) console.log(`${iso()} ${summary}`);
      this.lastSummary = summary;
    }
  }
}
