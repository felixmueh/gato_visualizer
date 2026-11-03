import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Group, Mesh, MeshPhongMaterial, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { armChain, forwardKinematics } from './arm-kinematics.js';
import { classifyJointHit, committedPose, graspToolShortcut, isJointClick, ORIENTATION_GAP_THRESHOLD, ringAngleToJoint, setupJointEditor,
  TETHER_THRESHOLD } from './joint-editor.js';
import { relativeRotvec } from './rotations.js';

test('joint clicks use the same four-pixel threshold as ghost seeking', () => {
  const press = { id: 1, x: 40, y: 50 };
  assert.equal(isJointClick(press, { pointerId: 1, clientX: 43, clientY: 50 }), true);
  assert.equal(isJointClick(press, { pointerId: 1, clientX: 44, clientY: 50 }), false);
  assert.equal(isJointClick({ ...press, dragged: true }, { pointerId: 1, clientX: 40, clientY: 50 }), false);
  assert.equal(isJointClick(press, { pointerId: 2, clientX: 40, clientY: 50 }), false);
});

test('ring angle keeps native negative joint 6 and supports more than one half-turn', () => {
  assert.equal(ringAngleToJoint(.2, .5, -1, -2, 2), -.3);
  assert.equal(ringAngleToJoint(-2.6, 5.2, 1, -2.6, 2.6), 2.6);
  assert.equal(ringAngleToJoint(0, 20, 1, -2, 2), 2);
  assert.equal(ringAngleToJoint(0, 20, -1, -2, 2), -2);
  assert.throws(() => ringAngleToJoint(0, NaN, 1, -2, 2), /finite/);
});

test('one release rounds then clamps; unmoved or malformed drafts make no change', () => {
  assert.equal(committedPose([1e-6, 0], [0, 0], [-1, -1], [1, 1]), null);
  assert.deepEqual(committedPose([.123456789, 1.2345678], [0, 0], [-1, -1], [1, 1.2345678]), [.123457, 1.2345678]);
  assert.equal(committedPose([NaN, 0], [0, 0], [-1, -1], [1, 1]), null);
});

test('solid link maps to its joint while every gripper descendant selects the grasp handle', () => {
  const linkMesh = new Group(), gripperRoot = new Group(), gripperLink = new Group(), gripperMesh = new Group();
  gripperRoot.add(gripperLink); gripperLink.add(gripperMesh);
  const links = [{ meshes: [linkMesh] }, { meshes: [gripperMesh] }];
  assert.deepEqual(classifyJointHit(linkMesh, links, gripperRoot), { mode: 'ring', joint: 0 });
  assert.deepEqual(classifyJointHit(gripperMesh, links, gripperRoot), { mode: 'grasp', joint: null });
  assert.equal(classifyJointHit(new Group(), links, gripperRoot), null);
});

