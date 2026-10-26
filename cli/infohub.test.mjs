import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from './infohub.mjs';

const testModel = {
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
        project_id: { type: 'id', required: true },
        use_when: { type: 'text', required: false },
        applies_to: { type: 'id-list', required: false }
      }
    },
    method: {
      label: '工作方法',
      properties: {
        project_id: { type: 'id', required: true },
        use_when: { type: 'text', required: false },
        applies_to: { type: 'id-list', required: false }
      }
    },
    work_item: {
      label: '工作',
      properties: {
        project_id: { type: 'id', required: true },
        requirement: { type: 'text', required: true, values: ['待澄清', '已明确'] },
        progress: { type: 'text', required: true, values: ['未开始', '实施中', '已交付', '已取消'] },
        targets: { type: 'id-list', required: false }
      }
    },
    knowledge: {
      label: '知识',
      properties: {
        project_id: { type: 'id', required: true },
        applies_to: { type: 'id-list', required: false }
      }
    },
    capability: {
      label: '能力',
      properties: {
        project_id: { type: 'id', required: true },
        attention: { type: 'text', required: false }
      }
    }
  },
  relations: {
    belongs_to: {
      sourceTypes: ['standard', 'method', 'work_item', 'capability', 'knowledge'],
      sourceField: 'project_id',
      targetTypes: ['project'],
      targetField: 'ontology_id',
      cardinality: 'many-to-one',
      outgoingLabel: '所属项目',
      incomingLabel: '项目中的对象'
    },
    applies_to: {
      sourceTypes: ['standard', 'method', 'knowledge'],
      sourceField: 'applies_to',
      targetTypes: ['project', 'capability'],
      targetField: 'ontology_id',
      cardinality: 'many-to-many',
      outgoingLabel: '适用对象',
      incomingLabel: '适用内容'
    },
    targets: {
      sourceTypes: ['work_item'],
      sourceField: 'targets',
      targetTypes: ['project', 'capability'],
      targetField: 'ontology_id',
      cardinality: 'many-to-many',
      outgoingLabel: '针对的对象',
      incomingLabel: '相关工作'
    }
  }
};

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'infohub-cli-test-'));
  await mkdir(path.join(root, 'ontology'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });

  await writeFile(
    path.join(root, 'ontology', 'ontology.json'),
    JSON.stringify(testModel, null, 2),
    'utf8'
  );

  // 项目 1 与项目 2
  await writeFile(
    path.join(root, 'docs', 'proj1.md'),
    '---\nontology_id: "project-1"\nontology_type: "project"\ntitle: "Alpha项目"\n---\n# Alpha项目入口\n',
    'utf8'
  );
  await writeFile(
    path.join(root, 'docs', 'proj2.md'),
    '---\nontology_id: "project-2"\nontology_type: "project"\ntitle: "Beta项目"\n---\n# Beta项目入口\n',
    'utf8'
  );

  // 能力 (属于项目 1，带 attention)
  await writeFile(
    path.join(root, 'docs', 'cap1.md'),
    '---\nontology_id: "cap-1"\nontology_type: "capability"\ntitle: "核心计算能力"\nproject_id: "project-1"\nattention: "注意内存泄露"\n---\n# 核心计算能力正文\n',
    'utf8'
  );

  // 规范 1 (直接属于项目 1)
  await writeFile(
    path.join(root, 'docs', 'std1.md'),
    '---\nontology_id: "std-1"\nontology_type: "standard"\ntitle: "Alpha编码规范"\nproject_id: "project-1"\nuse_when: "改 Alpha 代码时"\n---\n# 规范正文\n',
    'utf8'
  );

  // 知识 1 (属于项目 2，applies_to 指向项目 1 的 cap-1)；知识 2 与项目 1 无关
  await writeFile(
    path.join(root, 'docs', 'k1.md'),
    '---\nontology_id: "k-1"\nontology_type: "knowledge"\ntitle: "校验要放在高成本之前"\nproject_id: "project-2"\napplies_to:\n  - "cap-1"\n---\n# 校验要放在高成本之前\n',
    'utf8'
  );
  await writeFile(
    path.join(root, 'docs', 'k2.md'),
    '---\nontology_id: "k-2"\nontology_type: "knowledge"\ntitle: "无关知识"\nproject_id: "project-2"\n---\n# 无关知识\n',
    'utf8'
  );

  // 规范 2 (属于项目 2，但 applies_to 包含属于项目 1 的 cap-1)
  await writeFile(
    path.join(root, 'docs', 'std2.md'),
    '---\nontology_id: "std-2"\nontology_type: "standard"\ntitle: "通用跨项目规范"\nproject_id: "project-2"\napplies_to:\n  - "cap-1"\n---\n# 跨项目规范\n',
    'utf8'
  );

  // 方法 1 (带 use_when)
  await writeFile(
    path.join(root, 'docs', 'method1.md'),
    '---\nontology_id: "method-1"\nontology_type: "method"\ntitle: "发布流程"\nproject_id: "project-1"\nuse_when: "准备发版时"\n---\n# 发布流程正文\n',
    'utf8'
  );

  // 方法 2 (不带 use_when)
  await writeFile(
    path.join(root, 'docs', 'method2.md'),
    '---\nontology_id: "method-2"\nontology_type: "method"\ntitle: "应急排障"\nproject_id: "project-1"\n---\n# 排障正文\n',
    'utf8'
  );

  // 工作项 1 (实施中)
  await writeFile(
    path.join(root, 'docs', 'work1.md'),
    '---\nontology_id: "work-1"\nontology_type: "work_item"\ntitle: "重构引擎"\nproject_id: "project-1"\nrequirement: "已明确"\nprogress: "实施中"\ntargets:\n  - "cap-1"\n---\n# 引擎重构内容\n',
    'utf8'
  );

  // 工作项 2 (待澄清 / 未开始)
  await writeFile(
    path.join(root, 'docs', 'work2.md'),
    '---\nontology_id: "work-2"\nontology_type: "work_item"\ntitle: "新增接口"\nproject_id: "project-1"\nrequirement: "待澄清"\nprogress: "未开始"\n---\n# 接口内容\n',
    'utf8'
  );

  // 工作项 3 (待澄清 / 已取消 -> 不应在进行中列出)
  await writeFile(
    path.join(root, 'docs', 'work3.md'),
    '---\nontology_id: "work-3"\nontology_type: "work_item"\ntitle: "废弃特性"\nproject_id: "project-1"\nrequirement: "待澄清"\nprogress: "已取消"\n---\n# 废弃内容\n',
    'utf8'
  );

  // 坏 YAML 文件
  await writeFile(
    path.join(root, 'docs', 'bad.md'),
    '---\nontology_id: [broken yaml\n---\n',
    'utf8'
  );

  return root;
}

