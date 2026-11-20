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
const thread = (turns, { id = EXECUTOR, title = 'C2 线', status = 'completed', updatedAt, pending = [] } = {}) => ({
  threadId: id, title, status, pendingQuestions: pending,
  updatedAt: updatedAt ?? '2026-11-21T06:40:00.000Z', turns
});
const judge = (objects, threads, options = {}) => judgeActivity(index(...objects), { threads, ...options });

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

  // C1 收到指向这次交付的消息，就是接件事实；已接就不再重复催。
  const picked = judge([owner], [thread([delivered]), thread([turn(1, { sender: `codex://threads/${EXECUTOR}`, body: 'C2 的交付到了', status: 'running' })], { id: threadId(C1), title: 'C1', status: 'running' })],
    { now: new Date(Date.parse('2026-11-21T07:00:00.000Z')), state: late.state });
  assert.deepEqual(picked.exceptions.filter(exception => exception.kind === 'deliver'), []);
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
  // 换任后这一轮归新的负责会话；旧人零条，清单写明阻塞。
  const changed = judge([work('work-a', C2), work('work-b', C1)], [thread([delivered]), thread([], d)], {
    now, watches: [deliversTo], state: { ...state, turns: escalated.state.turns }
  });
  const moved = changed.exceptions.find(exception => exception.kind === 'changed');
  assert.equal(moved.workId, 'work-a');
  assert.equal(moved.recipient, null);
  assert.match(moved.blocking, /这一轮的负责会话已换任/);
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