function editorFixture({ taskGizmo } = {}) {
  const originalDocument = globalThis.document;
  const documentListeners = new Map();
  globalThis.document = { pointerLockElement: null,
    addEventListener(name, fn) { const list = documentListeners.get(name) || []; list.push(fn); documentListeners.set(name, list); },
    removeEventListener(name, fn) { documentListeners.set(name, (documentListeners.get(name) || []).filter(value => value !== fn)); } };
  const listeners = new Map(), captured = new Set();
  const canvas = { style: {}, ownerDocument: globalThis.document,
    addEventListener(name, fn, capture = false) { const list = listeners.get(name) || []; list.push({ fn, capture }); listeners.set(name, list); },
    removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter(item => item.fn !== fn)); },
    hasPointerCapture: id => captured.has(id), setPointerCapture: id => captured.add(id), releasePointerCapture: id => captured.delete(id),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 700 }) };
  const scene = new Scene(), robot = new Group(); robot.joints = {}; robot.links = {};
  const base = new Group(); base.isURDFLink = true; robot.add(base);
  const jointNames = [], links = [], meshes = [];
  let parent = base;
  for (let i = 0; i < 7; i++) {
    const name = `arm_right_${i + 1}_joint`, joint = new Group();
    joint.isURDFJoint = true; joint.jointType = 'revolute'; joint.axis = new Vector3(0, 0, i === 5 ? -1 : 1);
    joint.origPosition = new Vector3(i ? .17 : 0, 0, i === 3 ? .12 : 0); joint.position.copy(joint.origPosition);
    joint.origQuaternion = new Quaternion(); parent.add(joint); robot.joints[name] = joint; jointNames.push(name);
    const link = new Group(); link.isURDFLink = true; joint.add(link); parent = link;
    const mesh = new Mesh(new BoxGeometry(.1, .07, .07), new MeshPhongMaterial()); mesh.position.x = .06; link.add(mesh);
    meshes.push(mesh); links.push({ name, meshes: [mesh] });
  }
  const tool = new Group(); tool.isURDFJoint = true; tool.jointType = 'fixed'; tool.origPosition = new Vector3(.17, 0, 0);
  tool.origQuaternion = new Quaternion(); tool.position.copy(tool.origPosition); parent.add(tool); robot.joints.arm_right_tool_joint = tool;
  const toolLink = new Group(); toolLink.isURDFLink = true; tool.add(toolLink); robot.links.tool = toolLink;
  robot.setJointValue = (name, q) => { const joint = robot.joints[name]; joint.quaternion.copy(joint.origQuaternion).multiply(new Quaternion().setFromAxisAngle(joint.axis, q)); };
  scene.add(robot);
  const camera = new PerspectiveCamera(37, 1000 / 700, .01, 100); camera.up.set(0, 0, 1); camera.position.set(1.8, -2.6, 2);
  camera.lookAt(.5, 0, 0); camera.updateMatrixWorld();
  const initial = [0, .2, -.1, .4, 0, .3, .2];
  jointNames.forEach((name, i) => robot.setJointValue(name, initial[i])); robot.updateMatrixWorld(true);
  const endEffector = { frame: 'grasp', parent_link: 'tool', xyz: [.1, 0, 0], rpy: [0, 0, 0] };
  const chain = armChain(robot, { jointNames, grasp: endEffector });
  const reference = { q: initial.slice(), world: forwardKinematics(chain, base.matrixWorld, initial).grasp, frame: 'grasp', generation: 1 };
  const spec = { available: true, locked: false, lower: Array(7).fill(-2), upper: Array(7).fill(2),
    planning: { lower: Array(7).fill(-1.9), upper: Array(7).fill(1.9) }, endEffector, reference };
  let settings = initial.slice(), draft, ghost;
  const commits = [], previews = [], orbit = { enabled: true }, badge = {}, gapLabel = { hidden: true, textContent: '', style: {} }, hint = { hidden: true, textContent: '' };
  const getPose = () => spec.unavailable ? null : ({ ...spec, value: (draft || settings).slice() });
  const editor = setupJointEditor({ scene, camera, renderer: { domElement: canvas }, orbit, robot, jointNames, links,
    getPose, previewPose(q) { draft = q?.slice(); previews.push(q?.slice() || null); },
    commitPose(q) { commits.push(q.slice()); settings = q.slice(); draft = null; return true; },
    getGhostHit: () => ghost, guardBadge: badge, gapLabel, hint, taskGizmo });
  const controls = () => scene.children.filter(child => child.isTransformControlsRoot).map(child => child.controls);
  function emit(name, coordinates, extra = {}) {
    const [clientX, clientY] = coordinates || [0, 0];
    let stopped = false;
    const event = { pointerId: 1, button: 0, pointerType: 'mouse', clientX, clientY, buttons: name === 'pointerdown' ? 1 : 0,
      preventDefault() {}, stopImmediatePropagation() { stopped = true; }, ...extra };
    // As in a browser, a pointer event on the canvas passes the document's capture listeners first.
    if (name.startsWith('pointer')) for (const fn of documentListeners.get(name) || []) fn(event);
    const registrations = [...(listeners.get(name) || [])].sort((a, b) => Number(b.capture) - Number(a.capture));
    for (const { fn } of registrations) { fn(event); if (stopped) break; }
    return event;
  }
  function projectObject(object) {
    const point = object.getWorldPosition(new Vector3()).project(camera); return [(point.x + 1) * 500, (1 - point.y) * 350];
  }
  function selectJoint(index) {
    const point = projectObject(meshes[index]); emit('pointerdown', point); const event = emit('pointerup', point); editor.update();
    assert.equal(editor.snapshot.mode, 'ring'); assert.equal(editor.snapshot.joint, index);
    return event;
  }
  function startControl(control) { control.axis = control === controls()[0] ? 'Z' : 'X'; control.dragging = true; control.dispatchEvent({ type: 'mouseDown' }); }
  function releaseControl(control) { control.pointerUp(null); editor.update(); }
  function press(key, type = 'keydown') { for (const fn of documentListeners.get(type) || []) fn({ key, type, preventDefault() {} }); editor.update(); }
  const escape = () => press('Escape');
  function documentEmit(name, event) { for (const fn of documentListeners.get(name) || []) fn(event); }
  function selectGrasp() {
    const point = editor.snapshot.grasp_screen; emit('pointerdown', point); emit('pointerup', point); editor.update();
    assert.equal(editor.snapshot.mode, 'grasp');
    return controls()[1];
  }
  return { scene, robot, controls, editor, spec, commits, previews, orbit, badge, gapLabel, hint, emit, documentEmit, selectJoint, selectGrasp, startControl, releaseControl, escape, press,
    setGhost(value) { ghost = value; },
    close() { editor.dispose(); robot.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
      if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; } };
}

