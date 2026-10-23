import test from 'node:test';
import assert from 'node:assert/strict';
import { onionKeyframes, onionBudgets, sampleAtOrBefore, onionOpacity, visibleOnionKeyframes, validateGhostSettings, DEFAULT_GHOST_SETTINGS, ONION_MIN_OPACITY, ONION_MAX_OPACITY, ONION_CURSOR_HIDE_S } from './onion-skin.js';

test('fixed seconds spacing takes a capped prefix from the selected range without widening or a forced endpoint', () => {
  assert.deepEqual(onionKeyframes([0, 10], { range: [2, 8], interval_s: 1, maxCount: 4 }), { step: 1, times: [2, 3, 4, 5] });
  assert.deepEqual(onionKeyframes([0, 3.6]), { step: .5, times: [0, .5, 1, 1.5, 2, 2.5, 3, 3.5] });
  assert.deepEqual(onionKeyframes([0, 4], { interval_s: .5, maxCount: 4 }), { step: .5, times: [0, .5, 1, 1.5] });
  assert.deepEqual(onionKeyframes([0, 4], { maxCount: 1 }), { step: .5, times: [0] });
  for (const maxCount of [1, 2, 8, 16, 64]) for (const end of [.014, 3.625, 7.9, 100, 10000]) {
    const selected = onionKeyframes([0, end], { maxCount, interval_s: .01 });
    assert(selected.times.length <= maxCount); assert.equal(selected.times[0], 0); assert.equal(selected.step, .01);
  }
});

test('the range left edge anchors the grid even when the source starts later or uses a negative native clock', () => {
  assert.deepEqual(onionKeyframes([1.1, 4.8], { interval_s: 1 }).times, [1.1, 2.1, 3.1, 4.1]);
  assert.deepEqual(onionKeyframes([1.1, 4.8], { range: [0, 5], interval_s: 1 }).times, [2, 3, 4]);
  assert.deepEqual(onionKeyframes([-2.3, 1.2], { range: [-3, 1], interval_s: 1 }).times, [-2, -1, 0, 1]);
  assert.deepEqual(onionKeyframes([100.2, 102], { range: [100.1, 102], interval_s: .1, maxCount: 2 }).times, [100.2, 100.3]);
});

test('narrow, zero-length, disjoint and open ranges keep only in-range grid candidates', () => {
  assert.deepEqual(onionKeyframes([0, 5], { range: [2.1, 2.2], interval_s: 1 }).times, [2.1]);
  assert.deepEqual(onionKeyframes([0, 5], { range: [2, 2] }).times, [2]);
  assert.deepEqual(onionKeyframes([2.1, 2.2], { range: [0, 5], interval_s: 1 }).times, []);
  assert.deepEqual(onionKeyframes([0, 5], { range: [6, 8] }).times, []);
  assert.deepEqual(onionKeyframes([0, 5], { range: [3, 2] }).times, []);
  assert.deepEqual(onionKeyframes([2, 4], { range: [null, null], interval_s: 1 }).times, [2, 3, 4]);
  assert.deepEqual(onionKeyframes([]), { step: null, times: [] });
  assert.deepEqual(onionKeyframes([1.234]), { step: .5, times: [1.234] });
  assert.deepEqual(onionKeyframes([2, 2]), { step: .5, times: [2] });
});

test('Live growth retains the old fixed-spacing prefix without redistributing ghosts across the longer duration', () => {
  const options = { range: [0, 100], interval_s: 1, maxCount: 4 };
  assert.deepEqual(onionKeyframes([0, 3.6], options).times, [0, 1, 2, 3]);
  assert.deepEqual(onionKeyframes([0, 100], options).times, [0, 1, 2, 3]);
});

test('one global maximum excludes sources without any in-range grid candidate', () => {
  const sources = [{ times: [] }, { times: [0, 1] }, { times: [2], range: [0, 1] }, { times: [0, 3] }];
  assert.deepEqual(onionBudgets(sources, 5), [0, 3, 0, 2]);
  assert.deepEqual(onionBudgets(sources, 1), [0, 1, 0, 0]);
  assert.deepEqual(onionBudgets([{ times: [2.1, 2.2], range: [0, 5] }, { times: [0, 5] }], 4, { interval_s: 1 }), [0, 4]);
});

test('nonuniform recorded states snap at or before a keyframe, retaining the sample timestamp', () => {
  const times = [1.1, 1.3, 1.8, 2.1];
  for (const [time, index] of [[0, 0], [1.1, 0], [1.5, 1], [1.8, 2], [2.1, 3], [3, 3]]) assert.equal(sampleAtOrBefore(times, time), index);
  assert.equal(sampleAtOrBefore([], 1), -1); assert.equal(sampleAtOrBefore([2], 5), 0);
});

test('stronger adjustable opacity fades symmetrically and hides the coinciding arm', () => {
  const range = [0, 10], cursor = 5;
  assert.equal(DEFAULT_GHOST_SETTINGS.opacity, .55);
  assert.equal(onionOpacity(cursor, cursor, range), 0);
  assert.equal(onionOpacity(ONION_CURSOR_HIDE_S, 0, range), 0);
  const near = onionOpacity(5.01, cursor, range), middle = onionOpacity(6, cursor, range), far = onionOpacity(9, cursor, range);
  assert(near > middle && middle > far); assert(near < ONION_MAX_OPACITY && far > ONION_MIN_OPACITY);
  assert.equal(onionOpacity(1, cursor, range), far);
  assert(Math.abs(onionOpacity(0, 10, range) - ONION_MIN_OPACITY) < 1e-12);
  assert.equal(onionOpacity(6, cursor, range, .275), middle / 2);
  assert.equal(onionOpacity(6, cursor, range, 0), 0);
  for (const value of [{ opacity: 2 }, { interval_s: 0 }, { maxCount: 65 }, { maxCount: 1.5 }]) assert.throws(() => validateGhostSettings(value));
});

test('Live reveal hides future ghosts while growing, and completed history shows all', () => {
  const times = [0, 1, 2, 3];
  assert.deepEqual(visibleOnionKeyframes(times, 1.5, true), [0, 1]);
  assert.equal(visibleOnionKeyframes(times, 1.5, false), times);
  const snapped = [{ time: 0, q: [1] }, { time: 1, q: [2] }, { time: 2, q: [3] }];
  assert.deepEqual(visibleOnionKeyframes(snapped, 1.5, true), snapped.slice(0, 2));
});
