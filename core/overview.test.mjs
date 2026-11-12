import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnnotations } from './annotations.mjs';
import { buildOverview } from './overview.mjs';

const now = new Date(2026, 9, 26, 23, 30);
function object(id, type, frontmatter = {}) {
  return { id, type, title: id, path: `${id}.md`, frontmatter };
}
function work(id, frontmatter = {}) {
  return object(id, 'work_item', { project_id: 'p', progress: '实施中', ...frontmatter });
}
function requirement(id, frontmatter = {}) {
  return object(id, 'requirement', { project_id: 'p', status: '待澄清', ...frontmatter });
}
function overview(objects, issues = [], annotations = [], webUsers = []) {
  return buildOverview({ objects: new Map(objects.map(item => [item.id, item])), issues, annotations }, now, { webUsers });
}
const annotation = (id, content, author = 'agent') => ({ path: `${id}.md`, content, author });

test('action items prioritize Agent work annotations, then pending requirements and stale work', () => {
  const result = overview([
    work('stale', { updated: '2026-10-01' }),
    requirement('decision-new', { updated: '2026-10-20' }),
    requirement('decision-old', { updated: '2026-10-02' }),
    requirement('product', { destination: '进产品', updated: '2026-10-18' }),
    requirement('settled', { status: '已满足', updated: '2026-01-01' }),
    work('overlap', { updated: '2026-10-18' }),
    object('annotated-capability', 'capability', { updated: '2026-10-10' }),
    work('done-annotated', { progress: '已交付', updated: '2026-10-25' }),
    work('user-only', { updated: '2026-10-25' }),
    work('mixed', { updated: '2026-10-26' }),
    work('cancelled', { progress: '已取消', updated: '2026-01-01' }),
    work('done', { progress: '已交付', updated: '2026-01-01' }),
  ], [], [annotation('overlap', '等待外部决定'), annotation('annotated-capability', '接口有问题'),
    annotation('done-annotated', '尚待现场验证'), annotation('user-only', '给 Agent 的话', 'alice'),
    annotation('mixed', '用户不进 reason', 'bob'), annotation('mixed', 'Agent 报告的问题')], ['alice', 'bob']);
  assert.equal(result.version, 3);
  assert.deepEqual(result.needsAction.map(item => [item.object.id, item.category]), [
    ['overlap', '卡住了'], ['done-annotated', '卡住了'], ['mixed', '卡住了'],
    ['decision-old', '等我拍板'], ['product', '等我拍板'], ['decision-new', '等我拍板'], ['stale', '停滞'],
  ]);
  assert.equal(result.needsAction.find(item => item.object.id === 'overlap').reason, '等待外部决定');
  assert.equal(result.needsAction.find(item => item.object.id === 'mixed').reason, 'Agent 报告的问题');
});

test('only undecided or product-bound pending requirements wait for the user', () => {
  const result = overview([
    requirement('empty-destination', { updated: '2026-10-01' }),
    requirement('product', { destination: '进产品', updated: '2026-10-02' }),
    requirement('blank-destination', { destination: '', updated: '2026-10-03' }),
    requirement('custom', { destination: '交付侧定制', updated: '2026-10-04' }),
    requirement('existing', { destination: '已有能力', updated: '2026-10-05' }),
    requirement('clarified', { status: '已明确', updated: '2026-10-06' }),
    requirement('shelved', { status: '搁置', updated: '2026-10-07' }),
    requirement('satisfied', { status: '已满足', updated: '2026-10-08' }),
    requirement('dropped', { status: '不做', updated: '2026-10-09' }),
  ]);
  assert.deepEqual(result.needsAction.map(item => [item.object.id, item.category]), [
    ['empty-destination', '等我拍板'], ['product', '等我拍板'], ['blank-destination', '等我拍板'],
  ]);
});

test('archived objects never need action, whatever their annotations or progress say', () => {
  const archivedWork = work('archived-work', { updated: '2026-01-01' });
  archivedWork.path = '工作/archive/archived-work.md';
  const archivedRequirement = requirement('archived-requirement', { updated: '2026-01-01' });
  archivedRequirement.path = '需求/archive/archived-requirement.md';
  const annotations = parseAnnotations('<!-- 批注 2026-10-25 agent：旧批注 -->', { path: archivedWork.path }).annotations;
  const result = overview([archivedWork, archivedRequirement, work('live-stale', { updated: '2026-10-01' })], [], annotations);
  assert.deepEqual(result.needsAction.map(item => item.object.id), ['live-stale']);
});

