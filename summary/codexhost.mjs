import { spawn } from 'node:child_process';
import { findExecutable } from '../core/runtime.mjs';

// 以本机外部客户端身份调用：去掉调用方的会话身份和运行时入口，发出去的汇总不带 Sender。
const CLIENT_ENV = ['CODEXHOST_THREAD_ID', 'CODEX_THREAD_ID', 'CODEXHOST_RUNTIME_TOKEN', 'CODEXHOST_RUNTIME_ENDPOINT'];

// 显式置空（包括空的 CODEXHOST_CLI_PATH）表示这台机器不发汇总：测试和安装脚本都用它。
export function findSummaryCli(env = process.env) {
  if (env.CODEXHOST_CLI_PATH === '') return undefined;
  return env.CODEXHOST_CLI_PATH || findExecutable('codexhost');
}

function call(cli, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !CLIENT_ENV.includes(key)));
  return new Promise((resolve, reject) => {
    const child = spawn(cli, [...args, '--format', 'json'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = [], errors = [];
    // Host 忙时单次调用可能很慢；超时只让这一次失败，下一分钟再来。
    const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${cli} ${args.slice(0, 2).join(' ')}: ${Buffer.concat(errors).toString().trim() || code}`));
      else resolve(JSON.parse(Buffer.concat(out).toString()));
    });
  });
}

// 负责会话派出去的会话：codexhost 记的委派关系，不从消息里猜。
export async function listChildren(cli, ownerId) {
  return (await call(cli, ['thread', 'list', '--parent', ownerId, '--sort', 'updated-desc', '--limit', '100'])).threads;
}

export async function watchedIds(cli) {
  const { watches } = await call(cli, ['thread', 'watches']);
  return new Set(watches.filter(watch => watch.state === 'watching').map(watch => watch.threadId));
}

// 对方正忙就算没送到，下一分钟再试；不插话。
export async function send(cli, id, message) {
  try {
    await call(cli, ['thread', 'send', id, '--message', message]);
    return true;
  } catch (error) {
    if (/THREAD_BUSY/.test(error.message)) return false;
    throw error;
  }
}
