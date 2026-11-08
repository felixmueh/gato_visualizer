import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { conditionMatches, validateField, restoreWorktreeSettings, createWorktreeFields, resolvedValueText } from './worktree-fields.js';
import { createSettingResets } from './setting-resets.js';

const descriptor = {
  defaults: { enabled: false, gain: [1, 2], law: 'default' },
  parameters: [
    { path: 'enabled', label: 'Armature', kind: 'bool' },
    { path: 'gain', label: 'Gain', kind: 'vector', length: 2, min: 0, max: 10, enabled_if: { enabled: true } },
    { path: 'law', label: 'Law', kind: 'choice', choices: ['default', 'pd'] },
  ],
};

test('vectors and choices reject malformed values, including inactive candidates', () => {
  const parameter = descriptor.parameters[1];
  assert.deepEqual(validateField(parameter, [0, 10]), [0, 10]);
  for (const value of [[1], [1, NaN], [1, Infinity], [1, -1], ['1', 2]]) assert.throws(() => validateField(parameter, value));
  assert.throws(() => validateField(descriptor.parameters[0], 0));
  assert.throws(() => validateField(descriptor.parameters[2], 'foreign-law'));
  assert.throws(() => validateField({ kind: 'float', min: 0, min_exclusive: true }, 0));
  assert.equal(validateField({ kind: 'float', min: 0, min_exclusive: true }, .01), .01);
  assert.equal(conditionMatches({ law: ['pd', 'both'] }, { law: 'pd' }), true);
  assert.equal(conditionMatches({ enabled: true }, { enabled: false }), false);
});

test('restoring another source retains only compatible fields with explicit defaults and separate roles', () => {
  const schema = { source_settings: { simulation: descriptor, predictor: descriptor } };
  const restored = restoreWorktreeSettings(schema, { simulation: { enabled: true, gain: [3, 4], law: 'removed', stale: 1 }, predictor: { gain: [100, 2] } });
  assert.deepEqual(restored, { simulation: { enabled: true, gain: [3, 4], law: 'default' }, predictor: descriptor.defaults });
  restored.simulation.gain[0] = 9;
  assert.equal(descriptor.defaults.gain[0], 1);
});

test('generic fields enable vectors without erasing stored values and validate every element', () => {
  const { document, window } = parseHTML('<html><body><div id="fields"></div></body></html>');
  const previous = globalThis.document; globalThis.document = document;
  try {
    let changes = 0;
    const role = { ...descriptor, parameters: descriptor.parameters.slice(0, 2) };
    const form = createWorktreeFields({ container: document.getElementById('fields'), schema: { source_settings: { simulation: role } }, onChange: () => changes++ });
    const enabled = document.querySelector('input[type="checkbox"]'), vector = document.querySelectorAll('.parameter-vector input');
    assert.equal(vector.length, 2); assert.equal(vector[0].disabled, true);
    assert.deepEqual(form.read().simulation.gain, [1, 2]);
    enabled.checked = true; enabled.dispatchEvent(new window.Event('input'));
    assert.equal(vector[0].disabled, false); assert.equal(changes, 1);
    vector[1].value = '4.5'; vector[1].dispatchEvent(new window.Event('input'));
    assert.deepEqual(form.read().simulation.gain, [1, 4.5]);
    form.setDisabled(true); assert.equal(vector[0].disabled, true);
    form.setDisabled(false); assert.equal(vector[0].disabled, false);
    vector[1].value = ''; assert.throws(() => form.read(), /finite/);
    form.destroy(); assert.equal(document.getElementById('fields').children.length, 0);
  } finally { globalThis.document = previous; }
});

test('adapter timing fields accept equivalent frequency or period units but physical speeds stay numeric', () => {
  const { document, window } = parseHTML('<html><body><div id="fields"></div></body></html>');
  const previous = globalThis.document; globalThis.document = document;
  try {
    const parameters = [
      { path: 'rate_hz', kind: 'float', min: 1, max: 1000, effect: 'runtime' },
      { path: 'interval_s', kind: 'float', min: .001, max: 1, effect: 'runtime' },
      { path: 'width_rad_s', kind: 'float', min: 0, unit: 'rad/s', effect: 'runtime' },
    ];
    const form = createWorktreeFields({ container: document.getElementById('fields'),
      schema: { source_settings: { predictor: { parameters, defaults: { rate_hz: 50, interval_s: .02, width_rad_s: .2 } } } }, onChange() {} });
    const field = path => document.querySelector(`[data-source-path="${path}"] input`) || document.querySelector(`input[data-source-path="${path}"]`);
    field('rate_hz').value = '20 ms'; field('interval_s').value = '50 Hz';
    assert.deepEqual(form.read().predictor, { rate_hz: 50, interval_s: .02, width_rad_s: .2 });
    assert.equal(field('rate_hz').type, 'text'); assert.equal(field('width_rad_s').type, 'number');
    field('rate_hz').value = 'nonsense'; assert.throws(() => form.read());
    form.destroy();
  } finally { globalThis.document = previous; }
});