test('a ring drag previews native q and commits once on release; Escape restores without a request', () => {
  const f = editorFixture();
  try {
    f.selectJoint(5);
    const ring = f.controls()[0];
    assert.equal(ring.showX, false); assert.equal(ring.showY, false); assert.equal(ring.showZ, true);
    f.startControl(ring); assert.equal(f.orbit.enabled, false);
    ring.rotationAngle = .5; ring.dispatchEvent({ type: 'objectChange' }); f.editor.update();
    assert.equal(f.commits.length, 0); assert.equal(f.editor.snapshot.q_draft[5], -.2);
    f.releaseControl(ring);
    assert.equal(f.commits.length, 1); assert(Math.abs(f.commits[0][5] + .2) < 1e-12); assert.equal(f.orbit.enabled, true);
    f.startControl(ring); ring.rotationAngle = .9; ring.dispatchEvent({ type: 'objectChange' }); f.editor.update();
    f.escape();
    assert.equal(f.commits.length, 1); assert.equal(f.editor.snapshot.dragging, false); assert.equal(f.orbit.enabled, true);
    assert.equal(f.previews.at(-1), null);
  } finally { f.close(); }
});

test('lost capture cancels a draft; losing edit eligibility clears tools without committing', () => {
  const f = editorFixture();
  try {
    f.selectJoint(0); const ring = f.controls()[0];
    f.startControl(ring); ring.rotationAngle = .4; ring.dispatchEvent({ type: 'objectChange' });
    f.emit('lostpointercapture');
    assert.equal(f.commits.length, 0); assert.equal(f.editor.snapshot.dragging, false); assert.equal(f.orbit.enabled, true);
    f.startControl(ring); ring.rotationAngle = .6; ring.dispatchEvent({ type: 'objectChange' });
    f.spec.available = false; f.editor.update();
    assert.equal(f.commits.length, 0); assert.equal(f.editor.snapshot.mode, 'none'); assert.equal(f.editor.ownsPose, false);
    assert.equal(f.orbit.enabled, true); assert.equal(ring.getHelper().visible, false);
  } finally { f.close(); }
});

