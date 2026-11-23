import { isUnfinishedWork } from './engine.js';

export const SUMMARY_INTERVAL_MS = 15 * 60_000;
export const threadLink = id => `codex://threads/${id}`;
export const threadId = link => link.slice('codex://threads/'.length);
const isArchived = file => file.split(/[\\/]/).includes('archive');
const STOPPED_UNFINISHED = ['interrupted', 'failed'];

// 订阅者就是进行中、没归档的工作对象当前的负责会话：默认订上，它退订了就不发。
// 退订记的是退订时的负责会话，换了负责会话就自动给新人订上。
export function subscriptions(index, optOut = {}) {
  return [...index.objects.values()]
    .filter(object => isUnfinishedWork(object) && !isArchived(object.path) && object.frontmatter.owner_thread)
    .map(object => ({ id: object.id, title: object.title, progress: object.frontmatter.progress ?? null, owner: object.frontmatter.owner_thread }))
    .filter(work => optOut[work.id] !== work.owner);
}

// 哪些工作该看一眼了：新订上的（含换了负责会话的）马上看，其余每 15 分钟看一次。
// 前任派出去的会话仍算这件工作的，换人后一并列出。
export function plan(works, entries = {}, now = new Date()) {
  const next = { ...entries };
  const due = [];
  for (const work of works) {
    let entry = next[work.id];
    if (!entry || entry.owner !== work.owner) {
      const previous = entry ? [...new Set([...(entry.previous ?? []), entry.owner])].filter(owner => owner !== work.owner) : [];
      entry = next[work.id] = { owner: work.owner, previous, checkedAt: null, fingerprint: null };
    }
    if (!entry.checkedAt || now.getTime() - Date.parse(entry.checkedAt) >= SUMMARY_INTERVAL_MS) {
      due.push({ work, entry, first: !entry.checkedAt });
    }
  }
  return { entries: next, due };
}

// 只报工作对象这一级的事实：几个在跑、哪些在跑却没人挂 watch 等着、上次之后哪些没做完就停了。
// 不带各会话的结论，细节由负责会话自己去看。
export function digest(children, watchedIds, since) {
  const running = children.filter(child => child.status === 'running');
  const unwatched = running.filter(child => !watchedIds.has(child.threadId));
  const stopped = children.filter(child => STOPPED_UNFINISHED.includes(child.status)
    && since && Date.parse(child.updatedAt ?? '') > Date.parse(since));
  return {
    running: running.map(child => child.threadId).sort(),
    unwatched: unwatched.map(({ threadId: id, title }) => ({ id, title })),
    stopped: stopped.map(({ threadId: id, title, status }) => ({ id, title, status })),
  };
}

export function fingerprint(work, facts) {
  return JSON.stringify([work.progress, facts.running, facts.unwatched.map(item => item.id), facts.stopped.map(item => item.id)]);
}

const listed = items => items.map(item => `〔${item.title || item.id}〕${threadLink(item.id)}${item.status ? `（${item.status}）` : ''}`).join('、');

export function summaryText(work, facts, { first = false } = {}) {
  const lines = [
    `〔工作汇总〕${work.title} \`${work.id}\`（进度：${work.progress ?? '未填'}）`,
    ...(first ? ['你是这件工作的负责会话，已自动订阅这份汇总：每 15 分钟看一次，有变化才发。'] : []),
    `你派出的会话：${facts.running.length} 个在跑。`,
  ];
  if (facts.unwatched.length) {
    lines.push(`在跑却没人挂 watch 等着的：${listed(facts.unwatched)}。要它的结果就挂 \`thread watch <它> --notify <你>\`。`);
  }
  if (facts.stopped.length) lines.push(`上次之后没做完就停了的：${listed(facts.stopped)}。`);
  lines.push(`细节自己看：\`"$CODEXHOST_CLI_PATH" thread list --parent ${work.owner}\`。`);
  lines.push(`工作暂停或不想再收：\`infohub unsubscribe ${work.id}\`；恢复：\`infohub subscribe ${work.id}\`。`);
  return lines.join('\n');
}
