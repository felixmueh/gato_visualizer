import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSpan, moveAggregateBound, aggregateLabel, aggregateBounded, timelineTypingTarget, timelineBounds, clampTimelineWindow, zoomTimeline, timelineTicks, indexTimelineIntervals, visibleTimelineIntervals, setupExpandedTimeline } from './expanded-timeline.js';
import { plotDOM } from './plot-dom-test-helper.js';

test('timeline windows clamp pan, empty recordings and fine zoom to retained time', () => {
  assert.deepEqual(timelineBounds([NaN, Infinity]), [0, 0]);
  assert.deepEqual(clampTimelineWindow([10, 20], [2, 8]), [2, 8]);
  assert.deepEqual(clampTimelineWindow([-20, -18], [2, 8]), [2, 4]);
  assert.deepEqual(clampTimelineWindow([1, 4], [2, 2]), [2, 2]);
  assert.deepEqual(zoomTimeline([0, 10], [0, 10], .5, .25), [1.25, 6.25]);
  const fine = zoomTimeline([0, 10], [0, 10], .0000001, .5);
  assert(Math.abs(fine[1] - fine[0] - .001) < 1e-12);
  assert.deepEqual(zoomTimeline([2, 2], [2, 2], .5), [2, 2]);
  assert.deepEqual(zoomTimeline([0, .0001], [0, .0001], .5), [0, .0001]);
});

test('adaptive ruler displays unique submillisecond labels without dense tick DOM', () => {
  for (const window of [[0, 10000], [10, 10.001], [3.1234, 3.1244]]) {
    const ticks = timelineTicks(window, 640);
    assert(ticks.length > 0 && ticks.length <= 8);
    assert.equal(new Set(ticks.map(tick => tick.label)).size, ticks.length);
    assert(ticks.every(tick => tick.fraction >= -1e-8 && tick.fraction <= 1 + 1e-8));
  }
  assert.deepEqual(timelineTicks([1, 1], 640), []);
});

test('visible interval index retains overlapping red priority and actual short intervals', () => {
  const index = indexTimelineIntervals([
    { start_time_s: 0, end_time_s: 10, combined_overrun: true },
    { start_time_s: 4, end_time_s: 4.00001, mpc_overrun: true, physics_overrun: true },
    { start_time_s: 2, end_time_s: 3 },
    { start_time_s: 1, end_time_s: NaN },
  ]);
  assert.equal(index.length, 3);
  assert.deepEqual(visibleTimelineIntervals(index, [4, 4.001]).map(item => item.severity), ['yellow', 'red']);
  assert.equal(index[2].end, 4.00001);
  assert.deepEqual(visibleTimelineIntervals(index, [10, 11]), []);
});

test('a narrow viewport only returns intersecting entries from a 12000 interval history', () => {
  const index = indexTimelineIntervals(Array.from({ length: 12000 }, (_, i) => ({ start_time_s: i * .01, end_time_s: (i + 1) * .01, mpc_overrun: i % 7 === 0 })));
  const visible = visibleTimelineIntervals(index, [52.002, 52.008]);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].start, 52);
});


test('metric form controls and inherited editable descendants keep their keyboard input', () => {
  for (const tagName of ['INPUT', 'SELECT', 'TEXTAREA']) assert.equal(timelineTypingTarget({ tagName }), true);
  assert.equal(timelineTypingTarget({ tagName: 'SPAN', isContentEditable: true }), true);
  assert.equal(timelineTypingTarget({ tagName: 'DIV', isContentEditable: false }), false);
  assert.equal(timelineTypingTarget({ tagName: 'CANVAS' }), false);
});

