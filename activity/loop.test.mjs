import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runActivity, ensureActivity, readActivityState, readActivityResult, activityHome } from './loop.mjs';
import { findActivityCli } from './codexhost.mjs';

const C1 = 'codex://threads/11111111-1111-1111-1111-111111111111';
const D = 'codex://threads/44444444-4444-4444-4444-444444444444';
const EXEC = '55555555-5555-5555-5555-555555555555';
const T0 = '2026-11-21T06:40:00.000Z';
const FAKE = path.resolve(import.meta.dirname, 'fixtures/fake-codexhost.mjs');

const model = {
  folders: ['工作'], primaryKey: 'ontology_id',
  properties: { ontology_id: { type: 'text', required: true }, ontology_type: { type: 'text', required: true }, title: { type: 'text', required: true } },
  objectTypes: { work_item: { label: '工作', properties: { progress: { type: 'text', required: true }, owner_thread: { type: 'text', required: false } } } },
  relations: {}
};

async function workspace(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'InfoHub 活动-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'vault'), cli = path.join(home, 'codexhost');
  await mkdir(cli, { recursive: true });
  await mkdir(path.join(root, 'ontology'), { recursive: true });
  await mkdir(path.join(root, '工作'), { recursive: true });
  process.env.FAKE_CODEXHOST_DIR = cli;
  t.after(() => { delete process.env.FAKE_CODEXHOST_DIR; });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await writeFile(path.join(root, 'ontology/ontology.json'), JSON.stringify(model));
  await writeFile(path.join(root, '工作/面板化.md'),
    `---\nontology_id: "work-a"\nontology_type: "work_item"\ntitle: "面板化线"\nprogress: "实施中"\nowner_thread: "${C1}"\n---\n`);
  return { home, root, cli };
}

const write = (dir, name, value) => writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
const read = async (dir, name, fallback) => JSON.parse(await readFile(path.join(dir, name), 'utf8').catch(() => JSON.stringify(fallback)));
const sent = async cli => (await readFile(path.join(cli, 'sent.jsonl'), 'utf8').catch(() => ''))
  .split('\n').filter(Boolean).map(line => JSON.parse(line));

