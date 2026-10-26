import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverview } from './overview.mjs';

const now = new Date(2026, 9, 26, 23, 30);
function object(id, type, frontmatter = {}) {
  return { id, type, title: id, path: `${id}.md`, frontmatter };
}
function work(id, frontmatter = {}) {
  return object(id, 'work_item', { project_id: 'p', requirement: '已明确', progress: '实施中', ...frontmatter });
}
function overview(objects, issues = []) {
  return buildOverview({ objects: new Map(objects.map(item => [item.id, item])), issues }, now);
}

test('action items prioritize explicit attention, pending decisions, then stale work without repeating objects', () => {
  const result = overview([
    work('stale', { updated: '2026-10-01' }),
    work('decision-new', { requirement: '待澄清', updated: '2026-10-20' }),
    work('decision-old', { requirement: '待澄清', updated: '2026-10-02' }),
    work('overlap', { requirement: '待澄清', updated: '2026-10-18', attention: '等待外部决定' }),
    object('attention-old', 'capability', { updated: '2026-10-10', attention: '接口有问题' }),
    work('done-with-attention', { requirement: '待澄清', progress: '已交付', updated: '2026-10-25', attention: '尚待现场验证' }),
    work('cancelled', { requirement: '待澄清', progress: '已取消', updated: '2026-01-01' }),
    work('done', { requirement: '待澄清', progress: '已交付', updated: '2026-01-01' }),
  ]);
  assert.equal(result.version, 3);
  assert.deepEqual(result.needsAction.map(item => [item.object.id, item.category]), [
    ['attention-old', '卡住了'], ['overlap', '卡住了'], ['done-with-attention', '卡住了'],
    ['decision-old', '等我拍板'], ['decision-new', '等我拍板'], ['stale', '卡住了'],
  ]);
  assert.equal(result.needsAction.find(item => item.object.id === 'overlap').reason, '等待外部决定');
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
  const project = result.projects.find(item => item.id === 'p');
  assert.equal(project.ongoingCount, 6);
  assert.deepEqual(project.work.map(item => item.id), ['eight', 'seven', 'not-started', 'missing', 'invalid', 'future']);
  assert.equal(project.deliveredCount, 2);
  assert.equal(result.deliveryWindowDays, 14);
  assert.deepEqual(result.projects.find(item => item.id === 'empty'), {
    id: 'empty', title: 'empty', ongoingCount: 0, deliveredCount: 0, work: [],
  });
});

test('attention keeps its original prefix and full source; unknown dates sort last without creating stale claims', () => {
  const attention = '待核实😀'.repeat(20);
  const result = overview([
    object('unknown', 'material', { attention }),
    object('dated', 'material', { attention: '先处理', updated: '2026-10-25' }),
    work('missing-date'), work('bad-date', { updated: 'yesterday' }),
  ]);
  assert.deepEqual(result.needsAction.map(item => item.object.id), ['dated', 'unknown']);
  assert.equal(result.needsAction[1].reason, [...attention].slice(0, 50).join('') + '…');
  assert.equal(result.needsAction[1].object.frontmatter.attention, attention);
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