test('aggregate window bounds snap open at the data edges and never cross', () => {
  const bounds = [2, 12], open = { start: null, end: null };
  assert.deepEqual(aggregateSpan(open, bounds), [2, 12]);
  assert.equal(aggregateBounded(open), false);
  let window = moveAggregateBound(open, 'start', 4, bounds, .1);
  assert.deepEqual(window, { start: 4, end: null });
  window = moveAggregateBound(window, 'end', 8, bounds, .1);
  assert.deepEqual(window, { start: 4, end: 8 }); assert.equal(aggregateLabel(window), '4.000 s → 8.000 s');
  // Dragging an end onto (or past) the data edge leaves it unbounded.
  assert.deepEqual(moveAggregateBound(window, 'end', 11.95, bounds, .1), { start: 4, end: null });
  assert.deepEqual(moveAggregateBound(window, 'end', 30, bounds, .1), { start: 4, end: null });
  assert.deepEqual(moveAggregateBound(window, 'start', -5, bounds, .1), { start: null, end: 8 });
  // A bound is stopped by the opposite bound rather than swapping sides.
  assert.deepEqual(moveAggregateBound(window, 'start', 10, bounds, .1), { start: 8, end: 8 });
  assert.deepEqual(moveAggregateBound(window, 'end', 3, bounds, .1), { start: 4, end: 4 });
  // An open end follows growing data; fixed bounds clamp to retained history.
  assert.deepEqual(aggregateSpan({ start: 4, end: null }, [2, 20]), [4, 20]);
  assert.deepEqual(aggregateSpan({ start: 0, end: 30 }, bounds), [2, 12]);
  assert.equal(aggregateLabel({ start: null, end: 8 }), 'start → 8.000 s');
  assert.equal(aggregateLabel({ start: 4, end: null }), '4.000 s → latest');
});

test('onion ticks repaint by revision and seek only from plain clicks in their ruler band', async () => {
  const { document: doc } = plotDOM(), nodes = new Map(), strokes = [], seeks = [];
  const context = { scale() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {}, measureText: () => ({ width: 30 }), fillRect(...rect) { strokes.push({ color: this.fillStyle, rect }); } };
  doc.getElementById = id => {
    if (!nodes.has(id)) {
      const node = doc.createElement(id === 'timeline-bands' ? 'canvas' : 'div');
      node.classList.remove = name => node.classList.toggle(name, false);
      node.setPointerCapture = () => {}; node.hasPointerCapture = () => false;
      node.getContext = () => context; nodes.set(id, node);
    }
    return nodes.get(id);
  };
  const previousObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} };
  try {
    const timeline = setupExpandedTimeline({ document: doc, onSeek: time => seeks.push(time) });
    const keyframes = [{ time: 2.5, sampleTime: 12.5, color: 0x34d8d4 }], intervals = [];
    const update = (revision = 1) => timeline.update({ identity: 'episode', mode: 'replay', bounds: [0, 10], time: 0, keyframes, keyframeRevision: revision, intervals });
    update(); await nodes.get('replay-timeline-expand').emit('click');
    assert(strokes.some(item => item.color === '#34d8d4' && item.rect[0] === 149 && item.rect[1] === 23));
    const paints = timeline.snapshot.paints; update(); assert.equal(timeline.snapshot.paints, paints);
    update(2); assert.equal(timeline.snapshot.paints, paints + 1);
    const surface = nodes.get('timeline-inspector'), tooltip = nodes.get('timeline-inspection-tooltip');
    const pointer = (x = 152, y = 27, extra = {}) => ({ pointerId: 1, button: 0, clientX: x, clientY: y, ...extra });
    const click = async (x, y, extra = {}) => {
      await surface.emit('pointerdown', pointer(x, y, extra));
      await surface.emit('pointerup', pointer(x, y, { type: 'pointerup', ...extra }));
    };
    await surface.emit('pointermove', pointer()); assert.equal(tooltip.textContent, '12.500 s');
    await click(152, 27); assert.equal(seeks.at(-1), 2.5);
    await click(152, 50); assert.equal(seeks.at(-1), 152 / 600 * 10);
    // A drag that began on a tick continues ordinary scrubbing without snapping back.
    await surface.emit('pointerdown', pointer());
    await surface.emit('pointermove', pointer(180));
    await surface.emit('pointerup', pointer(180, 27, { type: 'pointerup' }));
    assert.equal(seeks.at(-1), 3);
    const count = seeks.length;
    await click(152, 27, { shiftKey: true }); assert.equal(seeks.length, count);
    await click(152, 27, { altKey: true }); assert.equal(seeks.length, count);
    const plot = doc.createElement('div'); plot.classList.remove = () => {}; plot.setPointerCapture = () => {}; plot.hasPointerCapture = () => false;
    timeline.bindSurface(plot);
    await plot.emit('pointerdown', pointer()); await plot.emit('pointerup', pointer(152, 27, { type: 'pointerup' }));
    assert.equal(seeks.at(-1), 152 / 600 * 10);
    // Zoom moves the same keyframe to 0 px; no stale hit at its old position.
    timeline.zoom(.5);
    await click(152, 27); assert.equal(seeks.at(-1), 2.5 + 152 / 600 * 5);
    await click(1, 27); assert.equal(seeks.at(-1), 2.5);
  } finally { globalThis.ResizeObserver = previousObserver; }
});

