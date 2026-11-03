// Orientations travel as rotation vectors (axis times angle, radians) in the full
// robot's root frame, as tiago_mpc's reference rows and the replay format hold them;
// three.js and the inverse kinematics use quaternions [x, y, z, w]. Pure functions.

export function rotvecToQuaternion(rotvec) {
  if (!Array.isArray(rotvec) || rotvec.length !== 3 || !rotvec.every(Number.isFinite)) return null;
  const angle = Math.hypot(...rotvec);
  if (angle < 1e-12) return [0, 0, 0, 1];
  const s = Math.sin(angle / 2) / angle;
  return [rotvec[0] * s, rotvec[1] * s, rotvec[2] * s, Math.cos(angle / 2)];
}

/** The rotation vector of a quaternion [x, y, z, w], with an angle of at most pi. */
export function quaternionToRotvec(quaternion) {
  if (!Array.isArray(quaternion) || quaternion.length !== 4 || !quaternion.every(Number.isFinite)) return null;
  const norm = Math.hypot(...quaternion);
  if (!(norm > 1e-12)) return null;
  const sign = quaternion[3] < 0 ? -1 : 1;
  const [x, y, z, w] = quaternion.map(value => sign * value / norm);
  const sine = Math.hypot(x, y, z);
  if (sine < 1e-12) return [0, 0, 0];
  const angle = 2 * Math.atan2(sine, w);
  return [x, y, z].map(value => value * angle / sine);
}

/** The angle in radians between two rotation vectors' rotations, |log(R_aᵀ R_b)|. */
export function rotationAngle(a, b) {
  const p = rotvecToQuaternion(a), q = rotvecToQuaternion(b);
  if (!p || !q) return null;
  const dot = Math.abs(p.reduce((sum, value, i) => sum + value * q[i], 0));
  return 2 * Math.acos(Math.min(1, dot));
}

/** The rotation vector of target · actual⁻¹ (world frame): the rotation that turns
 * actual into target, for two quaternions [x, y, z, w]. */
export function relativeRotvec(target, actual) {
  const [x1, y1, z1, w1] = target, [x2, y2, z2, w2] = actual;  // target times the conjugate of actual
  return quaternionToRotvec([w2 * x1 - w1 * x2 - y1 * z2 + z1 * y2, w2 * y1 - w1 * y2 - z1 * x2 + x1 * z2,
    w2 * z1 - w1 * z2 - x1 * y2 + y1 * x2, w1 * w2 + x1 * x2 + y1 * y2 + z1 * z2]);
}
