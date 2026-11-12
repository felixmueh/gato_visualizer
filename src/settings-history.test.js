import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsHistory, historyShortcut } from './settings-history.js';
import { settingValuesEqual } from './setting-resets.js';

const doc = (q, offset = 0) => ({ config: { solver: { q_cost: q } }, task: { kind: 'reach', target_offset_m: [offset, 0, 0] }, execution: {}, source_settings: {} });

test('one entry per accepted version; undone documents come back without new entries', () => {
  const history = createSettingsHistory({ equal: settingValuesEqual });
  history.accept(1, doc(4)); history.accept(2, doc(5)); history.accept(3, doc(5, .1));
  assert.deepEqual(history.snapshot, { undo: 2, redo: 0, versions: [1, 2, 3], cursor: 2 });
  assert.deepEqual(history.undo(), doc(5));
  history.accept(4, doc(5));  // the undo, accepted as a new version
  assert.deepEqual(history.snapshot, { undo: 1, redo: 1, versions: [1, 4, 3], cursor: 1 });
  assert.deepEqual(history.undo(), doc(4)); history.accept(5, doc(4));
  assert.equal(history.undo(), null);
  assert.deepEqual(history.redo(), doc(5)); history.accept(6, doc(5));
  assert.deepEqual(history.snapshot.cursor, 1);
  // The same version again (a presentation-only change) replaces its document.
  history.accept(6, { ...doc(5), execution: { continue_at_end: true } });
  assert.deepEqual(history.snapshot.versions, [5, 6, 3]);
  // A new edit, from anyone, drops what was undone.
  history.accept(7, doc(9)); assert.deepEqual(history.snapshot, { undo: 2, redo: 0, versions: [5, 6, 7], cursor: 2 });
  assert.equal(history.redo(), null);
});

test('a different document arriving before the undone one is a new edit', () => {
  const history = createSettingsHistory({ equal: settingValuesEqual });
  history.accept(1, doc(1)); history.accept(2, doc(2));
  history.undo(); history.accept(3, doc(7));  // another viewer was first
  history.accept(4, doc(1));                  // then the undone document: an ordinary edit now
  assert.deepEqual(history.snapshot, { undo: 3, redo: 0, versions: [1, 2, 3, 4], cursor: 3 });
  const bounded = createSettingsHistory({ equal: settingValuesEqual, limit: 3 });
  for (let version = 1; version <= 5; version++) bounded.accept(version, doc(version));
  assert.deepEqual(bounded.snapshot.versions, [3, 4, 5]);
});

test('history keys stay out of text fields', () => {
  const key = (key, extra = {}) => historyShortcut({ key, ctrlKey: true, target: { tagName: 'CANVAS' }, ...extra });
  assert.equal(key('z'), 'undo'); assert.equal(key('Z', { shiftKey: true }), 'redo'); assert.equal(key('y'), 'redo');
  assert.equal(key('z', { ctrlKey: false, metaKey: true }), 'undo');
  assert.equal(key('z', { ctrlKey: false }), null); assert.equal(key('c'), null);
  assert.equal(key('z', { target: { tagName: 'INPUT' } }), null); assert.equal(key('z', { target: { isContentEditable: true } }), null);
});


test('returning to an unchanged task retains its undo and redo cursor', () => {
  const history = createSettingsHistory({ equal: settingValuesEqual });
  history.accept(1, doc(1)); history.accept(2, doc(2));
  history.undo(); history.accept(3, doc(1));
  history.accept(7, doc(1), { coalesce: true });
  assert.deepEqual(history.snapshot, { undo: 0, redo: 1, versions: [7, 2], cursor: 0 });
  assert.deepEqual(history.redo(), doc(2));
  history.accept(8, doc(2));
  history.accept(10, doc(9), { coalesce: true });
  assert.deepEqual(history.snapshot, { undo: 2, redo: 0, versions: [7, 8, 10], cursor: 2 });
});
