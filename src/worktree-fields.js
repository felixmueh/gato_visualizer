// Settings declared by the selected Python worktree. No source-provided JS.
import { canonicalTimeUnit, configureTimeInput, readTimeInput } from './time-input.js';
import { LINE_TITLES, SHAPE_LAYOUTS, shapeValid } from './shape-layouts.js';
const roles = ['simulation', 'predictor'];
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const choiceValue = item => item && typeof item === 'object' && 'value' in item ? item.value : item;
const compiledModelHelp = 'Selects a compiled model variant. Cached modules are reused; use Build only if the requested variant is missing.';
export function parameterTooltip(parameter) {
  return [parameter.description || parameter.label || parameter.path,
    parameter.effect === 'compiled_model' ? compiledModelHelp : parameter.effect === 'runtime'
      ? 'Applied at runtime; no model build is needed.'
      : 'Compilation effect is not annotated; predictor changes are checked.'].filter(Boolean).join('\n');
}
export const fieldValue = (value, path) => path.split('.').reduce((item, key) => item?.[key], value);
export function setFieldValue(value, path, next) {
  const keys = path.split('.'), last = keys.pop();
  const parent = keys.reduce((item, key) => item[key] ??= {}, value);
  parent[last] = next;
}

export function conditionMatches(condition, values) {
  return Object.entries(condition || {}).every(([path, expected]) => {
    const actual = fieldValue(values, path);
    return Array.isArray(expected) ? expected.some(value => equal(value, actual)) : equal(actual, expected);
  });
}

export function validateField(parameter, value) {
  const label = parameter.label || parameter.path;
  if (parameter.kind === 'bool') {
    if (typeof value !== 'boolean') throw new Error(`${label} needs a boolean.`);
  } else if (parameter.kind === 'choice') {
    if (!(parameter.choices || []).some(choice => equal(choiceValue(choice), value))) throw new Error(`${label} needs an available choice.`);
  } else if (parameter.kind === 'shapes') {
    if (!Array.isArray(value) || value.length > (parameter.max_count ?? Infinity) || !value.every(item => shapeValid(parameter, item))) {
      throw new Error(`${label} needs at most ${parameter.max_count ?? 'any number of'} ${parameter.shape}s: positions within ±${parameter.bound ?? Infinity}, sizes in (${parameter.min_size ?? 0}, ${parameter.max_size ?? Infinity}].`);
    }
  } else {
    const values = parameter.kind === 'vector' ? value : [value];
    if (!Array.isArray(values) || (parameter.kind === 'vector' && values.length !== parameter.length)) throw new Error(`${label} needs ${parameter.length} values.`);
    if (!values.every(item => typeof item === 'number' && Number.isFinite(item) &&
      (parameter.kind !== 'int' || Number.isInteger(item)) &&
      (parameter.min == null || (parameter.min_exclusive ? item > parameter.min : item >= parameter.min)) &&
      (parameter.max == null || (parameter.max_exclusive ? item < parameter.max : item <= parameter.max)))) {
      throw new Error(`${label} needs finite ${parameter.kind === 'int' ? 'integer ' : ''}values${parameter.min == null ? '' : ` ${parameter.min_exclusive ? '>' : '≥'} ${parameter.min}`}${parameter.max == null ? '' : ` and ${parameter.max_exclusive ? '<' : '≤'} ${parameter.max}`}.`);
    }
  }
  return value;
}

export function restoreWorktreeSettings(schema, saved) {
  const result = {};
  for (const role of roles) {
    const descriptor = schema.source_settings?.[role];
    result[role] = clone(descriptor?.defaults || {});
    for (const parameter of descriptor?.parameters || []) {
      const value = fieldValue(saved?.[role], parameter.path);
      if (value === undefined) continue;
      try { setFieldValue(result[role], parameter.path, clone(validateField(parameter, value))); }
      catch { /* A new worktree can remove/narrow a field; retain its explicit default. */ }
    }
  }
  return result;
}

