import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, PerspectiveCamera } from 'three';
import { targetWorldOffset, targetWorldPosition, normalizeQuaternion, taskGizmoShortcut, setupTargetGizmo } from './target-gizmo.js';

test('world-axis dragging converts using the authoritative full-root target, without torso guesses', () => {
  const base=[.35,-.22,.95];
  const offset=[.04,-.01,.02];
  assert.deepEqual(targetWorldPosition(base,offset),[.38999999999999996,-.23,.97]);
  const requested=[.45,-.17,1.05];
  const actual=targetWorldPosition(base,targetWorldOffset(base,requested));
  actual.forEach((value,i)=>assert(Math.abs(value-requested[i])<1e-12));
});

test('drag targets respect the API offset range and reject invalid coordinates', () => {
  assert.deepEqual(targetWorldOffset([.3,-.2,1],[3,-3,1.4]),[1,-1,.3999999999999999]);
  assert.equal(targetWorldOffset([0,0,0],[NaN,1,2]),null);
  assert.equal(targetWorldOffset([0,0,0],[1,2]),null);
});


test('task shortcuts offer the target\'s own tools without stealing typing', () => {
  const figure8 = ['translate', 'rotate', 'scale'], reach = ['translate'], goal = ['translate', 'rotate'];
  assert.equal(taskGizmoShortcut({key: 'G'}, reach), 'translate');
  assert.equal(taskGizmoShortcut({key: 'T'}, reach), 'translate');
  assert.equal(taskGizmoShortcut({key: 'R'}, figure8), 'rotate');
  assert.equal(taskGizmoShortcut({key: 's'}, figure8), 'scale');
  assert.equal(taskGizmoShortcut({key: 'Escape'}, figure8), 'deselect');
  assert.equal(taskGizmoShortcut({key: 's'}, reach), null);
  assert.equal(taskGizmoShortcut({key: 'r'}, reach), null);  // position only: nothing to rotate
  assert.equal(taskGizmoShortcut({key: 'r'}, goal), 'rotate');  // a reach with an orientation goal
  assert.equal(taskGizmoShortcut({key: 's'}, goal), null);
  assert.equal(taskGizmoShortcut({key: 't'}), 'translate');
  for (const tagName of ['INPUT', 'SELECT', 'TEXTAREA']) assert.equal(taskGizmoShortcut({key: 's', target: {tagName}}, figure8), null);
  for (const tagName of ['INPUT', 'SELECT', 'TEXTAREA']) assert.equal(taskGizmoShortcut({key: 't', target: {tagName}}, figure8), null);
  assert.equal(taskGizmoShortcut({key: 'r', target: {isContentEditable: true}}, figure8), null);
  assert.equal(taskGizmoShortcut({key: 's', ctrlKey: true}, figure8), null);
});

test('rotation normalization rejects malformed transforms and preserves unit orientation', () => {
  assert.deepEqual(normalizeQuaternion([0, 0, 0, 2]), [0, 0, 0, 1]);
  const q = normalizeQuaternion([1, 2, 3, 4]);
  assert(Math.abs(Math.hypot(...q) - 1) < 1e-15);
  for (const bad of [null, [], [0, 0, 0, 0], [NaN, 0, 0, 1], [1e308, 1e308, 1e308, 1e308]]) assert.equal(normalizeQuaternion(bad), null);
});


test('real TransformControls preserve scale drag baseline and restore orbit on deselection', () => {
  const original = globalThis.document;
  const listeners = new Map();
  globalThis.document = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const canvas = { style: {}, addEventListener() {}, removeEventListener() {}, hasPointerCapture: () => false,
    getBoundingClientRect: () => ({left: 0, top: 0, width: 800, height: 600}) };
  const scene = new Scene(), camera = new PerspectiveCamera(), orbit = {enabled: true};
  let target = { available: true, kind: 'figure8', tools: ['translate', 'rotate', 'scale'], rotation_space: 'world',
    position_world: [.4, -.3, 1.2], quaternion_xyzw: [0, 0, 0, 1], size_m: [.24, .16] };
  const requests = [];
  let selections = 0;
  const gizmo = setupTargetGizmo({ scene, camera, renderer: {domElement: canvas}, orbit, getTarget: () => target,
    onSelect: () => selections++, moveTarget: p => p, transformTarget: pose => { requests.push(pose); target = {...target, ...pose}; return target; } });
  const control = scene.children.find(child => child.isTransformControlsRoot).controls;
  const press = key => listeners.get('keydown')({key, preventDefault() {}});
  try {
    press('s'); assert.equal(control.mode, 'scale'); assert.equal(control.space, 'local'); assert.equal(control.showZ, false);
    assert.equal(selections, 1);
    control.dragging = true; assert.equal(orbit.enabled, false);
    assert.equal(gizmo.interactionActive, true);
    control.object.scale.set(2, 1, 1); control.dispatchEvent({type: 'objectChange'});
    assert.deepEqual(requests.at(-1).size_m, [.48, .16]);
    gizmo.update(); control.object.scale.set(3, 2, 1); control.dispatchEvent({type: 'objectChange'});
    assert.deepEqual(requests.at(-1).size_m, [.72, .32]); // Relative to drag start, never compounded.
    const pivot = control.object.position.toArray();
    target = {...target, position_world: [9, 9, 9]}; gizmo.update();
    assert.deepEqual(control.object.position.toArray(), pivot); // Server updates cannot move an active drag.
    press('Escape'); assert.equal(control.object, undefined); assert.equal(orbit.enabled, true);
    press('r'); assert.equal(control.mode, 'rotate'); assert.equal(control.space, 'world'); assert.equal(control.showZ, true);
    press('t'); assert.equal(control.mode, 'translate');
    press('g'); assert.equal(control.mode, 'translate');
    assert.equal(selections, 4);
    gizmo.deselect(); assert.equal(control.object, undefined); assert.equal(gizmo.interactionActive, false);
    assert.equal(selections, 4); // Deselect never steals selection back.
  } finally {
    gizmo.dispose();
    if (original === undefined) delete globalThis.document; else globalThis.document = original;
  }
});


