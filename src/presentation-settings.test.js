import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRESENTATION, validatePresentation, setupPresentationSettings } from './presentation-settings.js';

test('presentation settings validate delivery cadence, simulation buffer and interpolation independently', () => {
  assert.deepEqual(validatePresentation({}), DEFAULT_PRESENTATION);
  assert.deepEqual(validatePresentation({ report_hz: 1, buffer_ms: 0, interpolate: true }), { ...DEFAULT_PRESENTATION, report_hz: 1, buffer_ms: 0, interpolate: true, limit_tint: true });
  assert.equal(validatePresentation({ report_hz: 120, buffer_ms: 10000 }).buffer_ms, 10000);
  for (const value of [{ report_hz: 0 }, { report_hz: 121 }, { report_hz: NaN }, { buffer_ms: -1 }, { buffer_ms: Infinity }, { buffer_ms: 10001 }, { interpolate: 'false' }, { limit_tint: 1 }, { limit_near_percent: 0 }, { limit_near_percent: 101 }, { limit_at_position_rad: -0.001 }, { limit_at_velocity_rad_s: 2 }, { limit_at_torque_percent: 11 }, { limit_at_torque_percent: '1' }]) assert.throws(() => validatePresentation(value));
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

async function harness(t, { store = { report_hz: 10, buffer_ms: 350, interpolate: true, limit_tint: false }, fail = false, request: requestOverride } = {}) {
  if (!t.mock.timers._enabled) { t.mock.timers.enable({ apis: ['setTimeout'] }); t.mock.timers._enabled = true; }
  const original = globalThis.document; globalThis.document = { createElement: () => new Element() };
  t.after(() => { globalThis.document = original; });
  const container = new Element(), posts = [], changes = [], state = { fail, reads: 0 };
  const ui = setupPresentationSettings({ container, onChange: value => changes.push(value), request: async (path, body) => {
    assert.equal(path, body ? '/api/presentation/settings/patch' : '/api/presentation/settings');
    if (requestOverride) return requestOverride(path, body, { store, posts, state });
    if (!body) { state.reads++; return { ...store }; }
    if (state.fail) throw new Error('disk full');
    posts.push(body); Object.assign(store, body); return { ...store }; } });
  t.after(() => ui.dispose());
  const section = container.children[0], field = name => section.querySelector(`[name="${name}"]`);
  await ui.ready;
  return { ui, section, field, posts, changes, store, state, tick: ms => t.mock.timers.tick(ms), title: section.querySelector('.presentation-title') };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('limit-state fields apply at once, validate their range and save', async t => {
  const h = await harness(t);
  assert.equal(h.field('limit_near_percent').value, '90');
  h.field('limit_near_percent').value = '80'; h.field('limit_near_percent').listeners.change();
  assert.equal(h.changes.at(-1).limit_near_percent, 80);
  h.field('limit_at_torque_percent').value = '12'; h.field('limit_at_torque_percent').listeners.change();
  assert.equal(h.field('limit_at_torque_percent').dataset.invalid, 'true');
  assert.equal(h.changes.at(-1).limit_at_torque_percent, 0.2);
  h.tick(400); await settle();
  assert.deepEqual(h.posts.at(-1), { limit_near_percent: 80 });
});

test('ghost opacity endpoints apply and persist independently without changing numerical settings', async t => {
  const h = await harness(t);
  assert.equal(h.field('ghost_start_opacity_percent').value, '55');
  assert.equal(h.field('ghost_end_opacity_percent').value, '25');
  assert.match(h.section.innerHTML, /Ghost start opacity \(%\)/); assert.match(h.section.innerHTML, /Ghost end opacity \(%\)/);
  assert.match(h.field('ghost_start_opacity_percent').title, /beginning of the aggregate range/);
  assert.match(h.field('ghost_end_opacity_percent').title, /end of the aggregate range/);
  const start = h.field('ghost_start_opacity_percent'), end = h.field('ghost_end_opacity_percent');
  start.value = '70'; start.listeners.change(); end.value = '10'; end.listeners.change();
  assert.equal(h.changes.at(-1).ghost_start_opacity_percent, 70); assert.equal(h.changes.at(-1).ghost_end_opacity_percent, 10);
  assert.equal(h.changes.at(-1).report_hz, 10);
  h.tick(400); await settle();
  assert.equal(h.store.ghost_start_opacity_percent, 70); assert.equal(h.store.ghost_end_opacity_percent, 10);
  assert.equal('ghost_opacity_percent' in h.posts.at(-1), false);
  for (const field of [start, end]) for (const value of ['-1', '101', '', 'NaN', 'Infinity']) {
    field.value = value; field.listeners.change();
    assert.equal(field.dataset.invalid, 'true');
    assert.equal(h.ui.settings.ghost_start_opacity_percent, 70); assert.equal(h.ui.settings.ghost_end_opacity_percent, 10);
  }
});

test('legacy scalar opacity migrates to start/end while explicit endpoint preferences take precedence', () => {
  const legacy = { ghost_opacity_percent: 70 }, migrated = validatePresentation(legacy);
  assert.equal(migrated.ghost_start_opacity_percent, 70); assert.equal(migrated.ghost_end_opacity_percent, 70 * (25 / 55));
  assert.equal('ghost_opacity_percent' in migrated, false); assert.deepEqual(legacy, { ghost_opacity_percent: 70 });
  const explicit = validatePresentation({ ...legacy, ghost_start_opacity_percent: 80, ghost_end_opacity_percent: 10 });
  assert.equal(explicit.ghost_start_opacity_percent, 80); assert.equal(explicit.ghost_end_opacity_percent, 10);
  assert.equal(validatePresentation({ ...legacy, ghost_start_opacity_percent: 80 }).ghost_end_opacity_percent, migrated.ghost_end_opacity_percent);
  assert.equal(validatePresentation({ ...legacy, ghost_end_opacity_percent: 10 }).ghost_start_opacity_percent, 70);
  for (const name of ['ghost_start_opacity_percent', 'ghost_end_opacity_percent']) for (const value of [-1, 101, NaN, Infinity, false, '25', null]) {
    assert.throws(() => validatePresentation({ [name]: value }));
  }
  assert.throws(() => validatePresentation({ extra: 1 }), /Unknown/);
});

test('a legacy endpoint response loads as two fields and the next save posts only new endpoint keys', async t => {
  const h = await harness(t, { store: { ghost_opacity_percent: 70 } });
  assert.equal(h.ui.settings.ghost_start_opacity_percent, 70); assert.equal(h.ui.settings.ghost_end_opacity_percent, 70 * (25 / 55));
  h.field('ghost_end_opacity_percent').value = '12'; h.field('ghost_end_opacity_percent').listeners.change(); h.tick(400); await settle();
  assert.equal(h.posts.at(-1).ghost_end_opacity_percent, 12); assert.equal('ghost_opacity_percent' in h.posts.at(-1), false);
});

test('presentation loads from its own endpoint and has no Save button', async t => {
  const h = await harness(t);
  assert.deepEqual(h.ui.settings, { ...DEFAULT_PRESENTATION, report_hz: 10, buffer_ms: 350, interpolate: true, limit_tint: false });
  assert.deepEqual(h.changes, [h.ui.settings]);
  assert.equal(h.section.querySelector('[data-action="save-presentation"]').listeners.click, undefined);
  assert.equal(h.field('report_hz').value, '10'); assert.equal(h.field('limit_tint').checked, false);
});

test('presentation timing accepts either units, saves canonical numbers and retains typed spellings after echo', async t => {
  const h = await harness(t), rate = h.field('report_hz'), buffer = h.field('buffer_ms');
  assert.equal(rate.type, 'text'); assert.equal(buffer.type, 'text');
  rate.value = '20 ms'; rate.listeners.change();
  buffer.value = '.5 s'; buffer.listeners.change();
  assert.equal(h.ui.settings.report_hz, 50); assert.equal(h.ui.settings.buffer_ms, 500);
  h.tick(400); await settle();
  assert.deepEqual(h.posts.at(-1), { report_hz: 50, buffer_ms: 500 });
  assert.equal(rate.value, '20 ms'); assert.equal(buffer.value, '.5 s');
  await h.ui.refresh(); assert.equal(rate.value, '20 ms'); assert.equal(buffer.value, '.5 s');
  rate.value = '.001 s'; rate.listeners.change();
  assert.equal(rate.dataset.invalid, 'true'); assert.equal(h.ui.settings.report_hz, 50);
  buffer.value = '-1ms'; buffer.listeners.change();
  assert.equal(buffer.dataset.invalid, 'true'); assert.equal(h.ui.settings.buffer_ms, 500);
});

test('checkboxes apply at once and save after a debounce', async t => {
  const h = await harness(t);
  h.field('limit_tint').checked = true; h.field('limit_tint').listeners.change();
  assert.equal(h.changes.at(-1).limit_tint, true); assert.equal(h.posts.length, 0);
  h.tick(400); await settle();
  assert.deepEqual(h.posts, [{ limit_tint: true }]);
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
  assert.deepEqual(h.posts.at(-1), { interpolate: false, limit_tint: true });
});

test('settings persist across a reload through the endpoint', async t => {
  const store = { report_hz: 20, buffer_ms: 200, interpolate: false, limit_tint: true };
  const h = await harness(t, { store });
  h.field('buffer_ms').value = '500'; h.field('buffer_ms').listeners.change(); h.tick(400); await settle();
  const reloaded = await harness(t, { store });
  assert.equal(reloaded.ui.settings.buffer_ms, 500); assert.equal(reloaded.field('buffer_ms').value, '500');
});

test('polling hydrates externally changed fields and callbacks without posting numerical work', async t => {
  const h = await harness(t);
  Object.assign(h.store, { buffer_ms: 800, interpolate: false, ghost_end_opacity_percent: 15 });
  h.tick(1000); await settle();
  assert.equal(h.state.reads, 2);
  assert.equal(h.field('buffer_ms').value, '800');
  assert.equal(h.field('interpolate').checked, false);
  assert.equal(h.field('ghost_end_opacity_percent').value, '15');
  assert.equal(h.changes.at(-1).buffer_ms, 800);
  assert.equal(h.posts.length, 0);
  const count = h.changes.length;
  await h.ui.refresh();
  assert.equal(h.changes.length, count); // unchanged polling does not redraw plots
  h.ui.dispose();
  h.tick(5000); await settle();
  assert.equal(h.state.reads, 3);
});

test('remote updates preserve a pending local field and its save patches only that field', async t => {
  const h = await harness(t);
  h.field('buffer_ms').value = '600'; h.field('buffer_ms').listeners.change();
  Object.assign(h.store, { buffer_ms: 900, report_hz: 70, limit_tint: true });
  await h.ui.refresh();
  assert.equal(h.ui.settings.buffer_ms, 600);
  assert.equal(h.field('buffer_ms').value, '600');
  assert.equal(h.field('report_hz').value, '70');
  assert.equal(h.field('limit_tint').checked, true);
  h.tick(400); await settle();
  assert.deepEqual(h.posts, [{ buffer_ms: 600 }]);
  assert.equal(h.store.report_hz, 70);
  assert.equal(h.store.limit_tint, true);
});

test('typing retains the local draft while other externally changed values appear', async t => {
  const h = await harness(t);
  h.field('buffer_ms').value = '65'; h.field('buffer_ms').listeners.input();
  Object.assign(h.store, { buffer_ms: 900, report_hz: 75 });
  await h.ui.refresh();
  assert.equal(h.field('buffer_ms').value, '65');
  assert.equal(h.field('report_hz').value, '75');
  h.tick(700); await settle();
  assert.equal(h.ui.settings.buffer_ms, 65);
  h.tick(400); await settle();
  assert.deepEqual(h.posts, [{ buffer_ms: 65 }]);
});

test('a change during an in-flight patch is saved afterwards and retains response fields', async t => {
  let finish;
  const h = await harness(t, { request: async (path, body, { store, posts }) => {
    if (!body) return { ...store };
    posts.push({ ...body }); Object.assign(store, body);
    if (posts.length === 1) return new Promise(resolve => { finish = () => resolve({ ...store }); });
    return { ...store };
  } });
  h.field('limit_tint').checked = true; h.field('limit_tint').listeners.change();
  h.tick(400); await settle();
  h.store.buffer_ms = 800;
  h.field('report_hz').value = '40'; h.field('report_hz').listeners.change();
  finish(); await settle();
  assert.equal(h.field('buffer_ms').value, '800');
  assert.equal(h.field('report_hz').value, '40');
  h.tick(400); await settle();
  assert.deepEqual(h.posts, [{ limit_tint: true }, { report_hz: 40 }]);
  assert.equal(h.store.buffer_ms, 800);
});

test('a poll started before a save cannot restore the old preferences afterwards', async t => {
  let finish, reads = 0;
  const h = await harness(t, { request: async (path, body, { store, posts }) => {
    if (!body) {
      if (++reads === 2) { const stale = { ...store }; return new Promise(resolve => { finish = () => resolve(stale); }); }
      return { ...store };
    }
    posts.push({ ...body }); Object.assign(store, body); return { ...store };
  } });
  const refresh = h.ui.refresh();
  h.field('buffer_ms').value = '650'; h.field('buffer_ms').listeners.change();
  h.tick(400); await settle();
  finish(); await refresh;
  assert.equal(h.field('buffer_ms').value, '650');
  assert.equal(h.ui.settings.buffer_ms, 650);
  assert.equal(h.changes.at(-1).buffer_ms, 650);
});

test('invalid remote snapshots and failed polls leave the last valid displayed settings', async t => {
  const h = await harness(t);
  h.store.buffer_ms = -1;
  await h.ui.refresh();
  assert.equal(h.ui.settings.buffer_ms, 350);
  assert.equal(h.field('buffer_ms').value, '350');
  assert.equal(h.changes.length, 1);
  h.store.buffer_ms = 850;
  await h.ui.refresh();
  assert.equal(h.field('buffer_ms').value, '850');
});