function sessionTimelineFixture(callbacks = {}) {
  const { document: doc } = plotDOM(), nodes = new Map(), draws = [];
  const createElement = doc.createElement;
  doc.createElement = tag => {
    const node = createElement(tag); node.classList.remove = name => node.classList.toggle(name, false);
    let capture;
    node.setPointerCapture = pointer => { capture = pointer; }; node.hasPointerCapture = pointer => capture === pointer;
    node.releasePointerCapture = () => { capture = undefined; };
    node.getContext = () => ({ scale() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {}, measureText: () => ({ width: 30 }), fillRect(...rect) { draws.push({ node, color: this.fillStyle, rect }); } });
    return node;
  };
  doc.getElementById = id => {
    if (!nodes.has(id)) nodes.set(id, doc.createElement(id === 'timeline-bands' ? 'canvas' : 'div'));
    return nodes.get(id);
  };
  const observer = globalThis.ResizeObserver; globalThis.ResizeObserver = class { observe() {} };
  let timeline;
  try { timeline = setupExpandedTimeline({ document: doc, onSeek() {}, ...callbacks }); }
  finally { globalThis.ResizeObserver = observer; }
  return { timeline, nodes, draws, doc };
}

const laneTracks = () => [
  { id: 'live', kind: 'live', letter: 'A', label: 'Live', color: 0xffffff, offset_s: 0, span: [0, 10], visible: true, display: 'arm' },
  { id: 'b', kind: 'replay', letter: 'B', label: 'Reach', color: 0xb48cff, offset_s: 1, span: [2, 4], visible: true, display: 'arm', differences: [{ text: 'SQP: 10' }, { text: 'N: 64' }, { text: 'dt: 0.02' }], badges: [{ label: 'Frame', title: 'Tool frames differ' }] },
];

