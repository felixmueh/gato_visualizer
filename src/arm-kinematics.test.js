import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DOMParser, Document, Element } from 'linkedom';
import URDFLoader from 'urdf-loader';
import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { angularJacobian, armChain, forwardKinematics, positionJacobian, solveGraspIk, ikBounds, ITERATIONS_PER_FRAME,
  ORIENTATION_LENGTH, POSITION_TOLERANCE } from './arm-kinematics.js';
import { quaternionToRotvec, relativeRotvec, rotvecToQuaternion } from './rotations.js';

Object.assign(globalThis, { DOMParser, Document, Element });
const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/grasp_fk.json', import.meta.url)));
const mpcRoot = process.env.TIAGO_MPC_ROOT || fileURLToPath(new URL('../../tiago_mpc/.worktrees/visualizer-base', import.meta.url));
const path = resolve(mpcRoot, 'models/tiago_pro/tiago_pro.urdf');
let xml;
try { xml = readFileSync(path, 'utf8'); } catch (error) { throw new Error(`Browser FK reference needs the selected full URDF at ${path}; set TIAGO_MPC_ROOT to a prepared checkout`, { cause: error }); }
const digest = createHash('sha256').update(xml).digest('hex');
const staleHint = digest === fixture.full_urdf_sha256 ? '' : ' Full URDF hash differs: rerun scripts/grasp_fk_fixture.py.';
const loader = new URDFLoader(); loader.parseVisual = loader.parseCollision = false;
const robot = loader.parse(xml), chain = armChain(robot, { jointNames: fixture.joint_names, grasp: fixture.grasp });
robot.updateMatrixWorld(true);
const base = chain.baseLink.matrixWorld.clone(), identity = new Matrix4();
const start = fixture.poses[0].q, raw = { lower: fixture.lower, upper: fixture.upper };
const error = (a, b) => Math.max(...a.flat(Infinity).map((v, i) => Math.abs(v - b.flat(Infinity)[i])));
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

test('browser FK and native position Jacobian match 80 Pinocchio poses in torso and world frames', t => {
  let maxPosition = 0, maxJacobian = 0, maxDifference = 0;
  for (const pose of fixture.poses) {
    const fk = forwardKinematics(chain, identity, pose.q), world = forwardKinematics(chain, base, pose.q);
    const j = positionJacobian(fk);
    const positionError = Math.max(error(fk.grasp, pose.grasp_torso_m), error(world.grasp, pose.grasp_world_m));
    const jacobianError = error(j, pose.jacobian_torso);
    maxPosition = Math.max(maxPosition, positionError); maxJacobian = Math.max(maxJacobian, jacobianError);
    assert.ok(positionError < 1e-6, `${pose.label}: FK error ${positionError} m.${staleHint}`);
    assert.ok(jacobianError < 1e-6, `${pose.label}: Jacobian error ${jacobianError}.${staleHint}`);
    pose.q.forEach((_, i) => {
      const lo = [...pose.q], hi = [...pose.q], h = 1e-6; lo[i] -= h; hi[i] += h;
      const p0 = forwardKinematics(chain, identity, lo).grasp, p1 = forwardKinematics(chain, identity, hi).grasp;
      const finiteDifference = p1.map((v, r) => (v - p0[r]) / (2 * h));
      const delta = error(finiteDifference, j.map(row => row[i]));
      maxDifference = Math.max(maxDifference, delta);
      assert.ok(delta < 1e-6, `${pose.label}, joint ${i+1}: central-difference error ${delta}`);
    });
    fixture.joint_names.forEach((name, i) => robot.setJointValue(name, pose.q[i]));
    robot.updateMatrixWorld(true);
    const loadedPoint = new Vector3().fromArray(fixture.grasp.xyz).applyMatrix4(robot.links[fixture.grasp.parent_link].matrixWorld).toArray();
    assert.ok(error(loadedPoint, world.grasp) < 1e-9, `${pose.label}: displayed URDF differs from the pure FK`);
  }
  assert.deepEqual(chain.axes[5], [0, 0, -1]);
  t.diagnostic(JSON.stringify({ poses: fixture.poses.length, tiago_mpc_commit: fixture.tiago_mpc_commit, maxPosition_m: maxPosition, maxJacobian, maxCentralDifference: maxDifference }));
});

