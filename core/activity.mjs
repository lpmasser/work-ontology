import { isUnfinishedWork } from './engine.js';

export const OWNER_THREAD_PATTERN = /^codex:\/\/threads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DELIVERY_GRACE_MS = 5 * 60_000;
export const SUMMARY_INTERVAL_MS = 15 * 60_000;
const STOPPED = ['completed', 'failed', 'interrupted'];
const WATCH_HEADER = '[codexhost thread watch]';
const STREAK_WINDOW = 5;
const STREAK_INTERRUPTED = 4;

export const threadLink = id => `codex://threads/${id}`;
export const threadId = link => link.slice('codex://threads/'.length);

function isArchived(path) {
  return path.split('/').includes('archive');
}

const maxTurn = thread => thread ? thread.turns.reduce((max, turn) => Math.max(max, turn.turnNumber), 0) : 0;

// 可派活的现任：未收口、不在归档目录段、有负责会话。
export function currentOwners(index) {
  return [...index.objects.values()]
    .filter(object => isUnfinishedWork(object) && !isArchived(object.path) && object.frontmatter.owner_thread)
    .map(object => ({ id: object.id, title: object.title, owner: object.frontmatter.owner_thread, path: object.path }));
}

export function describeWork(index, id) {
  const object = index.objects.get(id);
  if (!object) throw new Error(`找不到工作对象：${id}`);
  return {
    id, title: object.title, owner: object.frontmatter.owner_thread ?? null,
    archived: isArchived(object.path), unfinished: isUnfinishedWork(object)
  };
}

// 接手人：原生 watch 已指定收件人就采用；否则按「交给」，都没有就回派活人。
function recipientOf(index, initiator, watch) {
  if (watch?.notifyThreadId) return { recipient: threadLink(watch.notifyThreadId) };
  if (!initiator.handover) return { recipient: initiator.sender };
  if (OWNER_THREAD_PATTERN.test(initiator.handover)) return { recipient: initiator.handover };
  const target = describeWork(index, initiator.handover);
  const blocking = target.archived || !target.unfinished ? `交给 的 ${target.id} 已归档或已终结，按角色不唤醒原负责会话`
    : !target.owner ? `交给 的 ${target.id} 没有负责会话` : null;
  return { recipient: target.owner, blocking };
}

// 只认发起这一轮的输入：正文引用、后续插话和创建父级都不改变归属。
export function readInitiator(turn) {
  const input = turn.messages.find(message => message.role === 'user')?.text ?? '';
  if (input.startsWith(WATCH_HEADER)) return { kind: 'watch' };
  const lines = input.split('\n');
  const sender = lines.filter(line => line.startsWith('Sender: ')).at(-1)?.slice('Sender: '.length).trim();
  if (!sender || !OWNER_THREAD_PATTERN.test(sender)) return { kind: 'unknown' };
  const handover = lines.find(line => line.startsWith('交给：'))?.slice('交给：'.length).trim();
  return { kind: 'task', sender, noReply: lines.includes('不用回'), handover: handover || null };
}

function conclusionOf(turn) {
  return turn.messages.filter(message => message.role === 'agent').at(-1)?.text?.trim() ?? null;
}

function questionText(pending) {
  const fields = pending.request?.questions ?? pending.request?.params?.questions ?? [];
  return fields.map(field => field.question ?? field.prompt).filter(Boolean).join('；') || pending.interactionId;
}

// 看到终态变化且能对应列表更新时间时用该时间，否则从首次观察到终态起算。
function terminalAt(thread, isLatest, now) {
  return isLatest && thread.status !== 'running' && thread.updatedAt ? thread.updatedAt : now.toISOString();
}

function pickedUpBy(thread, executorId, floor) {
  if (!thread) return false;
  return thread.turns.some(turn => turn.turnNumber > floor && (() => {
    const initiator = readInitiator(turn);
    if (initiator.kind === 'task') return initiator.sender === threadLink(executorId);
    return initiator.kind === 'watch' && (turn.messages[0]?.text ?? '').includes(`thread://${executorId}`);
  })());
}

/**
 * 后台循环与只读查询共用这一份判断：哪一轮出了什么事、现在该谁动、依据是什么。
 * 状态只带上一次的观察位置、未结例外、已提醒收件人和各负责会话的汇总截止位置。
 */
