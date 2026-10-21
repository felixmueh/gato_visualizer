// Desired task geometry is independent of optimizer predictions. Keep this
// lightweight so a gizmo edit can redraw before any server round trip.
export function taskReferencePoint(task, base, time_s = 0) {
  if (!task || !Array.isArray(base) || base.length !== 3 || !base.every(Number.isFinite)) return null;
  const offset = task.target_offset_m;
  if (!Array.isArray(offset) || offset.length !== 3 || !offset.every(Number.isFinite)) return null;
  const anchor = base.map((value, i) => value + offset[i]);
  if (task.kind === 'reach') return anchor;
  if (task.kind !== 'figure8' || ![task.width_m, task.height_m].every(value => Number.isFinite(value) && value > 0)) return null;
  const q = task.orientation_xyzw || [0, 0, 0, 1];
  if (!Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite)) return null;
  const norm = Math.hypot(...q);
  if (!Number.isFinite(norm) || norm < 1e-12) return null;
  const [x, y, z, w] = q.map(value => value / norm);
  if (!Number.isFinite(task.period_s) || task.period_s <= 0 || !Number.isFinite(time_s)) return null;
  const phase = 2 * Math.PI * time_s / task.period_s;
  const dx = .5 * task.width_m * (1 - Math.cos(phase));
  const dy = .5 * task.height_m * Math.sin(2 * phase);
  return [anchor[0] + (1 - 2 * (y*y + z*z)) * dx + 2 * (x*y - z*w) * dy,
    anchor[1] + 2 * (x*y + z*w) * dx + (1 - 2 * (x*x + z*z)) * dy,
    anchor[2] + 2 * (x*z - y*w) * dx + 2 * (y*z + x*w) * dy];
}

export function taskReference(task, base, samples = 257) {
  const anchor = taskReferencePoint(task, base);
  if (!anchor) return null;
  const count = Math.max(5, Math.floor(samples));
  const points = task.kind === 'reach' ? [anchor] : Array.from({ length: count }, (_, i) =>
    taskReferencePoint(task, base, task.period_s * i / (count - 1)));
  return { kind: task.kind, points, target_xyz: anchor, draft: true };
}
