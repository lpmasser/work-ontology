function validateModel(model) {
  if (!Array.isArray(model.folders) || !model.folders.length || !model.primaryKey || !model.objectTypes || !model.relations) {
    throw new Error('本体定义缺少检索目录、主键、对象类或关系定义');
  }
  const validTypes = types => Array.isArray(types) && types.length
    && new Set(types).size === types.length
    && types.every(type => typeof type === 'string' && Object.hasOwn(model.objectTypes, type));
  const sourceFields = new Map();
  for (const [name, relation] of Object.entries(model.relations)) {
    const fieldType = { 'many-to-one': 'id', 'many-to-many': 'id-list' }[relation.cardinality];
    if (!validTypes(relation.sourceTypes) || !validTypes(relation.targetTypes)
      || typeof relation.sourceField !== 'string' || !relation.sourceField.trim()
      || !fieldType || !relation.sourceTypes.every(type =>
        model.objectTypes[type]?.properties?.[relation.sourceField]?.type === fieldType)
      || ![relation.outgoingLabel, relation.incomingLabel].every(label => typeof label === 'string' && label.trim())
      || relation.targetField !== model.primaryKey) {
      throw new Error(`无效关系映射：${name}；请检查两端类型、已声明的 ID 外键与基数、目标主键及正反向名称`);
    }
    for (const type of relation.sourceTypes) {
      if (!sourceFields.has(type)) sourceFields.set(type, new Map());
      const fields = sourceFields.get(type);
      if (fields.has(relation.sourceField)) {
        throw new Error(`无效关系映射：${name}；${type}.${relation.sourceField} 已用于关系 ${fields.get(relation.sourceField)}`);
      }
      fields.set(relation.sourceField, name);
    }
  }
}

function objectInfo(object) {
  const { frontmatter, ...info } = object;
  return info;
}

function buildIndex(notes, model) {
  const objects = new Map();
  const seenIds = new Map();
  const duplicates = new Set();
  const edges = [];
  const issues = [];
  const issue = (path, message) => issues.push({ path, message });

  for (const { path, frontmatter: fm } of notes) {
    if (!fm || (fm[model.primaryKey] == null && fm.ontology_type == null)) continue;
    const id = fm[model.primaryKey];
    if (typeof id === 'string' && id.trim()) {
      if (seenIds.has(id)) {
        duplicates.add(id);
        issue(path, `主键重复：${id}（另见 ${seenIds.get(id)}）`);
      } else seenIds.set(id, path);
    }
    const definition = Object.hasOwn(model.objectTypes, fm.ontology_type) ? model.objectTypes[fm.ontology_type] : null;
    if (!definition) {
      issue(path, `未知对象类：${fm.ontology_type ?? '未填写'}`);
      continue;
    }
    const invalid = Object.entries({ ...model.properties, ...definition.properties })
      .filter(([field, rule]) => {
        const value = fm[field];
        if (value == null || value === '') return rule.required;
        // ID 列表在所有对象主键收集完成后，与外键目标一起校验。
        if (rule.type === 'id-list') return Array.isArray(value) && rule.minItems != null && value.length < rule.minItems;
        return typeof value !== 'string' || !value.trim()
          || (rule.values && !rule.values.includes(value));
      });
    if (invalid.length) {
      issue(path, `属性缺失或值无效：${invalid.map(([field]) => field).join('、')}`);
      continue;
    }
    if (duplicates.has(id)) continue;
    objects.set(id, {
      id, type: fm.ontology_type, title: fm.title, path,
      ...(fm.progress ? { progress: fm.progress } : {}),
      ...(fm.kind ? { kind: fm.kind } : {}),
      frontmatter: fm
    });
  }
  for (const id of duplicates) objects.delete(id);

  const relationsByField = new Map();
  for (const entry of Object.entries(model.relations)) {
    const field = entry[1].sourceField;
    if (!relationsByField.has(field)) relationsByField.set(field, []);
    relationsByField.get(field).push(entry);
  }
  for (const object of objects.values()) {
    for (const [field, relations] of relationsByField) {
      const value = object.frontmatter[field];
      if (value == null) continue;
      const applicable = relations.filter(([, relation]) => relation.sourceTypes.includes(object.type));
      if (!applicable.length) {
        const sourceTypes = [...new Set(relations.flatMap(([, relation]) => relation.sourceTypes))];
        issue(object.path, `${field} 只能用于 ${sourceTypes.join('、')} 对象，当前为 ${object.type}`);
        continue;
      }
      const isList = model.objectTypes[object.type].properties[field].type === 'id-list';
      if (isList ? !Array.isArray(value) : typeof value !== 'string' || !value.trim()) {
        issue(object.path, `${field} 必须是${isList ? ' ID 列表' : '单个非空 ID'}`);
        continue;
      }
      const ids = new Set(isList ? value : [value]);
      for (const [name, relation] of applicable) {
        for (const id of ids) {
          const target = objects.get(id);
          if (typeof id !== 'string' || !id.trim() || !target || !relation.targetTypes.includes(target.type)) {
            issue(object.path, `${name} 引用无法解析为 ${relation.targetTypes.join('、')}：${String(id)}`);
            continue;
          }
          edges.push({ relation: name, source: object.id, target: target.id });
        }
      }
    }
  }
  return { objects, edges, issues };
}