test('grasp IK runs only on animation updates, shows reach gap and snaps on release', () => {
  const f = editorFixture();
  try {
    const point = f.editor.snapshot.grasp_screen;
    f.emit('pointerdown', point); f.emit('pointerup', point); f.editor.update();
    assert.equal(f.editor.snapshot.mode, 'grasp');
    const grasp = f.controls()[1]; f.startControl(grasp);
    grasp.object.position.x += 2; grasp.dispatchEvent({ type: 'objectChange' });
    assert.equal(f.previews.length, 0); assert.equal(f.commits.length, 0);
    f.editor.update(); assert(f.editor.snapshot.gap_m > .002);
    assert.equal(f.scene.getObjectByName('grasp-tether').visible, true);
    assert(f.editor.snapshot.q_draft.every((value, i) => value >= f.spec.planning.lower[i] && value <= f.spec.planning.upper[i]));
    f.releaseControl(grasp);
    assert.equal(f.commits.length, 1); assert.equal(f.editor.snapshot.gap_m, 0);
    assert.equal(f.scene.getObjectByName('grasp-tether').visible, false);
    const { target_world, achieved_world } = f.editor.snapshot;
    assert(Math.hypot(...target_world.map((v, i) => v - achieved_world[i])) < 1e-12);
  } finally { f.close(); }
});

test('guard disables grasp for mismatched recorded FK without hiding joint rings', () => {
  const f = editorFixture();
  try {
    assert(f.editor.snapshot.fk_guard_m < 1e-12); assert.equal(f.badge.hidden, true);
    f.spec.reference = { ...f.spec.reference, world: [9, 9, 9] }; f.editor.update();
    assert(f.editor.snapshot.fk_guard_m > 1); assert.equal(f.badge.hidden, false); assert.match(f.badge.title, /FK differs/);
    assert.equal(f.scene.getObjectByName('grasp-handle-anchor').visible, false);
    f.selectJoint(0); assert.equal(f.editor.snapshot.mode, 'ring');
    f.spec.reference = { ...f.spec.reference, frame: 'other' }; f.editor.update();
    assert.match(f.editor.snapshot.guard_reason, /frame differs/);
  } finally { f.close(); }
});

test('nearer ghosts keep click-to-seek; solid clicks are marked while camera orbit still receives pointerup', () => {
  const f = editorFixture();
  try {
    const solidEvent = f.selectJoint(0); assert.equal(solidEvent.jointEditHandled, true); f.editor.deselect();
    // The torso-like source mesh is visible and in front of a distant ghost.
    const ringPoint = [f.editor.snapshot.ring_screen[0], f.editor.snapshot.ring_screen[1]];
    f.setGhost({ distance: .01 });
    f.emit('pointerdown', ringPoint); const ghostEvent = f.emit('pointerup', ringPoint);
    assert.equal(ghostEvent.jointEditHandled, undefined); assert.equal(f.editor.snapshot.mode, 'none');
    f.setGhost(null); f.selectJoint(0);
    f.spec.available = false; f.editor.update();
    assert.equal(f.editor.ownsPose, false); assert.equal(f.editor.snapshot.mode, 'none');
  } finally { f.close(); }
});

test('a replacement Live generation cancels the current draft instead of overwriting a remote edit', () => {
  const f = editorFixture();
  try {
    f.selectJoint(0); const ring = f.controls()[0];
    f.startControl(ring); ring.rotationAngle = .3; ring.dispatchEvent({ type: 'objectChange' }); f.editor.update();
    f.spec.reference = { ...f.spec.reference, generation: 2 }; f.editor.update();
    assert.equal(f.commits.length, 0); assert.equal(f.editor.snapshot.dragging, false);
    assert.equal(f.previews.at(-1), null); assert.equal(f.orbit.enabled, true);
  } finally { f.close(); }
});

