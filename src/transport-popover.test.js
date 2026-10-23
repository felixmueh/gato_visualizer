import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTransportPopovers, setupGhostControls, GHOST_SETTINGS_KEY } from './transport-popover.js';
import { plotDOM } from './plot-dom-test-helper.js';

test('hover settings stay open when moving into the panel, support keyboard entry and Escape', async () => {
  const { document: doc } = plotDOM();
  const wrapper = doc.createElement('div'), trigger = doc.createElement('button'), panel = doc.createElement('div'), input = doc.createElement('input');
  panel.append(input); wrapper.append(trigger, panel); panel.hidden = true;
  wrapper.querySelector = selector => selector === '[data-popover-trigger]' ? trigger : panel;
  doc.querySelectorAll = () => [wrapper];
  const contains = function (element) { return this === element || this.children.some(child => contains.call(child, element)); };
  wrapper.contains = panel.contains = contains;
  setupTransportPopovers(doc);
  await wrapper.emit('pointerenter'); assert.equal(panel.hidden, false);
  input.focus(); await wrapper.emit('pointerleave'); assert.equal(panel.hidden, false);
  await wrapper.emit('keydown', { target: input, key: 'Escape' });
  assert.equal(panel.hidden, true); assert.equal(doc.activeElement, trigger);
  await wrapper.emit('keydown', { target: trigger, key: 'ArrowUp' });
  assert.equal(panel.hidden, false); assert.equal(doc.activeElement, input);
  doc.body.focus(); await wrapper.emit('focusout', { relatedTarget: doc.body });
  assert.equal(panel.hidden, true);
});

test('ghost spacing and strict maximum synchronize both popovers and retain valid browser preferences', async () => {
  const { document: doc } = plotDOM(), elements = new Map(), stored = new Map(), changes = [];
  for (const mode of ['live', 'replay']) for (const name of ['spacingEnabled', 'interval_s', 'maxCount']) {
    const input = doc.createElement('input'); input.dataset.tip = 'setting';
    input.removeAttribute = key => delete input.attributes[key]; elements.set(`${mode}-ghost-${name}`, input);
  }
  doc.getElementById = id => elements.get(id);
  const storage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  const controls = setupGhostControls({ doc, storage, onChange: settings => changes.push(settings) });
  const interval = elements.get('live-ghost-interval_s'), maximum = elements.get('replay-ghost-maxCount');
  assert.equal(Number(interval.value), .5); assert.equal(Number(maximum.value), 16);
  interval.value = '1.25'; await interval.emit('change');
  assert.equal(Number(elements.get('replay-ghost-interval_s').value), 1.25);
  maximum.value = '8'; await maximum.emit('keydown', { key: 'Enter' });
  assert.deepEqual(controls.settings, { spacingEnabled: true, interval_s: 1.25, maxCount: 8 });
  assert.deepEqual(JSON.parse(stored.get(GHOST_SETTINGS_KEY)), controls.settings);
  for (const value of ['0', '1.5', '65', '']) {
    maximum.value = value; await maximum.emit('change');
    assert.equal(maximum.getAttribute('aria-invalid'), 'true'); assert.equal(controls.settings.maxCount, 8);
  }
  const reloaded = setupGhostControls({ doc, storage, onChange() {} });
  assert.deepEqual(reloaded.settings, { spacingEnabled: true, interval_s: 1.25, maxCount: 8 });
  assert.equal(changes.length, 3);
});

test('Fixed spacing defaults on for old preferences, persists off and disables only the retained seconds input', async () => {
  const stored = new Map([[GHOST_SETTINGS_KEY, JSON.stringify({ interval_s: 1.25, maxCount: 8 })]]);
  const storage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  function fixture() {
    const { document: doc } = plotDOM(), elements = new Map();
    for (const mode of ['live', 'replay']) for (const name of ['spacingEnabled', 'interval_s', 'maxCount']) {
      const input = doc.createElement('input'); input.dataset.tip = 'setting'; input.removeAttribute = key => delete input.attributes[key]; elements.set(`${mode}-ghost-${name}`, input);
    }
    doc.getElementById = id => elements.get(id);
    return { elements, controls: setupGhostControls({ doc, storage, onChange() {} }) };
  }
  const first = fixture(), toggle = first.elements.get('live-ghost-spacingEnabled');
  assert.equal(toggle.checked, true); assert.equal(first.controls.settings.spacingEnabled, true);
  assert.equal(first.elements.get('live-ghost-interval_s').disabled, false);
  toggle.checked = false; await toggle.emit('change');
  assert.equal(first.controls.settings.spacingEnabled, false); assert.equal(first.elements.get('replay-ghost-spacingEnabled').checked, false);
  for (const mode of ['live', 'replay']) {
    assert.equal(first.elements.get(`${mode}-ghost-interval_s`).disabled, true);
    assert.equal(Number(first.elements.get(`${mode}-ghost-interval_s`).value), 1.25);
    assert.equal(Boolean(first.elements.get(`${mode}-ghost-maxCount`).disabled), false);
  }
  assert.deepEqual(JSON.parse(stored.get(GHOST_SETTINGS_KEY)), { spacingEnabled: false, interval_s: 1.25, maxCount: 8 });
  const reloaded = fixture(); assert.equal(reloaded.controls.settings.spacingEnabled, false); assert.equal(reloaded.elements.get('live-ghost-interval_s').disabled, true);
  const enabled = reloaded.elements.get('replay-ghost-spacingEnabled'); enabled.checked = true; await enabled.emit('change');
  assert.equal(reloaded.elements.get('live-ghost-spacingEnabled').checked, true); assert.equal(reloaded.elements.get('live-ghost-interval_s').disabled, false);
  assert.equal(Number(reloaded.elements.get('live-ghost-interval_s').value), 1.25);
});
