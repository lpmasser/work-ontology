import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { observeActivity } from './observe.mjs';

// 用例里的宿主一律用假 CLI；显式置空真实入口，直跑本文件也不会去调真的 codexhost。
process.env.CODEXHOST_CLI_PATH = '';
process.env.INFOHUB_ACTIVITY_CLI = '';

const FAKE = path.resolve(import.meta.dirname, 'fixtures/fake-codexhost.mjs');
const C1 = 'codex://threads/11111111-1111-1111-1111-111111111111';
const EXEC = '55555555-5555-5555-5555-555555555555';
const T0 = '2026-11-21T06:40:00.000Z';
const index = { objects: new Map([['work-a', { id: 'work-a', type: 'work_item', title: '面板化线', path: '工作/a.md', frontmatter: { progress: '实施中', owner_thread: C1 } }]]) };

async function fake(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'InfoHub 观察-'));
  const fixture = path.join(dir, 'fixture');
  await mkdir(path.join(fixture, 'read'), { recursive: true });
  process.env.FAKE_CODEXHOST_DIR = fixture;
  t.after(async () => { delete process.env.FAKE_CODEXHOST_DIR; await rm(dir, { recursive: true, force: true }); });
  const write = (name, value) => writeFile(path.join(fixture, name), `${JSON.stringify(value, null, 2)}\n`);
  const calls = async () => (await readFile(path.join(fixture, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { cli: FAKE, write, calls };
}

const thread = (id, turn) => ({
  threadId: id, title: id, status: turn.status, updatedAt: T0, from: 1, to: 1, totalTurns: 1, turns: [turn], pendingQuestions: []
});
const task = (status) => ({ turnId: 't1', turnNumber: 1, status, messages: [{ role: 'user', text: `派\n\nSender: ${C1}` }] });

test('an observation without a newly ended round does not call thread watches', async t => {
  const f = await fake(t);
  await f.write('threads.json', { threads: [{ threadId: EXEC, title: 'C2 线', status: 'completed', updatedAt: T0 }], nextCursor: null });
  await f.write(`read/${EXEC}.json`, thread(EXEC, task('completed')));
  await f.write(`read/11111111-1111-1111-1111-111111111111.json`, thread('11111111-1111-1111-1111-111111111111', { ...task('completed'), messages: [{ role: 'user', text: '自己的一轮' }] }));
  const state = {
    observedAt: '2026-11-21T06:49:00.000Z',
    threads: {
      [EXEC]: { updatedAt: T0, seenThrough: 1 },
      '11111111-1111-1111-1111-111111111111': { updatedAt: T0, seenThrough: 1 }
    },
    turns: { [`${EXEC}#1`]: { workId: 'work-a', dispatcher: C1, recipient: C1, floor: 0, terminalAt: T0, pickedUp: false } }
  };
  const snapshot = await observeActivity(f.cli, { index, state });
  assert.equal(snapshot.watches, null, '没有新结束的轮时不取 watch');
  assert.equal((await f.calls()).filter(line => line.startsWith('thread watches')).length, 0);
});

test('the first observation and a newly ended round do fetch thread watches', async t => {
  const f = await fake(t);
  await f.write('watches.json', { watches: [{ threadId: EXEC, notifyThreadId: '44444444-4444-4444-4444-444444444444', state: 'watching', turnId: 't1' }] });
  await f.write('threads.json', { threads: [{ threadId: EXEC, title: 'C2 线', status: 'completed', updatedAt: T0 }], nextCursor: null });
  await f.write(`read/${EXEC}.json`, thread(EXEC, task('completed')));
  await f.write(`read/11111111-1111-1111-1111-111111111111.json`, thread('11111111-1111-1111-1111-111111111111', task('completed')));

  const firstSnapshot = await observeActivity(f.cli, { index, state: {} });
  assert.equal(firstSnapshot.watches.length, 1, '首次接入取 watch');
  assert.equal((await f.calls()).filter(line => line.startsWith('thread watches')).length, 1);

  // 记录里没有接手人（比如上一轮刚结束还没取过 watch），这一轮要取。
  const snapshot = await observeActivity(f.cli, {
    index,
    state: {
      observedAt: '2026-11-21T06:49:00.000Z',
      threads: { [EXEC]: { updatedAt: T0, seenThrough: 1 } },
      turns: { [`${EXEC}#1`]: { workId: 'work-a', dispatcher: C1, floor: 0, terminalAt: T0, pickedUp: false } }
    }
  });
  assert.equal(snapshot.watches.length, 1);
  assert.equal((await f.calls()).filter(line => line.startsWith('thread watches')).length, 2);
});
