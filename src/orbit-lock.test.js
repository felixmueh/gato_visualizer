import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrbitLock } from './orbit-lock.js';

function fixture() {
  const element = { listeners: [], addEventListener(name, fn, capture) { this.listeners.push({ name, fn, capture }); },
    removeEventListener(name, fn) { this.listeners = this.listeners.filter(item => item.fn !== fn); } };
  const document = { listeners: [], addEventListener: element.addEventListener, removeEventListener: element.removeEventListener };
  element.ownerDocument = document;
  const orbit = { enabled: true };
  const emit = (target, name, event) => target.listeners.filter(item => item.name === name).forEach(item => item.fn(event));
  return { element, document, orbit, lock: createOrbitLock(orbit, element), emit };
}

test('a press on a gizmo handle disables orbit before OrbitControls sees it, until the release', () => {
  const { element, document, orbit, lock, emit } = fixture();
  let overHandle = false;
  lock.addGuard(() => overHandle);
  emit(element, 'pointerdown', { pointerId: 1, button: 0, isPrimary: true });
  assert.equal(orbit.enabled, true);  // empty space: the camera orbits as usual
  emit(document, 'pointerup', { pointerId: 1, button: 0 });
  overHandle = true;
  emit(element, 'pointerdown', { pointerId: 2, button: 0, isPrimary: true });
  assert.equal(orbit.enabled, false);  // the capture listener runs before OrbitControls' own
  emit(document, 'pointerup', { pointerId: 2, button: 0 });
  assert.equal(orbit.enabled, true);
  assert.ok(element.listeners.find(item => item.name === 'pointerdown').capture);
});

test('two tools hold and release independently, and orbit returns only once both and the press are done', () => {
  const { element, document, orbit, lock, emit } = fixture();
  emit(element, 'pointerdown', { pointerId: 3, button: 0, isPrimary: true });
  lock.hold('task-gizmo'); lock.hold('joint-editor');
  lock.release('task-gizmo'); assert.equal(orbit.enabled, false);
  lock.release('joint-editor'); assert.equal(orbit.enabled, false);  // the button is still held
  emit(document, 'pointerup', { pointerId: 3, button: 0 }); assert.equal(orbit.enabled, true);
  lock.hold('x'); lock.release('x'); assert.equal(orbit.enabled, true);  // no press: back at once
});

test('orbit keeps a disabled state it found, and a missed release cannot leave it locked', () => {
  const { element, orbit, lock, emit } = fixture();
  orbit.enabled = false; lock.hold('task-gizmo'); lock.release('task-gizmo'); assert.equal(orbit.enabled, false);
  orbit.enabled = true;
  emit(element, 'pointerdown', { pointerId: 4, button: 0, isPrimary: true }); lock.hold('joint-editor'); lock.release('joint-editor');
  assert.equal(orbit.enabled, false);
  emit(element, 'pointermove', { pointerId: 4, buttons: 0 });  // the release happened where no listener saw it
  assert.equal(orbit.enabled, true);
  emit(element, 'pointerdown', { pointerId: 5, button: 2, isPrimary: true }); lock.hold('a'); lock.release('a');
  assert.equal(orbit.enabled, true);  // only the primary button counts as a held gizmo press
  lock.dispose(); assert.equal(element.listeners.length, 0);
});
