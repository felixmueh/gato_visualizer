import { Box3, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, Raycaster, SphereGeometry, Vector2, Vector3 } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { coverMaterial, coverMeshes, createArmCover } from './track-scene.js';
import { capsuleRotation, createShapeObject, flipPlane, planeRotation, rotateCapsule, scaleShape, setShapeObject, shapeCentre,
  shapeExtent, shapeFromWorld, shapeToWorld, translateShape } from './collision-shapes.js';
import { clampShape } from './shape-layouts.js';
import { createOrbitLock } from './orbit-lock.js';

// Live's collision scene: the draft obstacles (solid, editable) of every shape list an
// adapter declares (spheres, capsules, boxes, planes; collision-shapes.js), and behind the
// collision-spheres toggle the spheres the current segment's rows see: the body's cover
// and the arm's cover following the drawn arm. Obstacles are in the rows' root frame
// (torso_lift_link); world_from_root (4×4, row-major) places them at Live's body posture.

const SELECTED_EMISSIVE = 0x5c2416;
const HANDLE_COLOR = 0xe7edf5;

export function rootToWorld(matrix, [x, y, z, r]) {
  const m = matrix;
  return [m[0][0] * x + m[0][1] * y + m[0][2] * z + m[0][3],
    m[1][0] * x + m[1][1] * y + m[1][2] * z + m[1][3],
    m[2][0] * x + m[2][1] * y + m[2][2] * z + m[2][3], ...(r === undefined ? [] : [r])];
}

/** A world point in the root frame (the inverse of a rigid transform). */
export function worldToRoot(matrix, [x, y, z]) {
  const m = matrix, d = [x - m[0][3], y - m[1][3], z - m[2][3]];
  return [0, 1, 2].map(i => m[0][i] * d[0] + m[1][i] * d[1] + m[2][i] * d[2]);
}

/** Modal scaling as in Blender: the pointer's screen distance from the sphere's centre over
 * that distance when scaling began sets the factor. Each move adds its change of that ratio,
 * a tenth of it with Shift, so pressing or releasing Shift never jumps. A small minimum
 * lever keeps a start near the centre controllable. Returns the next scale state. */
export const SCALE_MIN_LEVER_PX = 40;
export function scaleStep(state, distance, { fine = false } = {}) {
  const lever = Math.max(state.lever ?? distance, SCALE_MIN_LEVER_PX);
  const offset = lever - (state.lever ?? distance);  // added to every distance: the start is ratio 1
  const ratio = (distance + offset) / lever;
  const previous = state.ratio ?? 1;
  return { ...state, lever: state.lever ?? distance, ratio, factor: (state.factor ?? 1) + (ratio - previous) * (fine ? .1 : 1) };
}

/** A size (radius, half-extent) within the descriptor's bounds (exclusive minimum), on a 1 mm grid. */
export function boundedSize(radius, { min_size: low = 0, max_size: high = Infinity } = {}) {
  const value = Math.round(Math.min(high, Math.max(radius, low + 1e-3)) * 1000) / 1000;
  return value > low ? value : Math.ceil((low + 1e-9) * 1000) / 1000;
}

/** The pasted copy's centre: where the pointer's ray meets the plane through the copied
 * centre, normal to the view direction (all in the world). Without a pointer ray, or with
 * one parallel to that plane, the copy is offset sideways by twice its radius along right. */
export function pastedCentre(centre, radius, { origin, direction, view, right }) {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (origin && direction) {
    const denominator = dot(direction, view);
    if (Math.abs(denominator) > 1e-9) {
      const t = dot(centre.map((value, i) => value - origin[i]), view) / denominator;
      if (t > 0) return origin.map((value, i) => value + t * direction[i]);
    }
  }
  return centre.map((value, i) => value + 2 * radius * right[i]);
}

/** Keys of the obstacle tools; null for others and inside text fields. With Ctrl or Cmd:
 * copy and paste (undo and redo belong to the settings history); plain keys only while an
 * obstacle is selected. */
export function obstacleShortcut(event) {
  if (event.altKey || event.target?.isContentEditable ||
      /^(INPUT|SELECT|TEXTAREA)$/i.test(event.target?.tagName || '')) return null;
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) {
    if (key === 'c') return 'copy';
    if (key === 'v') return 'paste';
    return null;
  }
  if (key === 'escape') return 'deselect';
  if (key === 'enter') return 'confirm';
  if (key === 'delete' || key === 'backspace') return 'remove';
  if (key === 't' || key === 'g') return 'translate';
  if (key === 's') return 'scale';
  if (key === 'r') return 'rotate';
  return null;
}

