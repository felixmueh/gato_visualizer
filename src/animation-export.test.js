import test from 'node:test';
import assert from 'node:assert/strict';
import { AxesHelper, BoxGeometry, GridHelper, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Scene, Vector3 } from 'three';
import { URDFJoint } from 'urdf-loader/src/URDFClasses.js';
import { animationSchedule, animationLayout, letterboxViewport, freezeAnimationSnapshot, createAnimationCapture, exportAnimation, sampleAnimationHistory } from './animation-export.js';
import { createLiveHistory } from './live-history.js';

const motion = { time_s: [2, 4], q: [[0], [1]], ee_xyz: [[0, 0, 1], [2, 0, 1]] };
function fixture(replayOnly = false) {
  const scene = new Scene(), robot = new Group(), joint = new URDFJoint();
  joint.urdfName = 'arm_right_1_joint'; joint.jointType = 'revolute'; joint.axis.set(0, 0, 1); joint.limit.lower = -10; joint.limit.upper = 10;
  joint.setJointValue(.2); joint.add(new Mesh(new BoxGeometry(.2, .2, .2), new MeshStandardMaterial()));
  robot.joints = { arm_right_1_joint: joint }; robot.add(joint); scene.add(robot);
  scene.add(new Mesh(new PlaneGeometry(200, 200), new MeshStandardMaterial()));
  const editor = new Group(); editor.name = 'editor-handles'; scene.add(editor);
  const camera = new PerspectiveCamera(45, 2, .01, 100); camera.position.set(3, -4, 2); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 1);
  const track = { id: 'recording', kind: 'replay', motion, span: [2, 4], offset_s: 1, display: 'dot', color: 0xaa0000, visible: true };
  const liveTrack = { id: 'live', kind: 'live', span: [0, 4], offset_s: 0, empty: false, visible: true, display: 'arm' };
  const hidden = { ...track, id: 'hidden', offset_s: -1, visible: false };
  const session = { activeTracks: replayOnly ? [track, hidden] : [liveTrack, track, hidden], replayOnly,
    span: replayOnly ? [3, 5] : [0, 5], aggregate: { start: 1, end: 4 },
    setAggregate(bounds) { this.aggregate = bounds; } };
  const liveHistory = [0, 4].map(time => ({ state: { sim_time_s: time, q: [time / 4], ee_xyz: [time / 4, 0, 1] }, plan: null }));
  return { scene, robot, camera, session, track, liveHistory, jointNames: ['arm_right_1_joint'], cameraTarget: new Vector3(0, 0, 1) };
}

test('index-derived 30 fps schedules include exact endpoints without duplicate floating ticks', () => {
  for (const [begin, end, count] of [[0, 1, 31], [10, 10.1, 4], [1000, 1000.1, 4], [2, 2.051, 3], [3, 3, 1], [0, 1e-20, 2]]) {
    const schedule = animationSchedule(begin, end);
    assert.equal(schedule.frameCount, count); assert.equal(schedule.time(0), begin); assert.equal(schedule.time(count - 1), end);
    for (let i = 1; i < count - 1; i++) assert.equal(schedule.time(i), begin + i / 30);
    const times = Array.from({ length: count }, (_, index) => schedule.time(index));
    assert.equal(new Set(times).size, count);
  }
  assert.throws(() => animationSchedule(1, 0)); assert.throws(() => animationSchedule(0, Infinity));
});

test('Live snapshot freezes applied-plan associations across later controls, trim and reset', () => {
  const history = createLiveHistory(), a = { seq: 1, sim_time_s: 0 }, b = { seq: 2, sim_time_s: 0 };
  history.addPlan(a); history.addState({ sim_time_s: 0, q: [0], ee_xyz: [0, 0, 0] });
  const frozen = history.animationSnapshot;
  history.addPlan(b); history.addRecord({ type: 'control', plan_seq: 2, sim_time_s: 0 });
  assert.equal(frozen[0].plan, a); assert.equal(history.animationSnapshot[0].plan, b);
  history.clear(); assert.equal(frozen.length, 1); assert.ok(Object.isFrozen(frozen)); assert.ok(Object.isFrozen(frozen[0]));
});

test('frozen history interpolates q and holds its applied plan and generation boundary', () => {
  const plan = { seq: 1 }, samples = [{ state: { sim_time_s: 2, q: [0], ee_xyz: [0, 0, 0], settings_version: 1 }, plan },
    { state: { sim_time_s: 4, q: [2], ee_xyz: [2, 0, 0], settings_version: 1 }, plan: { seq: 2 } }];
  assert.deepEqual(sampleAnimationHistory(samples, 3).state.q, [1]); assert.equal(sampleAnimationHistory(samples, 3).plan, plan);
  assert.deepEqual(sampleAnimationHistory(samples, 3, false).state.q, [0]);
  assert.equal(sampleAnimationHistory(samples, 0).state, samples[0].state); assert.equal(sampleAnimationHistory(samples, 9).state, samples[1].state);
  samples[1].state.settings_version = 2; assert.deepEqual(sampleAnimationHistory(samples, 3).state.q, [0]);
});

