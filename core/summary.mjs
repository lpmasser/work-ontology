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

// 一个负责会话一份：它派出去的会话是按它数的，管着几件工作也只发一份（2026-11-23 面板化线管三件，同一件事收了三份）。
// works 记每件工作现在归谁、前任是谁（前任派出去的会话仍算）、新订上的有没有告诉过；owners 记每个负责会话上次看的时间和内容。
export function plan(subscribed, state = {}, now = new Date()) {
  const works = { ...(state.works ?? {}) };
  for (const work of subscribed) {
    const entry = works[work.id];
    if (!entry || entry.owner !== work.owner) {
      const previous = entry ? [...new Set([...(entry.previous ?? []), entry.owner])].filter(owner => owner !== work.owner) : [];
      works[work.id] = { owner: work.owner, previous, welcomed: false };
    }
  }
  const owners = { ...(state.owners ?? {}) };
  const groups = new Map();
  for (const work of subscribed) {
    if (!groups.has(work.owner)) groups.set(work.owner, []);
    groups.get(work.owner).push(work);
  }
  const due = [];
  for (const [owner, list] of groups) {
    const fresh = list.filter(work => !works[work.id].welcomed);
    const last = owners[owner]?.checkedAt;
    if (fresh.length || !last || now.getTime() - Date.parse(last) >= SUMMARY_INTERVAL_MS) {
      const previous = [...new Set(list.flatMap(work => works[work.id].previous))].filter(item => item !== owner);
      due.push({ owner, works: list, fresh, previous, since: last ?? null });
    }
  }
  return { works, owners, due };
}

// 只报工作这一级的事实：几个在跑、哪些在跑却没人挂 watch 等着、上次之后哪些没做完就停了。
// 不带各会话的结论，细节由负责会话自己去看。
export function digest(children, watchedIds, since) {
  const running = children.filter(child => child.status === 'running');
  const unwatched = running.filter(child => !watchedIds.has(child.threadId));
  const stopped = children.filter(child => STOPPED_UNFINISHED.includes(child.status)
    && since && Date.parse(child.updatedAt ?? '') > Date.parse(since));
  return {
    running: running.length,
    unwatched: unwatched.map(({ threadId: id, title }) => ({ id, title })),
    stopped: stopped.map(({ threadId: id, title, status }) => ({ id, title, status })),
  };
}

// 只有要它处理的变化才算变化：进度变了、出现没人等的在跑会话、有会话没做完就停了。
// 在跑的个数涨落不算，否则会给只在待命的线发“0 个在跑”。
export function fingerprint(works, facts) {
  return JSON.stringify([works.map(work => [work.id, work.progress]).sort(), facts.unwatched.map(item => item.id).sort(), facts.stopped.map(item => item.id).sort()]);
}

export function worthSending(facts) {
  return facts.unwatched.length > 0 || facts.stopped.length > 0;
}

const listed = items => items.map(item => `〔${item.title || item.id}〕${threadLink(item.id)}${item.status ? `（${item.status}）` : ''}`).join('、');
const named = works => works.map(work => `${work.title} \`${work.id}\`（进度：${work.progress ?? '未填'}）`).join('；');

export function summaryText(owner, works, facts, { fresh = [] } = {}) {
  const lines = [`〔工作汇总〕你负责的：${named(works)}`];
  if (fresh.length) lines.push(`新订上的：${fresh.map(work => `\`${work.id}\``).join('、')}。这份汇总每 15 分钟看一次，只在有要你处理的事时才发。`);
  lines.push(`你派出的会话：${facts.running} 个在跑。`);
  if (facts.unwatched.length) {
    lines.push(`在跑却没人挂 watch 等着的：${listed(facts.unwatched)}。要它的结果就挂 \`thread watch <它> --notify <你>\`。`);
  }
  if (facts.stopped.length) lines.push(`上次之后没做完就停了的：${listed(facts.stopped)}。`);
  lines.push(`细节自己看：\`"$CODEXHOST_CLI_PATH" thread list --parent ${owner}\`。`);
  lines.push(`哪件工作暂停了、在等别人、或已不由你推进，就退订它：\`infohub unsubscribe <工作 ID>\`；恢复推进时 \`infohub subscribe <工作 ID>\`。`);
  return lines.join('\n');
}