export function judgeActivity(index, { threads, watches = [], now = new Date(), state = {} }) {
  const nowMs = now.getTime();
  const works = currentOwners(index);
  const workByOwner = new Map(works.map(work => [work.owner, work]));
  const threadById = new Map(threads.map(thread => [thread.threadId, thread]));
  const watchByTurn = new Map(watches.filter(watch => watch.turnId).map(watch => [watch.turnId, watch]));
  const observed = structuredClone(state.turns ?? {});
  const streaks = { ...(state.streaks ?? {}) };
  const reminded = [...(state.reminded ?? [])];
  const cursor = structuredClone(state.summary ?? {});
  const exceptions = [], rounds = [], conclusions = [];

  for (const thread of threads) {
    const ordered = [...thread.turns].sort((a, b) => a.turnNumber - b.turnNumber);
    const attributed = [];
    for (const turn of ordered) {
      const initiator = readInitiator(turn);
      if (initiator.kind !== 'task' || initiator.noReply) continue;
      const work = workByOwner.get(initiator.sender);
      if (!work) continue;
      const key = `${thread.threadId}#${turn.turnNumber}`;
      const record = observed[key] ??= { workId: work.id, dispatcher: initiator.sender, floor: null, terminalAt: null, pickedUp: false };
      const base = { workId: work.id, executor: { id: thread.threadId, title: thread.title }, turnNumber: turn.turnNumber, link: threadLink(thread.threadId), dispatcher: initiator.sender };
      // 这一轮派出去之后负责会话换了工作：不唤醒旧人，清单写明阻塞。
      if (record.workId !== work.id) {
        exceptions.push({ key: `changed:${key}`, kind: 'changed', ...base, workId: record.workId, recipient: null, since: now.toISOString(), blocking: `这一轮的负责会话已换任（现归 ${work.id}），不再唤醒原负责会话` });
        continue;
      }
      const { recipient, blocking } = recipientOf(index, initiator, watchByTurn.get(turn.turnId));
      attributed.push({ turn, work, recipient, key, record, blocking });

      if (!STOPPED.includes(turn.status)) {
        rounds.push({ ...base, status: turn.status, progress: turn.messages.filter(message => message.role === 'agent').at(-1)?.text?.trim() ?? null });
        continue;
      }
      const isLatest = turn === ordered.at(-1);
      if (record.terminalAt === null) {
        record.floor = maxTurn(threadById.get(threadId(recipient)));
        record.terminalAt = terminalAt(thread, isLatest, now);
      }
      const conclusion = conclusionOf(turn);
      cursor[work.owner] ??= {};
      if (conclusion) {
        conclusions.push({ ...base, text: conclusion, isNew: turn.turnNumber > (cursor[work.owner][thread.threadId] ?? 0) });
        cursor[work.owner][thread.threadId] = Math.max(cursor[work.owner][thread.threadId] ?? 0, turn.turnNumber);
      }
      if (turn.status !== 'completed') {
        if (!ordered.some(later => later.turnNumber > turn.turnNumber)) {
          exceptions.push({
            key: `failure:${key}`, kind: 'failure', ...base, recipient, blocking, since: record.terminalAt,
            detail: `第 ${turn.turnNumber} 轮 ${turn.status}${conclusion ? `：${conclusion}` : ''}`
          });
        }
        continue;
      }
      if (!record.pickedUp) record.pickedUp = pickedUpBy(threadById.get(threadId(recipient)), thread.threadId, record.floor);
      if (record.pickedUp) continue;
      const delivery = { workId: work.id, executor: base.executor, turnNumber: turn.turnNumber, link: base.link, recipient, blocking, dispatcher: initiator.sender, since: record.terminalAt };
      if (nowMs - Date.parse(record.terminalAt) >= DELIVERY_GRACE_MS) {
        exceptions.push({ key: `deliver:${key}`, kind: 'deliver', ...delivery, detail: `第 ${turn.turnNumber} 轮交付后五分钟未接` });
      }
      const sent = reminded.find(entry => entry.key === `deliver:${key}` && entry.recipient === recipient);
      if (sent && nowMs - Date.parse(sent.at) >= DELIVERY_GRACE_MS) {
        // 接手人先动，派活人只接升级：升级只找派这一轮活的会话一次。
        exceptions.push({
          key: `escalate:${key}`, kind: 'escalate', ...delivery, primary: recipient, recipient: initiator.sender,
          detail: `第 ${turn.turnNumber} 轮交付后，接手人 ${recipient} 在提醒后五分钟仍未动`
        });
      }
    }

    for (const pending of thread.pendingQuestions) {
      const current = attributed.find(entry => entry.turn.turnId === pending.turnId) ?? attributed.at(-1);
      if (!current) continue;
      exceptions.push({
        key: `question:${current.key}:${pending.interactionId}`, kind: 'question', workId: current.work.id,
        executor: { id: thread.threadId, title: thread.title }, turnNumber: current.turn.turnNumber,
        link: threadLink(thread.threadId), recipient: current.recipient, blocking: current.blocking,
        dispatcher: current.record.dispatcher, since: now.toISOString(),
        interactionId: pending.interactionId, detail: questionText(pending)
      });
    }

    const visible = ordered.slice(-STREAK_WINDOW);
    const interrupted = visible.filter(turn => turn.status === 'interrupted');
    const latest = attributed.filter(entry => visible.includes(entry.turn)).at(-1);
    if (interrupted.length < STREAK_INTERRUPTED) delete streaks[thread.threadId];
    else if (latest && streaks[thread.threadId] !== interrupted[0].turnNumber) {
      streaks[thread.threadId] = interrupted[0].turnNumber;
      exceptions.push({
        key: `streak:${thread.threadId}#${interrupted[0].turnNumber}`, kind: 'streak', workId: latest.work.id,
        executor: { id: thread.threadId, title: thread.title }, turnNumber: interrupted[0].turnNumber,
        link: threadLink(thread.threadId), recipient: latest.record.dispatcher, dispatcher: latest.record.dispatcher,
        since: now.toISOString(), detail: `最近 ${visible.length} 个可见轮次有 ${interrupted.length} 轮中断：${interrupted.map(turn => `#${turn.turnNumber}`).join('、')}`
      });
    }
  }

  // 接手人本人、停在提问框、已换任或不在范围内时，清单直接写清阻塞。
  for (const exception of exceptions) {
    exception.reminded = reminded.find(entry => entry.key === exception.key && entry.recipient === exception.recipient)?.at ?? null;
    if (exception.kind !== 'escalate') continue;
    const dispatcher = threadById.get(threadId(exception.dispatcher));
    if (exception.primary === exception.dispatcher) exception.blocking = '派活人就是接手人，未指定其他接手人';
    else if (dispatcher?.pendingQuestions.length) exception.blocking = '派活人停在提问框，不能插话';
  }

  const unfinished = Object.values(observed).filter(record => record.terminalAt && !record.pickedUp);
  return {
    observedAt: now.toISOString(),
    works: works.map(work => ({ ...work, from: state.summaryAt?.[work.owner] ?? state.observedAt ?? null })),
    rounds, conclusions, exceptions,
    settled: !rounds.length && !exceptions.length && !unfinished.length,
    cursor, summaryAt: now.toISOString(),
    state: { observedAt: now.toISOString(), turns: observed, streaks, reminded, summary: state.summary ?? {}, summaryAt: state.summaryAt ?? {} }
  };
}

