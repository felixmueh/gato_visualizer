import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAnimationExportDialog } from './animation-export-dialog.js';

function harness(t, settings = {}) {
  const { document, Event } = parseHTML('<html><body></body></html>');
  const original = globalThis.document; globalThis.document = document;
  const prototype = Object.getPrototypeOf(document.createElement('dialog'));
  prototype.showModal = function () { this.open = true; };
  prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
  const ui = createAnimationExportDialog({ storage: null, ...settings });
  t.after(() => { ui.destroy(); globalThis.document = original; });
  const field = name => ui.body.querySelector(`[name="${name}"]`);
  const choose = (name, value) => {
    const select = field(name);
    for (const option of select.options) option.selected = false;
    [...select.options].find(option => option.value === value).selected = true;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };
  return { ui, field, choose, submit: () => ui.body.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true })), click: action => ui.body.querySelector(`[data-action="${action}"]`).click() };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('visible defaults and settings produce exact export options and persist', async t => {
  const saved = new Map(), calls = [];
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const h = harness(t, { storage, onExport: async options => calls.push(options) });
  h.ui.open();
  assert.equal(h.ui.isOpen, true);
  assert.deepEqual(h.ui.options, { width: 1920, height: 1080, views: 'main', orientation: 'current' });
  assert.equal(h.field('resolution').value, '1080');
  h.choose('resolution', '2160'); h.choose('views', 'main-principal'); h.choose('orientation', 'right');
  h.submit(); await settle();
  assert.deepEqual(calls, [{ width: 3840, height: 2160, views: 'main-principal', orientation: 'right' }]);
  assert.equal(h.ui.isOpen, false);
  const second = createAnimationExportDialog({ storage, onExport: async () => {} });
  assert.deepEqual(second.options, calls[0]); second.destroy();
});

test('availability is rechecked at export time without capturing context in advance', async t => {
  let allowed = false, calls = 0;
  const h = harness(t, { getContext: () => ({ canExport: allowed, reason: 'Select a nonempty aggregate window.' }), onExport: async () => calls++ });
  h.ui.open(); h.submit(); await settle(); assert.equal(calls, 0);
  assert.equal(h.ui.body.querySelector('[data-action="export"]').disabled, true);
  allowed = true; h.ui.refresh(); assert.equal(h.ui.body.querySelector('[data-action="export"]').disabled, false);
  allowed = false; h.submit(); await settle(); assert.equal(calls, 0);
});

test('busy export reports progress, blocks repeat submission, and cancel aborts', async t => {
  let callbacks, resolve, calls = 0;
  const h = harness(t, { onExport: (_options, value) => { calls++; callbacks = value; return new Promise(done => { resolve = done; }); } });
  h.ui.open(); h.submit(); h.submit(); assert.equal(calls, 1); assert.equal(h.ui.busy, true);
  assert.equal(h.field('views').disabled, true);
  callbacks.onProgress({ progress: 0.4 });
  assert.equal(h.ui.body.querySelector('.animation-export-progress span').textContent, '40%');
  h.click('cancel'); assert.equal(callbacks.signal.aborted, true);
  callbacks.onProgress(0.9);
  assert.equal(h.ui.body.querySelector('.animation-export-progress span').textContent, 'Canceling…');
  resolve(); await settle(); assert.equal(h.ui.busy, false); assert.equal(h.field('views').disabled, false);
});

test('closing aborts active export; export failure is visible and can be retried', async t => {
  let reject, signal, count = 0;
  const h = harness(t, { onExport: (_options, callbacks) => { count++; signal = callbacks.signal; return new Promise((_resolve, fail) => { reject = fail; }); } });
  h.ui.open(); h.submit(); reject(new Error('Encoder unavailable.')); await settle();
  assert.equal(h.ui.body.querySelector('[role="status"]').textContent, 'Encoder unavailable.');
  assert.equal(h.ui.busy, false); h.submit(); assert.equal(count, 2);
  h.ui.close(); assert.equal(signal.aborted, true); reject(new Error('Aborted')); await settle();
});

test('malformed or unsupported saved settings use visible defaults', t => {
  const h = harness(t, { storage: { getItem: () => '{"width":3,"height":5,"views":"unknown","orientation":"unknown"}' }, onExport: async () => {} });
  assert.deepEqual(h.ui.options, { width: 1920, height: 1080, views: 'main', orientation: 'current' });
});
