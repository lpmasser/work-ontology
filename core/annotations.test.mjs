import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMarkdown, parseAnnotations } from './annotations.mjs';

const example = '<!-- 批注 2026-11-09 lpmasser：修改时间 -->';
test('annotations preserve original document line positions, optional metadata and multiline content', () => {
  const text = '\uFEFF---\r\nontology_id: work-1\r\ntitle: "中文"\r\n---\r\n# 正文\r\n' + example + '\r\n\r\n<!-- 批注 2024-02-29 GPT-6.1 Sol: 多行\r\n第二行 -->\r\n';
  const parsed = inspectMarkdown(text, '中文/a.md');
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.annotations, [
    { path: '中文/a.md', objectId: 'work-1', title: '中文', line: 6, endLine: 6, date: '2026-11-09', author: 'lpmasser', content: '修改时间' },
    { path: '中文/a.md', objectId: 'work-1', title: '中文', line: 8, endLine: 9, date: '2024-02-29', author: 'GPT-6.1 Sol', content: '多行\n第二行' },
  ]);
  const plain = inspectMarkdown('# 文件\n' + example, 'plain.md');
  assert.equal(plain.annotations[0].objectId, null); assert.equal(plain.annotations[0].title, null); assert.equal(plain.annotations[0].line, 2);
});

test('fenced examples, metadata, inline examples and ordinary comments never create annotations or errors', () => {
  const text = ['---', 'note: |', '  '+example, '---', '# Examples', '````markdown', example, '```', '<!-- 批注 bad missing -->', '````', '   ~~~md', example, '   ~~~~', 'text '+example, '<!-- ordinary', example, '-->', example].join('\n');
  const result = inspectMarkdown(text, 'test.md');
  assert.deepEqual(result.issues, []); assert.equal(result.annotations.length, 1); assert.equal(result.annotations[0].line, 18);
});

test('invalid annotations report source line and do not become valid records', () => {
  for (const [text, reason] of [
    ['<!-- 批注 2026-02-29 agent：不存在的日期 -->', '日期'],
    ['<!-- 批注 2026-13-01 agent: bad -->', '日期'],
    ['<!-- 批注 yesterday agent: bad -->', '日期'],
    ['<!-- 批注 2026-11-09 ：缺作者 -->', '作者'],
    ['<!-- 批注 2026-11-09 agent missing colon -->', '冒号'],
    ['<!-- 批注 2026-11-09 agent： -->', '内容'],
    ['<!-- 批注 2026-11-09 agent：未闭合', '未闭合'],
    ['<!-- 批注 2026-11-09 agent：a --> 后续正文', '单独成行'],
    ['<!-- 批注 2026-11-09 agent：a <!-- nested -->', '嵌套'],
  ]) {
    const result = parseAnnotations('# heading\n' + text, { path: 'docs/a.md' });
    assert.equal(result.annotations.length, 0, text); assert.equal(result.issues.length, 1, text);
    assert.equal(result.issues[0].line, 2); assert.match(result.issues[0].message, new RegExp(reason));
  }
});
