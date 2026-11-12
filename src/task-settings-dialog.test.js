import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskSettingsDialog, settingValue } from './task-settings-dialog.js';
import { plotDOM } from './plot-dom-test-helper.js';

const settings = (kind, n, to) => ({ config: { N: n, solver: { max_sqp_iters: n, rho: to } }, task: { kind }, execution: { to_hz: to }, source_settings: {} });
function setup(onApply) {
  const { document } = plotDOM();
  const catalog = { defaults: { reach: settings('reach', 32, 100), figure8: settings('figure8', 64, 500) }, overrides: {} };
  const context = { catalog, current: catalog.defaults.reach, schema: { tasks: [{ kind: 'reach', label: 'Reach' }, { kind: 'figure8', label: 'Figure eight' }], parameters: [{ path: 'N', label: 'Knot points', disabled: true }] }, readonly: false, version: 7 };
  const previous = globalThis.document; globalThis.document = document;
  const dialog = createTaskSettingsDialog({ getContext: () => context, onApply }); dialog.open();
  const inputs = () => dialog.element.querySelectorAll('input');
  return { dialog, context, inputs, restore() { dialog.destroy(); globalThis.document = previous; } };
}

test('copy dialog shows source/current values and tristate branches while fixed fields stay disabled', async () => {
  const applied = [], h = setup(async (...args) => applied.push(args));
  try {
    const get = path => h.inputs().find(input => input.dataset.taskCopyPath === path);
    assert.equal(get('config.N').disabled, true);
    assert.match(h.dialog.element.querySelectorAll('span').map(node => node.textContent).join(' '), /500/);
    get('config.solver.max_sqp_iters').checked = true; await get('config.solver.max_sqp_iters').emit('change');
    assert.equal(get('config.solver').indeterminate, true);
    get('config.solver').checked = true; await get('config.solver').emit('change');
    assert.equal(get('config.solver').checked, true); assert.equal(get('config.solver').indeterminate, false);
    await h.dialog.element.querySelector('form').emit('submit');
    assert.deepEqual(applied, [['figure8', ['config.solver.max_sqp_iters', 'config.solver.rho'], 7]]);
    assert.equal(h.dialog.isOpen, false);
  } finally { h.restore(); }
});

test('failed validation retains selected source/leaves and replay makes all copy controls inert', async () => {
  const h = setup(async () => { throw new Error('N does not match the selected menu.'); });
  try {
    const all = h.inputs().find(input => input.dataset.taskCopyAll);
    all.checked = true; await all.emit('change');
    await h.dialog.element.querySelector('form').emit('submit');
    assert.equal(h.dialog.isOpen, true);
    assert.equal(h.dialog.element.querySelector('select').value, 'figure8');
    assert.equal(h.inputs().find(input => input.dataset.taskCopyPath === 'execution.to_hz').checked, true);
    assert.match(h.dialog.element.querySelectorAll('p').map(node => node.textContent).join(' '), /N does not match/);
    h.context.readonly = true; h.dialog.refresh();
    assert(h.inputs().every(input => input.disabled));
    assert.equal(h.dialog.element.querySelectorAll('button').find(button => button.dataset.taskCopyApply).disabled, true);
  } finally { h.restore(); }
});

test('unchanged refresh preserves tree nodes/focus and a new snapshot retains collapsed branches and selection', async () => {
  const h = setup(async () => {});
  try {
    const tree = h.dialog.element.querySelectorAll('div').find(node => node.className === 'task-settings-tree');
    const query = tree.querySelectorAll.bind(tree);
    // Real browser NodeLists are iterable, but do not implement Array.map.
    tree.querySelectorAll = selector => {
      const nodes = query(selector);
      return { length: nodes.length, [Symbol.iterator]: () => nodes[Symbol.iterator]() };
    };
    const branch = h.dialog.element.querySelectorAll('details').find(node => node.dataset.taskCopyBranch === 'config.solver');
    branch.open = false;
    const leaf = h.inputs().find(input => input.dataset.taskCopyPath === 'execution.to_hz');
    leaf.checked = true; await leaf.emit('change'); leaf.focus();
    h.dialog.refresh();
    assert.equal(h.dialog.element.querySelectorAll('details').find(node => node.dataset.taskCopyBranch === 'config.solver'), branch);
    assert.equal(branch.open, false); assert.equal(globalThis.document.activeElement, leaf);
    h.context.version++; h.context.catalog.defaults.figure8.config.solver.rho = 3; h.dialog.refresh();
    assert.equal(h.dialog.element.querySelectorAll('details').find(node => node.dataset.taskCopyBranch === 'config.solver').open, false);
    assert.equal(h.inputs().find(input => input.dataset.taskCopyPath === 'execution.to_hz').checked, true);
  } finally { h.restore(); }
});

test('copy labels reuse execution units and task/source descriptors while hiding native type metadata', () => {
  const h = setup(async () => {});
  try {
    h.context.current.task.target_offset_m = [0, 0, 0];
    h.context.catalog.defaults.figure8.task.target_offset_m = [1, 0, 0];
    h.context.current.task.width_m = .2; h.context.catalog.defaults.figure8.task.width_m = .3;
    h.context.schema.tasks[0].parameters = [{ path: 'width_m', label: 'Path width (m)' }];
    h.context.current.source_settings = { predictor: { gain: 1 } };
    h.context.catalog.defaults.figure8.source_settings = { predictor: { gain: 2 } };
    h.context.schema.source_settings = { predictor: { parameters: [{ path: 'gain', label: 'Predictor gain' }] } };
    h.dialog.refresh();
    const text = h.dialog.element.querySelectorAll('span').map(node => node.textContent).join(' ');
    assert.match(text, /TO frequency \(Hz\)/); assert.match(text, /Path width \(m\)/); assert.match(text, /Predictor gain/);
    assert.equal(settingValue({ type: 'CostMenu', input: { type: 'Term', weight: 1 } }), '{"input":{"weight":1}}');
  } finally { h.restore(); }
});
