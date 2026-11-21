import { isUnfinishedWork, OWNER_THREAD_PATTERN } from './engine.js';

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

// 接手人只要在交件后有过一轮提到执行者会话、并且那一轮已经结束，就算接住了：
// 执行者直接发来的任务、watch 通知、我们的提醒、别人转来的消息都算。
function pickedUpBy(thread, executorId, floor) {
  if (!thread) return false;
  const mentioned = [threadLink(executorId), `thread://${executorId}`];
  return thread.turns.some(turn => turn.turnNumber > floor
    && STOPPED.includes(turn.status)
    && mentioned.some(link => (turn.messages.find(message => message.role === 'user')?.text ?? '').includes(link)));
}

// 接手人这一轮还在跑：提醒会撞上忙、按设计不打断它，等它结束再提醒。
function busyRound(thread) {
  if (!thread || thread.status !== 'running') return null;
  const ongoing = thread.turns.filter(turn => !STOPPED.includes(turn.status));
  return ongoing.length ? Math.max(...ongoing.map(turn => turn.turnNumber)) : maxTurn(thread) || null;
}

function workOf(index, id) {
  const object = index.objects.get(id);
  return object ? {
    id, title: object.title, owner: object.frontmatter.owner_thread ?? null,
    archived: isArchived(object.path), unfinished: isUnfinishedWork(object)
  } : null;
}

/**
 * 后台循环与只读查询共用这一份判断：哪一轮出了什么事、现在该谁动、依据是什么。
 * 状态只带上一次的观察位置、未结例外、已提醒收件人和各负责会话的汇总截止位置。
 */
