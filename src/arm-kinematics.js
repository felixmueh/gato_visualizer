import { Euler, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';

export const DAMPING = 0.04; // m
export const ITERATIONS_PER_FRAME = 16;
export const ERROR_MAX = 0.05; // m
export const JOINT_STEP_MAX = 0.05; // rad per iteration
export const POSTURE_GAIN = 0.1;
export const POSITION_TOLERANCE = 1e-4; // m
export const STEP_TOLERANCE = 1e-7; // rad

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

/** base is the world matrix of chain.baseLink, read at the start of each drag. */
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
  return { grasp: new Vector3().setFromMatrixPosition(matrix).toArray(), origins, axes, orientations };
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

function inverseNormal(j, free, damping) {
  const entries = Array.from({ length: 3 }, (_, r) => Array.from({ length: 3 }, (_, s) => j[r].reduce((sum, v, i) => sum + (free[i] ? v * j[s][i] : 0), r === s ? damping * damping : 0)));
  return new Matrix3().set(...entries.flat()).invert();
}
const solve3 = (matrix, vector) => new Vector3().fromArray(vector).applyMatrix3(matrix).toArray();
const transposeMultiply = (j, vector, free) => j[0].map((_, i) => free[i] ? j.reduce((sum, row, r) => sum + row[i] * vector[r], 0) : 0);

/** One deterministic bounded DLS frame, warm-started by the preceding frame. */
export function solveGraspIk(chain, base, { q: input, q0, target, lower, upper,
  damping = DAMPING, iterations = ITERATIONS_PER_FRAME, errorMax = ERROR_MAX,
  jointStepMax = JOINT_STEP_MAX, postureGain = POSTURE_GAIN,
  tolerance = POSITION_TOLERANCE } = {}) {
  const count = chain.origins.length;
  for (const [value, name] of [[input, 'Joint positions'], [q0, 'Drag-start positions'], [lower, 'Lower bounds'], [upper, 'Upper bounds']]) finiteVector(value, count, name);
  finiteVector(target, 3, 'Grasp target');
  if (!(damping > 0 && errorMax > 0 && jointStepMax > 0 && tolerance > 0 && postureGain >= 0 && Number.isInteger(iterations) && iterations >= 0) || ![damping, errorMax, jointStepMax, tolerance, postureGain].every(Number.isFinite)) throw new Error('Invalid IK options');
  if (lower.some((v, i) => v > upper[i])) throw new Error('IK bounds must be ordered');
  let q = input.map((v, i) => clamp(v, lower[i], upper[i])), used = 0, stalled = false;
  let fk = forwardKinematics(chain, base, q), gap = norm(difference(target, fk.grasp));
  for (; used < iterations && gap >= tolerance; used++) {
    const j = positionJacobian(fk), error = difference(target, fk.grasp).map(v => v * Math.min(1, errorMax / gap));
    const free = q.map((_, i) => Math.hypot(j[0][i], j[1][i], j[2][i]) > 1e-12);
    let task, posture, normal;
    for (let activeSet = 0; activeSet <= count; activeSet++) {
      normal = inverseNormal(j, free, damping);
      task = transposeMultiply(j, solve3(normal, error), free);
      const toward = q.map((v, i) => free[i] ? postureGain * (q0[i] - v) : 0);
      const correction = transposeMultiply(j, solve3(normal, j.map(row => row.reduce((sum, v, i) => sum + v * toward[i], 0))), free);
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
        nextFk = forwardKinematics(chain, base, next); nextGap = norm(difference(target, nextFk.grasp));
        const movement = Math.max(...difference(next, q).map(Math.abs));
        if (nextGap < gap - 1e-14 && (movement >= STEP_TOLERANCE || nextGap < tolerance)) { accepted = true; break; }
      }
      if (accepted) break;
    }
    if (!accepted) { stalled = true; used++; break; }
    const moved = Math.max(...difference(next, q).map(Math.abs));
    q = next; fk = nextFk; gap = nextGap;
    if (moved < STEP_TOLERANCE) { stalled = true; used++; break; }
  }
  return { q, achieved: fk.grasp, gap_m: gap, iterations: used, converged: gap < tolerance, stalled };
}
