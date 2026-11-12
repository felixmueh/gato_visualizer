import test from 'node:test';
import assert from 'node:assert/strict';
import { setupLive as createLive, restoreCompatibleSettings } from './live.js';
// Existing controller tests exercise the unbuffered interpolated mode; buffered
// presentation is covered explicitly below without changing their clocks.
const setupLive = options => createLive({ presentationSettings: { report_hz: 20, buffer_ms: 0, interpolate: true }, ...options });
import { DEFAULT_EXECUTION } from './live-execution.js';
import { createSession } from './session.js';
import { bindStopPreference } from './workbench-ui.js';
import { settingsPatch } from './shared-settings.js';

// Exercise the real settings/mode/SSE controller without a GPU or renderer.
function harness() {
  const elements = new Map(), created = [];
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag; this.value = ''; this.dataset = {}; this.children = [];
      this.handlers = {}; this.classList = { toggle() {}, remove() {} };
      this.style = { setProperty() {} };
    }
    get value() { return this._value; }
    set value(value) { this._value = String(value); }
    addEventListener(type, callback) { (this.handlers[type] ||= []).push(callback); }
    removeEventListener(type, callback) { this.handlers[type] = (this.handlers[type] || []).filter(item => item !== callback); }
    emit(type) { this.dispatchEvent({ type, target: this, preventDefault() {}, stopPropagation() {} }); }
    dispatchEvent(event) { for (const callback of this.handlers[event.type] || []) callback(event); return true; }
    closest(tag) { for (let item = this; item; item = item.parentElement) if (item.tagName === tag) return item; return null; }
    replaceWith(next) {
      const parent = this.parentElement;
      if (!parent) return;
      const index = parent.children.indexOf(this); parent.children[index] = next; next.parentElement = parent; this.parentElement = null;
    }
    focus() { document.activeElement = this; }
    append(...children) {
      this.children.push(...children);
      for (const child of children) if (child && typeof child === 'object') child.parentElement = this;
      if (this.tagName === 'select') {
        for (const child of children) if (!this.value || child.selected) this.value = child.value;
      }
    }
    replaceChildren(...children) { this.children = []; this.value = ''; this.append(...children); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      const found = [];
      const visit = node => {
        for (const child of node.children || []) if (child && typeof child === 'object') {
          if (child.tagName === selector) found.push(child);
          visit(child);
        }
      };
      visit(this);
      return found;
    }
    setAttribute() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    setCustomValidity() {}
    reportValidity() {}
  }
  const $ = id => {
    if (!elements.has(id)) elements.set(id, new Element(id === 'live-task' ? 'select' : 'div'));
    return elements.get(id);
  };
  const document = {
    body: new Element(), getElementById: $,
    createElement(tag) { const element = new Element(tag); created.push(element); return element; },
    querySelector(selector) {
      const horizon = selector.match(/data-horizon="([^"]+)"/)?.[1];
      if (horizon) return created.filter(el => el.dataset.horizon === horizon).at(-1);
      const path = selector.match(/data-task-path="([^"]+)"/)?.[1];
      return created.filter(el => el.dataset.taskPath === path).at(-1);
    },
  };
  const schema = {
    defaults: { execution: { ...DEFAULT_EXECUTION }, config: { N: 32, solver_params: { q_cost: 4, max_sqp_iters: 5, max_pcg_iters: 120 }, unlisted: { preserved: true } }, task: { kind: 'reach', target_offset_m: [.15, .2, .2] } },
    available_N: [16, 32, 64],
    parameters: [
      { path: 'N', kind: 'int' },
      ...['q_cost', 'max_sqp_iters', 'max_pcg_iters'].map(path => ({ path: `solver_params.${path}`, label: path, kind: path === 'q_cost' ? 'float' : 'int', min: 0 })),
    ],
    tasks: [
      { kind: 'reach', label: 'Reach', defaults: { kind: 'reach', target_offset_m: [.15, .2, .2] } },
      { kind: 'figure8', label: 'Figure eight', defaults: { kind: 'figure8', target_offset_m: [0, 0, 0], width_m: .24, height_m: .16, period_s: 8 }, parameters: ['width_m', 'height_m', 'period_s'].map(path => ({ path, label: path, kind: 'float', min: .001 })) },
    ],
  };
  const fixtureGroups = value => ({ config: structuredClone(value.config), task: structuredClone(value.task), execution: structuredClone(value.execution), source_settings: structuredClone(value.source_settings || {}) });
  const fixtureMerge = (left, patch) => {
    const next = structuredClone(left);
    for (const [key, value] of Object.entries(patch)) next[key] = value && typeof value === 'object' && !Array.isArray(value) && next[key] && typeof next[key] === 'object' && !Array.isArray(next[key]) ? fixtureMerge(next[key], value) : structuredClone(value);
    return next;
  };
  let explicitTaskDefaults, fixtureCurrent;
  const fixtureSessions = new Map();
  Object.defineProperty(schema, 'task_defaults', { enumerable: true,
    get: () => explicitTaskDefaults || Object.fromEntries(schema.tasks.map(task => [task.kind, fixtureGroups({ ...schema.defaults, task: task.defaults })])),
    set: value => { explicitTaskDefaults = value; } });
  function withTaskCatalog(item) {
    if (!item?.config || !item.task || !item.execution) return item;
    fixtureCurrent = fixtureGroups(item); fixtureSessions.set(item.task.kind, fixtureCurrent);
    return { ...item, source_settings: fixtureCurrent.source_settings,
      task_settings: item.task_settings || { defaults: structuredClone(schema.task_defaults), sessions: Object.fromEntries([...fixtureSessions].map(([kind, value]) => [kind, structuredClone(value)])), overrides: Object.fromEntries([...fixtureSessions].filter(([kind]) => schema.task_defaults[kind]).map(([kind, value]) => [kind, settingsPatch(schema.task_defaults[kind], value)])) } };
  }
  const commands = [], sources = [];
  let version = 0, historyHandler, commandHandler, freezeHandler, settingsHandler, plansHandler;
  class EventSource {
    static OPEN = 1;
    constructor() { this.readyState = 0; sources.push(this); }
    close() { this.readyState = 2; }
    open() { this.readyState = 1; this.onopen?.(); }
    emit(item) { this.onmessage?.({ data: JSON.stringify(item.type === 'settings' ? withTaskCatalog(item) : item) }); }
  }
  const fetch = async (url, options) => {
    if (url.includes('/history?') || url.includes('/playback?')) return historyHandler(url);
    if (url.includes('/plans?')) return plansHandler(url);
    if (url.endsWith('/schema')) return { ok: true, json: async () => structuredClone(schema) };
    if (url.endsWith('/settings')) {
      if (settingsHandler) { const response = await settingsHandler(); return { ...response, json: async () => withTaskCatalog(await response.json()) }; }
      return fixtureCurrent ? { ok: true, json: async () => withTaskCatalog({ ...fixtureCurrent, settings_version: version }) } : { ok: false, json: async () => ({}) };
    }
    if (url.endsWith('/freeze')) return freezeHandler(JSON.parse(options.body));
    const command = JSON.parse(options.body); commands.push(command);
    if (['set_settings', 'patch_settings', 'switch_task', 'transfer_settings', 'reset_task_settings'].includes(command.type)) version++;
    if (commandHandler) return commandHandler(command, version);
    if (command.type === 'set_settings') withTaskCatalog(command);
    else if (command.type === 'patch_settings') withTaskCatalog(fixtureMerge(fixtureCurrent || schema.defaults, command.patch));
    else if (command.type === 'switch_task') withTaskCatalog(fixtureSessions.get(command.task_kind) || schema.task_defaults[command.task_kind]);
    else if (command.type === 'reset_task_settings') withTaskCatalog(schema.task_defaults[fixtureCurrent.task.kind]);
    return { ok: true, json: async () => ({ accepted: true, settings_version: version }) };
  };
  const edit = (path, value) => {
    const element = path.startsWith('target-offset-') ? $(path) : created.filter(el => el.dataset.path === path).at(-1);
    element.value = String(value); element.emit('input');
  };
  return { $, document, EventSource, fetch, commands, sources, created, edit, schema, setPlansHandler(value) { plansHandler = value; }, setHistoryHandler(value) { historyHandler = value; }, setCommandHandler(value) { commandHandler = value; }, setFreezeHandler(value) { freezeHandler = value; }, setVersion(value) { version = value; }, setSettingsHandler(value) { settingsHandler = value; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('source upgrade preserves known predictor friction without exposing native model fields', () => {
  const h = harness(), friction = { type: 'Friction', coulomb_nm: Array(7).fill(1), viscous_nm_s_per_rad: Array(7).fill(.5) };
  const law = { type: 'Tanh', width_rad_s: .03 };
  Object.assign(h.schema.defaults.config, { friction: null, friction_law: law, armature: Array(7).fill(0) });
  h.schema.parameters.push({ path: 'friction', kind: 'choice', choices: [{ value: null, label: 'Off' }, { value: friction, label: 'On' }] });
  const saved = structuredClone(h.schema.defaults);
  saved.config.friction = { ...friction, law }; saved.config.solver_params.q_cost = 13;
  const restored = restoreCompatibleSettings(h.schema, saved);
  assert.deepEqual(restored.config.friction, friction);
  assert.deepEqual(restored.config.friction_law, law);
  assert.deepEqual(restored.config.armature, Array(7).fill(0));
  assert.equal(restored.config.solver_params.q_cost, 13);
  assert.deepEqual(saved.config.friction.law, law);
  for (const previous of [{ type: 'Sign' }, { type: 'Tanh', width_rad_s: .2 }]) {
    saved.config.friction.law = previous;
    assert.throws(() => restoreCompatibleSettings(h.schema, saved), /Saved predictor friction.*Reload/);
  }
});

test('unknown saved predictor law blocks startup visibly instead of silently disabling friction', async () => {
  const h = harness();
  const friction = { type: 'Friction', coulomb_nm: Array(7).fill(1), viscous_nm_s_per_rad: Array(7).fill(.5) };
  Object.assign(h.schema.defaults.config, { friction: null, friction_law: { type: 'Tanh', width_rad_s: .03 } });
  h.schema.parameters.push({ path: 'friction', kind: 'choice', choices: [{ value: null, label: 'Off' }, { value: friction, label: 'On' }] });
  const saved = structuredClone(h.schema.defaults);
  saved.config.friction = { ...friction, law: { type: 'Tanh', width_rad_s: .2 } };
  let retained = JSON.stringify(saved);
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource', 'sessionStorage'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource,
    sessionStorage: { getItem: () => retained, removeItem() { retained = null; } } });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await live.ready;
    assert.match(h.$('live-availability').title, /Saved predictor friction.*Reload/);
    assert.equal(h.commands.length, 0);
    assert.equal(retained, null);
    live.dispose();
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});
test('one latency compensation checkbox submits a runtime execution setting', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let live;
  try {
    live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await live.ready;
    assert.equal(live.settings.execution.latency_compensation, false);
    assert.equal(h.$('live-latency-compensation').checked, false);
    h.$('live-mode').emit('click');
    const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'idle', settings_version: 0 });
    await flush();
    h.$('live-latency-compensation').checked = true;
    h.$('live-latency-compensation').emit('change');
    assert.equal(live.settings.execution.latency_compensation, true);
    await new Promise(resolve => setTimeout(resolve, 380)); await flush();
    const request = h.commands.filter(command => ['set_settings', 'patch_settings'].includes(command.type)).at(-1);
    assert.equal((request.execution || request.patch.execution).latency_compensation, true);
  } finally {
    live?.dispose();
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});
// A segment header: the constant context of a generation's records, sent once.
const segment = (kind, context = {}) => ({ type: 'segment', generation: 0, settings_version: 0, context: { task: { kind }, ...context } });
const plan = (version, seq, task_kind = 'reach') => ({
  type: 'plan', generation: 0, settings_version: version, seq, origin: 'preview', sim_time_s: 0,
  N: task_kind === 'reach' ? 32 : 64, dt_s: .01, knot_time_s: [0, .01], q: [Array(7).fill(0), Array(7).fill(0)],
  ee_xyz: [[.5, 0, 1], [.6, 0, 1]], reference_xyz: [[.7, 0, 1], [.7, 0, 1]], stats: {},
});

test('native model controls explain cached variants without labeling runtime costs as model builds', async () => {
  const h = harness();
  h.schema.parameters[0].effect = 'compiled_model';
  h.schema.parameters[1].effect = 'runtime';
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await flush();
    const field = path => h.created.filter(element => element.dataset.path === path).at(-1);
    assert.match(field('N').title, /compiled model variant[\s\S]*Cached modules are reused[\s\S]*Build only if.*missing/);
    assert.match(field('solver_params.q_cost').title, /Applied at runtime; no model build is needed/);
    assert.doesNotMatch(field('solver_params.q_cost').title, /compiled model variant/);
  } finally { Object.assign(globalThis, originals); }
});

function modelSchema(h, available = [32]) {
  h.schema.supported_N = [16, 32, 64]; h.schema.available_N = available;
  h.schema.compile_profile_id = 'one';
  h.schema.compile_selection = { mpc_root: '/one', python: '/one/python', cache: null, effective_cache: '/one/cache' };
  h.schema.source = { mpc_root: '/one', mpc_commit: 'recorded' };
  h.schema.parameters.forEach(parameter => { parameter.effect = parameter.path === 'N' ? 'compiled_model' : 'runtime'; });
}

test('repeated target drags, task and runtime settings retain readiness without native lookups', async () => {
  const h = harness(); modelSchema(h);
  h.schema.task_anchors = { reach: [.4, -.3, 1], figure8: [.4, -.3, 1] };
  let lookups = 0;
  const fetch = async (url, options) => {
    if (url === '/api/source/model') {
      lookups++;
      return { ok: true, json: async () => ({ compatible: true, compilation: { ready: true, N: 32, available_N: [32] } }) };
    }
    return h.fetch(url, options);
  };
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch, EventSource: h.EventSource });
  let live;
  try {
    live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await live.ready;
    h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'idle', settings_version: 0 }); await flush(); await flush();
    const checked = lookups; assert.equal(checked, 1);
    for (let i = 0; i < 10; i++) {
      assert.equal(live.targetInteraction.available, true);
      assert.ok(live.setTargetWorld([.5 + i / 100, -.2, 1.1]));
      assert.equal(live.targetInteraction.available, true);
      assert.equal(live.compilation.phase, 'ready');
    }
    h.edit('solver_params.q_cost', 7);
    h.$('live-duration').value = '12'; h.$('live-duration').emit('input');
    h.$('live-control-hz').value = '250'; h.$('live-control-hz').emit('input');
    // Intermediate empty runtime input must not turn a known model into checking.
    h.edit('solver_params.q_cost', ''); assert.equal(live.compilation.phase, 'ready');
    h.edit('solver_params.q_cost', 8);
    await new Promise(resolve => setTimeout(resolve, 380)); await flush();
    assert.equal(lookups, checked);
    const commands = h.commands.filter(command => ['set_settings', 'patch_settings'].includes(command.type));
    assert.equal(commands.at(-1).config.solver_params.q_cost, 8);
    assert.deepEqual(commands.at(-1).task.target_offset_m, [.19, .1, .1]);
    assert.equal(live.compilation.phase, 'ready');
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});

test('target editing stays available during a slow model check and shares that one check', async () => {
  const h = harness(); modelSchema(h);
  h.schema.task_anchors = { reach: [.4, -.3, 1] };
  let release, lookups = 0;
  const fetch = async (url, options) => {
    if (url === '/api/source/model') {
      lookups++;
      return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ compatible: true,
        compilation: { ready: true, N: 32, available_N: [32] } }) }); });
    }
    return h.fetch(url, options);
  };
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch, EventSource: h.EventSource });
  let live;
  try {
    live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await live.ready;
    h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'idle', settings_version: 0 }); await flush();
    assert.equal(live.compilation.phase, 'checking');
    assert.equal(h.created.find(element => element.className === 'model-compile-prompt').hidden, true);
    for (let i = 0; i < 5; i++) {
      assert.equal(live.targetInteraction.available, true);
      assert.ok(live.setTargetWorld([.5 + i / 100, -.2, 1.1]));
    }
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.equal(lookups, 1);
    release(); await flush(); await flush();
    assert.equal(live.compilation.phase, 'ready');
    assert.equal(lookups, 1);
    const command = h.commands.find(item => ['set_settings', 'patch_settings'].includes(item.type));
    assert.deepEqual(command.task.target_offset_m, [.14, .1, .1]);
  } finally { release?.(); live?.dispose(); Object.assign(globalThis, originals); }
});

test('missing supported N stays selectable and local until the exact model is ready in cache', async () => {
  const h = harness(); modelSchema(h);
  const compiled = new Set([32]), lookups = []; let builds = 0;
  const fetch = async (url, options) => {
    if (url === '/api/source/model') {
      const body = JSON.parse(options.body); lookups.push(body);
      return { ok: true, json: async () => ({ compatible: true, compilation: { ready: compiled.has(body.params.N),
        N: body.params.N, supported_N: [16, 32, 64], available_N: [...compiled], binary_path: compiled.has(body.params.N) ? '/actual.so' : null } }) };
    }
    if (url === '/api/source/build') { builds++; throw new Error('A cached model must not compile.'); }
    return h.fetch(url, options);
  };
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch, EventSource: h.EventSource });
  let live;
  try {
    live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await live.ready;
    h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'idle', settings_version: 0 }); await flush(); await flush();
    const numeric = () => h.commands.filter(command => ['set_settings', 'patch_settings'].includes(command.type));
    assert.equal(numeric().length, 1); assert.equal(numeric()[0].config.N, 32);
    const knot = h.created.filter(element => element.dataset.path === 'N').at(-1);
    assert.equal(knot.children[2].disabled, false); assert.match(knot.children[2].textContent, /64.*not compiled/);
    h.edit('N', 2); await new Promise(resolve => setTimeout(resolve, 380)); await flush();
    assert.equal(live.settings.config.N, 64); assert.equal(live.compilation.phase, 'missing');
    assert.equal(numeric().length, 1); assert.equal(numeric()[0].config.N, 32);
    assert.equal(knot.children[2].disabled, false); assert.match(knot.children[2].textContent, /not compiled/);
    const prompt = h.created.find(element => element.className === 'model-compile-prompt');
    assert.equal(prompt.hidden, false);
    compiled.add(64); h.edit('solver_params.q_cost', 8); await live.compileModel();
    assert.equal(builds, 0); assert.equal(numeric().length, 2);
    assert.equal(numeric()[1].config.N, 64); assert.equal(numeric()[1].config.solver_params.q_cost, 8);
    assert.deepEqual(lookups.at(-1).selection, { mpc_root: '/one', python: '/one/python', cache: null });
    assert.equal(prompt.hidden, true);
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});

test('an empty compiled catalog still opens supported model drafts and the Compile prompt', async () => {
  const h = harness(); modelSchema(h, []);
  const fetch = async (url, options) => url === '/api/source/model' ? { ok: true, json: async () => ({ compatible: true,
    compilation: { ready: false, N: 32, supported_N: [16, 32, 64], available_N: [], binary_path: null } }) } : h.fetch(url, options);
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch, EventSource: h.EventSource });
  let live;
  try {
    live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await live.ready;
    assert.equal(live.settings.config.N, 32);
    h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'idle', settings_version: 0 }); await flush(); await flush();
    assert.equal(live.compilation.phase, 'missing');
    const knot = h.created.filter(element => element.dataset.path === 'N').at(-1);
    assert.equal(knot.children.length, 3); assert.equal(knot.children.every(option => !option.disabled), true);
    assert.equal(h.created.find(element => element.className === 'model-compile-prompt').hidden, false);
    assert.equal(h.commands.some(command => ['set_settings', 'patch_settings'].includes(command.type)), false);
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});

test('Replay roundtrip retains complete task session draft and rejects older cached plans', async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let live;
  try {
    live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await live.ready; await live.enterLive();
    let source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    h.$('live-task').value = 'figure8'; h.$('live-task').emit('change'); await flush(); await flush();
    h.edit('N', 2); h.edit('solver_params.q_cost', 9.25); h.edit('solver_params.max_sqp_iters', 17); h.edit('solver_params.max_pcg_iters', 345);
    h.edit('target-offset-0', .13); h.edit('target-offset-1', -.21); h.edit('target-offset-2', .08);
    for (const [path, value] of [['width_m', .42], ['height_m', .28], ['period_s', 13]]) {
      const input = h.document.querySelector(`[data-task-path="${path}"]`); input.value = String(value); input.emit('input');
    }
    const retained = structuredClone(live.settings), count = h.commands.length;
    h.$('replay-mode').emit('click'); await flush();
    assert.deepEqual(live.settings, retained); assert.equal(h.commands.filter(command => ['set_settings', 'patch_settings'].includes(command.type)).length, 1);
    h.$('live-mode').emit('click'); source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 2 }); await flush();
    source.emit(plan(2, 900, 'figure8')); assert.notEqual(live.plan?.seq, 900);
    assert.deepEqual(live.settings, retained);
    assert.equal(h.commands.at(-1).type, 'patch_settings'); assert.equal(h.commands.at(-1).expected_settings_version, 2);
    source.emit(plan(3, 3, 'figure8')); assert.equal(live.plan.seq, 3); assert.equal(live.pending, false);
    source.open(); source.emit(plan(2, 901, 'figure8')); assert.equal(live.plan.seq, 3);
    assert.deepEqual(live.settings, retained); assert(h.commands.length > count);
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});

