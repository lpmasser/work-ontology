import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadVault } from './vault.mjs';

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
        project_id: { type: 'id', required: true },
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
        progress: { type: 'text', required: true, values: ['未开始', '实施中', '已交付', '已取消'] }
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
      sourceTypes: ['standard', 'method', 'work_item', 'capability'],
      sourceField: 'project_id',
      targetTypes: ['project'],
      targetField: 'ontology_id',
      cardinality: 'many-to-one',
      outgoingLabel: '所属项目',
      incomingLabel: '项目中的对象'
    },
    applies_to: {
      sourceTypes: ['standard', 'method'],
      sourceField: 'applies_to',
      targetTypes: ['project', 'capability'],
      targetField: 'ontology_id',
      cardinality: 'many-to-many',
      outgoingLabel: '适用对象',
      incomingLabel: '适用内容'
    }
  }
};

async function createFixtureVault() {
  const root = await mkdtemp(path.join(tmpdir(), 'vault-test-'));
  await mkdir(path.join(root, 'ontology'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'sub'), { recursive: true });
  await mkdir(path.join(root, 'docs', '.hidden'), { recursive: true });

  await writeFile(
    path.join(root, 'ontology', 'ontology.json'),
    JSON.stringify(minimalModel, null, 2),
    'utf8'
  );

  await writeFile(
    path.join(root, 'docs', 'proj.md'),
    '---\nontology_id: "project-1"\nontology_type: "project"\ntitle: "示例项目"\n---\n# 示例项目\n',
    'utf8'
  );

  await writeFile(
    path.join(root, 'docs', 'sub', 'std.md'),
    '---\nontology_id: "standard-1"\nontology_type: "standard"\ntitle: "编码规范"\nproject_id: "project-1"\n---\n# 规范正文\n',
    'utf8'
  );

  await writeFile(
    path.join(root, 'docs', 'method.md'),
    '---\nontology_id: "method-1"\nontology_type: "method"\ntitle: "发版方法"\nproject_id: "project-1"\nuse_when: "发版时读"\n---\n# 方法正文\n',
    'utf8'
  );

  await writeFile(
    path.join(root, 'docs', 'work.md'),
    '---\nontology_id: "work_item-1"\nontology_type: "work_item"\ntitle: "CLI开发"\nproject_id: "project-1"\nrequirement: "已明确"\nprogress: "实施中"\n---\n# 工作正文\n',
    'utf8'
  );

  await writeFile(
    path.join(root, 'docs', 'cap.md'),
    '---\nontology_id: "capability-1"\nontology_type: "capability"\ntitle: "命令行核心"\nproject_id: "project-1"\nattention: "注意并发"\n---\n# 能力正文\n',
    'utf8'
  );

  await writeFile(
    path.join(root, 'docs', 'bad_yaml.md'),
    '---\nontology_id: [broken yaml\n---\n# 坏的yaml\n',
    'utf8'
  );

  await writeFile(
    path.join(root, 'docs', 'plain.md'),
    '# 普通 Markdown\n没有属性头\n',
    'utf8'
  );

  await writeFile(
    path.join(root, 'docs', '.hidden', 'ignored.md'),
    '---\nontology_id: "ignored-1"\nontology_type: "project"\ntitle: "忽略"\n---\n',
    'utf8'
  );

  return root;
}

test('loadVault reads model, parses frontmatter and normalizes path separators', async () => {
  const root = await createFixtureVault();
  try {
    const { model, index, notes } = await loadVault(root);
    assert.equal(model.primaryKey, 'ontology_id');
    assert.equal(index.objects.size, 5);
    assert.ok(index.objects.has('project-1'));
    assert.ok(index.objects.has('standard-1'));
    assert.ok(index.objects.has('method-1'));
    assert.ok(index.objects.has('work_item-1'));
    assert.ok(index.objects.has('capability-1'));

    // Check all paths use '/'
    for (const note of notes) {
      assert.ok(!note.path.includes('\\'));
      assert.ok(note.path.startsWith('docs/'));
    }

    // Ignored and plain files not in notes
    assert.ok(!notes.some(n => n.path.includes('.hidden')));
    assert.ok(!notes.some(n => n.path.endsWith('plain.md')));

    // Bad YAML is recorded in index.issues
    const yamlIssue = index.issues.find(i => i.path === 'docs/bad_yaml.md');
    assert.ok(yamlIssue);
    assert.match(yamlIssue.message, /YAML 解析失败/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadVault throws path-bearing errors on missing model, invalid JSON, or invalid schema', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vault-error-'));
  try {
    // Missing model
    await assert.rejects(
      () => loadVault(root),
      err => err.message.includes('模型文件缺失') && err.message.includes(root)
    );

    // Invalid JSON
    await mkdir(path.join(root, 'ontology'), { recursive: true });
    await writeFile(path.join(root, 'ontology', 'ontology.json'), '{ broken json', 'utf8');
    await assert.rejects(
      () => loadVault(root),
      err => err.message.includes('模型文件 JSON 无效') && err.message.includes(root)
    );

    // Invalid schema
    await writeFile(path.join(root, 'ontology', 'ontology.json'), '{"folders": []}', 'utf8');
    await assert.rejects(
      () => loadVault(root),
      err => err.message.includes('模型定义校验失败') && err.message.includes(root)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
