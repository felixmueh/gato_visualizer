import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Scene } from 'three';
import { URDFJoint } from 'urdf-loader/src/URDFClasses.js';
import { createTrackScene, trackDisplayPath, trackReferencesDiffer, TRACK_OPACITY, TRACK_OUTSIDE_OPACITY } from './track-scene.js';

function fixture() {
  const scene = new Scene(), robot = new Group(), torso = new Group(), joint = new URDFJoint();
  joint.urdfName = 'arm_right_1_joint'; joint.jointType = 'revolute'; joint.axis.set(0, 0, 1); joint.setJointValue(0);
  joint.add(new Mesh(new BoxGeometry(.2, .2, .2), new MeshStandardMaterial()));
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