async function until(fn, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

const runningTurn = {
  turnId: 'turn-1', turnNumber: 1, status: 'running',
  messages: [{ role: 'user', text: `派给你\n\nSender: ${C1}` }]
};
const deliveredTurn = {
  ...runningTurn, status: 'completed',
  messages: [...runningTurn.messages, { role: 'agent', phase: 'final', text: '已在本地提交 486a69581。' }]
};
const emptyThread = (id, title) => ({ threadId: id, title, status: 'completed', updatedAt: T0, from: null, to: null, totalTurns: 0, turns: [], pendingQuestions: [] });

// 循环先看到这一轮在跑，随后它结束：只有这种轮才会被当成新交件跟踪。
async function finishRound(f, updatedAt) {
  await write(f.cli, 'threads.json', {
    threads: [
      { threadId: EXEC, title: 'C2 线', status: 'completed', updatedAt },
      { threadId: D.slice('codex://threads/'.length), title: 'D', status: 'completed', updatedAt: T0 },
      { threadId: C1.slice('codex://threads/'.length), title: '主控', status: 'completed', updatedAt: T0 }
    ], nextCursor: null
  });
  await write(f.cli, 'read/55555555-5555-5555-5555-555555555555.json',
    { threadId: EXEC, title: 'C2 线', status: 'completed', updatedAt, from: 1, to: 1, totalTurns: 1, turns: [deliveredTurn], pendingQuestions: [] });
}

async function fixtures(f, { updatedAt = T0 } = {}) {
  await mkdir(path.join(f.cli, 'read'), { recursive: true });
  await write(f.cli, 'threads.json', {
    threads: [
      { threadId: EXEC, title: 'C2 线', status: 'running', updatedAt: T0 },
      { threadId: D.slice('codex://threads/'.length), title: 'D', status: 'completed', updatedAt },
      { threadId: C1.slice('codex://threads/'.length), title: '主控', status: 'completed', updatedAt }
    ], nextCursor: null
  });
  await write(f.cli, 'read/55555555-5555-5555-5555-555555555555.json',
    { threadId: EXEC, title: 'C2 线', status: 'running', updatedAt: T0, from: 1, to: 1, totalTurns: 1, turns: [runningTurn], pendingQuestions: [] });
  await write(f.cli, 'read/44444444-4444-4444-4444-444444444444.json', emptyThread(D.slice('codex://threads/'.length), 'D'));
  await write(f.cli, 'read/11111111-1111-1111-1111-111111111111.json', emptyThread(C1.slice('codex://threads/'.length), '主控'));
  await write(f.cli, 'watches.json', { watches: [{ threadId: EXEC, notifyThreadId: D.slice('codex://threads/'.length), state: 'watching', turnId: 'turn-1', outcome: 'completed' }] });
}

test('the loop reminds the recipient once, escalates once, and exits after the delivery is picked up', async t => {
  const f = await workspace(t);
  await fixtures(f);
  let minute = 0;
  const clock = () => new Date(Date.parse(T0) + minute++ * 60_000);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const running = runActivity(f.root, { cli: FAKE, intervalMs: 5, clock, signal: abort.signal });
  let failure;
  running.catch(error => { failure = error; });

  // 循环先看到这一轮在跑，随后它结束，五分钟后再提醒接手人。
  await until(async () => (await readActivityState(f.root)).threads?.[EXEC]?.seenThrough >= 1, '循环没有观察这一轮');
  await finishRound(f, new Date(Date.parse(T0) + 60_000).toISOString());
  const first = await until(async () => (await sent(f.cli))[0], '五分钟后没有提醒接手人');
  assert.equal(first.threadId, D.slice('codex://threads/'.length));
  // 循环把判断结果写在 result.json，查询在它新鲜时直接读这份。
  const shared = await until(async () => {
    const { result } = await readActivityResult(f.root);
    return result?.exceptions.length ? result : null;
  }, '没有写出后台结果');
  assert.equal(shared.exceptions[0].kind, 'deliver');
  assert.deepEqual(shared.conclusions.map(conclusion => conclusion.text), ['已在本地提交 486a69581。']);
  assert.match(first.message, /面板化线 `work-a`.*第 1 轮.*已结束五分钟/);
  assert.match(first.message, /infohub activity work-a/);

  const second = await until(async () => (await sent(f.cli))[1], '五分钟没动后没有升级给派活人');
  assert.equal(second.threadId, C1.slice('codex://threads/'.length));
  assert.match(second.message, /接手人 codex:\/\/threads\/4444.*五分钟仍未动/);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal((await sent(f.cli)).length, 2, '同一例外对同一人只提醒一次');

  // D 收到交付并开工，交件解结，循环退出。
  await mkdir(path.join(f.cli, 'read'), { recursive: true });
  await write(f.cli, 'threads.json', {
    threads: [
      { threadId: EXEC, title: 'C2 线', status: 'completed', updatedAt: T0 },
      { threadId: D.slice('codex://threads/'.length), title: 'D', status: 'running', updatedAt: new Date(Date.parse(T0) + 20 * 60_000).toISOString() },
      { threadId: C1.slice('codex://threads/'.length), title: '主控', status: 'completed', updatedAt: T0 }
    ], nextCursor: null
  });
  // 提醒送达、接手人那一轮结束后就算接住：例外撤销，循环退出。
  await write(f.cli, 'read/44444444-4444-4444-4444-444444444444.json', {
    threadId: D.slice('codex://threads/'.length), title: 'D', status: 'completed', from: 1, to: 1, totalTurns: 1,
    turns: [{
      turnId: 'd-1', turnNumber: 1, status: 'completed',
      messages: [
        { role: 'user', text: first.message },
        { role: 'agent', phase: 'final', text: '已接住，开始组批' }
      ]
    }],
    pendingQuestions: []
  });
  await running;
  assert.equal(failure, undefined);
  const state = await readActivityState(f.root);
  assert.equal(state.running, false);
  assert.deepEqual(state.reminded, [], '接住后提醒记录一并撤掉');
  assert.equal((await readActivityResult(f.root)).result, null, '循环不在跑时查询不读后台结果');
  assert.equal(await stat(path.join(await activityHome(f.root), 'state.json')).then(() => true), true);
});

test('a busy recipient is left alone and reminded in a later window instead', async t => {
  const f = await workspace(t);
  await fixtures(f);
  await write(f.cli, 'busy.json', { refused: [D.slice('codex://threads/'.length)] }.refused);
  let minute = 0;
  const clock = () => new Date(Date.parse(T0) + minute++ * 60_000);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const running = runActivity(f.root, { cli: FAKE, intervalMs: 5, clock, signal: abort.signal });
  await until(async () => (await readActivityState(f.root)).threads?.[EXEC]?.seenThrough >= 1, '循环没有观察这一轮');
  await finishRound(f, new Date(Date.parse(T0) + 60_000).toISOString());
  await until(async () => minute > 12, '循环没有按窗口扫描');
  assert.deepEqual(await sent(f.cli), []);

  await write(f.cli, 'busy.json', []);
  const first = await until(async () => (await sent(f.cli))[0], '空闲后没有补发提醒');
  assert.equal(first.threadId, D.slice('codex://threads/'.length));

  await mkdir(path.join(f.cli, 'read'), { recursive: true });
  const late = new Date(Date.parse(T0) + 30 * 60_000).toISOString();
  await write(f.cli, 'threads.json', {
    threads: [
      { threadId: EXEC, title: 'C2 线', status: 'completed', updatedAt: T0 },
      { threadId: D.slice('codex://threads/'.length), title: 'D', status: 'completed', updatedAt: late },
      { threadId: C1.slice('codex://threads/'.length), title: '主控', status: 'completed', updatedAt: T0 }
    ], nextCursor: null
  });
  await write(f.cli, 'read/44444444-4444-4444-4444-444444444444.json', {
    threadId: D.slice('codex://threads/'.length), title: 'D', status: 'completed', from: 1, to: 1, totalTurns: 1,
    turns: [{ turnId: 'd-1', turnNumber: 1, status: 'completed', messages: [{ role: 'user', text: `接件\n\nSender: codex://threads/${EXEC}` }, { role: 'agent', phase: 'final', text: '开始组批' }] }],
    pendingQuestions: []
  });
  await running;
});

test('without a local codexhost CLI the activity loop is not started at all', async t => {
  const f = await workspace(t);
  assert.equal(findActivityCli({}), undefined);
  assert.equal(findActivityCli({ CODEXHOST_CLI_PATH: '/opt/codexhost' }), '/opt/codexhost');
  await ensureActivity(f.root, { cli: undefined });
  await assert.rejects(stat(await activityHome(f.root)), { code: 'ENOENT' });
});

test('a failed observation is recorded and the next interval recovers instead of exiting', async t => {
  const f = await workspace(t);
  await fixtures(f);
  await write(f.cli, 'fail.json', ['watches']);
  let minute = 0;
  const clock = () => new Date(Date.parse(T0) + minute++ * 60_000);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const running = runActivity(f.root, { cli: FAKE, intervalMs: 5, clock, signal: abort.signal });
  let failure;
  running.catch(error => { failure = error; });

  const failed = await until(async () => (await readActivityState(f.root)).error, '失败的观察没有写进状态');
  assert.match(failed, /第 1 次观察失败：.*thread watches/);
  assert.equal((await readActivityState(f.root)).running, true, '循环没有退出');
  assert.deepEqual(await sent(f.cli), []);

  // Host 恢复后下一个间隔照常观察，错误清掉，交件照原规则提醒。
  await write(f.cli, 'fail.json', []);
  await until(async () => (await readActivityState(f.root)).lastSuccessAt, '下一轮没有恢复');
  assert.equal((await readActivityState(f.root)).error, null);
  assert.equal((await readActivityState(f.root)).failures, 0);
  await finishRound(f, new Date(Date.parse(T0) + 60_000).toISOString());
  const reminder = await until(async () => (await sent(f.cli))[0], '恢复后没有提醒接手人');
  assert.equal(reminder.threadId, D.slice('codex://threads/'.length));
  abort.abort();
  await running;
  assert.equal(failure, undefined);
});
