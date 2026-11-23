import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptions, plan, digest, fingerprint, summaryText, SUMMARY_INTERVAL_MS } from './summary.mjs';

const A = 'codex://threads/11111111-1111-1111-1111-111111111111';
const B = 'codex://threads/22222222-2222-2222-2222-222222222222';
const work = (id, owner, extra = {}, file = `工作/${id}.md`) => ({
  id, type: 'work_item', title: id, path: file, frontmatter: { progress: '实施中', ...(owner ? { owner_thread: owner } : {}), ...extra }
});
const index = (...objects) => ({ objects: new Map(objects.map(object => [object.id, object])) });

test('every current owner of unfinished work is subscribed until it opts out, and a new owner is subscribed again', () => {
  const vault = index(work('w1', A), work('w2', A, { progress: '已交付' }), work('w3', A, {}, '工作/archive/w3.md'), work('w4', null));
  assert.deepEqual(subscriptions(vault).map(item => item.id), ['w1']);
  assert.deepEqual(subscriptions(vault, { w1: A }), []);
  // 退订记的是 A；换成 B 负责后 B 自动订上。
  assert.deepEqual(subscriptions(index(work('w1', B)), { w1: A }).map(item => item.owner), [B]);
});

test('a new subscription is due at once, then every fifteen minutes; a new owner starts over and keeps the predecessor', () => {
  const now = new Date('2026-11-23T01:00:00.000Z');
  const first = plan([{ id: 'w1', owner: A }], {}, now);
  assert.deepEqual(first.due.map(item => item.first), [true]);
  first.entries.w1.checkedAt = now.toISOString();
  assert.equal(plan([{ id: 'w1', owner: A }], first.entries, new Date(now.getTime() + 5 * 60_000)).due.length, 0);
  assert.deepEqual(plan([{ id: 'w1', owner: A }], first.entries, new Date(now.getTime() + SUMMARY_INTERVAL_MS)).due.map(item => item.first), [false]);
  const handed = plan([{ id: 'w1', owner: B }], first.entries, new Date(now.getTime() + 60_000));
  assert.deepEqual(handed.due.map(item => [item.first, item.entry.owner, item.entry.previous]), [[true, B, [A]]]);
});

test('the summary carries only work-level facts: running count, sessions nobody watches, and rounds that stopped unfinished', () => {
  const children = [
    { threadId: 'r1', title: '在跑有人等', status: 'running' },
    { threadId: 'r2', title: '在跑没人等', status: 'running' },
    { threadId: 's1', title: '刚中断', status: 'interrupted', updatedAt: '2026-11-23T01:10:00.000Z' },
    { threadId: 's2', title: '早就中断', status: 'interrupted', updatedAt: '2026-11-22T01:10:00.000Z' },
    { threadId: 'c1', title: '做完了', status: 'completed', updatedAt: '2026-11-23T01:10:00.000Z' },
  ];
  const facts = digest(children, new Set(['r1']), '2026-11-23T01:00:00.000Z');
  assert.deepEqual(facts.running, ['r1', 'r2']);
  assert.deepEqual(facts.unwatched.map(item => item.id), ['r2']);
  assert.deepEqual(facts.stopped.map(item => item.id), ['s1']);
  const item = { id: 'w1', title: '面板化线', progress: '实施中', owner: A };
  const text = summaryText(item, facts, { first: true });
  assert.match(text, /已自动订阅/);
  assert.match(text, /2 个在跑/);
  assert.match(text, /没人挂 watch 等着的：〔在跑没人等〕codex:\/\/threads\/r2/);
  assert.match(text, /没做完就停了的：〔刚中断〕codex:\/\/threads\/s1（interrupted）/);
  assert.match(text, /infohub unsubscribe w1/);
  assert.doesNotMatch(text, /做完了|早就中断/);
  // 同样的事实指纹不变，所以不会重发；有人挂上 watch 就变了。
  assert.equal(fingerprint(item, facts), fingerprint(item, digest(children, new Set(['r1']), '2026-11-23T01:00:00.000Z')));
  assert.notEqual(fingerprint(item, facts), fingerprint(item, digest(children, new Set(['r1', 'r2']), '2026-11-23T01:00:00.000Z')));
});