function searchAround(index, model, options = {}) {
  const unknown = Object.keys(options).filter(key => !['ids', 'relation', 'direction'].includes(key));
  if (unknown.length) throw new Error(`未知查询参数：${unknown.join('、')}`);
  const { ids, relation, direction = 'both' } = options;
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) {
    throw new Error('ids 必须是至少含一个对象主键的列表');
  }
  if (!['in', 'out', 'both'].includes(direction)) throw new Error('direction 只能是 in、out 或 both');
  if (relation !== undefined && !Object.hasOwn(model.relations, relation)) {
    throw new Error(`未知关系：${relation}`);
  }
  const selected = new Set(ids);
  const from = [...selected].map(id => {
    const object = index.objects.get(id);
    if (!object) throw new Error(`找不到唯一且有效的起点对象：${id}`);
    return object;
  });
  const groups = [];
  for (const [name, link] of Object.entries(model.relations)) {
    if (relation !== undefined && name !== relation) continue;
    for (const side of ['out', 'in']) {
      if (direction !== 'both' && direction !== side) continue;
      const outgoing = side === 'out';
      const startTypes = outgoing ? link.sourceTypes : link.targetTypes;
      const resultTypes = outgoing ? link.targetTypes : link.sourceTypes;
      if (!from.some(object => startTypes.includes(object.type))) continue;
      const resultIds = new Set(index.edges
        .filter(edge => edge.relation === name && selected.has(outgoing ? edge.source : edge.target))
        .map(edge => outgoing ? edge.target : edge.source));
      const results = [...resultIds].map(id => objectInfo(index.objects.get(id)));
      for (const type of resultTypes) {
        const objects = results.filter(object => object.type === type)
          .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
        const label = outgoing ? link.outgoingLabel : link.incomingLabel;
        groups.push({
          relation: name, direction: side,
          label: resultTypes.length > 1 ? `${label} · ${model.objectTypes[type].label || type}` : label,
          type, total: objects.length, objects
        });
      }
    }
  }
  if (relation !== undefined && !groups.length) {
    throw new Error(`关系 ${relation} 在方向 ${direction} 上不适用于起点类型`);
  }
  return { from: from.map(objectInfo), groups, issues: index.issues };
}

export { validateModel, buildIndex, searchAround };

export function isUnfinishedWork(object) {
  return object.type === 'work_item' && !['已交付', '已取消'].includes(object.frontmatter.progress);
}
