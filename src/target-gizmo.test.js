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


test('task shortcuts support world movement and figure-eight rotation and scaling without stealing typing', () => {
  assert.equal(taskGizmoShortcut({key: 'G'}, 'reach'), 'translate');
  assert.equal(taskGizmoShortcut({key: 'T'}, 'reach'), 'translate');
  assert.equal(taskGizmoShortcut({key: 'R'}, 'figure8'), 'rotate');
  assert.equal(taskGizmoShortcut({key: 's'}, 'figure8'), 'scale');
  assert.equal(taskGizmoShortcut({key: 'Escape'}, 'figure8'), 'deselect');
  assert.equal(taskGizmoShortcut({key: 's'}, 'reach'), null);
  for (const tagName of ['INPUT', 'SELECT', 'TEXTAREA']) assert.equal(taskGizmoShortcut({key: 's', target: {tagName}}, 'figure8'), null);
  for (const tagName of ['INPUT', 'SELECT', 'TEXTAREA']) assert.equal(taskGizmoShortcut({key: 't', target: {tagName}}, 'figure8'), null);
  assert.equal(taskGizmoShortcut({key: 'r', target: {isContentEditable: true}}, 'figure8'), null);
  assert.equal(taskGizmoShortcut({key: 's', ctrlKey: true}, 'figure8'), null);
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
  let target = { available: true, kind: 'figure8', position_world: [.4, -.3, 1.2], quaternion_xyzw: [0, 0, 0, 1], size_m: [.24, .16] };
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