test('presentation snapshot excludes hidden and Replay Live tracks and owns scene resources', () => {
  const original = fixture(true), snapshot = freezeAnimationSnapshot(original);
  assert.equal(snapshot.tracks.length, 1); assert.equal(snapshot.tracks[0].motion, motion); assert.equal(snapshot.scene.getObjectByName('editor-handles'), undefined);
  assert.deepEqual(snapshot.span, [3, 4]);
  original.track.offset_s = 100; original.track.color = 0xffffff; original.track.display = 'arm'; original.session.setAggregate({ start: 0, end: 0 });
  assert.equal(snapshot.tracks[0].offset_s, 1); assert.equal(snapshot.tracks[0].color, 0xaa0000); assert.equal(snapshot.tracks[0].display, 'dot');
  assert.notEqual(snapshot.robot.children[0].children[0].geometry, original.robot.children[0].children[0].geometry);
  assert.notEqual(snapshot.robot.children[0].children[0].material, original.robot.children[0].children[0].material);
  snapshot.robot.joints.arm_right_1_joint.setJointValue(1); assert.equal(original.robot.joints.arm_right_1_joint.jointValue[0], .2);
});

function fakeRenderer(log) {
  return { domElement: { toBlob: callback => callback(new Blob(['png'], { type: 'image/png' })) },
    setPixelRatio: ratio => log.push(['pixelRatio', ratio]), setSize: (...args) => log.push(['size', ...args]),
    setScissorTest() {}, setClearColor() {}, clear() {}, setViewport: (...args) => log.push(['viewport', ...args]), setScissor() {},
    render: (scene, camera) => log.push(['render', camera.userData.view || 'main', scene.getObjectByName('track-dot')?.position.x, scene.getObjectByName('export-prediction')?.visible]),
    dispose: () => log.push(['dispose']), forceContextLoss: () => log.push(['loseContext']) };
}

test('static grid and coordinate axes use actual Three helper types and independent resources', () => {
  const original = fixture(true), grid = new GridHelper(), axes = new AxesHelper();
  grid.name = 'context-grid'; axes.name = 'context-axes'; original.scene.add(grid, axes);
  const snapshot = freezeAnimationSnapshot(original);
  for (const helper of [grid, axes]) {
    const copy = snapshot.scene.getObjectByName(helper.name);
    assert.equal(copy?.type, helper.type);
    assert.notEqual(copy.geometry, helper.geometry);
    assert.notEqual(copy.material, helper.material);
  }
});

test('dedicated capture preserves main renderer, robot, camera and resources; fits principal views once', async () => {
  const original = fixture(), originalPose = original.camera.toJSON(), mesh = original.robot.children[0].children[0];
  let disposed = 0; mesh.geometry.addEventListener('dispose', () => disposed++); mesh.material.addEventListener('dispose', () => disposed++);
  const state = { sim_time_s: 0, q: [0], ee_xyz: [0, 0, 1] }, plan = { ee_xyz: [[0, 0, 1], [1, 0, 1]] };
  const snapshot = freezeAnimationSnapshot({ ...original, liveHistory: [{ state, plan }, { state: { ...state, sim_time_s: 4, ee_xyz: [2, 0, 1] }, plan }], liveState: state });
  const log = [], capture = createAnimationCapture(snapshot, { width: 1280, height: 720, views: 'main-principal', orientation: 'current' }, { rendererFactory: () => fakeRenderer(log) });
  const fitted = capture.cameras.slice(1).map(({ camera }) => camera.toJSON());
  assert.ok(capture.cameras[1].camera.right < 10, '200 m floor must not enter fitting bounds');
  await capture.frame(4); await capture.frame(9);
  assert.deepEqual(capture.cameras.slice(1).map(({ camera }) => camera.toJSON()), fitted);
  assert.deepEqual(log.filter(row => row[0] === 'render').map(row => row[1]), ['main', 'top', 'right', 'main', 'top', 'right']);
  assert.equal(log.find(row => row[0] === 'render')[2], 1); // session 4 minus offset 1 -> native 3
  assert.equal(original.robot.joints.arm_right_1_joint.jointValue[0], .2); assert.deepEqual(original.camera.toJSON(), originalPose);
  capture.dispose(); capture.dispose(); assert.equal(disposed, 0); assert.equal(log.filter(row => row[0] === 'dispose').length, 1);
});