test('session lanes group freezes first, keep timing on Live and cache across cursor motion', async () => {
  const added = [], tracks = laneTracks(), { timeline, nodes, draws } = sessionTimelineFixture({ onAddTrack: id => added.push(id) });
  const intervals = [{ start_time_s: 0, end_time_s: .1, mpc_overrun: true }];
  const update = time => timeline.update({ mode: 'live', identity: 'session', bounds: [0, 10], time, tracks, revision: 1, intervals, breaches: [{ sim_time_s: 3 }], catalog: [
    { id: 'experiment', name: 'Reach test', source: 'ingest', status: 'ready' }, { id: 'bad', source: 'ingest', status: 'error' },
    { id: 'freeze', name: 'Freeze B', source: 'freeze', status: 'ready' },
  ] });
  update(0); assert.equal(nodes.get('live-timeline-expand').dataset.trackCount, '1');
  assert.equal(timeline.snapshot.lanePaints, 0);
  await nodes.get('live-timeline-expand').emit('click');
  const lanes = nodes.get('timeline-lanes'), rows = lanes.children;
  assert.equal(rows.length, 2); assert.equal(nodes.get('timeline-track-picker').hidden, false);
  assert.equal(rows[0].querySelector('.timeline-lane-offset').value, '+0.000');
  assert.equal(rows[0].querySelector('.timeline-lane-offset').disabled, true);
  assert.equal(rows[1].querySelector('.timeline-lane-offset').value, '+1.000');
  assert.equal(rows[1].querySelector('.timeline-lane-differences').textContent, 'SQP: 10 · N: 64');
  assert.match(rows[1].querySelector('.timeline-lane-differences').title, /dt: 0.02/);
  assert.equal(rows[1].querySelector('.timeline-lane-badge').title, 'Tool frames differ');
  assert(draws.some(draw => draw.node === rows[0].querySelector('canvas') && draw.color === '#ed716c'));
  assert(!draws.some(draw => draw.node === nodes.get('timeline-bands') && draw.color === '#ed716c'));
  assert.equal(rows[1].querySelector('canvas').hidden, true);
  const paints = timeline.snapshot.paints, lanePaints = timeline.snapshot.lanePaints;
  update(5); assert.equal(timeline.snapshot.paints, paints); assert.equal(timeline.snapshot.lanePaints, lanePaints);
  assert.equal(rows[1].querySelector('.timeline-lane-cursor').style.left, '50%');
  const choices = nodes.get('timeline-track-menu').children;
  assert.equal(choices[0].textContent, 'Temporary'); assert.equal(choices[1].textContent, 'Freeze B');
  await choices[1].emit('click'); assert.deepEqual(added, ['freeze']);
  assert.equal(nodes.get('timeline-track-menu').hidden, true);
  await rows[1].querySelector('.timeline-lane-rail').emit('pointermove', { clientX: 300 });
  assert.equal(nodes.get('timeline-inspection-tooltip').textContent, 'B · 4.000 s');
});

test('lane drag uses pointer capture, six-pixel snapping and Alt; explicit edits and controls use track callbacks', async () => {
  const changes = [], resets = [], removed = [], tracks = laneTracks();
  const { timeline, nodes } = sessionTimelineFixture({ onTrackChange: (id, patch) => changes.push([id, patch]), onTrackReset: id => resets.push(id), onTrackRemove: id => removed.push(id) });
  timeline.update({ mode: 'live', identity: 'session', bounds: [0, 10], time: 5, tracks });
  await nodes.get('live-timeline-expand').emit('click');
  const row = nodes.get('timeline-lanes').children[1], clip = row.querySelector('.timeline-lane-clip'), rail = row.querySelector('.timeline-lane-rail');
  const pointer = (x, extra = {}) => ({ pointerId: 2, button: 0, clientX: x, ...extra });
  await clip.emit('pointerdown', pointer(0)); assert.equal(clip.hasPointerCapture(2), true);
  await rail.emit('pointermove', pointer(-175)); // First recorded sample at 2 s snaps onto session 0.
  assert.equal(changes.at(-1)[1].offset_s, -2);
  await rail.emit('pointermove', pointer(-175, { altKey: true }));
  assert(Math.abs(changes.at(-1)[1].offset_s - (1 - 175 / 600 * 10)) < 1e-12);
  await clip.emit('pointerup', pointer(-175)); assert.equal(clip.hasPointerCapture(2), false);
  await clip.emit('dblclick'); assert.deepEqual(resets, ['b']);
  const offset = row.querySelector('.timeline-lane-offset'); offset.value = '-0.350'; await offset.emit('change'); assert.deepEqual(changes.at(-1), ['b', { offset_s: -.35 }]);
  offset.value = 'bad'; await offset.emit('change'); assert.equal(offset.value, '+1.000');
  await row.querySelector('.timeline-lane-visibility').emit('click'); assert.deepEqual(changes.at(-1), ['b', { visible: false }]);
  await row.querySelector('.timeline-lane-display').emit('click'); assert.deepEqual(changes.at(-1), ['b', { display: 'dot' }]);
  await row.querySelector('.timeline-lane-remove').emit('click'); assert.deepEqual(removed, ['b']);
});