async function runCli(argv, envHome = null) {
  const origLog = console.log;
  const origError = console.error;
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const origHome = process.env[homeKey];

  const logs = [];
  const errors = [];
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  if (envHome) process.env[homeKey] = envHome;

  try {
    const code = await main(argv);
    return { code, stdout: logs.join('\n'), stderr: errors.join('\n') };
  } catch (err) {
    return { code: 1, error: err, stdout: logs.join('\n'), stderr: err.message };
  } finally {
    console.log = origLog;
    console.error = origError;
    if (envHome) process.env[homeKey] = origHome;
  }
}

test('brief outputs all 5 sections with correct filtering rules', async () => {
  const root = await createFixture();
  try {
    // 1. 通过 ID 精确匹配
    const res = await runCli(['--root', root, 'brief', 'project-1']);
    assert.equal(res.code, 0);

    // ① 项目入口
    assert.ok(res.stdout.includes('项目入口: docs/proj1.md'));

    // ② 适用规范: std-1 (project_id 匹配) 和 std-2 (applies_to 属于该项目的 cap-1)
    assert.ok(res.stdout.includes('Alpha编码规范 — 改 Alpha 代码时 — docs/std1.md'));
    assert.ok(res.stdout.includes('通用跨项目规范 — 未写何时使用 — docs/std2.md'));

    // ③ 工作方法: method-1 (带 use_when) 与 method-2 (未写何时使用)
    assert.ok(res.stdout.includes('发布流程 — 准备发版时 — docs/method1.md'));
    assert.ok(res.stdout.includes('应急排障 — 未写何时使用 — docs/method2.md'));

    // ④ 进行中的工作: work-1 (实施中) 和 work-2 (待澄清且未交付/未取消)，不含 work-3 (已取消)
    assert.ok(res.stdout.includes('重构引擎 [已明确/实施中] — docs/work1.md'));
    assert.ok(res.stdout.includes('新增接口 [待澄清/未开始] — docs/work2.md'));
    assert.ok(!res.stdout.includes('废弃特性'));

    // 相关知识: k-1 (applies_to 指向项目 1 的 cap-1)，不含与项目 1 无关的 k-2
    assert.ok(res.stdout.includes('相关知识:'));
    assert.ok(res.stdout.includes('校验要放在高成本之前 — docs/k1.md'));
    assert.ok(!res.stdout.includes('无关知识'));

    // ⑤ 需关注: cap-1 (attention: 注意内存泄露)
    assert.ok(res.stdout.includes('核心计算能力：注意内存泄露 — docs/cap1.md'));

    // 2. 通过 title 精确匹配
    const resTitle = await runCli(['--root', root, 'brief', 'Alpha项目']);
    assert.equal(resTitle.code, 0);
    assert.ok(resTitle.stdout.includes('项目入口: docs/proj1.md'));

    // 3. 项目不存在时报错并列出全部项目
    const resMissing = await runCli(['--root', root, 'brief', 'NonExistent']);
    assert.equal(resMissing.code, 1);
    assert.ok(resMissing.stderr.includes('找不到项目 "NonExistent"'));
    assert.ok(resMissing.stderr.includes('project-1'));
    assert.ok(resMissing.stderr.includes('project-2'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('find filters by type, project, where clauses, text, and handles intersections', async () => {
  const root = await createFixture();
  try {
    // 按 type
    const resType = await runCli(['--root', root, 'find', '--type', 'standard']);
    assert.equal(resType.code, 0);
    assert.ok(resType.stdout.includes('std-1'));
    assert.ok(resType.stdout.includes('std-2'));
    assert.ok(resType.stdout.includes('共 2 个对象'));

    // 按 project (ID 或 title)
    const resProj = await runCli(['--root', root, 'find', '--project', 'Alpha项目']);
    assert.equal(resProj.code, 0);
    assert.ok(resProj.stdout.includes('std-1'));
    assert.ok(!resProj.stdout.includes('std-2'));

    // 按 where (单值与数组)
    const resWhere = await runCli(['--root', root, 'find', '--where', 'progress=实施中']);
    assert.equal(resWhere.code, 0);
    assert.ok(resWhere.stdout.includes('work-1'));
    assert.ok(!resWhere.stdout.includes('work-2'));

    const resWhereList = await runCli(['--root', root, 'find', '--where', 'applies_to=cap-1']);
    assert.equal(resWhereList.code, 0);
    assert.ok(resWhereList.stdout.includes('std-2'));

    // 交集过滤
    const resMulti = await runCli([
      '--root', root, 'find',
      '--type', 'work_item',
      '--where', 'requirement=待澄清',
      '--where', 'progress=未开始'
    ]);
    assert.equal(resMulti.code, 0);
    assert.ok(resMulti.stdout.includes('work-2'));
    assert.ok(!resMulti.stdout.includes('work-1'));
    assert.ok(!resMulti.stdout.includes('work-3'));

    // 文本搜索 (title 或 body)
    const resText = await runCli(['--root', root, 'find', '排障正文']);
    assert.equal(resText.code, 0);
    assert.ok(resText.stdout.includes('method-2'));

    // 无条件时报错
    const resNoCond = await runCli(['--root', root, 'find']);
    assert.equal(resNoCond.code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('around traverses relations with outgoing/incoming direction and path resolution', async () => {
  const root = await createFixture();
  try {
    // 以 ID 查询
    const resId = await runCli(['--root', root, 'around', 'cap-1']);
    assert.equal(resId.code, 0);
    assert.ok(resId.stdout.includes('所属项目 (1)'));
    assert.ok(resId.stdout.includes('适用内容 · 规范 (1)'));
    assert.ok(resId.stdout.includes('相关工作 (1)'));

    // 以 .md 路径解析
    const resPath = await runCli(['--root', root, 'around', 'docs/cap1.md']);
    assert.equal(resPath.code, 0);
    assert.ok(resPath.stdout.includes('project-1'));

    // 带 --direction outgoing
    const resOut = await runCli(['--root', root, 'around', 'cap-1', '--direction', 'outgoing']);
    assert.equal(resOut.code, 0);
    assert.ok(resOut.stdout.includes('所属项目 (1)'));
    assert.ok(!resOut.stdout.includes('适用内容 · 规范'));

    // 带 --direction incoming
    const resIn = await runCli(['--root', root, 'around', 'cap-1', '--direction', 'incoming']);
    assert.equal(resIn.code, 0);
    assert.ok(!resIn.stdout.includes('所属项目'));
    assert.ok(resIn.stdout.includes('适用内容 · 规范 (1)'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('get displays path and properties', async () => {
  const root = await createFixture();
  try {
    const res = await runCli(['--root', root, 'get', 'method-1']);
    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes('路径: docs/method1.md'));
    assert.ok(res.stdout.includes('ontology_id: method-1'));
    assert.ok(res.stdout.includes('use_when: 准备发版时'));

    // 用 .md 路径
    const resByPath = await runCli(['--root', root, 'get', 'docs/method1.md']);
    assert.equal(resByPath.code, 0);
    assert.ok(resByPath.stdout.includes('ontology_id: method-1'));

    // 不存在的对象报错
    const resMissing = await runCli(['--root', root, 'get', 'not-exist']);
    assert.equal(resMissing.code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('check returns exit code 1 on issues and exit code 0 when clean', async () => {
  const root = await createFixture();
  try {
    // 全库 check，包含 bad.md，退出码 1
    const resAll = await runCli(['--root', root, 'check']);
    assert.equal(resAll.code, 1);
    assert.ok(resAll.stdout.includes('docs/bad.md'));
    assert.ok(resAll.stdout.includes('YAML 解析失败'));

    // 只检查有问题的路径
    const resBad = await runCli(['--root', root, 'check', path.join(root, 'docs/bad.md')]);
    assert.equal(resBad.code, 1);
    assert.ok(resBad.stdout.includes('docs/bad.md'));

    // 检查干净的文件
    const resClean = await runCli(['--root', root, 'check', path.join(root, 'docs/proj1.md')]);
    assert.equal(resClean.code, 0);
    assert.ok(resClean.stdout.includes('无问题'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('root source resolves from --root, config file, or fails with error', async () => {
  const root = await createFixture();
  const tmpHome = await mkdtemp(path.join(tmpdir(), 'home-cli-'));
  try {
    // 1. 无 --root 且无 config 文件：报错
    const resFail = await runCli(['get', 'project-1'], tmpHome);
    assert.equal(resFail.code, 1);
    assert.ok(resFail.stderr.includes('未指定 InfoHub 根目录'));

    // 2. 写入 config 文件：成功读取
    await mkdir(path.join(tmpHome, '.config', 'infohub'), { recursive: true });
    await writeFile(
      path.join(tmpHome, '.config', 'infohub', 'config.json'),
      JSON.stringify({ root }),
      'utf8'
    );
    const resConfig = await runCli(['get', 'project-1'], tmpHome);
    assert.equal(resConfig.code, 0);
    assert.ok(resConfig.stdout.includes('ontology_id: project-1'));

    // 3. --root 覆盖 config
    const resRoot = await runCli(['--root', root, 'get', 'project-1'], tmpHome);
    assert.equal(resRoot.code, 0);
    assert.ok(resRoot.stdout.includes('ontology_id: project-1'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(tmpHome, { recursive: true, force: true });
  }
});

test('desktop queries share find semantics and expose issues without parsing text output', async () => {
  const root = await createFixture();
  try {
    const args = ['--root', root, 'find', '--type', 'work_item', '--where-not', 'progress=已交付', '--where-not', 'progress=已取消'];
    const plain = await runCli(args);
    const result = await runCli([...args, '--json']);
    assert.equal(result.code, 0);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.version, 1);
    assert.deepEqual(snapshot.objects.map(o => o.id), ['work-1', 'work-2']);
    assert.ok(plain.stdout.includes(`共 ${snapshot.objects.length} 个对象`));
    assert.equal(snapshot.objects[0].frontmatter.progress, '实施中');
    assert.ok(snapshot.issues.some(issue => issue.path === 'docs/bad.md'));
    const attention = JSON.parse((await runCli(['--root', root, 'find', '--has', 'attention', '--json'])).stdout);
    assert.deepEqual(attention.objects.map(o => o.path), ['docs/cap1.md']);
    await rm(path.join(root, 'docs', 'cap1.md'));
    assert.deepEqual(JSON.parse((await runCli(['--root', root, 'find', '--has', 'attention', '--json'])).stdout).objects, []);
    assert.equal((await runCli(['--root', root, 'find', '--typo', '--json'])).code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('overview projects share unfinished find semantics, expose action items and reload changed documents', async () => {
  const root = await createFixture();
  try {
    const result = await runCli(['--root', root, 'overview']);
    assert.equal(result.code, 0);
    const overview = JSON.parse(result.stdout);
    const found = JSON.parse((await runCli(['--root', root, 'find', '--type', 'work_item', '--where-not', 'progress=已交付', '--where-not', 'progress=已取消', '--json'])).stdout);
    assert.equal(overview.version, 3);
    assert.deepEqual(overview.projects.flatMap(project => project.work), found.objects);
    assert.deepEqual(overview.projects.map(project => project.ongoingCount), [2, 0]);
    assert.deepEqual(overview.needsAction.map(item => item.object.id), ['cap-1', 'work-2']);
    assert.deepEqual(overview.issues, found.issues);
    await rm(path.join(root, 'docs', 'work2.md'));
    await rm(path.join(root, 'docs', 'cap1.md'));
    const changed = JSON.parse((await runCli(['--root', root, 'overview'])).stdout);
    assert.deepEqual(changed.projects.flatMap(project => project.work).map(o => o.id), ['work-1']);
    assert.deepEqual(changed.needsAction, []);
    assert.equal(Object.hasOwn(changed.references, 'work-2'), false);
    assert.equal(Object.hasOwn(changed.references, 'cap-1'), false);
    assert.deepEqual(changed.references['work-1'], { title: '重构引擎', path: 'docs/work1.md' });
    assert.ok(changed.issues.some(issue => issue.path === 'docs/bad.md'));
    assert.equal((await runCli(['--root', root, 'overview', '--typo'])).code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('check resolves cwd-relative and absolute paths and rejects missing, outside or unmodeled paths', async t => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const bad = path.join(root, 'docs/bad.md');
  for (const input of [bad, path.relative(process.cwd(), bad)]) {
    const result = await runCli(['--root', root, 'check', input]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /YAML 解析失败/);
  }
  await writeFile(path.join(root, 'outside.md'), '# outside model');
  for (const input of [path.join(root, 'missing.md'), path.join(root, 'outside.md'), import.meta.filename]) {
    const result = await runCli(['--root', root, 'check', input]);
    assert.equal(result.code, 1);
    assert.ok(result.stderr);
    assert.ok(!result.stdout.includes('无问题'));
  }
  const model = await runCli(['--root', root, 'check', path.join(root, 'ontology/ontology.json')]);
  assert.equal(model.code, 1);
  assert.match(model.stdout, /docs\/bad.md/);
});

test('brief and overview include every nonterminal work item independent of requirement', async t => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'docs/ready.md'), '---\nontology_id: ready\nontology_type: work_item\ntitle: Ready work\nproject_id: project-1\nrequirement: 已明确\nprogress: 未开始\n---\n');
  const brief = await runCli(['--root', root, 'brief', 'project-1']);
  const overview = JSON.parse((await runCli(['--root', root, 'overview'])).stdout);
  assert.match(brief.stdout, /Ready work/);
  assert.ok(overview.projects.flatMap(project => project.work).some(o => o.id === 'ready'));
  assert.deepEqual(Object.keys(overview).sort(), ['deliveryWindowDays', 'issues', 'needsAction', 'projects', 'references', 'version']);
});

test('subprocess flushes large UTF-8 JSON to a pipe before exit', async t => {
  const { spawn } = await import('node:child_process');
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const title = '完整中文输出'.repeat(30000);
  await writeFile(path.join(root, 'docs/large.md'), `---\nontology_id: large\nontology_type: project\ntitle: ${title}\n---\n`);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'infohub.mjs'), '--root', root, 'overview']);
  const chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, stderr);
  const bytes = Buffer.concat(chunks);
  assert.ok(bytes.length > 65536);
  const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  assert.equal(result.projects.find(o => o.id === 'large').title, title);
});