test('chain extraction preserves nonzero loaded poses and rejects unsupported topology and axes', () => {
  const before = robot.joints.arm_right_6_joint.angle;
  const reread = armChain(robot, { jointNames: fixture.joint_names, grasp: fixture.grasp });
  assert.equal(error(forwardKinematics(reread, identity, start).grasp, forwardKinematics(chain, identity, start).grasp), 0);
  assert.equal(robot.joints.arm_right_6_joint.angle, before);
  const joint = robot.joints.arm_right_6_joint, axis = joint.axis.clone();
  joint.axis.set(1, 0, 0);
  assert.throws(() => armChain(robot, { jointNames: fixture.joint_names, grasp: fixture.grasp }), /Unsupported native arm axis/);
  joint.axis.copy(axis);
  const link = robot.joints.arm_right_2_joint.parent;
  link.position.x = .01;
  assert.throws(() => armChain(robot, { jointNames: fixture.joint_names, grasp: fixture.grasp }), /Unsupported arm topology/);
  link.position.x = 0; link.updateMatrix();
  assert.throws(() => armChain(robot, { jointNames: fixture.joint_names, grasp: { ...fixture.grasp, parent_link: 'missing' } }), /grasp parent/);
});

function converge(target, { q0 = start, lower = raw.lower, upper = raw.upper, frames = 100, postureGain, initial = q0 } = {}) {
  let q = [...initial], previous = Infinity, result;
  for (let frame = 1; frame <= frames; frame++) {
    result = solveGraspIk(chain, identity, { q, q0, target, lower, upper, ...(postureGain == null ? {} : { postureGain }) });
    assert.ok(result.gap_m <= previous + 1e-12, `error grew on frame ${frame}: ${previous} -> ${result.gap_m}`);
    assert.ok(result.iterations <= ITERATIONS_PER_FRAME);
    result.q.forEach((v, i) => assert.ok(v >= lower[i] && v <= upper[i], `joint ${i+1} outside bounds`));
    q = result.q; previous = result.gap_m;
    if (result.converged || result.stalled) return { ...result, frames: frame };
  }
  return { ...result, frames };
}

test('a nearby position target converges below 0.1 mm in a few frames and leaves joint 7 untouched', t => {
  const goal = start.map((v, i) => v + [0.1, 0.08, -0.1, 0.1, 0.04, 0.06, 0][i]);
  const result = converge(forwardKinematics(chain, identity, goal).grasp);
  assert.ok(result.converged, `gap ${result.gap_m} after ${result.frames} frames`);
  assert.ok(result.frames <= 8, `${result.frames} frames`);
  assert.equal(result.q[6], start[6]);
  t.diagnostic(JSON.stringify({ nearbyFrames: result.frames, nearbyGap_m: result.gap_m }));
});

test('out-of-reach targets descend monotonically, respect bounds and stall with a visible gap', t => {
  const result = converge([4, -3, 5], { frames: 300 });
  assert.equal(result.converged, false);
  assert.equal(result.stalled, true);
  assert.ok(result.gap_m > 1);
  assert.equal(result.q[6], start[6]);
  t.diagnostic(JSON.stringify({ unreachableFrames: result.frames, unreachableGap_m: result.gap_m, stalled: result.stalled }));
});

test('planning-box bounds apply per joint only when it started inside the box', () => {
  const box = { lower_position_rad: raw.lower.map(v => v + .1), upper_position_rad: raw.upper.map(v => v - .1) };
  const q0 = [...start]; q0[3] = raw.lower[3] + .01;
  const bounds = ikBounds(q0, raw, box);
  assert.equal(bounds.lower[3], raw.lower[3]); assert.equal(bounds.upper[3], raw.upper[3]);
  q0.forEach((_, i) => { if (i !== 3) { assert.equal(bounds.lower[i], box.lower_position_rad[i]); assert.equal(bounds.upper[i], box.upper_position_rad[i]); } });
  const result = converge(forwardKinematics(chain, identity, fixture.poses[1].q).grasp, { lower: bounds.lower, upper: bounds.upper, q0 });
  result.q.forEach((v, i) => assert.ok(v >= bounds.lower[i] && v <= bounds.upper[i]));
  assert.deepEqual(ikBounds(start, raw, null), raw);
});

test('zero-error targets leave q unchanged; posture keeps a redundant reach closer to its starting pose', () => {
  const origin = forwardKinematics(chain, identity, start).grasp;
  const unchanged = solveGraspIk(chain, identity, { q: start, q0: start, target: origin, ...raw });
  assert.deepEqual(unchanged.q, start); assert.equal(unchanged.iterations, 0); assert.equal(unchanged.converged, true);
  const target = forwardKinematics(chain, identity, fixture.poses[1].q).grasp;
  const posture = converge(target), plain = converge(target, { postureGain: 0 });
  assert.ok(posture.converged && plain.converged, `${posture.gap_m}, ${plain.gap_m}`);
  assert.ok(distance(posture.q, start) < distance(plain.q, start), `${distance(posture.q, start)} >= ${distance(plain.q, start)}`);
});

