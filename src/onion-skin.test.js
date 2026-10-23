import test from 'node:test';
import assert from 'node:assert/strict';
import { Color } from 'three';
import { onionKeyframes, onionBudgets, sampleAtOrBefore, onionOpacity, visibleOnionKeyframes, validateGhostSettings, DEFAULT_GHOST_SETTINGS, ONION_MIN_OPACITY, ONION_MAX_OPACITY, ONION_CURSOR_HIDE_S, TEMPORAL_END_LIGHTNESS, aggregateFraction, temporalGhostColor } from './onion-skin.js';

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

test('opacity interpolates aggregate start to end independently of cursor, with optional anti-overlap hiding', () => {
  const range = [2, 8], endpoints = { opacityStart: .8, opacityEnd: .2 };
  assert.equal(DEFAULT_GHOST_SETTINGS.opacityStart, .55); assert.equal(DEFAULT_GHOST_SETTINGS.opacityEnd, .25);
  assert.equal(onionOpacity(2, -10, range, endpoints), .8);
  assert(Math.abs(onionOpacity(8, 20, range, endpoints) - .2) < 1e-12);
  assert.equal(onionOpacity(5, 1, range, endpoints), .5); assert.equal(onionOpacity(5, 9, range, endpoints), .5);
  assert.equal(onionOpacity(-1, 10, range, endpoints), .8); assert(Math.abs(onionOpacity(12, 1, range, endpoints) - .2) < 1e-12);
  assert.equal(onionOpacity(5, 5, range, endpoints), 0);
  assert.equal(onionOpacity(ONION_CURSOR_HIDE_S, 0, range), 0);
  assert.equal(onionOpacity(5, 5, range, { ...endpoints, hideCursor: false }), .5);
  assert.equal(onionOpacity(5, 10, [5, 5], endpoints), .8);
  const reverse = { opacityStart: .2, opacityEnd: .8 };
  assert.equal(onionOpacity(2, 10, range, reverse), .2); assert.equal(onionOpacity(5, 10, range, reverse), .5); assert.equal(onionOpacity(8, 10, range, reverse), .8);
  for (const value of [{ opacityStart: 2 }, { opacityEnd: -1 }, { spacingEnabled: 1 }, { interval_s: 0 }, { maxCount: 65 }, { maxCount: 1.5 }]) assert.throws(() => validateGhostSettings(value));
});

test('disabled fixed spacing distributes a budget over the full aggregate endpoints before support intersection', () => {
  const options = { spacingEnabled: false, range: [2, 8], maxCount: 4, interval_s: .01 };
  assert.deepEqual(onionKeyframes([0, 10], options), { step: null, times: [2, 4, 6, 8] });
  assert.deepEqual(onionKeyframes([3, 7], options), { step: null, times: [4, 6] });
  assert.deepEqual(onionKeyframes([3, 7], { ...options, maxCount: 2 }).times, []); // Never stretch short support to fake endpoints.
  assert.deepEqual(onionKeyframes([0, 10], { ...options, maxCount: 1 }).times, [2]);
  assert.deepEqual(onionKeyframes([0, 10], { ...options, range: [5, 5] }).times, [5]);
  assert.deepEqual(onionKeyframes([0, 1], options).times, []);
  const sources = [{ times: [2, 8], range: [2, 8] }, { times: [100, 106], range: [100, 106] }, { times: [200, 210], range: [2, 8] }];
  assert.deepEqual(onionBudgets(sources, 6, options), [3, 3, 0]);
  for (const [source, budget] of sources.map((source, i) => [source, [3, 3, 0][i]])) if (budget) assert.equal(onionKeyframes(source.times, { ...options, range: source.range, maxCount: budget }).times.length, 3);
});

test('Live reveal hides future ghosts while growing, and completed history shows all', () => {
  const times = [0, 1, 2, 3];
  assert.deepEqual(visibleOnionKeyframes(times, 1.5, true), [0, 1]);
  assert.equal(visibleOnionKeyframes(times, 1.5, false), times);
  const snapped = [{ time: 0, q: [1] }, { time: 1, q: [2] }, { time: 2, q: [3] }];
  assert.deepEqual(visibleOnionKeyframes(snapped, 1.5, true), snapped.slice(0, 2));
});


test('temporal colour darkens lightness gently across the aggregate while preserving palette hue and saturation', () => {
  const range = [2, 8];
  assert.equal(TEMPORAL_END_LIGHTNESS, .85);
  for (const base of [0xb48cff, 0x6fa8ff, 0x6fdc8c, 0xff7eb6, 0xc8a27a, 0xaeb7c2]) {
    const original = new Color(base).getHSL({});
    assert.equal(temporalGhostColor(2, range, base), base);
    const middle = new Color(temporalGhostColor(5, range, base)).getHSL({}), end = new Color(temporalGhostColor(8, range, base)).getHSL({});
    assert(original.l > middle.l && middle.l > end.l);
    // Display colours are 8-bit hex; tolerances allow one-channel rounding.
    assert(Math.abs(middle.l - original.l * .925) < .003);
    assert(Math.abs(end.l - original.l * .85) < .003);
    for (const tint of [middle, end]) { assert(Math.abs(tint.h - original.h) < .005); assert(Math.abs(tint.s - original.s) < .006); }
    assert.equal(temporalGhostColor(-20, range, base), base);
    assert.equal(temporalGhostColor(50, range, base), temporalGhostColor(8, range, base));
    assert.equal(temporalGhostColor(5, [5, 5], base), base);
    assert.equal(temporalGhostColor(105, [102, 108], base), temporalGhostColor(5, range, base));
  }
  assert.equal(aggregateFraction(5, range), .5); assert.equal(aggregateFraction(-1, range), 0); assert.equal(aggregateFraction(20, range), 1);
});
