// This parser only reads source. It never reserializes Markdown or frontmatter.
import YAML from 'yaml';

export function isISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = Date.parse(value);
  return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === value;
}
export function annotationSummary(content, limit = 50) {
  const chars = [...content.replace(/\s+/g, ' ').trim()];
  return chars.slice(0, limit).join('') + (chars.length > limit ? '…' : '');
}

export function parseAnnotations(body, { path, objectId = null, title = null, lineOffset = 0 } = {}) {
  const lines = body.split(/\r\n|\n|\r/), annotations = [], issues = [];
  let fence = null, comment = false;
  const issue = (line, reason) => issues.push({ path, line, message: `第 ${line} 行批注格式错误：${reason}；规范写法 <!-- 批注 YYYY-MM-DD 作者：内容 -->（也接受半角冒号）` });
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (fence) {
      const close = /^ {0,3}(`+|~+)[\t ]*$/.exec(text);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    if (comment) { if (text.includes('-->')) comment = false; continue; }
    const openingFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (openingFence && (openingFence[1][0] !== '`' || !openingFence[2].includes('`'))) { fence = openingFence[1]; continue; }
    if (!/^[\t ]*<!--[\t ]*批注/.test(text)) {
      // Ordinary HTML comments cannot contain an active nested annotation.
      const start = text.indexOf('<!--');
      if (start >= 0 && !text.slice(start).includes('-->')) comment = true;
      continue;
    }
    const line = i + 1 + lineOffset;
    let end = i;
    while (end < lines.length && !lines[end].includes('-->')) end++;
    if (end === lines.length) { issue(line, '批注未闭合'); break; }
    const block = lines.slice(i, end + 1).join('\n').trim();
    i = end;
    const closing = block.indexOf('-->');
    if (block.slice(closing + 3).trim()) { issue(line, '批注必须单独成行，内容不能含 -->'); continue; }
    const match = /^<!--[\t ]*批注[\t ]+(\S+)[\t ]+([^：:\r\n]*?)[：:]([\s\S]*?)-->$/.exec(block);
    if (!match) { issue(line, '需要日期、作者和冒号'); continue; }
    const [, date, rawAuthor, rawContent] = match, author = rawAuthor.trim(), content = rawContent.trim();
    if (!isISODate(date)) { issue(line, '日期必须是有效的 YYYY-MM-DD'); continue; }
    if (!author) { issue(line, '缺少作者'); continue; }
    if (!content || content.includes('<!--')) { issue(line, '内容不能为空或嵌套 HTML 注释'); continue; }
    annotations.push({ path, objectId, title, line, endLine: end + 1 + lineOffset, date, author, content });
  }
  return { annotations, issues };
}

export function inspectMarkdown(text, path) {
  const match = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  let frontmatter = null;
  const issues = [];
  if (match) {
    try { frontmatter = YAML.parse(match[1]); }
    catch (error) { issues.push({ path, message: `YAML 解析失败: ${error.message}` }); }
  }
  const body = match ? match[2] : text;
  const metadata = frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter) ? frontmatter : {};
  const result = parseAnnotations(body, {
    path, objectId: typeof metadata.ontology_id === 'string' && metadata.ontology_id.trim() ? metadata.ontology_id : null,
    title: typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title : null,
    lineOffset: match ? text.slice(0, text.length - body.length).split(/\r\n|\n|\r/).length - 1 : 0,
  });
  return { frontmatter, body, annotations: result.annotations, issues: [...issues, ...result.issues] };
}