test('returning to Live keeps the retained prediction while a different cached server plan is waiting for the GPU', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click');
    let source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 });
    await flush(); source.emit(plan(1, 1));
    h.$('replay-mode').emit('click'); await flush();
    h.$('live-mode').emit('click'); source = h.sources.at(-1); source.open();
    h.setVersion(7);
    source.emit({ type: 'status', state: 'paused', settings_version: 7 });
    source.emit(plan(7, 700, 'figure8'));
    await flush();
    assert.equal(live.plan.seq, 1);
    source.emit({ type: 'status', state: 'gpu_busy', settings_version: 7 });
    source.emit(plan(7, 701, 'figure8'));
    assert.equal(live.plan.seq, 1);
    assert.deepEqual(live.settings, h.schema.task_defaults.reach);
    h.$('replay-mode').emit('click'); await flush();
  } finally {
    h.$('replay-mode').emit('click');
    await flush();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});

test('unchanged Live roundtrip preserves history and does not request another solve', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); let source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 });
    await flush(); source.emit(plan(1, 1));
    for (const time of [0, .1, .2]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time, q: Array(7).fill(time), qd: Array(7).fill(0), ee_xyz: [time, 0, 1] });
    const retained = live.settings; assert.equal(live.history.length, 3);
    h.$('replay-mode').emit('click'); await flush(); h.$('live-mode').emit('click'); source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 1 });
    await flush();
    assert.equal(h.commands.filter(command => command.type === 'set_settings').length, 1);
    assert.equal(live.history.length, 3); assert.deepEqual(live.settings, retained);
    h.$('replay-mode').emit('click'); await flush();
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('obsolete asynchronous history pages cannot overwrite a newer generation', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let releaseOld;
  h.setHistoryHandler(url => {
    const generation = Number(new URL(url, 'http://test').searchParams.get('generation'));
    const response = { ok: true, json: async () => ({ generation, next_cursor: 1, complete: true, records: [{ type: 'state', generation, settings_version: 1, sim_time_s: generation * 5, q: Array(7).fill(generation), qd: Array(7).fill(0), ee_xyz: [generation, 0, 1] }] }) };
    return generation === 1 ? new Promise(resolve => { releaseOld = () => resolve(response); }) : Promise.resolve(response);
  });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 });
    await flush(); source.emit(plan(1, 1));
    source.emit({ type: 'history', generation: 1, settings_version: 1 });
    source.emit({ type: 'history', generation: 2, settings_version: 1 });
    releaseOld(); await flush(); await flush();
    assert.equal(live.history.generation, 2); assert.deepEqual(live.history.bounds, [10, 10]); assert.equal(live.state.q[0], 2);
    source.emit({ type: 'history', generation: 1, settings_version: 1 }); await flush();
    assert.equal(live.history.generation, 2); assert.deepEqual(live.history.bounds, [10, 10]);
    source.emit({ ...plan(1, 999), generation: 1 });
    source.emit({ type: 'state', generation: 1, settings_version: 1, sim_time_s: 999, q: Array(7).fill(999), ee_xyz: [999, 0, 1] });
    source.emit({ type: 'status', generation: 1, settings_version: 1, state: 'error' });
    assert.notEqual(live.plan.seq, 999); assert.equal(live.state.q[0], 2); assert.notEqual(live.status, 'error');
    h.$('replay-mode').emit('click'); await flush();
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('Play during a dirty settings debounce queues generation after accepted settings and retains intent through the preview pause', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 });
    await flush(); source.emit(plan(1, 1)); source.emit({ type: 'state', settings_version: 1, sim_time_s: 0, q: Array(7).fill(0), qd: Array(7).fill(0), ee_xyz: [0, 0, 1] });
    h.edit('solver_params.q_cost', 9); h.$('live-play').emit('click'); await flush(); await flush();
    assert.deepEqual(h.commands.slice(-2).map(command => command.type), ['set_settings', 'play']);
    source.emit(plan(2, 2)); source.emit({ type: 'status', state: 'paused', settings_version: 2, job_active: false });
    live.frame(performance.now() + 1000); assert.equal(live.playing, true); assert.equal(h.$('live-play').disabled, false);
    source.emit({ type: 'status', state: 'playing', settings_version: 2, job_active: true });
    assert.equal(live.playing, true); assert.equal(h.commands.filter(command => command.type === 'play').length, 1);
    h.$('replay-mode').emit('click'); await flush();
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('first Play survives the asynchronous readiness check for dirty cached settings', async () => {
  for (const calculation of ['on_play', 'automatic']) {
    const h = harness(); modelSchema(h); h.schema.defaults.execution.calculation = calculation;
    const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
    const fetch = async (url, options) => url === '/api/source/model'
      ? { ok: true, json: async () => ({ compatible: true, compilation: { ready: true, N: 32, available_N: [32] } }) }
      : h.fetch(url, options);
    Object.assign(globalThis, { document: h.document, fetch, EventSource: h.EventSource });
    let live;
    const records = [], shown = [];
    h.setHistoryHandler(url => ({ ok: true, json: async () => ({ generation: 2,
      records: records.slice(Number(new URL(url, 'http://test').searchParams.get('after'))),
      next_cursor: records.length, complete: false }) }));
    try {
      live = setupLive({ onMode() {}, onPlan() {}, onState(state) { shown.push(state); }, onReset() {} });
      await live.ready; h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
      source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); await flush();
      source.emit(plan(1, 1));
      source.emit({ type: 'state', settings_version: 1, sim_time_s: 0, q: Array(7).fill(0), qd: Array(7).fill(0), ee_xyz: [0, 0, 1] });
      assert.equal(live.compilation.phase, 'ready');
      h.edit('solver_params.q_cost', 9); h.$('live-play').emit('click'); await flush(); await flush();
      assert.equal(live.playing, true, calculation);
      assert.equal(h.$('live-play').textContent, 'Pause', calculation);
      assert.equal(h.commands.filter(command => command.type === 'play').length, 1, calculation);
      records.push(...[0, .2].map(time => ({ type: 'state', generation: 2, settings_version: 2,
        sim_time_s: time, q: Array(7).fill(time), qd: Array(7).fill(1), ee_xyz: [time, 0, 1] })));
      source.emit({ type: 'status', state: 'playing', generation: 2, settings_version: 2, job_active: true });
      source.emit({ type: 'history', generation: 2, settings_version: 2, history_cursor: records.length }); await flush();
      live.frame(0); live.frame(100);
      assert.equal(live.history.selectedTime, .1, calculation);
      assert.equal(shown.at(-1).q[0], .1, calculation);
    } finally { live?.dispose(); Object.assign(globalThis, originals); }
  }
});

test('own settings echoes before or after HTTP acknowledgement retain the first Play intent', async () => {
  for (const echoBeforeHttp of [true, false]) {
    await sharedSettingsCase(async (h, live, source) => {
      let acknowledge;
      h.setCommandHandler((command, version) => command.type === 'patch_settings'
        ? new Promise(resolve => { acknowledge = () => resolve({ ok: true, json: async () => ({ accepted: true, settings_version: version }) }); })
        : { ok: true, json: async () => ({ accepted: true, settings_version: version }) });
      source.emit({ type: 'state', settings_version: 1, sim_time_s: 0, q: Array(7).fill(0), qd: Array(7).fill(0), ee_xyz: [0, 0, 1] });
      h.edit('solver_params.q_cost', 9); h.$('live-play').emit('click'); await flush();
      const ownEcho = { type: 'settings', ...live.settings, settings_version: 2 };
      if (echoBeforeHttp) source.emit(ownEcho);
      acknowledge(); await flush(); await flush();
      if (!echoBeforeHttp) source.emit(ownEcho);
      assert.equal(live.playing, true, `echo before HTTP: ${echoBeforeHttp}`);
      assert.equal(h.$('live-play').textContent, 'Pause');
      assert.equal(h.commands.filter(command => command.type === 'play').length, 1);
    });
  }
});

test('scrubbing during a dirty settings readiness check cancels the queued Play intent', async () => {
  const h = harness(); modelSchema(h);
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  const fetch = async (url, options) => url === '/api/source/model'
    ? { ok: true, json: async () => ({ compatible: true, compilation: { ready: true, N: 32, available_N: [32] } }) }
    : h.fetch(url, options);
  Object.assign(globalThis, { document: h.document, fetch, EventSource: h.EventSource });
  let live;
  try {
    live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await live.ready;
    h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); await flush();
    source.emit(plan(1, 1));
    h.edit('solver_params.q_cost', 9); h.$('live-play').emit('click');
    live.seek(0); // Cancels playback while the cached readiness Promise is still pending.
    await flush(); await flush();
    assert.equal(live.playing, false);
    assert.equal(h.$('live-play').textContent, 'Play');
    assert.equal(h.commands.some(command => command.type === 'play'), false);
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});

test('external numerical settings still pause active playback', async () => {
  await sharedSettingsCase(async (h, live, source) => {
    source.emit({ type: 'state', settings_version: 1, sim_time_s: 0, q: Array(7).fill(0), qd: Array(7).fill(0), ee_xyz: [0, 0, 1] });
    h.$('live-play').emit('click'); await flush(); assert.equal(live.playing, true);
    const remote = live.settings; remote.config.solver_params.q_cost = 19;
    source.emit({ type: 'settings', ...remote, settings_version: 2 });
    assert.equal(live.playing, false);
    assert.equal(h.$('live-play').textContent, 'Play');
  });
});

