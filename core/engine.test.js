import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateModel, buildIndex, searchAround } from './engine.js';

const model = {
  primaryKey: 'ontology_id',
  folders: ['试点'],
  properties: Object.fromEntries(['ontology_id', 'ontology_type', 'title'].map(field => [field, { required: true }])),
  objectTypes: {
    capability: { label: '能力', properties: {} },
    work_item: { label: '工作', properties: { requirement: { required: true, values: ['待澄清', '已明确'] }, progress: { required: true, values: ['未开始', '实施中', '已交付', '已取消'] }, targets: { type: 'id-list', required: false } } },
    knowledge: { label: '知识', properties: { kind: { required: true, values: ['经验', '决策'] }, applies_to: { type: 'id-list', required: false } } }
  },
  relations: {
    targets: { sourceTypes: ['work_item'], sourceField: 'targets', targetTypes: ['capability'], targetField: 'ontology_id', cardinality: 'many-to-many', required: false, outgoingLabel: '针对的能力', incomingLabel: '相关工作' },
    applies_to: { sourceTypes: ['knowledge'], sourceField: 'applies_to', targetTypes: ['capability'], targetField: 'ontology_id', cardinality: 'many-to-many', required: false, outgoingLabel: '适用的能力', incomingLabel: '适用知识' }
  }
};
const note = (id, type, properties = {}, path = `${id}.md`) => ({
  path, frontmatter: { ontology_id: id, ontology_type: type, title: id,
    ...(type === 'work_item' ? { requirement: '已明确', progress: '未开始' } : {}),
    ...(type === 'knowledge' ? { kind: '决策' } : {}), ...properties }
});
const fixture = () => [
  note('cap-a', 'capability'), note('cap-b', 'capability'),
  note('work-a', 'work_item', { targets: ['cap-a', 'cap-b', 'cap-a'] }),
  note('work-b', 'work_item', { targets: ['cap-a'] }),
  note('lesson', 'knowledge', { applies_to: ['cap-a'] })
];
const query = (notes, options) => searchAround(buildIndex(notes, model), model, options);
const ownershipModel = () => {
  const schema = structuredClone(model);
  for (const definition of Object.values(schema.objectTypes)) {
    definition.properties.project_id = { type: 'id', required: true };
  }
  schema.objectTypes.project = { label: '项目', properties: {} };
  schema.relations.belongs_to = {
    sourceTypes: ['capability', 'work_item', 'knowledge'], sourceField: 'project_id',
    targetTypes: ['project'], targetField: 'ontology_id', cardinality: 'many-to-one',
    outgoingLabel: '所属项目', incomingLabel: '项目中的对象'
  };
  return schema;
};
const ownedNote = (id, type, properties = {}) => note(id, type, { project_id: 'project', ...properties });

test('typed forward and reverse traversal produce distinct object sets', () => {
  const forward = query(fixture(), { ids: ['work-a'], relation: 'targets', direction: 'out' });
  assert.deepEqual(forward.groups[0].objects.map(o => o.id), ['cap-a', 'cap-b']);
  const reverse = query(fixture(), { ids: ['cap-a'], direction: 'in' });
  assert.deepEqual(reverse.groups.map(group => [group.relation, group.total]), [['targets', 2], ['applies_to', 1]]);
  assert.deepEqual(reverse.issues, []);
});

test('set traversal deduplicates shared neighbors and supports another hop', () => {
  const first = query(fixture(), { ids: ['cap-a', 'cap-b'], relation: 'targets', direction: 'in' });
  assert.equal(first.groups[0].total, 2);
  const second = query(fixture(), { ids: first.groups[0].objects.map(o => o.id), relation: 'targets', direction: 'out' });
  assert.deepEqual(second.groups[0].objects.map(o => o.id), ['cap-a', 'cap-b']);
});

test('a new work item may have an empty or absent target list', () => {
  for (const fields of [{}, { targets: [] }]) {
    const result = query([note('new-work', 'work_item', { requirement: '待澄清', progress: '未开始', ...fields })], { ids: ['new-work'] });
    assert.equal(result.groups[0].total, 0);
    assert.deepEqual(result.issues, []);
  }
});

test('invalid foreign keys are reported and never traversed', () => {
  const notes = [note('cap', 'capability'), note('lesson', 'knowledge'),
    note('work', 'work_item', { targets: ['cap', 'missing', 'lesson', 42, ''] })];
  const result = query(notes, { ids: ['work'] });
  assert.deepEqual(result.groups[0].objects.map(o => o.id), ['cap']);
  assert.equal(result.issues.length, 4);
});

