import test from 'node:test';
import assert from 'node:assert/strict';
import { setupLive as createLive } from './live.js';
// Existing controller tests exercise the unbuffered interpolated mode; buffered
// presentation is covered explicitly below without changing their clocks.
const setupLive = options => createLive({ presentationSettings: { report_hz: 20, buffer_ms: 0, interpolate: true }, ...options });
import { DEFAULT_EXECUTION } from './live-execution.js';

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
      for (const child of children) if (child) child.parentElement = this;
      if (this.tagName === 'select') {
        for (const child of children) if (!this.value || child.selected) this.value = child.value;
      }
    }
    replaceChildren(...children) { this.children = []; this.value = ''; this.append(...children); }
    setAttribute() {}
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
  const commands = [], sources = [];
  let version = 0, historyHandler, commandHandler;
  class EventSource {
    static OPEN = 1;
    constructor() { this.readyState = 0; sources.push(this); }
    close() { this.readyState = 2; }
    open() { this.readyState = 1; this.onopen?.(); }
    emit(item) { this.onmessage?.({ data: JSON.stringify(item) }); }
  }
  const fetch = async (url, options) => {
    if (url.includes('/history?')) return historyHandler(url);
    if (url.endsWith('/schema')) return { ok: true, json: async () => structuredClone(schema) };
    const command = JSON.parse(options.body); commands.push(command);
    if (command.type === 'set_settings') version++;
    if (commandHandler) return commandHandler(command, version);
    return { ok: true, json: async () => ({ accepted: true, settings_version: version }) };
  };
  const edit = (path, value) => {
    const element = path.startsWith('target-offset-') ? $(path) : created.find(el => el.dataset.path === path);
    element.value = String(value); element.emit('input');
  };
  return { $, document, EventSource, fetch, commands, sources, created, edit, schema, setHistoryHandler(value) { historyHandler = value; }, setCommandHandler(value) { commandHandler = value; }, setVersion(value) { version = value; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
// A segment header: the constant context of a generation's records, sent once.
const segment = (kind, context = {}) => ({ type: 'segment', generation: 0, settings_version: 0, context: { task: { kind }, ...context } });
const plan = (version, seq, task_kind = 'reach') => ({
  type: 'plan', generation: 0, settings_version: version, seq, origin: 'preview', sim_time_s: 0,
  N: task_kind === 'reach' ? 32 : 64, dt_s: .01, knot_time_s: [0, .01], q: [Array(7).fill(0), Array(7).fill(0)],
  ee_xyz: [[.5, 0, 1], [.6, 0, 1]], reference_xyz: [[.7, 0, 1], [.7, 0, 1]], stats: {},
});

test('Replay roundtrip retains complete Live draft and rejects cached plans from another configuration', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const shown = [];
    const live = setupLive({ onMode() {}, onPlan: value => shown.push(value?.seq), onState() {}, onReset() {} });
    await flush();
    h.$('live-mode').emit('click');
    let source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 });
    await flush(); source.emit(plan(1, 1));
    assert.equal(live.plan.seq, 1);

    h.edit('N', 2); h.edit('solver_params.q_cost', 9.25);
    h.edit('solver_params.max_sqp_iters', 17); h.edit('solver_params.max_pcg_iters', 345);
    h.edit('target-offset-0', .13); h.edit('target-offset-1', -.21); h.edit('target-offset-2', .08);
    h.$('live-task').value = 'figure8'; h.$('live-task').emit('change');
    assert.deepEqual(live.settings.task.target_offset_m, [0, 0, 0]);
    h.edit('target-offset-0', .13); h.edit('target-offset-1', -.21); h.edit('target-offset-2', .08);
    for (const [path, value] of [['width_m', .42], ['height_m', .28], ['period_s', 13]]) {
      const input = h.document.querySelector(`[data-task-path="${path}"]`); input.value = String(value); input.emit('input');
    }
    const retained = live.settings;
    assert.equal(retained.config.N, 64);
    assert.deepEqual(retained.task, { kind: 'figure8', width_m: .42, height_m: .28, period_s: 13, target_offset_m: [.13, -.21, .08] });
    assert.deepEqual(retained.config.unlisted, { preserved: true });
    // Leave before the 350ms debounce. Replay never submits or replaces Live settings.
    h.$('replay-mode').emit('click'); await flush();
    assert.equal(h.commands.filter(command => command.type === 'set_settings').length, 1);
    assert.deepEqual(live.settings, retained);
    h.$('live-mode').emit('click'); source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 1 });
    source.emit(plan(1, 900)); // Cached wrong-task prediction follows status in the SSE snapshot.
    await flush();
    assert.equal(live.plan.seq, 1);
    assert.equal(shown.includes(900), false);
    assert.deepEqual(h.commands.at(-1), { type: 'set_settings', ...retained });
    source.emit({ type: 'status', state: 'gpu_busy', settings_version: 1 });
    source.emit(plan(1, 901));
    assert.equal(live.plan.seq, 1);
    assert.deepEqual(live.settings, retained);
    source.emit(plan(2, 2, 'figure8'));
    assert.equal(live.plan.seq, 2);
    assert.equal(live.pending, false);
    assert.deepEqual(live.settings, retained);

    // A stream reconnect and old snapshots must not refill the form from defaults.
    source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 1 }); source.emit(plan(1, 902));
    assert.equal(live.plan.seq, 2);
    assert.equal(h.commands.filter(command => command.type === 'set_settings').length, 2);
    h.$('replay-mode').emit('click'); await flush();
    assert.equal(h.created.find(el => el.dataset.path === 'solver_params.q_cost').value, '9.25');
    assert.equal(h.$('live-task').value, 'figure8');
    assert.equal(h.$('target-offset-1').value, '-0.21');
  } finally {
    h.$('replay-mode').emit('click');
    await flush();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
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
    assert.deepEqual(live.settings, h.schema.defaults);
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

test('On Play resumes at the existing history tip and keeps waiting for continuous computation regardless of Stop', async () => {
  const h = harness();
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open(); source.emit({ type: 'status', state: 'paused', settings_version: 0 });
    await flush(); source.emit(plan(1, 1));
    assert.equal(h.$('live-stop-at-end').disabled, true);
    assert.match(h.$('live-stop-at-end').title, /continues until paused/);
    assert.match(h.$('live-duration').title, /Precalculation duration/);
    for (const time of [0, .2]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time, q: Array(7).fill(time), qd: Array(7).fill(0), ee_xyz: [time, 0, 1] });
    h.$('live-history-latest').emit('click'); assert.equal(live.settings.execution.continue_at_end, false);
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
    h.$('live-calculation').value = 'manual'; h.$('live-calculation').emit('input');
    assert.equal(h.$('live-stop-at-end').disabled, false);
    assert.equal(live.settings.execution.continue_at_end, false);
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
    h.$('live-task').value = 'figure8'; h.$('live-task').emit('change');
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
    h.$('live-task').value = 'reach'; h.$('live-task').emit('change');
    assert.deepEqual(live.settings.task.target_offset_m, [.15, .2, .2]);
    h.$('live-task').value = 'figure8'; h.$('live-task').emit('change');
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
    h.$('live-task').value = 'figure8'; h.$('live-task').emit('change');
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
    source.emit({ type: 'state', generation: 0, settings_version: 1, sim_time_s: 4, q: Array(7).fill(0), qd: Array(7).fill(0), ee_xyz: [9,9,9], target_xyz: [99,99,99] });
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
    h.$('live-task').value = 'figure8'; h.$('live-task').emit('change');
    const width = h.document.querySelector('[data-task-path="width_m"]'); width.value = '.4'; width.emit('input');
    assert.equal(reset('task.width_m').disabled, false); reset('task.width_m').emit('click'); assert.equal(live.settings.task.width_m, .24);
    h.edit('target-offset-0', .15); h.edit('target-offset-2', -.2); assert.equal(reset('task.pose').disabled, false);
    reset('task.pose').emit('click'); assert.deepEqual(live.settings.task.target_offset_m, [0, 0, 0]); assert.deepEqual(live.settings.task.orientation_xyzw, [0, 0, 0, 1]);
    h.$('live-duration').value = '20'; h.$('live-duration').emit('input'); assert.equal(reset('execution.duration_s').disabled, false);
    reset('execution.duration_s').emit('click'); assert.equal(live.settings.execution.duration_s, DEFAULT_EXECUTION.duration_s);
    reset('task.kind').emit('click'); assert.equal(live.settings.task.kind, 'reach'); assert.equal(reset('task.kind').disabled, true);
    h.$('replay-mode').emit('click'); await flush();
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('task switches restore independent reach and figure-eight positions and tracking dimensions', async () => {
  const h = harness(); h.schema.tasks[1].defaults.orientation_xyzw = [0, 0, 0, 1];
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  const switchTask = kind => { h.$('live-task').value = kind; h.$('live-task').emit('change'); };
  const visibleOffsets = () => [0, 1, 2].map(i => Number(h.$(`target-offset-${i}`).value));
  const reset = key => h.created.filter(el => el.dataset.resetSetting === key).at(-1);
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} }); await flush();
    assert.deepEqual(visibleOffsets(), [.15, .2, .2]);
    h.edit('target-offset-0', -.12); h.edit('target-offset-1', .31);
    switchTask('figure8');
    assert.deepEqual(visibleOffsets(), [0, 0, 0]);
    assert.deepEqual(live.settings.task.target_offset_m, [0, 0, 0]);
    assert.equal(reset('task.pose').disabled, true);
    h.edit('target-offset-0', .08); h.edit('target-offset-2', -.09);
    const width = h.document.querySelector('[data-task-path="width_m"]'); width.value = '.4'; width.emit('input');
    switchTask('reach');
    assert.deepEqual(visibleOffsets(), [-.12, .31, .2]);
    assert.deepEqual(live.settings.task, { kind: 'reach', target_offset_m: [-.12, .31, .2] });
    assert.equal(reset('task.pose').disabled, false);
    switchTask('figure8');
    assert.deepEqual(visibleOffsets(), [.08, 0, -.09]);
    assert.equal(Number(h.document.querySelector('[data-task-path="width_m"]').value), .4);
    assert.deepEqual(live.settings.task.orientation_xyzw, [0, 0, 0, 1]);
    reset('task.pose').emit('click');
    assert.deepEqual(visibleOffsets(), [0, 0, 0]);
    switchTask('reach');
    assert.deepEqual(visibleOffsets(), [-.12, .31, .2]);
    reset('task.pose').emit('click');
    assert.deepEqual(visibleOffsets(), [.15, .2, .2]);
    switchTask('figure8');
    assert.deepEqual(visibleOffsets(), [0, 0, 0]);
    assert.equal(Number(h.document.querySelector('[data-task-path="width_m"]').value), .4);
    h.$('replay-mode').emit('click'); await flush();
    assert.equal(h.commands.length, 0);
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
    assert.equal(h.$('live-task').handlers.change.length, 2); assert.equal(h.commands.length, count);
    assert.equal(h.$('live-preview').disabled, false);
    // Repeat schema hydration without adding handlers or issuing a preview.
    live.beginSolverProfileSwitch(); await live.finishSolverProfileSwitch({ state: 'active', profile_id: 'main', generation: 3 }); await flush();
    assert.equal(h.$('target-offset-0').handlers.input.length, 2); assert.equal(h.$('live-task').handlers.change.length, 2); assert.equal(h.commands.length, count);
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
    assert.equal(live.settings.execution.continue_at_end, false); // Default on_play still follows.
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

// config.friction is MpcParams' predictor friction (null: loss-free); config.plant.friction the simulator's.
function frictionSchema(h, { N = 32, on = [32], prediction = false } = {}) {
  h.schema.defaults.config.N = N;
  h.schema.defaults.config.friction = prediction ? structuredClone(PREDICTOR_FRICTION) : null;
  h.schema.defaults.config.plant = { friction: false };
  h.schema.available_N_by_friction = { off: [16, 32, 64], on };
  h.schema.friction = { coefficients: { coulomb_nm: PREDICTOR_FRICTION.coulomb_nm, viscous_nm_s_per_rad: PREDICTOR_FRICTION.viscous_nm_s_per_rad },
    simulation_law: 'hard-sign Coulomb + viscous (RK4)', prediction_law: 'tanh Coulomb (width 0.03 rad/s) + viscous' };
  h.schema.parameters.push(
    { path: 'friction', label: 'Predictor friction', kind: 'choice', group: 'Friction',
      choices: [{ value: null, label: 'Loss-free' }, { value: structuredClone(PREDICTOR_FRICTION), label: 'URDF Coulomb + viscous, tanh 0.03 rad/s' }] },
    { path: 'plant.friction', label: 'Simulator friction', kind: 'bool', group: 'Friction' },
  );
  return path => h.created.filter(el => el.dataset.path === path).at(-1);
}

test('friction controls start loss-free and submit independent simulator and predictor friction from the frozen native anchor', async () => {
  const h = harness(), field = frictionSchema(h);
  const originals = Object.fromEntries(['document', 'fetch', 'EventSource'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: h.document, fetch: h.fetch, EventSource: h.EventSource });
  try {
    const live = setupLive({ onMode() {}, onPlan() {}, onState() {}, onReset() {} });
    await flush(); h.$('live-mode').emit('click'); const source = h.sources.at(-1); source.open();
    source.emit({ type: 'status', state: 'paused', settings_version: 0 }); await flush(); source.emit(plan(1, 1));
    assert.equal(field('plant.friction').checked, false);
    assert.equal(field('friction').value, '0');
    assert.deepEqual(field('friction').children.map(item => item.textContent), ['Loss-free', 'URDF Coulomb + viscous, tanh 0.03 rad/s']);
    assert(h.created.some(el => el.textContent?.includes('hard-sign Coulomb + viscous')));
    assert(h.created.some(el => el.textContent === 'Coulomb (Nm), joints 1–7: 2.1, 2.6, 2, 1.95, 0.8, 1.1, 0.3'));
    assert(h.created.some(el => el.textContent === 'Viscous (Nm s/rad), joints 1–7: 3.35, 4.15, 2.45, 2.25, 0.5, 0.3, 0.15'));
    for (const time of [1, 1.2]) source.emit({ type: 'state', settings_version: 1, sim_time_s: time,
      q: Array(7).fill(time), qd: Array(7).fill(-.2), ee_xyz: [time, 0, 1] });
    h.$('live-history').value = '1'; h.$('live-history').emit('input');
    const anchor = structuredClone(live.displayedState), presentation = live.presentationSettings;
    field('plant.friction').checked = true; field('plant.friction').emit('input');
    assert.equal(live.playing, false);
    source.emit({ type: 'state', settings_version: 1, sim_time_s: 1.3, q: Array(7).fill(3), qd: Array(7).fill(2), ee_xyz: [3, 0, 1] });
    await new Promise(resolve => setTimeout(resolve, 380));
    const simulatorOnly = h.commands.at(-1);
    assert.equal(simulatorOnly.type, 'set_settings');
    assert.deepEqual(simulatorOnly.config.plant, { friction: true }); assert.equal(simulatorOnly.config.friction, null);
    assert.deepEqual(simulatorOnly.anchor, { sim_time_s: 1, q: anchor.q, qd: anchor.qd });
    assert.equal(simulatorOnly.reset, undefined); assert.deepEqual(live.presentationSettings, presentation);
    source.emit(plan(2, 2));
    field('friction').value = '1'; field('friction').emit('input');
    field('plant.friction').checked = false; field('plant.friction').emit('input');
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.deepEqual(h.commands.at(-1).config.friction, PREDICTOR_FRICTION);
    assert.deepEqual(h.commands.at(-1).config.plant, { friction: false });
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

test('Limit handling shows Clip effort and the three Stop on breach checkboxes in one row with their defaults', async () => {
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
    assert(h.created.some(el => el.tagName === 'details' && el.open && el.children[0].textContent === 'Limit handling'));
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
    const live = setupLive({ onMode() {}, onPlan() {}, onState: state => shown.push(state), onReset: () => resets.push(1) });
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
