import { listThreads, readMessages, listWatches } from './codexhost.mjs';
import { currentOwners, threadId } from '../core/activity.mjs';

/**
 * 要展开的会话：负责会话、出过可归属轮次的执行者会话（这两类永远展开），
 * 以及列表里更新时间变了的会话（新派出的会话只在这里出现）。
 * 首次接入只展开负责会话、仍在运行的轮和挂着的 watch，不翻整机历史。
 * cache 是本进程内存里的上一份快照，没变的会话不重复读。
 */
export async function observeActivity(cli, { index, state, cache }) {
  const listed = await listThreads(cli, state.observedAt);
  const positions = state.threads ?? {};
  const owners = new Set(currentOwners(index).map(work => threadId(work.owner)));
  const attributed = new Set(Object.keys(state.turns ?? {}).map(key => key.split('#')[0]));
  const watches = await listWatches(cli);
  const watched = new Set(watches.map(watch => watch.threadId));
  const first = !state.threads;

  const next = { ...positions };
  const candidates = new Map();
  for (const entry of listed) {
    next[entry.threadId] = { updatedAt: entry.updatedAt, seenThrough: positions[entry.threadId]?.seenThrough ?? 0 };
    const relevant = owners.has(entry.threadId) || attributed.has(entry.threadId);
    const expand = first
      ? relevant || entry.status === 'running' || watched.has(entry.threadId)
      : relevant || positions[entry.threadId]?.updatedAt !== entry.updatedAt;
    if (expand) candidates.set(entry.threadId, entry);
  }
  // 负责会话不在本次翻页结果里时，它的更新时间没变，仍要展开。
  for (const id of [...owners, ...attributed]) {
    if (!candidates.has(id)) candidates.set(id, { threadId: id, updatedAt: positions[id]?.updatedAt ?? null });
  }

  const threads = [], errors = {};
  for (const entry of candidates.values()) {
    const seen = positions[entry.threadId];
    // 没变的会话直接用上一次的观察。
    const cached = cache?.get(entry.threadId);
    if (cached && entry.updatedAt && cached.updatedAt === entry.updatedAt) {
      threads.push(cached);
      continue;
    }
    let snapshot;
    try {
      snapshot = await readMessages(cli, entry.threadId, seen?.seenThrough || undefined);
    } catch (error) {
      // Host 读不到这个会话时只标记它，其余会话照常判断，错误在活动状态里如实暴露。
      errors[entry.threadId] = error.message.split('\n')[0];
      continue;
    }
    const seenThrough = snapshot.turns.reduce((max, turn) => Math.max(max, turn.turnNumber), seen?.seenThrough ?? 0);
    next[entry.threadId] = { updatedAt: entry.updatedAt ?? seen?.updatedAt ?? null, seenThrough };
    // thread read 不带更新时间，终态变化的时间要取自列表。
    const observed = { ...snapshot, updatedAt: entry.updatedAt ?? null };
    cache?.set(entry.threadId, observed);
    threads.push(observed);
  }
  for (const id of cache?.keys() ?? []) if (!owners.has(id) && !attributed.has(id)) cache.delete(id);
  return { threads, errors, watches, positions: next };
}