test('Replay or an unavailable Live source leaves a readable inactive editor snapshot', () => {
  const f = editorFixture();
  try {
    assert(f.editor.snapshot.achieved_world);
    f.spec.unavailable = true; f.editor.update();
    assert.equal(f.editor.snapshot.available, false);
    assert.equal(f.editor.snapshot.mode, 'none');
    assert.equal(f.editor.snapshot.achieved_world, null);
    assert.equal(f.editor.ownsPose, false);
  } finally { f.close(); }
});

test('the sidebar lock does not prevent viewport selection or cancel a joint drag', () => {
  const f = editorFixture();
  try {
    f.spec.locked = true; f.editor.update();
    assert.equal(f.editor.ownsPose, true);
    f.selectJoint(0); const ring = f.controls()[0];
    f.startControl(ring); ring.rotationAngle = .25; ring.dispatchEvent({ type: 'objectChange' });
    f.spec.locked = false; f.editor.update();
    f.spec.locked = true; f.editor.update();
    assert.equal(f.editor.dragging, true);
    assert.equal(f.editor.snapshot.mode, 'ring');
    assert.equal(f.commits.length, 0);
    f.releaseControl(ring);
    assert.equal(f.commits.length, 1);
    assert.equal(f.commits[0][0], .25);
  } finally { f.close(); }
});


const angleBetween = (a, b) => Math.hypot(...relativeRotvec(a, b));
// Animation frames until the IK settles; the first one always solves the new request.
function settle(f, frames = 30) {
  for (let frame = 0; frame < frames; frame++) {
    f.editor.update();
    if (f.editor.snapshot.converged || f.editor.snapshot.stalled) break;
  }
  return f.editor.snapshot;
}

test('grasp tool keys: T or G translates, R rotates, Escape cancels; typing is ignored', () => {
  assert.equal(graspToolShortcut({ key: 'r' }), 'rotate');
  assert.equal(graspToolShortcut({ key: 'T' }), 'translate'); assert.equal(graspToolShortcut({ key: 'g' }), 'translate');
  assert.equal(graspToolShortcut({ key: 'Escape' }), 'deselect');
  assert.equal(graspToolShortcut({ key: 's' }), null);
  assert.equal(graspToolShortcut({ key: 'r', target: { tagName: 'INPUT' } }), null);
});

test('R rotates the selected grasp handle in its own axes and holds the grasp point; T returns to world translation', () => {
  const f = editorFixture();
  try {
    const grasp = f.selectGrasp();
    assert.equal(f.editor.snapshot.handle_glyph_visible, true);
    const start = f.editor.snapshot.achieved_world, startRotation = f.editor.snapshot.achieved_quaternion;
    assert(angleBetween(f.editor.snapshot.target_quaternion, startRotation) < 1e-12);  // the handle shows the achieved pose
    f.press('r'); assert.equal(grasp.mode, 'rotate'); assert.equal(grasp.space, 'local'); assert.equal(f.editor.snapshot.grasp_tool, 'rotate');
    f.startControl(grasp);
    // This planar test arm turns about z; it reaches 0.2 rad (larger turns end near its stretched singular pose).
    grasp.object.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), .2));
    grasp.dispatchEvent({ type: 'objectChange' });
    const turned = settle(f);
    assert.equal(turned.converged, true, `${turned.gap_m} m, ${turned.orientation_gap_rad} rad`);
    assert(Math.hypot(...turned.achieved_world.map((v, i) => v - start[i])) < 1e-4);  // position held
    assert(Math.abs(angleBetween(turned.achieved_quaternion, startRotation) - .2) < 1e-3);
    assert.equal(turned.achieved_glyph_visible, false); assert.equal(f.gapLabel.hidden, true);
    f.releaseControl(grasp);
    assert.equal(f.commits.length, 1);
    f.press('t'); assert.equal(grasp.mode, 'translate'); assert.equal(grasp.space, 'world');
    f.editor.deselect(); assert.equal(f.editor.snapshot.grasp_tool, 'translate'); assert.equal(f.editor.snapshot.handle_glyph_visible, false);
  } finally { f.close(); }
});

