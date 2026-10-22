import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRESENTATION, validatePresentation, setupPresentationSettings } from './presentation-settings.js';

test('presentation settings validate delivery cadence, simulation buffer and interpolation independently', () => {
  assert.deepEqual(validatePresentation({}), DEFAULT_PRESENTATION);
  assert.deepEqual(validatePresentation({ report_hz: 1, buffer_ms: 0, interpolate: true }), { report_hz: 1, buffer_ms: 0, interpolate: true, limit_tint: true });
  assert.equal(validatePresentation({ report_hz: 120, buffer_ms: 10000 }).buffer_ms, 10000);
  for (const value of [{ report_hz: 0 }, { report_hz: 121 }, { report_hz: NaN }, { buffer_ms: -1 }, { buffer_ms: Infinity }, { buffer_ms: 10001 }, { interpolate: 'false' }, { limit_tint: 1 }]) assert.throws(() => validatePresentation(value));
});

test('presentation loads and saves through its own endpoint without a Source apply or Live command', async () => {
  class Element {
    constructor() { this.children = []; this.queries = new Map(); this.listeners = {}; this.dataset = {}; }
    append(child) { this.children.push(child); }
    set value(value) { this._value = String(value); }
    get value() { return this._value; }
    querySelector(selector) { if (!this.queries.has(selector)) this.queries.set(selector, new Element()); return this.queries.get(selector); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
  }
  const original = globalThis.document; globalThis.document = { createElement: () => new Element() };
  try {
    const container = new Element(), requests = [], changes = [];
    const saved = { report_hz: 10, buffer_ms: 350, interpolate: true, limit_tint: false };
    const ui = setupPresentationSettings({ container, onChange: value => changes.push(value), request: async (path, body) => { requests.push({ path, body }); return body || saved; } });
    const section = container.children[0], save = section.querySelector('[data-action="save-presentation"]');
    assert.equal(save.disabled, true);
    await ui.ready;
    assert.deepEqual(ui.settings, saved); assert.equal(save.disabled, false);
    const field = name => section.querySelector(`[name="${name}"]`);
    field('report_hz').value = 30; field('buffer_ms').value = 200; field('interpolate').checked = false; field('limit_tint').checked = true;
    await save.listeners.click();
    assert.deepEqual(changes, [saved, { report_hz: 30, buffer_ms: 200, interpolate: false, limit_tint: true }]);
    assert.deepEqual(requests, [{ path: '/api/presentation/settings', body: undefined }, { path: '/api/presentation/settings', body: changes[1] }]);
    field('buffer_ms').value = '';
    await save.listeners.click(); assert.equal(requests.length, 2);
    assert.match(section.querySelector('.presentation-message').textContent, /buffer must be/);
  } finally { globalThis.document = original; }
});