test('duplicate primary keys are excluded even when one note has invalid properties', () => {
  const notes = [note('cap', 'capability'), note('cap', 'capability', { title: '' }, 'copy.md'),
    note('work', 'work_item', { targets: ['cap'] })];
  const index = buildIndex(notes, model);
  assert.equal(index.objects.has('cap'), false);
  assert.equal(index.edges.length, 0);
  assert.throws(() => searchAround(index, model, { ids: ['cap'] }), /找不到唯一/);
  assert.ok(index.issues.some(issue => issue.message.includes('主键重复')));
});

test('ordinary references do not become objects or semantic relations', () => {
  const notes = [note('cap', 'capability'), note('work', 'work_item', { ontology_about: 'cap', links: ['cap'] }),
    { path: 'reference.md', frontmatter: { ontology_about: 'cap', title: '参考资料' } }];
  const index = buildIndex(notes, model);
  assert.equal(index.objects.size, 2);
  assert.equal(index.edges.length, 0);
});

test('wrong source types and scalar relation values cannot create links', () => {
  const index = buildIndex([note('cap', 'capability', { targets: ['cap'] }),
    note('work', 'work_item', { targets: 'cap' })], model);
  assert.equal(index.edges.length, 0);
  assert.equal(index.issues.length, 2);
});

test('new snapshots preserve identity across moves and reflect relationship changes', () => {
  const notes = fixture();
  notes[0].path = 'renamed/能力.md';
  notes[2].frontmatter.targets = ['cap-a'];
  const result = query(notes, { ids: ['work-a'] });
  assert.equal(result.groups[0].objects[0].path, 'renamed/能力.md');
  assert.equal(result.groups[0].total, 1);
});

test('unknown start IDs and unsupported query options fail explicitly', () => {
  for (const options of [{ ids: ['missing'] }, { ids: [] }, { ids: ['cap-a'], direction: 'sideways' },
    { ids: ['cap-a'], relation: 'references' }, { ids: ['work-a'], relation: 'targets', direction: 'in' },
    { ids: ['cap-a'], relatoin: 'targets' }]) {
    assert.throws(() => query(fixture(), options));
  }
});

test('missing or misspelled foreign-key mappings cannot look like empty results', () => {
  assert.doesNotThrow(() => validateModel(model));
  for (const change of [{ sourceField: '' }, { sourceField: 'targtes' }, { sourceField: undefined },
    { incomingLabel: '' }, { outgoingLabel: undefined }]) {
    const invalid = structuredClone(model);
    Object.assign(invalid.relations.targets, change);
    assert.throws(() => validateModel(invalid), /无效关系映射：targets/);
  }
});

test('material is independently identified and linked to one or more capabilities', () => {
  const schema = structuredClone(model);
  schema.objectTypes.material = { properties: { supports: { type: 'id-list', required: true, minItems: 1 } } };
  schema.relations.supports = { sourceTypes: ['material'], sourceField: 'supports', targetTypes: ['capability'], targetField: 'ontology_id', cardinality: 'many-to-many', outgoingLabel: '关联能力', incomingLabel: '附属资料' };
  validateModel(schema);
  const index = buildIndex([note('cap-a', 'capability'), note('cap-b', 'capability'),
    note('material-a', 'material', { supports: ['cap-a', 'cap-b'] })], schema);
  const forward = searchAround(index, schema, { ids: ['material-a'], relation: 'supports', direction: 'out' });
  assert.equal(forward.groups[0].total, 2);
  const reverse = searchAround(index, schema, { ids: ['cap-a'], relation: 'supports', direction: 'in' });
  assert.deepEqual(reverse.groups[0].objects.map(o => o.id), ['material-a']);
  assert.deepEqual(index.issues, []);
});

test('material without an associated capability cannot be silently indexed', () => {
  const schema = structuredClone(model);
  schema.objectTypes.material = { properties: { supports: { type: 'id-list', required: true, minItems: 1 } } };
  for (const props of [{}, { supports: [] }]) {
    const index = buildIndex([note('orphan-material', 'material', props)], schema);
    assert.equal(index.objects.size, 0);
    assert.ok(index.issues[0].message.includes('supports'));
  }
});