test('IK is deterministic, bounds every step, and rejects non-finite targets and invalid bounds', () => {
  const options = { q: start, q0: start, target: fixture.poses[1].grasp_torso_m, ...raw };
  assert.deepEqual(solveGraspIk(chain, identity, options), solveGraspIk(chain, identity, options));
  assert.throws(() => solveGraspIk(chain, identity, { ...options, target: [NaN, 0, 0] }), /finite/);
  assert.throws(() => solveGraspIk(chain, identity, { ...options, lower: raw.upper, upper: raw.lower }), /ordered/);
  const result = solveGraspIk(chain, identity, { ...options, iterations: 1 });
  assert.ok(Math.max(...result.q.map((v, i) => Math.abs(v - start[i]))) <= .05 + 1e-12);
});


// Six-dimensional grasp IK: position plus orientation (rotation vector scaled by
// ORIENTATION_LENGTH, metres per radian).
const angle = (a, b) => Math.hypot(...relativeRotvec(a, b));
const quaternionOf = rows => new Quaternion().setFromRotationMatrix(new Matrix4().setFromMatrix3(new Matrix3().set(...rows.flat()))).toArray();
const turned = (quaternion, axis, radians) => new Quaternion().setFromAxisAngle(new Vector3(...axis), radians).multiply(new Quaternion(...quaternion)).toArray();

test('browser grasp orientation and rotation Jacobian rows match Pinocchio in torso and world frames', t => {
  let maxAngle = 0, maxAngular = 0;
  for (const pose of fixture.poses) {
    const fk = forwardKinematics(chain, identity, pose.q), world = forwardKinematics(chain, base, pose.q);
    const torsoAngle = angle(fk.rotation, quaternionOf(pose.rotation_torso));
    const worldAngle = angle(world.rotation, rotvecToQuaternion(pose.rotvec_world));
    const angularError = error(angularJacobian(fk), pose.angular_jacobian_torso);
    maxAngle = Math.max(maxAngle, torsoAngle, worldAngle); maxAngular = Math.max(maxAngular, angularError);
    assert.ok(torsoAngle < 1e-6 && worldAngle < 1e-6, `${pose.label}: orientation error ${torsoAngle}, ${worldAngle} rad.${staleHint}`);
    assert.ok(angularError < 1e-6, `${pose.label}: rotation Jacobian error ${angularError}.${staleHint}`);
  }
  t.diagnostic(JSON.stringify({ maxOrientation_rad: maxAngle, maxAngularJacobian: maxAngular }));
});

function converge6(target, orientation, { q0 = start, lower = raw.lower, upper = raw.upper, frames = 100, initial = q0, ...options } = {}) {
  let q = [...initial], previous = Infinity, result;
  for (let frame = 1; frame <= frames; frame++) {
    result = solveGraspIk(chain, identity, { q, q0, target, orientation, lower, upper, ...options });
    assert.ok(result.error_m <= previous + 1e-12, `weighted error grew on frame ${frame}: ${previous} -> ${result.error_m}`);
    result.q.forEach((v, i) => assert.ok(v >= lower[i] && v <= upper[i], `joint ${i+1} outside bounds on frame ${frame}`));
    q = result.q; previous = result.error_m;
    if (result.converged || result.stalled) return { ...result, frames: frame };
  }
  return { ...result, frames };
}

test('a nearby grasp pose converges in position and orientation within a few frames', t => {
  const goal = start.map((v, i) => v + [0.1, 0.08, -0.1, 0.1, 0.04, 0.06, 0.3][i]), pose = forwardKinematics(chain, identity, goal);
  const result = converge6(pose.grasp, pose.rotation);
  assert.ok(result.converged && !result.stalled, `gap ${result.gap_m} m, ${result.orientation_gap_rad} rad after ${result.frames} frames`);
  assert.ok(result.gap_m < POSITION_TOLERANCE && result.orientation_gap_rad < POSITION_TOLERANCE / ORIENTATION_LENGTH);
  assert.ok(result.frames <= 10, `${result.frames} frames`);
  assert.notEqual(result.q[6], start[6]);  // joint 7 turns the gripper about its approach axis
  assert.ok(angle(result.achieved_quaternion, pose.rotation) === result.orientation_gap_rad);
  t.diagnostic(JSON.stringify({ frames6d: result.frames, gap_m: result.gap_m, orientation_gap_rad: result.orientation_gap_rad }));
});

