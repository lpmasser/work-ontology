import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { tick, setSubscription } from './loop.mjs';

const FAKE = path.resolve(import.meta.dirname, 'fixtures/fake-codexhost.mjs');
const OWNER = '11111111-1111-1111-1111-111111111111';
const NEXT = '22222222-2222-2222-2222-222222222222';
const link = id => `codex://threads/${id}`;

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'infohub-summary-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'vault'), host = path.join(home, 'host');
  await mkdir(path.join(root, 'ontology'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(host, 'children'), { recursive: true });
  await writeFile(path.join(root, 'ontology/ontology.json'), JSON.stringify({
    folders: ['docs'], primaryKey: 'ontology_id',
    properties: { ontology_id: { type: 'text', required: true }, ontology_type: { type: 'text', required: true }, title: { type: 'text', required: true } },
    objectTypes: { work_item: { label: '工作', properties: { progress: { type: 'text', required: true }, owner_thread: { type: 'text', required: false } } } },
    relations: {}
  }));
  const before = process.env.FAKE_CODEXHOST_DIR;
  process.env.FAKE_CODEXHOST_DIR = host;
  t.after(() => { if (before === undefined) delete process.env.FAKE_CODEXHOST_DIR; else process.env.FAKE_CODEXHOST_DIR = before; });
  const put = (name, value) => writeFile(path.join(host, name), JSON.stringify(value));
  return {
    root,
    work: (id, owner) => writeFile(path.join(root, `docs/${id}.md`), `---\nontology_id: "${id}"\nontology_type: "work_item"\ntitle: "面板化线"\nprogress: "实施中"\n${owner ? `owner_thread: "${link(owner)}"\n` : ''}---\n`),
    children: (owner, threads) => put(`children/${owner}.json`, { threads, nextCursor: null }),
    watches: ids => put('watches.json', { watches: ids.map(threadId => ({ threadId, state: 'watching' })) }),
    busy: ids => put('busy.json', ids),
    sent: async () => (await readFile(path.join(host, 'sent.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}

const at = minutes => new Date(Date.parse('2026-11-23T01:00:00.000Z') + minutes * 60_000);

test('a new owner gets one welcome summary, later ones only on change, and busy owners are retried', async t => {
  const f = await fixture(t);
  await f.work('w-old', OWNER);
  await f.children(OWNER, [{ threadId: 'e1', title: '执行者', status: 'running' }]);
  await f.watches(['e1']);
  // 第一次在这台机器上跑：已有的工作只记下现状，不叫醒任何人。
  let state = await tick(f.root, FAKE, {}, at(0));
  assert.deepEqual(await f.sent(), []);

  await f.work('w-new', OWNER);
  state = await tick(f.root, FAKE, state, at(1));
  let sent = await f.sent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, OWNER);
  assert.match(sent[0].message, /已自动订阅/);
  assert.match(sent[0].message, /w-new/);

  // 十五分钟内不再看；到点了没变化也不发。
  state = await tick(f.root, FAKE, state, at(5));
  state = await tick(f.root, FAKE, state, at(17));
  assert.equal((await f.sent()).length, 1);

  // 有个会话在跑却没人等：到点发一份；对方忙就下一分钟再试。
  await f.children(OWNER, [{ threadId: 'e1', title: '执行者', status: 'running' }, { threadId: 'e2', title: '没人等', status: 'running' }]);
  await f.busy([OWNER]);
  state = await tick(f.root, FAKE, state, at(33));
  assert.equal(state.pending, true);
  assert.equal((await f.sent()).length, 1);
  await f.busy([]);
  state = await tick(f.root, FAKE, state, at(34));
  sent = await f.sent();
  assert.equal(sent.length, 3, '两件工作各一份');
  assert.ok(sent.slice(1).every(item => /没人挂 watch 等着的：〔没人等〕codex:\/\/threads\/e2/.test(item.message)));
});

test('an opted-out owner gets nothing, and the next owner is subscribed again with the predecessor sessions', async t => {
  const f = await fixture(t);
  await f.work('w1', OWNER);
  let state = await tick(f.root, FAKE, {}, at(0));
  await setSubscription(f.root, { id: 'w1', owner: link(OWNER) }, false);
  await f.children(OWNER, [{ threadId: 'e1', title: '前任派的', status: 'running' }]);
  state = await tick(f.root, FAKE, state, at(20));
  assert.deepEqual(await f.sent(), []);

  await f.work('w1', NEXT);
  state = await tick(f.root, FAKE, state, at(21));
  const sent = await f.sent();
  assert.deepEqual(sent.map(item => item.threadId), [NEXT]);
  assert.match(sent[0].message, /已自动订阅/);
  assert.match(sent[0].message, /〔前任派的〕codex:\/\/threads\/e1/);
});
