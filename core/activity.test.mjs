import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeActivity, readInitiator, currentOwners, threadId, DELIVERY_GRACE_MS } from './activity.mjs';

const C1 = 'codex://threads/11111111-1111-1111-1111-111111111111';
const C2 = 'codex://threads/22222222-2222-2222-2222-222222222222';
const D = 'codex://threads/44444444-4444-4444-4444-444444444444';
const EXECUTOR = '55555555-5555-5555-5555-555555555555';

const work = (id, owner, extra = {}) => ({
  id, type: 'work_item', title: id, path: `工作/${id}.md`,
  frontmatter: { progress: '实施中', owner_thread: owner, ...extra }
});
const index = (...objects) => ({ objects: new Map(objects.map(object => [object.id, object])) });

let turnSeed = 0;
function turn(number, { sender, body = '干活', reply = null, status = 'completed', watchNotice = null } = {}) {
  turnSeed += 1;
  const text = watchNotice ?? `${body}${sender ? `\n\nSender: ${sender}` : ''}`;
  return {
    turnId: `turn-${EXECUTOR}-${number}-${turnSeed}`, turnNumber: number, status,
    messages: [{ role: 'user', text }, ...(reply ? [{ role: 'agent', phase: 'final', text: reply }] : [])]
  };
}
const thread = (turns, { id = EXECUTOR, title = 'C2 线', status = 'completed', updatedAt, createdAt, pending = [] } = {}) => ({
  threadId: id, title, status, pendingQuestions: pending, createdAt,
  updatedAt: updatedAt ?? '2026-11-21T06:40:00.000Z', turns
});
// 默认按「这些会话上次已经观察过、读到的轮号是 0」来判：它们带来的轮都算新轮。
const judge = (objects, threads, options = {}) => judgeActivity(index(...objects), {
  threads,
  ...options,
  state: {
    observedAt: '2026-01-01T00:00:00.000Z',
    threads: Object.fromEntries(threads.map(thread => [thread.threadId, { updatedAt: thread.updatedAt, ...(thread.seenThrough === undefined ? { seenThrough: 0 } : { seenThrough: thread.seenThrough }) }])),
    ...options.state,
  },
});

test('a round belongs to the sender of its initiating input, and only a separate 不用回 line drops it', () => {
  const owner = work('work-a', C1);
  const other = work('work-b', C2);
  const input = [
    turn(1, { sender: C1, reply: 'A 已交付' }),
    turn(2, { sender: C2, reply: 'B 已交付' }),
    turn(3, { sender: C1, body: '正文提到不用回这三个字，仍要跟进', reply: '收到' }),
    turn(4, { sender: C1, body: '这一轮先别管我\n不用回', reply: '好' }),
    turn(5, { body: '没有发送者的一轮', reply: '匿名的' }),
    turn(6, { watchNotice: "[codexhost thread watch] Read each Thread's result, then continue your task:\n\n- [C2](thread://x): completed", reply: '已接' })
  ];
  const first = judge([owner, other], [thread(input)], { now: new Date('2026-11-21T06:41:00.000Z') });
  assert.deepEqual(first.conclusions.map(entry => [entry.turnNumber, entry.workId]), [[1, 'work-a'], [2, 'work-b'], [3, 'work-a']]);
  const later = judge([owner, other], [thread(input)], { now: new Date('2026-11-21T06:46:00.000Z'), state: first.state });
  const recipients = later.exceptions.filter(exception => exception.kind === 'deliver').map(exception => exception.recipient).sort();
  assert.deepEqual([...new Set(recipients)], [C1, C2]);
});

test('an executor who is not a current owner cannot claim a round, and steered messages do not re-claim it', () => {
  const owner = work('work-a', C1);
  const steered = turn(1, { sender: C1, body: '第一段', reply: '好' });
  steered.messages.push({ role: 'user', text: `插话\n\nSender: ${C2}` });
  const unknown = work('work-c', C2, { progress: '已交付' });
  const result = judge([owner, unknown], [thread([steered, turn(2, { sender: C2 })])], { now: new Date() });
  assert.deepEqual(result.conclusions.map(entry => entry.workId), ['work-a']);
  assert.equal(readInitiator(steered).sender, C1);
});