export function judgeActivity(index, { threads, watches = [], now = new Date(), state = {} }) {
  // watches 为 null 表示这一轮没取 watch：接手人沿用记录里的，不重新猜。
  const nowMs = now.getTime();
  const works = currentOwners(index);
  const worksByOwner = new Map();
  for (const work of works) {
    if (!worksByOwner.has(work.owner)) worksByOwner.set(work.owner, []);
    worksByOwner.get(work.owner).push(work);
  }
  const threadById = new Map(threads.map(thread => [thread.threadId, thread]));
  const watchByTurn = watches === null ? null : new Map(watches.filter(watch => watch.turnId).map(watch => [watch.turnId, watch]));
  const observed = structuredClone(state.turns ?? {});
  const streaks = { ...(state.streaks ?? {}) };
  const reminded = [...(state.reminded ?? [])];
  const cursor = structuredClone(state.summary ?? {});
  const exceptions = [], rounds = [], conclusions = [];
  const held = new Set();

  for (const thread of threads) {
    const ordered = [...thread.turns].sort((a, b) => a.turnNumber - b.turnNumber);
    const attributed = [];
    const known = state.threads?.[thread.threadId];
    const created = Date.parse(thread.createdAt ?? '');
    for (const turn of ordered) {
      const initiator = readInitiator(turn);
      if (initiator.kind !== 'task' || initiator.noReply) continue;
      const key = `${thread.threadId}#${turn.turnNumber}`;
      const record = observed[key];
      // 只有新轮才建档：仍在运行的轮、上次观察之后新增的轮、上次观察之后新建的会话里的轮。
      // 其余没有记录的是历史，不再当成新交件，也不重新提醒。
      const fresh = !STOPPED.includes(turn.status)
        || (known?.seenThrough !== undefined && turn.turnNumber > known.seenThrough)
        || (Number.isFinite(created) && state.observedAt && created > Date.parse(state.observedAt));
      if (!record && !fresh) continue;
      // 一个会话可能先后或同时负责多项工作：仍在负责的那几项里优先沿用原来那项。
      const owned = worksByOwner.get(initiator.sender) ?? [];
      const target = owned.find(work => work.id === record?.workId) ?? owned[0] ?? (record ? workOf(index, record.workId) : null);
      if (!target) {
        delete observed[key];
        continue;
      }
      const entry = record ?? (observed[key] = { workId: target.id, dispatcher: initiator.sender, floor: null, terminalAt: null, pickedUp: false });
      held.add(key);
      const base = {
        workId: target.id, executor: { id: thread.threadId, title: thread.title },
        turnNumber: turn.turnNumber, link: threadLink(thread.threadId), dispatcher: initiator.sender
      };
      const { recipient: derived, blocking } = recipientOf(index, initiator, watchByTurn?.get(turn.turnId));
      const recipient = watchByTurn || !entry.recipient ? derived : entry.recipient;
      // 定了接手人就记下来：之后不取 watch 的轮沿用同一个人。
      if (watchByTurn && !blocking) entry.recipient = derived;
      attributed.push({ turn, work: target, recipient, key, record: entry, blocking });

      if (blocking) {
        entry.blocked = true;
        exceptions.push({
          key: `blocked:${key}`, kind: 'blocked', ...base, recipient, blocking, since: now.toISOString(),
          detail: `第 ${turn.turnNumber} 轮按「交给」取不到现任`
        });
        continue;
      }
      entry.blocked = false;

      if (!STOPPED.includes(turn.status)) {
        // 运行中的轮要留记录，它结束时才认得出是新交件。
        entry.running = true;
        rounds.push({ ...base, status: turn.status, progress: turn.messages.filter(message => message.role === 'agent').at(-1)?.text?.trim() ?? null });
        continue;
      }
      entry.running = false;
      if (entry.terminalAt === null) {
        // 起点是接手人上一次观察时的位置：执行者一结束就送到的那一轮（例如 watch 通知）
        // 本来就落在上一次观察之后，不能因为本次观察时才看到结束就把它排除。
        const floorOf = link => {
          const seenBefore = state.threads?.[threadId(link)]?.seenThrough;
          return seenBefore !== undefined ? seenBefore : Math.max(maxTurn(threadById.get(threadId(link))) - 1, 0);
        };
        entry.floor = floorOf(recipient);
        // 负责会话和接手人可以不是同一个（交给 D）：各自的轮号各按各的起点算。
        entry.ownerFloor = target.owner ? floorOf(target.owner) : null;
        entry.terminalAt = terminalAt(thread, turn === ordered.at(-1), now);
      }
      const conclusion = conclusionOf(turn);
      // 负责会话已经接住的结论（例如 watch 通知一到就读了）不再算新增，也就不进汇总。
      const ownerPickedUp = target.owner ? pickedUpBy(threadById.get(threadId(target.owner)), thread.threadId, entry.ownerFloor ?? entry.floor) : false;
      if (target.owner) {
        cursor[target.owner] ??= {};
        if (conclusion) {
          conclusions.push({
            ...base, text: conclusion,
            isNew: !ownerPickedUp && turn.turnNumber > (cursor[target.owner][thread.threadId] ?? 0),
            pickedUp: ownerPickedUp
          });
          cursor[target.owner][thread.threadId] = Math.max(cursor[target.owner][thread.threadId] ?? 0, turn.turnNumber);
        }
      }
      if (turn.status !== 'completed') {
        if (!ordered.some(later => later.turnNumber > turn.turnNumber)) {
          exceptions.push({
            key: `failure:${key}`, kind: 'failure', ...base, recipient, since: entry.terminalAt,
            detail: `第 ${turn.turnNumber} 轮 ${turn.status}${conclusion ? `：${conclusion}` : ''}`
          });
        }
        continue;
      }
      if (!entry.pickedUp) entry.pickedUp = pickedUpBy(threadById.get(threadId(recipient)), thread.threadId, entry.floor);
      if (!entry.pickedUp) {
        // 升级之后派活人自己有一轮结束并提到执行者，就按他不再往下转撤项。
        const escalated = reminded.find(item => item.key === `escalate:${key}`);
        if (escalated) entry.pickedUp = pickedUpBy(threadById.get(threadId(escalated.recipient)), thread.threadId, escalated.floor ?? entry.floor);
      }
      if (entry.pickedUp) continue;
      const busy = busyRound(threadById.get(threadId(recipient)));
      const delivery = { ...base, recipient, since: entry.terminalAt, ...(busy ? { busy } : {}) };
      if (busy) {
        exceptions.push({ key: `deliver:${key}`, kind: 'deliver', ...delivery, detail: `接手人在忙（第 ${busy} 轮在跑），等这一轮结束再提醒` });
        continue;
      }
      if (nowMs - Date.parse(entry.terminalAt) >= DELIVERY_GRACE_MS) {
        exceptions.push({ key: `deliver:${key}`, kind: 'deliver', ...delivery, detail: `第 ${turn.turnNumber} 轮交付后五分钟未接` });
      }
      // 接手人忙的时候不升级：等它这一轮结束，再按原来的规则提醒一次。
      const sent = reminded.find(item => item.key === `deliver:${key}` && item.recipient === recipient);
      if (sent && nowMs - Date.parse(sent.at) >= DELIVERY_GRACE_MS) {
        // 接手人先动，派活人只接升级：升级只找派这一轮活的会话一次。
        exceptions.push({
          key: `escalate:${key}`, kind: 'escalate', ...delivery, primary: recipient, recipient: initiator.sender,
          detail: `第 ${turn.turnNumber} 轮交付后，接手人 ${recipient} 在提醒后五分钟仍未动`
        });
      }
    }

    for (const pending of thread.pendingQuestions) {
      const current = attributed.find(item => item.turn.turnId === pending.turnId) ?? attributed.at(-1);
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
    const latest = attributed.filter(item => visible.includes(item.turn)).at(-1);
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

  // 有阻塞的项只进清单写明阻塞：不走接件判断，也不拖住循环。
  // 升级也接不了时，同一件事不再重复挂在「交付未接」上。
  const givenUp = new Set();
  for (const exception of exceptions) {
    exception.reminded = reminded.find(item => item.key === exception.key && item.recipient === exception.recipient)?.at ?? null;
    if (exception.kind !== 'escalate') continue;
    const dispatcher = threadById.get(threadId(exception.dispatcher));
    const target = workOf(index, exception.workId);
    if (exception.primary === exception.dispatcher) exception.blocking = '派活人就是接手人，未指定其他接手人';
    else if (dispatcher?.pendingQuestions.length) exception.blocking = '派活人停在提问框，不能插话';
    else if (!target || target.archived) exception.blocking = '派活的工作已归档或不在库里，不唤醒原负责会话';
    else if (target.owner !== exception.dispatcher) exception.blocking = `派活人已换任（现为 ${target.owner ?? '无'}）`;
    if (exception.blocking) givenUp.add(exception.key.slice('escalate:'.length));
  }
  for (const key of givenUp) if (observed[key]) observed[key].blocked = true;
  const open = exceptions.filter(exception => !(exception.kind === 'deliver' && givenUp.has(exception.key.slice('deliver:'.length))));

  const openKeys = new Set(open.map(exception => exception.key));
  for (const [key, record] of Object.entries(observed)) {
    const open = held.has(key) && (record.running || openKeys.has(key) || [...openKeys].some(entry => entry.endsWith(`:${key}`)) || (record.terminalAt && !record.pickedUp && !record.blocked));
    if (!open) delete observed[key];
  }
  const kept = reminded.filter(item => openKeys.has(item.key));
  const waiting = Object.values(observed).some(record => record.terminalAt && !record.pickedUp && !record.blocked);

  return {
    observedAt: now.toISOString(),
    works: works.map(work => ({ ...work, from: state.summaryAt?.[work.owner] ?? state.observedAt ?? null })),
    rounds, conclusions, exceptions: open,
    settled: !rounds.length && !waiting && !open.some(exception => !exception.blocking),
    cursor, summaryAt: now.toISOString(),
    state: { observedAt: now.toISOString(), turns: observed, streaks, reminded: kept, summary: state.summary ?? {}, summaryAt: state.summaryAt ?? {} }
  };
}

export function situationLine(exception) {
  const who = `${exception.executor.title} #${exception.turnNumber}`;
  if (exception.blocking) return `阻塞 ${who}：${exception.detail}；${exception.blocking}`;
  return `${who} → ${exception.recipient}，${exception.detail}${exception.reminded ? `；已提醒 ${exception.recipient}` : ''}`;
}

function windowText(from, to, source) {
  return `${from ? from.slice(11, 16) : '未观察'}–${to.slice(11, 16)}（观察 ${to}，${source}）`;
}

const excerpt = (text, size = 160) => text.length > size ? `${text.slice(0, size)}…` : text;

export function formatActivity(result, work, { title, archived, from, source = '本次观察' }) {
  const lines = [`${title} · ${windowText(from, result.observedAt, source)}`];
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

export function formatExceptions(result, source = '本次观察') {
  const window = windowText(result.works[0]?.from, result.observedAt, source);
  if (!result.exceptions.length) return `未结例外 · ${window}\n无`;
  return [`未结例外 · ${window}`, ...result.exceptions.map(exception => `  ${situationLine(exception)}`)].join('\n');
}

// 循环的健康状况：最近一次错误，以及距上次观察成功过了多久。
export function formatHealth({ error, lastSuccessAt }, now = new Date()) {
  const lines = [];
  if (error) lines.push(`最近错误 ${error}`);
  if (lastSuccessAt) lines.push(`后台上次成功观察 ${lastSuccessAt}（${Math.round((now.getTime() - Date.parse(lastSuccessAt)) / 1000)} 秒前）`);
  return lines.length ? lines.join('\n') : null;
}

export function formatErrors(errors) {
  const entries = Object.entries(errors ?? {});
  if (!entries.length) return null;
  return ['读取失败', ...entries.map(([id, message]) => `  ${id}：${message}`)].join('\n');
}