test('capability dependencies distinguish both directions and traverse one hop at a time', () => {
  const schema = structuredClone(model);
  schema.objectTypes.capability.properties.depends_on = { type: 'id-list', required: false };
  schema.relations.depends_on = {
    sourceTypes: ['capability'], sourceField: 'depends_on', targetTypes: ['capability'],
    targetField: 'ontology_id', cardinality: 'many-to-many',
    outgoingLabel: '依赖的能力', incomingLabel: '被哪些能力依赖'
  };
  validateModel(schema);
  const index = buildIndex([
    note('cap-a', 'capability', { depends_on: ['cap-b'] }),
    note('cap-b', 'capability', { depends_on: ['cap-c'] }),
    note('cap-c', 'capability')
  ], schema);
  const aroundB = searchAround(index, schema, { ids: ['cap-b'], relation: 'depends_on' });
  assert.deepEqual(aroundB.groups.map(g => [g.direction, g.objects.map(o => o.id)]),
    [['out', ['cap-c']], ['in', ['cap-a']]]);
  assert.deepEqual(aroundB.groups.map(g => [g.type, g.label]),
    [['capability', '依赖的能力'], ['capability', '被哪些能力依赖']]);
  const first = searchAround(index, schema, { ids: ['cap-a'], relation: 'depends_on', direction: 'out' });
  assert.deepEqual(first.groups[0].objects.map(o => o.id), ['cap-b']);
  const next = searchAround(index, schema, { ids: first.groups[0].objects.map(o => o.id), relation: 'depends_on', direction: 'out' });
  assert.deepEqual(next.groups[0].objects.map(o => o.id), ['cap-c']);
  const combined = searchAround(index, schema, { ids: ['cap-a', 'cap-b'], relation: 'depends_on', direction: 'out' });
  assert.deepEqual(combined.groups[0].objects.map(o => o.id), ['cap-b', 'cap-c']);
  const empty = searchAround(index, schema, { ids: ['cap-c'], relation: 'depends_on', direction: 'out' });
  assert.deepEqual(empty.groups, [{ relation: 'depends_on', direction: 'out', label: '依赖的能力', type: 'capability', total: 0, objects: [] }]);
  assert.deepEqual(index.issues, []);
});

test('scalar ownership supports multiple source types and typed reverse groups including empty ones', () => {
  const schema = ownershipModel();
  validateModel(schema);
  const index = buildIndex([note('project', 'project'), ownedNote('cap', 'capability'),
    ownedNote('work', 'work_item')], schema);
  const forward = searchAround(index, schema, { ids: ['cap', 'work'], relation: 'belongs_to', direction: 'out' });
  assert.deepEqual(forward.groups.map(g => [g.type, g.label, g.objects.map(o => o.id)]),
    [['project', '所属项目', ['project']]]);
  const reverse = searchAround(index, schema, { ids: ['project'], relation: 'belongs_to', direction: 'in' });
  assert.deepEqual(reverse.groups.map(g => [g.type, g.label, g.objects.map(o => o.id)]), [
    ['capability', '项目中的对象 · 能力', ['cap']],
    ['work_item', '项目中的对象 · 工作', ['work']],
    ['knowledge', '项目中的对象 · 知识', []]
  ]);
  assert.deepEqual(index.issues, []);
});

test('required scalar foreign keys reject missing values, wrong shapes, invalid sources and invalid targets', () => {
  const schema = ownershipModel();
  const notes = [note('project', 'project'), ownedNote('cap', 'capability'),
    note('missing-field', 'work_item'),
    ownedNote('empty-id', 'work_item', { project_id: '' }),
    ownedNote('list-id', 'work_item', { project_id: ['project'] }),
    ownedNote('numeric-id', 'work_item', { project_id: 42 }),
    ownedNote('missing-target', 'work_item', { project_id: 'missing' }),
    ownedNote('wrong-target', 'work_item', { project_id: 'cap' }),
    note('wrong-source', 'project', { project_id: 'project' })];
  const index = buildIndex(notes, schema);
  assert.deepEqual(index.edges, [{ relation: 'belongs_to', source: 'cap', target: 'project' }]);
  for (const id of ['missing-field', 'empty-id', 'list-id', 'numeric-id']) {
    assert.equal(index.objects.has(id), false);
  }
  assert.equal(index.issues.length, 7);
  assert.equal(index.issues.filter(issue => issue.path === 'wrong-source.md').length, 1);
});

test('optional scalar foreign keys may be absent and still enforce target types when present', () => {
  const schema = ownershipModel();
  schema.objectTypes.knowledge.properties.project_id.required = false;
  for (const fields of [{}, { project_id: null }]) {
    const index = buildIndex([note('lesson', 'knowledge', fields)], schema);
    const result = searchAround(index, schema, { ids: ['lesson'], relation: 'belongs_to', direction: 'out' });
    assert.equal(result.groups[0].total, 0);
    assert.deepEqual(index.issues, []);
  }
  const index = buildIndex([ownedNote('cap', 'capability'), note('project', 'project'),
    note('lesson', 'knowledge', { project_id: 'cap' })], schema);
  assert.equal(index.edges.some(edge => edge.source === 'lesson'), false);
  assert.equal(index.issues.length, 1);
});

