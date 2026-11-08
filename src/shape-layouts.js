// Obstacle layouts of tiago_mpc.collision.Collision (descriptor kind shapes), without three.js:
//   sphere  [x, y, z, r]
//   capsule [ax, ay, az, bx, by, bz, r]
//   box     [cx, cy, cz, qx, qy, qz, qw, hx, hy, hz]  quaternion xyzw, half-extents
//   plane   [nx, ny, nz, d]                           the free side is n·p ≥ d
// lines: the settings table's rows per obstacle, each a caption and up to four value
// indices under the header's four columns (null leaves a column empty).
export const SHAPE_LAYOUTS = {
  sphere: { width: 4, header: ['x', 'y', 'z', 'r'], lines: [['', [0, 1, 2, 3]]], sizes: [3] },
  capsule: { width: 7, header: ['x', 'y', 'z', 'r'], lines: [['a', [0, 1, 2, null]], ['b', [3, 4, 5, 6]]], sizes: [6] },
  box: { width: 10, header: ['x', 'y', 'z', 'w'], lines: [['c', [0, 1, 2, null]], ['q', [3, 4, 5, 6]], ['h', [7, 8, 9, null]]], sizes: [7, 8, 9] },
  plane: { width: 4, header: ['x', 'y', 'z', 'd'], lines: [['n', [0, 1, 2, 3]]], sizes: [] },
};
// What each table caption means, for tooltips.
export const LINE_TITLES = { a: 'End a', b: 'End b and radius', c: 'Centre', q: 'Orientation quaternion (x, y, z, w)', h: 'Half-extents along the box axes', n: 'Unit normal and offset d (free side n·p ≥ d)' };

const finite = value => typeof value === 'number' && Number.isFinite(value);

/** Whether one obstacle fits its shape and the descriptor's bound and size limits. */
export function shapeValid(parameter, item) {
  const layout = SHAPE_LAYOUTS[parameter.shape];
  if (!layout || !Array.isArray(item) || item.length !== layout.width || !item.every(finite)) return false;
  const bound = parameter.bound ?? Infinity, low = parameter.min_size ?? 0, high = parameter.max_size ?? Infinity;
  const within = values => values.every(value => Math.abs(value) <= bound);
  const sized = layout.sizes.every(i => item[i] > low && item[i] <= high);
  if (parameter.shape === 'sphere') return within(item.slice(0, 3)) && sized;
  if (parameter.shape === 'capsule') return within(item.slice(0, 6)) && sized;
  if (parameter.shape === 'box') return within(item.slice(0, 3)) && Math.hypot(...item.slice(3, 7)) > 1e-9 && sized;
  return Math.hypot(...item.slice(0, 3)) > 1e-9 && within([item[3]]);
}

const round = (value, digits) => Number(value.toFixed(digits));
/** One obstacle kept within the descriptor: positions (and a plane's d) within ±bound,
 * sizes within (min_size, max_size]; rounded to 0.1 mm, a unit quaternion or normal to 1e-5. */
export function clampShape(parameter, values) {
  const layout = SHAPE_LAYOUTS[parameter.shape], bound = parameter.bound ?? Infinity;
  const low = (parameter.min_size ?? 0) + 1e-3, high = parameter.max_size ?? Infinity;
  const unit = (start, count) => { const length = Math.hypot(...values.slice(start, start + count)) || 1; return [length, i => round(values[i] / length, 5)]; };
  const [, quaternion] = parameter.shape === 'box' ? unit(3, 4) : [1, null];
  // A plane scales its offset with its normal: n·p ≥ d is n̂·p ≥ d / |n|.
  const [length, normal] = parameter.shape === 'plane' ? unit(0, 3) : [1, null];
  return values.map((value, i) => {
    if (layout.sizes.includes(i)) return round(Math.min(high, Math.max(low, value)), 4);
    if (quaternion && i >= 3 && i < 7) return quaternion(i);
    if (normal && i < 3) return normal(i);
    return round(Math.max(-bound, Math.min(bound, normal ? value / length : value)), 4);
  });
}
