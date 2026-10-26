import { isUnfinishedWork } from './engine.js';

const STALE_AFTER_DAYS = 7;
const DELIVERY_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

function dateNumber(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return timestamp / DAY_MS;
}

function byUpdated(a, b) {
  const first = dateNumber(a.frontmatter.updated) ?? Infinity;
  const second = dateNumber(b.frontmatter.updated) ?? Infinity;
  return (first === second ? 0 : first - second)
    || a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id);
}

export function buildOverview(index, now = new Date()) {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS;
  const objects = [...index.objects.values()];
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
    if (fm.attention || awaitingDecision || stale) {
      const attention = fm.attention ? [...fm.attention] : null;
      actions.push({
        priority: attention ? 0 : awaitingDecision ? 1 : 2,
        item: {
          object,
          category: attention || !awaitingDecision ? '卡住了' : '等我拍板',
          reason: attention
            ? attention.slice(0, 50).join('') + (attention.length > 50 ? '…' : '')
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
    references: Object.fromEntries(objects.map(({ id, title, path }) => [id, { title, path }])),
    needsAction: actions.sort((a, b) => a.priority - b.priority || byUpdated(a.item.object, b.item.object))
      .map(({ item }) => item),
    projects: [...projects.values()].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id)),
    deliveryWindowDays: DELIVERY_WINDOW_DAYS,
    issues: index.issues,
  };
}
