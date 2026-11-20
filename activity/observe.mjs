import { listThreads, readMessages, listWatches } from './codexhost.mjs';
import { currentOwners, threadId } from '../core/activity.mjs';

/**
 * 要展开的会话：负责会话、出过可归属轮次的执行者会话，以及上次观察后更新过的会话
 * （新派出的会话只在那里出现）。其余会话只更新观察位置，不重复读取。
 */
export async function observeActivity(cli, { index, state }) {
  const listed = await listThreads(cli);
  const positions = state.threads ?? {};
  const owners = new Set(currentOwners(index).map(work => threadId(work.owner)));
  const attributed = new Set(Object.keys(state.turns ?? {}).map(key => key.split('#')[0]));
  const watches = await listWatches(cli);
  // 首次接入只展开负责会话、仍在运行的轮和挂着的 watch（未接住的交件），不翻整机历史。
  const first = !state.threads;
  const watched = new Set(watches.map(watch => watch.threadId));
  const threads = [];
  const errors = {};
  const next = {};
  for (const entry of listed) {
    const seen = positions[entry.threadId];
    next[entry.threadId] = { updatedAt: entry.updatedAt, seenThrough: seen?.seenThrough ?? 0 };
    const firstRound = entry.status === 'running' || watched.has(entry.threadId);
    if (!owners.has(entry.threadId) && !attributed.has(entry.threadId)
      && (first ? !firstRound : seen?.updatedAt === entry.updatedAt)) continue;
    let snapshot;
    try {
      snapshot = await readMessages(cli, entry.threadId, seen?.seenThrough || undefined);
    } catch (error) {
      // Host 读不到这个会话时只标记它，其余会话照常判断，错误在活动状态里如实暴露。
      errors[entry.threadId] = error.message.split('\n')[0];
      continue;
    }
    const seenThrough = snapshot.turns.reduce((max, turn) => Math.max(max, turn.turnNumber), seen?.seenThrough ?? 0);
    next[entry.threadId] = { updatedAt: entry.updatedAt, seenThrough };
    // thread read 不带更新时间，终态变化的时间要取自列表。
    threads.push({ ...snapshot, updatedAt: entry.updatedAt });
  }
  return { threads, errors, watches, positions: next };
}