export function resolvedValueText(value) {
  if (value === null) return 'off';
  if (value && typeof value === 'object' && value.type === 'Collision') {
    // Every obstacle the rows see: spheres, capsules, boxes and planes.
    const obstacles = ['obstacles', 'capsules', 'boxes', 'planes'].reduce((sum, name) => sum + (value[name]?.length ?? 0), 0);
    return `${value.mechanism} · margin ${value.margin_m} m · rho ${value.rho} · ${value.body ? 'body + ' : ''}${obstacles} obstacle${obstacles === 1 ? '' : 's'}`;
  }
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object' && 'coulomb_nm' in value) {
    const law = value.law || {}, name = law.type || 'friction';
    return `${name}${law.width_rad_s == null ? '' : ` (${law.width_rad_s} rad/s)`}; c: ${value.coulomb_nm.join(', ')}; b: ${value.viscous_nm_s_per_rad.join(', ')}`;
  }
  return value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? 'unavailable');
}

export function createVectorField(parameter, value, onInput) {
  const element = document.createElement('div'); element.className = 'parameter-vector';
  element.style.setProperty('--vector-columns', Math.min(4, parameter.length));
  const inputs = Array.from({ length: parameter.length }, (_, index) => {
    const cell = document.createElement('label'), caption = document.createElement('span');
    caption.textContent = parameter.labels?.[index] || `J${index + 1}`;
    const input = document.createElement('input'); input.type = 'number'; input.step = 'any'; input.required = true;
    if (parameter.min != null) input.min = parameter.min;
    if (parameter.max != null) input.max = parameter.max;
    input.value = String(value[index]); input.title = `${parameter.label || parameter.path} · ${caption.textContent}${parameter.unit ? ` (${parameter.unit})` : ''}\n${parameterTooltip(parameter)}`;
    input.addEventListener('input', onInput); cell.append(caption, input); element.append(cell);
    return input;
  });
  return {
    element, inputs, focus: inputs[0],
    read() {
      return validateField(parameter, inputs.map(input => input.value.trim() === '' ? NaN : Number(input.value)));
    },
    set(next) { inputs.forEach((input, index) => { input.value = String(next[index]); input.setCustomValidity?.(''); }); },
    disable(disabled) { inputs.forEach(input => { input.disabled = disabled; }); },
    destroy() { inputs.forEach(input => input.removeEventListener('input', onInput)); },
  };
}

