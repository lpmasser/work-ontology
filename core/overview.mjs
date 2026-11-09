import { isISODate, annotationSummary } from './annotations.mjs';
import { withObjectUrl } from './links.mjs';

import { isUnfinishedWork } from './engine.js';

const STALE_AFTER_DAYS = 7;
const DELIVERY_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

function dateNumber(value) {
  return isISODate(value) ? Date.parse(value) / DAY_MS : null;
}

function isArchived(path) {
  return path.split('/').includes('archive');
}

function byUpdated(a, b) {
  const first = dateNumber(a.frontmatter.updated) ?? Infinity;
  const second = dateNumber(b.frontmatter.updated) ?? Infinity;
  return (first === second ? 0 : first - second)
    || a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id);
}

export function buildOverview(index, now = new Date(), { webUsers = [], webUrl } = {}) {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS;
  const objects = [...index.objects.values()].map(object => withObjectUrl(object, webUrl));
  const userAuthors = new Set(webUsers), agentAnnotations = new Map();
  for (const annotation of index.annotations || []) {
    if (userAuthors.has(annotation.author)) continue;
    if (!agentAnnotations.has(annotation.path)) agentAnnotations.set(annotation.path, []);
    agentAnnotations.get(annotation.path).push(annotation);
  }
  const projects = new Map(objects.filter(object => object.type === 'project')
    .map(project => [project.id, { id: project.id, title: project.title, ongoingCount: 0, deliveredCount: 0, work: [] }]));
  const actions = [];

  for (const object of objects) {
    const fm = object.frontmatter;
    const updated = dateNumber(fm.updated);
    const age = updated === null ? null : today - updated;
    const unfinished = isUnfinishedWork(object);
    const awaitingDecision = unfinished && fm.requirement === '待澄清';
    const stale = unfinished && fm.progress === '实施中' && age !== null && age > STALE_AFTER_DAYS;
    const annotations = object.type === 'work_item' ? agentAnnotations.get(object.path) || [] : [];
    const blocked = annotations.length > 0;
    // 归档对象已收口，不再作为待处理项；用户批注不会单独产生待处理项。
    if ((blocked || awaitingDecision || stale) && !isArchived(object.path)) {
      actions.push({
        priority: blocked ? 0 : awaitingDecision ? 1 : 2,
        item: {
          object,
          category: blocked ? '卡住了' : awaitingDecision ? '等我拍板' : '停滞',
          reason: blocked
            ? annotationSummary(annotations[0].content)
            : awaitingDecision ? '等你拍板：需求待澄清' : `实施中，${age} 天未更新`,
        },
      });
    }

    const delivered = object.type === 'work_item' && fm.progress === '已交付'
      && age !== null && age >= 0 && age <= DELIVERY_WINDOW_DAYS;
    if (!unfinished && !delivered) continue;
    const id = fm.project_id;
    // Keep work with an unresolved project visible; the index reports the broken reference in issues.
    if (!projects.has(id)) projects.set(id, { id, title: id, ongoingCount: 0, deliveredCount: 0, work: [] });
    const project = projects.get(id);
    if (unfinished) {
      project.work.push(object);
      project.ongoingCount++;
    }
    if (delivered) project.deliveredCount++;
  }

  return {
    version: 3,
    references: Object.fromEntries(objects.map(({ id, title, path, url }) => [id, { title, path, ...(url ? { url } : {}) }])),
    needsAction: actions.sort((a, b) => a.priority - b.priority || byUpdated(a.item.object, b.item.object))
      .map(({ item }) => item),
    projects: [...projects.values()].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id)),
    deliveryWindowDays: DELIVERY_WINDOW_DAYS,
    issues: index.issues,
  };
}
