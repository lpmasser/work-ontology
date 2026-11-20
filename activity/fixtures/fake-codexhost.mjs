#!/usr/bin/env node
// 可控的本机 codexhost 替身：只按 FAKE_CODEXHOST_DIR 里的固定内容回答，读到的和发出的都留在那里。
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const dir = process.env.FAKE_CODEXHOST_DIR;
const argv = process.argv.slice(2);
const option = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const load = async (name, fallback) => {
  try { return JSON.parse(await readFile(path.join(dir, name), 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
};
const print = value => process.stdout.write(`${JSON.stringify(value)}\n`);
await mkdir(dir, { recursive: true });
await appendFile(path.join(dir, 'calls.log'), `${argv.join(' ')}\n`);

if (argv[0] !== 'thread') throw new Error(`fake codexhost: 未知命令 ${argv.join(' ')}`);
const id = argv[2];
if (argv[1] === 'list') print(await load('threads.json', { threads: [], nextCursor: null }));
else if (argv[1] === 'watches') print(await load('watches.json', { watches: [] }));
else if (argv[1] === 'read') print(await load(path.join('read', `${id}.json`), null));
else if (argv[1] === 'send') {
  const busy = await load('busy.json', []);
  if (busy.includes(id)) {
    process.stderr.write(`${JSON.stringify({ error: { code: 'THREAD_BUSY', message: 'Thread is busy' } })}\n`);
    process.exit(1);
  }
  await appendFile(path.join(dir, 'sent.jsonl'), `${JSON.stringify({ threadId: id, message: option('--message') })}\n`);
  print({ threadId: id });
} else throw new Error(`fake codexhost: 未知子命令 ${argv.join(' ')}`);