test('the recipient comes from the registered watch, then 交给, then the dispatcher', () => {
  const owner = work('work-a', C1);
  const holder = work('work-b', D);
  const now = new Date('2026-11-21T06:50:00.000Z');
  const watched = turn(1, { sender: C1, reply: '交件一' });
  const handover = turn(2, { sender: C1, body: '交给：work-b', reply: '交件二' });
  const plain = turn(3, { sender: C1, reply: '交件三' });
  const threads = [thread([watched, handover, plain])];
  const watches = [{ threadId: EXECUTOR, notifyThreadId: '44444444-4444-4444-4444-444444444444', state: 'pendingDelivery', outcome: 'completed', turnId: watched.turnId }];
  const first = judge([owner, holder], threads, { now: new Date('2026-11-21T06:40:00.000Z'), watches });
  const result = judge([owner, holder], threads, { now, watches, state: first.state });
  const recipients = Object.fromEntries(result.exceptions.map(exception => [exception.turnNumber, exception.recipient]));
  assert.deepEqual(recipients, { 1: D, 2: D, 3: C1 });
});

test('a delivery is only raised after five minutes, and a picked-up delivery is dropped', () => {
  const owner = work('work-a', C1);
  const delivered = turn(1, { sender: C1, reply: '已在本地提交 486a69581。' });
  const threads = [thread([delivered])];
  const early = judge([owner], threads, { now: new Date(Date.parse('2026-11-21T06:40:00.000Z') + DELIVERY_GRACE_MS - 1) });
  assert.deepEqual(early.exceptions, []);
  assert.equal(early.settled, false);
  const late = judge([owner], threads, { now: new Date(Date.parse('2026-11-21T06:40:00.000Z') + DELIVERY_GRACE_MS) });
  assert.equal(late.exceptions[0].kind, 'deliver');
  assert.equal(late.exceptions[0].recipient, C1);

  // 接手人那一轮提到执行者并已结束，就是接件事实；已接就不再重复催。
  const picked = judge([owner], [thread([delivered]), thread([turn(1, { sender: `codex://threads/${EXECUTOR}`, body: 'C2 的交付到了', reply: '开始组批' })], { id: threadId(C1), title: 'C1', status: 'completed' })],
    { now: new Date(Date.parse('2026-11-21T07:00:00.000Z')), state: late.state });
  assert.deepEqual(picked.exceptions.filter(exception => exception.kind === 'deliver'), []);
  assert.equal(picked.settled, true, '接住后退出条件成立');

  // 只是被我们的提醒叫醒、还没结束的不算接住；提醒那一轮结束即撤项。
  const remindedThread = thread([turn(1, { sender: `codex://threads/${EXECUTOR}`, body: '面板化线 `work-a`，C2 线〔codex://threads/5555〕第 1 轮已结束五分钟', status: 'running' })],
    { id: threadId(C1), title: 'C1', status: 'running' });
  const awake = judge([owner], [thread([delivered]), remindedThread], { now: new Date(Date.parse('2026-11-21T07:00:00.000Z')), state: late.state });
  assert.equal(awake.exceptions.filter(exception => exception.kind === 'deliver').length, 1);
  const answered = judge([owner], [thread([delivered]), thread([{ ...remindedThread.turns[0], status: 'completed', messages: [...remindedThread.turns[0].messages, { role: 'agent', phase: 'final', text: '已接手' }] }], { id: threadId(C1), title: 'C1', status: 'completed' })],
    { now: new Date(Date.parse('2026-11-21T07:05:00.000Z')), state: awake.state });
  assert.deepEqual(answered.exceptions.filter(exception => exception.kind === 'deliver'), []);
  assert.equal(answered.settled, true);
});

