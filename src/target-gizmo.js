import { Box3, Group, Mesh, MeshBasicMaterial, Raycaster, SphereGeometry, Vector2, Vector3 } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export function targetWorldPosition(base, offset) {
  return base.map((value, i) => value + offset[i]);
}

export function targetWorldOffset(base, position) {
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) return null;
  return position.map((value, i) => Math.max(-1, Math.min(1, value - base[i])));
}

export function setupTargetGizmo({ scene, camera, renderer, orbit, getTarget, moveTarget, button, note }) {
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
  let pointerId;

  const cancelDrag = () => {
    if (transform.dragging) transform.pointerUp(null);
    if (pointerId != null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    pointerId = undefined;
  };
  const select = (next) => {
    selected = Boolean(next && active);
    if (selected) transform.attach(anchor);
    else { cancelDrag(); transform.detach(); }
    if (button) button.textContent = selected ? 'Hide target handles' : 'Move target in 3D';
    marker.material.wireframe = !selected;
  };
  transform.addEventListener('dragging-changed', (event) => {
    if (event.value) { orbitWasEnabled = orbit.enabled; orbit.enabled = false; }
    else orbit.enabled = orbitWasEnabled;
  });
  transform.addEventListener('objectChange', () => {
    if (!active) return;
    const applied = moveTarget(anchor.position.toArray());
    if (applied) anchor.position.fromArray(applied);
  });
  const pickTarget = (event) => {
    if (!active || event.button !== 0) return;
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
  const escape = (event) => { if (event.key === 'Escape') select(false); };
  document.addEventListener('keydown', escape);
  const toggle = () => select(!selected);
  button?.addEventListener('click', toggle);

  const update = () => {
    const target = getTarget();
    active = Boolean(target?.available);
    anchor.visible = active;
    transform.enabled = active && selected;
    if (!active) select(false);
    else if (!transform.dragging) anchor.position.fromArray(target.position_world);
    helper.visible = active && selected;
    if (button) button.disabled = !active;
    if (note) note.textContent = !active
      ? 'Target handles become available after the live preview is ready.'
      : selected ? `Drag X (red), Y (green), or Z (blue) in world coordinates.${target.pending ? ' Preview updating…' : ''} Esc hides handles.`
        : 'Click the gold target in the workspace to show X / Y / Z handles.';
  };
  const project = (point) => {
    const position = point.clone().project(camera);
    const bounds = canvas.getBoundingClientRect();
    return [bounds.left + (position.x + 1) * bounds.width / 2, bounds.top + (1 - position.y) * bounds.height / 2];
  };
  update();
  return {
    update,
    get active() { return active; },
    get snapshot() {
      const handles = {};
      helper.updateMatrixWorld(true);
      helper.traverse((object) => {
        if (object.visible && object.isMesh && /^[XYZ]$/.test(object.name) && object.geometry.parameters?.radialSegments === 12 && !handles[object.name]) {
          handles[object.name] = project(new Box3().setFromObject(object).getCenter(new Vector3()));
        }
      });
      return { active, selected, dragging: transform.dragging, position_world: anchor.position.toArray(),
        target_screen: project(anchor.position), handles_screen: handles, orbit_enabled: orbit.enabled };
    },
    dispose() {
      cancelDrag();
      canvas.removeEventListener('pointerdown', pickTarget, true);
      document.removeEventListener('keydown', escape);
      button?.removeEventListener('click', toggle);
      transform.dispose();
      scene.remove(helper, anchor);
      marker.geometry.dispose();marker.material.dispose();
    },
  };
}