test('multi-source and multi-target traversal groups actual types and deduplicates each set', () => {
  const schema = ownershipModel();
  schema.objectTypes.work_item.properties.applies_to = { type: 'id-list', required: false };
  Object.assign(schema.relations.applies_to, {
    sourceTypes: ['knowledge', 'work_item'], targetTypes: ['project', 'capability'],
    outgoingLabel: '适用对象', incomingLabel: '适用内容'
  });
  validateModel(schema);
  const index = buildIndex([note('project', 'project'), ownedNote('cap', 'capability'),
    ownedNote('work', 'work_item', { applies_to: ['project', 'cap', 'cap'] }),
    ownedNote('lesson', 'knowledge', { applies_to: ['cap', 'project'] })], schema);
  const forward = searchAround(index, schema, { ids: ['work', 'lesson'], relation: 'applies_to', direction: 'out' });
  assert.deepEqual(forward.groups.map(g => [g.type, g.label, g.objects.map(o => o.id)]), [
    ['project', '适用对象 · 项目', ['project']], ['capability', '适用对象 · 能力', ['cap']]
  ]);
  const reverse = searchAround(index, schema, { ids: forward.groups.flatMap(g => g.objects.map(o => o.id)), relation: 'applies_to', direction: 'in' });
  assert.deepEqual(reverse.groups.map(g => [g.type, g.label, g.objects.map(o => o.id)]), [
    ['knowledge', '适用内容 · 知识', ['lesson']], ['work_item', '适用内容 · 工作', ['work']]
  ]);
  assert.deepEqual(index.issues, []);
});

test('different relations sharing one field only apply to their declared source types', () => {
  const schema = structuredClone(model);
  schema.objectTypes.knowledge.properties.targets = { type: 'id-list', required: false };
  schema.relations.applies_to.sourceField = 'targets';
  validateModel(schema);
  const index = buildIndex([note('cap', 'capability', { targets: ['cap'] }),
    note('work', 'work_item', { targets: ['cap'] }), note('lesson', 'knowledge', { targets: ['cap'] })], schema);
  assert.deepEqual(index.edges, [
    { relation: 'targets', source: 'work', target: 'cap' },
    { relation: 'applies_to', source: 'lesson', target: 'cap' }
  ]);
  assert.equal(index.issues.length, 1);
  assert.equal(index.issues[0].path, 'cap.md');
  assert.match(index.issues[0].message, /targets.*work_item.*knowledge.*capability/);
});

test('relation endpoints must be nonempty declared type arrays with matching foreign-key cardinality', () => {
  for (const change of [
    { sourceTypes: undefined }, { sourceTypes: [] }, { sourceTypes: 'work_item' }, { sourceTypes: ['work_item', 'unknown'] },
    { sourceTypes: ['work_item', 'work_item'] }, { targetTypes: ['capability', 'capability'] },
    { sourceTypes: ['work_item', 'knowledge'] }, { targetTypes: undefined }, { targetTypes: [] },
    { targetTypes: 'capability' }, { targetTypes: ['capability', 'unknown'] },
    { targetField: 'title' }, { cardinality: 'many-to-one' }, { cardinality: 'one-to-many' }
  ]) {
    const schema = structuredClone(model);
    Object.assign(schema.relations.targets, change);
    assert.throws(() => validateModel(schema), /无效关系映射：targets/);
  }
  const schema = ownershipModel();
  schema.objectTypes.knowledge.properties.project_id.type = 'id-list';
  assert.throws(() => validateModel(schema), /无效关系映射：belongs_to/);
  const legacy = structuredClone(model);
  Object.assign(legacy.relations.targets, { sourceType: 'work_item', targetType: 'capability' });
  delete legacy.relations.targets.sourceTypes;
  delete legacy.relations.targets.targetTypes;
  assert.throws(() => validateModel(legacy), /无效关系映射：targets/);
});

test('one source type and foreign-key field cannot be assigned to multiple relation names', () => {
  const schema = structuredClone(model);
  schema.objectTypes.knowledge.properties.targets = { type: 'id-list', required: false };
  schema.relations.also_targets = {
    ...schema.relations.targets, sourceTypes: ['knowledge', 'work_item']
  };
  assert.throws(() => validateModel(schema), /无效关系映射：also_targets.*work_item\.targets.*targets/);
});
