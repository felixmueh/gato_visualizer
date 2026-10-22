import test from 'node:test';
import assert from 'node:assert/strict';
import { stripRoom, fitStripHeights, resizeStripCard, resizeStrip, STRIP_PLOT_DEFAULT } from './timeline-strip.js';

test('the strip may take what the viewport gives up above its minimum', () => {
  assert.equal(stripRoom({ rowsHeight: 237, viewportHeight: 571, viewportMin: 100 }), 708);
  assert.equal(stripRoom({ rowsHeight: 0, viewportHeight: 50, viewportMin: 100 }), 0);
  assert.equal(stripRoom({ rowsHeight: 100 }), Infinity);
});

test('stored heights are shown unchanged while they fit, defaults fill gaps', () => {
  assert.deepEqual(fitStripHeights([120, undefined], { room: 400, chrome: 72 }), [120, STRIP_PLOT_DEFAULT]);
});

test('a smaller window scales all plots down together without touching stored heights', () => {
  const stored = [300, 100];
  const shown = fitStripHeights(stored, { room: 272, chrome: 72 });
  assert.equal(shown.reduce((a, b) => a + b), 200); assert.deepEqual(shown, [150, 50]);
  assert.deepEqual(stored, [300, 100]);
  // Minimum heights win over the room; the rows then scroll.
  assert.deepEqual(fitStripHeights([100, 100], { room: 50, chrome: 0, min: 40 }), [40, 40]);
});

test('a card handle follows the mouse: down is taller, up is shorter, limits clamp the height only', () => {
  const shown = [100, 85], options = { room: 400, chrome: 72, min: 40 };
  assert.equal(resizeStripCard(shown, 0, 50, options), 150);
  assert.equal(resizeStripCard(shown, 0, -30, options), 70);
  assert.equal(resizeStripCard(shown, 0, 1000, options), 400 - 72 - 85);
  assert.equal(resizeStripCard(shown, 0, -1000, options), 40);
  // Monotonic in the drag: never inverted by a clamp.
  let last = -Infinity;
  for (let delta = -300; delta <= 600; delta += 7) { const value = resizeStripCard(shown, 0, delta, options); assert(value >= last); last = value; }
});

test('the panel edge grows the strip when dragged up and shrinks it when dragged down', () => {
  const options = { room: 600, chrome: 72, min: 40 };
  const up = resizeStrip([100, 50], 90, options); assert.deepEqual(up, [160, 80]);
  const down = resizeStrip([100, 50], -60, options); assert.deepEqual(down, [50, 40]);
  assert.equal(down.reduce((a, b) => a + b), 90);
  // Up to the viewport minimum, down to the plot minimum.
  assert.equal(resizeStrip([100, 50], 5000, options).reduce((a, b) => a + b), 600 - 72);
  assert.deepEqual(resizeStrip([100, 50], -5000, options), [40, 40]);
  let last = -Infinity;
  for (let delta = -300; delta <= 800; delta += 11) { const total = resizeStrip([100, 50], delta, options).reduce((a, b) => a + b); assert(total >= last); last = total; }
});
