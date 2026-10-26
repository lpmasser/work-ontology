import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
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
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`服务未能就绪: ${url}`);
}

test('main.mjs: 端口缺失时退出', async () => {
  const serverPath = path.join(import.meta.dirname, 'main.mjs');
  const res = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  res.stderr.setEncoding('utf8');
  res.stderr.on('data', (c) => { stderr += c; });
  const code = await new Promise((resolve) => res.on('close', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /PORT/);
});

test('main.mjs: HTTP 服务端到端测试', async (t) => {
  const port = await getFreePort();
  const testTmpDir = await mkdtemp(path.join(tmpdir(), 'main-test-tmp-'));
  t.after(async () => {
    await rm(testTmpDir, { recursive: true, force: true });
  });

  const serverPath = path.join(import.meta.dirname, 'main.mjs');
  const serverProcess = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(port), TMPDIR: testTmpDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  t.after(() => {
    serverProcess.kill();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/health`);

  // 1. GET /health
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  assert.equal(await healthRes.text(), 'ok');

  // 2. 404 测试
  const notFoundRes = await fetch(`${baseUrl}/unknown-path`);
  assert.equal(notFoundRes.status, 404);

  // 3. 构建临时 git 仓库，包含 >100 字节的中文长路径
  const gitDir = await mkdtemp(path.join(tmpdir(), 'git-test-'));
  t.after(async () => {
    await rm(gitDir, { recursive: true, force: true });
  });

  execFileSync('git', ['init'], { cwd: gitDir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: gitDir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: gitDir });

  await mkdir(path.join(gitDir, 'ontology'), { recursive: true });
  await writeFile(
    path.join(gitDir, 'ontology', 'ontology.json'),
    JSON.stringify(minimalModel, null, 2),
    'utf8'
  );

  const longRelPath =
    'docs/超长中文目录名测试用于验证超过一百字节的路径处理能力/这是一个子目录/这是一篇名称非常长长长长长长长长的中文规范文档.md';
  assert.ok(Buffer.byteLength(longRelPath, 'utf8') > 100);

  await mkdir(path.join(gitDir, path.dirname(longRelPath)), { recursive: true });
  await writeFile(
    path.join(gitDir, longRelPath),
    '---\nontology_id: "standard-1"\nontology_type: "standard"\ntitle: "长路径规范"\nproject_id: "project-1"\n---\n# 正文\n',
    'utf8'
  );

  await writeFile(
    path.join(gitDir, 'docs', 'proj.md'),
    '---\nontology_id: "project-1"\nontology_type: "project"\ntitle: "项目"\n---\n# 正文\n',
    'utf8'
  );

  execFileSync('git', ['add', '.'], { cwd: gitDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: gitDir });

  // 4. 200 测试（无问题）
  const tarBuffer200 = execFileSync(
    'git',
    ['archive', '--format=tar', `--add-virtual-file=.infohub-changed:${longRelPath}`, 'HEAD'],
    { cwd: gitDir }
  );

  const res200 = await fetch(`${baseUrl}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-tar' },
    body: tarBuffer200
  });
  assert.equal(res200.status, 200);
  assert.equal(await res200.text(), '无问题');
  assert.equal((await readdir(testTmpDir)).length, 0);

  // 5. 422 测试（有问题）
  const brokenPath = 'docs/broken.md';
  await writeFile(
    path.join(gitDir, brokenPath),
    '---\nontology_id: "standard-broken"\nontology_type: "standard"\ntitle: "损坏规范"\n---\n# 缺少 project_id\n',
    'utf8'
  );
  execFileSync('git', ['add', '.'], { cwd: gitDir });
  execFileSync('git', ['commit', '-m', 'add broken'], { cwd: gitDir });

  const tarBuffer422 = execFileSync(
    'git',
    ['archive', '--format=tar', `--add-virtual-file=.infohub-changed:${brokenPath}`, 'HEAD'],
    { cwd: gitDir }
  );

  const res422 = await fetch(`${baseUrl}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-tar' },
    body: tarBuffer422
  });
  assert.equal(res422.status, 422);
  const text422 = await res422.text();
  assert.match(text422, new RegExp(`${brokenPath}：`));
  assert.match(text422, /共 1 个问题/);
  assert.equal((await readdir(testTmpDir)).length, 0);

  // A model-only change must report invalid documents outside the diff.
  const modelOnly = execFileSync('git', ['archive', '--format=tar', '--add-virtual-file=.infohub-changed:ontology/ontology.json', 'HEAD'], { cwd: gitDir });
  const modelResult = await fetch(`${baseUrl}/validate`, { method: 'POST', body: modelOnly });
  assert.equal(modelResult.status, 422);
  assert.match(await modelResult.text(), /docs\/broken.md/);

  // 6. 400 测试：缺 .infohub-changed
  const tarWithoutChanged = execFileSync('git', ['archive', '--format=tar', 'HEAD'], {
    cwd: gitDir
  });
  const res400Missing = await fetch(`${baseUrl}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-tar' },
    body: tarWithoutChanged
  });
  assert.equal(res400Missing.status, 400);
  assert.match(await res400Missing.text(), /缺少 \.infohub-changed/);
  assert.equal((await readdir(testTmpDir)).length, 0);

  // 7. 400 测试：tar 解包失败
  const res400Tar = await fetch(`${baseUrl}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-tar' },
    body: Buffer.from('invalid tar stream content')
  });
  assert.equal(res400Tar.status, 400);
  assert.match(await res400Tar.text(), /tar 解包失败/);
  assert.equal((await readdir(testTmpDir)).length, 0);

  // 8. 400 测试：loadVault 抛错（模型缺失）
  const noModelGitDir = await mkdtemp(path.join(tmpdir(), 'git-nomodel-'));
  t.after(async () => {
    await rm(noModelGitDir, { recursive: true, force: true });
  });
  execFileSync('git', ['init'], { cwd: noModelGitDir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: noModelGitDir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: noModelGitDir });
  await writeFile(path.join(noModelGitDir, 'a.md'), 'hello', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: noModelGitDir });
  execFileSync('git', ['commit', '-m', 'nomodel'], { cwd: noModelGitDir });

  const tarNoModel = execFileSync(
    'git',
    ['archive', '--format=tar', '--add-virtual-file=.infohub-changed:a.md', 'HEAD'],
    { cwd: noModelGitDir }
  );
  const res400NoModel = await fetch(`${baseUrl}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-tar' },
    body: tarNoModel
  });
  assert.equal(res400NoModel.status, 400);
  assert.match(await res400NoModel.text(), /模型文件缺失/);
  assert.equal((await readdir(testTmpDir)).length, 0);
});
