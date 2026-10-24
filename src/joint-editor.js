import { Box3, Group, Mesh, MeshBasicMaterial, Quaternion, Raycaster, SphereGeometry, Vector2, Vector3 } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { armChain, forwardKinematics, ikBounds, solveGraspIk } from './arm-kinematics.js';
import { createPathLine, setPathPoints } from './path-lines.js';
import { taskGizmoShortcut } from './target-gizmo.js';

export const CLICK_DISTANCE = 4; // CSS pixels; shared with ghost click-to-seek.
export const COMMIT_TOLERANCE = 1e-6; // rad
export const FK_GUARD_TOLERANCE = 1e-4; // m
export const TETHER_THRESHOLD = .002; // m

export function isJointClick(press, event) {
  return Boolean(press && press.id === event.pointerId && !press.dragged &&
    Math.hypot(event.clientX - press.x, event.clientY - press.y) < CLICK_DISTANCE);
}

export function ringAngleToJoint(start, rotationAngle, axisZ, lower, upper) {
  if (![start, rotationAngle, axisZ, lower, upper].every(Number.isFinite) || Math.abs(Math.abs(axisZ) - 1) > 1e-12) throw new Error('A joint ring needs a finite native ±z axis and limits.');
  return Math.max(lower, Math.min(upper, start + rotationAngle * axisZ));
}

export function committedPose(q, start, lower, upper) {
  if (!Array.isArray(q) || q.length !== start.length || !q.every(Number.isFinite)) return null;
  if (!q.some((value, i) => Math.abs(value - start[i]) > COMMIT_TOLERANCE)) return null;
  return q.map((value, i) => Math.max(lower[i], Math.min(upper[i], Math.round(value / COMMIT_TOLERANCE) * COMMIT_TOLERANCE)));
}

// Mesh membership comes from limit-tint's link traversal, which stops at joints.
export function classifyJointHit(object, links, gripperRoot) {
  for (let node = object; node; node = node.parent) {
    if (node === gripperRoot) return { mode: 'grasp', joint: null };
  }
  const index = links.findIndex(link => link.meshes.includes(object));
  return index < 0 ? null : { mode: 'ring', joint: index };
}

