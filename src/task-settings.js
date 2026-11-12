// The four editable groups are the only values sent in settings transactions.
export const SETTINGS_GROUPS = ['config', 'task', 'execution', 'source_settings'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (left, right) => {
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equal(value, right[index]));
  if (object(left) && object(right)) return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
  return left === right;
};

export function settingsGroups(snapshot) {
  return Object.fromEntries(SETTINGS_GROUPS.filter(group => snapshot?.[group] !== undefined)
    .map(group => [group, structuredClone(snapshot[group])]));
}

export function mergeTaskSettings(base, patch, prefix = '') {
  const result = structuredClone(base || {});
  for (const [key, value] of Object.entries(patch || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    result[key] = object(value) && object(result[key]) && path !== 'config.cost'
      ? mergeTaskSettings(result[key], value, path) : structuredClone(value);
  }
  return result;
}

export function taskSession(catalog, kind) {
  if (catalog?.sessions?.[kind]) return settingsGroups(catalog.sessions[kind]);
  const defaults = catalog?.defaults?.[kind];
  return defaults ? mergeTaskSettings(defaults, catalog.overrides?.[kind]) : null;
}

// Mirrors task_settings.transfer_differences: shared keys, arrays/null atomic,
// explicit atomic native objects, and no metadata or derived standard cost.
export function transferDifferences(source, current) {
  const result = [], standard = object(source?.config?.cost_weights) && object(current?.config?.cost_weights);
  function visit(left, right, path) {
    if (equal(left, right) || path === 'task.kind' || path.split('.').at(-1) === 'type') return;
    if (path === 'config.cost' && standard) return;
    if (object(left) && object(right) && path !== 'config.cost') {
      for (const key of Object.keys(left).filter(key => Object.hasOwn(right, key)).sort()) visit(left[key], right[key], `${path}.${key}`);
    } else result.push({ path, source: structuredClone(left), current: structuredClone(right) });
  }
  for (const group of SETTINGS_GROUPS) if (source?.[group] !== undefined && current?.[group] !== undefined) visit(source[group], current[group], group);
  return result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function differenceTree(differences) {
  const roots = [];
  for (const difference of differences) {
    let nodes = roots, path = '';
    for (const part of difference.path.split('.')) {
      path = path ? `${path}.${part}` : part;
      let node = nodes.find(item => item.path === path);
      if (!node) { node = { path, name: part, children: [] }; nodes.push(node); }
      if (path === difference.path) Object.assign(node, difference);
      nodes = node.children;
    }
  }
  return roots;
}

export function treeLeaves(node) { return node.children.length ? node.children.flatMap(treeLeaves) : [node]; }
export function selectionState(paths, selected) {
  const count = paths.filter(path => selected.has(path)).length;
  return { checked: paths.length > 0 && count === paths.length, indeterminate: count > 0 && count < paths.length };
}
