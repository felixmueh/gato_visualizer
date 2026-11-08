import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Scene, Vector3 } from 'three';
import { URDFJoint, URDFLink } from 'urdf-loader/src/URDFClasses.js';
import { createTrackScene, trackDisplayPath, trackReferencesDiffer, TRACK_OPACITY, TRACK_OUTSIDE_OPACITY } from './track-scene.js';

function fixture({ gripper = false } = {}) {
  const scene = new Scene(), robot = new Group(), torso = new Group(), joint = new URDFJoint();
  joint.urdfName = 'arm_right_1_joint'; joint.jointType = 'revolute'; joint.axis.set(0, 0, 1); joint.setJointValue(0);
  joint.add(new Mesh(new BoxGeometry(.2, .2, .2), new MeshStandardMaterial()));
  if (gripper) {
    const finger = new URDFJoint(); finger.urdfName = 'gripper_right_finger_joint'; finger.jointType = 'prismatic';
    finger.axis.set(1, 0, 0); finger.limit.upper = .1; finger.setJointValue(.02); joint.add(finger);
  }
  torso.add(joint); robot.add(torso); robot.joints = { arm_right_1_joint: joint }; scene.add(robot);
  return { scene, robot, tracks: createTrackScene({ robot, scene, jointNames: ['arm_right_1_joint'] }) };
}
function track(id, overrides = {}) {
  return { id, kind: 'replay', color: 0xb48cff, offset_s: 1, visible: true, display: 'arm',
    motion: { time_s: [2, 4], q: [[0], [1]], ee_xyz: [[0, 0, 0], [2, 0, 0]], reference_xyz: [[2, 0, 0]] }, ...overrides };
}

test('track display resamples large paths evenly and preserves endpoints', () => {
  const points = Array.from({ length: 10000 }, (_, i) => [i, 0, 0]);
  const sampled = trackDisplayPath(points);
  assert.equal(sampled.length, 5000); assert.equal(sampled[0], points[0]); assert.equal(sampled.at(-1), points.at(-1));
  assert.equal(trackDisplayPath(points.slice(0, 2)).length, 2);
  assert.equal(trackReferencesDiffer([[1, 2, 3]], [[1, 2, 3], [1, 2, 3]]), false);
  assert.equal(trackReferencesDiffer([[0, 0, 0], [2, 0, 0]], [[0, 0, 0], [1, 0, 0], [2, 0, 0]]), false);
  assert.equal(trackReferencesDiffer([[0, 0, 0]], [[1, 0, 0]]), true);
});

test('tracks share session time, interpolate native data and hold dimmed endpoints', () => {
  const { tracks, scene } = fixture(), arm = track('arm'), dot = track('dot', { offset_s: 0, display: 'dot' });
  const mainReference = [[2, 0, 0]];
  tracks.update({ tracks: [{ id: 'live', kind: 'live' }, arm, dot], time: 4, mainReference });
  assert.equal(tracks.snapshot.ghostCount, 1); assert.equal(tracks.snapshot.dotCount, 1);
  assert.deepEqual(tracks.snapshot.sampled[0].q, [.5]); assert.deepEqual(tracks.snapshot.sampled[0].xyz, [1, 0, 0]);
  assert.equal(tracks.snapshot.sampled[0].time, 3); assert.equal(tracks.snapshot.sampled[0].opacity, TRACK_OPACITY);
  assert.equal(tracks.snapshot.referenceCount, 0);
  const geometry = scene.getObjectByName('track-path').geometry;
  tracks.update({ tracks: [arm, dot], time: 9, mainReference });
  assert.deepEqual(tracks.snapshot.sampled[0].q, [1]); assert.equal(tracks.snapshot.sampled[0].outside, true);
  assert.equal(tracks.snapshot.sampled[0].opacity, TRACK_OUTSIDE_OPACITY);
  assert.equal(scene.getObjectByName('track-path').geometry, geometry);
  tracks.update({ tracks: [arm], time: -2, mainReference });
  assert.deepEqual(tracks.snapshot.sampled[0].q, [0]); assert.equal(tracks.snapshot.dotCount, 0);
  tracks.dispose(); assert.equal(scene.getObjectByName('session-tracks'), undefined);
});