test('an unclaimed delivery escalates to the dispatcher once, and names the blocking reason instead', () => {
  const owner = work('work-a', C1);
  const now = new Date('2026-11-21T07:10:00.000Z');
  const delivered = turn(1, { sender: C1, reply: '交件' });
  const d = { id: '44444444-4444-4444-4444-444444444444', title: 'D', status: 'completed' };
  const deliversTo = { threadId: EXECUTOR, notifyThreadId: d.id, turnId: delivered.turnId };
  const state = { reminded: [{ key: `deliver:${EXECUTOR}#1`, recipient: D, at: '2026-11-21T07:00:00.000Z' }] };
  const escalated = judge([owner, work('work-b', D)], [thread([delivered]), thread([], d)], { now, watches: [deliversTo], state });
  const escalate = escalated.exceptions.filter(exception => exception.kind === 'escalate');
  assert.equal(escalate.length, 1);
  assert.equal(escalate[0].recipient, C1);
  assert.equal(escalate[0].reminded, null);
  assert.equal(escalate[0].blocking, undefined);

  // 派活人就是接手人时无级可升，清单写清阻塞而不是换个名字再发一遍。
  const samePerson = judge([owner], [thread([delivered])], {
    now, state: { reminded: [{ key: `deliver:${EXECUTOR}#1`, recipient: C1, at: '2026-11-21T07:00:00.000Z' }] }
  });
  const sameEscalate = samePerson.exceptions.find(exception => exception.kind === 'escalate');
  assert.ok(sameEscalate);
  assert.equal(sameEscalate.blocking, '派活人就是接手人，未指定其他接手人');
  // 派活人已经不负责任何进行中的工作时，这一轮照常判断，只在升级那一步写阻塞，不叫醒旧人。
  const moved = judge([work('work-a', C2)], [thread([delivered]), thread([], d)], {
    now, watches: [deliversTo], state: { ...state, turns: escalated.state.turns }
  });
  const stranded = moved.exceptions.find(exception => exception.kind === 'escalate');
  assert.equal(stranded.workId, 'work-a');
  assert.equal(stranded.recipient, C1);
  assert.match(stranded.blocking, /派活人已换任（现为 codex:\/\/threads\/2222/);
  assert.equal(moved.settled, true, '阻塞项不拖住循环');

  // 负责多项工作时沿用记录里原来的那项。
  const twoWorks = judge([work('work-a', C1), work('work-b', C1)], [thread([delivered])], {
    now, state: { turns: { [`${EXECUTOR}#1`]: { workId: 'work-b', dispatcher: C1, floor: 0, terminalAt: '2026-11-21T06:40:00.000Z', pickedUp: false } } }
  });
  assert.deepEqual(twoWorks.conclusions.map(conclusion => conclusion.workId), ['work-b']);
  const busyDispatcher = thread([], {
    id: threadId(C1), title: 'C1', status: 'running',
    pending: [{ interactionId: 'int-2', turnId: 'x', request: { questions: [{ prompt: '选哪个？' }] } }]
  });
  const asking = judge([owner, work('work-b', D)], [thread([delivered]), thread([], d), busyDispatcher],
    { now, watches: [deliversTo], state });
  assert.equal(asking.exceptions.find(exception => exception.kind === 'escalate').blocking, '派活人停在提问框，不能插话');
});

