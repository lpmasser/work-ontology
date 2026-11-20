import { spawn } from 'node:child_process';
import { findExecutable } from '../core/runtime.mjs';

// 以本机外部客户端身份调用：去掉调用方的会话身份和运行时入口，列表才跨工作区，后台消息也不带 Sender。
const CLIENT_ENV = ['CODEXHOST_THREAD_ID', 'CODEX_THREAD_ID', 'CODEXHOST_RUNTIME_TOKEN', 'CODEXHOST_RUNTIME_ENDPOINT'];

export function findActivityCli(env = process.env) {
  return env.CODEXHOST_CLI_PATH || findExecutable('codexhost');
}

// 调用方环境只保留非身份变量；Host 卡住时不能拖住整个活动循环。
function call(cli, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !CLIENT_ENV.includes(key)));
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = [], errors = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString();
      if (code !== 0) reject(new Error(`${cli} ${args.slice(0, 2).join(' ')}: ${Buffer.concat(errors).toString().trim() || code}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

const json = (cli, args) => call(cli, [...args, '--format', 'json']);

// 按 updated-desc 翻页；翻到整页都不比上次观察新的那一页就停，不把整机历史列一遍。
export async function listThreads(cli, since) {
  const threads = [];
  let cursor = null;
  do {
    const page = await json(cli, ['thread', 'list', '--sort', 'updated-desc', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])]);
    threads.push(...page.threads);
    const oldest = page.threads.at(-1)?.updatedAt;
    cursor = since && oldest && oldest < since ? null : page.nextCursor;
  } while (cursor);
  return threads;
}

// 首次接入读默认的最近十轮；之后从已看到的轮号取增量，每段最多五十轮。
export async function readMessages(cli, threadId, from) {
  const latest = await json(cli, ['thread', 'read', threadId, '--view', 'messages']);
  if (!from || !latest.from || from >= latest.to) return latest;
  const turns = [...latest.turns];
  let end = latest.from;
  while (end > from) {
    const begin = Math.max(from, end - 50);
    const page = await json(cli, ['thread', 'read', threadId, '--view', 'messages', '--from', String(begin), '--to', String(end - 1)]);
    turns.push(...page.turns);
    end = begin;
  }
  return { ...latest, turns };
}

export async function listWatches(cli) {
  return (await json(cli, ['thread', 'watches'])).watches;
}

export async function send(cli, threadId, message) {
  await json(cli, ['thread', 'send', threadId, '--message', message]);
}
