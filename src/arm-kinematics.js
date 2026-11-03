import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { relativeRotvec } from './rotations.js';

export const DAMPING = 0.04; // m
export const ITERATIONS_PER_FRAME = 16;
export const ERROR_MAX = 0.05; // m
export const JOINT_STEP_MAX = 0.05; // rad per iteration
export const POSTURE_GAIN = 0.1;
export const POSITION_TOLERANCE = 1e-4; // m
export const STEP_TOLERANCE = 1e-7; // rad
// With an orientation goal the task error is six-dimensional: the position gap in metres,
// then the rotation vector to the goal in radians times this length, so 1 rad weighs as
// much as 0.1 m (1° as 1.7 mm). Damping, clamps and the tolerance then apply to one error in
// metres; convergence (1e-4 m) means within 0.1 mm and 1 mrad (0.06°).
export const ORIENTATION_LENGTH = 0.1; // m per rad

const finiteVector = (value, count, name) => {
  if (!Array.isArray(value) || value.length !== count || !value.every(Number.isFinite)) throw new Error(`${name} must contain ${count} finite numbers`);
  return value;
};
const identity = matrix => matrix.elements.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-12);
const originOf = joint => new Matrix4().compose(joint.origPosition || joint.position, joint.origQuaternion || joint.quaternion, new Vector3(1, 1, 1));

/** Extract native-coordinate arm kinematics from the very robot being displayed. */
export function armChain(robot, { jointNames, grasp }) {
  if (!Array.isArray(jointNames) || jointNames.length !== 7) throw new Error('Expected seven native arm joints');
  if (!grasp || !robot.links[grasp.parent_link]) throw new Error('Missing grasp parent link');
  finiteVector(grasp.xyz, 3, 'Grasp xyz'); finiteVector(grasp.rpy, 3, 'Grasp rpy');
  const joints = jointNames.map(name => {
    const joint = robot.joints[name];
    if (!joint || joint.jointType !== 'revolute') throw new Error(`Expected revolute arm joint: ${name}`);
    const a = joint.axis;
    if (Math.abs(a.x) > 1e-12 || Math.abs(a.y) > 1e-12 || Math.abs(Math.abs(a.z) - 1) > 1e-12) throw new Error(`Unsupported native arm axis: ${name}`);
    return joint;
  });
  const origins = joints.map(originOf), axes = joints.map(joint => joint.axis.toArray());
  joints.forEach((joint, i) => {
    if (i === 0) return;
    const link = joint.parent;
    link.updateMatrix();
    if (!link.isURDFLink || link.parent !== joints[i - 1] || !identity(link.matrix)) throw new Error(`Unsupported arm topology at ${jointNames[i]}`);
  });
  const tail = [];
  let node = robot.links[grasp.parent_link];
  while (node && node !== joints.at(-1)) {
    if (node.isURDFJoint && node.jointType !== 'fixed') throw new Error('Grasp must follow only fixed joints after arm joint 7');
    node.updateMatrix();
    tail.push(node.isURDFJoint ? originOf(node) : node.matrix.clone());
    node = node.parent;
  }
  if (!node) throw new Error('Grasp parent does not descend from arm joint 7');
  const end = new Matrix4();
  tail.reverse().forEach(matrix => end.multiply(matrix));
  end.multiply(new Matrix4().compose(new Vector3().fromArray(grasp.xyz), new Quaternion().setFromEuler(new Euler(...grasp.rpy, 'ZYX')), new Vector3(1, 1, 1)));
  return { jointNames: [...jointNames], joints, origins, axes, end, baseLink: joints[0].parent };
}

/** base is the world matrix of chain.baseLink, read at the start of each drag. The grasp
 * frame's orientation is a quaternion [x, y, z, w] in base's frame. */