test('each arm keeps recorded base, visibility and display while references differ once', () => {
  const { tracks, scene } = fixture(), arm = track('arm');
  arm.motion.arm_base = [1, 0, 0, 3, 0, 1, 0, 0, 0, 0, 1, 2, 0, 0, 0, 1];
  tracks.update({ tracks: [arm], time: 4, mainReference: [[0, 0, 0]] });
  assert.equal(tracks.snapshot.referenceCount, 1);
  assert.equal(scene.getObjectByName('ghost-arm').matrix.elements[12], 3);
  arm.display = 'dot'; tracks.update({ tracks: [arm], time: 4 });
  assert.equal(tracks.snapshot.ghostCount, 0); assert.equal(tracks.snapshot.dotCount, 1);
  arm.visible = false; tracks.update({ tracks: [arm], time: 4 });
  assert.equal(tracks.snapshot.ghostCount, 0); assert.equal(tracks.snapshot.dotCount, 0); assert.equal(tracks.snapshot.pathCount, 0);
  arm.visible = true; arm.display = 'arm';
  tracks.update({ tracks: [arm], time: 4, visible: false }); assert.equal(tracks.snapshot.ghostCount, 0);
  tracks.update({ tracks: Array.from({ length: 30 }, (_, i) => track(`arm-${i}`)), time: 4 });
  assert.equal(tracks.snapshot.ghostCount, 30);
  const camera = new Group(); camera.position.set(3, 3, 3); tracks.sort(camera);
  tracks.update({ tracks: [], time: 4 }); assert.equal(tracks.snapshot.ghostCount, 0); assert.equal(tracks.snapshot.referenceCount, 0);
  tracks.dispose();
});


test('auxiliary bounds include visible paths and poses, excluding hidden tracks and pooled ghosts', () => {
  const { tracks } = fixture(), near = track('near'), distant = track('distant');
  distant.motion.ee_xyz = [[100, 0, 0], [101, 0, 0]];
  distant.motion.arm_base = [1, 0, 0, 100, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  tracks.update({ tracks: [near, distant], time: 4 });
  assert(tracks.bounds.max.x > 100);
  distant.visible = false; tracks.update({ tracks: [near, distant], time: 4 });
  assert(tracks.bounds.max.x < 3);
  tracks.update({ tracks: [near], time: 4 }); // Distant ghost remains allocated and hidden.
  assert(tracks.bounds.max.x < 3);
  tracks.update({ tracks: [near], time: 4, visible: false }); assert(tracks.bounds.isEmpty());
  tracks.dispose();
});


test('recorded gripper coordinates stay independent per track without overriding moving joints or the solid robot', () => {
  const { tracks, scene, robot } = fixture({ gripper: true }), a = track('a'), b = track('b');
  a.motion.fixed_joints = { gripper_right_finger_joint: .01, arm_right_1_joint: -2, torso_lift_joint: .3, arm_left_1_joint: 1 };
  b.motion.fixed_joints = { gripper_right_finger_joint: .07, arm_right_1_joint: -1 };
  const solidFinger = robot.joints.arm_right_1_joint.children.find(object => object.urdfName === 'gripper_right_finger_joint');
  tracks.update({ tracks: [a, b], time: 4 });
  const colors = scene.getObjectByName('ghost-arms').children.map(group => group.children[0]);
  const fingers = colors.map(root => root.children.find(object => object.urdfName === 'gripper_right_finger_joint'));
  assert.deepEqual(fingers.map(finger => finger.jointValue[0]), [.01, .07]);
  assert.deepEqual(colors.map(root => root.jointValue[0]), [.5, .5]);
  assert.equal(solidFinger.jointValue[0], .02); assert.equal(robot.joints.arm_right_1_joint.jointValue[0], 0);
  let sets = 0;
  fingers.forEach(finger => { const original = finger.setJointValue.bind(finger); finger.setJointValue = (...values) => { sets++; return original(...values); }; });
  tracks.update({ tracks: [a, b], time: 4 });
  assert.equal(sets, 0); // Pose names/constant values feed the existing unchanged-pose cache.
  tracks.update({ tracks: [a, b], time: 4.5 });
  assert.deepEqual(fingers.map(finger => finger.jointValue[0]), [.01, .07]);
  assert.equal(solidFinger.jointValue[0], .02);
  tracks.dispose();
});

test('temporal sources hold recorded native samples and retain each track base, gripper and session offset', () => {
  const { tracks, robot } = fixture({ gripper: true }), arm = track('arm', { defaultName: 'A', displayName: 'A' });
  arm.motion.fixed_joints = { gripper_right_finger_joint: .07 };
  arm.motion.arm_base = [1, 0, 0, 3, 0, 1, 0, 0, 0, 0, 1, 2, 0, 0, 0, 1];
  tracks.update({ tracks: [arm], time: 4, opacity: .8 });
  const [source] = tracks.onionSources;
  assert.equal(source.id, 'arm'); assert.equal(source.cursor, 3); assert.equal(source.seekOffset, 1);
  assert.equal(source.label, 'A');
  assert.equal(source.base.elements[12], 3); assert.equal(source.color, arm.color);
  assert.deepEqual(source.states([3, 4]), [{ time: 2, q: [.07, 0] }, { time: 4, q: [.07, 1] }]);
  assert.deepEqual(source.jointNames, ['gripper_right_finger_joint', 'arm_right_1_joint']);
  assert.equal(tracks.snapshot.sampled[0].opacity, .8);
  const states = source.states; arm.displayName = 'Comparison reach';
  tracks.update({ tracks: [arm], time: 9, opacity: .8 });
  assert.equal(source.label, 'Comparison reach'); assert.equal(source.states, states);
  assert(tracks.snapshot.sampled[0].opacity < .8); assert.equal(tracks.onionSources[0], source);
  arm.visible = false; tracks.update({ tracks: [arm], time: 3 }); assert.equal(tracks.onionSources[0].visible, false);
  assert.equal(robot.joints.arm_right_1_joint.jointValue[0], 0);
  tracks.dispose();
});

test('a recording with an orientation reference shows its held goal and interpolated grasp frame as glyphs', () => {
  const { tracks } = fixture();
  const quarter = [0, 0, Math.PI / 2], half = [0, 0, Math.PI];
  const oriented = track('oriented', { offset_s: 0, motion: { time_s: [2, 4], q: [[0], [1]], ee_xyz: [[0, 0, 0], [2, 0, 0]],
    reference_time_s: [2, 3], reference_xyz: [[2, 0, 0], [2, 1, 0]], reference_rotvec: [quarter, null], ee_rotvec: [[0, 0, 0], half] } });
  const close = (actual, expected) => actual.forEach((value, i) => assert(Math.abs(value - expected[i]) < 1e-12, `${actual} ≠ ${expected}`));
  tracks.update({ tracks: [oriented, track('plain', { offset_s: 0 })], time: 2.5 });
  assert.equal(tracks.snapshot.glyphs.length, 1);  // a recording without orientations draws none
  const [{ goal, grasp }] = tracks.snapshot.glyphs;
  close(goal.position, [2, .5, 0]); close(goal.quaternion, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);  // held, not blended toward none
  close(grasp.position, [.5, 0, 0]); close(grasp.quaternion, [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)]);  // a quarter of the half turn
  tracks.update({ tracks: [oriented], time: 3.5 });
  assert.equal(tracks.snapshot.glyphs[0].goal, null);  // the reference has no target from 3 s on
  tracks.dispose();
});

