import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateTree } from './validation.mjs';

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

async function createFixtureVault() {
  const root = await mkdtemp(path.join(tmpdir(), 'validate-test-'));
  await mkdir(path.join(root, 'ontology'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });

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
    path.join(root, 'docs', 'valid.md'),
    '---\nontology_id: "standard-1"\nontology_type: "standard"\ntitle: "合规规范"\nproject_id: "project-1"\n---\n# 规范正文\n',
    'utf8'
  );

  await writeFile(
    path.join(root, 'docs', 'invalid1.md'),
    '---\nontology_id: "standard-2"\nontology_type: "standard"\ntitle: "缺失属性规范1"\n---\n# 缺失 project_id\n',
    'utf8'
  );

  await writeFile(
    path.join(root, 'docs', 'invalid2.md'),
    '---\nontology_id: "standard-3"\nontology_type: "standard"\ntitle: "缺失属性规范2"\n---\n# 缺失 project_id\n',
    'utf8'
  );

  return root;
}

test('validateTree: 只返回改动清单内文件的问题，清单外问题被忽略', async () => {
  const root = await createFixtureVault();
  try {
    const issues = await validateTree(root, ['docs/invalid1.md']);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].path, 'docs/invalid1.md');
    assert.match(issues[0].message, /属性缺失/);

    const validIssues = await validateTree(root, ['docs/valid.md']);
    assert.equal(validIssues.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validateTree: 模型无效时原样抛错', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'validate-invalid-model-'));
  try {
    await assert.rejects(
      () => validateTree(root, ['docs/proj.md']),
      (err) => err.message.includes('模型文件缺失')
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model changes validate all documents; unrelated files do not load the model', async t => {
  const root = await createFixtureVault();
  t.after(() => rm(root, { recursive: true, force: true }));
  const issues = await validateTree(root, ['ontology/ontology.json']);
  assert.deepEqual(issues.map(i => i.path).sort(), ['docs/invalid1.md', 'docs/invalid2.md']);
  await rm(path.join(root, 'ontology/ontology.json'));
  assert.deepEqual(await validateTree(root, ['image.png']), []);
});
