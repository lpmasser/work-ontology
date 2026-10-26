import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const minimalModel = {
  folders: ['ontology', 'docs'],
  primaryKey: 'ontology_id',
  properties: {
    ontology_id: { type: 'text', required: true },
    ontology_type: { type: 'text', required: true },
    title: { type: 'text', required: true }
  },
  objectTypes: {
    project: { label: '项目', properties: {} },
    standard: {
      label: '规范',
      properties: {
        project_id: { type: 'id', required: true }
      }
    }
  },
  relations: {
    belongs_to: {
      sourceTypes: ['standard'],
      sourceField: 'project_id',
      targetTypes: ['project'],
      targetField: 'ontology_id',
      cardinality: 'many-to-one',
      outgoingLabel: '所属项目',
      incomingLabel: '项目中的对象'
    }
  }
};

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch { /* the child may still be starting on a cold CI runner */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`服务未能就绪: ${url}`);
}

function runGit(args, cwd) {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.stderr.on('data', (c) => { stderr += c; });
    proc.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

test('pre-receive 钩子测试', async (t) => {
  // 1. 启动验证服务与计数代理
  const serverPort = await getFreePort();
  const serverPath = path.join(import.meta.dirname, '..', 'server', 'main.mjs');
  const serverProcess = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(serverPort) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  t.after(() => {
    serverProcess.kill();
  });

  await waitForServer(`http://127.0.0.1:${serverPort}/health`);

  let requestCount = 0;
  const proxyPort = await getFreePort();
  const proxyServer = http.createServer((req, proxyRes) => {
    if (req.url === '/validate') {
      requestCount++;
    }
    const upstreamReq = http.request(
      {
        host: '127.0.0.1',
        port: serverPort,
        path: req.url,
        method: req.method,
        headers: req.headers
      },
      (upstreamRes) => {
        proxyRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(proxyRes);
      }
    );
    req.pipe(upstreamReq);
  });

  await new Promise((resolve) => proxyServer.listen(proxyPort, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => proxyServer.close(resolve));
  });

  const validateUrl = `http://127.0.0.1:${proxyPort}/validate`;

  // 2. 建立临时裸仓库与工作仓库
  const tempBase = await mkdtemp(path.join(tmpdir(), 'pre-receive-test-'));
  t.after(async () => {
    await rm(tempBase, { recursive: true, force: true });
  });

  const bareRepo = path.join(tempBase, 'bare.git');
  const workRepo = path.join(tempBase, 'work');

  await runGit(['init', '--bare', bareRepo]);
  const hookSource = path.join(import.meta.dirname, 'pre-receive');
  const hookDest = path.join(bareRepo, 'hooks', 'pre-receive');
  await copyFile(hookSource, hookDest);
  await chmod(hookDest, 0o755);

  await runGit(['init', '-b', 'main', workRepo]);
  await runGit(['config', 'user.name', 'test'], workRepo);
  await runGit(['config', 'user.email', 'test@test.com'], workRepo);
  await runGit(['remote', 'add', 'origin', bareRepo], workRepo);

  // 3. 测试 ④: 未配置 infohub.validateUrl 时被拒
  await writeFile(path.join(workRepo, 'README.md'), '# test\n', 'utf8');
  await runGit(['add', '.'], workRepo);
  await runGit(['commit', '-m', 'commit before url config'], workRepo);

  const pushNoUrl = await runGit(['push', 'origin', 'main'], workRepo);
  assert.notEqual(pushNoUrl.status, 0);
  assert.match(pushNoUrl.stderr, /未配置 infohub\.validateUrl，推送被拒绝/);

  // 配置 infohub.validateUrl
  await runGit(['config', 'infohub.validateUrl', validateUrl], bareRepo);

  // 4. 测试 ①: 合规改动被接受
  await mkdir(path.join(workRepo, 'ontology'), { recursive: true });
  await mkdir(path.join(workRepo, 'docs'), { recursive: true });
  await writeFile(
    path.join(workRepo, 'ontology', 'ontology.json'),
    JSON.stringify(minimalModel, null, 2),
    'utf8'
  );
  await writeFile(
    path.join(workRepo, 'docs', 'proj.md'),
    '---\nontology_id: "project-1"\nontology_type: "project"\ntitle: "项目"\n---\n# 正文\n',
    'utf8'
  );
  await writeFile(
    path.join(workRepo, 'docs', 'std.md'),
    '---\nontology_id: "standard-1"\nontology_type: "standard"\ntitle: "合规规范"\nproject_id: "project-1"\n---\n# 正文\n',
    'utf8'
  );
  await runGit(['add', '.'], workRepo);
  await runGit(['commit', '-m', 'add valid docs'], workRepo);

  const countBeforeValid = requestCount;
  const pushValid = await runGit(['push', 'origin', 'main'], workRepo);
  assert.equal(pushValid.status, 0);
  assert.equal(requestCount, countBeforeValid + 1);

  // 5. 测试 ⑤: 推送到非 main 分支不校验
  await runGit(['checkout', '-b', 'feature'], workRepo);
  await writeFile(
    path.join(workRepo, 'docs', 'broken-feature.md'),
    '---\nontology_id: "standard-f"\nontology_type: "standard"\ntitle: "缺少属性"\n---\n',
    'utf8'
  );
  await runGit(['add', '.'], workRepo);
  await runGit(['commit', '-m', 'broken feature commit'], workRepo);

  const countBeforeFeature = requestCount;
  const pushFeature = await runGit(['push', 'origin', 'feature'], workRepo);
  assert.equal(pushFeature.status, 0);
  assert.equal(requestCount, countBeforeFeature);

  // 6. 测试 ③: 只改非 md 文件不触发校验
  await runGit(['checkout', 'main'], workRepo);
  await writeFile(path.join(workRepo, 'notes.txt'), 'plain text change\n', 'utf8');
  await runGit(['add', '.'], workRepo);
  await runGit(['commit', '-m', 'txt change'], workRepo);

  const countBeforeTxt = requestCount;
  const pushTxt = await runGit(['push', 'origin', 'main'], workRepo);
  assert.equal(pushTxt.status, 0);
  assert.equal(requestCount, countBeforeTxt + 1);

  // 7. 测试 ②: 属性缺失的改动被拒，stderr 含问题行
  await writeFile(
    path.join(workRepo, 'docs', 'broken-main.md'),
    '---\nontology_id: "standard-broken"\nontology_type: "standard"\ntitle: "损坏规范"\n---\n',
    'utf8'
  );
  await runGit(['add', '.'], workRepo);
  await runGit(['commit', '-m', 'broken main commit'], workRepo);

  const countBeforeBroken = requestCount;
  const pushBroken = await runGit(['push', 'origin', 'main'], workRepo);
  assert.notEqual(pushBroken.status, 0);
  assert.equal(requestCount, countBeforeBroken + 1);
  assert.match(pushBroken.stderr, /docs\/broken-main\.md：/);
  assert.match(
    pushBroken.stderr,
    /InfoHub 校验未通过，推送被拒绝；本地运行 infohub check <文件> 查看/
  );
});
