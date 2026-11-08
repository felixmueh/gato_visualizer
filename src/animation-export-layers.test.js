import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3 } from 'three';
import { URDFJoint, URDFLink } from 'urdf-loader/src/URDFClasses.js';
import { EXPORT_SHOW_DEFAULTS, collisionSegmentsInWorld, createAnimationCapture, freezeAnimationSnapshot } from './animation-export.js';

// Export Show choices (collision objects, sphere covers, prediction, paths, target and
// reference). Kept apart from animation-export.test.js, which another session edits.
const T = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 1], [0, 0, 0, 1]];
const segments = [
  { generation: 3, world_from_root: T, collision: { obstacles: [[.4, -.4, -.3, .05]], body: [[0, 0, -.5, .15], [0, 0, -.2, .1]],
    arm: { arm_right_2_link: [[0, 0, .1, .04]] } } },
  { generation: 4, world_from_root: T, collision: { obstacles: [[.4, -.6, -.3, .05], [.3, -.3, -.4, .06]], body: [], arm: {} } },
  { generation: 5, world_from_root: T, collision: null },
];
function fixture() {
  const scene = new Scene(), robot = new Group(), joint = new URDFJoint(), link = new URDFLink();
  joint.urdfName = 'arm_right_1_joint'; joint.jointType = 'revolute'; joint.axis.set(0, 0, 1); joint.limit.lower = -10; joint.limit.upper = 10;
  link.urdfName = 'arm_right_2_link'; joint.add(link); link.add(new Mesh(new BoxGeometry(.2, .2, .2), new MeshStandardMaterial()));
  robot.joints = { arm_right_1_joint: joint }; robot.add(joint); scene.add(robot);
  const camera = new PerspectiveCamera(45, 2, .01, 100); camera.position.set(3, -4, 2); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 1);
  const live = { id: 'live', kind: 'live', span: [0, 4], offset_s: 0, empty: false, visible: true, display: 'arm' };
  const motion = { time_s: [0, 4], q: [[0], [1]], ee_xyz: [[0, 0, 1], [1, 0, 1]], obstacles: [[1, 1, 1, .1]], reference_xyz: [[0, 1, 1], [1, 1, 1]] };
  const replay = { id: 'replay', kind: 'replay', motion, span: [0, 4], offset_s: 0, color: 0xaa0000, visible: true, display: 'arm' };
  const session = { activeTracks: [live, replay], replayOnly: false, span: [0, 4], aggregate: { start: 0, end: 4 }, track: () => null };
  const plan = { ee_xyz: [[0, 0, 1], [.5, 0, 1]] };
  const liveHistory = [[0, 3], [1.9, 3], [2, 4], [4, 4]].map(([time, generation]) => ({ plan,
    state: { sim_time_s: time, generation, settings_version: generation, q: [time / 4], ee_xyz: [time / 4, 0, 1], target_xyz: [1, 0, 1] } }));
  return { scene, robot, camera, session, liveHistory, jointNames: ['arm_right_1_joint'], cameraTarget: new Vector3(0, 0, 1),
    mainReference: { points: [[0, 0, 1], [1, 0, 1]], target_xyz: [1, 0, 1] }, liveSegments: segments };
}
const renderer = () => ({ domElement: { toBlob: callback => callback(new Blob(['png'])) }, setPixelRatio() {}, setSize() {},
  setScissorTest() {}, setClearColor() {}, clear() {}, setViewport() {}, setScissor() {}, render() {}, dispose() {}, forceContextLoss() {} });
const spheres = (scene, name) => (scene.getObjectByName(name)?.children || []).map(mesh => [...mesh.position.toArray(), mesh.scale.x]);

test('segments with collision rows place obstacles and the body cover in the world', () => {
  const world = collisionSegmentsInWorld(segments);
  assert.deepEqual([...world.keys()], [3, 4]);
  assert.deepEqual(world.get(3).obstacles, [[.4, -.4, .7, .05]]);
  assert.deepEqual(world.get(3).body[0], [0, 0, .5, .15]);
});

test('collision objects follow the segment in effect at each frame; covers and layers are separate choices', async () => {
  const capture = createAnimationCapture(freezeAnimationSnapshot(fixture()), { width: 640, height: 360, show: { covers: true } }, { rendererFactory: renderer });
  await capture.frame(1); assert.deepEqual(spheres(capture.scene, 'export-obstacles'), [[.4, -.4, .7, .05]]);
  assert.equal(spheres(capture.scene, 'export-body-cover').length, 2);
  assert.ok(capture.scene.getObjectByName('track-arm-cover'));
  assert.deepEqual(spheres(capture.scene, 'track-obstacles'), [[1, 1, 1, .1]]);  // the recording's own
  await capture.frame(3); assert.deepEqual(spheres(capture.scene, 'export-obstacles').map(sphere => sphere[1]), [-.6, -.3]);
  assert.equal(capture.scene.getObjectByName('export-body-cover'), undefined);
  for (const name of ['export-prediction', 'export-reference', 'export-live-trace']) assert.equal(capture.scene.getObjectByName(name).visible, true, name);
  capture.dispose();
});

test('unchecked choices hide their geometry, the recordings’ included', async () => {
  const off = Object.fromEntries(Object.keys(EXPORT_SHOW_DEFAULTS).map(key => [key, false]));
  const capture = createAnimationCapture(freezeAnimationSnapshot(fixture()), { width: 640, height: 360, show: off }, { rendererFactory: renderer });
  await capture.frame(3);
  assert.equal(capture.scene.getObjectByName('export-obstacles'), undefined);
  assert.equal(capture.scene.getObjectByName('track-obstacles'), undefined);
  for (const name of ['export-prediction', 'export-reference', 'export-live-trace']) assert.equal(capture.scene.getObjectByName(name).visible, false, name);
  assert.equal(capture.scene.getObjectByName('track-path').visible, false);
  assert.equal(capture.scene.getObjectByName('track-reference').visible, false);
  capture.dispose();
});