function isVisible(object) {
  for (let node = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}

/** The two viewport tools edit the same Live start-pose draft as the Joints tab. */
export function setupJointEditor({ scene, camera, renderer, orbit, robot, jointNames, links,
  getPose, previewPose, commitPose, onSelect = () => {}, getGhostHit = () => null, taskGizmo, guardBadge }) {
  const canvas = renderer.domElement;
  const ringProxy = new Group(), graspProxy = new Group();
  ringProxy.name = 'joint-ring-anchor'; graspProxy.name = 'grasp-handle-anchor';
  const marker = new Mesh(new SphereGeometry(.02, 20, 14), new MeshBasicMaterial({ color: 0xe7edf5,
    wireframe: true, depthTest: false, depthWrite: false, toneMapped: false }));
  marker.name = 'grasp-handle'; marker.renderOrder = 6; graspProxy.add(marker);
  const tether = createPathLine([], { color: 0xe7edf5, dashed: true, renderOrder: 6, name: 'grasp-tether' });
  scene.add(ringProxy, graspProxy, tether);
  const ring = new TransformControls(camera, canvas), grasp = new TransformControls(camera, canvas);
  ring.setMode('rotate'); ring.setSpace('local'); ring.setSize(.6);
  ring.showX = ring.showY = false; ring.showZ = true;
  grasp.setMode('translate'); grasp.setSpace('world'); grasp.setSize(.6);
  const ringHelper = ring.getHelper(), graspHelper = grasp.getHelper();
  ringHelper.name = 'joint-ring-controls'; graspHelper.name = 'grasp-handle-controls';
  scene.add(ringHelper, graspHelper);
  const raycaster = new Raycaster(), pointer = new Vector2();
  const gripperRoot = robot.joints.arm_right_tool_joint;
  let active = false, pose, mode = 'none', joint = null, chain, chainKey, chainError;
  let press, drag, cancelling = false, releasing = false, orbitWasEnabled = true;
  let lastResult, targetChanged = false, guardKey, guardError = null, guardReason = null;
  let highlighted = [];

  function readBase() { chain.baseLink.updateWorldMatrix(true, false); return chain.baseLink.matrixWorld.clone(); }
  function ensureChain() {
    const key = JSON.stringify(pose?.endEffector);
    if (key === chainKey) return;
    chainKey = key; chain = null; chainError = null; guardKey = null;
    try { chain = armChain(robot, { jointNames, grasp: pose?.endEffector }); }
    catch (error) { chainError = error.message; }
  }
  function checkGuard() {
    ensureChain();
    const reference = pose?.reference;
    const key = JSON.stringify([chainKey, reference?.generation, reference?.frame, reference?.q, reference?.world]);
    if (key === guardKey) return;
    guardKey = key; guardError = null;
    guardReason = chainError || (!reference?.q || !reference?.world ? 'Waiting for a recorded grasp point.' : null);
    if (!guardReason && reference.frame !== pose.endEffector.frame) guardReason = `Grasp frame differs: recorded ${reference.frame || 'unknown'}, model ${pose.endEffector.frame}.`;
    if (!guardReason) {
      try {
        const point = forwardKinematics(chain, readBase(), reference.q).grasp;
        guardError = Math.hypot(...point.map((value, i) => value - reference.world[i]));
        if (!Number.isFinite(guardError) || guardError > FK_GUARD_TOLERANCE) guardReason = `Grasp FK differs by ${(guardError * 1000).toFixed(3)} mm (limit 0.1 mm).`;
      } catch (error) { guardReason = error.message; }
    }
  }
  function clearHighlight() {
    highlighted.forEach(([material, color]) => material.emissive.copy(color)); highlighted = [];
  }
  function highlight() {
    clearHighlight();
    if (mode !== 'ring') return;
    links[joint]?.meshes.forEach(mesh => {
      if (mesh.material.emissive) { highlighted.push([mesh.material, mesh.material.emissive.clone()]); mesh.material.emissive.set(0x1d3a55); }
    });
  }
  function updateProxies() {
    if (!active) return;
    robot.updateMatrixWorld(true);
    if (mode === 'ring') {
      const selected = robot.joints[jointNames[joint]];
      selected.getWorldPosition(ringProxy.position); selected.getWorldQuaternion(ringProxy.quaternion);
    }
    if (chain && !guardReason && !(drag && mode === 'grasp')) {
      graspProxy.position.fromArray(forwardKinematics(chain, readBase(), pose.value).grasp);
    }
    ringProxy.updateMatrixWorld(true); graspProxy.updateMatrixWorld(true);
  }
  function restoreOrbit() { if (drag) return; orbit.enabled = orbitWasEnabled; }
  function releaseCapture(id) {
    if (id != null && canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id);
  }
  function cancelDrag() {
    if (!drag) return;
    const before = drag; drag = null; cancelling = true;
    ring.pointerUp(null); grasp.pointerUp(null); releaseCapture(before.pointerId);
    cancelling = false; releasing = false;
    previewPose(null); pose = getPose(); restoreOrbit();
    lastResult = null; tether.visible = false; targetChanged = false;
    if (active) updateProxies();
  }
  function deselect() {
    cancelDrag(); mode = 'none'; joint = null; press = null;
    ring.detach(); grasp.detach(); clearHighlight(); tether.visible = false;
    marker.material.wireframe = true;
  }
  function select(selection) {
    deselect();
    if (!active || !selection || (selection.mode === 'grasp' && guardReason)) return;
    onSelect(); taskGizmo?.deselect();
    mode = selection.mode; joint = selection.joint;
    updateProxies();
    if (mode === 'ring') ring.attach(ringProxy);
    else { grasp.attach(graspProxy); marker.material.wireframe = false; }
    highlight();
  }
  function beginDrag(control) {
    if (!active || drag || cancelling) return;
    pose = getPose();
    if (!pose?.available) return;
    const q0 = pose.value.slice();
    drag = { q0, q: q0.slice(), pointerId: press?.id, generation: pose.reference?.generation, base: chain ? readBase() : null,
      lower: pose.lower.slice(), upper: pose.upper.slice(), quaternion: ringProxy.quaternion.clone() };
    if (mode === 'grasp') {
      Object.assign(drag, ikBounds(q0, pose, pose.planning));
      drag.target = graspProxy.position.toArray(); targetChanged = false;
      lastResult = { q: q0.slice(), achieved: drag.target.slice(), gap_m: 0, iterations: 0, converged: true, stalled: false };
    }
    orbitWasEnabled = orbit.enabled; orbit.enabled = false;
    // TransformControls emits mouseDown after setting dragging. No settings request here.
  }
  function solveFrame() {
    if (!drag || mode !== 'grasp' || (!targetChanged && (lastResult?.converged || lastResult?.stalled))) return;
    lastResult = solveGraspIk(chain, drag.base, { q: drag.q, q0: drag.q0, target: drag.target,
      lower: drag.lower, upper: drag.upper });
    drag.q = lastResult.q; targetChanged = false; previewPose(drag.q);
    setPathPoints(tether, [drag.target, lastResult.achieved]);
    tether.visible = lastResult.gap_m >= TETHER_THRESHOLD;
  }
  function finishDrag() {
    if (!drag || cancelling) return;
    const finished = drag;
    // Use the last rendered IK solution. A final pointer event only changes the request.
    const q = committedPose(finished.q, finished.q0, finished.lower, finished.upper);
    drag = null; releasing = false; targetChanged = false;
    if (!q || commitPose(q) === false) previewPose(null);
    pose = getPose(); restoreOrbit(); tether.visible = false;
    if (active) updateProxies();
  }
  for (const control of [ring, grasp]) {
    control.addEventListener('mouseDown', () => beginDrag(control));
    control.addEventListener('mouseUp', finishDrag);
  }
  ring.addEventListener('objectChange', () => {
    if (!drag || mode !== 'ring') return;
    const q = ringAngleToJoint(drag.q0[joint], ring.rotationAngle, robot.joints[jointNames[joint]].axis.z,
      drag.lower[joint], drag.upper[joint]);
    drag.q[joint] = q;
    ringProxy.quaternion.copy(drag.quaternion).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1),
      (q - drag.q0[joint]) * robot.joints[jointNames[joint]].axis.z));
    previewPose(drag.q);
  });
  grasp.addEventListener('objectChange', () => {
    if (!drag || mode !== 'grasp') return;
    drag.target = graspProxy.position.toArray(); targetChanged = true;
  });
  function pointAt(event) {
    const bounds = canvas.getBoundingClientRect();
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return { x: pointer.x, y: pointer.y, button: event.button };
  }
  function editorHandleAt(event) {
    if (!active) return false;
    const control = mode === 'ring' ? ring : mode === 'grasp' ? grasp : null;
    if (!control) return false;
    scene.updateMatrixWorld(true);
    control.pointerHover(pointAt(event));
    return Boolean(control.axis);
  }
  taskGizmo?.setPickGuard(editorHandleAt);
  function hit(event) {
    pointAt(event); robot.updateMatrixWorld(true); graspProxy.updateMatrixWorld(true);
    // The grasp handle has priority over the robot, as its depth-free visual does.
    if (!guardReason && marker.visible && raycaster.intersectObject(marker, false).length) return { mode: 'grasp', joint: null };
    const solid = raycaster.intersectObject(robot, true).find(item => item.object.isMesh && isVisible(item.object));
    const ghost = getGhostHit(raycaster);
    if (ghost && (!solid || ghost.distance < solid.distance)) return { mode: 'ghost' };
    return solid ? classifyJointHit(solid.object, links, gripperRoot) : null;
  }
  function pointerDown(event) {
    if (!active || event.button !== 0) return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
    // Handles keep normal TransformControls pointer processing; no link picking.
    if (editorHandleAt(event) || taskGizmo?.interactionActive) press.handle = true;
  }
  function pointerMove(event) {
    if (!active) return;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= CLICK_DISTANCE) press.dragged = true;
    if (drag || event.buttons) return;
    const handle = editorHandleAt(event), picked = handle ? null : hit(event);
    canvas.style.cursor = handle || picked?.mode === 'ring' || picked?.mode === 'grasp' ? 'pointer' : '';
  }
  function pointerUp(event) {
    if (drag) { event.jointEditHandled = true; releasing = true; press = null; return; }
    const before = press; press = null;
    if (before?.handle) { event.jointEditHandled = true; return; }
    if (!active || !isJointClick(before, event)) return;
    const picked = hit(event);
    if (picked?.mode === 'ghost') { deselect(); return; }
    select(picked);
    // OrbitControls still needs pointerup to release capture. Onion skin checks
    // this claim before seeking, so one click cannot both select and seek.
    event.jointEditHandled = true;
  }
  function pointerCancel() { press = null; cancelDrag(); }
  function lostCapture() { if (!releasing) pointerCancel(); }
  function keyDown(event) {
    if (taskGizmoShortcut(event, 'reach') !== 'deselect' || !active) return;
    event.preventDefault();
    if (drag) cancelDrag(); else deselect();
  }
  canvas.addEventListener('pointerdown', pointerDown, true);
  canvas.addEventListener('pointermove', pointerMove, true);
  canvas.addEventListener('pointerup', pointerUp, true);
  canvas.addEventListener('pointercancel', pointerCancel, true);
  canvas.addEventListener('lostpointercapture', lostCapture);
  document.addEventListener('keydown', keyDown);

  function update() {
    pose = getPose();
    const next = Boolean(pose?.available);
    if (!next && active) deselect();
    active = next;
    if (active) {
      // A replaced Live segment invalidates this local draft, just as playback
      // and locking do. Never overwrite another viewer's newer start pose.
      if (drag && drag.generation !== pose.reference?.generation) cancelDrag();
      checkGuard();
      if (mode === 'grasp' && guardReason) deselect();
      solveFrame();
      // A draft's callback may have replaced the source object.
      pose = getPose();
      jointNames.forEach((name, i) => robot.setJointValue(name, drag?.q[i] ?? pose.value[i]));
      robot.updateMatrixWorld(true);
      if (!drag) updateProxies();
    } else canvas.style.cursor = '';
    ring.enabled = active && mode === 'ring'; grasp.enabled = active && mode === 'grasp' && !guardReason;
    ringHelper.visible = ring.enabled; graspHelper.visible = grasp.enabled;
    graspProxy.visible = active && Boolean(chain) && !guardReason;
    if (!active) tether.visible = false;
    if (guardBadge) { guardBadge.hidden = !active || !guardReason; guardBadge.title = guardReason || ''; }
  }
  function project(point) {
    const p = point.clone().project(camera), bounds = canvas.getBoundingClientRect();
    return [bounds.left + (p.x + 1) * bounds.width / 2, bounds.top + (1 - p.y) * bounds.height / 2];
  }
  update();
  return {
    update, deselect,
    get ownsPose() { return Boolean(getPose()?.available); },
    get dragging() { return Boolean(drag); },
    get interactionActive() { return Boolean(drag || (mode === 'ring' ? ring.axis : mode === 'grasp' ? grasp.axis : null)); },
    get snapshot() {
      const handles = {}, ringSamples = [];
      const helper = mode === 'ring' ? ringHelper : graspHelper;
      helper.updateMatrixWorld(true);
      helper.traverse(object => {
        if (!object.isMesh || !isVisible(object) || !/^[XYZ]$/.test(object.name)) return;
        if (mode === 'grasp' && object.geometry.parameters?.radialSegments === 12 && !handles[object.name]) {
          handles[object.name] = project(new Box3().setFromObject(object).getCenter(new Vector3()));
        }
        if (mode === 'ring' && object.name === 'Z' && object.geometry.type === 'TorusGeometry') {
          const vertices = object.geometry.attributes.position;
          for (let i = 0; i < vertices.count; i += Math.max(1, Math.floor(vertices.count / 32))) ringSamples.push(project(new Vector3().fromBufferAttribute(vertices, i).applyMatrix4(object.matrixWorld)));
        }
      });
      return { available: Boolean(pose?.available), mode, joint,
        dragging: Boolean(drag), q_draft: drag?.q.slice() || null, target_world: drag?.target?.slice() || graspProxy.position.toArray(),
        achieved_world: drag ? lastResult?.achieved : (pose && chain && !guardReason ? forwardKinematics(chain, readBase(), pose.value).grasp : null),
        gap_m: drag ? lastResult?.gap_m || 0 : 0, iterations: lastResult?.iterations || 0,
        converged: Boolean(lastResult?.converged), stalled: Boolean(lastResult?.stalled), fk_guard_m: guardError, guard_reason: guardReason,
        grasp_screen: project(graspProxy.position), ring_screen: project(ringProxy.position), handles_screen: handles,
        ring_samples_screen: ringSamples,
        links_screen: links.map(link => link.meshes.length ? project(new Box3().setFromObject(link.meshes[0]).getCenter(new Vector3())) : null),
        joints_screen: jointNames.map(name => project(robot.joints[name].getWorldPosition(new Vector3()))),
        gripper_screen: gripperRoot ? project(gripperRoot.getWorldPosition(new Vector3())) : null,
        orbit_enabled: orbit.enabled };
    },
    dispose() {
      deselect(); taskGizmo?.setPickGuard(null);
      canvas.removeEventListener('pointerdown', pointerDown, true);
      canvas.removeEventListener('pointermove', pointerMove, true);
      canvas.removeEventListener('pointerup', pointerUp, true);
      canvas.removeEventListener('pointercancel', pointerCancel, true);
      canvas.removeEventListener('lostpointercapture', lostCapture);
      document.removeEventListener('keydown', keyDown);
      ring.dispose(); grasp.dispose();
      marker.geometry.dispose(); marker.material.dispose(); tether.geometry.dispose(); tether.material.dispose();
      scene.remove(ringProxy, graspProxy, tether, ringHelper, graspHelper);
      if (guardBadge) guardBadge.hidden = true;
      canvas.style.cursor = '';
    },
  };
}