const round = value => Number(value.toFixed(4));

export function setupLiveObstacles({ scene, camera, renderer, orbit, orbitLock, robot, jointNames, getInteraction, setObstacles,
  commit, beginGesture = () => {}, endGesture = () => {}, highlight = () => {}, onSelect = () => {}, onChange = () => {} }) {
  const canvas = renderer.domElement;
  const group = new Group(); group.name = 'live-collision'; scene.add(group);
  const obstacles = new Group(); obstacles.name = 'live-obstacles'; group.add(obstacles);
  const handles = new Group(); handles.name = 'live-obstacle-handles'; scene.add(handles);
  const drawn = new Map();  // list path → drawn objects, one per obstacle
  let body = null, bodyKey, arm = null, armKey;
  const anchor = new Group(); anchor.name = 'live-obstacle-anchor'; scene.add(anchor);
  const transform = new TransformControls(camera, canvas);
  transform.setMode('translate'); transform.setSpace('world'); transform.setSize(.7);
  const helper = transform.getHelper(); helper.name = 'live-obstacle-controls'; scene.add(helper);
  const raycaster = new Raycaster(), pointer = new Vector2();
  const label = document.createElement('div'); label.className = 'obstacle-scale-label'; label.hidden = true;
  label.setAttribute('role', 'status'); canvas.parentElement?.append(label);
  // selected: {path, index}; tool: move, rotate, scale (capsules and boxes, on their own
  // axes), or a capsule end / box face ({kind, ...}).
  let interaction = null, selected = null, tool = 'move', drag = null, scaling = null, hovering = false;
  let lastAdded, pendingSelect = null, clipboard = null, lastPointer = null, handleKey;
  // Orbit is disabled through the shared lock (orbit-lock.js): a press on a handle or an
  // obstacle never starts an orbit, and orbit returns only once the button is up.
  const lock = orbitLock ?? createOrbitLock(orbit, canvas);
  let pickGuard = () => false;

  const listOf = path => interaction?.lists.find(list => list.path === path) || null;
  const current = () => {
    const list = selected && listOf(selected.path);
    return list && selected.index < list.values.length ? { list, values: list.values[selected.index], world: list.world[selected.index] } : null;
  };
  function dispose(object) {
    object?.traverse(item => { item.geometry?.dispose(); item.material?.dispose?.(); });
    object?.removeFromParent();
  }
  function select(next, nextTool = 'move') {
    cancelDrag(); finishScale(false);
    const list = next && listOf(next.path);
    selected = list && Number.isInteger(next.index) && next.index >= 0 && next.index < list.values.length ? { path: next.path, index: next.index } : null;
    tool = selected ? nextTool : 'move';
    if (selected) { onSelect(); transform.attach(anchor); } else transform.detach();
    highlight(selected); paint(); handleKey = undefined;
  }
  function paint() {
    for (const [path, objects] of drawn) objects.forEach((object, i) =>
      object.userData.material.emissive?.setHex(selected?.path === path && selected.index === i ? SELECTED_EMISSIVE : 0x000000));
  }
  function cancelDrag() {
    if (!drag) return;
    const before = drag; drag = null;
    lock.release('live-obstacles');
    if (transform.dragging) transform.pointerUp(null);
    // Escape restores the obstacles from before the drag; the gesture then submits nothing new.
    if (before.cancelled) setObstacles(before.path, before.start);
    endGesture({ commit: true });
  }
  // The anchor's pose and the gizmo's mode and axes for the selection and tool.
  function placeAnchor() {
    const item = current();
    if (!item) return;
    const { list, world } = item, shape = list.shape;
    let position = shapeCentre(shape, world, interaction.reference), quaternion = new Quaternion();
    let mode = 'translate', space = 'world', axes = [true, true, true];
    if (shape === 'plane') { quaternion = planeRotation(world); space = 'local'; axes = [false, false, true]; }
    if (tool === 'rotate' || tool === 'scale') {
      mode = tool; space = 'local';
      // The shape's own axes: a box's quaternion, a capsule's local y along a→b, a plane's normal.
      quaternion = shape === 'box' ? new Quaternion(...world.slice(3, 7)) : shape === 'capsule' ? capsuleRotation(world) : planeRotation(world);
      axes = shape === 'plane' ? [true, true, false] : [true, true, true];
    } else if (tool?.kind === 'end') position = world.slice(3 * tool.end, 3 * tool.end + 3);
    else if (tool?.kind === 'face') {
      quaternion = new Quaternion(...world.slice(3, 7)); space = 'local';
      axes = [0, 1, 2].map(axis => axis === tool.axis);
      position = facePoint(world, tool.axis, tool.sign);
    }
    anchor.position.fromArray(position); anchor.quaternion.copy(quaternion); anchor.scale.set(1, 1, 1); anchor.updateMatrixWorld(true);
    if (transform.mode !== mode) transform.setMode(mode);
    if (transform.space !== space) transform.setSpace(space);
    [transform.showX, transform.showY, transform.showZ] = axes;
  }
  function facePoint(world, axis, sign) {
    const direction = new Vector3().setComponent(axis, sign * world[7 + axis]).applyQuaternion(new Quaternion(...world.slice(3, 7)));
    return new Vector3(...world.slice(0, 3)).add(direction).toArray();
  }
  // The edited obstacle's world values for the anchor's pose (drag.world: at the drag's start).
  function draggedWorld() {
    const shape = drag.shape, world = [...drag.world];
    if (tool === 'move') return translateShape(shape, world, anchor.position.clone().sub(drag.position).toArray());
    if (tool === 'scale') return scaleShape(shape, world, anchor.scale.toArray());
    if (tool === 'rotate') {
      if (shape === 'box') return [...world.slice(0, 3), ...anchor.quaternion.toArray(), ...world.slice(7)];
      // The turn since the drag began, about the capsule's centre.
      if (shape === 'capsule') return rotateCapsule(world, anchor.quaternion.clone().multiply(drag.quaternion.clone().invert()).toArray());
      const normal = new Vector3(0, 0, 1).applyQuaternion(anchor.quaternion), centre = new Vector3(...drag.centre);
      return [...normal.toArray(), normal.dot(centre)];  // turns about the patch centre
    }
    if (tool.kind === 'end') { world.splice(3 * tool.end, 3, ...anchor.position.toArray()); return world; }
    // A face: the opposite face stays; half the face's travel grows the half-extent and moves the centre.
    const axis = new Vector3().setComponent(tool.axis, tool.sign).applyQuaternion(new Quaternion(...world.slice(3, 7)));
    const travel = anchor.position.clone().sub(drag.position).dot(axis), size = Math.max(1e-3, world[7 + tool.axis] + travel / 2);
    const shift = size - world[7 + tool.axis];
    world.splice(0, 3, ...new Vector3(...world.slice(0, 3)).addScaledVector(axis, shift).toArray());
    world[7 + tool.axis] = size;
    return world;
  }
  transform.addEventListener('dragging-changed', event => {
    const item = current();
    if (event.value && item) {
      lock.hold('live-obstacles');
      drag = { path: selected.path, shape: item.list.shape, start: item.list.values.map(values => [...values]), world: [...item.world],
        position: anchor.position.clone(), quaternion: anchor.quaternion.clone(), centre: shapeCentre(item.list.shape, item.world, interaction.reference) };
      beginGesture();
    } else if (drag) {
      drag = null; lock.release('live-obstacles');
      endGesture({ commit: true });  // released: one submission for the whole drag
    }
  });
  transform.addEventListener('objectChange', () => {
    const item = current();
    if (!drag || !item || !interaction?.world_from_root) return;
    const values = drag.start.map(row => [...row]);
    values[selected.index] = clampShape(item.list.parameter, shapeFromWorld(drag.shape, draggedWorld(), interaction.world_from_root));
    setObstacles(drag.path, values);
  });

  function screenOf(world) {
    const point = new Vector3(...world).project(camera), bounds = canvas.getBoundingClientRect();
    return [bounds.left + (point.x + 1) * bounds.width / 2, bounds.top + (1 - point.y) * bounds.height / 2];
  }
  // Modal scaling (S): spheres' and capsules' radius, a box's half-extents together; the factor
  // follows the pointer's distance from the obstacle's centre.
  function startScale() {
    const item = current();
    if (!item || drag || scaling || item.list.shape === 'plane') return;
    scaling = { path: selected.path, index: selected.index, shape: item.list.shape, start: item.list.values.map(values => [...values]), state: {} };
    transform.enabled = false; helper.visible = false; handles.visible = false;
    beginGesture();
    if (lastPointer) scaleTo(lastPointer, false); else showLabel(null);
  }
  function scaleTo(point, fine) {
    const list = listOf(scaling.path), world = list.world[scaling.index];
    const centre = screenOf(shapeCentre(scaling.shape, world, interaction.reference));
    scaling.state = scaleStep(scaling.state, Math.hypot(point[0] - centre[0], point[1] - centre[1]), { fine });
    const values = scaling.start.map(row => [...row]), item = values[scaling.index];
    const sizes = scaling.shape === 'box' ? [7, 8, 9] : [scaling.shape === 'capsule' ? 6 : 3];
    for (const i of sizes) item[i] = boundedSize(scaling.start[scaling.index][i] * scaling.state.factor, list.parameter);
    setObstacles(scaling.path, values);
    showLabel(point, sizes.map(i => item[i]));
  }
  function showLabel(point, sizes) {
    const list = listOf(scaling.path), parent = canvas.parentElement?.getBoundingClientRect() ?? canvas.getBoundingClientRect();
    const values = sizes || (scaling.shape === 'box' ? [7, 8, 9] : [scaling.shape === 'capsule' ? 6 : 3]).map(i => list.values[scaling.index][i]);
    const [x, y] = point || screenOf(shapeCentre(scaling.shape, list.world[scaling.index], interaction.reference));
    label.textContent = scaling.shape === 'box' ? `h ${values.map(value => value.toFixed(3)).join(' ')} m` : `r ${values[0].toFixed(3)} m`;
    label.hidden = false; label.style.left = `${x - parent.left}px`; label.style.top = `${y - parent.top}px`;
  }
  function finishScale(apply) {
    if (!scaling) return;
    const before = scaling; scaling = null; label.hidden = true; handles.visible = true;
    if (!apply) setObstacles(before.path, before.start);
    endGesture({ commit: true });
  }

  function pointAt(event) {
    const bounds = canvas.getBoundingClientRect();
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return { x: pointer.x, y: pointer.y, button: event.button };
  }
  function handleAt(event) {
    if (!selected || !transform.enabled) return false;
    scene.updateMatrixWorld(true); transform.pointerHover(pointAt(event));
    return Boolean(transform.axis);
  }
  // The nearest obstacle (or, of the selected one, a capsule end or box face handle) under the pointer.
  function hit(event) {
    pointAt(event); scene.updateMatrixWorld(true);
    const marker = handles.visible ? raycaster.intersectObjects(handles.children, false)[0] : null;
    if (marker) return { ...selected, tool: marker.object.userData.tool };
    const meshes = [...drawn.values()].flat().map(object => object.userData.mesh);
    const found = raycaster.intersectObjects(meshes, false)[0];
    return found ? { ...found.object.userData.obstacle, tool: 'move' } : null;
  }
  function pointerDown(event) {
    if (scaling) {
      // A click applies the scale, the right button cancels it; neither orbits nor picks.
      finishScale(event.button === 0); event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (!interaction?.available || event.button !== 0 || pickGuard(event) || handleAt(event)) return;
    const picked = hit(event);
    if (!picked) return;
    // Selecting claims the press, as the task anchor does: no orbit, link pick or seek.
    select(picked, picked.tool); event.preventDefault(); event.stopImmediatePropagation();
  }
  function trackPointer(event) {
    const point = [event.clientX, event.clientY], bounds = canvas.getBoundingClientRect();
    // Paste and the scale's start use the last pointer position over the viewport.
    if (point[0] >= bounds.left && point[0] <= bounds.right && point[1] >= bounds.top && point[1] <= bounds.bottom) lastPointer = point;
    if (scaling && interaction?.available) scaleTo(point, event.shiftKey);
  }
  function pointerMove(event) {
    if (!interaction?.available || drag || scaling || event.buttons) return;
    const over = hit(event) != null;
    if (over) canvas.style.cursor = 'pointer';
    else if (hovering && !handleAt(event)) canvas.style.cursor = '';
    hovering = over;
  }
  // A copy of the clipboard's obstacle where the pointer's ray meets the view plane through
  // its centre, appended to its list and selected.
  function paste() {
    const list = clipboard && listOf(clipboard.path), matrix = interaction.world_from_root;
    if (!list || !matrix || list.values.length >= (list.parameter.max_count ?? Infinity)) return false;
    const world = shapeToWorld(list.shape, clipboard.values, matrix), centre = shapeCentre(list.shape, world, interaction.reference);
    const view = camera.getWorldDirection(new Vector3()).toArray();
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize().toArray();
    let ray = {};
    if (lastPointer) { pointAt({ clientX: lastPointer[0], clientY: lastPointer[1] }); ray = { origin: raycaster.ray.origin.toArray(), direction: raycaster.ray.direction.toArray() }; }
    const target = pastedCentre(centre, shapeExtent(list.shape, world), { ...ray, view, right });
    const moved = translateShape(list.shape, world, target.map((value, i) => value - centre[i]));
    const copy = clampShape(list.parameter, shapeFromWorld(list.shape, moved, matrix));
    if (!setObstacles(list.path, [...list.values.map(values => [...values]), copy], { commit: true })) return false;
    pendingSelect = { path: list.path, index: list.values.length };
    return true;
  }
  function keyDown(event) {
    if (!interaction?.available) return;
    const action = obstacleShortcut(event);
    if (!action) return;
    let handled = true;
    const item = current();
    if (scaling) {
      if (action === 'confirm') finishScale(true);
      else if (action === 'deselect') finishScale(false);
      else if (!['scale', 'translate', 'rotate'].includes(action)) handled = false;
    } else if (action === 'copy') {
      if (!item) handled = false; else clipboard = { path: selected.path, values: [...item.values] };
    } else if (action === 'paste') handled = paste();
    else if (!item) handled = false;
    else if (action === 'deselect') { if (drag) { drag.cancelled = true; cancelDrag(); } else select(null); }
    else if (action === 'remove') {
      const { path, index } = selected; select(null);
      setObstacles(path, item.list.values.filter((_, i) => i !== index), { commit: true });
    } else if (action === 'scale') {
      // A sphere scales modally (uniform); capsules and boxes get handles on their own axes.
      if (item.list.shape === 'sphere') startScale();
      else if (['capsule', 'box'].includes(item.list.shape)) { cancelDrag(); tool = 'scale'; handleKey = undefined; }
      else handled = false;
    }
    else if (action === 'rotate') { if (['capsule', 'box', 'plane'].includes(item.list.shape)) { cancelDrag(); tool = 'rotate'; handleKey = undefined; } else handled = false; }
    else if (action === 'translate') { cancelDrag(); tool = 'move'; handleKey = undefined; }
    else handled = false;
    // Captured before the task and joint tools' document shortcuts, which share these keys.
    if (handled) { event.preventDefault(); event.stopImmediatePropagation(); }
  }
  const contextMenu = event => { if (scaling) event.preventDefault(); };
  // Double-clicking a plane's normal arrow flips it: the same plane, the other side free.
  function doubleClick(event) {
    const item = current();
    if (!interaction?.available || item?.list.shape !== 'plane' || tool !== 'move' || !handleAt(event)) return;
    const values = item.list.values.map(row => [...row]);
    values[selected.index] = flipPlane(values[selected.index]);
    setObstacles(selected.path, values, { commit: true }); handleKey = undefined;
    event.preventDefault(); event.stopImmediatePropagation();
  }
  canvas.addEventListener('dblclick', doubleClick, true);
  canvas.addEventListener('pointerdown', pointerDown, true);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('contextmenu', contextMenu);
  window.addEventListener('pointermove', trackPointer);
  window.addEventListener('keydown', keyDown, true);
  // A press that selects an obstacle or grabs a handle claims it from orbit.
  const removeOrbitGuard = lock.addGuard(event => Boolean(interaction?.available) && event.button === 0
    && !pickGuard(event) && (Boolean(scaling) || handleAt(event) || hit(event) != null));

  // Draw every list's obstacles; recreate only when a list's length changes.
  function showObstacles() {
    const paths = new Set(interaction.lists.map(list => list.path));
    for (const [path, objects] of drawn) if (!paths.has(path)) { objects.forEach(dispose); drawn.delete(path); onChange(); }
    for (const list of interaction.lists) {
      let objects = drawn.get(list.path) || [];
      if (objects.length !== list.world.length) {
        objects.forEach(dispose);
        objects = list.world.map((_, index) => {
          const object = createShapeObject(list.shape); object.name = `live-obstacle-${list.shape}`;
          object.userData.mesh.userData.obstacle = { path: list.path, index }; obstacles.add(object); return object;
        });
        drawn.set(list.path, objects); paint(); onChange();
      }
      list.world.forEach((world, i) => {
        const key = JSON.stringify(world);
        if (objects[i].userData.placed !== key) { setShapeObject(objects[i], list.shape, world, interaction.reference); objects[i].userData.placed = key; onChange(); }
      });
    }
  }
  // A selected capsule's two end handles and a selected box's six face handles.
  function showHandles() {
    const item = current(), shape = item?.list.shape;
    const key = item && ['capsule', 'box'].includes(shape) ? JSON.stringify([selected, item.world, tool]) : null;
    if (key === handleKey) return;
    handleKey = key; handles.children.slice().forEach(dispose); onChange();
    if (!key) return;
    const material = () => new MeshBasicMaterial({ color: HANDLE_COLOR, transparent: true, opacity: .9, depthTest: false, toneMapped: false });
    if (shape === 'capsule') for (const end of [0, 1]) {
      const marker = new Mesh(new SphereGeometry(.014, 16, 12), material());
      marker.position.fromArray(item.world.slice(3 * end, 3 * end + 3)); marker.renderOrder = 6;
      marker.userData.tool = { kind: 'end', end }; marker.material.wireframe = tool?.kind !== 'end' || tool.end !== end;
      handles.add(marker);
    } else for (const axis of [0, 1, 2]) for (const sign of [-1, 1]) {
      const marker = new Mesh(new PlaneGeometry(.03, .03), material());
      marker.material.side = 2; marker.renderOrder = 6;
      marker.position.fromArray(facePoint(item.world, axis, sign));
      marker.quaternion.copy(new Quaternion(...item.world.slice(3, 7))).multiply(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3().setComponent(axis, 1)));
      marker.userData.tool = { kind: 'face', axis, sign }; marker.material.wireframe = tool?.kind !== 'face' || tool.axis !== axis || tool.sign !== sign;
      handles.add(marker);
    }
  }
  function showCovers(collision, transform, covers, armVisible) {
    const nextBody = collision && transform
      ? JSON.stringify([collision.body, collision.body_capsules, collision.body_boxes, transform]) : null;
    if (nextBody !== bodyKey) {
      dispose(body); body = null; bodyKey = nextBody;
      if (nextBody) {
        // The stored body cover: spheres, capsules and boxes (tiago_mpc's mixed cover).
        body = coverMeshes({ spheres: collision.body.map(sphere => rootToWorld(transform, sphere)),
          capsules: (collision.body_capsules || []).map(values => shapeToWorld('capsule', values, transform)),
          boxes: (collision.body_boxes || []).map(values => shapeToWorld('box', values, transform)) },
        coverMaterial(), 'live-body-cover');
        group.add(body);
      }
      onChange();
    }
    const nextArm = collision ? JSON.stringify(collision.arm) : null;
    if (nextArm !== armKey) {
      dispose(arm?.holder); arm = null; armKey = nextArm;
      if (nextArm && robot.joints?.arm_right_1_joint) { arm = createArmCover(robot, collision.arm); group.add(arm.holder); }
      onChange();
    }
    if (body && body.visible !== covers) { body.visible = covers; onChange(); }
    if (arm) {
      const visible = covers && armVisible;
      if (arm.holder.visible !== visible) { arm.holder.visible = visible; onChange(); }
      if (visible) {
        // Follow the drawn arm: its base (Live's body posture) and joint values.
        const source = robot.joints.arm_right_1_joint;
        source.parent.updateWorldMatrix(true, false);
        arm.holder.matrix.copy(source.parent.matrixWorld);
        for (const name of jointNames) {
          const value = robot.joints[name]?.angle;
          if (Number.isFinite(value) && arm.joints.get(name)?.angle !== value) { arm.joints.get(name)?.setJointValue(value); onChange(); }
        }
      }
    }
  }

  function update({ covers = false, armVisible = true } = {}) {
    interaction = getInteraction();
    const shown = Boolean(interaction);
    group.visible = handles.visible = shown && !scaling;
    group.visible = shown;
    if (!shown) {
      if (selected || scaling) select(null);
      transform.enabled = helper.visible = false; handles.visible = false;
      return;
    }
    if (interaction.added && interaction.added !== lastAdded) {
      // The settings list just added one: select it here to place it.
      const list = listOf(interaction.added.path);
      if (lastAdded !== undefined && list?.values.length) pendingSelect = { path: list.path, index: list.values.length - 1 };
    }
    lastAdded = interaction.added;
    if (pendingSelect && listOf(pendingSelect.path)?.values.length > pendingSelect.index) { select(pendingSelect); pendingSelect = null; }
    // A drag or scale in progress keeps its obstacle; the edits it makes are the draft's.
    if (!drag && !scaling && selected && (!current() || !interaction.available)) select(null);
    showObstacles();
    showCovers(interaction.collision, interaction.world_from_root, covers, armVisible);
    transform.enabled = interaction.available && Boolean(selected) && !scaling;
    helper.visible = transform.enabled;
    if (selected && !drag) placeAnchor();
    showHandles();
  }

  return {
    update, select, deselect: () => select(null),
    setPickGuard(fn) { pickGuard = fn || (() => false); },
    get interactionActive() { return Boolean(scaling) || (Boolean(selected) && Boolean(drag || transform.axis)); },
    handleAt,
    get dragging() { return Boolean(drag || scaling); },
    /** Whether Live has spheres of collision rows to show. */
    get coversAvailable() { return Boolean(interaction?.collision); },
    get snapshot() {
      const project = point => {
        const p = point.clone().project(camera), bounds = canvas.getBoundingClientRect();
        return [bounds.left + (p.x + 1) * bounds.width / 2, bounds.top + (1 - p.y) * bounds.height / 2];
      };
      const lists = Object.fromEntries((interaction?.lists || []).map(list => [list.path, { shape: list.shape,
        values: list.values.map(values => [...values]), world: list.world,
        screen: (drawn.get(list.path) || []).map(object => project(object.position)) }]));
      return { available: Boolean(interaction?.available), selected, tool, mode: scaling ? 'scale' : transform.mode, dragging: Boolean(drag),
        scaling: scaling ? { values: listOf(scaling.path)?.values[scaling.index], label: label.textContent, factor: scaling.state.factor ?? 1 } : null,
        clipboard: clipboard ? { ...clipboard } : null, pointer: lastPointer ? [...lastPointer] : null, lists,
        handles: handles.children.map(marker => ({ tool: marker.userData.tool, screen: project(marker.position) })),
        anchor_screen: project(anchor.position), hover_axis: transform.axis ?? null,
        // Screen points 0.1 m along each of the gizmo's axes from the anchor: drag directions for checks.
        axes_screen: Object.fromEntries(['X', 'Y', 'Z'].map((name, i) => {
          const axis = new Vector3().setComponent(i, .1);
          if (transform.space === 'local') axis.applyQuaternion(anchor.quaternion);
          return [name, project(anchor.position.clone().add(axis))];
        })),
        handles_screen: Object.fromEntries((() => {
          const found = []; helper.updateMatrixWorld(true);
          helper.traverse(object => {
            if (object.visible && object.isMesh && /^[XYZ]$/.test(object.name) && !found.some(([name]) => name === object.name)
              && (object.geometry.parameters?.radialSegments === 12 || object.geometry.type === 'TorusGeometry')) found.push([object.name, project(new Box3().setFromObject(object).getCenter(new Vector3()))]);
          });
          return found;
        })()),
        body_cover: body?.visible ? body.children.length : 0, arm_cover: arm?.holder.visible ? arm.count : 0 };
    },
    dispose() {
      cancelDrag(); finishScale(false); transform.detach(); transform.dispose();
      canvas.removeEventListener('pointerdown', pointerDown, true);
      canvas.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('pointermove', trackPointer);
      canvas.removeEventListener('contextmenu', contextMenu);
      canvas.removeEventListener('dblclick', doubleClick, true);
      removeOrbitGuard(); if (!orbitLock) lock.dispose();
      label.remove();
      for (const objects of drawn.values()) objects.forEach(dispose);
      handles.children.slice().forEach(dispose); dispose(body); dispose(arm?.holder);
      scene.remove(group, anchor, helper, handles);
    },
  };
}