test('reset buttons stay outside control labels and hidden rows hide their reset wrapper', () => {
  const { document } = parseHTML('<html><body><div id="fields"></div></body></html>');
  const previous = globalThis.document; globalThis.document = document;
  try {
    const resets = createSettingResets({ document });
    const parameters = [{ path: 'enabled', kind: 'bool', label: 'Enable' },
      { path: 'gain', kind: 'vector', length: 2, min: 0, visible_if: { enabled: true } }];
    const form = createWorktreeFields({ container: document.getElementById('fields'),
      schema: { source_settings: { simulation: { defaults: { enabled: false, gain: [1, 2] }, parameters } } },
      onChange() {}, onResetBinding: options => resets.bind(options) });
    const checkbox = document.querySelector('input[type="checkbox"]');
    assert.equal(checkbox.closest('label').querySelector('button'), null);
    const vector = document.querySelector('.vector-row');
    assert.equal(vector.hidden, true); assert.equal(vector.parentElement.hidden, true);
    form.destroy(); resets.clear();
  } finally { globalThis.document = previous; }
});

test('model fields explain cached variants while runtime fields stay unbadged and conditions still apply', () => {
  const { document, window } = parseHTML('<html><body><div id="fields"></div></body></html>');
  const previous = globalThis.document; globalThis.document = document;
  try {
    const simulation = { defaults: { enabled: true, gain: [1, 2] }, parameters: [
      { path: 'enabled', label: 'Plant armature', kind: 'bool', description: 'Use the fixed plant inertia.' },
      { path: 'gain', label: 'PD gain', kind: 'vector', length: 2, effect: 'runtime', enabled_if: { enabled: true } },
    ] };
    const predictor = { defaults: { enabled: false, width: .2 }, parameters: [
      { path: 'enabled', label: 'MPC friction', kind: 'bool', effect: 'compiled_model' },
      { path: 'width', label: 'Tanh width', kind: 'float', min: 0, min_exclusive: true,
        effect: 'compiled_model', visible_if: { enabled: true } },
    ] };
    const form = createWorktreeFields({ container: document.getElementById('fields'),
      schema: { source_settings: { simulation, predictor } }, onChange() {} });
    const row = (role, path) => document.querySelector(`.parameter-row[data-source-role="${role}"][data-source-path="${path}"]`);
    assert.equal(row('simulation', 'enabled').querySelector('.setting-model-badge'), null);
    assert.match(row('simulation', 'enabled').querySelector('input').title, /fixed plant inertia[\s\S]*runtime/);
    assert.equal(row('simulation', 'gain').querySelector('.setting-model-badge'), null);
    assert.match(row('simulation', 'gain').querySelector('input').title, /no model build is needed/);
    const friction = row('predictor', 'enabled'), width = row('predictor', 'width');
    assert.equal(friction.querySelector('.setting-model-badge').textContent, 'Model');
    assert.match(friction.querySelector('input').title, /compiled model variant[\s\S]*Cached modules are reused[\s\S]*Build only if.*missing/);
    assert.equal(width.hidden, true);
    friction.querySelector('input').checked = true;
    friction.querySelector('input').dispatchEvent(new window.Event('input'));
    assert.equal(width.hidden, false);
    assert.equal(width.querySelector('.setting-model-badge').textContent, 'Model');
    assert.deepEqual(form.read().predictor, { enabled: true, width: .2 });
    form.setModelMissing(true);
    assert.equal(friction.classList.contains('model-uncompiled'), true);
    assert.equal(row('simulation', 'gain').classList.contains('model-uncompiled'), false);
    form.setModelMissing(false); assert.equal(friction.classList.contains('model-uncompiled'), false);
    form.destroy();
  } finally { globalThis.document = previous; }
});