test('rejected Continue extension stops playback and does not retry every animation frame', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 });
    await flush(); source.emit(plan(1, 1));
    for (const time of [0, .2]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time, q: Array(7).fill(time), qd: Array(7).fill(0), ee_xyz: [time, 0, 1] });
    h.setCommandHandler((command, version) => command.type === 'play' ? { ok: false, json: async () => ({ accepted: false, error: 'History capacity reached' }) } : { ok: true, json: async () => ({ accepted: true, settings_version: version }) });
    h.$('live-continue').checked = true; h.$('live-continue').emit('change');
    h.$('live-play').emit('click'); await flush(); live.frame(performance.now() + 500); await flush();
    assert.equal(live.playing, false); assert.equal(h.commands.filter(command => command.type === 'play').length, 1);
    live.frame(performance.now() + 1000); await flush(); assert.equal(h.commands.filter(command => command.type === 'play').length, 1);
    assert.match(h.$('live-message').textContent, /History capacity reached/);
    h.$('replay-mode').emit('click'); await flush();
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('a pending static preview can be cancelled before a native solve finishes', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 });
    await flush(); assert.equal(live.pending, true); assert.equal(h.$('live-cancel').disabled, false);
    h.$('live-cancel').emit('click'); await flush(); assert.equal(h.commands.at(-1).type, 'cancel'); assert.equal(live.pending, false);
    h.$('replay-mode').emit('click'); await flush();
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('Cancel at a growing history tip pauses playback and cannot restart calculation with Continue enabled', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 });
    await flush(); source.emit(plan(1, 1));
    source.emit({ type: 'state', settings_version: 1, sim_time_s: 0, q: Array(7).fill(0), qd: Array(7).fill(0), ee_xyz: [0, 0, 1] });
    h.$('live-continue').checked = true; h.$('live-continue').emit('change');
    h.$('live-play').emit('click'); await flush();
    source.emit({ type: 'status', state: 'playing', settings_version: 1, job_active: true });
    live.frame(performance.now() + 1000); assert.equal(live.playing, true);
    const playsBeforeCancel = h.commands.filter(command => command.type === 'play').length;
    h.$('live-cancel').emit('click'); await flush();
    assert.equal(live.playing, false); assert.equal(h.$('live-continue').checked, true);
    source.emit({ type: 'status', state: 'paused', settings_version: 1, job_active: false });
    for (let i = 1; i <= 5; i++) live.frame(performance.now() + i * 1000);
    await flush();
    assert.equal(h.commands.filter(command => command.type === 'play').length, playsBeforeCancel);
    assert.equal(h.commands.at(-1).type, 'cancel');
    h.$('replay-mode').emit('click'); await flush();
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('Automatic history plans settle settings without a presentation plan SSE and keep Play available', async () => {
  const h = harness(); h.schema.defaults.execution.calculation = 'automatic';
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let version = 1;
  h.setHistoryHandler(async () => ({ ok: true, json: async () => ({ generation: version, next_cursor: 3, complete: true, records: [
    { ...plan(version, 1), generation: version },
    ...[0, .1].map(time => ({ type: 'state', generation: version, settings_version: version, sim_time_s: time, q: Array(7).fill(time), qd: Array(7).fill(0), ee_xyz: [time, 0, 1] })),
  ] }) }));
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 });
    await flush(); assert.equal(live.pending, true); assert.equal(h.$('live-play').disabled, false);
    source.emit({ type: 'history', generation: 1, settings_version: 1, history_cursor: 3, complete: true });
    await flush(); await flush();
    assert.equal(live.pending, false); assert.equal(live.plan.seq, 1); assert.equal(live.history.length, 2);
    assert.equal(live.precomputedPath.length, 2);
    live.frame(performance.now()); assert.doesNotMatch(h.$('live-plan-label').textContent, /settings pending/);
    h.edit('solver_params.q_cost', 9); assert.equal(live.precomputedPath, undefined);
    await new Promise(resolve => setTimeout(resolve, 380)); await flush();
    assert.equal(h.commands.at(-1).type, 'set_settings'); assert.equal(h.commands.at(-1).execution.calculation, 'automatic');
    version = 2;
    source.emit({ type: 'history', generation: 2, settings_version: 2, history_cursor: 3, complete: true });
    await flush(); await flush(); assert.equal(live.pending, false); assert.equal(live.plan.settings_version, 2);
    h.$('replay-mode').emit('click'); await flush();
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('accepted settings reconcile a completed job whose notices arrived before its HTTP acknowledgement', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let acknowledge;
  h.setCommandHandler((command, version) => command.type === 'set_settings' ? new Promise(resolve => { acknowledge = () => resolve({ ok: true, json: async () => ({ accepted: true, settings_version: version }) }); }) : { ok: true, json: async () => ({ accepted: true, settings_version: version }) });
  h.setHistoryHandler(async () => ({ ok: true, json: async () => ({ generation: 1, next_cursor: 2, complete: true, records: [
    { ...plan(1, 1), generation: 1 },
    { type: 'state', generation: 1, settings_version: 1, sim_time_s: 0, q: Array(7).fill(0), qd: Array(7).fill(0), ee_xyz: [0, 0, 1] },
  ] }) }));
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 1 });
    // The initial cached status made the browser provisionally expect v2.
    // The authoritative acknowledgement is v1; all v1 notices arrive first.
    source.emit({ type: 'status', state: 'paused', settings_version: 1, generation: 1, job_active: false });
    source.emit({ type: 'history', settings_version: 1, generation: 1, history_cursor: 2, complete: true });
    acknowledge(); await flush(); await flush();
    assert.equal(live.pending, false); assert.equal(live.plan.settings_version, 1); assert.equal(live.history.length, 1); assert.equal(h.$('live-play').disabled, false);
    h.$('replay-mode').emit('click'); await flush();
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('Play at an idle recorded end restarts history locally; an active growing tip keeps waiting', async () => {
  const h = harness(); h.schema.defaults.execution.calculation = 'manual';
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 });
    await flush(); source.emit(plan(1, 1));
    assert.equal(h.$('live-stop-at-end').disabled, false);
    for (const time of [0, .2]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time, q: Array(7).fill(time), qd: Array(7).fill(0), ee_xyz: [time, 0, 1] });
    h.$('live-history-latest').emit('click'); assert.equal(live.history.selectedTime, .2);
    const before = h.commands.length;
    h.$('live-play').emit('click'); await flush();
    assert.equal(live.history.selectedTime, 0); assert.equal(live.playing, true); assert.equal(h.commands.length, before);
    live.frame(performance.now() + 50); assert(live.displayedState.sim_time_s > 0 && live.displayedState.sim_time_s < .2);
    h.$('live-play').emit('click'); await flush();
    source.emit({ type: 'status', state: 'playing', settings_version: 1, job_active: true });
    h.$('live-history-latest').emit('click'); h.$('live-play').emit('click'); await flush();
    live.frame(performance.now() + 50); assert.equal(live.history.selectedTime, .2); assert.equal(live.playing, true);
    assert.equal(h.commands.filter(command => command.type === 'play').length, 0);
    h.$('replay-mode').emit('click'); await flush();
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('On Play Stop replays existing motion through the session end without starting another calculation', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const session = createSession(), live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); live.setSession(session);
    bindStopPreference(h.$('live-stop-at-end'), h.$('live-continue'));
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 });
    await flush(); source.emit(plan(1, 1));
    assert.equal(h.$('live-stop-at-end').disabled, false);
    assert.equal(h.$('live-stop-at-end').checked, true);
    assert.match(h.$('live-stop-at-end').title, /session end/);
    for (const time of [0, .2]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time, q: Array(7).fill(time), qd: Array(7).fill(0), ee_xyz: [time, 0, 1] });
    session.addTrack({ span: [0, 1] });
    const before = h.commands.length;
    // Stop is a local preference in On Play too; neither direction configures
    // the solver, replaces the generation or starts a job.
    h.$('live-stop-at-end').checked = false; h.$('live-stop-at-end').emit('change');
    h.$('live-stop-at-end').checked = true; h.$('live-stop-at-end').emit('change');
    assert.equal(live.settings.execution.continue_at_end, false);
    assert.equal(h.commands.length, before);
    h.$('live-history-latest').emit('click'); h.$('live-play').emit('click'); await flush();
    assert.equal(live.playing, true); assert.equal(live.history.selectedTime, .2);
    live.frame(0); live.frame(500); assert.equal(session.cursor, .7); assert.equal(live.playing, true);
    live.frame(1000); assert.equal(session.cursor, 1); assert.equal(live.playing, false);
    assert.equal(live.displayedState.sim_time_s, .2); assert.equal(h.commands.length, before);
    // Play at the finite session end starts its recording again locally.
    h.$('live-play').emit('click'); live.frame(0); live.frame(100);
    assert.equal(session.cursor, .1); assert.equal(live.playing, true); assert.equal(h.commands.length, before);
    h.$('live-play').emit('click'); await flush();
    session.removeTrack(session.tracks[1].id);
    live.seek(0); h.$('live-play').emit('click'); live.frame(0); live.frame(500);
    assert.equal(session.cursor, .2); assert.equal(live.playing, false);
    assert.equal(h.commands.filter(command => command.type === 'play').length, 0);
  } finally {
    h.$('replay-mode').emit('click'); await flush();
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('On Play Continue resumes the existing tip, while Stop can follow an already active calculation', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 });
    await flush(); source.emit(plan(1, 1));
    assert.equal(h.$('live-stop-at-end').disabled, false);
    assert.match(h.$('live-duration').title, /Precalculation duration/);
    for (const time of [0, .2]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time, q: Array(7).fill(time), qd: Array(7).fill(0), ee_xyz: [time, 0, 1] });
    h.$('live-history-latest').emit('click');
    h.$('live-continue').checked = true; h.$('live-continue').emit('change');
    h.$('live-play').emit('click'); await flush();
    assert.equal(live.history.selectedTime, .2); assert.equal(live.playing, true);
    assert.equal(h.commands.filter(command => command.type === 'play').length, 1);
    source.emit({ type: 'status', state: 'playing', settings_version: 1, job_active: true });
    for (let i = 1; i <= 3; i++) live.frame(performance.now() + 1000 * i);
    await flush(); assert.equal(live.playing, true); assert.equal(live.history.selectedTime, .2);
    assert.equal(h.commands.filter(command => command.type === 'play').length, 1); // No duplicate jobs at a growing tip.
    h.$('live-play').emit('click'); await flush(); assert.equal(live.playing, false);
    source.emit({ type: 'status', state: 'paused', settings_version: 1, job_active: false });
    live.frame(performance.now() + 4000);
    assert.equal(h.commands.filter(command => command.type === 'play').length, 1);
    h.$('live-continue').checked = false; h.$('live-continue').emit('change');
    assert.equal(live.settings.execution.continue_at_end, false);
    source.emit({ type: 'status', state: 'playing', settings_version: 1, job_active: true });
    h.$('live-play').emit('click'); live.frame(performance.now() + 5000);
    assert.equal(live.playing, true); assert.equal(live.history.following, true);
    assert.equal(h.commands.filter(command => command.type === 'play').length, 1);
  } finally {
    h.$('replay-mode').emit('click'); await flush();
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('slow growing playback keeps task handles disabled and reference geometry stable until explicitly paused', async () => {
  const h = harness();
  h.schema.task_anchors = { reach: [.5, -.2, 1], figure8: [.4, -.2, 1] };
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const references = [];
    const live = setupLive({ onMode() {}, onPlan() {}, onReference: value => references.push(value), onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    const appendState = time => source.emit({ type: 'state', settings_version: 1, sim_time_s: time,
      q: Array(7).fill(time), qd: Array(7).fill(0), ee_xyz: [time, 0, 1] });
    appendState(0); appendState(.2); h.$('live-history-latest').emit('click');
    h.$('live-continue').checked = true; h.$('live-continue').emit('change');
    assert.equal(live.targetInteraction.available, true);
    h.$('live-play').emit('click'); await flush();
    source.emit({ type: 'status', state: 'playing', settings_version: 1, job_active: true, calculation_rtf: .5 });
    const reference = live.reference, referenceCount = references.length, now = performance.now();
    const commands = h.commands.length;
    // Compute stalls at the tip, then supplies another short stretch. No user
    // Pause occurs, even though playback repeatedly enters/leaves the tip.
    for (let i = 0; i < 3; i++) {
      live.frame(now + 1000 + i * 1000);
      assert.equal(live.playing, true);
      assert.equal(live.targetInteraction.available, false);
      assert.equal(live.setTargetWorld([.8, 0, 1]), null);
      appendState(.3 + i * .1);
      live.frame(now + 1010 + i * 1000);
      assert(live.history.selectedTime < live.history.bounds[1]);
      assert.equal(live.targetInteraction.available, false);
      assert.equal(live.reference, reference);
    }
    assert.equal(references.length, referenceCount); // No line/marker allocation on each tip transition.
    assert.equal(h.commands.length, commands); // No automatic pause, settings update or new job.
    live.frame(now + 5000);
    h.$('live-play').emit('click'); await flush();
    assert.equal(live.playing, false); assert.equal(h.commands.at(-1).type, 'pause');
    assert.equal(live.targetInteraction.available, true);
    h.$('live-history').value = '.1'; h.$('live-history').emit('input');
    assert.equal(live.targetInteraction.available, false);
    h.$('live-history-latest').emit('click'); assert.equal(live.targetInteraction.available, true);
  } finally {
    h.$('replay-mode').emit('click'); await flush();
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('first Live connection requests atomic comfortable reset and rejects prior server episode snapshots', async () => {
  const h = harness(); h.setVersion(7);
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); let source = h.sources.at(-1); source.open();
    source.emit({ type: 'state', settings_version: 7, sim_time_s: 99, q: Array(7).fill(1), qd: Array(7).fill(.3), ee_xyz: [1, 0, 1] });
    source.emit({ type: 'status', state: 'paused', settings_version: 7 });
    source.emit(plan(7, 999));
    await flush();
    assert.equal(h.commands[0].reset, true);
    assert.equal(h.commands[0].anchor, undefined);
    assert.equal(live.plan, undefined);
    assert.equal(live.history.length, 0);
    source.emit(plan(8, 1));
    source.emit({ type: 'state', settings_version: 8, sim_time_s: 0, q: Array(7).fill(0), qd: Array(7).fill(0), ee_xyz: [0, 0, 1] });
    h.$('replay-mode').emit('click'); await flush(); h.$('live-mode').emit('click');
    source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 8 });
    await flush();
    assert.equal(h.commands.filter(command => command.reset).length, 1);
    assert.equal(live.history.length, 1);
    h.edit('solver_params.q_cost', 8); h.$('live-preview').emit('click'); await flush();
    assert.equal(h.commands.filter(command => command.type === 'set_settings').at(-1).reset, undefined);
  } finally {
    h.$('replay-mode').emit('click'); await flush();
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('N stays an available choice while dt and horizon edit the same prediction interval', async () => {
  const h = harness();
  h.schema.defaults.config.dt_s = .03;
  h.schema.parameters.push({ path: 'dt_s', kind: 'float', label: 'Knot interval', min: .001, max: .1 });
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await flush();
    const horizon = h.created.find(el => el.dataset.horizon === 'seconds');
    assert.equal(Number(horizon.value), .93);
    horizon.value = '1.55'; horizon.emit('input');
    assert.equal(live.settings.config.N, 32); assert.equal(live.settings.config.dt_s, .05);
    h.edit('N', 2); assert.equal(live.settings.config.N, 64); assert.equal(Number(horizon.value), 3.15);
    h.edit('dt_s', .02); assert.equal(Number(horizon.value), 1.26);
    horizon.value = ''; horizon.emit('input'); assert.equal(live.settings.config.dt_s, .02);
    horizon.value = '999'; horizon.emit('input'); assert.equal(live.settings.config.dt_s, .02);
    horizon.value = '3.15'; horizon.emit('input'); assert.equal(live.settings.config.dt_s, .05);
    assert.equal('horizon' in live.settings.config, false);
    assert.equal(h.created.filter(el => el.dataset.path === 'N').length, 1);
    assert.equal(h.created.filter(el => el.dataset.path === 'dt_s').length, 1);
  } finally {
    h.$('live-mode').emit('click'); h.$('replay-mode').emit('click'); await flush();
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('an equivalent settings echo preserves typed frequency notation in the derived Horizon field', async () => {
  const h = harness(); h.schema.defaults.config.dt_s = .03;
  h.schema.parameters.push({ path: 'dt_s', kind: 'float', label: 'Knot interval', min: .001, max: .1 });
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let live;
  try {
    live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await live.ready;
    h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush();
    const horizon = h.document.querySelector('[data-horizon="seconds"]');
    horizon.focus();
    horizon.value = '0.5 Hz'; horizon.emit('input');
    assert.equal(live.settings.config.dt_s, Number((2 / 31).toPrecision(12)));
    source.emit({ type: 'settings', ...live.settings, settings_version: 2 });
    assert.notEqual(h.document.querySelector('[data-horizon="seconds"]'), horizon);
    assert.equal(h.document.querySelector('[data-horizon="seconds"]').value, '0.5 Hz');
    assert.equal(h.document.activeElement, h.document.querySelector('[data-horizon="seconds"]'));
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});

test('figure-eight transforms use static start anchor, preserve period and reach, and clamp dimensions', async () => {
  const h = harness();
  h.schema.tasks[1].defaults.orientation_xyzw = [0, 0, 0, 1];
  h.schema.tasks[1].parameters.forEach(parameter => { parameter.max = parameter.path === 'period_s' ? 120 : .6; });
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    assert.equal(live.targetInteraction.available, true);
    assert.equal(live.setTaskTransform({size_m: [.3, .2]}), null);
    h.$('live-task').value = 'figure8'; h.$('live-task').emit('change'); await flush(); await flush();
    h.$('live-preview').emit('click'); await flush();
    source.emit(segment('figure8', { task_path_xyz: [[.4, -.3, 1.2], [.64, -.3, 1.2]] }));
    source.emit({...plan(2, 2, 'figure8'), reference_xyz: [[.5, -.22, 1.2], [.51, -.21, 1.2]]});
    assert.deepEqual(live.targetInteraction.position_world, [.4, -.3, 1.2]);
    assert.equal(live.targetInteraction.available, true);
    live.setTargetWorld([.5, -.2, 1.3]);
    assert.deepEqual(live.settings.task.target_offset_m, [.1, .1, .1]);
    const transformed = live.setTaskTransform({quaternion_xyzw: [1, 0, 0, 1], size_m: [2, -.1]});
    assert.deepEqual(transformed.size_m, [.6, .01]);
    assert.equal(live.settings.task.period_s, 8);
    assert(Math.abs(Math.hypot(...live.settings.task.orientation_xyzw) - 1) < 1e-15);
    assert.deepEqual(live.targetInteraction.position_world, [.5, -.19999999999999998, 1.3]);
    const retained = live.settings;
    assert.equal(live.setTaskTransform({quaternion_xyzw: [NaN, 0, 0, 1]}), null);
    assert.deepEqual(live.settings, retained);
    h.$('live-task').value = 'reach'; h.$('live-task').emit('change'); await flush(); await flush();
    assert.deepEqual(live.settings.task.target_offset_m, [.15, .2, .2]);
    h.$('live-task').value = 'figure8'; h.$('live-task').emit('change'); await flush(); await flush();
    assert.deepEqual(live.settings.task, retained.task); // includes edited rotation and dimensions
    const width = h.document.querySelector('[data-task-path="width_m"]'); width.value = '99'; width.emit('input');
    assert.equal(live.targetInteraction.available, false);
  } finally {
    h.$('replay-mode').emit('click'); await flush();
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('desired figure-eight redraws before planner responses and stale predictions cannot replace the local draft', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const references = [], predictions = [], states = [];
    const live = setupLive({ onMode() {}, onPlan: value => predictions.push(value), onReference: value => references.push(value), onState: (value, context) => states.push(context), onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush();
    const anchors = { reach: [.7, -.2, .9], figure8: [.5, -.2, .9] };
    source.emit(segment('reach', { task_anchors: anchors })); source.emit(plan(1, 1));
    h.$('live-task').value = 'figure8'; h.$('live-task').emit('change'); await flush(); await flush();
    const commandCount = h.commands.length;
    live.frame(0);
    assert.equal(references.at(-1).kind, 'figure8'); // No tracking plan has ever arrived.
    assert.deepEqual(references.at(-1).points[0], anchors.figure8);
    assert.equal(predictions.at(-1), null);
    const before = references.at(-1);
    live.setTaskTransform({ quaternion_xyzw: [0, 0, Math.SQRT1_2, Math.SQRT1_2], size_m: [.4, .2] });
    live.frame(1);
    assert.notDeepEqual(references.at(-1).points, before.points);
    assert(Math.abs(references.at(-1).points[128][1] - .2) < 1e-12);
    live.setTargetWorld([.6, -.1, 1]); live.frame(2);
    assert.deepEqual(references.at(-1).points[0], [.6, -.1, 1]);
    assert.equal(h.commands.length, commandCount); // Visible before the edit debounce or any POST.
    const current = references.at(-1);
    source.emit({ type: 'state', generation: 0, settings_version: 2, sim_time_s: 4, q: Array(7).fill(0), qd: Array(7).fill(0), ee_xyz: [9,9,9], target_xyz: [99,99,99] });
    live.frame(2.5);
    assert.deepEqual(states.at(-1).segment.task_anchors, anchors); // The state's context comes from its segment header.
    assert(Math.abs(states.at(-1).referenceTarget[0] - .6) < 1e-12);
    assert(Math.abs(states.at(-1).referenceTarget[1] - .3) < 1e-12); // Rotated/scaled half-cycle target, not the stale state target.
    assert.deepEqual(live.targetInteraction.position_world, [.6, -.1, 1]); // Gizmo pivot stays fixed even as the target moves.
    source.emit(plan(1, 2)); live.frame(3);
    assert.equal(references.at(-1), current); // Delayed optimizer response cannot redraw geometry.
    assert.equal(predictions.at(-1), null);
    h.$('live-preview').emit('click'); await flush(); live.frame(4);
    assert.equal(live.pending, true);
    assert.equal(references.at(-1), current);
    source.emit(plan(1, 3)); live.frame(5);
    assert.equal(references.at(-1), current);
    assert.deepEqual(live.targetInteraction.position_world, [.6, -.1, 1]);
  } finally {
    h.$('replay-mode').emit('click'); await flush();
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('setting resets use normalized schema defaults, keep selected N for Horizon, and do not submit passively', async () => {
  const h = harness(); h.schema.available_N = [16, 64]; h.schema.defaults.config.dt_s = .03;
  h.schema.parameters.push({ path: 'dt_s', label: 'Knot interval', kind: 'float', min: .001, max: .1 });
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  const reset = key => h.created.find(el => el.dataset.resetSetting === key);
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await flush();
    assert.deepEqual(live.settings.task.target_offset_m, [.15, .2, .2]);
    h.edit('target-offset-0', -.1);
    reset('task.target_offset_m.0').emit('click');
    assert.deepEqual(live.settings.task.target_offset_m, [.15, .2, .2]);
    h.edit('target-offset-1', -.1);
    reset('task.pose').emit('click');
    assert.deepEqual(live.settings.task.target_offset_m, [.15, .2, .2]);
    assert.equal(live.settings.config.N, 16); assert.equal(reset('config.N').disabled, true);
    h.edit('N', 1); assert.equal(live.settings.config.N, 64); assert.equal(reset('config.N').disabled, false);
    assert.equal(reset('config.horizon_s').disabled, true); // same default dt at selected N
    h.edit('dt_s', .04); assert.equal(reset('config.horizon_s').disabled, false);
    reset('config.horizon_s').emit('click'); assert.equal(live.settings.config.dt_s, .03); assert.equal(live.settings.config.N, 64);
    assert.equal(reset('config.horizon_s').disabled, true); assert.equal(reset('config.N').disabled, false);
    reset('config.N').emit('click'); assert.equal(live.settings.config.N, 16);
    h.edit('dt_s', ''); assert.equal(reset('config.dt_s').disabled, false);
    reset('config.dt_s').emit('click'); assert.equal(live.settings.config.dt_s, .03);
    for (let i = 0; i < 20; i++) live.frame(performance.now() + i * 20);
    await flush(); assert.equal(h.commands.length, 0); // all edits happened in Replay
    assert.deepEqual(live.settings.config.unlisted, { preserved: true });
    h.$('replay-mode').emit('click'); await flush();
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('active-task defaults, pose group and execution reset route through normal edits', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  const reset = key => h.created.filter(el => el.dataset.resetSetting === key).at(-1);
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await flush();
    await live.enterLive(); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush();
    h.$('live-task').value = 'figure8'; h.$('live-task').emit('change'); await flush(); await flush();
    const width = h.document.querySelector('[data-task-path="width_m"]'); width.value = '.4'; width.emit('input');
    assert.equal(reset('task.width_m').disabled, false); reset('task.width_m').emit('click'); assert.equal(live.settings.task.width_m, .24);
    h.edit('target-offset-0', .15); h.edit('target-offset-2', -.2); assert.equal(reset('task.pose').disabled, false);
    reset('task.pose').emit('click'); assert.deepEqual(live.settings.task.target_offset_m, [0, 0, 0]); assert.deepEqual(live.settings.task.orientation_xyzw, [0, 0, 0, 1]);
    h.$('live-duration').value = '20'; h.$('live-duration').emit('input'); assert.equal(reset('execution.duration_s').disabled, false);
    reset('execution.duration_s').emit('click'); assert.equal(live.settings.execution.duration_s, DEFAULT_EXECUTION.duration_s);
    assert.equal(live.settings.task.kind, 'figure8');
    h.$('replay-mode').emit('click'); await flush();
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('task switches restore independent reach and figure-eight positions and tracking dimensions', async () => {
  const h = harness(); h.schema.tasks[1].defaults.orientation_xyzw = [0, 0, 0, 1];
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  const switchTask = async kind => { h.$('live-task').value = kind; h.$('live-task').emit('change'); await flush(); await flush(); };
  const visibleOffsets = () => [0, 1, 2].map(i => Number(h.$(`target-offset-${i}`).value));
  const reset = key => h.created.filter(el => el.dataset.resetSetting === key).at(-1);
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await flush();
    await live.enterLive(); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush();
    assert.deepEqual(visibleOffsets(), [.15, .2, .2]);
    h.edit('target-offset-0', -.12); h.edit('target-offset-1', .31);
    await switchTask('figure8');
    assert.deepEqual(visibleOffsets(), [0, 0, 0]);
    assert.deepEqual(live.settings.task.target_offset_m, [0, 0, 0]);
    assert.equal(reset('task.pose').disabled, true);
    h.edit('target-offset-0', .08); h.edit('target-offset-2', -.09);
    const width = h.document.querySelector('[data-task-path="width_m"]'); width.value = '.4'; width.emit('input');
    await switchTask('reach');
    assert.deepEqual(visibleOffsets(), [-.12, .31, .2]);
    assert.deepEqual(live.settings.task, { kind: 'reach', target_offset_m: [-.12, .31, .2] });
    assert.equal(reset('task.pose').disabled, false);
    await switchTask('figure8');
    assert.deepEqual(visibleOffsets(), [.08, 0, -.09]);
    assert.equal(Number(h.document.querySelector('[data-task-path="width_m"]').value), .4);
    assert.deepEqual(live.settings.task.orientation_xyzw, [0, 0, 0, 1]);
    reset('task.pose').emit('click');
    assert.deepEqual(visibleOffsets(), [0, 0, 0]);
    await switchTask('reach');
    assert.deepEqual(visibleOffsets(), [-.12, .31, .2]);
    reset('task.pose').emit('click');
    assert.deepEqual(visibleOffsets(), [.15, .2, .2]);
    await switchTask('figure8');
    assert.deepEqual(visibleOffsets(), [0, 0, 0]);
    assert.equal(Number(h.document.querySelector('[data-task-path="width_m"]').value), .4);
    h.$('replay-mode').emit('click'); await flush();
    assert.equal(h.commands.filter(command => command.type === 'switch_task').length, 5);
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('solver profile refresh keeps native history anchor and compatible drafts, updates controls once, and never submits a solve', async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  h.setHistoryHandler(url => { const generation = Number(new URL(url, 'http://test').searchParams.get('generation')); return { ok: true, json: async () => ({ generation, complete: true, next_cursor: 1, records: [{ type: 'state', generation, settings_version: 1, sim_time_s: .1, q: Array(7).fill(.1), qd: Array(7).fill(-.2), ee_xyz: [.1, 0, 1] }] }) }; });
  try {
    let live; const events = [];
    live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {}, onSolverProfile: item => { events.push(item); return live.finishSolverProfileSwitch(item); } });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    for (const time of [0, .1, .2]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time, q: Array(7).fill(time), qd: Array(7).fill(-.2), ee_xyz: [time, 0, 1] });
    h.$('live-history').value = '.1'; h.$('live-history').emit('input');
    h.edit('solver_params.q_cost', 9.25); h.edit('target-offset-0', .31);
    const before = live.settings, count = h.commands.length, anchor = live.beginSolverProfileSwitch();
    assert.deepEqual(anchor, { sim_time_s: .1, q: Array(7).fill(.1), qd: Array(7).fill(-.2) });
    assert.equal(live.playing, false); assert.equal(h.$('live-preview').disabled, true);
    // Even a synthetic old button event cannot enqueue calculation while switching.
    h.$('live-preview').emit('click'); await flush(); assert.equal(h.commands.length, count);
    h.schema.available_N = [32, 128]; h.schema.parameters.push({ path: 'solver_params.new_weight', kind: 'float', min: 0 }); h.schema.defaults.config.solver_params.new_weight = .7;
    source.emit({ type: 'status', state: 'paused', settings_version: 1, generation: 2 });
    source.emit({ type: 'solver_profile', state: 'active', profile_id: 'candidate', generation: 2 }); await flush(); await flush();
    assert.equal(events.length, 1); assert.equal(live.history.generation, 2); assert.deepEqual(live.history.bounds, [.1, .1]);
    assert.equal(live.settings.config.N, before.config.N); assert.equal(live.settings.config.solver_params.q_cost, 9.25); assert.deepEqual(live.settings.task, before.task); assert.equal(live.settings.config.solver_params.new_weight, .7);
    const n = h.created.filter(input => input.dataset.path === 'N').at(-1); assert.deepEqual(n.children.map(option => option.textContent), ['32', '128']);
    assert.equal(h.$('target-offset-0').handlers.input.length, 2); // one edit and one reset indicator listener
    assert.equal(h.$('live-task').handlers.change.length, 1); assert.equal(h.commands.length, count);
    assert.equal(h.$('live-preview').disabled, false);
    // Repeat schema hydration without adding handlers or issuing a preview.
    live.beginSolverProfileSwitch(); await live.finishSolverProfileSwitch({ state: 'active', profile_id: 'main', generation: 3 }); await flush();
    assert.equal(h.$('target-offset-0').handlers.input.length, 2); assert.equal(h.$('live-task').handlers.change.length, 1); assert.equal(h.commands.length, count);
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('failed solver switch leaves paused history and settings intact; unavailable N requires an explicit choice', async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    for (const time of [0, .1, .2]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time, q: Array(7).fill(time), qd: Array(7).fill(0), ee_xyz: [time, 0, 1] });
    h.$('live-history').value = '.1'; h.$('live-history').emit('input');
    const retained = live.settings, beforeHistory = live.history, count = h.commands.length;
    live.beginSolverProfileSwitch(); await live.finishSolverProfileSwitch({ state: 'failed', profile_id: 'bad', error: 'N=32 unavailable' });
    assert.deepEqual(live.settings, retained); assert.deepEqual(live.history, beforeHistory); assert.equal(live.playing, false); assert.equal(h.$('live-preview').disabled, true); assert(h.$('live-message').textContent.includes('N=32 unavailable'));
    // A preflight rejection leaves the previous child usable and paused.
    live.beginSolverProfileSwitch(); await live.finishSolverProfileSwitch({ state: 'failed', profile_id: 'bad', active_profile_id: 'main', error: 'Prebuilt N unavailable' });
    assert.deepEqual(live.settings, retained); assert.deepEqual(live.history, beforeHistory); assert.equal(live.playing, false); assert.equal(h.$('live-preview').disabled, false); assert.equal(h.commands.length, count);
    // Defensive schema reconciliation also exposes a removed N rather than replacing it.
    h.schema.available_N = [16, 128]; live.beginSolverProfileSwitch(); await live.finishSolverProfileSwitch({ state: 'active', profile_id: 'other' });
    assert.equal(live.settings.config.N, 32); assert(h.$('live-message').textContent.includes('N=32')); assert.equal(h.$('live-preview').disabled, true);
    const n = h.created.filter(input => input.dataset.path === 'N').at(-1); assert.equal(n.value, '-1'); n.value = '1'; n.emit('input');
    assert.equal(live.settings.config.N, 128); assert.equal(h.$('live-preview').disabled, false); assert.equal(h.commands.length, count);
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('solver activation from Replay fetches the paused segment on Live entry without initial reset or preview', async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let downloads = 0;
  h.setHistoryHandler(() => { downloads++; return { ok: true, json: async () => ({ generation: 7, complete: true, next_cursor: 1, records: [{ type: 'state', generation: 7, settings_version: 0, sim_time_s: 2.5, q: Array(7).fill(.2), qd: Array(7).fill(0), ee_xyz: [.2, 0, 1] }] }) }; });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await flush();
    live.beginSolverProfileSwitch(); await live.finishSolverProfileSwitch({ state: 'active', profile_id: 'candidate', generation: 7 });
    assert.equal(downloads, 0); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', generation: 7, settings_version: 0 }); await flush();
    assert.equal(downloads, 1); assert.deepEqual(live.history.bounds, [2.5, 2.5]); assert.equal(h.commands.length, 0); assert.equal(live.playing, false);
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('fresh inspection holds local playback and pending edits without sending Live commands or moving the cursor', async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await flush();
    h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    for (const time of [0, .1, .2]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time, q: Array(7).fill(time), qd: Array(7).fill(0), ee_xyz: [time, 0, 1] });
    h.$('live-history').value = '.1'; h.$('live-history').emit('input'); h.$('live-play').emit('click'); await flush(); assert.equal(live.playing, true);
    const before = live.history.selectedTime, count = h.commands.length, pose = structuredClone(live.displayedState);
    live.holdForInspection(); live.frame(performance.now() + 10000);
    assert.equal(live.playing, false); assert.equal(live.history.selectedTime, before); assert.deepEqual(live.displayedState, pose); assert.equal(h.commands.length, count);
    h.edit('solver_params.q_cost', 7.5); const draft = live.settings; live.holdForInspection(); await new Promise(resolve => setTimeout(resolve, 380));
    assert.deepEqual(live.settings, draft); assert.equal(h.commands.length, count); assert.equal(live.history.selectedTime, before);
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('Live batches keep a right-edge cursor with smooth recorded motion, and scrubbing holds history', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  const records = [];
  const append = time => records.push({ type: 'state', generation: 1, settings_version: 1, sim_time_s: time,
    q: Array(7).fill(time), qd: Array(7).fill(1), torque_nm: [time], ee_xyz: [time, 0, 1] });
  h.setHistoryHandler(url => {
    const after = Number(new URL(url, 'http://local').searchParams.get('after'));
    return { ok: true, json: async () => ({ generation: 1, records: records.slice(after), next_cursor: records.length, complete: false }) };
  });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    append(0); append(.2);
    source.emit({ type: 'history', generation: 1, settings_version: 1, history_cursor: records.length }); await flush();
    h.$('live-continue').checked = true; h.$('live-continue').emit('change');
    h.$('live-history-latest').emit('click'); h.$('live-play').emit('click'); await flush();
    source.emit({ type: 'status', state: 'playing', generation: 1, settings_version: 1, job_active: true });
    live.frame(0);
    append(.3); append(.4);
    source.emit({ type: 'history', generation: 1, settings_version: 1, history_cursor: records.length }); await flush();
    // Receiving a batch neither snaps the pose nor moves the thumb left.
    assert.equal(live.history.following, true);
    assert.equal(live.history.selectedTime, .2);
    assert.equal(h.$('live-history').value, h.$('live-history').max.toString());
    live.frame(10);
    assert(Math.abs(live.history.selectedTime - .21) < 1e-12);
    assert.deepEqual(live.history.presentationBounds, [0, live.history.selectedTime]);
    assert.deepEqual(live.history.bounds, [0, .4]);
    assert(Math.abs(live.displayedState.q[0] - .21) < 1e-12);
    assert.deepEqual(live.displayedState.torque_nm, [.2]);
    assert.equal(h.$('live-history').value, h.$('live-history').max.toString());
    assert.match(h.$('live-history-note').textContent, /recorded through 0.40/);
    assert(Math.abs(parseFloat(h.$('live-history-intervals').style.width) - 100 * .4 / .21) < 1e-10);
    const commands = h.commands.length;
    h.$('live-history').value = '.1'; h.$('live-history').emit('input');
    assert.equal(live.playing, false);
    assert.equal(live.history.following, false);
    assert.deepEqual(live.history.presentationBounds, [0, .4]);
    assert.equal(h.$('live-history-intervals').style.width, '100%');
    assert.equal(h.$('live-history-intervals').style.clipPath, 'inset(0 0% 0 0)');
    append(.5);
    source.emit({ type: 'history', generation: 1, settings_version: 1, history_cursor: records.length }); await flush();
    live.frame(1000);
    assert.equal(live.history.selectedTime, .1);
    assert.deepEqual(live.history.presentationBounds, [0, .5]);
    assert.equal(h.commands.length, commands); // Inspecting history does not restart numerical work.
    h.$('live-play').emit('click'); await flush(); live.frame(0); live.frame(100);
    assert.equal(live.history.selectedTime, .2);
    assert.equal(live.history.following, false); // Historical playback keeps the full range.
    live.frame(1000);
    assert.equal(live.history.selectedTime, .5);
    assert.equal(live.history.following, true); // Rejoins Live only on reaching its end.
    h.$('live-play').emit('click'); await flush();
    assert.equal(live.history.following, false);
    assert.deepEqual(live.history.presentationBounds, live.history.bounds);
  } finally {
    h.$('replay-mode').emit('click'); await flush();
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('Play captures live-follow intent before delayed acknowledgement and incoming history pages', async () => {
  const h = harness();
  h.schema.task_anchors = { reach: [.5, -.2, 1] };
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  const records = [];
  const append = time => records.push({ type: 'state', generation: 1, settings_version: 1, sim_time_s: time,
    q: Array(7).fill(time), qd: Array(7).fill(0), ee_xyz: [time, 0, 1] });
  h.setHistoryHandler(url => ({ ok: true, json: async () => ({ generation: 1,
    records: records.slice(Number(new URL(url, 'http://local').searchParams.get('after'))), next_cursor: records.length, complete: false }) }));
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    append(0); append(.2);
    source.emit({ type: 'history', generation: 1, settings_version: 1, history_cursor: records.length }); await flush();
    h.$('live-history-latest').emit('click');
    let acknowledge;
    h.setCommandHandler(command => command.type === 'play' ? new Promise(resolve => { acknowledge = resolve; }) : { ok: true, json: async () => ({ accepted: true }) });
    h.$('live-continue').checked = true; h.$('live-continue').emit('change');
    assert.equal(live.settings.execution.continue_at_end, true);
    assert.equal(live.targetInteraction.available, true);
    h.$('live-play').emit('click');
    assert.equal(live.playing, true);
    assert.equal(h.$('live-play').textContent, 'Pause');
    assert.equal(live.targetInteraction.available, false);
    assert.equal(live.history.following, true);
    live.frame(0);
    append(.3); append(.4);
    source.emit({ type: 'history', generation: 1, settings_version: 1, history_cursor: records.length }); await flush();
    acknowledge({ ok: true, json: async () => ({ accepted: true, generation: 1 }) }); await flush();
    live.frame(10);
    assert.equal(live.history.following, true);
    assert(Math.abs(live.history.selectedTime - .21) < 1e-12);
    assert.deepEqual(live.history.bounds, [0, .4]);
    assert.equal(h.$('live-history').value, String(h.$('live-history').max));
  } finally {
    h.$('replay-mode').emit('click'); await flush();
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('late Play responses cannot override Pause, scrub, settings edits, or mode changes', async () => {
  for (const action of ['pause', 'scrub', 'settings', 'mode']) {
    const h = harness();
    const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
    Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
    h.setHistoryHandler(url => ({ ok: true, json: async () => ({ generation: Number(new URL(url, 'http://local').searchParams.get('generation')), records: [], next_cursor: 0, complete: true }) }));
    try {
      const live = createLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
      await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
      source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
      for (const time of [0, .2]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time,
        q: Array(7).fill(time), qd: Array(7).fill(0), ee_xyz: [time, 0, 1] });
      h.$('live-history-latest').emit('click');
      h.$('live-continue').checked = true; h.$('live-continue').emit('change');
      let acknowledgePlay, acknowledgePause;
      h.setCommandHandler(command => {
        if (command.type === 'play') return new Promise(resolve => { acknowledgePlay = resolve; });
        if (command.type === 'pause' && action === 'pause') return new Promise(resolve => { acknowledgePause = resolve; });
        return { ok: true, json: async () => ({ accepted: true }) };
      });
      h.$('live-play').emit('click');
      if (action === 'pause') h.$('live-play').emit('click');
      else if (action === 'scrub') { h.$('live-history').value = '.1'; h.$('live-history').emit('input'); }
      else if (action === 'settings') h.edit('solver_params.q_cost', 5);
      else h.$('replay-mode').emit('click');
      const selected = action === 'scrub' ? .1 : .2;
      assert.equal(live.playing, false, action);
      assert.equal(live.history.following, false, action);
      assert.equal(live.history.buffering, false, action);
      if (action === 'pause') assert.equal(h.$('live-play').textContent, 'Play'); // Before acknowledgement.
      acknowledgePlay({ ok: true, json: async () => ({ accepted: true, generation: 999 }) }); await flush();
      assert.equal(live.playing, false, action);
      assert.equal(live.history.generation, null, action); // Obsolete acknowledgement cannot replace history.
      assert.equal(live.history.selectedTime, selected, action);
      if (acknowledgePause) { acknowledgePause({ ok: true, json: async () => ({ accepted: true }) }); await flush(); }
      h.setCommandHandler(() => ({ ok: true, json: async () => ({ accepted: true }) }));
    } finally {
      h.$('replay-mode').emit('click'); await flush();
      for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    }
  }
});

test('first default Live Play follows even before any motion or command acknowledgement', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    source.emit({ type: 'state', settings_version: 1, sim_time_s: 0, q: Array(7).fill(0), qd: Array(7).fill(0), ee_xyz: [0, 0, 1] });
    let acknowledge;
    h.setCommandHandler(command => command.type === 'play' ? new Promise(resolve => { acknowledge = resolve; }) : { ok: true, json: async () => ({ accepted: true }) });
    h.$('live-play').emit('click'); live.frame(0);
    assert.equal(live.history.following, true);
    source.emit({ type: 'state', settings_version: 1, sim_time_s: .1, q: Array(7).fill(.1), qd: Array(7).fill(0), ee_xyz: [.1, 0, 1] });
    live.frame(10);
    assert.equal(live.history.selectedTime, .01);
    assert.equal(h.$('live-history').value, String(h.$('live-history').max));
    acknowledge({ ok: true, json: async () => ({ accepted: true }) }); await flush();
    assert.equal(live.history.following, true);
  } finally {
    h.$('replay-mode').emit('click'); await flush();
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('default Live playback waits for received lead, holds native samples, and presentation edits preserve the episode', async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = createLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    const sample = time => source.emit({ type: 'state', settings_version: 1, sim_time_s: time,
      q: Array(7).fill(time), qd: Array(7).fill(1), torque_nm: [time], ee_xyz: [time, 0, 1] });
    sample(0); h.$('live-play').emit('click'); await flush(); live.frame(0);
    assert.equal(live.playing, true); assert.equal(live.history.buffering, true);
    assert.equal(h.$('live-play').textContent, 'Pause'); assert.equal(live.targetInteraction.available, false);
    sample(.1); live.frame(100); assert.equal(live.history.selectedTime, 0);
    assert.match(h.$('live-history-position').textContent, /Buffering/);
    sample(.2); live.frame(200); assert.equal(live.history.selectedTime, 0);
    live.frame(250); assert.equal(live.history.selectedTime, .05);
    assert.equal(live.displayedState.q[0], 0); // Recorded sample, no invented joint pose.
    assert.equal(h.$('live-history').value, String(h.$('live-history').max));
    const commands = h.commands.length, before = live.history, settings = live.settings;
    live.setPresentationSettings({ report_hz: 10, buffer_ms: 200, interpolate: true }); live.frame(250);
    assert.equal(live.displayedState.q[0], .05);
    assert.deepEqual(live.displayedState.torque_nm, [0]);
    assert.equal(live.history.selectedTime, before.selectedTime); assert.equal(live.history.generation, before.generation);
    assert.deepEqual(live.history.bounds, before.bounds); assert.deepEqual(live.settings, settings); assert.equal(h.commands.length, commands);
    live.setPresentationSettings({ report_hz: 10, buffer_ms: 500, interpolate: false }); live.frame(260);
    assert.equal(live.history.buffering, true); assert.equal(live.history.selectedTime, .05);
    h.$('live-play').emit('click'); // Pause immediately cancels a buffer wait.
    assert.equal(live.history.buffering, false); assert.equal(live.playing, false); assert.equal(h.$('live-play').textContent, 'Play');
    sample(.8); live.frame(5000); assert.equal(live.history.selectedTime, .05);
    await flush();
    h.$('live-history').value = '.1'; h.$('live-history').emit('input');
    assert.equal(live.history.selectedTime, .1); assert.equal(live.displayedState.q[0], .1);
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('complete metadata cannot release a short buffer before remaining history pages arrive', async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  const records = Array.from({ length: 1100 }, (_, index) => ({ type: 'state', generation: 1, settings_version: 1,
    sim_time_s: index / 1000, q: Array(7).fill(index / 1000), qd: Array(7).fill(1), ee_xyz: [index / 1000, 0, 1] }));
  let finishPage;
  h.setHistoryHandler(url => {
    const params = new URL(url, 'http://local').searchParams;
    assert.equal(params.get('limit'), '1024');
    const after = Number(params.get('after'));
    if (after === 1024) return new Promise(resolve => { finishPage = () => resolve({ ok: true, json: async () => ({ generation: 1, records: records.slice(1024), next_cursor: 1100, complete: true }) }); });
    return { ok: true, json: async () => ({ generation: 1, records: records.slice(after, after + 1024), next_cursor: Math.min(1100, after + 1024), complete: true }) };
  });
  try {
    h.schema.defaults.execution.calculation = 'manual';
    const live = createLive({ presentationSettings: { report_hz: 10, buffer_ms: 2000, interpolate: false }, onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    source.emit({ type: 'history', generation: 1, settings_version: 1, history_cursor: 1100, complete: true }); await flush();
    assert.equal(live.history.complete, true); assert.equal(live.history.cursor, 1024);
    h.$('live-play').emit('click'); live.frame(0); live.frame(1000);
    assert.equal(live.history.buffering, true); assert.equal(live.history.selectedTime, 0);
    finishPage(); await flush(); live.frame(2000);
    assert.equal(live.history.cursor, 1100); assert.equal(live.history.buffering, false); assert.equal(live.history.selectedTime, 0);
    live.frame(2100); assert.equal(live.history.selectedTime, .1);
    live.frame(3500); assert.equal(live.history.selectedTime, 1.099); assert.equal(live.playing, false);
    const commands = h.commands.length;
    h.$('live-play').emit('click'); live.frame(0); live.frame(10);
    assert.equal(live.history.buffering, false); assert.equal(live.history.selectedTime, .01);
    assert.equal(h.commands.length, commands); // Completed manual recording never starts calculation.
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

const PREDICTOR_FRICTION = { coulomb_nm: [2.1, 2.6, 2, 1.95, .8, 1.1, .3], viscous_nm_s_per_rad: [3.35, 4.15, 2.45, 2.25, .5, .3, .15], width_rad_s: .03 };

// config.friction is MpcParams' predictor friction (null: loss-free); config.plant the simulated plant's
// integrator, friction switch, Coulomb law and tanh width.
const PLANT = { integrator: 'rk4', friction: false, coulomb_law: 'constraint', friction_width_rad_s: .03 };
function frictionSchema(h, { N = 32, on = [32], prediction = false } = {}) {
  h.schema.defaults.config.N = N;
  h.schema.defaults.config.friction = prediction ? structuredClone(PREDICTOR_FRICTION) : null;
  h.schema.defaults.config.plant = { ...PLANT };
  h.schema.available_N_by_friction = { off: [16, 32, 64], on };
  h.schema.friction = { coefficients: { coulomb_nm: PREDICTOR_FRICTION.coulomb_nm, viscous_nm_s_per_rad: PREDICTOR_FRICTION.viscous_nm_s_per_rad },
    source: 'reduced right-arm URDF (tiago.urdf_friction)' };
  h.schema.parameters.push(
    { path: 'friction', label: 'Predictor friction', kind: 'choice', group: 'Friction',
      choices: [{ value: null, label: 'Loss-free' }, { value: structuredClone(PREDICTOR_FRICTION), label: 'URDF, tanh 0.03 rad/s' }] },
    { path: 'plant.integrator', label: 'Plant integrator', kind: 'choice', group: 'Friction',
      choices: [{ value: 'rk4', label: 'RK4' }, { value: 'euler', label: 'Euler' }] },
    { path: 'plant.friction', label: 'Plant friction', kind: 'bool', group: 'Friction', description: 'URDF coefficients' },
    { path: 'plant.coulomb_law', label: 'Coulomb law', kind: 'choice', group: 'Friction', choices: ['tanh', 'sign', 'constraint'] },
    { path: 'plant.friction_width_rad_s', label: 'tanh width (rad/s)', kind: 'float', group: 'Friction', min: 1e-4, max: 1 },
  );
  return path => h.created.filter(el => el.dataset.path === path).at(-1);
}

test('adapter identity alone preserves the standard friction readout; friction ownership hides it', async () => {
  for (const controls of [[], ['law'], ['friction']]) {
    const h = harness(); frictionSchema(h);
    const section = { defaults: {}, parameters: [], controls,
      module: { path: '/visualizer/adapters/tiago.py', sha256: 'recorded', origin: 'bundled' } };
    h.schema.source_settings = { simulation: section, predictor: { ...section, controls: [] } };
    h.schema.defaults.source_settings = { simulation: {}, predictor: {} };
    const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
    Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
    try {
      setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await flush();
      const notes = h.created.filter(el => el.className === 'settings-note').map(el => el.textContent);
      assert.equal(notes.some(text => text?.startsWith('Coulomb (Nm), joints 1–7:')), !controls.includes('friction'));
    } finally { Object.assign(globalThis, originals); }
  }
});

test('friction controls start loss-free and submit independent plant and predictor friction from the frozen native anchor', async () => {
  const h = harness(), field = frictionSchema(h);
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    assert.equal(field('plant.integrator').value, '0'); assert.equal(field('plant.coulomb_law').value, '2');
    assert.equal(field('plant.friction').checked, false);
    // RK4 is loss-free: plant friction and its law are disabled, the tanh width hidden.
    assert.equal(field('plant.friction').disabled, true); assert.match(field('plant.friction').title, /RK4 is loss-free/);
    assert.equal(field('plant.coulomb_law').disabled, true);
    const widthRow = () => field('plant.friction_width_rad_s').closest('label').parentElement;
    assert.equal(widthRow().hidden, true);
    assert.equal(field('friction').value, '0');
    assert.deepEqual(field('friction').children.map(item => item.textContent), ['Loss-free', 'URDF, tanh 0.03 rad/s']);
    assert(!h.created.some(el => /hard-sign|RK4\)/.test(el.textContent || '')));
    assert(h.created.some(el => el.textContent === 'Coulomb (Nm), joints 1–7: 2.1, 2.6, 2, 1.95, 0.8, 1.1, 0.3'));
    assert(h.created.some(el => el.textContent === 'Viscous (Nm s/rad), joints 1–7: 3.35, 4.15, 2.45, 2.25, 0.5, 0.3, 0.15'));
    for (const time of [1, 1.2]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time,
      q: Array(7).fill(time), qd: Array(7).fill(-.2), ee_xyz: [time, 0, 1] });
    h.$('live-history').value = '1'; h.$('live-history').emit('input');
    const anchor = structuredClone(live.displayedState), presentation = live.presentationSettings;
    field('plant.integrator').value = '1'; field('plant.integrator').emit('input');
    assert.equal(field('plant.friction').disabled, false); assert.equal(field('plant.coulomb_law').disabled, true);
    field('plant.friction').checked = true; field('plant.friction').emit('input');
    assert.equal(field('plant.coulomb_law').disabled, false);
    assert.equal(live.playing, false);
    source.emit({ type: 'state', settings_version: 1, sim_time_s: 1.3, q: Array(7).fill(3), qd: Array(7).fill(2), ee_xyz: [3, 0, 1] });
    await new Promise(resolve => setTimeout(resolve, 380));
    const simulatorOnly = h.commands.at(-1);
    assert.equal(simulatorOnly.type, 'set_settings');
    assert.deepEqual(simulatorOnly.config.plant, { ...PLANT, integrator: 'euler', friction: true }); assert.equal(simulatorOnly.config.friction, null);
    assert.deepEqual(simulatorOnly.anchor, { sim_time_s: 1, q: anchor.q, qd: anchor.qd });
    assert.equal(simulatorOnly.reset, undefined); assert.deepEqual(live.presentationSettings, presentation);
    source.emit(plan(2, 2));
    field('plant.coulomb_law').value = '0'; field('plant.coulomb_law').emit('input');
    assert.equal(widthRow().hidden, false); assert.equal(field('plant.friction_width_rad_s').disabled, false);
    field('plant.friction_width_rad_s').value = '0.01'; field('plant.friction_width_rad_s').emit('input');
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.deepEqual(h.commands.at(-1).config.plant, { integrator: 'euler', friction: true, coulomb_law: 'tanh', friction_width_rad_s: .01 });
    source.emit(plan(3, 3));
    field('friction').value = '1'; field('friction').emit('input');
    field('plant.integrator').value = '0'; field('plant.integrator').emit('input');  // RK4 switches plant friction off
    assert.equal(field('plant.friction').checked, false); assert.equal(field('plant.friction_width_rad_s').disabled, true);
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.deepEqual(h.commands.at(-1).config.friction, PREDICTOR_FRICTION);
    assert.deepEqual(h.commands.at(-1).config.plant, { integrator: 'rk4', friction: false, coulomb_law: 'tanh', friction_width_rad_s: .01 });
    assert(h.commands.every(item => item.type === 'set_settings')); // No compile, source apply, or presentation request.
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('predictor friction keeps unsupported N visible and blocks calculation until the user chooses a compatible mode or N', async () => {
  const h = harness(), field = frictionSchema(h, { N: 64, prediction: false });
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    const before = h.commands.length;
    field('friction').value = '1'; field('friction').emit('input');
    assert.equal(live.settings.config.N, 64); assert.deepEqual(live.settings.config.friction, PREDICTOR_FRICTION);
    assert.equal(field('N').children[2].disabled, true); assert.match(field('N').children[2].textContent, /unavailable/);
    assert.equal(h.$('live-play').disabled, true); assert.equal(h.$('live-preview').disabled, true);
    assert.match(h.$('live-message').textContent, /N=64 is not compiled.*Settings › Backend/);
    await new Promise(resolve => setTimeout(resolve, 380)); assert.equal(h.commands.length, before);
    field('N').value = '1'; field('N').emit('input');
    assert.equal(live.settings.config.N, 32); assert.equal(h.$('live-play').disabled, false);
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.equal(h.commands.at(-1).config.N, 32); assert.deepEqual(h.commands.at(-1).config.friction, PREDICTOR_FRICTION);
    source.emit(plan(2, 2));
    field('friction').value = '0'; field('friction').emit('input');
    assert.equal(field('N').children[2].disabled, false); assert.equal(live.settings.config.N, 32);
    assert.equal(h.$('live-play').disabled, false);
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('a Build listed without a restart enables the draft N it compiled and offers new knot counts', async () => {
  const h = harness(), field = frictionSchema(h, { N: 64, on: [32] });
  h.schema.available_N = [32, 64];
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    field('friction').value = '1'; field('friction').emit('input');
    assert.equal(h.$('live-play').disabled, true);
    await new Promise(resolve => setTimeout(resolve, 380));
    const before = h.commands.length;
    source.emit({ type: 'compiled_modules', available_N: [16, 32, 64], available_N_by_friction: { off: [16, 32, 64], on: [32, 64] } });
    assert.deepEqual(field('N').children.map(item => item.textContent), ['16 · unavailable', '32', '64']); // 16: loss-free only
    assert.equal(field('N').value, '2'); assert.equal(h.$('live-play').disabled, false);
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.equal(h.commands.length, before + 1);
    assert.equal(h.commands.at(-1).config.N, 64); assert.deepEqual(h.commands.at(-1).config.friction, PREDICTOR_FRICTION);
    source.emit(plan(2, 2));
    field('friction').value = '0'; field('friction').emit('input');
    assert.equal(field('N').children[0].textContent, '16');
    field('N').value = '0'; field('N').emit('input');
    assert.equal(live.settings.config.N, 16); assert.equal(h.$('live-play').disabled, false);
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('unavailable friction transition cancels active work and keeps Cancel available without losing its frozen edit anchor', async () => {
  const h = harness(), field = frictionSchema(h, { N: 64, prediction: false });
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    for (const time of [1, 1.2]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time,
      q: Array(7).fill(time), qd: Array(7).fill(-.2), ee_xyz: [time, 0, 1] });
    h.$('live-history').value = '1'; h.$('live-history').emit('input');
    source.emit({ type: 'status', state: 'playing', settings_version: 1, job_active: true });
    h.$('live-play').emit('click'); await flush();
    const anchor = structuredClone(live.displayedState), before = h.commands.length;
    let acknowledgeCancel;
    h.setCommandHandler((command, version) => command.type === 'cancel'
      ? new Promise(resolve => { acknowledgeCancel = resolve; })
      : { ok: true, json: async () => ({ accepted: true, settings_version: version }) });
    field('friction').value = '1'; field('friction').emit('input');
    assert.equal(live.playing, false); assert.equal(h.$('live-play').disabled, true);
    assert.equal(h.$('live-cancel').disabled, false); // Transport works despite an incompatible numerical draft.
    assert.deepEqual(h.commands.slice(before), [{ type: 'cancel' }]);
    field('plant.friction').checked = true; field('plant.friction').emit('input');
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.deepEqual(h.commands.slice(before), [{ type: 'cancel' }]); // No repeated cancel or invalid submission.
    source.emit({ type: 'state', settings_version: 1, sim_time_s: 1.3, q: Array(7).fill(3), qd: Array(7).fill(2), ee_xyz: [3, 0, 1] });
    field('N').value = '1'; field('N').emit('input');
    await new Promise(resolve => setTimeout(resolve, 380));
    const accepted = h.commands.at(-1);
    assert.equal(accepted.type, 'set_settings'); assert.equal(accepted.config.N, 32);
    assert.deepEqual(accepted.anchor, { sim_time_s: anchor.sim_time_s, q: anchor.q, qd: anchor.qd });
    source.emit(plan(2, 2));
    const retained = live.settings;
    acknowledgeCancel({ ok: true, json: async () => ({ accepted: true }) }); await flush();
    assert.deepEqual(live.settings, retained); assert.equal(live.pending, false);
    assert.equal(live.plan.seq, 2); assert.equal(h.$('live-play').disabled, false);
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('Plant limit handling shows Clip effort and the three Stop on breach checkboxes in one row with their defaults', async () => {
  const h = harness();
  h.schema.defaults.config.plant = { friction: false, clip_effort: true, stop_on_breach: { position: true, velocity: true, torque: true } };
  h.schema.parameters.push({ path: 'plant.clip_effort', label: 'Clip effort', kind: 'bool', group: 'Limit handling', description: 'Clip each command' },
    ...[['position', 'Joint limits'], ['velocity', 'Velocity'], ['torque', 'Torque']].map(([key, label]) =>
      ({ path: `plant.stop_on_breach.${key}`, label, kind: 'bool', group: 'Limit handling', row: 'Stop on breach' })));
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    const field = path => h.created.filter(el => el.dataset.path === path).at(-1);
    assert.equal(field('plant.clip_effort').checked, true);
    const row = h.created.filter(el => el.className === 'parameter-row check-row');
    assert.equal(row.length, 1); assert.equal(row[0].children[0].textContent, 'Stop on breach');
    // Each checkbox keeps its own reset arrow beside it (setting-reset-field: [button, label]).
    const checks = row[0].children[1].children.map(field => field.children[1]);
    assert.deepEqual(checks.map(label => [label.className, label.children[0].dataset.path, label.children[0].checked, label.children[1].textContent]), [
      ['row-check', 'plant.stop_on_breach.position', true, 'Joint limits'], ['row-check', 'plant.stop_on_breach.velocity', true, 'Velocity'],
      ['row-check', 'plant.stop_on_breach.torque', true, 'Torque']]);
    assert(h.created.some(el => el.tagName === 'details' && el.open && el.children[0].textContent === 'Plant limit handling'));
    field('plant.clip_effort').checked = false; field('plant.clip_effort').emit('input');
    field('plant.stop_on_breach.velocity').checked = false; field('plant.stop_on_breach.velocity').emit('input');
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.deepEqual(h.commands.at(-1).config.plant, { friction: false, clip_effort: false, stop_on_breach: { position: true, velocity: false, torque: true } });
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('playback pauses at a recorded limit breach, and Play at a breach-ended tip continues the calculation', async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  const message = 'Limit breach at 0.100 s: joint 7 torque 850 Nm beyond its effort limit 26 Nm';
  const records = [...Array.from({ length: 11 }, (_, index) => ({ type: 'state', generation: 1, settings_version: 1,
    sim_time_s: index / 100, q: Array(7).fill(0), qd: Array(7).fill(0), ee_xyz: [index / 100, 0, 1] })),
    { type: 'breach', generation: 1, settings_version: 1, sim_time_s: .1, message,
      breaches: [{ joint_index: 6, quantity: 'torque', value: 850, limit: 26 }] }];
  h.setHistoryHandler(() => ({ ok: true, json: async () => ({ generation: 1, records, next_cursor: records.length, complete: false }) }));
  try {
    h.schema.defaults.execution.calculation = 'manual';
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    source.emit({ type: 'history', generation: 1, settings_version: 1, history_cursor: records.length, complete: false }); await flush();
    source.emit({ type: 'status', state: 'paused', generation: 1, settings_version: 1, job_active: false, message,
      breach: { sim_time_s: .1, breaches: records.at(-1).breaches } }); await flush();
    assert.equal(live.history.bounds[1], .1);
    h.$('live-play').emit('click'); live.frame(0); live.frame(50);
    assert.equal(live.playing, true); assert.equal(live.history.selectedTime, .05);
    live.frame(500);
    assert.equal(live.playing, false); assert.equal(live.history.selectedTime, .1);
    assert.equal(h.$('live-message').textContent, message);
    assert.equal(h.commands.filter(command => command.type === 'play').length, 0);
    assert(h.$('live-history-intervals').children.some(el => el.className === 'breach'));
    // Continue: Play at the breach sends the calculation on, although Manual stops at its end.
    h.$('live-play').emit('click'); await flush();
    assert.equal(h.commands.filter(command => command.type === 'play').length, 1);
    assert.equal(live.history.selectedTime, .1); assert.equal(live.playing, true);
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('On Play stops at a breach announced at the very time it resumed from, without extending past it', async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  const records = Array.from({ length: 4 }, (_, index) => ({ type: 'state', generation: 1, settings_version: 1,
    sim_time_s: index / 100, q: Array(7).fill(0), qd: Array(7).fill(0), ee_xyz: [index / 100, 0, 1] }));
  const breach = (time, text) => ({ type: 'breach', generation: 1, settings_version: 1, sim_time_s: time, message: text, breaches: [] });
  records.push(breach(.03, 'velocity breach'));
  h.setHistoryHandler(url => { const after = Number(new URL(url, 'http://local').searchParams.get('after'));
    return { ok: true, json: async () => ({ generation: 1, records: records.slice(after), next_cursor: records.length, complete: false }) }; });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    source.emit({ type: 'history', generation: 1, settings_version: 1, history_cursor: records.length, complete: false }); await flush();
    source.emit({ type: 'status', state: 'paused', generation: 1, settings_version: 1, job_active: false, message: 'velocity breach', breach: { sim_time_s: .03 } }); await flush();
    h.$('live-history-latest').emit('click');
    h.$('live-play').emit('click'); await flush();
    assert.equal(h.commands.filter(command => command.type === 'play').length, 1);
    // The resumed calculation stops again at once: a torque breach at the same tick.
    records.push(breach(.03, 'torque breach'));
    source.emit({ type: 'status', state: 'paused', generation: 1, settings_version: 1, job_active: false, message: 'torque breach', breach: { sim_time_s: .03 } });
    source.emit({ type: 'history', generation: 1, settings_version: 1, history_cursor: records.length, complete: false }); await flush();
    live.frame(performance.now() + 100); live.frame(performance.now() + 200);
    assert.equal(live.playing, false); assert.equal(h.$('live-message').textContent, 'torque breach');
    assert.equal(h.commands.filter(command => command.type === 'play').length, 1);
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('one session clock plays comparison tails at the chosen rate and edits clamp to recorded main states', async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  h.schema.defaults.execution.calculation = 'manual';
  const records = [1, 2].map(time => ({ type: 'state', generation: 1, settings_version: 1, sim_time_s: time,
    q: Array(7).fill(time), qd: Array(7).fill(.2), ee_xyz: [time, 0, 1] }));
  records.unshift({ ...segment('reach', { settings: h.schema.defaults, end_effector_frame: 'grasp' }), generation: 1, settings_version: 1 });
  h.setHistoryHandler(() => ({ ok: true, json: async () => ({ generation: 1, records, next_cursor: records.length, complete: true }) }));
  try {
    const session = createSession(), seen = [];
    const live = setupLive({ onMode() {}, onPlan() {}, onState(state) { seen.push([session.cursor, state.sim_time_s]); }, onReset() {} }); live.setSession(session);
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 });
    await flush(); source.emit(plan(1, 1)); source.emit({ type: 'history', generation: 1, settings_version: 1, history_cursor: records.length }); await flush();
    session.addTrack({ span: [0, 4], source: { kind: 'replay', id: 'other', revision: 'a' } });
    session.setAggregate({ start: 1.1, end: null });
    live.seek(1); h.$('live-speed').value = '2'; h.$('live-speed').emit('change');
    h.$('live-play').emit('click'); live.frame(0); live.frame(500); live.frame(1000);
    assert.equal(session.cursor, 3); assert.equal(live.history.selectedTime, 3); assert.deepEqual(live.history.sessionBounds, [1, 5]);
    assert.equal(live.displayedState.sim_time_s, 2); assert.equal(session.focused.displayedState.sim_time_s, 2);
    assert.equal(h.$('live-playback-rate').textContent, '2×'); assert.equal(h.$('live-speed').disabled, false);
    assert(seen.some(([cursor, recorded]) => cursor === 3 && recorded === 2));
    assert.equal(h.commands.filter(command => command.type === 'play').length, 0);
    h.$('live-play').emit('click'); await flush();
    h.$('live-continue').checked = true; h.$('live-continue').emit('change');
    live.seek(2); h.$('live-speed').value = '4'; h.$('live-speed').emit('change');
    source.emit({ type: 'status', state: 'calculating', settings_version: 1, generation: 1, job_active: true });
    h.$('live-play').emit('click'); await flush();
    assert.equal(h.$('live-speed').disabled, true); assert.equal(h.$('live-speed').value, '1');
    h.$('live-play').emit('click'); await flush();
    assert.equal(h.$('live-speed').disabled, false); assert.equal(h.$('live-speed').value, '4');
    source.emit({ type: 'status', state: 'paused', settings_version: 1, generation: 1, job_active: false });
    h.edit('solver_params.q_cost', 6); await new Promise(resolve => setTimeout(resolve, 380));
    assert.deepEqual(h.commands.at(-1).anchor, { sim_time_s: 2, q: Array(7).fill(2), qd: Array(7).fill(.2) });
    assert.deepEqual(session.aggregate, { start: 1.1, end: null });
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

for (const unavailable of ['no compiled N', 'predictor unavailable']) test(`unavailable Live (${unavailable}) keeps an empty main track and plays comparisons locally across a Replay roundtrip`, async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  if (unavailable === 'no compiled N') h.schema.available_N = [];
  else h.schema.available_N_by_friction = { off: [], on: [32] };
  try {
    const session = createSession(), live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    session.updateMain({ endEffectorFrame: 'known_grasp' }); live.setSession(session);
    await flush(); assert.equal(h.$('live-mode').disabled, false);
    assert.equal(session.focused.endEffectorFrame, 'known_grasp');
    h.$('live-mode').emit('click'); assert.equal(live.mode, 'live');
    if (unavailable === 'no compiled N') assert.equal(h.sources.length, 0);
    else { const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); }
    assert.equal(session.focused.empty, true); assert.equal(h.$('live-play').disabled, true);
    const track = session.addTrack({ span: [5, 6] });
    assert.equal(h.$('live-play').disabled, false); assert.equal(h.$('live-precalculate').disabled, true);
    live.seek(0); h.$('live-play').emit('click'); live.frame(0); live.frame(250);
    assert.equal(live.playing, true); assert.equal(session.cursor, .25);
    h.$('live-play').emit('click'); await flush(); assert.equal(live.playing, false);
    h.$('replay-mode').emit('click'); await flush(); h.$('live-mode').emit('click');
    assert.equal(session.tracks[1], track); assert.equal(session.cursor, .25);
    live.seek(.75); assert.equal(session.cursor, .75); assert.deepEqual(h.commands, []);
    live.seek(1); h.$('live-play').emit('click'); live.frame(0); live.frame(250);
    assert.equal(live.playing, true); assert.equal(session.cursor, .25); // Play restarts the finite local session.
    session.setVisible(track.id, false); live.frame(500);
    assert.equal(h.$('live-play').disabled, true); assert.equal(live.playing, false);
    session.setVisible(track.id, true); live.frame(600);
    assert.equal(h.$('live-play').disabled, false);
    h.$('live-play').emit('click'); live.frame(0); live.frame(250);
    assert.equal(live.playing, true);
    session.removeTrack(track.id); live.frame(500);
    assert.equal(h.$('live-play').disabled, true); assert.equal(live.playing, false);
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('disconnected Live replays its recorded main span locally and ignores a stale active producer status', async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const session = createSession(), live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); live.setSession(session);
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    for (const time of [0, .5, 1]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time,
      q: Array(7).fill(time), qd: Array(7).fill(.1), ee_xyz: [time, 0, 1] });
    source.emit({ type: 'status', state: 'playing', settings_version: 1, job_active: true });
    live.seek(0); source.readyState = 0; source.onerror();
    assert.equal(h.$('live-play').disabled, false); assert.equal(h.$('live-precalculate').disabled, true);
    assert.equal(live.history.growing, false);
    const before = h.commands.length;
    h.$('live-speed').value = '2'; h.$('live-speed').emit('change'); h.$('live-play').emit('click');
    live.frame(0); live.frame(250); assert.equal(session.cursor, .5); assert.equal(live.playing, true);
    live.frame(1000); assert.equal(session.cursor, 1); assert.equal(live.playing, false);
    h.$('live-play').emit('click'); live.frame(0); live.frame(250);
    assert.equal(session.cursor, .5); assert.equal(live.playing, true);
    h.$('live-play').emit('click'); await flush(); assert.deepEqual(h.commands.slice(before), []);
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

for (const available of [true, false]) test(`enterLive awaits initial schema readiness and enters one session with solver ${available ? 'available' : 'unavailable'}`, async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  let releaseSchema;
  if (!available) h.schema.available_N = [];
  Object.assign(globalThis, { document: h.document, EventSource: h.EventSource,
    fetch: (url, options) => url.endsWith('/schema') ? new Promise(resolve => { releaseSchema = resolve; }) : h.fetch(url, options) });
  try {
    const modes = [], live = setupLive({ onMode: mode => modes.push(mode), onPlan() {}, onState() {}, onReset() {} }); live.setSession(createSession());
    const entry = live.enterLive(); assert(live.ready instanceof Promise);
    assert.equal(live.mode, 'replay'); assert.equal(h.sources.length, 0);
    releaseSchema({ ok: true, json: async () => structuredClone(h.schema) }); await live.ready; await entry;
    assert.equal(live.mode, 'live'); assert.equal(h.sources.length, available ? 1 : 0);
    await live.enterLive(); assert.deepEqual(modes, ['live']); assert.equal(h.sources.length, available ? 1 : 0);
    assert.equal(h.$('live-panel').hidden, false); assert.equal(h.$('replay-controls').hidden, true);
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('Freeze posts the current generation, adds a replay track and rewinds before an Automatic edit', async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  h.schema.defaults.execution.calculation = 'automatic';
  const records = [3, 4].map(time => ({ type: 'state', generation: 1, settings_version: 1, sim_time_s: time,
    q: Array(7).fill(time), qd: Array(7).fill(.1), ee_xyz: [time, 0, 1] }));
  records.unshift({ ...segment('reach', { settings: h.schema.defaults }), generation: 1, settings_version: 1 });
  h.setHistoryHandler(() => ({ ok: true, json: async () => ({ generation: 1, records, next_cursor: records.length, complete: true }) }));
  const requests = [], item = { id: 'freeze-test', revision: 'r1', source: 'freeze', name: 'Freeze B' };
  h.setFreezeHandler(body => { requests.push(body); return { ok: true, json: async () => ({ accepted: true, item }) }; });
  try {
    const session = createSession(), frozen = [];
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {}, onFreeze: async value => {
      frozen.push(value); session.addTrack({ span: [3, 4], catalogSource: value.source, source: { kind: 'replay', id: value.id, revision: value.revision } });
    } }); live.setSession(session);
    await flush(); assert.equal(h.$('live-freeze').disabled, true);
    h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 });
    await flush(); source.emit(plan(1, 1)); source.emit({ type: 'history', generation: 1, settings_version: 1, history_cursor: records.length }); await flush(); live.frame(0);
    source.emit({ type: 'status', state: 'calculating', settings_version: 1, generation: 1, job_active: true });
    assert.equal(h.$('live-freeze').disabled, true);
    source.emit({ type: 'status', state: 'paused', settings_version: 1, generation: 1, job_active: false });
    assert.equal(h.$('live-freeze').disabled, false); live.seek(4);
    h.$('live-freeze').emit('click'); assert.equal(h.$('live-freeze').disabled, true); await flush();
    assert.deepEqual(requests, [{ generation: 1 }]); assert.deepEqual(frozen, [item]);
    assert.equal(session.tracks[1].offset_s, 0); assert.equal(live.sessionTime, 3); assert.equal(live.displayedState.sim_time_s, 3);
    h.edit('solver_params.q_cost', 7); assert.equal(h.$('live-freeze').disabled, true);
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.deepEqual(h.commands.at(-1).anchor, { sim_time_s: 3, q: Array(7).fill(3), qd: Array(7).fill(.1) });
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('the start pose is edited at the run start only: a drag previews the arm, a commit starts a new run at t = 0', async () => {
  const h = harness(), start = [-.39, -1.73, -.38, -2.33, 0, -1.21, .04];
  h.schema.defaults.config.joint_margin_rad = .1;
  h.schema.defaults.config.plant = { start_pose_rad: [...start] };
  h.schema.parameters.push({ path: 'plant.start_pose_rad', kind: 'joints', label: 'Start pose', group: 'Start pose',
    lower: Array(7).fill(-3), upper: Array(7).fill(3) });
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  const shown = [], resets = [];
  try {
    const session = createSession();
    const live = setupLive({ onMode() {}, onPlan() {}, onState: state => {
      shown.push(state); assert.equal(session.focused.displayedState, state);
    }, onReset: () => resets.push(1) });
    live.setSession(session); session.setAggregate({ start: .1, end: .4 });
    await flush();
    assert.equal(live.startPose, null);  // Replay: read-only
    h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush();
    assert.equal(h.commands.length, 1);
    // No generic settings field: the Joints tab edits it.
    assert(!h.created.some(el => el.dataset.path === 'plant.start_pose_rad'));
    source.emit(plan(1, 1));
    source.emit({ type: 'state', settings_version: 1, sim_time_s: 0, q: [...start], qd: Array(7).fill(0), ee_xyz: [0, 0, 1] });
    await flush();
    const pose = live.startPose;
    assert.deepEqual([pose.editable, pose.value, pose.defaults], [true, start, start]);
    assert.deepEqual([pose.planning.lower[0], pose.planning.upper[0]], [-2.9, 2.9]);
    // Dragging shows the pose at once, without a settings change.
    const dragged = start.map((v, i) => i === 3 ? v + .3 : v);
    live.previewStartPose(dragged);
    assert.deepEqual(shown.at(-1).q, dragged); assert.equal(shown.at(-1).start_pose_draft, true);
    assert.equal(h.commands.length, 1);
    live.previewStartPose(null);
    assert.equal(live.setStartPose([...dragged.slice(0, 6), 9]), true);  // clamped to the URDF range
    await new Promise(resolve => setTimeout(resolve, 380));
    const command = h.commands.at(-1);
    assert.equal(command.type, 'set_settings'); assert.equal(command.reset, true); assert.equal(command.anchor, undefined);
    assert.deepEqual(session.aggregate, { start: .1, end: .4 });
    assert.deepEqual(command.config.plant.start_pose_rad, [...dragged.slice(0, 6), 3]);
    assert.equal(resets.length, 2);  // the first Live reset and this one
    // Away from the run start the Joints tab is read-only; other edits continue from the displayed state.
    source.emit(plan(2, 1));
    for (const time of [0, .5]) source.emit({ type: 'state', settings_version: 2, sim_time_s: time, q: [...dragged.slice(0, 6), 3], qd: Array(7).fill(.1), ee_xyz: [0, 0, 1] });
    h.$('live-history').value = '0.5'; h.$('live-history').emit('input'); await flush();
    assert.equal(live.startPose.editable, false);
    assert.equal(live.setStartPose(start), false);
    // The Joints tab's Reset still works there: default start pose, new run at t = 0.
    assert.equal(live.startPose.resettable, true);
    assert.equal(live.resetStartPose(), true);
    await new Promise(resolve => setTimeout(resolve, 380));
    const back = h.commands.at(-1);
    assert.equal(back.type, 'set_settings'); assert.equal(back.reset, true); assert.equal(back.anchor, undefined);
    assert.deepEqual(back.config.plant.start_pose_rad, start);
    h.edit('solver_params.q_cost', 8);
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.equal(h.commands.at(-1).reset, undefined); assert.equal(h.commands.at(-1).anchor.sim_time_s, .5);
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

test('state callbacks observe the current displayed state and start-pose editability when seeking away from and back to zero', async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  h.schema.defaults.config.plant = { start_pose_rad: Array(7).fill(0) };
  h.schema.parameters.push({ path: 'plant.start_pose_rad', kind: 'joints', label: 'Start pose', lower: Array(7).fill(-3), upper: Array(7).fill(3) });
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const session = createSession(), observed = [];
    const live = setupLive({ onMode() {}, onPlan() {}, onReset() {}, onState(state) {
      observed.push({ shown: state.sim_time_s, displayed: live.displayedState?.sim_time_s,
        focused: session.focused.displayedState.sim_time_s, editable: live.startPose?.editable });
    } }); live.setSession(session);
    await live.enterLive(); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    for (const time of [0, 4]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time,
      q: Array(7).fill(time / 10), qd: Array(7).fill(0), ee_xyz: [time, 0, 1] });
    live.seek(0); observed.length = 0;
    live.seek(3.75);
    assert.deepEqual(observed.at(-1), { shown: 3.75, displayed: 3.75, focused: 3.75, editable: false });
    live.seek(0);
    assert.deepEqual(observed.at(-1), { shown: 0, displayed: 0, focused: 0, editable: true });
  } finally { h.$('replay-mode').emit('click'); await flush(); Object.assign(globalThis, originals); }
});

async function withReplayHarness({ replayOnly = false, calculation = 'on_play' } = {}, run) {
  const h = harness(); h.schema.defaults.execution.calculation = calculation;
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const session = createSession();
    const live = setupLive({ replayOnly, onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    live.setSession(session); await live.enterLive();
    await run({ h, live, session });
  } finally {
    h.$('replay-mode').emit('click'); await flush();
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
}

async function settleReplayHarness(h) {
  const source = h.sources.at(-1); source.open();
  source.emit({ type: 'status', state: 'paused', settings_version: 0 });
  await flush(); source.emit(plan(1, 1));
  for (const time of [0, .5]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time,
    q: Array(7).fill(time), qd: Array(7).fill(0), ee_xyz: [time, 0, 1] });
  return source;
}

test('initial Replay mode plays, scrubs, changes speed and rewinds recordings without subscribing or calculating', async () => {
  await withReplayHarness({ replayOnly: true }, async ({ h, live, session }) => {
    const recording = session.addTrack({ span: [10, 12], offset_s: -5 });
    session.addTrack({ span: [-100, 100], offset_s: 0, visible: false });
    assert.equal(live.mode, 'live'); assert.equal(live.replayOnly, true); assert.equal(session.replayOnly, true);
    assert.equal(h.sources.length, 0); assert.deepEqual(h.commands, []);
    assert.equal(h.$('live-panel').inert, true);
    assert.equal(h.$('live-preview').disabled, true); assert.equal(h.$('live-precalculate').disabled, true);
    assert.equal(live.targetInteraction.available, false); assert.equal(live.startPose, null);
    assert.deepEqual(live.history.sessionBounds, [5, 7]);

    h.$('live-reset').emit('click'); assert.equal(session.cursor, 5);
    h.$('live-speed').value = '2'; h.$('live-speed').emit('change');
    assert.equal(live.playbackRate, 2); assert.equal(session.rate, 2);
    // Even a retained Continue preference cannot extend Live from replay playback.
    h.$('live-continue').checked = true; h.$('live-continue').emit('change');
    h.$('live-play').emit('click'); live.frame(0); live.frame(500);
    assert.equal(session.cursor, 6); assert.equal(live.playing, true);
    live.frame(1500); assert.equal(session.cursor, 7); assert.equal(live.playing, false);
    live.seek(6.25); assert.equal(session.cursor, 6.25);
    h.$('live-reset').emit('click'); assert.equal(session.cursor, 5);
    h.$('live-preview').emit('click'); h.$('live-precalculate').emit('click');
    await flush(); assert.equal(h.sources.length, 0); assert.deepEqual(h.commands, []);

    session.removeTrack(recording.id); live.frame(2000);
    assert.equal(live.replayOnly, true); assert.equal(h.$('live-play').disabled, true);
    h.$('live-play').emit('click'); await flush(); assert.deepEqual(h.commands, []);
  });
});

test('computing reports numerical jobs and previews, independently of retained playback and disconnected Replay', async () => {
  await withReplayHarness({ calculation: 'manual' }, async ({ h, live, session }) => {
    const source = await settleReplayHarness(h);
    assert.equal(live.computing, false);
    h.$('live-play').emit('click'); live.frame(0); live.frame(100);
    assert.equal(live.playing, true); assert.equal(live.computing, false);
    source.emit({ type: 'status', state: 'calculating', settings_version: 1, job_active: true });
    assert.equal(live.computing, true);
    source.emit({ type: 'status', state: 'paused', settings_version: 1, job_active: false });
    assert.equal(live.playing, true); assert.equal(live.computing, false);
    h.$('live-preview').emit('click'); await flush();
    assert.equal(live.playing, false); assert.equal(live.computing, true);
    source.emit(plan(1, 2)); assert.equal(live.computing, false);
    source.emit({ type: 'status', state: 'calculating', settings_version: 1, job_active: true });
    assert.equal(live.computing, true);
    session.addTrack({ span: [0, 2], offset_s: 0 }); await live.setReplayOnly(true);
    assert.equal(live.computing, false);
    source.emit({ type: 'status', state: 'playing', settings_version: 1, job_active: true });
    assert.equal(live.computing, false);
  });
});

for (const calculation of ['manual', 'automatic']) {
  test(`Replay mode cancels active ${calculation} precalculation while retaining Live history`, async () => {
    await withReplayHarness({ calculation }, async ({ h, live, session }) => {
      const source = await settleReplayHarness(h);
      const recording = session.addTrack({ span: [0, 2], offset_s: 0 });
      h.$('live-precalculate').emit('click'); await flush();
      source.emit({ type: 'status', state: 'precalculating', settings_version: 1, job_active: true });
      const before = h.commands.length, settings = live.settings;
      await live.setReplayOnly(true);
      assert.deepEqual(h.commands.slice(before), [{ type: 'cancel' }]);
      assert.equal(source.readyState, 2); assert.equal(live.playing, false);
      assert.equal(live.history.length, 2); assert.deepEqual(live.history.bounds, [0, .5]);
      assert.deepEqual(live.settings, settings); assert.equal(session.track(recording.id), recording);
      assert.deepEqual(live.history.sessionBounds, [0, 2]);
      // A detached stream cannot resume a producer or replace retained history.
      source.emit({ type: 'status', state: 'playing', settings_version: 1, job_active: true });
      source.emit({ type: 'state', settings_version: 1, sim_time_s: 99, q: Array(7).fill(0), ee_xyz: [99, 0, 1] });
      live.frame(1000); assert.equal(live.history.length, 2); assert.equal(live.playing, false);
      assert.equal(h.commands.length, before + 1);
    });
  });
}

test('entering Replay mode drops a queued settings debounce and ignores further Live edits', async () => {
  await withReplayHarness({}, async ({ h, live, session }) => {
    await settleReplayHarness(h); session.addTrack({ span: [0, 2], offset_s: 0 });
    h.edit('solver_params.q_cost', 9);
    const draft = live.settings, before = h.commands.length;
    await live.setReplayOnly(true);
    h.edit('solver_params.q_cost', 12);
    h.$('live-preview').emit('click'); h.$('live-precalculate').emit('click');
    await new Promise(resolve => setTimeout(resolve, 380)); await flush();
    assert.deepEqual(h.commands.slice(before), [{ type: 'cancel' }]);
    assert.deepEqual(live.settings, draft); assert.equal(live.playing, false);
    assert.equal(h.sources.length, 1);
  });
});

test('a late Play acknowledgement cannot restart Live or replace its generation after entering Replay mode', async () => {
  await withReplayHarness({}, async ({ h, live, session }) => {
    await settleReplayHarness(h); session.addTrack({ span: [0, 2], offset_s: 0 });
    let acknowledge;
    h.setCommandHandler((command, version) => command.type === 'play'
      ? new Promise(resolve => { acknowledge = () => resolve({ ok: true, json: async () => ({ accepted: true, generation: 99, settings_version: version }) }); })
      : { ok: true, json: async () => ({ accepted: true, settings_version: version }) });
    h.$('live-continue').checked = true; h.$('live-continue').emit('change');
    live.seek(.5); h.$('live-play').emit('click'); await flush();
    assert.equal(typeof acknowledge, 'function');
    const generation = live.generation;
    await live.setReplayOnly(true); const commands = h.commands.length;
    acknowledge(); await flush(); await flush(); live.frame(1000);
    assert.equal(live.generation, generation); assert.equal(live.playing, false);
    assert.equal(live.replayOnly, true); assert.equal(h.commands.length, commands);
    assert.equal(live.history.length, 2);
  });
});

test('a late settings acknowledgement cannot continue a pending Play after entering Replay mode', async () => {
  await withReplayHarness({}, async ({ h, live, session }) => {
    await settleReplayHarness(h); session.addTrack({ span: [0, 2], offset_s: 0 });
    let acknowledge;
    h.setCommandHandler((command, version) => command.type === 'set_settings'
      ? new Promise(resolve => { acknowledge = () => resolve({ ok: true, json: async () => ({ accepted: true, generation: 99, settings_version: version }) }); })
      : { ok: true, json: async () => ({ accepted: true, settings_version: version }) });
    h.edit('solver_params.q_cost', 9); h.$('live-play').emit('click'); await flush();
    assert.equal(typeof acknowledge, 'function');
    const generation = live.generation;
    await live.setReplayOnly(true); const commands = h.commands.length;
    acknowledge(); await flush(); await flush();
    assert.equal(live.generation, generation); assert.equal(live.playing, false);
    assert.equal(live.replayOnly, true); assert.equal(h.commands.length, commands);
    assert.equal(h.commands.filter(command => command.type === 'play').length, 0);
    assert.equal(live.settings.config.solver_params.q_cost, 9);
  });
});

test('returning from Replay mode restores the settled Live run and recordings paused without another solve', async () => {
  await withReplayHarness({}, async ({ h, live, session }) => {
    await settleReplayHarness(h);
    const recording = session.addTrack({ span: [10, 12], offset_s: -10, displayName: 'Reference run' });
    session.setDisplay('live', 'hidden');
    const settings = live.settings, retainedPlan = live.plan, generation = live.generation;
    await live.setReplayOnly(true); live.seek(1);
    const before = h.commands.length;
    await live.setReplayOnly(false);
    const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 1, job_active: false }); await flush();
    assert.equal(live.replayOnly, false); assert.equal(session.replayOnly, false);
    assert.equal(live.playing, false); assert.equal(session.cursor, 1);
    assert.equal(live.history.length, 2); assert.deepEqual(live.history.bounds, [0, .5]);
    assert.equal(live.generation, generation); assert.equal(live.plan, retainedPlan);
    assert.deepEqual(live.settings, settings); assert.equal(session.track('live').display, 'hidden');
    assert.equal(session.track(recording.id), recording); assert.equal(recording.offset_s, -10);
    assert.equal(recording.displayName, 'Reference run'); assert.equal(h.$('live-panel').inert, false);
    assert.equal(h.commands.length, before); assert.equal(h.sources.length, 2);
  });
});

test('a quick return from Replay mode waits for cancellation before reconnecting Live', async () => {
  await withReplayHarness({}, async ({ h, live, session }) => {
    const source = await settleReplayHarness(h); session.addTrack({ span: [0, 2], offset_s: 0 });
    let acknowledge;
    h.setCommandHandler((command, version) => command.type === 'cancel'
      ? new Promise(resolve => { acknowledge = () => resolve({ ok: true, json: async () => ({ accepted: true, settings_version: version }) }); })
      : { ok: true, json: async () => ({ accepted: true, settings_version: version }) });
    const entering = live.setReplayOnly(true);
    const returning = live.setReplayOnly(false);
    await flush(); assert.equal(source.readyState, 2); assert.equal(h.sources.length, 1);
    assert.equal(live.playing, false); assert.equal(h.commands.at(-1).type, 'cancel');
    acknowledge(); await Promise.all([entering, returning]);
    assert.equal(h.sources.length, 2); assert.equal(live.replayOnly, false);
    assert.equal(live.playing, false); assert.equal(live.history.length, 2);
  });
});

test('Replay Play at the end rewinds locally even when retained Live ended at the same time with a breach', async () => {
  await withReplayHarness({}, async ({ h, live, session }) => {
    const source = await settleReplayHarness(h);
    const records = [{ ...plan(1, 1), generation: 1 },
      ...[0, .1].map(time => ({ type: 'state', generation: 1, settings_version: 1,
        sim_time_s: time, q: Array(7).fill(time), qd: Array(7).fill(0), ee_xyz: [time, 0, 1] })),
      { type: 'breach', generation: 1, settings_version: 1, sim_time_s: .1,
        message: 'Live velocity breach', breaches: [] }];
    h.setHistoryHandler(async () => ({ ok: true, json: async () => ({ generation: 1,
      next_cursor: records.length, complete: false, records }) }));
    source.emit({ type: 'history', generation: 1, settings_version: 1,
      history_cursor: records.length, complete: false }); await flush(); await flush();
    assert.deepEqual(live.history.bounds, [0, .1]); assert.equal(live.history.breaches.length, 1);
    source.emit({ type: 'status', state: 'paused', generation: 1, settings_version: 1,
      job_active: false, breach: { sim_time_s: .1 }, message: 'Live velocity breach' });
    session.addTrack({ span: [0, .1], offset_s: 0 });
    live.seek(.1); await live.setReplayOnly(true);
    const before = h.commands.length;
    h.$('live-play').emit('click');
    assert.equal(session.cursor, 0); assert.equal(live.playing, true);
    live.frame(0); live.frame(50);
    assert.equal(session.cursor, .05); assert.equal(live.playing, true);
    live.frame(100); await flush();
    assert.equal(session.cursor, .1); assert.equal(live.playing, false);
    assert.equal(h.commands.length, before);
  });
});

test('returning from Replay mode does not restart cancelled Automatic calculation that produced no plan', async () => {
  await withReplayHarness({ calculation: 'automatic' }, async ({ h, live, session }) => {
    h.setHistoryHandler(async () => ({ ok: true, json: async () => ({ generation: 1,
      next_cursor: 0, complete: false, records: [] }) }));
    const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush();
    assert.equal(h.commands.at(-1).type, 'set_settings');
    assert.equal(h.commands.at(-1).execution.calculation, 'automatic');
    assert.equal(live.plan, undefined); assert.equal(live.pending, true);
    source.emit({ type: 'status', state: 'precalculating', generation: 1,
      settings_version: 1, job_active: true });
    session.addTrack({ span: [0, 2], offset_s: 0 });
    const settings = live.settings;
    await live.setReplayOnly(true); assert.equal(h.commands.at(-1).type, 'cancel');
    const before = h.commands.length;
    await live.setReplayOnly(false);
    const reconnected = h.sources.at(-1); reconnected.open();
    reconnected.emit({ type: 'status', state: 'paused', generation: 1,
      settings_version: 1, job_active: false }); await flush(); await flush();
    assert.equal(h.commands.length, before); assert.equal(live.playing, false);
    assert.equal(live.plan, undefined); assert.deepEqual(live.settings, settings);
    assert.equal(session.tracks.length, 2); assert.equal(live.replayOnly, false);
  });
});

// Shared settings are authoritative even when an agent writes outside this tab.
async function sharedSettingsCase(run, { initial } = {}) {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  if (initial) h.setSettingsHandler(() => ({ ok: true, json: async () => structuredClone(initial) }));
  const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
  try {
    await live.ready; await live.enterLive();
    const source = h.sources.at(-1); source.open();
    if (initial) source.emit({ type: 'settings', ...initial });
    source.emit({ type: 'status', state: 'paused', settings_version: initial?.settings_version ?? 0 });
    await flush();
    if (!initial) {
      source.emit(plan(1, 1));
      source.emit({ type: 'settings', ...live.settings, settings_version: 1 });
    }
    await run(h, live, source);
  } finally {
    live.dispose(); await flush();
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
}

test('agent settings hydrate fields and reset indicators; next browser edit sends only its own patch', async () => {
  await sharedSettingsCase(async (h, live, source) => {
    const remote = structuredClone(live.settings); remote.config.solver_params.q_cost = 27; remote.config.N = 64;
    remote.execution.to_hz = 0; remote.execution.solve_latency_s = .0055;
    const count = h.commands.length;
    source.emit({ type: 'settings', ...remote, settings_version: 2 });
    assert.deepEqual(live.settings, remote);
    assert.equal(h.created.filter(el => el.dataset.path === 'solver_params.q_cost').at(-1).value, '27');
    assert.equal(h.$('live-to-asap').checked, true);
    assert.equal(h.$('live-to-hz').disabled, true);
    assert.notEqual(h.$('live-to-hz').value, '0');
    assert.equal(h.$('live-solve-latency').value, '0.0055');
    assert.equal(h.$('live-latency-measured').checked, false);
    assert.equal(h.created.filter(el => el.dataset.resetSetting === 'config.solver_params.q_cost').at(-1)?.disabled, false);
    assert.equal(h.commands.length, count);
    h.setVersion(2); h.edit('solver_params.max_pcg_iters', 333); h.$('live-preview').emit('click'); await flush();
    const sent = h.commands.findLast(command => command.type === 'patch_settings');
    assert.deepEqual(sent.patch, { config: { solver_params: { max_pcg_iters: 333 } } });
    assert.equal(sent.expected_settings_version, 2);
    assert.equal(live.settings.config.solver_params.q_cost, 27);
  });
});

test('separate measured and back-to-back checkboxes submit native modes and preserve numeric drafts', async () => {
  await sharedSettingsCase(async (h, live, source) => {
    assert.equal(h.$('live-latency-measured').checked, true);
    assert.equal(h.$('live-solve-latency').disabled, true);
    assert.notEqual(h.$('live-solve-latency').value, 'measured');
    h.$('live-latency-measured').checked = false; h.$('live-latency-measured').emit('change');
    h.$('live-solve-latency').value = '5.5 ms'; h.$('live-solve-latency').emit('input');
    h.$('live-to-asap').checked = true; h.$('live-to-asap').emit('change');
    h.$('live-preview').emit('click'); await flush();
    const sent = h.commands.findLast(command => command.type === 'patch_settings');
    assert.deepEqual(sent.patch.execution, { to_hz: 0, solve_latency_s: .0055 });
    source.emit({ type: 'settings', ...live.settings, settings_version: 2 }); h.setVersion(2);
    h.$('live-latency-measured').checked = true; h.$('live-latency-measured').emit('change');
    h.$('live-preview').emit('click'); await flush();
    assert.equal(h.commands.findLast(command => command.type === 'patch_settings').patch.execution.solve_latency_s, 'measured');
    assert.equal(h.$('live-solve-latency').disabled, true);
    assert.equal(h.$('live-solve-latency').value, '5.5 ms');
    h.$('live-to-asap').checked = false; h.$('live-to-asap').emit('change');
    assert.equal(h.$('live-to-hz').disabled, false);
    h.$('live-preview').emit('click'); await flush();
    assert.equal(h.commands.findLast(command => command.type === 'patch_settings').patch.execution.to_hz, DEFAULT_EXECUTION.to_hz);
  });
});

test('plan age checkbox submits nullable seconds and retains the numeric draft while disabled', async () => {
  await sharedSettingsCase(async (h, live, source) => {
    assert.equal(live.settings.execution.max_plan_age_s, null);
    assert.equal(h.$('live-plan-age-enabled').checked, false);
    assert.equal(h.$('live-max-plan-age').disabled, true);
    assert.equal(h.$('live-max-plan-age').value, '0.1');
    h.$('live-plan-age-enabled').checked = true; h.$('live-plan-age-enabled').emit('change');
    h.$('live-max-plan-age').value = '250 ms'; h.$('live-max-plan-age').emit('input');
    h.$('live-preview').emit('click'); await flush();
    assert.deepEqual(h.commands.findLast(command => command.type === 'patch_settings').patch.execution,
      { max_plan_age_s: .25 });
    source.emit({ type: 'settings', ...live.settings, settings_version: 2 }); h.setVersion(2);
    h.$('live-plan-age-enabled').checked = false; h.$('live-plan-age-enabled').emit('change');
    h.$('live-preview').emit('click'); await flush();
    assert.deepEqual(h.commands.findLast(command => command.type === 'patch_settings').patch.execution,
      { max_plan_age_s: null });
    assert.equal(h.$('live-max-plan-age').disabled, true);
    assert.equal(h.$('live-max-plan-age').value, '250 ms');
    source.emit({ type: 'settings', ...live.settings, settings_version: 3 }); h.setVersion(3);
    h.$('live-plan-age-enabled').checked = true; h.$('live-plan-age-enabled').emit('change');
    h.$('live-preview').emit('click'); await flush();
    assert.equal(h.$('live-max-plan-age').disabled, false);
    assert.equal(h.commands.findLast(command => command.type === 'patch_settings').patch.execution.max_plan_age_s, .25);
    const reset = h.created.findLast(element => element.dataset.resetSetting === 'execution.max_plan_age_s');
    assert.equal(reset.disabled, false);
    reset.emit('click');
    assert.equal(live.settings.execution.max_plan_age_s, null);
    assert.equal(h.$('live-plan-age-enabled').checked, false);
  });
});

test('remote plan age settings hydrate the enabled state and preserve typed equivalent values', async () => {
  await sharedSettingsCase(async (h, live, source) => {
    const remote = structuredClone(live.settings); remote.execution.max_plan_age_s = .2;
    source.emit({ type: 'settings', ...remote, settings_version: 2 }); h.setVersion(2);
    assert.equal(h.$('live-plan-age-enabled').checked, true);
    assert.equal(h.$('live-max-plan-age').disabled, false);
    assert.equal(h.$('live-max-plan-age').value, '0.2');
    assert.equal(h.created.findLast(element => element.dataset.resetSetting === 'execution.max_plan_age_s').disabled, false);
    h.$('live-max-plan-age').value = '200 ms'; h.$('live-max-plan-age').emit('input');
    source.emit({ type: 'settings', ...remote, settings_version: 3 });
    assert.equal(h.$('live-max-plan-age').value, '200 ms');
    remote.execution.max_plan_age_s = null;
    source.emit({ type: 'settings', ...remote, settings_version: 4 });
    assert.equal(h.$('live-plan-age-enabled').checked, false);
    assert.equal(h.$('live-max-plan-age').disabled, true);
    assert.equal(h.$('live-max-plan-age').value, '200 ms');
  });
});

test('Live timing accepts periods and frequencies without changing canonical API units', async () => {
  await sharedSettingsCase(async (h, live) => {
    h.$('live-simulation-hz').value = '1 ms'; h.$('live-simulation-hz').emit('input');
    h.$('live-control-hz').value = '2 ms'; h.$('live-control-hz').emit('input');
    h.$('live-to-hz').value = '20 ms'; h.$('live-to-hz').emit('input');
    h.$('live-duration').value = '0.05 Hz'; h.$('live-duration').emit('input');
    h.$('live-preview').emit('click'); await flush();
    const patch = h.commands.findLast(command => command.type === 'patch_settings').patch;
    assert.deepEqual(patch.execution, { to_hz: 50, duration_s: 20 });
    assert.equal(live.settings.execution.simulation_hz, 1000);
    assert.equal(live.settings.execution.control_hz, 500);
  });
});

test('external settings preserve unrelated debounced edits and override conflicting drafts', async () => {
  await sharedSettingsCase(async (h, live, source) => {
    h.edit('solver_params.q_cost', 9);
    const remote = structuredClone(live.settings); remote.config.solver_params.q_cost = 4; remote.config.solver_params.max_sqp_iters = 12;
    source.emit({ type: 'settings', ...remote, settings_version: 2 });
    assert.equal(live.settings.config.solver_params.q_cost, 9);
    assert.equal(live.settings.config.solver_params.max_sqp_iters, 12);
    remote.config.solver_params.q_cost = 21;
    source.emit({ type: 'settings', ...remote, settings_version: 3 });
    assert.equal(live.settings.config.solver_params.q_cost, 21);
  });
});

test('own SSE acknowledgement before HTTP preserves an edit typed after submission', async () => {
  await sharedSettingsCase(async (h, live, source) => {
    let acknowledge;
    h.setCommandHandler((command, version) => command.type === 'patch_settings'
      ? new Promise(resolve => { acknowledge = () => resolve({ ok: true, json: async () => ({ accepted: true, settings_version: version }) }); })
      : { ok: true, json: async () => ({ accepted: true, settings_version: version }) });
    h.edit('solver_params.q_cost', 8); h.$('live-preview').emit('click'); await flush();
    const sent = structuredClone(live.settings);
    h.edit('solver_params.q_cost', 9);
    source.emit({ type: 'settings', ...sent, settings_version: 2 });
    assert.equal(live.settings.config.solver_params.q_cost, 9);
    acknowledge(); await flush();
    assert.equal(live.settings.config.solver_params.q_cost, 9);
  });
});

test('opening a viewer on accepted settings never resubmits defaults or resets the run', async () => {
  const seed = harness(), current = { ...structuredClone(seed.schema.defaults), settings_version: 5 };
  current.config.solver_params.q_cost = 77;
  await sharedSettingsCase(async (h, live) => {
    assert.equal(live.settings.config.solver_params.q_cost, 77);
    assert.equal(h.commands.length, 0);
  }, { initial: current });
});

test('configured backend start-pose edit submits its debounced reset patch', async () => {
  const h = harness(), start = [-.39, -1.73, -.38, -2.33, 0, -1.21, .04];
  h.schema.defaults.config.joint_margin_rad = .1;
  h.schema.defaults.config.plant = { start_pose_rad: [...start] };
  h.schema.parameters.push({ path: 'plant.start_pose_rad', kind: 'joints', label: 'Start pose',
    lower: Array(7).fill(-3), upper: Array(7).fill(3) });
  const accepted = { ...structuredClone(h.schema.defaults), settings_version: 5 };
  h.setVersion(5);
  // The accepted snapshot must hydrate the controller before Live is opened:
  // this is a viewer joining an existing run, not configuring a fresh backend.
  h.setSettingsHandler(() => ({ ok: true, json: async () => structuredClone(accepted) }));
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let live;
  try {
    live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await live.ready; await live.enterLive();
    const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 5 });
    source.emit(plan(5, 1));
    source.emit({ type: 'state', settings_version: 5, sim_time_s: 0, q: [...start],
      qd: Array(7).fill(0), ee_xyz: [0, 0, 1] });
    await flush();
    assert.equal(h.commands.length, 0);
    assert.equal(live.startPose.editable, true);
    const edited = start.map((value, i) => i === 3 ? value + .3 : value);
    assert.equal(live.setStartPose(edited), true);
    assert.deepEqual(live.settings.config.plant.start_pose_rad, edited);
    assert.equal(h.commands.length, 0); // one commit after the debounce
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.deepEqual(h.commands, [{ type: 'patch_settings',
      patch: { config: { plant: { start_pose_rad: edited } } },
      expected_settings_version: 5, reset: true }]);
    assert.deepEqual(accepted.config.plant.start_pose_rad, start);
  } finally {
    live?.dispose(); await flush();
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('Replay settings polling hydrates retained Live without numerical commands', async () => {
  await sharedSettingsCase(async (h, live) => {
    await live.setReplayOnly(true);
    const remote = { ...structuredClone(live.settings), settings_version: 2 };
    remote.config.solver_params.max_sqp_iters = 24;
    h.setSettingsHandler(() => ({ ok: true, json: async () => remote }));
    const count = h.commands.length;
    await live.refreshSettings();
    assert.equal(live.settings.config.solver_params.max_sqp_iters, 24);
    assert.equal(h.created.filter(el => el.dataset.path === 'solver_params.max_sqp_iters').at(-1).value, '24');
    assert.equal(h.commands.length, count);
    assert.equal(live.replayOnly, true);
  });
});

test('stale version rejection rebases current values without resending the complete old form', async () => {
  await sharedSettingsCase(async (h, live) => {
    const remote = { ...structuredClone(live.settings), settings_version: 2 };
    remote.config.solver_params.max_sqp_iters = 26;
    h.setCommandHandler(() => ({ ok: false, status: 409, json: async () => ({ accepted: false, error: 'Settings changed', settings: remote }) }));
    h.edit('solver_params.q_cost', 9); h.$('live-preview').emit('click'); await flush();
    assert.equal(live.settings.config.solver_params.q_cost, 9);
    assert.equal(live.settings.config.solver_params.max_sqp_iters, 26);
    assert.equal(h.commands.at(-1).type, 'patch_settings');
    assert.deepEqual(h.commands.at(-1).patch, { config: { solver_params: { q_cost: 9 } } });
  });
});

test('a poll started before a same-version Stop/Continue event cannot restore the stale preference', async () => {
  await sharedSettingsCase(async (h, live, source) => {
    const stale = { ...structuredClone(live.settings), settings_version: 1 };
    let finishPoll;
    h.setSettingsHandler(() => new Promise(resolve => { finishPoll = () => resolve({ ok: true, json: async () => stale }); }));
    const refreshing = live.refreshSettings();
    const current = structuredClone(stale); current.execution.continue_at_end = true;
    source.emit({ type: 'settings', ...current });
    h.setSettingsHandler(() => ({ ok: true, json: async () => current }));
    finishPoll(); await refreshing;
    assert.equal(live.settings.execution.continue_at_end, true);
    assert.equal(h.$('live-continue').checked, true);
  });
});

test('editing a field back to its accepted value does not submit an empty patch or block Preview', async () => {
  await sharedSettingsCase(async (h, live) => {
    const count = h.commands.length;
    h.edit('solver_params.q_cost', 9); h.edit('solver_params.q_cost', 4);
    h.$('live-preview').emit('click'); await flush();
    assert.deepEqual(h.commands.slice(count).map(command => command.type), ['preview']);
    assert.equal(live.settings.config.solver_params.q_cost, 4);
  });
});

test('the reach orientation goal starts at the displayed grasp orientation, rotates in the viewport and keeps its weights editable', async () => {
  const h = harness();
  h.schema.task_anchors = { reach: [.5, -.2, 1], figure8: [.4, -.2, 1] };
  Object.assign(h.schema.defaults.config, { cost_weights: { orientation: 1, terminal_orientation: 8 } });
  h.schema.defaults.task.orientation_rad = null; h.schema.tasks[0].defaults.orientation_rad = null;
  h.schema.orientation_goal_supported = true;
  h.schema.parameters.push(...['cost_weights.orientation', 'cost_weights.terminal_orientation'].map(path =>
    ({ path, label: path, kind: 'float', min: 0, effect: 'runtime' })));
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  const displayed = [0, 0, .3];
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {}, graspOrientation: () => displayed });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    const toggle = () => h.created.filter(element => element.id === 'target-orientation').at(-1);
    const weights = () => ['cost_weights.orientation', 'cost_weights.terminal_orientation'].map(path => h.created.filter(element => element.dataset.path === path).at(-1));
    assert.equal(toggle().checked, false);
    assert(weights().every(input => !input.disabled));
    assert.deepEqual(live.settings.config.cost_weights, { orientation: 1, terminal_orientation: 8 });
    h.edit('cost_weights.orientation', 3); h.edit('cost_weights.terminal_orientation', 12);
    assert.deepEqual(live.targetInteraction.tools, ['translate']);
    toggle().checked = true; toggle().emit('change');
    assert.deepEqual(live.settings.task.orientation_rad, displayed);
    assert(weights().every(input => !input.disabled));
    assert.deepEqual(live.settings.config.cost_weights, { orientation: 3, terminal_orientation: 12 });
    assert.deepEqual(live.targetInteraction.tools, ['translate', 'rotate']);
    assert.equal(live.targetInteraction.rotation_space, 'local');
    live.refreshView();
    assert.deepEqual(live.reference.orientation_rotvec, displayed);
    assert.equal(h.$('live-orientation-stat').hidden, false);
    const turned = live.setTaskTransform({ quaternion_xyzw: [0, 0, Math.sin(.25), Math.cos(.25)] });
    assert(turned.tools.includes('rotate'));
    live.settings.task.orientation_rad.forEach((value, i) => assert(Math.abs(value - [0, 0, .5][i]) < 1e-12));
    h.edit('cost_weights.orientation', 2);
    toggle().checked = false; toggle().emit('change');
    assert.equal(live.settings.task.orientation_rad, null);
    assert.equal(live.setTaskTransform({ quaternion_xyzw: [0, 0, 0, 1] }), null);  // nothing to rotate without a goal
    live.refreshView(); assert.equal(h.$('live-orientation-stat').hidden, true);
    assert(weights().every(input => !input.disabled));
    toggle().checked = true; toggle().emit('change');  // the goal and edited costs return
    assert.equal(live.settings.config.cost_weights.orientation, 2);
    // Deliberately zeroed weights stay zero on later toggles, too.
    h.edit('cost_weights.orientation', 0); h.edit('cost_weights.terminal_orientation', 0);
    toggle().checked = false; toggle().emit('change');
    toggle().checked = true; toggle().emit('change');
    assert.deepEqual(live.settings.config.cost_weights, { orientation: 0, terminal_orientation: 0 });
    live.settings.task.orientation_rad.forEach((value, i) => assert(Math.abs(value - [0, 0, .5][i]) < 1e-12));
    await new Promise(resolve => setTimeout(resolve, 380)); await flush();
    const submitted = h.commands.filter(command => ['set_settings', 'patch_settings'].includes(command.type)).at(-1);
    const task = submitted.task ?? submitted.patch.task;
    task.orientation_rad.forEach((value, i) => assert(Math.abs(value - [0, 0, .5][i]) < 1e-12));
  } finally {
    h.$('replay-mode').emit('click'); await flush();
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('a saved orientation goal is restored only for a source with the orientation cost', () => {
  const h = harness();
  h.schema.tasks[0].defaults.orientation_rad = null;
  const saved = { ...structuredClone(h.schema.defaults), task: { kind: 'reach', target_offset_m: [0, 0, 0], orientation_rad: [0, 0, .5] } };
  assert.equal(restoreCompatibleSettings(h.schema, saved).task.orientation_rad, null);
  h.schema.parameters.push({ path: 'cost_weights.orientation', kind: 'float', min: 0, enabled_with: 'orientation_goal' });
  assert.deepEqual(restoreCompatibleSettings(h.schema, saved).task.orientation_rad, [0, 0, .5]);
  saved.task.orientation_rad = [0, 0, 4];  // beyond pi: not a rotation vector the backend accepts
  assert.equal(restoreCompatibleSettings(h.schema, saved).task.orientation_rad, null);
});

test('a custom-menu profile preserves the orientation goal across switching and toggling without rewriting costs', async () => {
  const h = harness();
  h.schema.task_anchors = { reach: [.5, -.2, 1], figure8: [.4, -.2, 1] };
  h.schema.defaults.task.orientation_rad = null; h.schema.tasks[0].defaults.orientation_rad = null;
  h.schema.orientation_goal_supported = true;
  const custom = { type: 'CostMenu', orientation: { type: 'Term', weight: [2, 3, 4], target: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] } };
  h.schema.defaults.config.cost = structuredClone(custom);
  h.schema.fixed_horizon_N = 32;
  h.schema.parameters.find(parameter => parameter.path === 'N').disabled = true;
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let live;
  try {
    live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {}, graspOrientation: () => [0, 0, .3] });
    await live.ready; h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    const toggle = () => h.created.filter(element => element.id === 'target-orientation').at(-1);
    assert.equal(toggle().checked, false);
    const knot = h.created.filter(element => element.dataset.path === 'N').at(-1);
    assert.equal(knot.disabled, true); assert.deepEqual(knot.children.map(option => option.textContent), ['32']);
    toggle().checked = true; toggle().emit('change');
    assert.deepEqual(live.settings.task.orientation_rad, [0, 0, .3]);
    assert.deepEqual(live.settings.config.cost, custom); assert.equal(live.settings.config.cost_weights, undefined);
    live.beginSolverProfileSwitch();
    await live.finishSolverProfileSwitch({ state: 'active', profile_id: 'custom', generation: 2 }); await flush();
    assert.equal(toggle().checked, true);
    assert.deepEqual(live.settings.task.orientation_rad, [0, 0, .3]);
    toggle().checked = false; toggle().emit('change');
    assert.equal(live.settings.task.orientation_rad, null);
    toggle().checked = true; toggle().emit('change');
    assert.deepEqual(live.settings.task.orientation_rad, [0, 0, .3]);
    assert.deepEqual(live.settings.config.cost, custom); assert.equal(live.settings.config.cost_weights, undefined);
    const poseReset = h.created.filter(element => element.dataset.resetSetting === 'task.pose').at(-1);
    assert.equal(poseReset.disabled, false); poseReset.emit('click');
    assert.equal(live.settings.task.orientation_rad, null); assert.equal(toggle().checked, false);
    assert.equal(poseReset.disabled, true);
    assert.deepEqual(live.settings.config.cost, custom);
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});

test('a field following GATO looks as if GATO\'s value were chosen and stays None until changed', async () => {
  const h = harness();
  Object.assign(h.schema.defaults.config, { warm_start: null, admm: { iters: null }, reseed_threshold: null });
  h.schema.parameters.push(
    { path: 'warm_start', kind: 'choice', gato_default: true, choices: [{ value: null, label: 'GATO default' }, 'shift', 'hold'] },
    { path: 'admm.iters', kind: 'int', nullable: true, gato_default: true, min: 1, max: 200 },
    { path: 'reseed_threshold', kind: 'float', nullable: true, gato_default: true, gato_none: 'off', min: 1e-6, max: 10 });
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let live;
  try {
    live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await live.ready;
    h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush();
    const select = () => h.created.filter(el => el.dataset.path === 'warm_start').at(-1);
    const iters = () => h.created.filter(el => el.dataset.path === 'admm.iters').at(-1);
    assert.equal(select().children[0].textContent, 'GATO default');  // no configured solver yet
    assert.equal(iters().value, '');
    source.emit({ type: 'settings', ...live.settings, settings_version: 1,
                  effective_settings: { params: { warm_start: 'shift', admm: { iters: 10 }, reseed_threshold: null } } });
    await flush();
    const reseed = h.created.filter(el => el.dataset.path === 'reseed_threshold').at(-1);
    assert.equal(reseed.value, ''); assert.equal(reseed.placeholder, 'off');  // GATO's own None, known
    const [gato, shift, hold] = select().children;
    assert.equal(gato.textContent, 'shift'); assert.equal(gato.selected, true);  // GATO's shift, shown as chosen
    assert.equal(shift.hidden, true); assert.equal(hold.hidden, false);
    assert.equal(iters().value, '10');
    h.edit('solver_params.q_cost', 5);  // another edit keeps both following GATO
    assert.equal(live.settings.config.warm_start, null);
    assert.equal(live.settings.config.admm.iters, null);
    h.edit('admm.iters', 12);
    assert.equal(live.settings.config.admm.iters, 12);
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});

test('compact playback advances through a stalled prediction fetch and scrubbing/export hydrate exact solves', async () => {
  const h = harness(), originals = Object.fromEntries(['document','fetch','EventSource'].map(key => [key,globalThis[key]]));
  Object.assign(globalThis,{document:h.document,fetch:h.fetch,EventSource:h.EventSource});
  h.schema.live_playback = {version:1}; h.schema.defaults.execution.calculation = 'manual';
  const full = seq => ({...plan(1,seq),generation:1,origin:'play',sim_time_s:(seq-10)/1000,available_time_s:0});
  const records = [{...segment('reach',{settings:h.schema.defaults,task:{kind:'reach',orientation_rad:[0,0,.3]},task_anchors:{reach:[.5,0,1]}}),generation:1,settings_version:1}];
  for(let i=0;i<=100;i++) {
    records.push({type:'plan',summary:true,seq:i+10,generation:1,settings_version:1,origin:'play',sim_time_s:i/1000,available_time_s:0,N:32,dt_s:.01,stats:{}});
    records.push({type:'state',generation:1,settings_version:1,sim_time_s:i/1000,q:Array(7).fill(i/1000),qd:Array(7).fill(0),ee_xyz:[i/1000,0,1],target_xyz:[.65,.2,1.2],plan_seq:i+10});
  }
  let release, hold = true, historyUrl;
  h.setHistoryHandler(url => {historyUrl=url;const after=Number(new URL(url,'http://local').searchParams.get('after'));return {ok:true,json:async()=>({generation:1,records:records.slice(after),next_cursor:records.length,complete:true})};});
  h.setPlansHandler(url => {
    const ids=new URL(url,'http://local').searchParams.get('ids').split(',').map(Number);
    const response={ok:true,json:async()=>({generation:1,plans:ids.map(full)})};
    return hold ? new Promise(resolve=>{release=()=>{hold=false;resolve(response);};}) : response;
  });
  let live;
  try {
    const session=createSession(); live=setupLive({onMode(){},onPlan(){},onState(){},onReset(){}});live.setSession(session);
    await live.enterLive(); const source=h.sources.at(-1);source.open();source.emit({type:'status',state:'paused',settings_version:0});
    await flush(); source.emit(plan(1,1));source.emit({type:'history',generation:1,settings_version:1,history_cursor:records.length,complete:true});
    await flush(); await flush();
    assert(historyUrl.includes('/playback?')); assert.equal(live.history.length,101);
    live.seek(0); await flush(); h.$('live-play').emit('click');live.frame(0);live.frame(50);
    assert.equal(live.history.selectedTime,.05);assert.equal(live.displayedState.sim_time_s,.05);
    await flush();
    assert(release); release(); await flush(); await flush();
    live.seek(.025);
    assert.deepEqual(live.reference.orientation_rotvec,[0,0,.3]);
    await flush(); await flush();
    assert.equal(session.focused.plan.seq,35);assert.equal(session.focused.plan.summary,undefined);
    assert(live.animationHistory.every(sample=>sample.plan?.summary));
    const hydrated=await live.hydrateAnimationHistory(live.animationHistory,{frameCount:3,time:i=>[0,.025,.1][i]});
    assert.deepEqual([hydrated[0].plan.seq,hydrated[25].plan.seq,hydrated[100].plan.seq],[10,35,110]);
    assert(hydrated[25].plan.ee_xyz);assert(live.animationHistory[25].plan.summary);
  } finally {live?.dispose();Object.assign(globalThis,originals);}
});

test('playback grid retains a full preview when its sequence overlaps a cached play solve', async () => {
  const h = harness(), originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  h.schema.live_playback = { version: 1 }; h.schema.defaults.execution.calculation = 'manual';
  const preview = { ...plan(1, 1), generation: 1 };
  const play = { ...preview, origin: 'play', sim_time_s: .001, available_time_s: .001, ee_xyz: [[.8, 0, 1], [.9, 0, 1]] };
  const state = time => ({ type: 'state', generation: 1, settings_version: 1, sim_time_s: time,
    q: Array(7).fill(time), qd: Array(7).fill(0), ee_xyz: [time, 0, 1], plan_seq: 1 });
  const records = [{ ...segment('reach', { settings: h.schema.defaults }), generation: 1, settings_version: 1 },
    preview, state(0), { ...play, summary: true }, state(.001), state(.1)];
  h.setHistoryHandler(url => ({ ok: true, json: async () => ({ generation: 1, complete: true,
    records: records.slice(Number(new URL(url, 'http://viewer').searchParams.get('after'))), next_cursor: records.length }) }));
  h.setPlansHandler(() => ({ ok: true, json: async () => ({ generation: 1, plans: [play] }) }));
  let live;
  try {
    const session = createSession();
    live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); live.setSession(session);
    await live.enterLive(); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush();
    source.emit(plan(1, 1)); source.emit({ type: 'history', generation: 1, settings_version: 1, complete: true });
    await flush(); await flush();
    live.seek(.001); await flush(); await flush();
    assert.equal(session.focused.plan.origin, 'play');
    h.$('live-play').emit('click'); live.frame(0);
    assert.equal(session.focused.plan.origin, 'preview');
    assert.deepEqual(session.focused.plan.ee_xyz, preview.ee_xyz);
    live.frame(20);
    assert.equal(session.focused.plan.origin, 'play');
    assert.deepEqual(session.focused.plan.ee_xyz, play.ee_xyz);
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});


test('resetting another task\'s pose preserves its task fields when reach orientation is supported', async () => {
  const h = harness();
  const defaults = { kind: 'hold', target_offset_m: [.15, .2, .2], speed: 6 };
  h.schema.tasks.push({ kind: 'hold', label: 'Hold', defaults, parameters: [{ path: 'speed', label: 'Speed', min: 0, max: 10 }] });
  h.schema.orientation_goal_supported = true;
  taskSessionBackend(h);
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = await startTaskSessionLive(h);
    h.$('live-task').value = 'hold'; h.$('live-task').emit('change');
    await flush(); await flush(); await flush(); await flush();
    h.edit('target-offset-0', -.12);
    h.created.filter(element => element.dataset.resetSetting === 'task.pose').at(-1).emit('click');
    assert.deepEqual(live.settings.task, defaults);
    assert.equal(Object.hasOwn(live.settings.task, 'orientation_rad'), false);
    h.$('replay-mode').emit('click'); await flush();
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

function taskSessionBackend(h, shared) {
  const groups = value => structuredClone({ config: value.config, task: value.task, execution: value.execution, source_settings: value.source_settings || {} });
  const merge = (left, right) => {
    const next = structuredClone(left);
    for (const [key, value] of Object.entries(right)) next[key] = value && typeof value === 'object' && !Array.isArray(value) && next[key] && typeof next[key] === 'object' && !Array.isArray(next[key]) ? merge(next[key], value) : structuredClone(value);
    return next;
  };
  h.schema.defaults.config.cost_weights = { position: 4, terminal_position: 8 };
  h.schema.parameters.push(...['position', 'terminal_position'].map(path => ({ path: `cost_weights.${path}`, label: path, kind: 'float', min: 0, effect: 'runtime' })));
  h.schema.task_defaults = Object.fromEntries(h.schema.tasks.map(task => {
    const baseline = groups({ ...h.schema.defaults, task: task.defaults, source_settings: { predictor: { gain: 1 }, simulation: { armature_on: true } } });
    if (['figure8', 'tracking', 'hold'].includes(task.kind)) { baseline.config.cost_weights = { position: 500, terminal_position: 1000 }; baseline.execution.to_hz = 500; }
    return [task.kind, baseline];
  }));
  const state = shared || { version: 1, active: 'reach', defaults: structuredClone(h.schema.task_defaults), sessions: structuredClone(h.schema.task_defaults) };
  const snapshot = () => ({ ...groups(state.sessions[state.active]), settings_version: state.version,
    task_settings: { defaults: structuredClone(state.defaults), sessions: structuredClone(state.sessions), overrides: Object.fromEntries(Object.entries(state.sessions).map(([kind, value]) => [kind, settingsPatch(state.defaults[kind], value)])) } });
  h.setSettingsHandler(() => ({ ok: true, json: async () => snapshot() }));
  h.setCommandHandler(command => {
    if (command.expected_settings_version != null && command.expected_settings_version !== state.version) return { ok: false, status: 409, json: async () => ({ settings: snapshot(), accepted: false }) };
    if (['patch_settings', 'set_settings'].includes(command.type)) {
      state.sessions[state.active] = command.type === 'patch_settings' ? merge(state.sessions[state.active], command.patch) : groups(command);
      state.version++;
    } else if (command.type === 'switch_task') { state.active = command.task_kind; state.version++; }
    else if (command.type === 'reset_task_settings') {
      state.sessions[state.active] = structuredClone(state.defaults[state.active]);
      state.version++;
    }
    else if (command.type === 'transfer_settings') {
      if (state.rejectTransfer) return { ok: false, status: 400, json: async () => ({ accepted: false, error: 'Selected values do not fit this profile.' }) };
      for (const path of command.paths) {
        const keys = path.split('.'), leaf = keys.pop();
        const from = keys.reduce((value, key) => value[key], state.sessions[command.source_task]);
        const to = keys.reduce((value, key) => value[key], state.sessions[state.active]);
        to[leaf] = structuredClone(from[leaf]);
      }
      state.version++;
    }
    return { ok: true, json: async () => ({ accepted: true, settings_version: state.version }) };
  });
  state.snapshot = snapshot;
  return state;
}

async function startTaskSessionLive(h) {
  const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
  await live.ready; await live.enterLive(); const stream = h.sources.at(-1); stream.open();
  stream.emit({ type: 'status', state: 'paused', settings_version: 1 }); await flush();
  return live;
}

// Two more tasks with their own default overrides (taskSessionBackend).
function addTaskDescriptors(h) {
  h.schema.tasks.push(
    { kind: 'tracking', label: 'Tracking',
      defaults: { kind: 'tracking', target_offset_m: [0, 0, 0], speed: 1 },
      parameters: [{ path: 'speed', label: 'Speed', min: 0, max: 10 }] },
    { kind: 'hold', label: 'Hold', defaults: { kind: 'hold', target_offset_m: [.15, .2, .2] } },
  );
}

test('Reset all discards an invalid draft in one transaction and undo stays within the active task', async () => {
  const h = harness(); addTaskDescriptors(h);
  const backend = taskSessionBackend(h); backend.active = 'tracking';
  const active = backend.sessions.tracking;
  active.config.cost_weights.position = 750;
  active.config.solver_params.max_sqp_iters = 11;
  active.task.speed = 2; active.task.target_offset_m = [.1, -.2, .05];
  active.execution.to_hz = 400; active.execution.duration_s = 7;
  active.source_settings.predictor.gain = 9;
  active.source_settings.simulation.armature_on = false;
  backend.sessions.hold.config.cost_weights.position = 900;
  const before = structuredClone(active), defaults = structuredClone(backend.defaults);
  const inactive = Object.fromEntries(Object.entries(backend.sessions).filter(([kind]) => kind !== backend.active)
    .map(([kind, value]) => [kind, structuredClone(value)]));
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let live;
  const settle = async () => { await flush(); await flush(); await flush(); await flush(); };
  const echo = () => h.sources.at(-1).emit({ type: 'settings', ...backend.snapshot() });
  try {
    live = await startTaskSessionLive(h);
    const reset = h.created.find(element => element.id === 'live-task-reset-all');
    assert.ok(reset, 'Reset all settings button exists beside Copy settings from');
    assert.match(reset.textContent, /^Reset all(?: settings)?$/);
    h.edit('cost_weights.position', 'invalid');
    assert.equal(reset.disabled, false, 'Invalid fields can be discarded without saving');
    h.commands.length = 0;
    reset.emit('click'); await settle(); echo();
    assert.deepEqual(h.commands, [{ type: 'reset_task_settings', expected_settings_version: 1 }]);
    assert.deepEqual(live.settings, defaults.tracking);
    assert.deepEqual(backend.sessions.tracking, defaults.tracking);
    assert.equal(h.created.filter(element => element.dataset.path === 'cost_weights.position').at(-1).value, '500');
    assert.equal(live.settingsHistory.undo, 1);
    for (const [kind, values] of Object.entries(inactive)) assert.deepEqual(backend.sessions[kind], values);
    assert.deepEqual(backend.defaults, defaults);
    assert.equal(live.undoSettings(), true); await settle(); echo();
    assert.deepEqual(live.settings, before);
    assert.deepEqual(backend.sessions.hold, inactive.hold);
    assert.equal(live.redoSettings(), true); await settle(); echo();
    assert.deepEqual(live.settings, defaults.tracking);
    h.$('live-task').value = 'reach'; h.$('live-task').emit('change'); await settle();
    assert.deepEqual(live.settings, inactive.reach);
    assert.equal(live.undoSettings(), false, 'Reset did not enter another task history');
    assert.deepEqual(backend.sessions.tracking, defaults.tracking);
    await live.setReplayOnly(true);
    const resets = h.commands.filter(command => command.type === 'reset_task_settings').length;
    assert.equal(reset.disabled, true); reset.emit('click'); await settle();
    assert.equal(h.commands.filter(command => command.type === 'reset_task_settings').length, resets);
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});

test('Reset all rejects a stale task snapshot without resetting the newly active remote task', async () => {
  const h = harness(); addTaskDescriptors(h);
  const backend = taskSessionBackend(h); backend.active = 'tracking';
  backend.sessions.tracking.config.cost_weights.position = 750;
  backend.sessions.hold.config.cost_weights.position = 900;
  const defaults = structuredClone(backend.defaults);
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let live;
  const settle = async () => { await flush(); await flush(); await flush(); await flush(); };
  try {
    live = await startTaskSessionLive(h);
    const reset = h.created.find(element => element.id === 'live-task-reset-all');
    backend.version++; backend.active = 'hold';
    const sessions = structuredClone(backend.sessions);
    h.commands.length = 0;
    reset.emit('click'); await settle();
    assert.deepEqual(h.commands, [{ type: 'reset_task_settings', expected_settings_version: 1 }]);
    assert.deepEqual(backend.sessions, sessions, 'Neither session changes after the rejected reset');
    assert.deepEqual(backend.defaults, defaults);
    assert.equal(live.settings.task.kind, 'hold');
    assert.equal(live.settings.config.cost_weights.position, 900);
    assert.match(h.$('live-message').textContent, /changed|review|Review/);
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});

test('Reset all restores a compiled default from an unavailable model draft but remains blocked during source switching', async () => {
  const h = harness(); modelSchema(h);
  const backend = taskSessionBackend(h);
  const fetch = async (url, options) => {
    if (url === '/api/source/model') {
      const body = JSON.parse(options.body), ready = body.params.N === 32;
      return { ok: true, json: async () => ({ compatible: true,
        compilation: { ready, N: body.params.N, available_N: [32] } }) };
    }
    return h.fetch(url, options);
  };
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch, EventSource: h.EventSource });
  let live;
  const settle = async () => { await flush(); await flush(); await flush(); await flush(); };
  try {
    live = await startTaskSessionLive(h);
    const reset = h.created.find(element => element.id === 'live-task-reset-all');
    h.edit('N', 2);
    await new Promise(resolve => setTimeout(resolve, 380)); await settle();
    assert.equal(live.settings.config.N, 64); assert.equal(live.compilation.phase, 'missing');
    assert.equal(h.$('live-preview').disabled, true, 'The uncompiled draft cannot solve');
    assert.equal(reset.disabled, false, 'Its compiled default can still be restored');
    h.commands.length = 0;
    reset.emit('click'); await settle();
    assert.deepEqual(h.commands, [{ type: 'reset_task_settings', expected_settings_version: 1 }]);
    assert.equal(live.settings.config.N, backend.defaults.reach.config.N);
    live.beginSolverProfileSwitch();
    assert.equal(reset.disabled, true);
    reset.emit('click'); await settle();
    assert.equal(h.commands.filter(command => command.type === 'reset_task_settings').length, 1);
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});

test('task switching flushes the outgoing four-group session and resets to the selected task baseline across reloads', async () => {
  const h = harness(), backend = taskSessionBackend(h);
  backend.sessions.reach.source_settings.predictor.gain = 8;
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let live;
  try {
    live = await startTaskSessionLive(h);
    h.edit('cost_weights.position', 7); h.edit('solver_params.max_sqp_iters', 12);
    h.$('live-to-hz').value = '44'; h.$('live-to-hz').emit('input');
    h.$('live-task').value = 'figure8'; h.$('live-task').emit('change'); await flush(); await flush(); await flush(); await flush();
    assert.deepEqual(h.commands.slice(-2).map(command => command.type), ['patch_settings', 'switch_task']);
    assert.equal(h.commands.at(-1).expected_settings_version, 2);
    assert.equal(live.settings.config.cost_weights.position, 500); assert.equal(live.settings.execution.to_hz, 500);
    assert.equal(live.settings.config.solver_params.max_sqp_iters, 5);
    assert.equal(live.settings.source_settings.predictor.gain, 1);
    h.edit('cost_weights.position', 650);
    h.created.filter(element => element.dataset.resetSetting === 'config.cost_weights.position').at(-1).emit('click');
    assert.equal(live.settings.config.cost_weights.position, 500);
    h.$('live-to-hz').value = '250'; h.$('live-to-hz').emit('input');
    h.created.filter(element => element.dataset.resetSetting === 'execution.to_hz').at(-1).emit('click');
    assert.equal(live.settings.execution.to_hz, 500);
    h.edit('cost_weights.position', 600);
    h.$('live-task').value = 'reach'; h.$('live-task').emit('change'); await flush(); await flush(); await flush(); await flush();
    assert.equal(live.settings.config.cost_weights.position, 7); assert.equal(live.settings.execution.to_hz, 44);
    assert.equal(live.settings.config.solver_params.max_sqp_iters, 12); assert.equal(live.settings.source_settings.predictor.gain, 8);
    live.dispose();
    const reloaded = harness(); taskSessionBackend(reloaded, backend);
    Object.assign(globalThis, { document: reloaded.document, fetch: reloaded.fetch, EventSource: reloaded.EventSource });
    live = await startTaskSessionLive(reloaded);
    assert.equal(live.settings.config.cost_weights.position, 7); assert.equal(live.settings.execution.to_hz, 44);
    assert.equal(reloaded.commands.length, 0);
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});

test('copy selected settings submits one versioned transfer, preserves defaults/source, and retains selection after rejection', async () => {
  const h = harness(), backend = taskSessionBackend(h); backend.active = 'figure8';
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let live;
  try {
    live = await startTaskSessionLive(h);
    const sourceBefore = structuredClone(backend.sessions.reach), defaultsBefore = structuredClone(backend.defaults);
    h.created.find(element => element.id === 'live-task-copy').emit('click'); await flush(); await flush();
    const leaf = () => h.created.filter(element => element.dataset.taskCopyPath === 'config.cost_weights.position').at(-1);
    assert.ok(leaf(), h.$('live-message').textContent);
    leaf().checked = true; leaf().emit('change'); backend.rejectTransfer = true;
    const form = h.created.find(element => element.className === 'task-settings-form');
    form.emit('submit'); await flush(); await flush();
    assert.equal(leaf().checked, true);
    assert.match(h.created.filter(element => element.className === 'source-message').at(-1).textContent, /Selected values/);
    backend.rejectTransfer = false; form.emit('submit'); await flush(); await flush();
    const command = h.commands.filter(command => command.type === 'transfer_settings').at(-1);
    assert.deepEqual(command.paths, ['config.cost_weights.position']); assert.equal(command.source_task, 'reach');
    assert.equal(live.settings.config.cost_weights.position, 4); assert.equal(live.settings.config.cost_weights.terminal_position, 1000);
    assert.deepEqual(backend.sessions.reach, sourceBefore); assert.deepEqual(backend.defaults, defaultsBefore);
    assert.equal(h.commands.filter(command => ['set_settings', 'patch_settings'].includes(command.type)).length, 0);
    await live.setReplayOnly(true);
    assert.equal(h.created.find(element => element.id === 'live-task-copy').disabled, true);
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});

test('copy requires review again when a newer backend snapshot arrives during draft flush', async () => {
  const h = harness(), backend = taskSessionBackend(h); backend.active = 'figure8';
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let live;
  try {
    live = await startTaskSessionLive(h);
    h.created.find(element => element.id === 'live-task-copy').emit('click'); await flush(); await flush();
    const leaf = () => h.created.filter(element => element.dataset.taskCopyPath === 'config.cost_weights.position').at(-1);
    assert.ok(leaf(), h.$('live-message').textContent);
    leaf().checked = true; leaf().emit('change');
    backend.version++; backend.sessions.reach.config.cost_weights.position = 6;
    const form = h.created.find(element => element.className === 'task-settings-form');
    form.emit('submit'); await flush(); await flush();
    assert.equal(h.commands.filter(command => command.type === 'transfer_settings').length, 0);
    assert.equal(live.settings.config.cost_weights.position, 500); assert.equal(leaf().checked, true);
    assert.match(h.created.filter(element => element.className === 'source-message').at(-1).textContent, /Review the refreshed/);
    form.emit('submit'); await flush(); await flush();
    assert.equal(live.settings.config.cost_weights.position, 6);
    assert.equal(h.commands.filter(command => command.type === 'transfer_settings').at(-1).expected_settings_version, backend.version - 1);
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});

test('task switching retries an authoritative settings read when an SSE echo overtakes the GET', async () => {
  const h = harness(), backend = taskSessionBackend(h);
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let live;
  try {
    live = await startTaskSessionLive(h);
    const stale = backend.snapshot(); let release, reads = 0;
    h.setSettingsHandler(() => ++reads === 1 ? new Promise(resolve => {
      release = () => resolve({ ok: true, json: async () => stale });
    }) : { ok: true, json: async () => backend.snapshot() });
    h.$('live-task').value = 'figure8'; h.$('live-task').emit('change'); await flush();
    assert.equal(typeof release, 'function');
    backend.version++; backend.sessions.reach.config.solver_params.max_sqp_iters = 13;
    h.sources.at(-1).emit({ type: 'settings', ...backend.snapshot() });
    release(); await flush(); await flush();
    const command = h.commands.find(command => command.type === 'switch_task');
    assert.equal(command.task_kind, 'figure8'); assert.equal(command.expected_settings_version, 2);
    assert.equal(live.settings.task.kind, 'figure8'); assert.equal(reads, 3);
    assert.equal(backend.sessions.reach.config.solver_params.max_sqp_iters, 13);
    assert.doesNotMatch(h.$('live-message').textContent, /settings are unavailable/);
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});


test('undo and redo stay with each task session and selective transfers edit only the destination history', async () => {
  const h = harness(), backend = taskSessionBackend(h);
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  let live;
  const settle = async () => { await flush(); await flush(); await flush(); await flush(); };
  const echo = () => h.sources.at(-1).emit({ type: 'settings', ...backend.snapshot() });
  const selectTask = async kind => { h.$('live-task').value = kind; h.$('live-task').emit('change'); await settle(); };
  try {
    live = await startTaskSessionLive(h);
    h.edit('cost_weights.position', 7); h.$('live-preview').emit('click'); await settle(); echo();
    assert.equal(live.settingsHistory.undo, 1);
    await selectTask('figure8');
    assert.equal(live.settingsHistory.undo, 0); assert.equal(live.undoSettings(), false);
    assert.equal(backend.sessions.reach.config.cost_weights.position, 7);
    h.edit('cost_weights.position', 600); h.$('live-preview').emit('click'); await settle(); echo();
    assert.equal(live.settingsHistory.undo, 1);
    // An unsubmitted field must not return when history or task sessions are restored.
    h.edit('cost_weights.position', 999);
    assert.equal(live.undoSettings(), true); await settle(); echo();
    assert.equal(live.settings.config.cost_weights.position, 500);
    assert.equal(backend.sessions.figure8.config.cost_weights.position, 500);
    await selectTask('reach');
    assert.equal(live.settingsHistory.undo, 1);
    assert.equal(live.undoSettings(), true); await settle(); echo();
    assert.equal(live.settings.config.cost_weights.position, 4);
    assert.equal(backend.sessions.figure8.config.cost_weights.position, 500);
    await selectTask('figure8');
    assert.equal(live.settingsHistory.undo, 0); assert.equal(live.settingsHistory.redo, 1);
    assert.equal(live.redoSettings(), true); await settle(); echo();
    assert.equal(live.settings.config.cost_weights.position, 600);
    h.created.find(element => element.id === 'live-task-copy').emit('click'); await settle();
    const leaf = h.created.filter(element => element.dataset.taskCopyPath === 'config.cost_weights.position').at(-1);
    leaf.checked = true; leaf.emit('change');
    h.created.find(element => element.className === 'task-settings-form').emit('submit'); await settle();
    assert.equal(live.settings.config.cost_weights.position, 4);
    assert.equal(live.undoSettings(), true); await settle(); echo();
    assert.equal(live.settings.config.cost_weights.position, 600);
    assert.equal(backend.sessions.reach.config.cost_weights.position, 4);
    assert.equal(live.redoSettings(), true); await settle(); echo();
    assert.equal(live.settings.config.cost_weights.position, 4);
    assert.equal(backend.sessions.reach.config.cost_weights.position, 4);
  } finally { live?.dispose(); Object.assign(globalThis, originals); }
});
