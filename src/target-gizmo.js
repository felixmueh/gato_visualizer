import { Box3, Group, Mesh, MeshBasicMaterial, Raycaster, SphereGeometry, Vector2, Vector3 } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export function targetWorldPosition(base, offset) {
  return base.map((value, i) => value + offset[i]);
}

export function targetWorldOffset(base, position) {
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) return null;
  return position.map((value, i) => Math.max(-1, Math.min(1, value - base[i])));
}

export function normalizeQuaternion(value) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) return null;
  const norm = Math.hypot(...value);
  return Number.isFinite(norm) && norm > 1e-12 ? value.map(x => x / norm) : null;
}

export function taskGizmoShortcut(event, kind) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.target?.isContentEditable ||
      /^(INPUT|SELECT|TEXTAREA)$/i.test(event.target?.tagName || '')) return null;
  const key = event.key.toLowerCase();
  if (key === 'escape') return 'deselect';
  if (key === 't' || key === 'g') return 'translate';
  if (kind === 'figure8' && key === 'r') return 'rotate';
  if (kind === 'figure8' && key === 's') return 'scale';
  return null;
}

export function setupTargetGizmo({ scene, camera, renderer, orbit, getTarget, moveTarget, transformTarget, button, note, onSelect = () => {} }) {
  const canvas = renderer.domElement;
  const anchor = new Group();
  const marker = new Mesh(new SphereGeometry(.022, 20, 14), new MeshBasicMaterial({
    color: 0xffb547, depthTest: false, depthWrite: false, transparent: true, opacity: .9, toneMapped: false,
  }));
  marker.renderOrder = 6;
  anchor.add(marker);
  scene.add(anchor);
  const transform = new TransformControls(camera, canvas);
  transform.setMode('translate');
  transform.setSpace('world');
  transform.setSize(.8);
  const helper = transform.getHelper();
  scene.add(helper);
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let selected = false;
  let active = false;
  let orbitWasEnabled = true;
  let pointerId, dragSize;
  let toolMode = 'translate';
  let pickGuard = () => false;

  const cancelDrag = () => {
    const capturedPointer = pointerId;
    pointerId = undefined;
    if (transform.dragging) transform.pointerUp(null);
    if (capturedPointer != null && canvas.hasPointerCapture(capturedPointer)) canvas.releasePointerCapture(capturedPointer);
  };
  const select = (next) => {
    selected = Boolean(next && active);
    if (selected) { onSelect(); transform.attach(anchor); }
    else { cancelDrag(); transform.detach(); }
    if (button) button.textContent = selected ? 'Hide task handles' : 'Edit task in 3D';
    marker.material.wireframe = !selected;
  };
  transform.addEventListener('dragging-changed', (event) => {
    if (event.value) { orbitWasEnabled = orbit.enabled; orbit.enabled = false; dragSize = getTarget()?.size_m; }
    else orbit.enabled = orbitWasEnabled;
  });
  transform.addEventListener('objectChange', () => {
    if (!active) return;
    if (toolMode === 'translate') {
      const applied = moveTarget(anchor.position.toArray());
      if (applied) anchor.position.fromArray(applied);
    } else if (transformTarget) {
      const applied = transformTarget({ quaternion_xyzw: anchor.quaternion.toArray(),
        ...(toolMode === 'scale' && dragSize ? { size_m: dragSize.map((value, i) => value * anchor.scale.getComponent(i)) } : {}) });
      if (applied?.quaternion_xyzw) anchor.quaternion.fromArray(applied.quaternion_xyzw);
      if (applied?.size_m && dragSize && toolMode === 'scale') anchor.scale.set(applied.size_m[0] / dragSize[0], applied.size_m[1] / dragSize[1], 1);
    }
  });
  const pickTarget = (event) => {
    if (!active || event.button !== 0 || pickGuard(event)) return;
    pointerId = event.pointerId;
    const bounds = canvas.getBoundingClientRect();
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    anchor.updateMatrixWorld(true);
    if (raycaster.intersectObject(marker, false).length) {
      select(true);
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  canvas.addEventListener('pointerdown', pickTarget, true);
  canvas.addEventListener('pointercancel', cancelDrag);
  canvas.addEventListener('lostpointercapture', cancelDrag);
  const setToolMode = (next) => {
    cancelDrag(); toolMode = next;
    transform.setMode(next); transform.setSpace(next === 'scale' ? 'local' : 'world');
    transform.showZ = next !== 'scale';
    anchor.scale.set(1, 1, 1);
  };
  const escape = (event) => {
    if (!active) return;
    const action = taskGizmoShortcut(event, getTarget()?.kind);
    if (!action) return;
    event.preventDefault();
    if (action === 'deselect') select(false);
    else { setToolMode(action); select(true); }
  };
  document.addEventListener('keydown', escape);
  const toggle = () => select(!selected);
  button?.addEventListener('click', toggle);

  const update = () => {
    const target = getTarget();
    active = Boolean(target?.available);
    anchor.visible = active;
    transform.enabled = active && selected;
    if (!active) select(false);
    else if (!transform.dragging) {
      if (target.kind !== 'figure8' && toolMode !== 'translate') setToolMode('translate');
      anchor.position.fromArray(target.position_world);
      anchor.quaternion.fromArray(target.quaternion_xyzw || [0, 0, 0, 1]);
      anchor.scale.set(1, 1, 1);
    }
    helper.visible = active && selected;
    if (button) button.disabled = !active;
    if (note) note.textContent = !active
      ? 'Task handles become available at the latest live state after preview.'
      : selected ? `${toolMode === 'scale' ? 'Scale local X width / Y height' : toolMode === 'rotate' ? 'Rotate path around its start point in world coordinates' : 'Move task in world coordinates'}. T translate${target.kind === 'figure8' ? ' · R rotate · S scale' : ''} · Esc deselect.${target.pending ? ' Prediction updating…' : ''}`
        : `Click the gold task anchor or press T to translate${target.kind === 'figure8' ? ', R to rotate, S to scale' : ''}.`;
  };
  const project = (point) => {
    const position = point.clone().project(camera);
    const bounds = canvas.getBoundingClientRect();
    return [bounds.left + (position.x + 1) * bounds.width / 2, bounds.top + (1 - position.y) * bounds.height / 2];
  };
  update();
  return {
    update,
    deselect: () => select(false),
    setPickGuard(fn) { pickGuard = fn || (() => false); },
    get interactionActive() { return selected && Boolean(transform.dragging || transform.axis); },
    get active() { return active; },
    get snapshot() {
      const handles = {};
      helper.updateMatrixWorld(true);
      helper.traverse((object) => {
        if (object.visible && object.isMesh && /^[XYZ]$/.test(object.name) && object.geometry.parameters?.radialSegments === 12 && !handles[object.name]) {
          handles[object.name] = project(new Box3().setFromObject(object).getCenter(new Vector3()));
        }
      });
      return { active, selected, mode: toolMode, quaternion_xyzw: anchor.quaternion.toArray(), dragging: transform.dragging, position_world: anchor.position.toArray(),
        target_screen: project(anchor.position), handles_screen: handles, orbit_enabled: orbit.enabled };
    },
    dispose() {
      cancelDrag();
      canvas.removeEventListener('pointerdown', pickTarget, true);
      canvas.removeEventListener('pointercancel', cancelDrag);
      canvas.removeEventListener('lostpointercapture', cancelDrag);
      document.removeEventListener('keydown', escape);
      button?.removeEventListener('click', toggle);
      transform.dispose();
      scene.remove(helper, anchor);
      marker.geometry.dispose();marker.material.dispose();
    },
  };
}
