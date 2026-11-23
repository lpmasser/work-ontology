import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptions, plan, digest, fingerprint, worthSending, summaryText, SUMMARY_INTERVAL_MS } from './summary.mjs';

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

test('one owner is one summary however many works it holds; new works are due at once, the rest every fifteen minutes', () => {
  const now = new Date('2026-11-23T01:00:00.000Z');
  const held = [{ id: 'w1', owner: A }, { id: 'w2', owner: A }];
  const first = plan(held, {}, now);
  assert.deepEqual(first.due.map(group => [group.owner, group.works.length, group.fresh.length]), [[A, 2, 2]]);
  for (const id of ['w1', 'w2']) first.works[id].welcomed = true;
  first.owners[A] = { checkedAt: now.toISOString() };
  assert.equal(plan(held, first, new Date(now.getTime() + 5 * 60_000)).due.length, 0);
  assert.deepEqual(plan(held, first, new Date(now.getTime() + SUMMARY_INTERVAL_MS)).due.map(group => group.fresh.length), [0]);
  // 换给 B：B 马上订上，前任 A 派出去的会话一并算。
  const handed = plan([{ id: 'w1', owner: B }, { id: 'w2', owner: A }], first, new Date(now.getTime() + 60_000));
  assert.deepEqual(handed.due.map(group => [group.owner, group.fresh.map(item => item.id), group.previous]), [[B, ['w1'], [A]]]);
});

test('only actionable facts count as a change: sessions nobody watches and rounds that stopped unfinished, not the running count', () => {
  const since = '2026-11-23T01:00:00.000Z';
  const children = [
    { threadId: 'r1', title: '在跑有人等', status: 'running' },
    { threadId: 'r2', title: '在跑没人等', status: 'running' },
    { threadId: 's1', title: '刚中断', status: 'interrupted', updatedAt: '2026-11-23T01:10:00.000Z' },
    { threadId: 's2', title: '早就中断', status: 'interrupted', updatedAt: '2026-11-22T01:10:00.000Z' },
    { threadId: 'c1', title: '做完了', status: 'completed', updatedAt: '2026-11-23T01:10:00.000Z' },
  ];
  const facts = digest(children, new Set(['r1']), since);
  assert.equal(facts.running, 2);
  assert.deepEqual(facts.unwatched.map(item => item.id), ['r2']);
  assert.deepEqual(facts.stopped.map(item => item.id), ['s1']);
  assert.equal(worthSending(facts), true);
  const quiet = digest([{ threadId: 'r1', status: 'running' }], new Set(['r1']), since);
  assert.equal(worthSending(quiet), false);
  const held = [{ id: 'w1', title: '面板化线', progress: '实施中' }];
  assert.equal(fingerprint(held, quiet), fingerprint(held, digest([], new Set(), since)), '在跑的个数涨落不算变化');
  const text = summaryText(A, [...held, { id: 'w2', title: '产品层四项', progress: '实施中' }], facts, { fresh: [held[0]] });
  assert.match(text, /你负责的：面板化线 `w1`（进度：实施中）；产品层四项 `w2`/);
  assert.match(text, /新订上的：`w1`/);
  assert.match(text, /没人挂 watch 等着的：〔在跑没人等〕codex:\/\/threads\/r2/);
  assert.match(text, /没做完就停了的：〔刚中断〕codex:\/\/threads\/s1（interrupted）/);
  assert.match(text, /在等别人.*infohub unsubscribe/);
  assert.doesNotMatch(text, /做完了|早就中断/);
});
