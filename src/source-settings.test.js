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
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this.style = {}; this.value = ''; this.checked = false; this.open = false; this.classes = new Set(); this.classList = { toggle: (name, force) => { const on = force ?? !this.classes.has(name); on ? this.classes.add(name) : this.classes.delete(name); return on; } }; }
    replaceChildren(...nodes) { this.children = nodes; }
    dispatchEvent(event) { this.emit(event.type); return true; }
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
  const current = { compatible: true, selection: { mpc_root: '/source', python: '/source/venv-host/bin/python', cache: '/source/.cache/gato', templates: { python: '<checkout>/venv-host/bin/python', cache: '<checkout>/.cache/gato' } }, source: { mpc_branch: 'main', mpc_commit: 'abc', mpc_dirty: false }, available_N: [48] };
  const request = async (path, body) => {
    requests.push({ path, body });
    if (path === '/api/source') return { current, build: currentBuild };
    if (path === '/api/plots/settings') return body === undefined ? { directory: '/source/_visualizer', default_directory: '/source/_visualizer', override: null } : { directory: body.directory };
    if (path === '/api/plots/reload') return { errors: [] };
    if (path === '/api/source/inspect') return current;
    if (path === '/api/source/defaults') return templateDefaults(body);
    if (path === '/api/source/build') { currentBuild = { state: 'running', N: body.N, log: 'compiling current key', log_path: '/retained/build.log' }; return currentBuild; }
    if (path === '/api/source/apply') { applied = true; return { accepted: true }; }
    if (path === '/api/health') return { backend_id: applied ? 'new' : 'old' };
    throw new Error(path);
  };
  try {
    const ui = setupSourceSettings({ button, request, beforeApply: () => beforeApply++, reload: () => reloaded++ });
    await button.emit('click'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.dialog.isOpen, true);
    assert.deepEqual(requests.map(item => item.path), ['/api/source', '/api/source/defaults', '/api/plots/settings']);
    assert.deepEqual(Object.keys(ui.dialog.panels), ['backend', 'ui']);
    const form = ui.panels.backend.children[0], field = name => form.querySelector(`[name="${name}"]`), action = name => form.querySelector(`[data-action="${name}"]`);
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
    // Default templates are not overrides: Apply lets the checkout resolve them.
    assert.equal(field('cache').value, '<checkout>/.cache/gato');
    assert.equal(field('python').title, '/source/venv-host/bin/python');
    assert.deepEqual(requests.find(item => item.path.endsWith('/apply')).body, { mpc_root: '/source', python: null, cache: null });
    await ui.dialog.element.emit('keydown', { key: 'Escape' });
    assert.equal(ui.dialog.isOpen, false);
    ui.dialog.destroy();
  } finally { Object.assign(globalThis, original); }
});

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

function templateDefaults(body, host = 'venv-host') {
  const python = `<checkout>/${host}/bin/python`, cache = '<checkout>/.cache/gato', fill = text => text.replace('<checkout>', body.mpc_root);
  const entered = {};
  for (const [key, template] of [['python', body.python || python], ['cache', body.cache || cache]]) {
    entered[key] = /<(?!checkout>)[^>]*>/.test(template) ? { error: `Unknown token in ${template}` } : { path: fill(template) };
  }
  return { mpc_root: body.mpc_root, python, cache, resolved: { python: fill(python), cache: fill(cache) }, entered };
}