test('sphere lists validate bounds and add, edit and remove rows', () => {
  const parameter = { path: 'obstacles', label: 'Obstacles', kind: 'shapes', shape: 'sphere', bound: 2, min_size: .005, max_size: .5,
    max_count: 3, default_size: .05, frame: 'torso_lift_link', effect: 'runtime' };
  assert.deepEqual(validateField(parameter, [[.1, -.2, .3, .05]]), [[.1, -.2, .3, .05]]);
  for (const value of [[[.1, .2, .3]], [[.1, .2, .3, 0]], [[3, 0, 0, .1]], [[.1, .2, .3, .6]], [[0, 0, 0, .1]].concat([[0, 0, 0, .1]], [[0, 0, 0, .1]], [[0, 0, 0, .1]]), [[0, 0, NaN, .1]]]) {
    assert.throws(() => validateField(parameter, value));
  }
  const { document } = parseHTML('<html><body><div id="fields"></div></body></html>');
  const previous = globalThis.document; globalThis.document = document;
  try {
    let changes = 0, asked = 0;
    const schema = { source_settings: { simulation: { defaults: {}, parameters: [] },
      predictor: { defaults: { obstacles: [] }, parameters: [parameter] } } };
    const fields = createWorktreeFields({ container: document.getElementById('fields'), schema,
      values: { simulation: {}, predictor: { obstacles: [[.1, .2, .3, .05]] } }, onChange: () => changes++,
      newShape: (spec, current) => { asked++; assert.equal(spec.path, 'obstacles'); return [.4, -.4, -.3, current.length === 1 ? .06 : spec.default_size]; } });
    const add = document.querySelector('.sphere-add');
    assert.equal(add.title, 'Add a sphere');
    add.click();
    assert.deepEqual(fields.read().predictor.obstacles, [[.1, .2, .3, .05], [.4, -.4, -.3, .06]]);
    assert.equal(asked, 1); assert.equal(changes, 1);
    const inputs = document.querySelectorAll('.parameter-sphere input');
    assert.equal(inputs.length, 8);
    assert.equal(inputs[4].dataset.sourceRole, 'predictor'); assert.equal(inputs[4].dataset.vectorIndex, '1:0');
    assert.match(inputs[0].title, /Obstacle 1 · x/);
    inputs[1].value = '-.25'; inputs[1].dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
    assert.equal(changes, 2);
    assert.deepEqual(fields.read().predictor.obstacles[0], [.1, -.25, .3, .05]);
    document.querySelector('.sphere-remove').click();
    assert.deepEqual(fields.read().predictor.obstacles, [[.4, -.4, -.3, .06]]);
    fields.setValue('predictor', 'obstacles', [[0, 0, 0, .1], [0, 0, .5, .1], [0, 0, 1, .1]]);
    assert.equal(changes, 3);  // setValue reports no change itself
    assert.equal(add.disabled, true);  // at max_count
    fields.field('predictor', 'obstacles').highlight(2);
    assert.deepEqual([...document.querySelectorAll('.parameter-sphere')].map(row => row.classList.contains('selected')), [false, false, true]);
    inputs[0].value = '';
    const rows = document.querySelectorAll('.parameter-sphere input'); rows[0].value = '';
    assert.throws(() => fields.read());
    fields.destroy();
  } finally { globalThis.document = previous; }
});