test('a translate drag holds the handle orientation', () => {
  const f = editorFixture();
  try {
    const grasp = f.selectGrasp(), rotation = f.editor.snapshot.target_quaternion;
    f.startControl(grasp);
    grasp.object.position.x -= .05; grasp.object.position.y += .04; grasp.dispatchEvent({ type: 'objectChange' });
    const moved = settle(f);
    assert.equal(moved.converged, true, `${moved.gap_m} m, ${moved.orientation_gap_rad} rad`);
    assert(angleBetween(moved.achieved_quaternion, rotation) < 1e-3);
    assert(moved.q_draft.some((v, i) => Math.abs(v - f.spec.reference.q[i]) > .01));
  } finally { f.close(); }
});

test('an unreachable rotation shows the achieved glyph and the angle readout, then snaps to the achieved pose on release', () => {
  const f = editorFixture();
  try {
    const grasp = f.selectGrasp();
    f.press('r'); f.startControl(grasp);
    // Every joint of this arm turns about z: a tilt about x is out of reach.
    grasp.object.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), .5)); grasp.dispatchEvent({ type: 'objectChange' });
    const stuck = settle(f);
    assert.equal(stuck.converged, false);
    assert(stuck.orientation_gap_rad > ORIENTATION_GAP_THRESHOLD, `${stuck.orientation_gap_rad}`);
    assert.equal(stuck.achieved_glyph_visible, true);
    assert.equal(f.gapLabel.hidden, false); assert.match(f.gapLabel.textContent, /^\d+\.\d°$/);
    assert(Math.abs(parseFloat(f.gapLabel.textContent) - stuck.orientation_gap_rad * 180 / Math.PI) < .06);
    assert(stuck.gap_m < TETHER_THRESHOLD);  // the position is held, so no tether
    assert.equal(f.scene.getObjectByName('grasp-tether').visible, false);
    f.releaseControl(grasp);
    const released = f.editor.snapshot;
    assert.equal(f.gapLabel.hidden, true); assert.equal(released.achieved_glyph_visible, false);
    // The handle now shows the achieved pose, never the unreachable request.
    assert(angleBetween(released.target_quaternion, released.achieved_quaternion) < 1e-9);
    assert(Math.hypot(...released.target_world.map((v, i) => v - released.achieved_world[i])) < 1e-12);
  } finally { f.close(); }
});

test('Escape during a rotate drag restores the start pose without a request', () => {
  const f = editorFixture();
  try {
    const grasp = f.selectGrasp(), before = f.editor.snapshot.target_quaternion;
    f.press('r'); f.startControl(grasp);
    grasp.object.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), .4)); grasp.dispatchEvent({ type: 'objectChange' });
    f.editor.update(); assert(f.previews.length > 0);
    f.escape();
    assert.equal(f.commits.length, 0); assert.equal(f.previews.at(-1), null); assert.equal(f.editor.snapshot.dragging, false);
    assert(angleBetween(f.editor.snapshot.target_quaternion, before) < 1e-9);
  } finally { f.close(); }
});

test('while the grasp handle is selected, the task gizmo leaves R and T to it', () => {
  let guard;
  const taskGizmo = { deselect() {}, setPickGuard() {}, setKeyGuard(fn) { guard = fn; } };
  const f = editorFixture({ taskGizmo });
  try {
    assert.equal(guard(), false);
    f.selectGrasp(); assert.equal(guard(), true);
    f.editor.deselect(); assert.equal(guard(), false);
    f.selectJoint(0); assert.equal(guard(), false);  // a joint ring has no tool keys
    f.press('r'); assert.equal(f.controls()[0].mode, 'rotate'); assert.equal(f.editor.snapshot.mode, 'ring');
  } finally { f.close(); }
});