test('incomplete local Live history fails clearly while endpoint holds outside its own span remain allowed', () => {
  const original = fixture();
  assert.throws(() => freezeAnimationSnapshot({ ...original, liveHistory: original.liveHistory.slice(0, 1) }), /recording has not loaded/);
  assert.throws(() => freezeAnimationSnapshot({ ...original, liveHistory: [] }), /recording has not loaded/);
  original.session.setAggregate({ start: 4.5, end: 5 });
  const snapshot = freezeAnimationSnapshot(original);
  assert.deepEqual(snapshot.span, [4.5, 5]);
});

test('Live trace appears again after a frozen draft pose transitions to recorded states', async () => {
  const original = fixture(); original.session.setAggregate({ start: 0, end: 4 });
  original.liveHistory[0].state.start_pose_draft = true;
  const snapshot = freezeAnimationSnapshot(original);
  const capture = createAnimationCapture(snapshot, { width: 1280, height: 720 }, { rendererFactory: () => fakeRenderer([]) });
  await capture.frame(0); assert.equal(capture.scene.getObjectByName('export-live-trace').visible, false);
  await capture.frame(4); assert.equal(capture.scene.getObjectByName('export-live-trace').visible, true);
  capture.dispose();
});

test('preset camera preserves orbit radius; composite viewports and current aspect have deterministic pixels', () => {
  const original = fixture(), snapshot = freezeAnimationSnapshot(original), distance = snapshot.camera.position.distanceTo(snapshot.cameraTarget);
  const capture = createAnimationCapture(snapshot, { width: 1280, height: 720, orientation: 'isometric' }, { rendererFactory: () => fakeRenderer([]) });
  assert.ok(Math.abs(capture.cameras[0].camera.position.distanceTo(snapshot.cameraTarget) - distance) < 1e-10);
  assert.ok(capture.cameras[0].camera.position.y < snapshot.cameraTarget.y); capture.dispose();
  assert.deepEqual(animationLayout(1280, 720, 'main-principal').map(v => [v.width, v.height]), [[853, 720], [427, 360], [427, 360]]);
  assert.deepEqual(letterboxViewport({ x: 0, y: 0, width: 1280, height: 720 }, 2), { x: 0, y: 40, width: 1280, height: 640 });
});

test('stream waits for each frame upload and hands successful download ownership to caller', async () => {
  const log = [], snapshot = { span: [0, .051], scene: new Scene() };
  const result = await exportAnimation({ snapshot, options: { width: 1280, height: 720 },
    createCapture: () => ({ frame: async time => { log.push(['capture', time]); return new Blob(['png']); }, dispose: () => log.push(['dispose']) }),
    fetchImpl: async (url, init) => {
      log.push(['fetch', url]);
      if (url.includes('/frame?')) { await Promise.resolve(); log.push(['uploaded', url]); }
      return { ok: true, json: async () => url.endsWith('/start') ? { id: 'a b' } : { download_url: '/download' } };
    } });
  assert.equal(result.frame_count, 3); assert.equal(result.download_url, '/download');
  const actions = log.map(row => row[0]);
  assert.deepEqual(actions, ['fetch', 'capture', 'fetch', 'uploaded', 'capture', 'fetch', 'uploaded', 'capture', 'fetch', 'uploaded', 'fetch', 'dispose']);
  assert.equal(log.some(row => row[1]?.includes?.('/cancel')), false);
});

test('cancel during PNG capture skips upload, cancels server without aborted signal and disposes', async () => {
  const controller = new AbortController(), log = [];
  await assert.rejects(exportAnimation({ snapshot: { span: [0, 1], scene: new Scene() }, options: { width: 1280, height: 720 }, signal: controller.signal,
    createCapture: () => ({ frame: async () => { controller.abort(); return new Blob(['png']); }, dispose: () => log.push('disposed') }),
    fetchImpl: async (url, init) => { log.push(url); if (url.includes('/cancel')) assert.equal(init.signal, undefined); return { ok: true, json: async () => ({ id: 'cancel-me' }) }; } }), { name: 'AbortError' });
  assert.deepEqual(log, ['/api/animation-export/start', 'disposed', '/api/animation-export/cancel?id=cancel-me']);
});

test('frame server errors cancel the encoder and dispose the dedicated scene', async () => {
  const log = [];
  await assert.rejects(exportAnimation({ snapshot: { span: [0, 0], scene: new Scene() }, options: { width: 1280, height: 720 },
    createCapture: () => ({ frame: async () => new Blob(['png']), dispose: () => log.push('disposed') }),
    fetchImpl: async url => { log.push(url); return url.includes('/frame?') ? { ok: false, status: 500, json: async () => ({ error: 'encoder failed' }) } : { ok: true, json: async () => ({ id: 'failed' }) }; } }), /encoder failed/);
  assert.deepEqual(log.slice(-2), ['disposed', '/api/animation-export/cancel?id=failed']);
});