test('a rotation about the gripper axis turns the gripper and holds the grasp point', () => {
  const pose = forwardKinematics(chain, identity, start), approach = new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...pose.rotation)).toArray();
  const goal = turned(pose.rotation, approach, .6);
  const result = converge6(pose.grasp, goal);
  assert.ok(result.converged, `${result.gap_m} m, ${result.orientation_gap_rad} rad`);
  assert.ok(result.gap_m < POSITION_TOLERANCE);
  // The least-squares step shares the turn between joint 7 and the other wrist joints.
  assert.ok(Math.abs(result.q[6] - start[6]) > .1, `joint 7 moved ${result.q[6] - start[6]}`);
});

test('an unreachable pose stalls on a weighted compromise; the weighting decides position against orientation', t => {
  const pose = forwardKinematics(chain, identity, start), goal = turned(pose.rotation, [1, 0, 0], 2.5);
  const far = converge6([2, -1, 1], goal, { frames: 400 });
  assert.equal(far.converged, false); assert.equal(far.stalled, true);
  assert.ok(far.gap_m > 1 && far.orientation_gap_rad > .5, `${far.gap_m} m, ${far.orientation_gap_rad} rad`);
  // Out of reach: weighting orientation more keeps more of the orientation goal and gives up position.
  const reach = forwardKinematics(chain, identity, fixture.poses[1].q).grasp, heavy = { frames: 400 };
  const positionFirst = converge6(reach.map((v, i) => v + [.25, 0, .15][i]), goal, { ...heavy, orientationLength: .02 });
  const orientationFirst = converge6(reach.map((v, i) => v + [.25, 0, .15][i]), goal, { ...heavy, orientationLength: .5 });
  assert.ok(!positionFirst.converged && !orientationFirst.converged);
  assert.ok(orientationFirst.orientation_gap_rad < positionFirst.orientation_gap_rad, `${orientationFirst.orientation_gap_rad} >= ${positionFirst.orientation_gap_rad}`);
  assert.ok(positionFirst.gap_m < orientationFirst.gap_m, `${positionFirst.gap_m} >= ${orientationFirst.gap_m}`);
  t.diagnostic(JSON.stringify({ far: [far.gap_m, far.orientation_gap_rad, far.frames],
    positionFirst: [positionFirst.gap_m, positionFirst.orientation_gap_rad], orientationFirst: [orientationFirst.gap_m, orientationFirst.orientation_gap_rad] }));
});

test('joint bounds hold at every iteration; a pose beyond them stalls with joints at their bounds', () => {
  const q0 = [...start], lower = q0.map(v => v - .05), upper = q0.map(v => v + .05);
  const pose = forwardKinematics(chain, identity, start.map((v, i) => v + [.3, -.3, .3, .3, -.3, .3, .3][i]));
  const result = converge6(pose.grasp, pose.rotation, { lower, upper, frames: 200 });
  assert.equal(result.converged, false); assert.equal(result.stalled, true);
  assert.ok(result.q.some((v, i) => v === lower[i] || v === upper[i]), 'no joint reached its bound');
  // A joint starting at its bound stays within it while the others reach a nearby pose.
  const atLimit = [...start]; atLimit[3] = raw.upper[3];
  const nearby = forwardKinematics(chain, identity, atLimit.map((v, i) => v + [.05, .05, -.05, 0, .05, .05, .1][i]));
  const bounded = converge6(nearby.grasp, nearby.rotation, { q0: atLimit, initial: atLimit });
  assert.ok(bounded.q[3] <= raw.upper[3]);
});

test('orientation goals are validated; without one the solver stays position-only', () => {
  const pose = forwardKinematics(chain, identity, start), options = { q: start, q0: start, target: pose.grasp, ...raw };
  for (const orientation of [[0, 0, 0, 0], [NaN, 0, 0, 1], [0, 0, 1]]) {
    assert.throws(() => solveGraspIk(chain, identity, { ...options, orientation }), /orientation/i);
  }
  assert.throws(() => solveGraspIk(chain, identity, { ...options, orientation: pose.rotation, orientationLength: 0 }), /Invalid IK options/);
  const plain = solveGraspIk(chain, identity, options);
  assert.equal(plain.orientation_gap_rad, null); assert.equal(plain.iterations, 0);
  const scaled = solveGraspIk(chain, identity, { ...options, orientation: pose.rotation.map(v => 3 * v) });  // any length: normalized
  assert.ok(scaled.converged); assert.ok(scaled.orientation_gap_rad < 1e-9);
  const rotvec = quaternionToRotvec(pose.rotation);
  assert.ok(angle(rotvecToQuaternion(rotvec), pose.rotation) < 1e-12);
});
