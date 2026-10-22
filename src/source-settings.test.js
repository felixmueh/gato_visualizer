import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBuildCounts, sourceRequest } from './source-settings.js';
import { restoreCompatibleSettings } from './live.js';


test('explicit build counts support additional horizons and remain integer typed', () => {
  assert.deepEqual(parseBuildCounts('96, 48  96\n256'), [48, 96, 256]);
  for (const value of ['', '16.5', '0', '1', '-32', 'Infinity', '4097', '32oops']) assert.throws(() => parseBuildCounts(value));
});

test('source requests send explicit JSON and surface compatibility errors', async () => {
  let observed;
  const result = await sourceRequest('/api/source/build', { N: [48] }, async (...args) => {
    observed = args; return { ok: true, json: async () => ({ state: 'running' }) };
  });
  assert.equal(result.state, 'running');
  assert.equal(observed[1].method, 'POST');
  assert.deepEqual(JSON.parse(observed[1].body), { N: [48] });
  await assert.rejects(sourceRequest('/api/source/apply', {}, async () => ({ ok: false, json: async () => ({ error: 'Python ABI differs' }) })), /Python ABI differs/);
});

test('backend reload restores only supported typed settings and fresh defaults for changed horizons', () => {
  const schema = {
    available_N: [48, 96],
    defaults: { config: { N: 48, dt_s: .03, solver_params: { max_sqp_iters: 5, q_cost: 4 } }, task: { kind: 'reach', target_offset_m: [0, 0, 0] } },
    parameters: [{ path: 'N', kind: 'choice', choices: [48, 96] }, { path: 'dt_s', kind: 'float', min: .001, max: .1 }, { path: 'solver_params.max_sqp_iters', kind: 'int', min: 1, max: 100 }, { path: 'solver_params.q_cost', kind: 'float', min: 0, max: 100 }],
    tasks: [{ kind: 'reach', defaults: { target_offset_m: [0, 0, 0] } }],
  };
  const saved = { config: { N: 32, dt_s: .02, solver_params: { max_sqp_iters: 12.5, q_cost: 9 } }, task: { kind: 'reach', target_offset_m: [.1, .2, .3] }, execution: { simulation_hz: 1000, control_hz: 80, to_hz: 40, duration_s: 7, calculation: 'manual' } };
  const restored = restoreCompatibleSettings(schema, saved);
  assert.equal(restored.config.N, 48);
  assert.equal(typeof restored.config.N, 'number');
  assert.equal(restored.config.dt_s, .02);
  assert.equal(restored.config.solver_params.max_sqp_iters, 5);
  assert.equal(restored.config.solver_params.q_cost, 9);
  assert.deepEqual(restored.task.target_offset_m, [.1, .2, .3]);
  assert.equal(restored.execution.control_hz, 80);
  assert.equal(schema.defaults.config.solver_params.q_cost, 4);
  saved.config.N = '96';
  assert.equal(restoreCompatibleSettings(schema, saved).config.N, 48);
  saved.config.N = 96;
  assert.equal(restoreCompatibleSettings(schema, saved).config.N, 96);
});

function dialogDOM() {
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this.style = {}; this.value = ''; this.checked = false; this.open = false; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
    async emit(type, event = {}) { await Promise.all((this.listeners.get(type) || []).map(fn => fn({ target: this, preventDefault() {}, ...event }))); }
    querySelector(selector) { this.queries ||= new Map(); if (!this.queries.has(selector)) this.queries.set(selector, new Element(selector.includes('button') ? 'button' : 'input')); return this.queries.get(selector); }
    show() { this.open = true; this.method = 'show'; }
    showModal() { this.open = true; this.method = 'showModal'; }
    close() { this.open = false; this.emit('close'); }
    remove() { this.removed = true; }
    focus() { document.activeElement = this; }
  }
  return { document: { body: new Element('body'), activeElement: new Element('button'), createElement: tag => new Element(tag) }, Element };
}