export function forwardKinematics(chain, base, q) {
  finiteVector(q, chain.origins.length, 'Joint positions');
  const matrix = base.clone(), origins = [], axes = [], orientations = [];
  const axis = new Vector3(), turn = new Matrix4(), rotation = new Quaternion();
  for (let i = 0; i < q.length; i++) {
    matrix.multiply(chain.origins[i]);
    origins.push(new Vector3().setFromMatrixPosition(matrix).toArray());
    axes.push(axis.fromArray(chain.axes[i]).transformDirection(matrix).toArray());
    orientations.push(new Quaternion().setFromRotationMatrix(matrix).toArray());
    matrix.multiply(turn.makeRotationFromQuaternion(rotation.setFromAxisAngle(axis.fromArray(chain.axes[i]), q[i])));
  }
  matrix.multiply(chain.end);
  return { grasp: new Vector3().setFromMatrixPosition(matrix).toArray(), rotation: new Quaternion().setFromRotationMatrix(matrix).toArray(),
    origins, axes, orientations };
}

/** Position rows of the world-aligned geometric Jacobian, in native joint order. */
export function positionJacobian(fk) {
  const result = [[], [], []];
  fk.axes.forEach((axis, i) => {
    const column = new Vector3().fromArray(axis).cross(new Vector3().fromArray(fk.grasp).sub(new Vector3().fromArray(fk.origins[i])));
    column.toArray().forEach((value, row) => { result[row][i] = value; });
  });
  return result;
}

/** Rotation rows of the world-aligned geometric Jacobian: each joint's axis. */
export function angularJacobian(fk) {
  return [0, 1, 2].map(row => fk.axes.map(axis => axis[row]));
}

/** Keep joints already in the planning box inside it; allow raw limits otherwise. */
export function ikBounds(q0, raw, planningBox) {
  const lo = raw.lower || raw.lower_position_rad, hi = raw.upper || raw.upper_position_rad;
  finiteVector(lo, q0.length, 'Raw lower bounds'); finiteVector(hi, q0.length, 'Raw upper bounds');
  const boxLo = planningBox?.lower || planningBox?.lower_position_rad, boxHi = planningBox?.upper || planningBox?.upper_position_rad;
  const inside = i => Number.isFinite(boxLo?.[i]) && Number.isFinite(boxHi?.[i]) && boxLo[i] <= boxHi[i] && q0[i] >= boxLo[i] && q0[i] <= boxHi[i];
  return { lower: q0.map((_, i) => inside(i) ? Math.max(lo[i], boxLo[i]) : lo[i]),
    upper: q0.map((_, i) => inside(i) ? Math.min(hi[i], boxHi[i]) : hi[i]) };
}

