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
    const keyframes = [{ time: 2.5, color: 0x34d8d4 }], intervals = [];
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
    await surface.emit('pointermove', pointer()); assert.equal(tooltip.textContent, '2.500 s');
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
