import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalOrientation, createSettingResets, settingValuesEqual } from './setting-resets.js';

function dom() {
  const doc = { activeElement: null };
  class Element extends EventTarget {
    constructor(tag) { super(); this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.attributes = {}; this.classList = { toggle() {} }; }
    append(...children) { for (const child of children) { this.children.push(child); child.parentElement = this; } }
    closest(tag) { for (let item = this; item; item = item.parentElement) if (item.tagName === tag) return item; return null; }
    replaceWith(next) { const parent = this.parentElement; if (parent) { parent.children[parent.children.indexOf(this)] = next; next.parentElement = parent; this.parentElement = null; } }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() { doc.activeElement = this; }
  }
  doc.createElement = tag => new Element(tag);
  const parent = doc.createElement('div'), label = doc.createElement('label'), input = doc.createElement('input');
  parent.append(label); label.append(input);
  return { doc, parent, label, input };
}

test('default comparison is typed, tolerant of floating representation and quaternion sign', () => {
  assert.equal(settingValuesEqual(.1 + .2, .3), true);
  assert.equal(settingValuesEqual(.301, .3), false);
  assert.equal(settingValuesEqual('4', 4), false);
  assert.equal(settingValuesEqual(null, false), false);
  assert.equal(settingValuesEqual([1, true], [1, false]), false);
  assert.equal(settingValuesEqual(canonicalOrientation([0, 0, 0, -2]), canonicalOrientation()), true);
  assert.throws(() => canonicalOrientation([0, 0, 0, 0]));
});

test('reset sits outside labels, restores typed defaults once and transfers focus before disappearing', () => {
  const { doc, label, input } = dom();
  let value = false, resetCount = 0;
  const registry = createSettingResets({ document: doc });
  const entry = registry.bind({ key: 'flag', name: 'flag', input, getValue: () => value, getDefault: () => true,
    reset: next => { value = next; resetCount++; } });
  assert.notEqual(entry.button.parentElement, label);
  assert.equal(entry.button.disabled, false);
  entry.button.focus(); entry.button.dispatchEvent(new Event('click', { cancelable: true }));
  assert.equal(value, true); assert.equal(resetCount, 1);
  assert.equal(entry.button.style.visibility, 'hidden'); assert.equal(doc.activeElement, input);
  assert.equal(entry.button.attributes['aria-label'], 'Reset flag to default');
});

test('invalid drafts expose recovery and passive updates never invoke reset or submit behavior', () => {
  const { doc, input } = dom(); let draft = '', resets = 0;
  const registry = createSettingResets({ document: doc });
  const entry = registry.bind({ key: 'rate', name: 'rate', input,
    getValue() { if (!draft.trim() || !Number.isFinite(Number(draft))) throw new Error('Invalid'); return Number(draft); },
    getDefault: () => 100, reset(value) { draft = String(value); resets++; } });
  assert.equal(entry.button.style.visibility, 'visible');
  for (let i = 0; i < 50; i++) registry.update(); assert.equal(resets, 0);
  entry.button.dispatchEvent(new Event('click', { cancelable: true })); assert.equal(draft, '100'); assert.equal(resets, 1);
  input.disabled = true; draft = '200'; registry.update(); assert.equal(entry.button.disabled, true); assert.equal(entry.button.style.visibility, 'hidden');
});

test('disposing settings controls unwraps hosts and removes obsolete edit/reset listeners', () => {
  const { doc, parent, label, input } = dom(); let reads = 0, resets = 0;
  const registry = createSettingResets({ document: doc });
  const bind = () => registry.bind({ key: 'rate', name: 'rate', input, getValue: () => { reads++; return 2; }, getDefault: () => 1, reset: () => resets++ });
  const old = bind(); registry.clear(); assert.equal(registry.entries.length, 0); assert.equal(parent.children[0], label);
  reads = 0; input.dispatchEvent(new Event('input')); old.button.dispatchEvent(new Event('click')); assert.equal(reads, 0); assert.equal(resets, 0);
  bind(); reads = 0; input.dispatchEvent(new Event('input')); assert.equal(reads, 1);
  registry.forget('settings'); assert.equal(parent.children[0], label); assert.equal(registry.entries.length, 0);
});