test('session aggregate and zoom persist across generations, empty main spans and Replay visits', async () => {
  const { timeline, nodes } = sessionTimelineFixture(), intervals = [];
  const live = (bounds, revision) => timeline.update({ mode: 'live', identity: 'session', bounds, time: 0, revision, intervals, tracks: laneTracks() });
  live([0, 10], 1); await nodes.get('live-timeline-expand').emit('click');
  timeline.zoom(.5); timeline.setAggregate({ start: 3, end: 7 });
  assert.deepEqual(timeline.snapshot.visible, [2.5, 7.5]);
  live([0, 0], 2); assert.deepEqual(timeline.snapshot.visible, [2.5, 7.5]); assert.deepEqual(timeline.snapshot.aggregate, { start: 3, end: 7 });
  live([0, 20], 3); assert.deepEqual(timeline.snapshot.visible, [2.5, 7.5]);
  timeline.update({ mode: 'replay', identity: 'other', bounds: [100, 102], time: 100, intervals });
  assert.deepEqual(timeline.snapshot.aggregate, { start: null, end: null }); assert.equal(nodes.get('timeline-lanes').hidden, true);
  live([0, 20], 4); assert.deepEqual(timeline.snapshot.visible, [2.5, 7.5]); assert.deepEqual(timeline.snapshot.aggregate, { start: 3, end: 7 });
});


test('different Replay object identities reset independently while Live session windows stay retained', async () => {
  const { timeline } = sessionTimelineFixture();
  timeline.update({ mode: 'replay', identity: { id: 'one' }, bounds: [0, 10], time: 0 });
  timeline.zoom(.5); timeline.setAggregate({ start: 3, end: 4 });
  timeline.update({ mode: 'replay', identity: { id: 'two' }, bounds: [100, 110], time: 100 });
  assert.deepEqual(timeline.snapshot.aggregate, { start: null, end: null });
  assert.deepEqual(timeline.snapshot.visible, [100, 110]);
});

test('compact Live rows show editable names, source tooltips and one aligned remove/freeze action slot', async () => {
  const changes = [], freezes = [], tracks = laneTracks();
  tracks[1].displayName = 'A'; tracks[1].defaultName = 'A'; tracks[1].label = 'Source filename';
  tracks[1].badges.push({ label: 'Incomplete', title: 'Incomplete run' });
  const { timeline, nodes } = sessionTimelineFixture({ onTrackChange: (id, patch) => changes.push([id, patch]), onFreeze: () => freezes.push(true) });
  const update = freezeAvailable => timeline.update({ mode: 'live', identity: 'session', bounds: [0, 10], time: 0, tracks, freezeAvailable });
  update(true); await nodes.get('live-timeline-expand').emit('click');
  assert.equal(nodes.get('timeline-bands').height, 20);
  const rows = nodes.get('timeline-lanes').children, main = rows[0], replay = rows[1];
  assert.equal(main.querySelector('.timeline-lane-label').textContent, 'Live');
  const name = replay.querySelector('.timeline-lane-name'); assert.equal(name.value, 'A'); assert.match(name.title, /Source filename/);
  name.value = 'slow run'; await name.emit('change'); assert.deepEqual(changes.at(-1), ['b', { displayName: 'slow run' }]);
  assert.equal(replay.querySelectorAll('.timeline-lane-badge').some(node => node.textContent === 'Incomplete'), false);
  const header = replay.querySelector('.timeline-lane-header');
  assert.deepEqual(header.children.map(node => node.className), ['timeline-lane-chip', 'timeline-lane-information', 'timeline-lane-offset', 'timeline-lane-offset-unit', 'timeline-lane-visibility', 'timeline-lane-display', 'timeline-lane-action']);
  const mainHeader = main.querySelector('.timeline-lane-header'), action = replay.querySelector('.timeline-lane-action'), mainAction = main.querySelector('.timeline-lane-action');
  assert.equal(header.children.at(-1), action); assert.equal(mainHeader.children.at(-1), mainAction);
  assert.equal(replay.querySelector('.timeline-lane-remove').parentElement, action); assert.equal(replay.querySelector('.timeline-lane-freeze').parentElement, action);
  assert.equal(main.querySelector('.timeline-lane-remove').parentElement, mainAction); assert.equal(main.querySelector('.timeline-lane-freeze').parentElement, mainAction);
  assert.equal(replay.querySelector('.timeline-lane-remove').textContent, '×');
  assert.equal(main.querySelector('.timeline-lane-remove').hidden, true); assert.equal(replay.querySelector('.timeline-lane-freeze').hidden, true);
  await main.querySelector('.timeline-lane-freeze').emit('click'); assert.equal(freezes.length, 1);
  update(false); await main.querySelector('.timeline-lane-freeze').emit('click'); assert.equal(freezes.length, 1);
});

