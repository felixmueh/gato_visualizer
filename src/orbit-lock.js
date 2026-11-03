// The one owner of OrbitControls.enabled for the viewport's gizmos (Felix's camera bug,
// 2026-10-30). OrbitControls registers its pointerdown first, so a press on a gizmo handle
// starts its own rotate (or, with Shift, pan) gesture before the gizmo disables it. If orbit
// came back while that button was still held, for example because a drag was cancelled
// when Live turned gpu_busy, OrbitControls resumed the gesture from the press and swung the
// camera with the pointer. So:
// - a press on a gizmo handle (a guard says so) disables orbit before OrbitControls sees it;
// - holds are counted, so the task gizmo and the joint editor never restore each other's state;
// - orbit comes back only when no hold remains and the pointer pressed on the viewport is up.
export function createOrbitLock(orbit, element) {
  const holds = new Set(), down = new Set(), guards = [];
  let restoreTo = null, guarded = false;
  function settle() {
    if (holds.size || guarded) {
      if (restoreTo === null) restoreTo = orbit.enabled;
      orbit.enabled = false;
    } else if (restoreTo !== null && !down.size) {
      orbit.enabled = restoreTo; restoreTo = null;
    }
  }
  function press(event) {
    if (event.button !== 0) return;
    if (event.isPrimary !== false) { down.clear(); guarded = false; }  // a new press ends any unseen one
    down.add(event.pointerId);
    if (guards.some(guard => guard(event))) guarded = true;
    settle();
  }
  function lift(event) {
    if (!down.delete(event.pointerId)) return;
    if (!down.size) guarded = false;
    settle();
  }
  // A release outside the viewport (capture lost) arrives on the document; a move without
  // buttons means it was missed altogether.
  function move(event) { if (down.size && event.buttons === 0) { down.clear(); guarded = false; settle(); } }
  const releases = element.ownerDocument ?? globalThis.document;
  element.addEventListener('pointerdown', press, true);
  element.addEventListener('pointermove', move, true);
  for (const name of ['pointerup', 'pointercancel']) releases?.addEventListener(name, lift, true);
  return {
    hold(key) { holds.add(key); settle(); },
    release(key) { holds.delete(key); settle(); },
    /** guard(event) → whether a press there hits this tool's handle. */
    addGuard(guard) { guards.push(guard); return () => { const i = guards.indexOf(guard); if (i >= 0) guards.splice(i, 1); }; },
    get snapshot() { return { holds: [...holds], pressed: down.size, guarded, orbit_enabled: orbit.enabled }; },
    dispose() {
      element.removeEventListener('pointerdown', press, true);
      element.removeEventListener('pointermove', move, true);
      for (const name of ['pointerup', 'pointercancel']) releases?.removeEventListener(name, lift, true);
    },
  };
}