// Whether an obstacle list is expanded, per role and path, for this page: collapsed by default
// and kept across the panel's repopulation after each accepted settings change.
const shapeListsOpen = new Map();
// A list of obstacles of one shape (descriptor kind shapes, shape-layouts.js): a collapsible
// table, collapsed by default, whose summary keeps the caption, the count and the add button.
// Under a four-column header each obstacle takes its layout's lines (a capsule's ends a and
// b, a box's c, q and h), with a remove button. The add button asks newShape for the values.
// Rows are rebuilt on set(); edits report through onInput.
export function createShapesField(parameter, value, onInput, { newShape, dataset = {}, caption, key = parameter.path } = {}) {
  const layout = SHAPE_LAYOUTS[parameter.shape];
  const element = document.createElement('details'); element.className = 'parameter-spheres';
  element.dataset.shape = parameter.shape;
  element.open = shapeListsOpen.get(key) ?? false;
  const summary = document.createElement('summary');
  const count = document.createElement('span'); count.className = 'sphere-count';
  const add = document.createElement('button'); add.type = 'button'; add.className = 'sphere-add'; add.textContent = '+';
  add.title = `Add a ${parameter.shape}`; add.setAttribute('aria-label', add.title);
  summary.append(...(caption ? [caption] : []), count, add);
  const table = document.createElement('div'); table.className = 'parameter-sphere-table';
  const header = document.createElement('div'); header.className = 'parameter-sphere-header';
  header.append(document.createElement('span'), ...layout.header.map(axis => {
    const cell = document.createElement('span'); cell.textContent = axis;
    cell.title = `${axis}${parameter.unit && axis !== 'w' ? ` (${parameter.unit})` : ''}${parameter.frame ? ` in ${parameter.frame}` : ''}`;
    return cell;
  }), document.createElement('span'));
  const list = document.createElement('div'); list.className = 'parameter-sphere-list';
  table.append(header, list); element.append(summary, table);
  let rows = [], disabled = false, selected = null;
  const name = parameter.label?.replace(/s$/, '') || parameter.shape;
  function row(item, index) {
    const block = document.createElement('div'); block.className = 'parameter-sphere'; block.dataset.sphereIndex = String(index);
    const inputs = new Array(layout.width);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'sphere-remove'; remove.textContent = '×';
    remove.title = `Remove ${name.toLowerCase()} ${index + 1}`; remove.setAttribute('aria-label', remove.title);
    layout.lines.forEach(([lineCaption, columns], line) => {
      const label = document.createElement('span'); label.className = 'parameter-sphere-line'; label.textContent = lineCaption;
      if (lineCaption) label.title = LINE_TITLES[lineCaption] || lineCaption;
      block.append(label);
      columns.forEach((column, slot) => {
        if (column == null) { block.append(document.createElement('span')); return; }
        const input = document.createElement('input'); input.type = 'number'; input.step = 'any'; input.required = true;
        input.value = String(item[column]); input.dataset.sphereAxis = `${lineCaption}${layout.header[slot]}`;
        Object.assign(input.dataset, dataset, { vectorIndex: `${index}:${column}` });  // focus survives a repopulation
        input.title = `${name} ${index + 1} · ${lineCaption ? `${LINE_TITLES[lineCaption] || lineCaption} ` : ''}${layout.header[slot]}`;
        input.setAttribute('aria-label', input.title);
        inputs[column] = input; block.append(input);
      });
      block.append(line === 0 ? remove : document.createElement('span'));
    });
    block.classList.toggle('selected', index === selected);
    return { item: block, inputs, remove };
  }
  function set(next) {
    rows = (next || []).map(row);
    list.replaceChildren(...rows.map(entry => entry.item));
    count.textContent = String(rows.length); count.title = `${rows.length} ${parameter.label?.toLowerCase() || 'obstacles'}`;
    header.hidden = !rows.length;
    disable(disabled);
  }
  function read() {
    return validateField(parameter, rows.map(entry => entry.inputs.map(input => input.value.trim() === '' ? NaN : Number(input.value))));
  }
  function disable(next) {
    disabled = next;
    for (const entry of rows) [...entry.inputs, entry.remove].forEach(control => { control.disabled = next; });
    add.disabled = next || rows.length >= (parameter.max_count ?? Infinity);
  }
  const changed = event => {
    if (event.type === 'click') {
      const target = event.target.closest?.('button');
      if (!target) return;
      // The add button sits in the summary: adding must not also fold the list.
      if (target === add) event.preventDefault();
      let next;
      try { next = read(); } catch { return; }
      if (target === add) {
        const created = newShape?.(parameter, next);
        if (!created) return;
        next.push(created);
      } else next.splice(Number(target.closest('[data-sphere-index]').dataset.sphereIndex), 1);
      set(next);
    }
    onInput(event);
  };
  const toggled = () => shapeListsOpen.set(key, element.open);
  element.addEventListener('input', changed); element.addEventListener('click', changed); element.addEventListener('toggle', toggled);
  set(value);
  return {
    element, add, get inputs() { return rows.flatMap(entry => entry.inputs); },
    get focus() { return rows[0]?.inputs[0] || add; },
    read, set, disable,
    highlight(index) { selected = index; rows.forEach((entry, i) => entry.item.classList.toggle('selected', i === index)); },
    destroy() { element.removeEventListener('input', changed); element.removeEventListener('click', changed); element.removeEventListener('toggle', toggled); },
  };
}