test('path fields hold <checkout> templates; resolution is a tooltip, errors an invalid mark, edits an override until reset', async () => {
  const { trackCheckoutDefaults } = await import('./source-settings.js');
  const { createSettingResets } = await import('./setting-resets.js');
  const { document: doc } = dialogDOM();
  const fields = { python: doc.createElement('input'), cache: doc.createElement('input') }, resets = createSettingResets({ document: doc });
  const requests = [];
  const request = async (path, body) => { requests.push(body); return templateDefaults(body); };
  const tracked = trackCheckoutDefaults({ fields, resets, request, delay: 0 });
  await tracked.follow('/a');
  assert.equal(fields.python.value, '<checkout>/venv-host/bin/python'); assert.equal(fields.cache.value, '<checkout>/.cache/gato');
  assert.equal(fields.python.title, '/a/venv-host/bin/python'); assert.equal(fields.python.dataset.invalid, 'false');
  assert.equal(tracked.value('python'), null); assert.equal(resets.entries.every(entry => entry.button.disabled), true);
  // An edit is an override, sent as typed, and highlighted until reset.
  fields.cache.value = '<checkout>/../shared/cache'; await fields.cache.emit('input'); await settle();
  assert.equal(tracked.value('cache'), '<checkout>/../shared/cache'); assert.equal(resets.entries[1].button.disabled, false);
  assert.deepEqual(requests.at(-1), { mpc_root: '/a', python: null, cache: '<checkout>/../shared/cache' });
  assert.equal(fields.cache.title, '/a/../shared/cache');
  // A checkout change leaves the edited template alone; the template resolves against the new checkout.
  await tracked.follow('/b');
  assert.equal(fields.cache.value, '<checkout>/../shared/cache'); assert.equal(fields.cache.title, '/b/../shared/cache');
  // Unresolvable templates get an invalid mark with the reason as tooltip.
  fields.python.value = '<home>/py'; await fields.python.emit('input'); await settle();
  assert.equal(fields.python.dataset.invalid, 'true'); assert.match(fields.python.title, /Unknown token/);
  await resets.entries[0].button.emit('click', { stopPropagation() {} }); await settle();
  assert.equal(fields.python.value, '<checkout>/venv-host/bin/python'); assert.equal(tracked.value('python'), null);
  assert.equal(fields.python.dataset.invalid, 'false');
  await resets.entries[1].button.emit('click', { stopPropagation() {} });
  assert.equal(fields.cache.value, '<checkout>/.cache/gato'); assert.equal(tracked.value('cache'), null);
  // A field still on the default text follows a changed default (container checkouts use .venv).
  const other = trackCheckoutDefaults({ fields: { python: doc.createElement('input'), cache: doc.createElement('input') }, resets: createSettingResets({ document: doc }),
    request: async (_path, body) => templateDefaults(body, body.mpc_root === '/old' ? 'venv-host' : '.venv') });
  await other.follow('/old'); await other.follow('/new');
  assert.equal(other.defaults.python, '<checkout>/.venv/bin/python');
  const slow = trackCheckoutDefaults({ fields: { python: doc.createElement('input'), cache: doc.createElement('input') }, resets: createSettingResets({ document: doc }),
    request: async (_path, body) => { if (body.mpc_root === '/old') await new Promise(resolve => setTimeout(resolve, 5)); return templateDefaults(body); } });
  const stale = slow.follow('/old'); await slow.follow('/new'); await stale;
  assert.equal(slow.defaults.cache, '<checkout>/.cache/gato'); assert.equal(slow.defaults.python, '<checkout>/venv-host/bin/python');
});

test('source and profile refresh preserve the predictor friction choice, simulator friction and a null SQP time limit', () => {
  const friction = { coulomb_nm: [1, 1, 1, 1, 1, 1, 1], viscous_nm_s_per_rad: [2, 2, 2, 2, 2, 2, 2], width_rad_s: .03 };
  const schema = {
    available_N: [32], available_N_by_friction: { off: [32], on: [32] },
    defaults: { config: { N: 32, friction: null, max_sqp_time_s: null, plant: { friction: false } }, task: { kind: 'reach', target_offset_m: [0, 0, 0] } },
    parameters: [
      { path: 'N', kind: 'choice', choices: [32] },
      { path: 'friction', kind: 'choice', choices: [{ value: null, label: 'Loss-free' }, { value: friction, label: 'URDF' }] },
      { path: 'max_sqp_time_s', kind: 'float', min: 1e-4, max: 10, nullable: true },
      { path: 'plant.friction', kind: 'bool' },
    ], tasks: [{ kind: 'reach', defaults: { target_offset_m: [0, 0, 0] } }],
  };
  const saved = { config: { N: 32, friction: structuredClone(friction), max_sqp_time_s: .05, plant: { friction: true } }, task: { kind: 'reach' } };
  assert.deepEqual(restoreCompatibleSettings(schema, saved).config, saved.config);
  saved.config.friction.width_rad_s = .05; saved.config.max_sqp_time_s = null; saved.config.plant.friction = 'true';
  assert.deepEqual(restoreCompatibleSettings(schema, saved).config, { N: 32, friction: null, max_sqp_time_s: null, plant: { friction: false } });
});

test('a draft saved before tiago_mpc 31c405a keeps the new warm-up and SQP time-limit defaults', () => {
  const schema = {
    available_N: [32], available_N_by_friction: { off: [32], on: [] },
    defaults: { config: { N: 32, warmup: true, max_sqp_time_s: null, plant: { friction: false } }, task: { kind: 'reach', target_offset_m: [0, 0, 0] } },
    parameters: [
      { path: 'N', kind: 'choice', choices: [32] },
      { path: 'warmup', kind: 'bool' },
      { path: 'max_sqp_time_s', kind: 'float', min: 1e-4, max: 10, nullable: true },
      { path: 'plant.friction', kind: 'bool' },
    ], tasks: [{ kind: 'reach', defaults: { target_offset_m: [0, 0, 0] } }],
  };
  const saved = { config: { N: 32, warmup: 0, budget_s: .05, plant: { friction: false } }, task: { kind: 'reach' } };
  assert.deepEqual(restoreCompatibleSettings(schema, saved).config, { N: 32, warmup: true, max_sqp_time_s: null, plant: { friction: false } });
});