test('the sphere list is a collapsed table with header and count, and paired descriptors share a row', () => {
  const { document } = parseHTML('<html><body><div id="fields"></div></body></html>');
  const previous = globalThis.document; globalThis.document = document;
  try {
    const spheres = { path: 'obstacles', label: 'Obstacles', unit: 'm', kind: 'shapes', shape: 'sphere', max_size: .5, default_size: .05, frame: 'torso_lift_link', effect: 'runtime' };
    const schema = { source_settings: { simulation: { defaults: {}, parameters: [] }, predictor: { defaults: { body: true, margin_m: .005, obstacles: [] },
      parameters: [{ path: 'body', label: 'Avoid body', kind: 'bool', row: 'body-margin' },
        { path: 'margin_m', label: 'Margin', unit: 'm', kind: 'float', min: 0, max: .2, row: 'body-margin' }, spheres] } } };
    const values = { simulation: {}, predictor: { body: true, margin_m: .005, obstacles: [[.1, .2, .3, .05], [.4, .5, .6, .07]] } };
    let fields = createWorktreeFields({ container: document.getElementById('fields'), schema, values, onChange: () => {} });
    const list = () => document.querySelector('details.parameter-spheres');
    assert.equal(list().open, false);
    assert.equal(document.querySelector('.sphere-count').textContent, '2');
    assert.deepEqual([...document.querySelectorAll('.parameter-sphere-header span')].map(cell => cell.textContent), ['', 'x', 'y', 'z', 'r', '']);
    assert.ok(list().querySelector('summary .sphere-add'), 'add stays in the summary while collapsed');
    const pair = document.querySelector('.source-pair-row');
    assert.deepEqual([...pair.querySelectorAll('.pair-cell > span')].map(caption => caption.textContent), ['Avoid body', 'Margin (m)']);
    assert.deepEqual(fields.read().predictor, values.predictor);
    // Opening is remembered across the panel's repopulation.
    list().open = true; list().dispatchEvent(new document.defaultView.Event('toggle'));
    fields.destroy(); document.getElementById('fields').replaceChildren();
    fields = createWorktreeFields({ container: document.getElementById('fields'), schema, values, onChange: () => {} });
    assert.equal(list().open, true);
    list().open = false; list().dispatchEvent(new document.defaultView.Event('toggle'));
    fields.destroy();
  } finally { globalThis.document = previous; }
});

test('capsule, box and plane lists lay their values out under the four columns and validate their layouts', () => {
  const { document } = parseHTML('<html><body><div id="fields"></div></body></html>');
  const previous = globalThis.document; globalThis.document = document;
  try {
    const spec = (path, shape) => ({ path, label: path[0].toUpperCase() + path.slice(1), unit: 'm', kind: 'shapes', shape, bound: 2, min_size: .005, max_size: .5, effect: 'runtime' });
    const parameters = [spec('capsules', 'capsule'), spec('boxes', 'box'), spec('planes', 'plane')];
    const values = { capsules: [[.1, .2, .3, .4, .5, .6, .05]], boxes: [[.1, .2, .3, 0, 0, 0, 1, .1, .2, .3]], planes: [[0, 0, 1, -.6]] };
    const schema = { source_settings: { simulation: { defaults: {}, parameters: [] }, predictor: { defaults: { capsules: [], boxes: [], planes: [] }, parameters } } };
    const fields = createWorktreeFields({ container: document.getElementById('fields'), schema, values: { simulation: {}, predictor: values }, onChange: () => {} });
    assert.deepEqual(fields.read().predictor, values);
    const lines = shape => [...document.querySelector(`details[data-shape="${shape}"] .parameter-sphere`).querySelectorAll('.parameter-sphere-line')].map(cell => cell.textContent);
    assert.deepEqual(lines('capsule'), ['a', 'b']); assert.deepEqual(lines('box'), ['c', 'q', 'h']); assert.deepEqual(lines('plane'), ['n']);
    assert.deepEqual([...document.querySelectorAll('details[data-shape="box"] .parameter-sphere-header span')].map(cell => cell.textContent), ['', 'x', 'y', 'z', 'w', '']);
    for (const [index, bad] of [[0, [[.1, .2, .3, .4, .5, .6, 0]]], [1, [[0, 0, 0, 0, 0, 0, 0, .1, .1, .1]]], [1, [[0, 0, 0, 0, 0, 0, 1, .1, .1, .6]]], [2, [[0, 0, 0, 1]]], [2, [[0, 0, 1, 3]]]]) {
      assert.throws(() => validateField(parameters[index], bad), undefined, JSON.stringify(bad));
    }
    fields.destroy();
  } finally { globalThis.document = previous; }
});

test('the resolved collision summary counts obstacles of every shape', () => {
  const value = { type: 'Collision', mechanism: 'admm', margin_m: .02, rho: 5, body: true,
    obstacles: [[0, 0, 0, .05]], capsules: [[0, 0, 0, 0, .1, 0, .03], [0, 0, 0, 0, .1, 0, .03]], boxes: [], planes: [[0, 0, 1, -.6]] };
  assert.equal(resolvedValueText(value), 'admm · margin 0.02 m · rho 5 · body + 4 obstacles');
  assert.equal(resolvedValueText({ ...value, body: false, capsules: [], planes: [] }), 'admm · margin 0.02 m · rho 5 · 1 obstacle');
});
