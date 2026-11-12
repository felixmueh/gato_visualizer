import { createFloatingDialog } from './floating-dialog.js';
import { differenceTree, selectionState, taskSession, transferDifferences, treeLeaves } from './task-settings.js';

const GROUP_NAMES = { config: 'Prediction and plant', task: 'Task', execution: 'Execution', source_settings: 'Source settings',
  'config.cost_weights': 'Tracking weights', 'config.solver': 'Solver', 'config.plant': 'Simulated plant',
  'source_settings.predictor': 'Predictor', 'source_settings.simulation': 'Plant and execution controller' };
const EXECUTION_LABELS = { to_hz: 'TO frequency (Hz)', control_hz: 'Control frequency (Hz)', simulation_hz: 'Simulation frequency (Hz)',
  solve_latency_s: 'Solve latency (s)', latency_compensation: 'Latency compensation', max_plan_age_s: 'Plan age limit (s)',
  calculation: 'Calculation', duration_s: 'Precalculation duration (s)', continue_at_end: 'Continue simulation at end' };
const titleCase = value => value.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
export function settingValue(value) {
  if (value === null) return 'none';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return typeof value === 'object' ? JSON.stringify(value, (key, item) => key === 'type' ? undefined : item) : String(value);
}

/** Select one atomic copy; the backend resolves the source's latest session. */
export function createTaskSettingsDialog({ getContext, onApply }) {
  const el = (tag, text) => { const node = document.createElement(tag); if (text != null) node.textContent = text; return node; };
  const form = el('form'), sourceLabel = el('label', 'Copy from'), source = el('select'), tree = el('div');
  form.className = 'task-settings-form'; source.id = 'task-settings-source'; source.setAttribute('aria-label', 'Copy settings from task');
  sourceLabel.append(source); tree.className = 'task-settings-tree'; tree.setAttribute('aria-label', 'Settings to copy');
  const columns = el('div'); columns.className = 'task-settings-columns'; columns.append(el('span', 'Setting'), el('span', 'Source'), el('span', 'Current'));
  const allLabel = el('label'), all = el('input'); all.type = 'checkbox'; all.dataset.taskCopyAll = 'true'; allLabel.className = 'task-settings-all'; allLabel.append(all, el('span', 'Select all differences'));
  const feedback = el('p'); feedback.className = 'source-message'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const actions = el('div'), cancel = el('button', 'Cancel'), apply = el('button', 'Apply');
  actions.className = 'source-actions'; cancel.type = 'button'; apply.type = 'submit'; apply.dataset.taskCopyApply = 'true'; actions.append(cancel, apply);
  form.append(sourceLabel, allLabel, columns, tree, feedback, actions);
  const dialog = createFloatingDialog({ id: 'task-settings-copy', title: 'Copy settings from…', modal: true, content: form });
  dialog.element.className += ' task-settings-dialog';
  let selected = new Set(), sourceKind = null, busy = false, bindings = [], available = [], reviewedVersion, renderKey;
  function context() { return getContext() || {}; }
  function disabledReason(path, current) {
    const spec = path.startsWith('config.') && current.schema?.parameters?.find(item => `config.${item.path.replace(/^config\./, '')}` === path);
    return spec?.disabled ? 'This setting is fixed by the active profile.' : spec?.controlled_by_source ? 'This setting is controlled by the source settings.' : '';
  }
  function sync() {
    const readonly = context().readonly;
    for (const entry of bindings) {
      const state = selectionState(entry.paths, selected); entry.input.checked = state.checked; entry.input.indeterminate = state.indeterminate;
      entry.input.disabled = busy || readonly || !entry.paths.length;
    }
    const state = selectionState(available, selected); all.checked = state.checked; all.indeterminate = state.indeterminate;
    all.disabled = busy || readonly || !available.length; source.disabled = busy || readonly;
    apply.disabled = busy || readonly || !available.some(path => selected.has(path));
    form.setAttribute('aria-busy', String(busy));
  }
  function refresh() {
    const current = context(); reviewedVersion = current.version;
    const nextKey = JSON.stringify([sourceKind, current.current, current.catalog, current.version, current.schema?.parameters, current.schema?.tasks]);
    if (renderKey === nextKey) { sync(); return; }
    const expanded = new Map(Array.from(tree.querySelectorAll('details'), node => [node.dataset.taskCopyBranch, node.open]));
    const scroll = tree.scrollTop, focused = document.activeElement?.dataset?.taskCopyPath;
    const choices = (current.schema?.tasks || []).filter(task => task.kind !== current.current?.task.kind && taskSession(current.catalog, task.kind));
    source.replaceChildren(...choices.map(task => { const option = el('option', task.label || titleCase(task.kind)); option.value = task.kind; return option; }));
    if (!choices.some(task => task.kind === sourceKind)) { sourceKind = choices[0]?.kind ?? null; selected.clear(); }
    source.value = sourceKind || '';
    const differences = sourceKind ? transferDifferences(taskSession(current.catalog, sourceKind), current.current) : [];
    available = differences.filter(item => !disabledReason(item.path, current)).map(item => item.path);
    selected = new Set([...selected].filter(path => available.includes(path))); bindings = []; tree.replaceChildren();
    const labels = new Map((current.schema?.parameters || []).map(spec => [`config.${spec.path.replace(/^config\./, '')}`, spec.label]));
    for (const [path, label] of Object.entries(EXECUTION_LABELS)) labels.set(`execution.${path}`, label);
    const task = current.schema?.tasks?.find(task => task.kind === current.current?.task.kind);
    for (const spec of task?.parameters || []) if (spec.label) labels.set(`task.${spec.path}`, spec.label);
    labels.set('task.target_offset_m', 'Task offset (m)');
    labels.set('task.orientation_rad', 'Grasp orientation (rad)');
    for (const [role, section] of Object.entries(current.schema?.source_settings || {})) {
      for (const spec of section.parameters || []) if (spec.label) labels.set(`source_settings.${role}.${spec.path}`, spec.label);
    }
    function add(nodes, host) {
      for (const node of nodes) {
        const branch = node.children.length > 0, wrapper = el(branch ? 'details' : 'div');
        wrapper.className = branch ? 'task-settings-branch' : 'task-settings-leaf'; if (branch) { wrapper.dataset.taskCopyBranch = node.path; wrapper.open = expanded.get(node.path) ?? true; }
        const row = el(branch ? 'summary' : 'label'); row.className = 'task-settings-row';
        const heading = el('span'), input = el('input'); input.type = 'checkbox'; input.dataset.taskCopyPath = node.path;
        const paths = treeLeaves(node).map(leaf => leaf.path).filter(path => available.includes(path));
        const caption = el('span', GROUP_NAMES[node.path] || labels.get(node.path) || titleCase(node.name)); heading.append(input, caption);
        row.append(heading);
        if (!branch) {
          row.title = disabledReason(node.path, current) || node.path;
          for (const value of [node.source, node.current]) { const cell = el('span', settingValue(value)); cell.title = settingValue(value); row.append(cell); }
        }
        input.addEventListener('click', event => event.stopPropagation());
        input.addEventListener('change', () => { for (const path of paths) input.checked ? selected.add(path) : selected.delete(path); sync(); });
        bindings.push({ input, paths }); wrapper.append(row); if (branch) add(node.children, wrapper); host.append(wrapper);
      }
    }
    add(differenceTree(differences), tree);
    if (!differences.length) tree.append(el('p', choices.length ? 'These tasks have no differing compatible settings.' : 'No other task settings are available.'));
    renderKey = JSON.stringify([sourceKind, current.current, current.catalog, current.version, current.schema?.parameters, current.schema?.tasks]);
    if (scroll != null) tree.scrollTop = scroll;
    if (focused) bindings.find(entry => entry.input.dataset.taskCopyPath === focused)?.input.focus?.();
    sync();
  }
  source.addEventListener('change', () => { sourceKind = source.value; selected.clear(); feedback.textContent = ''; refresh(); });
  all.addEventListener('change', () => { for (const path of available) all.checked ? selected.add(path) : selected.delete(path); sync(); });
  cancel.addEventListener('click', () => { if (!busy) dialog.close(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || apply.disabled) return;
    busy = true; feedback.textContent = ''; feedback.dataset.error = 'false'; sync();
    try { await onApply(sourceKind, available.filter(path => selected.has(path)), reviewedVersion); dialog.close(); }
    catch (error) { feedback.textContent = error.message || 'Settings could not be copied.'; feedback.dataset.error = 'true'; }
    finally { busy = false; refresh(); }
  });
  return { ...dialog, refresh, get isOpen() { return dialog.isOpen; },
    open() { feedback.textContent = ''; refresh(); dialog.open(); },
  };
}