const norm = value => Math.hypot(...value);
const difference = (a, b) => a.map((v, i) => v - b[i]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// The damped normal matrix J_f J_fᵀ + λ² I of the free joints' columns (3×3 or 6×6).
function dampedNormal(j, free, damping) {
  return j.map((row, r) => j.map((other, s) => row.reduce((sum, v, i) => sum + (free[i] ? v * other[i] : 0), r === s ? damping * damping : 0)));
}
// Gaussian elimination with partial pivoting; the damped normal matrix is positive definite.
function solveLinear(matrix, vector) {
  const n = vector.length, a = matrix.map((row, i) => [...row, vector[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    for (let r = c + 1; r < n; r++) {
      const factor = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= factor * a[c][k];
    }
  }
  const x = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) x[r] = (a[r][n] - a[r].slice(r + 1, n).reduce((sum, v, k) => sum + v * x[r + 1 + k], 0)) / a[r][r];
  return x;
}
const transposeMultiply = (j, vector, free) => j[0].map((_, i) => free[i] ? j.reduce((sum, row, r) => sum + row[i] * vector[r], 0) : 0);

/** One deterministic bounded DLS frame, warm-started by the preceding frame, toward a grasp
 * position and, with orientation (a quaternion [x, y, z, w] in base's frame), the grasp
 * frame's orientation too (ORIENTATION_LENGTH). gap_m is the position gap and
 * orientation_gap_rad the angle to the orientation goal (null without one). */
export function solveGraspIk(chain, base, { q: input, q0, target, orientation = null, lower, upper,
  damping = DAMPING, iterations = ITERATIONS_PER_FRAME, errorMax = ERROR_MAX,
  jointStepMax = JOINT_STEP_MAX, postureGain = POSTURE_GAIN,
  tolerance = POSITION_TOLERANCE, orientationLength = ORIENTATION_LENGTH } = {}) {
  const count = chain.origins.length;
  for (const [value, name] of [[input, 'Joint positions'], [q0, 'Drag-start positions'], [lower, 'Lower bounds'], [upper, 'Upper bounds']]) finiteVector(value, count, name);
  finiteVector(target, 3, 'Grasp target');
  let goal = null;
  if (orientation != null) {
    finiteVector(orientation, 4, 'Grasp orientation');
    const length = Math.hypot(...orientation);
    if (!(length > 1e-12) || !Number.isFinite(length)) throw new Error('Grasp orientation must be a finite nonzero quaternion');
    goal = orientation.map(v => v / length);
  }
  if (!(damping > 0 && errorMax > 0 && jointStepMax > 0 && tolerance > 0 && postureGain >= 0 && orientationLength > 0 && Number.isInteger(iterations) && iterations >= 0) || ![damping, errorMax, jointStepMax, tolerance, postureGain, orientationLength].every(Number.isFinite)) throw new Error('Invalid IK options');
  if (lower.some((v, i) => v > upper[i])) throw new Error('IK bounds must be ordered');
  // The task error in metres: the position gap, then with an orientation goal the
  // rotation vector to it (world frame) times orientationLength; the Jacobian rows match.
  const residual = fk => goal ? [...difference(target, fk.grasp), ...relativeRotvec(goal, fk.rotation).map(v => v * orientationLength)]
    : difference(target, fk.grasp);
  const jacobian = fk => goal ? [...positionJacobian(fk), ...angularJacobian(fk).map(row => row.map(v => v * orientationLength))]
    : positionJacobian(fk);
  let q = input.map((v, i) => clamp(v, lower[i], upper[i])), used = 0, stalled = false;
  let fk = forwardKinematics(chain, base, q), residualNow = residual(fk), gap = norm(residualNow);
  for (; used < iterations && gap >= tolerance; used++) {
    const j = jacobian(fk), error = residualNow.map(v => v * Math.min(1, errorMax / gap));
    const free = q.map((_, i) => Math.hypot(...j.map(row => row[i])) > 1e-12);
    let task, posture, normal;
    for (let activeSet = 0; activeSet <= count; activeSet++) {
      normal = dampedNormal(j, free, damping);
      task = transposeMultiply(j, solveLinear(normal, error), free);
      const toward = q.map((v, i) => free[i] ? postureGain * (q0[i] - v) : 0);
      const correction = transposeMultiply(j, solveLinear(normal, j.map(row => row.reduce((sum, v, i) => sum + v * toward[i], 0))), free);
      posture = toward.map((v, i) => v - correction[i]);
      let changed = false;
      q.forEach((v, i) => {
        const dq = task[i] + posture[i];
        if (free[i] && ((v <= lower[i] + 1e-12 && dq < 0) || (v >= upper[i] - 1e-12 && dq > 0))) { free[i] = false; changed = true; }
      });
      if (!changed) break;
    }
    let accepted = false, next, nextFk, nextGap;
    // Damping leaks posture into task space. Backtracking, then a task-only
    // fallback, preserves descent when a target or a bound is out of reach.
    for (const gain of [1, 0]) {
      const step = task.map((v, i) => v + gain * posture[i]);
      const cap = Math.min(1, jointStepMax / Math.max(...step.map(Math.abs), 1e-30));
      for (let backtrack = 0; backtrack < 10; backtrack++) {
        const scale = cap * 2 ** -backtrack;
        next = q.map((v, i) => clamp(v + scale * step[i], lower[i], upper[i]));
        nextFk = forwardKinematics(chain, base, next); nextGap = norm(residual(nextFk));
        const movement = Math.max(...difference(next, q).map(Math.abs));
        if (nextGap < gap - 1e-14 && (movement >= STEP_TOLERANCE || nextGap < tolerance)) { accepted = true; break; }
      }
      if (accepted) break;
    }
    if (!accepted) { stalled = true; used++; break; }
    const moved = Math.max(...difference(next, q).map(Math.abs));
    q = next; fk = nextFk; gap = nextGap; residualNow = residual(fk);
    if (moved < STEP_TOLERANCE) { stalled = true; used++; break; }
  }
  return { q, achieved: fk.grasp, achieved_quaternion: fk.rotation, gap_m: norm(difference(target, fk.grasp)),
    orientation_gap_rad: goal ? norm(relativeRotvec(goal, fk.rotation)) : null, error_m: gap,
    iterations: used, converged: gap < tolerance, stalled };
}