export function situationLine(exception) {
  const who = `${exception.executor.title} #${exception.turnNumber}`;
  if (exception.blocking) return `阻塞 ${who}：${exception.detail}；${exception.blocking}`;
  return `${who} → ${exception.recipient}，${exception.detail}${exception.reminded ? `；已提醒 ${exception.recipient}` : ''}`;
}

function windowText(from, to) {
  return `${from ? from.slice(11, 16) : '未观察'}–${to.slice(11, 16)}（观察 ${to}）`;
}

const excerpt = (text, size = 160) => text.length > size ? `${text.slice(0, size)}…` : text;

export function formatActivity(result, work, { title, archived, from }) {
  const lines = [`${title} · ${windowText(from, result.observedAt)}`];
  if (archived) lines.push('已归档');
  lines.push('待处理');
  const open = result.exceptions.filter(exception => exception.workId === work);
  if (open.length) for (const exception of open) lines.push(`  ${situationLine(exception)}`);
  else lines.push('  无');
  lines.push('当前轮');
  const current = result.rounds.filter(round => round.workId === work);
  if (current.length) for (const round of current) lines.push(`  ${round.executor.title} #${round.turnNumber} 正在${round.progress ? `处理：${excerpt(round.progress)}` : '运行'}〔${round.link}〕`);
  else lines.push('  无');
  lines.push('新增结论');
  const fresh = result.conclusions.filter(conclusion => conclusion.workId === work && conclusion.isNew);
  if (fresh.length) for (const conclusion of fresh) lines.push(`  ${conclusion.executor.title} #${conclusion.turnNumber}〔执行者报告〕“${excerpt(conclusion.text)}”〔${conclusion.link}，第 ${conclusion.turnNumber} 轮〕`);
  else lines.push('  无');
  return lines.join('\n');
}

export function formatExceptions(result) {
  const window = windowText(result.works[0]?.from, result.observedAt);
  if (!result.exceptions.length) return `未结例外 · ${window}\n无`;
  return [`未结例外 · ${window}`, ...result.exceptions.map(exception => `  ${situationLine(exception)}`)].join('\n');
}

export function formatErrors(errors) {
  const entries = Object.entries(errors ?? {});
  if (!entries.length) return null;
  return ['读取失败', ...entries.map(([id, message]) => `  ${id}：${message}`)].join('\n');
}