export function createWorktreeFields({ container, schema, values, groupsOpen, onChange, onResetBinding, newShape }) {
  const entries = [], groups = new Map(), pairs = new Map(), start = restoreWorktreeSettings(schema, values);
  let disabled = false;
  const read = () => {
    const next = clone(start);
    for (const entry of entries) {
      entry.inputs.forEach(input => input.setCustomValidity?.(''));
      try { setFieldValue(next[entry.role], entry.parameter.path, entry.read()); }
      catch (error) { entry.focus.setCustomValidity?.(error.message); throw error; }
    }
    return next;
  };
  const visibility = () => {
    const current = clone(start);
    for (const entry of entries) {
      try { setFieldValue(current[entry.role], entry.parameter.path, entry.read()); } catch {}
    }
    for (const entry of entries) {
      entry.row.hidden = !conditionMatches(entry.parameter.visible_if, current[entry.role]);
      entry.visibilityHost.hidden = entry.row.hidden;
      entry.disable(disabled || Boolean(entry.parameter.disabled) || !conditionMatches(entry.parameter.enabled_if, current[entry.role]));
    }
    for (const { details, rows } of groups.values()) details.hidden = rows.every(row => row.hidden);
  };
  const changed = () => { visibility(); onChange(); };
  for (const role of roles) for (const supplied of schema.source_settings?.[role]?.parameters || []) {
    const parameter = { ...supplied, ...(role === 'simulation' && supplied.effect == null ? { effect: 'runtime' } : {}) };
    const name = parameter.group || (role === 'simulation' ? 'Plant and execution law' : 'Predictor dynamics');
    const key = `${role}:${name}`;
    if (!groups.has(key)) {
      const details = document.createElement('details'); details.className = 'settings-group worktree-settings'; details.open = groupsOpen?.get(name) ?? true;
      const summary = document.createElement('summary'); summary.textContent = name;
      const fields = document.createElement('div'); fields.className = 'settings-fields';
      details.append(summary, fields); container.append(details); groups.set(key, { details, fields, rows: [], role, selector: false });
    }
    const block = ['vector', 'shapes'].includes(parameter.kind);
    // Descriptors with the same row share one grid row, side by side (e.g. body and margin).
    const paired = parameter.row && !block;
    const row = document.createElement(block ? 'div' : 'label');
    row.className = paired ? 'pair-cell' : `parameter-row${parameter.kind === 'vector' ? ' vector-row' : parameter.kind === 'shapes' ? ' spheres-row' : parameter.kind === 'choice' ? ' source-choice-row' : ''}`;
    row.dataset.sourceRole = role; row.dataset.sourcePath = parameter.path;
    const caption = document.createElement('span'); caption.textContent = `${parameter.label || parameter.path}${parameter.unit ? ` (${parameter.unit})` : ''}`;
    caption.title = parameterTooltip(parameter);
    if (parameter.effect === 'compiled_model') {
      const badge = document.createElement('span'); badge.className = 'setting-model-badge'; badge.textContent = 'Model';
      badge.title = compiledModelHelp; badge.setAttribute('aria-label', 'Compiled model variant'); caption.append(' ', badge);
    }
    if (parameter.kind !== 'shapes') row.append(caption);
    const value = fieldValue(start[role], parameter.path);
    let field;
    if (parameter.kind === 'vector') field = createVectorField(parameter, value, changed);
    else if (parameter.kind === 'shapes') {
      field = createShapesField(parameter, value, changed, { newShape, caption, key: `${role}:${parameter.path}`,
        dataset: { sourceRole: role, sourcePath: parameter.path } });
    } else {
      const input = document.createElement(parameter.kind === 'choice' ? 'select' : 'input');
      if (parameter.kind === 'choice') {
        for (const [index, item] of parameter.choices.entries()) {
          const option = document.createElement('option'); option.value = String(index);
          option.textContent = item && typeof item === 'object' && 'label' in item ? item.label : String(item);
          input.append(option);
        }
      } else {
        input.type = parameter.kind === 'bool' ? 'checkbox' : 'number';
        input.step = parameter.kind === 'int' ? '1' : 'any'; input.required = parameter.kind !== 'bool';
        if (parameter.min != null) input.min = parameter.min;
        if (parameter.max != null) input.max = parameter.max;
      }
      const set = next => {
        if (parameter.kind === 'bool') input.checked = next;
        else if (parameter.kind === 'choice') input.value = String(parameter.choices.findIndex(item => equal(choiceValue(item), next)));
        else input.value = String(next);
        input.setCustomValidity?.('');
      };
      set(value); input.title = parameterTooltip(parameter);
      const timeUnit = canonicalTimeUnit(parameter);
      if (timeUnit && !['choice', 'bool'].includes(parameter.kind)) configureTimeInput(input, { unit: timeUnit });
      input.addEventListener('input', changed);
      field = { element: input, inputs: [input], focus: input, set,
        read: () => validateField(parameter, parameter.kind === 'bool' ? input.checked : parameter.kind === 'choice' ? choiceValue(parameter.choices[Number(input.value)]) : timeUnit ? readTimeInput(input, { ...parameter, unit: timeUnit }) : input.value.trim() === '' ? NaN : Number(input.value)),
        disable: value => { input.disabled = value; }, destroy: () => input.removeEventListener('input', changed) };
    }
    if (parameter.kind !== 'shapes') field.inputs.forEach((input, index) => { input.dataset.sourceRole = role; input.dataset.sourcePath = parameter.path; if (parameter.kind === 'vector') input.dataset.vectorIndex = String(index); });
    row.append(field.element); groups.get(key).rows.push(row);
    if (paired) {
      const pairKey = `${key}:${parameter.row}`;
      if (!pairs.has(pairKey)) {
        const pair = document.createElement('div'); pair.className = 'parameter-row source-pair-row';
        groups.get(key).fields.append(pair); pairs.set(pairKey, pair);
      }
      pairs.get(pairKey).append(row);
    } else groups.get(key).fields.append(row);
    if (parameter.kind === 'choice') groups.get(key).selector = true;
    const entry = { ...field, role, parameter, row, visibilityHost: row };
    entries.push(entry);
    const reset = onResetBinding?.({ key: `source_settings.${role}.${parameter.path}`, name: parameter.label || parameter.path,
      input: field.focus, host: row, group: 'source-settings',
      getValue: field.read, getDefault: () => fieldValue(schema.source_settings[role].defaults, parameter.path),
      reset: next => { field.set(next); changed(); } });
    entry.visibilityHost = reset?.button?.parentElement || row;
  }
  // Preserve descriptor group order within the simulator and predictor scopes.
  for (const role of roles) [...groups.values()].filter(group => group.role === role)
    .forEach(group => container.append(group.details));
  visibility();
  const entryAt = (role, path) => entries.find(entry => entry.role === role && entry.parameter.path === path);
  return { read, refresh: visibility,
    groupFields(role, name) { return groups.get(`${role}:${name}`)?.fields; },
    /** Replace one field's value without an input event; the caller reports the change. */
    setValue(role, path, next) { const entry = entryAt(role, path); if (!entry) return false; entry.set(next); visibility(); return true; },
    field(role, path) { return entryAt(role, path) || null; },
    setModelMissing(next) { entries.forEach(entry => entry.row.classList.toggle('model-uncompiled', next && entry.parameter.effect === 'compiled_model')); },
    setDisabled(next) { disabled = next; visibility(); },
    destroy() { entries.forEach(entry => entry.destroy()); groups.forEach(({ details }) => details.remove()); },
  };
}
