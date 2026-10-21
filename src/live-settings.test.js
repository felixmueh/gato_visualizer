import test from 'node:test';
import assert from 'node:assert/strict';
import { setupLive } from './live.js';

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
    defaults: { config: { N: 32, solver_params: { q_cost: 4, max_sqp_iters: 5, max_pcg_iters: 120 }, unlisted: { preserved: true } }, task: { kind: 'reach', target_offset_m: [0, 0, 0] } },
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
  let version = 0;
  class EventSource {
    static OPEN = 1;
    constructor() { this.readyState = 0; sources.push(this); }
    close() { this.readyState = 2; }
    open() { this.readyState = 1; this.onopen?.(); }
    emit(item) { this.onmessage?.({ data: JSON.stringify(item) }); }
  }
  const fetch = async (url, options) => {
    if (url.endsWith('/schema')) return { ok: true, json: async () => structuredClone(schema) };
    const command = JSON.parse(options.body); commands.push(command);
    if (command.type === 'set_settings') version++;
    return { ok: true, json: async () => ({ accepted: true, settings_version: version }) };
  };
  const edit = (path, value) => {
    const element = path.startsWith('target-offset-') ? $(path) : created.find(el => el.dataset.path === path);
    element.value = String(value); element.emit('input');
  };
  return { $, document, EventSource, fetch, commands, sources, created, edit, schema, setVersion(value) { version = value; } };
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