test('a pending question, a failed round that was not continued, and a repeated interruption streak each raise once', () => {
  const owner = work('work-a', C1);
  const now = new Date('2026-11-21T06:50:00.000Z');
  const asking = thread([turn(1, { sender: C1, status: 'running' })], {
    status: 'running',
    pending: [{ interactionId: 'int-1', turnId: null, kind: 'requestUserInput', request: { params: { questions: [{ question: '用哪个分支？' }] } } }]
  });
  asking.pendingQuestions[0].turnId = asking.turns[0].turnId;
  const question = judge([owner], [asking], { now });
  assert.deepEqual(question.exceptions.map(exception => [exception.kind, exception.interactionId, exception.detail]), [['question', 'int-1', '用哪个分支？']]);

  const failed = judge([owner], [thread([turn(1, { sender: C1, status: 'interrupted' })])], { now });
  assert.deepEqual(failed.exceptions.map(exception => exception.kind), ['failure']);
  const resumed = judge([owner], [thread([turn(1, { sender: C1, status: 'interrupted' }), turn(2, { sender: C1, status: 'running' })])], { now });
  assert.deepEqual(resumed.exceptions.filter(exception => exception.kind === 'failure'), []);

  const streakThread = thread([
    turn(1, { sender: C1, status: 'interrupted' }), turn(2, { sender: C1, status: 'interrupted' }),
    turn(3, { sender: C1, status: 'interrupted' }), turn(4, { sender: C1, status: 'running' }),
    turn(5, { sender: C1, status: 'interrupted' })
  ]);
  const streak = judge([owner], [streakThread], { now });
  const streaks = streak.exceptions.filter(exception => exception.kind === 'streak');
  assert.equal(streaks.length, 1);
  assert.equal(streaks[0].recipient, C1);
  assert.match(streaks[0].detail, /4 轮中断：#1、#2、#3、#5/);
  const again = judge([owner], [streakThread], { now, state: streak.state });
  assert.deepEqual(again.exceptions.filter(exception => exception.kind === 'streak'), []);
  const recovered = judge([owner], [thread([turn(1, { sender: C1, status: 'interrupted' }), turn(2, { sender: C1, status: 'completed', reply: '好了' })])],
    { now, state: again.state });
  assert.equal(recovered.state.streaks[EXECUTOR], undefined);
});

test('new conclusions follow the owner summary position, so a second read reports nothing new', () => {
  const owner = work('work-a', C1);
  const threads = [thread([turn(1, { sender: C1, reply: '已在本地提交 486a69581。' })])];
  const now = new Date('2026-11-21T06:50:00.000Z');
  const first = judge([owner], threads, { now });
  assert.deepEqual(first.conclusions.map(conclusion => conclusion.isNew), [true]);
  const advanced = { ...first.state, summary: first.cursor, summaryAt: { [C1]: first.summaryAt } };
  const second = judge([owner], threads, { now, state: advanced });
  assert.deepEqual(second.conclusions.map(conclusion => conclusion.isNew), [false]);
  assert.equal(second.works[0].from, first.summaryAt);
});

test('only unfinished work outside archive with an owner thread can dispatch', () => {
  const objects = [work('live', C1), work('done', C1, { progress: '已交付' }), work('old', C1)];
  objects[2].path = '工作/archive/old.md';
  assert.deepEqual(currentOwners(index(...objects)).map(entry => entry.id), ['live']);
  assert.equal(currentOwners(index(work('none', undefined, { owner_thread: undefined }))).length, 0);
});

test('a 交给 target without a current owner becomes a blocking item instead of an error', () => {
  const owner = work('work-a', C1);
  const gone = work('work-old', C2, { progress: '已交付' });
  const archived = work('work-archived', C2);
  archived.path = '工作/archive/work-archived.md';
  const orphan = { id: 'work-orphan', type: 'work_item', title: '无负责会话', path: '工作/orphan.md', frontmatter: { progress: '实施中' } };
  const now = new Date('2026-11-21T06:50:00.000Z');
  const turns = [turn(1, { sender: C1, body: '交给：work-old' }), turn(2, { sender: C1, body: '交给：work-archived' }), turn(3, { sender: C1, body: '交给：work-orphan' })];
  const result = judge([owner, gone, archived, orphan], [thread(turns)], { now });
  assert.deepEqual(result.exceptions.map(exception => [exception.kind, exception.recipient, exception.blocking]), [
    ['blocked', C2, '交给 的 work-old 已归档或已终结，按角色不唤醒原负责会话'],
    ['blocked', C2, '交给 的 work-archived 已归档或已终结，按角色不唤醒原负责会话'],
    ['blocked', null, '交给 的 work-orphan 没有负责会话']
  ]);
  assert.equal(result.settled, true, '取不到现任的项不拖住循环');
  assert.equal(result.state.turns[`${EXECUTOR}#3`].blocked, true);
});

test('settled rounds drop out of the stored records and reminders only keep open exceptions', () => {
  const owner = work('work-a', C1);
  const now = new Date('2026-11-21T06:50:00.000Z');
  const threads = [
    thread([turn(1, { sender: C1, reply: '交件一' })]),
    thread([turn(1, { sender: `codex://threads/${EXECUTOR}`, body: '接件', reply: '组批中' })], { id: threadId(C1), title: 'C1' })
  ];
  const state = {
    reminded: [{ key: `deliver:${EXECUTOR}#1`, recipient: C1, at: '2026-11-21T06:41:00.000Z' }, { key: 'failure:old#9', recipient: C1, at: '2026-11-21T06:00:00.000Z' }],
    turns: { [`${EXECUTOR}#1`]: { workId: 'work-a', dispatcher: C1, floor: 0, terminalAt: '2026-11-21T06:40:00.000Z', pickedUp: false } }
  };
  const settled = judge([owner], threads, { now, state });
  assert.equal(settled.settled, true);
  assert.deepEqual(settled.state.turns, {}, '已接住的轮不再留在记录里');
  assert.deepEqual(settled.state.reminded, [], '已撤项的提醒不再保留');
});

test('re-reading a responsible session does not turn withdrawn history back into new deliveries', () => {
  const owner = work('work-a', C1);
  const now = new Date('2026-11-21T06:50:00.000Z');
  const history = thread([
    turn(1, { sender: C2, reply: '旧的一轮，早就处理过' }),
    turn(2, { sender: C2, reply: '也是旧的一轮' })
  ], { id: threadId(C1), title: '主控' });
  // 上次已读到第 2 轮：这两轮是历史，不再建记录、不再提醒。
  const reread = judge([owner, work('work-b', C2)], [history], {
    now, state: { observedAt: '2026-11-21T06:49:00.000Z', threads: { [history.threadId]: { updatedAt: '2026-11-21T06:40:00.000Z', seenThrough: 2 } } }
  });
  assert.deepEqual(reread.exceptions, []);
  assert.deepEqual(reread.conclusions, []);
  assert.deepEqual(reread.state.turns, {});
  assert.equal(reread.settled, true);
});

test('a first observation only follows rounds that are still running', () => {
  const owner = work('work-a', C2);
  const threads = [thread([turn(1, { sender: C2, reply: '接入前就结束的轮' })], { id: threadId(C1), title: '主控' }),
    thread([turn(1, { sender: C2, status: 'running' })], { id: EXECUTOR, title: '执行者', status: 'running' })];
  const first = judgeActivity(index(owner), { threads, now: new Date('2026-11-21T06:50:00.000Z') });
  assert.deepEqual(first.state.turns[`${C1.slice('codex://threads/'.length)}#1`], undefined, '历史轮不建档');
  assert.deepEqual(first.rounds.map(round => round.turnNumber), [1]);
  assert.deepEqual(first.exceptions, []);
});

test('a session created after the last observation is followed even when its round already ended', () => {
  const owner = work('work-a', C1);
  const created = '2026-11-21T06:49:00.000Z';
  const fresh = thread([turn(1, { sender: C1, reply: '交件' })], { id: EXECUTOR, createdAt: created });
  const result = judge([owner], [fresh], {
    now: new Date('2026-11-21T06:55:00.000Z'),
    state: { observedAt: '2026-11-21T06:48:00.000Z', threads: {} }
  });
  assert.deepEqual(result.exceptions.map(exception => [exception.kind, exception.turnNumber]), [['deliver', 1]]);
});

test('the recipient floor keeps the last observed turn number when that session is not in this observation', () => {
  const owner = work('work-a', C1);
  const delivered = turn(1, { sender: C1, reply: '交件' });
  const state = {
    observedAt: '2026-11-21T06:41:00.000Z',
    threads: { [threadId(C1)]: { updatedAt: '2026-11-21T06:40:00.000Z', seenThrough: 7 }, [EXECUTOR]: { updatedAt: '2026-11-21T06:40:00.000Z', seenThrough: 0 } }
  };
  const first = judge([owner], [thread([delivered])], { now: new Date('2026-11-21T06:46:00.000Z'), state });
  assert.equal(first.state.turns[`${EXECUTOR}#1`].floor, 7, '接手人不在 threads 里时不归零');
  // 接手人回来了，历史轮里的旧提及不能算接件。
  const back = judge([owner], [thread([delivered]), thread([
    turn(5, { sender: `codex://threads/${EXECUTOR}`, body: '很早以前的一轮', reply: '旧' }),
    turn(7, { sender: `codex://threads/${EXECUTOR}`, body: '更早以前的一轮', reply: '旧' })
  ], { id: threadId(C1), title: 'C1', seenThrough: 7 })], {
    now: new Date('2026-11-21T06:47:00.000Z'), state: { ...first.state, threads: { [threadId(C1)]: { updatedAt: '2026-11-21T06:40:00.000Z', seenThrough: 7 } } }
  });
  assert.equal(back.exceptions.filter(exception => exception.kind === 'deliver').length, 1);
});

test('after the escalation a finished round of the dispatcher itself withdraws the delivery', () => {
  const owner = work('work-a', C1);
  const delivered = turn(1, { sender: C1, reply: '交件' });
  const state = {
    observedAt: '2026-11-21T07:10:00.000Z',
    threads: {
      [threadId(C1)]: { updatedAt: '2026-11-21T06:40:00.000Z', seenThrough: 3 },
      [EXECUTOR]: { updatedAt: '2026-11-21T06:40:00.000Z', seenThrough: 0 },
      '44444444-4444-4444-4444-444444444444': { updatedAt: '2026-11-21T06:40:00.000Z', seenThrough: 1 }
    },
    reminded: [{ key: `deliver:${EXECUTOR}#1`, recipient: D, at: '2026-11-21T07:00:00.000Z', floor: 1 },
      { key: `escalate:${EXECUTOR}#1`, recipient: C1, at: '2026-11-21T07:05:00.000Z', floor: 3 }]
  };
  const watches = [{ threadId: EXECUTOR, notifyThreadId: '44444444-4444-4444-4444-444444444444', turnId: delivered.turnId }];
  const open = judge([owner, work('work-b', D)], [thread([delivered]), thread([], { id: '44444444-4444-4444-4444-444444444444', title: 'D' })], { now: new Date('2026-11-21T07:10:00.000Z'), state, watches });
  assert.equal(open.exceptions.filter(exception => exception.kind === 'escalate').length, 1);

  const decided = judge([owner, work('work-b', D)], [thread([delivered]), thread([], { id: '44444444-4444-4444-4444-444444444444', title: 'D' }),
    thread([turn(4, { body: `面板化线 \`work-a\`，C2 线〔codex://threads/${EXECUTOR}〕第 1 轮交付后，接手人 … 五分钟仍未动`, reply: '收到，我直接处理' })], { id: threadId(C1), title: 'C1' })],
  { now: new Date('2026-11-21T07:11:00.000Z'), state, watches });
  assert.deepEqual(decided.exceptions, []);
  assert.equal(decided.settled, true);
});

test('a watch notice to the dispatcher does not count as the named recipient picking the delivery up', () => {
  const owner = work('work-a', C1);
  const delivered = turn(1, { sender: C1, reply: '交件' });
  const watches = [{ threadId: EXECUTOR, notifyThreadId: '44444444-4444-4444-4444-444444444444', turnId: delivered.turnId }];
  const dispatcherNotified = thread([turn(2, {
    watchNotice: `[codexhost thread watch] Read each Thread's result, then continue your task:\n\n- [C2 线](thread://${EXECUTOR}): completed`,
    reply: '知道了'
  })], { id: threadId(C1), title: 'C1' });
  const result = judge([owner, work('work-b', D)],
    [thread([delivered]), thread([], { id: '44444444-4444-4444-4444-444444444444', title: 'D' }), dispatcherNotified],
    { now: new Date('2026-11-21T06:50:00.000Z'), watches });
  const deliver = result.exceptions.filter(exception => exception.kind === 'deliver');
  assert.equal(deliver.length, 1, '交件仍然指向 D');
  assert.equal(deliver[0].recipient, D);
  assert.equal(result.state.turns[`${EXECUTOR}#1`].pickedUp, false);
});

test('a busy recipient is reported as busy instead of unclaimed, and is never escalated while it runs', () => {
  const owner = work('work-a', C1);
  const delivered = turn(1, { sender: C1, reply: '交件' });
  const d = { id: '44444444-4444-4444-4444-444444444444', title: 'S1' };
  const watches = [{ threadId: EXECUTOR, notifyThreadId: d.id, turnId: delivered.turnId }];
  const state = {
    observedAt: '2026-11-21T07:10:00.000Z',
    threads: { [EXECUTOR]: { updatedAt: '2026-11-21T06:40:00.000Z', seenThrough: 1 }, [d.id]: { updatedAt: '2026-11-21T07:00:00.000Z', seenThrough: 148 } },
    turns: { [`${EXECUTOR}#1`]: { workId: 'work-a', dispatcher: C1, floor: 148, terminalAt: '2026-11-21T06:40:00.000Z', pickedUp: false } },
    reminded: [{ key: `deliver:${EXECUTOR}#1`, recipient: D, at: '2026-11-21T07:00:00.000Z', floor: 148 }]
  };
  const busy = judge([owner, work('work-b', D)], [thread([delivered]), thread([turn(149, { sender: C1, status: 'running' })], { ...d, status: 'running' })],
    { now: new Date('2026-11-21T07:10:00.000Z'), state, watches });
  const open = busy.exceptions.filter(exception => exception.kind === 'deliver');
  assert.equal(open.length, 1);
  assert.equal(open[0].busy, 149);
  assert.match(open[0].detail, /接手人在忙（第 149 轮在跑），等这一轮结束再提醒/);
  assert.deepEqual(busy.exceptions.filter(exception => exception.kind === 'escalate'), [], '忙着的时候不升级');
  assert.equal(busy.settled, false, '仍等这一轮结束');

  // 这一轮结束后按原来的规则提醒一次，之后才轮到升级。
  const finished = judge([owner, work('work-b', D)], [thread([delivered]), thread([turn(149, { sender: C1, reply: '做完了' })], { ...d, status: 'completed' })],
    { now: new Date('2026-11-21T07:11:00.000Z'), state: busy.state, watches });
  const after = finished.exceptions.filter(exception => exception.kind === 'deliver' && exception.key === `deliver:${EXECUTOR}#1`);
  assert.equal(after.length, 1);
  assert.equal(after[0].busy, undefined);
  assert.match(after[0].detail, /五分钟未接/);
  assert.equal(finished.exceptions.filter(exception => exception.kind === 'escalate' && exception.key === `escalate:${EXECUTOR}#1`).length, 1, '老提醒已过五分钟，这一轮可以升级');
});

test('a round the recipient answered as soon as it ended is not reported as unclaimed', () => {
  const M4 = 'codex://threads/08bcfb49-84c6-4338-8a2d-da9de614686f';
  const executorId = '6d84da0c-1bba-40af-b7c6-d5ca7cc55c9f';
  const link = `codex://threads/${executorId}`;
  const owner = work('work-a', M4);
  // 执行者第 4 轮结束，watch 通知立刻成了 M4 的第 135 轮，M4 当场读了结果。
  const finished = turn(4, { sender: M4, reply: '已交付' });
  const executorThread = { threadId: executorId, title: '本体图谱翻成面板', status: 'completed', updatedAt: '2026-11-21T06:40:00.000Z', turns: [
    turn(3, { sender: M4, reply: '上一轮' }),
    finished
  ], pendingQuestions: [] };
  const watcher = (n, body) => ({ turnId: `w${n}`, turnNumber: n, status: 'completed', messages: [{ role: 'user', text: body }, { role: 'agent', phase: 'final', text: '读了' }] });
  const watchNotice = `[codexhost thread watch] Read each Thread's result, then continue your task:\n\n- [本体图谱翻成面板](thread://${executorId}): completed`;
  const m4 = {
    threadId: M4.slice('codex://threads/'.length), title: 'M4 主控', status: 'completed', updatedAt: '2026-11-21T06:41:00.000Z',
    turns: [watcher(134, '早先的一轮'), watcher(135, watchNotice)], pendingQuestions: []
  };
  // 上一次观察：执行者还在第 3 轮，M4 已经读到 134 轮。
  const state = {
    observedAt: '2026-11-21T06:39:00.000Z',
    threads: { [executorId]: { updatedAt: '2026-11-21T06:30:00.000Z', seenThrough: 3 }, [m4.threadId]: { updatedAt: '2026-11-21T06:30:00.000Z', seenThrough: 134 } },
    turns: { [`${executorId}#3`]: { workId: 'work-a', dispatcher: M4, recipient: M4, floor: 130, terminalAt: '2026-11-21T06:20:00.000Z', pickedUp: true } }
  };
  const result = judge([owner], [executorThread, m4], { now: new Date('2026-11-21T06:52:00.000Z'), state });
  assert.deepEqual(result.exceptions.filter(exception => exception.turnNumber === 4), [], '没有误报');
  assert.equal(result.state.turns[`${executorId}#4`], undefined, '已接住的轮不留记录');
  // 这条结论已经通过 watch 送到，不再进汇总。
  assert.deepEqual(result.conclusions.filter(conclusion => conclusion.turnNumber === 4).map(conclusion => conclusion.isNew), [false]);

  // 反例：接手人上一次观察之后没有再提到执行者，才算没接。
  const silent = { ...m4, turns: [watcher(134, '早先的一轮')] };
  const unclaimed = judge([owner], [executorThread, silent], { now: new Date('2026-11-21T06:52:00.000Z'), state });
  assert.deepEqual(unclaimed.exceptions.filter(exception => exception.turnNumber === 4).map(exception => exception.kind), ['deliver']);
  assert.deepEqual(unclaimed.conclusions.filter(conclusion => conclusion.turnNumber === 4).map(conclusion => conclusion.isNew), [true]);
});