test('calendar-day boundaries exclude exactly seven stale days and include delivered work through fourteen days', () => {
  const result = overview([
    object('p', 'project'), object('empty', 'project'),
    work('eight', { updated: '2026-10-18' }),
    work('seven', { updated: '2026-10-19' }),
    work('not-started', { progress: '未开始', updated: '2026-01-01' }),
    work('missing'), work('invalid', { updated: '2026-02-30' }),
    work('future', { updated: '2026-10-27' }),
    ...['2026-10-26', '2026-10-12', '2026-10-11', '2026-10-27'].map(updated =>
      work(`delivered-${updated}`, { progress: '已交付', updated })),
    work('cancelled-recent', { progress: '已取消', updated: '2026-10-26' }),
    object('not-work', 'record', { progress: '已交付', project_id: 'p', updated: '2026-10-26' }),
  ]);
  assert.deepEqual(result.needsAction.map(item => item.object.id), ['eight']);
  assert.equal(result.needsAction[0].category, '停滞');
  const project = result.projects.find(item => item.id === 'p');
  assert.equal(project.ongoingCount, 6);
  assert.deepEqual(project.work.map(item => item.id), ['eight', 'seven', 'not-started', 'missing', 'invalid', 'future']);
  assert.equal(project.deliveredCount, 2);
  assert.equal(result.deliveryWindowDays, 14);
  assert.deepEqual(result.projects.find(item => item.id === 'empty'), {
    id: 'empty', title: 'empty', ongoingCount: 0, deliveredCount: 0, work: [],
  });
});

test('Agent annotation keeps its full source; unknown dates sort last without creating stale claims', () => {
  const content = '待核实😀'.repeat(20);
  const result = overview([
    work('unknown'), work('dated', { updated: '2026-10-25' }),
    work('missing-date'), work('bad-date', { updated: 'yesterday' }),
  ], [], [annotation('unknown', content), annotation('dated', '先处理')]);
  assert.deepEqual(result.needsAction.map(item => item.object.id), ['dated', 'unknown']);
  assert.equal(result.needsAction[1].reason, [...content].slice(0, 50).join('') + '…');
});

test('user-only annotations do not suppress other action rules and old metadata has no compatibility path', () => {
  const result = overview([
    requirement('user-decision'), work('user-stale', { updated: '2026-01-01' }),
    work('old-field', { attention: 'obsolete' }),
  ], [], [annotation('user-decision', 'note', 'alice'), annotation('user-stale', 'note', 'alice')], ['alice']);
  assert.deepEqual(result.needsAction.map(item => [item.object.id, item.category]), [['user-decision', '等我拍板'], ['user-stale', '停滞']]);
});

test('unresolved project references retain work alongside the index issue instead of dropping it', () => {
  const issues = [{ path: 'orphan.md', message: '所属项目无法解析' }];
  const result = overview([work('orphan', { project_id: 'missing-project' })], issues);
  assert.equal(result.projects[0].id, 'missing-project');
  assert.equal(result.projects[0].ongoingCount, 1);
  assert.deepEqual(result.issues, issues);
});


test('the reference map uses every indexed object, preserves exact paths and refreshes titles without reconstructing ontology data', () => {
  const current = object('project-1', 'project');
  current.title = '中文项目'; current.path = '中文 空格/项目 #1.md';
  const result = overview([current, object('capability-1', 'capability')]);
  assert.deepEqual(result.references, {
    'project-1': { title: '中文项目', path: '中文 空格/项目 #1.md' },
    'capability-1': { title: 'capability-1', path: 'capability-1.md' },
  });
  assert.equal(Object.hasOwn(result.references, 'unknown'), false);
  current.title = '新标题'; current.path = '移动/项目.md';
  assert.deepEqual(overview([current]).references, {
    'project-1': { title: '新标题', path: '移动/项目.md' },
  });
});