test('a reach with an orientation goal rotates the goal about its own axes and returns to translation without one', () => {
  const original = globalThis.document;
  const listeners = new Map();
  globalThis.document = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const canvas = { style: {}, addEventListener() {}, removeEventListener() {}, hasPointerCapture: () => false,
    getBoundingClientRect: () => ({left: 0, top: 0, width: 800, height: 600}) };
  const scene = new Scene(), camera = new PerspectiveCamera(), orbit = {enabled: true};
  const goal = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  let target = { available: true, kind: 'reach', tools: ['translate', 'rotate'], rotation_space: 'local',
    position_world: [.5, -.2, 1], quaternion_xyzw: goal, size_m: null };
  const requests = [];
  const gizmo = setupTargetGizmo({ scene, camera, renderer: {domElement: canvas}, orbit, getTarget: () => target,
    moveTarget: p => p, transformTarget: pose => { requests.push(pose); return pose; } });
  const control = scene.children.find(child => child.isTransformControlsRoot).controls;
  const press = key => listeners.get('keydown')({key, preventDefault() {}});
  try {
    press('s'); assert.equal(control.object, undefined);  // no scaling for a reach
    press('r'); assert.equal(control.mode, 'rotate'); assert.equal(control.space, 'local');
    control.object.quaternion.toArray().forEach((value, i) => assert(Math.abs(value - goal[i]) < 1e-12));
    control.object.quaternion.set(0, 0, Math.sin(.25), Math.cos(.25)); control.dispatchEvent({type: 'objectChange'});
    assert.deepEqual(requests.at(-1), { quaternion_xyzw: [0, 0, Math.sin(.25), Math.cos(.25)] });
    target = { ...target, tools: ['translate'], quaternion_xyzw: [0, 0, 0, 1] }; gizmo.update();
    assert.equal(control.mode, 'translate'); assert.equal(control.space, 'world');  // the goal was switched off
  } finally {
    gizmo.dispose();
    if (original === undefined) delete globalThis.document; else globalThis.document = original;
  }
});

// Felix's camera bug (2026-10-30): OrbitControls starts its own gesture at the press, so
// re-enabling it while that button is still held swings the camera with the pointer.
test('a task drag that ends while the button is still held keeps the camera locked until the release', () => {
  const original = globalThis.document;
  const documentListeners = [], canvasListeners = [];
  globalThis.document = { addEventListener: (name, fn, capture) => documentListeners.push({ name, fn, capture }),
    removeEventListener: (name, fn) => { const i = documentListeners.findIndex(item => item.name === name && item.fn === fn); if (i >= 0) documentListeners.splice(i, 1); } };
  const canvas = { style: {}, ownerDocument: globalThis.document, hasPointerCapture: () => false, setPointerCapture() {}, releasePointerCapture() {},
    addEventListener: (name, fn, capture) => canvasListeners.push({ name, fn, capture }), removeEventListener() {},
    getBoundingClientRect: () => ({left: 0, top: 0, width: 800, height: 600}) };
  const emit = (listeners, name, event) => listeners.filter(item => item.name === name && item.capture).forEach(item => item.fn(event));
  const scene = new Scene(), camera = new PerspectiveCamera(), orbit = {enabled: true};
  let target = { available: true, kind: 'reach', tools: ['translate'], position_world: [.5, -.2, 1], quaternion_xyzw: [0, 0, 0, 1] };
  const gizmo = setupTargetGizmo({ scene, camera, renderer: {domElement: canvas}, orbit, getTarget: () => target, moveTarget: p => p });
  const control = scene.children.find(child => child.isTransformControlsRoot).controls;
  try {
    documentListeners.find(item => item.name === 'keydown').fn({ key: 't', preventDefault() {} });
    emit(canvasListeners, 'pointerdown', { pointerId: 7, button: 0, isPrimary: true, clientX: 400, clientY: 300 });
    control.dragging = true; assert.equal(orbit.enabled, false);
    target = { ...target, available: false }; gizmo.update();  // e.g. Live turns gpu_busy mid-drag
    assert.equal(control.dragging, false);
    assert.equal(orbit.enabled, false, 'orbit came back while the button was still held');
    emit(documentListeners, 'pointerup', { pointerId: 7, button: 0 });
    assert.equal(orbit.enabled, true);
  } finally {
    gizmo.dispose();
    if (original === undefined) delete globalThis.document; else globalThis.document = original;
  }
});
