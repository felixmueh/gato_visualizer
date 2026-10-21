import test from 'node:test';
import assert from 'node:assert/strict';
import { setupLive } from './live.js';
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
    emit(type) { for (const callback of this.handlers[type] || []) callback({ target: this }); }
    append(...children) {
      this.children.push(...children);
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
    defaults: { execution: { ...DEFAULT_EXECUTION }, config: { N: 32, solver_params: { q_cost: 4, max_sqp_iters: 5, max_pcg_iters: 120 }, unlisted: { preserved: true } }, task: { kind: 'reach', target_offset_m: [0, 0, 0] } },
    available_N: [16, 32, 64],
    parameters: [
      { path: 'N', kind: 'int' },
      ...['q_cost', 'max_sqp_iters', 'max_pcg_iters'].map(path => ({ path: `solver_params.${path}`, label: path, kind: path === 'q_cost' ? 'float' : 'int', min: 0 })),
    ],
    tasks: [
      { kind: 'reach', label: 'Reach', defaults: { kind: 'reach' } },
      { kind: 'figure8', label: 'Figure eight', defaults: { kind: 'figure8', width_m: .24, height_m: .16, period_s: 8 }, parameters: ['width_m', 'height_m', 'period_s'].map(path => ({ path, label: path, kind: 'float', min: .001 })) },
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
const plan = (version, seq, task_kind = 'reach') => ({
  type: 'plan', settings_version: version, seq, task_kind, origin: 'preview', sim_time_s: 0,
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
