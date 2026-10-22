import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRESENTATION, validatePresentation, setupPresentationSettings } from './presentation-settings.js';

test('presentation settings validate delivery cadence, simulation buffer and interpolation independently', () => {
  assert.deepEqual(validatePresentation({}), DEFAULT_PRESENTATION);
  assert.deepEqual(validatePresentation({ report_hz: 1, buffer_ms: 0, interpolate: true }), { report_hz: 1, buffer_ms: 0, interpolate: true, limit_tint: true });
  assert.equal(validatePresentation({ report_hz: 120, buffer_ms: 10000 }).buffer_ms, 10000);
  for (const value of [{ report_hz: 0 }, { report_hz: 121 }, { report_hz: NaN }, { buffer_ms: -1 }, { buffer_ms: Infinity }, { buffer_ms: 10001 }, { interpolate: 'false' }, { limit_tint: 1 }]) assert.throws(() => validatePresentation(value));
});

class Element {
  constructor() { this.children = []; this.queries = new Map(); this.listeners = {}; this.dataset = {}; this.title = ''; }
  append(child) { this.children.push(child); }
  set value(value) { this._value = String(value); }
  get value() { return this._value; }
  querySelector(selector) { if (!this.queries.has(selector)) this.queries.set(selector, new Element()); return this.queries.get(selector); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  removeAttribute() {} setAttribute() {}
}

async function harness(t, { store = { report_hz: 10, buffer_ms: 350, interpolate: true, limit_tint: false }, fail = false } = {}) {
  if (!t.mock.timers._enabled) { t.mock.timers.enable({ apis: ['setTimeout'] }); t.mock.timers._enabled = true; }
  const original = globalThis.document; globalThis.document = { createElement: () => new Element() };
  t.after(() => { globalThis.document = original; });
  const container = new Element(), posts = [], changes = [], state = { fail };
  const ui = setupPresentationSettings({ container, onChange: value => changes.push(value), request: async (path, body) => {
    assert.equal(path, '/api/presentation/settings');
    if (!body) return { ...store };
    if (state.fail) throw new Error('disk full');
    posts.push(body); Object.assign(store, body); return body; } });
  const section = container.children[0], field = name => section.querySelector(`[name="${name}"]`);
  await ui.ready;
  return { ui, section, field, posts, changes, store, state, tick: ms => t.mock.timers.tick(ms), title: section.querySelector('.presentation-title') };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('presentation loads from its own endpoint and has no Save button', async t => {
  const h = await harness(t);
  assert.deepEqual(h.ui.settings, { report_hz: 10, buffer_ms: 350, interpolate: true, limit_tint: false });
  assert.deepEqual(h.changes, [h.ui.settings]);
  assert.equal(h.section.querySelector('[data-action="save-presentation"]').listeners.click, undefined);
  assert.equal(h.field('report_hz').value, '10'); assert.equal(h.field('limit_tint').checked, false);
});

test('checkboxes apply at once and save after a debounce', async t => {
  const h = await harness(t);
  h.field('limit_tint').checked = true; h.field('limit_tint').listeners.change();
  assert.equal(h.changes.at(-1).limit_tint, true); assert.equal(h.posts.length, 0);
  h.tick(400); await settle();
  assert.deepEqual(h.posts, [{ report_hz: 10, buffer_ms: 350, interpolate: true, limit_tint: true }]);
});

test('numeric fields apply on commit or idle, never per keystroke, and rapid changes coalesce', async t => {
  const h = await harness(t), input = h.field('report_hz');
  for (const v of ['3', '30', '300']) { input.value = v; input.listeners.input(); h.tick(100); }
  assert.equal(h.changes.length, 1); // initial load only
  assert.equal(input.dataset.invalid, 'true'); assert.match(input.title, /between 1 and 120/);
  input.value = '40'; input.listeners.input(); input.value = '45'; input.listeners.input();
  h.tick(700); // idle debounce commits the last value
  assert.equal(h.changes.at(-1).report_hz, 45); assert.equal(input.dataset.invalid, undefined);
  input.value = '50'; input.listeners.change(); input.value = '60'; input.listeners.keydown({ key: 'Enter' });
  h.tick(400); await settle();
  assert.deepEqual(h.posts.map(p => p.report_hz), [60]); // one POST, last value wins
});

test('invalid values are neither applied nor saved and the last valid value stays', async t => {
  const h = await harness(t);
  h.field('buffer_ms').value = '-5'; h.field('buffer_ms').listeners.change();
  h.field('report_hz').value = ''; h.field('report_hz').listeners.change();
  h.tick(2000); await settle();
  assert.equal(h.changes.length, 1); assert.equal(h.posts.length, 0);
  assert.equal(h.ui.settings.buffer_ms, 350); assert.equal(h.ui.settings.report_hz, 10);
  assert.match(h.field('buffer_ms').title, /between 0 and 10000/); assert.equal(h.field('report_hz').dataset.invalid, 'true');
  h.field('buffer_ms').value = '100'; h.field('buffer_ms').listeners.change();
  assert.equal(h.field('buffer_ms').dataset.invalid, undefined); assert.equal(h.ui.settings.buffer_ms, 100);
});

test('a change during an in-flight save is sent afterwards; failures are marked and retried on the next change', async t => {
  const h = await harness(t, { fail: true });
  h.field('interpolate').checked = false; h.field('interpolate').listeners.change(); h.tick(400); await settle();
  assert.equal(h.title.dataset.saveFailed, 'true'); assert.match(h.title.title, /disk full/);
  assert.equal(h.ui.settings.interpolate, false); // still applied
  h.state.fail = false;
  h.field('limit_tint').checked = true; h.field('limit_tint').listeners.change(); h.tick(400); await settle();
  assert.equal(h.title.dataset.saveFailed, undefined);
  assert.deepEqual(h.posts.at(-1), { report_hz: 10, buffer_ms: 350, interpolate: false, limit_tint: true });
});

test('settings persist across a reload through the endpoint', async t => {
  const store = { report_hz: 20, buffer_ms: 200, interpolate: false, limit_tint: true };
  const h = await harness(t, { store });
  h.field('buffer_ms').value = '500'; h.field('buffer_ms').listeners.change(); h.tick(400); await settle();
  const reloaded = await harness(t, { store });
  assert.equal(reloaded.ui.settings.buffer_ms, 500); assert.equal(reloaded.field('buffer_ms').value, '500');
});