test('scrubbing and aggregate selection operate on each lane while offset dragging stays separate', async () => {
  const seeks = [], changes = [], tracks = laneTracks();
  const { timeline, nodes } = sessionTimelineFixture({ onSeek: time => seeks.push(time), onTrackChange: (id, patch) => changes.push([id, patch]) });
  timeline.update({ mode: 'live', identity: 'session', bounds: [0, 10], time: 0, tracks });
  await nodes.get('live-timeline-expand').emit('click');
  const rows = nodes.get('timeline-lanes').children, rail = rows[1].querySelector('.timeline-lane-rail'), clip = rows[1].querySelector('.timeline-lane-clip');
  const pointer = (x, extra = {}) => ({ pointerId: 3, button: 0, clientX: x, clientY: 20, ...extra });
  await rail.emit('pointerdown', pointer(120)); await rail.emit('pointermove', pointer(240)); await rail.emit('pointerup', pointer(240, { type: 'pointerup' }));
  assert.equal(seeks.at(-1), 4);
  await clip.emit('pointerdown', pointer(120, { shiftKey: true })); // Bubbles to rail in the browser; emit that stage explicitly.
  await rail.emit('pointerdown', pointer(120, { shiftKey: true, target: clip }));
  await rail.emit('pointermove', pointer(420, { shiftKey: true })); await rail.emit('pointerup', pointer(420, { type: 'pointerup', shiftKey: true }));
  assert.deepEqual(timeline.snapshot.aggregate, { start: 2, end: 7 }); assert.deepEqual(changes, []);
  assert.equal(nodes.get('timeline-window-shade-start').style.width, '20%'); assert.equal(nodes.get('timeline-window-shade-end').style.width, '30%');
  const overlay = nodes.get('timeline-aggregate-overlay'), handle = nodes.get('timeline-window-start');
  handle.className = 'timeline-window-handle'; handle.dataset.side = 'start';
  await overlay.emit('pointerdown', pointer(120, { target: handle }));
  await overlay.emit('pointermove', pointer(180, { target: handle })); await overlay.emit('pointerup', pointer(180, { type: 'pointerup' }));
  assert.deepEqual(timeline.snapshot.aggregate, { start: 3, end: 7 });
  await clip.emit('pointerdown', pointer(120)); await rail.emit('pointermove', pointer(150, { altKey: true })); await clip.emit('pointerup', pointer(150));
  assert.deepEqual(changes.at(-1), ['b', { offset_s: 1.5 }]); assert.deepEqual(timeline.snapshot.aggregate, { start: 3, end: 7 });
});