test('obstacles show once per recorded scene; the collision spheres follow their toggle and each arm', () => {
  const { tracks, scene, robot } = fixture(), link = new URDFLink();
  link.urdfName = 'arm_right_1_link'; robot.joints.arm_right_1_joint.add(link);
  const recorded = { obstacles: [[1, 2, 3, .05], [1, 2, 3.2, .05]],
    collision_spheres: { environment: [[0, 0, 1, .1]], arm: { arm_right_1_link: [[1, 0, 0, .05]] } } };
  const on = track('on'), off = track('off', { display: 'dot' }), plain = track('plain');
  for (const item of [on, off]) Object.assign(item.motion, structuredClone(recorded), { q: [[0], [Math.PI / 2]] });
  tracks.update({ tracks: [plain], time: 5 });
  assert.equal(tracks.coversAvailable, false); assert.equal(tracks.snapshot.obstacleCount, 0);
  tracks.update({ tracks: [plain, on, off], time: 5 });
  assert.equal(tracks.coversAvailable, true);
  assert.equal(tracks.snapshot.obstacleCount, 2); assert.equal(tracks.snapshot.coverCount, 0);
  const obstacle = scene.getObjectByName('track-obstacles').children[1];
  assert.deepEqual(obstacle.position.toArray(), [1, 2, 3.2]); assert.equal(obstacle.scale.x, .05);
  tracks.update({ tracks: [plain, on, off], time: 5, covers: true });
  assert.equal(tracks.snapshot.coverCount, 2); // The shared environment once, and only the Arm track's cover.
  scene.updateMatrixWorld(true);
  const sphere = scene.getObjectByName('track-arm-cover-link').children[0];
  const at = () => new Vector3().setFromMatrixPosition(sphere.matrixWorld).toArray().map(v => Math.round(v * 1e9) / 1e9);
  assert.deepEqual(at(), [0, 1, 0]); // The track's end, a quarter turn about z.
  tracks.update({ tracks: [plain, on, off], time: 3, covers: true }); scene.updateMatrixWorld(true);
  assert.deepEqual(at(), [1, 0, 0]);
  assert.equal(robot.joints.arm_right_1_joint.jointValue[0], 0);
  on.visible = false; tracks.update({ tracks: [plain, on, off], time: 3, covers: true });
  assert.equal(tracks.snapshot.obstacleCount, 2); assert.equal(tracks.snapshot.coverCount, 1);
  off.visible = false; tracks.update({ tracks: [plain, on, off], time: 3, covers: true });
  assert.equal(tracks.snapshot.obstacleCount, 0); assert.equal(tracks.snapshot.coverCount, 0);
  assert.equal(scene.getObjectByName('track-obstacles'), undefined);
  tracks.dispose(); assert.equal(scene.getObjectByName('track-environment'), undefined);
});