test('Shift during a translate drag frees the orientation at once; releasing Shift keeps the orientation reached', () => {
  const f = editorFixture();
  try {
    const grasp = f.selectGrasp(), startRotation = f.editor.snapshot.target_quaternion;
    assert.match(f.hint.textContent, /Shift/); assert.equal(f.hint.hidden, false);
    f.startControl(grasp);
    f.press('Shift');  // pressed mid-drag: switches immediately, from the current pose
    assert.equal(f.editor.snapshot.orientation_free, true);
    grasp.object.position.x -= .08; grasp.object.position.y += .12; grasp.dispatchEvent({ type: 'objectChange' });
    const free = settle(f);
    assert.equal(free.converged, true, `${free.gap_m} m`); assert.equal(free.orientation_gap_rad, 0);
    assert(angleBetween(free.achieved_quaternion, startRotation) > .01);  // the arm turned the gripper freely
    assert(angleBetween(free.target_quaternion, free.achieved_quaternion) < 1e-12);  // the handle follows it
    f.press('Shift', 'keyup');
    const held = free.achieved_quaternion;
    assert.equal(f.editor.snapshot.orientation_free, false);
    grasp.object.position.y -= .03; grasp.dispatchEvent({ type: 'objectChange' });
    const after = settle(f);
    assert.equal(after.converged, true); assert(angleBetween(after.achieved_quaternion, held) < 1e-3);  // held again
    // A pointer event's modifier state counts too.
    f.emit('pointermove', [10, 10], { shiftKey: true }); assert.equal(f.editor.snapshot.orientation_free, true);
    f.releaseControl(grasp);
    const released = f.editor.snapshot;
    assert.equal(f.commits.length, 1); assert.equal(released.orientation_free, false);
    assert(angleBetween(released.target_quaternion, released.achieved_quaternion) < 1e-9);  // snapped, orientation included
  } finally { f.close(); }
});

test('Shift changes nothing in a rotate drag, and the hint names the active tool', () => {
  const f = editorFixture();
  try {
    const grasp = f.selectGrasp(); f.press('r');
    assert.match(f.hint.textContent, /turn it about its own axes/);
    f.startControl(grasp); f.press('Shift');
    assert.equal(f.editor.snapshot.orientation_free, false);
    grasp.object.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), .15)); grasp.dispatchEvent({ type: 'objectChange' });
    const turned = settle(f);
    assert.equal(turned.converged, true); assert(turned.orientation_gap_rad < 1e-3);
    f.escape(); f.editor.deselect(); f.editor.update(); assert.equal(f.hint.hidden, true);  // hints follow the frame update
  } finally { f.close(); }
});


// Felix's camera bug (2026-10-30): a drag cancelled while its button is held (Live turning
// gpu_busy, a new generation, lost capture) must not hand the press back to OrbitControls.
test('a grasp drag cancelled while the button is still held keeps orbit off until the release', () => {
  const f = editorFixture();
  try {
    const grasp = f.selectGrasp(), point = f.editor.snapshot.grasp_screen;
    f.emit('pointerdown', point, { isPrimary: true, buttons: 1 });
    f.startControl(grasp); assert.equal(f.orbit.enabled, false);
    grasp.object.position.x += .3; grasp.dispatchEvent({ type: 'objectChange' }); f.editor.update();
    f.spec.available = false; f.editor.update();  // e.g. Live turns gpu_busy mid-drag
    assert.equal(f.editor.snapshot.dragging, false); assert.equal(f.commits.length, 0);
    assert.equal(f.orbit.enabled, false, 'orbit came back while the button was still held');
    f.documentEmit('pointerup', { pointerId: 1, button: 0 });
    assert.equal(f.orbit.enabled, true);
  } finally { f.close(); }
});