test('source window checks without compiling, streams explicit build status, then applies a full reload', async () => {
  const { setupSourceSettings } = await import('./source-settings.js');
  const { document: mockDocument, Element } = dialogDOM();
  const original = { document: globalThis.document, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  globalThis.document = mockDocument;
  let poll;
  globalThis.setTimeout = (fn, ms) => { if (ms === 750) queueMicrotask(fn); else poll = fn; return 1; };
  globalThis.clearTimeout = () => { poll = null; };
  const requests = [], button = new Element('button');
  let currentBuild = null, applied = false, beforeApply = 0, reloaded = 0;
  const current = { compatible: true, selection: { mpc_root: '/source', python: '/source/.venv/bin/python', cache: '/source/.cache/gato' }, source: { mpc_branch: 'main', mpc_commit: 'abc', mpc_dirty: false }, available_N: [48] };
  const request = async (path, body) => {
    requests.push({ path, body });
    if (path === '/api/source') return { current, build: currentBuild };
    if (path === '/api/plots/settings') return body === undefined ? { directory: '/source/_visualizer', default_directory: '/source/_visualizer', override: null } : { directory: body.directory };
    if (path === '/api/plots/reload') return { errors: [] };
    if (path === '/api/source/inspect') return current;
    if (path === '/api/source/build') { currentBuild = { state: 'running', N: body.N, log: 'compiling current key', log_path: '/retained/build.log' }; return currentBuild; }
    if (path === '/api/source/apply') { applied = true; return { accepted: true }; }
    if (path === '/api/health') return { backend_id: applied ? 'new' : 'old' };
    throw new Error(path);
  };
  try {
    const ui = setupSourceSettings({ button, request, beforeApply: () => beforeApply++, reload: () => reloaded++ });
    await button.emit('click'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.dialog.isOpen, true);
    assert.deepEqual(requests.map(item => item.path), ['/api/source', '/api/plots/settings']);
    const form = ui.dialog.body.children[0], field = name => form.querySelector(`[name="${name}"]`), action = name => form.querySelector(`[data-action="${name}"]`);
    field('plotters').value = '/custom/plots';
    await action('plotters').emit('click');
    assert.deepEqual(requests.find(item => item.path === '/api/plots/settings' && item.body).body, { directory: '/custom/plots' });
    assert.equal(requests.filter(item => item.path === '/api/source/apply').length, 0);
    assert.equal(requests.filter(item => item.path.endsWith('/build')).length, 0);
    await action('inspect').emit('click');
    assert.equal(requests.filter(item => item.path.endsWith('/build')).length, 0);
    field('counts').value = '96,48';
    field('prediction_friction').checked = true;
    assert.equal(requests.filter(item => item.path.endsWith('/build')).length, 0);
    await action('build').emit('click');
    assert.deepEqual(requests.find(item => item.path.endsWith('/build')).body.N, [48, 96]);
    assert.equal(requests.find(item => item.path.endsWith('/build')).body.prediction_friction, true);
    assert.equal(action('apply').disabled, true);
    assert.equal(form.querySelector('.source-build-log').textContent, 'compiling current key');
    currentBuild = { ...currentBuild, state: 'complete' };
    await poll();
    assert.equal(action('apply').disabled, false);
    await action('apply').emit('click');
    assert.equal(beforeApply, 1); assert.equal(reloaded, 1);
    assert.equal(requests.find(item => item.path.endsWith('/apply')).body.cache, '/source/.cache/gato');
    await ui.dialog.element.emit('keydown', { key: 'Escape' });
    assert.equal(ui.dialog.isOpen, false);
    ui.dialog.destroy();
  } finally { Object.assign(globalThis, original); }
});

test('source and profile refresh preserve typed friction modes and valid predictor smoothing', () => {
  const schema = {
    available_N: [32], available_N_by_friction: { off: [32], on: [] },
    defaults: { config: { N: 32, friction: { simulation: true, prediction: true, predictor_smoothing_rad_s: .03 } }, task: { kind: 'reach', target_offset_m: [0, 0, 0] } },
    parameters: [
      { path: 'N', kind: 'choice', choices: [32] },
      { path: 'friction.simulation', kind: 'bool' }, { path: 'friction.prediction', kind: 'bool' },
      { path: 'friction.predictor_smoothing_rad_s', kind: 'float', min: .001, max: 1 },
    ], tasks: [{ kind: 'reach', defaults: { target_offset_m: [0, 0, 0] } }],
  };
  const saved = { config: { N: 32, friction: { simulation: false, prediction: true, predictor_smoothing_rad_s: .05 } }, task: { kind: 'reach' } };
  assert.deepEqual(restoreCompatibleSettings(schema, saved).config.friction, saved.config.friction);
  saved.config.friction.predictor_smoothing_rad_s = 0;
  assert.equal(restoreCompatibleSettings(schema, saved).config.friction.predictor_smoothing_rad_s, .03);
  saved.config.friction.prediction = 'false';
  assert.equal(restoreCompatibleSettings(schema, saved).config.friction.prediction, true);
});
