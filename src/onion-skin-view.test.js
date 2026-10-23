import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene } from 'three';
import { URDFJoint } from 'urdf-loader/src/URDFClasses.js';
import { setupOnionSkin, ONION_COLOR, ONION_PREDICTION_COLOR, ONION_STORAGE_KEY } from './onion-skin-view.js';
import { sampleAtOrBefore, temporalGhostColor } from './onion-skin.js';
import { plotDOM } from './plot-dom-test-helper.js';

function fixture(t, { enabled = true, storageThrows = false } = {}) {
  const { document, Element } = plotDOM(), elements = new Map(), writes = [];
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (selector) {
    return selector.split(',').some(part => matches.call(this, part.trim()));
  };
  const createElement = document.createElement;
  document.createElement = tag => {
    const element = createElement(tag);
    element.style.setProperty = (key, value) => { element.style[key] = value; };
    return element;
  };
  document.getElementById = id => elements.get(id);
  for (const id of ['live-onion-skin', 'replay-onion-skin', 'onion-skin-tooltip', 'limit-tint-tooltip', 'viewport', 'live-onion-ticks', 'replay-onion-ticks']) {
    const element = document.createElement(id.endsWith('skin') ? 'button' : 'div');
    elements.set(id, element); document.body.append(element);
  }
  elements.get('limit-tint-tooltip').hidden = true;
  const pending = [];
  for (const [name, value] of Object.entries({
    document,
    localStorage: {
      getItem(key) { if (storageThrows) throw new Error('Storage disabled'); return key === ONION_STORAGE_KEY ? String(enabled) : null; },
      setItem(key, value) { if (storageThrows) throw new Error('Storage disabled'); writes.push([key, value]); },
    },
    requestAnimationFrame(callback) { pending.push(callback); return pending.length; },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  const scene = new Scene(), robot = new Group(), joint = new URDFJoint();
  joint.urdfName = 'arm_right_1_joint'; joint.jointType = 'revolute';
  joint.axis.set(0, 0, 1); joint.limit.lower = -2; joint.limit.upper = 2; joint.setJointValue(0);
  const mesh = new Mesh(new BoxGeometry(.2, .2, .2), new MeshBasicMaterial());
  mesh.position.x = .5; joint.add(mesh); robot.add(joint);
  robot.joints = { arm_right_1_joint: joint }; scene.add(robot);
  const camera = new PerspectiveCamera(50, 3, .01, 100);
  camera.position.set(.5, 0, 2); camera.lookAt(.5, 0, 0); camera.updateMatrixWorld(true);
  const element = document.createElement('canvas'), seeks = [];
  const view = setupOnionSkin({ robot, scene, camera, element, onSeek: time => seeks.push(time) });
  return { document, elements, view, element, seeks, writes, scene, joint };
}

function source(overrides = {}) {
  const times = overrides.times || [0, .7, 1.4, 2.1, 2.8, 3.5, 4];
  let calls = 0;
  const next = {
    mode: 'replay', identity: {}, revision: 1, times,
    bounds: [times[0] ?? 0, times.at(-1) ?? 0], trackBounds: [0, times.at(-1) ?? 0],
    cursor: .1, jointNames: ['arm_right_1_joint'], color: ONION_COLOR,
    states(keyframes) {
      calls++;
      return keyframes.map(time => {
        const index = sampleAtOrBefore(times, time);
        return index < 0 ? null : { time: times[index], q: [times[index] / 10] };
      });
    },
    ...overrides,
  };
  return { next, calls: () => calls };
}

test('cursor-only updates reuse recorded samples, ticks and aggregate-relative ghost opacity', t => {
  const { view, elements, joint } = fixture(t), motion = source();
  view.update(motion.next);
  const before = view.snapshot, revision = view.timeline.keyframeRevision;
  assert.equal(before.renderer.method, 'prepass');
  assert.equal(before.renderer.layer, 0); // Main, Top and Right cameras share ghosts.
  const tick = elements.get('replay-onion-ticks').children[1];
  assert.equal(motion.calls(), 1);
  assert.deepEqual(before.snappedTimes, [0, .7, 1.4, 2.1, 2.8, 3.5, 4]);
  view.update({ ...motion.next, cursor: 2 });
  assert.equal(motion.calls(), 1);
  assert.equal(view.timeline.keyframeRevision, revision);
  assert.equal(elements.get('replay-onion-ticks').children[1], tick);
  assert.deepEqual(view.snapshot.opacities, before.opacities);
  assert.equal(joint.jointValue[0], 0);
  assert.match(elements.get('replay-onion-skin').title, /every 0.5 s/);
  view.update({ ...motion.next, revision: 2 });
  assert.equal(motion.calls(), 2);
});

test('Live reveal follows the cursor and a new empty generation clears ghosts and ticks', t => {
  const { view, elements } = fixture(t), motion = source({ mode: 'live', identity: 'live:1', reveal: 1.5 });
  view.update(motion.next);
  assert.deepEqual(view.timeline.keyframes.map(item => item.time), [0, .7, 1.4]);
  assert.equal(view.snapshot.ghostCount, 3);
  assert.equal(elements.get('live-onion-ticks').children.length, 3);
  assert.equal(elements.get('replay-onion-ticks').children.length, 0);
  view.update({ ...motion.next, reveal: undefined });
  assert.equal(motion.calls(), 1);
  assert.equal(view.timeline.keyframes.length, 7);
  const empty = source({ mode: 'live', identity: 'live:2', revision: 0, times: [], bounds: [0, 0], trackBounds: [0, 0] });
  view.update(empty.next);
  assert.equal(view.snapshot.ghostCount, 0);
  assert.equal(view.snapshot.step, null);
  assert.deepEqual(view.snapshot.snappedTimes, []);
  assert.deepEqual(view.timeline.keyframes, []);
  assert.equal(elements.get('live-onion-ticks').children.length, 0);
});

test('Replay ticks seek relative to a nonzero start and show absolute snapped sample times', async t => {
  const { view, elements, seeks, scene } = fixture(t);
  const motion = source({ times: [10, 10.4, 10.9, 11.2, 11.8, 12], bounds: [10, 12], trackBounds: [0, 2], offset: 10, cursor: 10.1, color: ONION_PREDICTION_COLOR });
  view.update(motion.next);
  const tick = elements.get('replay-onion-ticks').children[1];
  assert.equal(tick.title, '10.400 s');
  assert(Math.abs(parseFloat(tick.style.left) - 20) < 1e-10);
  assert.equal(tick.style['--ghost-color'], '#34d8d4');
  await tick.emit('pointerenter', { clientX: 100, clientY: 100 });
  assert.equal(elements.get('onion-skin-tooltip').textContent, '10.400 s');
  await tick.emit('click');
  assert(Math.abs(seeks[0] - .4) < 1e-10);
  assert.equal(view.timeline.keyframes[1].sampleTime, 10.4);
  assert(Math.abs(view.timeline.keyframes[1].time - .4) < 1e-10);
  assert.equal(scene.getObjectByName('ghost-arm').children[0].children[0].material.color.getHex(), ONION_PREDICTION_COLOR);
});

test('storage failures keep toggling functional and O ignores typing, modifiers and repeats', async t => {
  const { view, document, elements } = fixture(t, { storageThrows: true });
  view.update(source().next);
  assert.equal(view.snapshot.enabled, false);
  assert.equal(view.snapshot.ghostCount, 0);
  await elements.get('live-onion-skin').emit('click');
  assert.equal(view.snapshot.enabled, true);
  const input = document.createElement('input');
  await document.emit('keydown', { code: 'KeyO', target: input });
  for (const flags of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }]) {
    await document.emit('keydown', { code: 'KeyO', target: document.body, ...flags });
  }
  assert.equal(view.snapshot.enabled, true);
  await document.emit('keydown', { code: 'KeyO', target: document.body });
  assert.equal(view.snapshot.enabled, false);
  assert.equal(elements.get('live-onion-skin').getAttribute('aria-pressed'), 'false');
  assert.equal(elements.get('replay-onion-skin').getAttribute('aria-pressed'), 'false');
});

test('ghost clicks seek while an orbit drag does not seek even after returning to its start', async t => {
  const { view, element, seeks } = fixture(t);
  const motion = source({ times: [1], bounds: [1, 1], trackBounds: [0, 1], cursor: 0, states: () => [{ time: 1, q: [0] }] });
  view.update(motion.next);
  const pointer = { pointerId: 1, button: 0, clientX: 300, clientY: 100 };
  await element.emit('pointerdown', pointer);
  await element.emit('pointerup', pointer);
  assert.deepEqual(seeks, [1]);
  await element.emit('pointerdown', pointer);
  await element.emit('pointermove', { ...pointer, clientX: 310, buttons: 1 });
  await element.emit('pointerup', pointer);
  assert.deepEqual(seeks, [1]);
});

test('Live cycles off, primary and colored all-track ghosts under one strict maximum; Replay keeps two states', async t => {
  const { view, elements } = fixture(t, { enabled: false });
  const primary = source({ mode: 'live', identity: 'live:1' }), comparison = source({ id: 'track-b', identity: 'track-b',
    times: [10, 11, 12], cursor: 10.1, bounds: [10, 12], seekOffset: -9, color: 0xb48cff, label: 'B' });
  const next = { ...primary.next, comparisons: [comparison.next] };
  view.setSettings({ maxCount: 4, interval_s: .5 }); view.update(next);
  assert.equal(view.mode, 'off');
  await elements.get('live-onion-skin').emit('click'); assert.equal(view.mode, 'primary');
  assert(view.snapshot.poses.every(pose => pose.sourceId === 'primary'));
  await elements.get('live-onion-skin').emit('click'); assert.equal(view.mode, 'all');
  assert(view.snapshot.ghostCount <= 4); assert(view.snapshot.poses.length <= 4);
  const comparisonPoses = view.snapshot.poses.filter(pose => pose.sourceId === 'track-b');
  assert(comparisonPoses.length > 0); assert(comparisonPoses.every(pose => pose.color === 0xb48cff));
  assert.equal(comparisonPoses.at(-1).sessionTime, 1);
  assert.equal(elements.get('live-onion-skin').getAttribute('data-ghost-mode'), 'all');
  await elements.get('live-onion-skin').emit('click'); assert.equal(view.mode, 'off'); assert.equal(view.snapshot.ghostCount, 0);
  view.update({ ...primary.next, mode: 'replay', comparisons: [comparison.next] });
  await elements.get('replay-onion-skin').emit('click'); assert.equal(view.mode, 'primary');
  await elements.get('replay-onion-skin').emit('click'); assert.equal(view.mode, 'off');
});

test('spacing and maximum update the prefix, opacity preserves samples, and a one-arm cap retains its first sample', t => {
  const { view } = fixture(t), motion = source(); view.update(motion.next);
  view.setSettings({ opacityStart: .8, opacityEnd: .4 }); assert.equal(motion.calls(), 1);
  assert.equal(view.settings.interval_s, .5); assert.equal(view.settings.maxCount, 16);
  const before = view.snapshot.opacities;
  view.setSettings({ opacityStart: .4, opacityEnd: .2 }); assert.equal(motion.calls(), 1);
  assert.deepEqual(view.snapshot.opacities, before.map(opacity => opacity / 2));
  view.setSettings({ interval_s: 1, maxCount: 3 }); assert.equal(motion.calls(), 2);
  assert(view.snapshot.snappedTimes.length <= 3);
  view.setSettings({ maxCount: 1 }); assert.deepEqual(view.snapshot.snappedTimes, [0]);
  assert.throws(() => view.setSettings({ maxCount: 65 }), /1 to 64/);
  assert.equal(view.settings.maxCount, 1);
});

test('comparison ghosts hold native samples and seek session time through ticks and direct picking', async t => {
  const { view, elements, element, seeks } = fixture(t), primary = source({ mode: 'live', times: [], bounds: [0, 0], trackBounds: [0, 3] });
  const comparison = source({ id: 'track-b', times: [10], bounds: [10, 10], cursor: 9, seekOffset: -9,
    color: 0xb48cff, label: 'B', states: () => [{ time: 10, q: [0] }] });
  view.setMode('all'); view.update({ ...primary.next, comparisons: [comparison.next] });
  assert.equal(view.snapshot.ghostCount, 1); assert.deepEqual(view.snapshot.snappedTimes, [10]);
  const tick = elements.get('live-onion-ticks').children[0];
  assert(Math.abs(parseFloat(tick.style.left) - 100 / 3) < 1e-10);
  await tick.emit('pointerenter', { clientX: 100, clientY: 100 });
  assert.match(elements.get('onion-skin-tooltip').textContent, /B.*10.000 s.*1.000 s.*session/);
  await tick.emit('click'); assert.deepEqual(seeks, [1]);
  const pointer = { pointerId: 1, button: 0, clientX: 300, clientY: 100 };
  await element.emit('pointerdown', pointer); await element.emit('pointerup', pointer);
  assert.deepEqual(seeks, [1, 1]);
});

test('the temporal pool supports the selectable 64-arm budget and immediately enforces a reduced cap', t => {
  const { view } = fixture(t), times = Array.from({ length: 101 }, (_, index) => index / 10);
  const motion = source({ times, cursor: .025 });
  view.setSettings({ interval_s: .1, maxCount: 64 }); view.update(motion.next);
  assert(view.snapshot.ghostCount > 24); assert(view.snapshot.ghostCount <= 64);
  view.setSettings({ maxCount: 2 }); assert(view.snapshot.ghostCount <= 2);
});

test('comparison renaming refreshes tick titles and hover labels without resampling recorded states', async t => {
  const { view, elements } = fixture(t), primary = source({ mode: 'live', times: [], trackBounds: [0, 3] });
  const comparison = source({ id: 'track-a', identity: 'saved', times: [10, 11], bounds: [10, 11], cursor: 9,
    seekOffset: -9, color: 0xb48cff, label: 'A' });
  const next = { ...primary.next, comparisons: [comparison.next] };
  view.setMode('all'); view.update(next);
  const oldTick = elements.get('live-onion-ticks').children[0], calls = comparison.calls();
  assert.match(oldTick.title, /^A ·/);
  comparison.next.label = 'Renamed reach'; view.update(next);
  const tick = elements.get('live-onion-ticks').children[0];
  assert.notEqual(tick, oldTick); assert.match(tick.title, /^Renamed reach ·/); assert.equal(comparison.calls(), calls);
  await tick.emit('pointerenter', { clientX: 100, clientY: 100 });
  assert.match(elements.get('onion-skin-tooltip').textContent, /^Renamed reach ·/);
});

test('aggregate range anchors a fixed-spacing prefix; cursor, zoom and opacity preserve sampled states', t => {
  const { view } = fixture(t), motion = source({ mode: 'live', identity: 'live:1', times: Array.from({ length: 11 }, (_, index) => index),
    range: [2, 8], trackBounds: [0, 10], cursor: 2.1 });
  view.setSettings({ interval_s: 1, maxCount: 4 }); view.update(motion.next);
  assert.deepEqual(view.snapshot.keyframeTimes, [2, 3, 4, 5]); assert.deepEqual(view.snapshot.snappedTimes, [2, 3, 4, 5]);
  assert.equal(motion.calls(), 1);
  view.update({ ...motion.next, cursor: 3.1, trackBounds: [3, 5] });
  view.setSettings({ opacityStart: .8, opacityEnd: .4 }); assert.equal(motion.calls(), 1);
  view.update({ ...motion.next, range: [4, 8] }); assert.equal(motion.calls(), 2);
  assert.deepEqual(view.snapshot.keyframeTimes, [4, 5, 6, 7]);
  view.update({ ...motion.next, range: [4, 20], revision: 2, times: Array.from({ length: 21 }, (_, index) => index) });
  assert.deepEqual(view.snapshot.keyframeTimes, [4, 5, 6, 7]); // Growth preserves the capped prefix.
});

test('session aggregate ranges convert to each native clock and offset changes invalidate selection', t => {
  const { view } = fixture(t), primary = source({ mode: 'live', identity: 'live', times: [], range: [2, 8], trackBounds: [0, 12] });
  const comparison = source({ id: 'track-a', identity: 'saved', times: Array.from({ length: 11 }, (_, index) => 100 + index),
    bounds: [100, 110], cursor: 99, seekOffset: -98, color: 0xb48cff, label: 'A' });
  const next = { ...primary.next, comparisons: [comparison.next] };
  view.setMode('all'); view.setSettings({ interval_s: 1, maxCount: 4 }); view.update(next);
  assert.deepEqual(view.snapshot.poses.map(pose => pose.time), [100, 101, 102, 103]);
  assert.deepEqual(view.timeline.keyframes.map(pose => pose.time), [2, 3, 4, 5]); assert.equal(comparison.calls(), 1);
  comparison.next.seekOffset = -99; view.update(next);
  assert.deepEqual(view.snapshot.poses.map(pose => pose.time), [101, 102, 103, 104]);
  assert.deepEqual(view.timeline.keyframes.map(pose => pose.time), [2, 3, 4, 5]); assert.equal(comparison.calls(), 2);
});

test('all-track budgets exclude disjoint recordings and stay within one maximum when they move into range', t => {
  const { view } = fixture(t), primary = source({ mode: 'live', identity: 'live', times: Array.from({ length: 11 }, (_, index) => index),
    range: [2, 8], trackBounds: [0, 10], cursor: 1 });
  const comparison = source({ id: 'track-a', identity: 'saved', times: [100, 101], bounds: [100, 101], cursor: 99, seekOffset: 0, label: 'A' });
  const next = { ...primary.next, comparisons: [comparison.next] };
  view.setMode('all'); view.setSettings({ interval_s: 1, maxCount: 4 }); view.update(next);
  assert.deepEqual(view.snapshot.poses.map(pose => pose.time), [2, 3, 4, 5]); assert.equal(comparison.calls(), 0);
  comparison.next.seekOffset = -98; view.update(next);
  assert.equal(view.snapshot.poses.length, 4); assert(view.snapshot.ghostCount <= 4);
  assert.deepEqual(view.snapshot.poses.filter(pose => pose.sourceId === 'primary').map(pose => pose.time), [2, 3]);
  assert.deepEqual(view.snapshot.poses.filter(pose => pose.sourceId !== 'primary').map(pose => pose.time), [100, 101]);
});

test('disabled spacing covers aggregate endpoints and cursor movement does not change aligned fade', t => {
  const { view } = fixture(t), motion = source({ mode: 'live', times: Array.from({ length: 11 }, (_, i) => i), range: [2, 8], cursor: 20 });
  view.setSettings({ spacingEnabled: false, maxCount: 4, interval_s: .1, opacityStart: .8, opacityEnd: .2 }); view.update(motion.next);
  assert.deepEqual(view.snapshot.keyframeTimes, [2, 4, 6, 8]); assert.equal(motion.calls(), 1);
  const opacity = view.snapshot.opacities;
  for (const [actual, expected] of opacity.map((actual, i) => [actual, [.8, .6, .4, .2][i]])) assert(Math.abs(actual - expected) < 1e-12);
  view.update({ ...motion.next, cursor: -20 }); assert.deepEqual(view.snapshot.opacities, opacity); assert.equal(motion.calls(), 1);
  view.setSettings({ interval_s: 10 }); assert.equal(motion.calls(), 1); // Disabled seconds stay retained but do not resample.
  view.update({ ...motion.next, cursor: 2 }); assert.equal(view.snapshot.opacities[0], 0);
  view.update({ ...motion.next, cursor: 2, hideCursor: false }); assert.equal(view.snapshot.opacities[0], .8); assert.equal(motion.calls(), 1);
  view.setSettings({ spacingEnabled: true }); assert.equal(motion.calls(), 2); assert.deepEqual(view.snapshot.keyframeTimes, [2]);
});

test('all-track even distributions keep aggregate-aligned endpoints and fade through offsets and partial support', t => {
  const { view } = fixture(t), primary = source({ mode: 'live', identity: 'live', times: Array.from({ length: 11 }, (_, i) => i), range: [2, 8], cursor: 20 });
  const comparison = source({ id: 'track-a', identity: 'saved', times: Array.from({ length: 11 }, (_, i) => 100 + i), bounds: [100, 110], seekOffset: -98, cursor: 120, label: 'A' });
  const next = { ...primary.next, comparisons: [comparison.next] };
  view.setSettings({ spacingEnabled: false, maxCount: 6, opacityStart: .8, opacityEnd: .2 }); view.setMode('all'); view.update(next);
  const poses = view.snapshot.poses;
  assert.deepEqual(poses.filter(pose => pose.sourceId === 'primary').map(pose => pose.sessionTime), [2, 5, 8]);
  assert.deepEqual(poses.filter(pose => pose.sourceId === 'track-a').map(pose => pose.sessionTime), [2, 5, 8]);
  assert.deepEqual(view.snapshot.opacities.slice(0, 3), view.snapshot.opacities.slice(3)); assert(view.snapshot.ghostCount <= 6);
  comparison.next.times = [101, 102, 103, 104, 105]; comparison.next.bounds = [101, 105]; comparison.next.revision = 2;
  view.update(next);
  assert.deepEqual(view.snapshot.poses.filter(pose => pose.sourceId === 'track-a').map(pose => pose.time), [103]);
  assert.deepEqual(view.snapshot.poses.filter(pose => pose.sourceId === 'track-a').map(pose => pose.sessionTime), [5]);
  assert(view.snapshot.ghostCount <= 6); // No stretching this short source to its own endpoints.
  comparison.next.seekOffset = 0; view.update(next);
  assert.equal(view.snapshot.poses.some(pose => pose.sourceId === 'track-a'), false);
  assert.equal(view.snapshot.poses.length, 6); // Disjoint sources consume no budget.
});


test('temporal display colours align across source offsets, stay cursor-independent and keep identity ticks unchanged', async t => {
  const { view, elements, scene } = fixture(t), base = 0xb48cff;
  const primary = source({ mode: 'live', identity: 'live', color: base, times: Array.from({ length: 11 }, (_, i) => i), range: [2, 8], cursor: 20 });
  const comparison = source({ id: 'track-a', identity: 'saved', color: base, times: Array.from({ length: 11 }, (_, i) => 100 + i), bounds: [100, 110], seekOffset: -98, cursor: 120, label: 'A' });
  const next = { ...primary.next, comparisons: [comparison.next] };
  view.setSettings({ spacingEnabled: false, maxCount: 6 }); view.setMode('all'); view.update(next);
  const before = view.snapshot, first = before.poses.filter(pose => pose.sourceId === 'primary'), second = before.poses.filter(pose => pose.sourceId === 'track-a');
  assert.deepEqual(first.map(pose => pose.displayColor), second.map(pose => pose.displayColor));
  assert(before.poses.every(pose => pose.color === base));
  assert.equal(first[0].displayColor, base); assert.notEqual(first[2].displayColor, base);
  assert.equal(first[2].displayColor, temporalGhostColor(8, [2, 8], base));
  const rendered = scene.getObjectByName('ghost-arms').children.at(-1).children[0].getObjectByProperty('isMesh', true).material.color.getHex();
  assert.equal(rendered, second.at(-1).displayColor);
  const tick = elements.get('live-onion-ticks').children.at(-1);
  assert.equal(tick.style['--ghost-color'], '#b48cff');
  await tick.emit('pointerenter', { clientX: 100, clientY: 100 }); assert.equal(elements.get('onion-skin-tooltip').style['--ghost-color'], '#b48cff');
  view.update({ ...next, cursor: -20 }); view.setSettings({ opacityStart: .9, opacityEnd: .7 });
  assert.deepEqual(view.snapshot.poses.map(pose => pose.displayColor), before.poses.map(pose => pose.displayColor));
  assert.equal(primary.calls(), 1); assert.equal(comparison.calls(), 1);
});
