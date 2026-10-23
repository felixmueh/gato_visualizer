import test from 'node:test';
import assert from 'node:assert/strict';
import { onionKeyframes, sampleAtOrBefore, onionOpacity, visibleOnionKeyframes, ONION_MIN_OPACITY, ONION_MAX_OPACITY, ONION_CURSOR_HIDE_S } from './onion-skin.js';

test('keyframes use the smallest nice step with at most eight absolute grid points plus the final state', () => {
  assert.deepEqual(onionKeyframes([0, 3.6]), { step: .5, times: [0, .5, 1, 1.5, 2, 2.5, 3, 3.6] });
  // .5 would put nine grid points inside this inclusive range.
  assert.deepEqual(onionKeyframes([0, 4]), { step: 1, times: [0, 1, 2, 3, 4] });
  assert.deepEqual(onionKeyframes([0, .014]), { step: .002, times: [0, .002, .004, .006, .008, .01, .012, .014] });
  assert.deepEqual(onionKeyframes([0, 71]), { step: 10, times: [0, 10, 20, 30, 40, 50, 60, 71] });
});

test('offset and negative ranges keep absolute multiples, not offsets from their first sample', () => {
  assert.deepEqual(onionKeyframes([1.1, 4.8]), { step: .5, times: [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 4.8] });
  assert.deepEqual(onionKeyframes([-2.3, 1.2]), { step: .5, times: [-2, -1.5, -1, -.5, 0, .5, 1, 1.2] });
});

test('the final recorded state replaces a near-final grid point but preserves quarter-step spacing', () => {
  assert.deepEqual(onionKeyframes([0, 3.6]).times, [0, .5, 1, 1.5, 2, 2.5, 3, 3.6]);
  assert.deepEqual(onionKeyframes([0, 3.625]).times, [0, .5, 1, 1.5, 2, 2.5, 3, 3.5, 3.625]);
  assert.equal(onionKeyframes([0, 3.5]).times.filter(time => time === 3.5).length, 1);
  assert.deepEqual(onionKeyframes([.3, .6, .7]).times.at(-1), .7);
});

test('Live growth keeps its spacing through sixteen grid points and recomputes once exceeded', () => {
  const initial = onionKeyframes([0, 3.6]);
  const held = onionKeyframes([0, 7.9], { previousStep: initial.step });
  assert.equal(held.step, .5);
  assert.equal(held.times.length, 17); // Sixteen grid points and the final state.
  const recomputed = onionKeyframes([0, 8], { previousStep: held.step });
  assert.equal(recomputed.step, 2);
  assert.deepEqual(recomputed.times, [0, 2, 4, 6, 8]);
  assert.equal(onionKeyframes([0, 2], { previousStep: 2 }).step, 2);
});

test('empty, single-sample and zero-length motions preserve recorded endpoints', () => {
  assert.deepEqual(onionKeyframes([]), { step: null, times: [] });
  assert.deepEqual(onionKeyframes([1.234]), { step: null, times: [1.234] });
  assert.deepEqual(onionKeyframes([2, 2]), { step: null, times: [2] });
  assert.deepEqual(onionKeyframes([2], { previousStep: .5 }), { step: .5, times: [2] });
});

test('nonuniform recorded states snap at or before a keyframe, retaining the sample timestamp', () => {
  const times = [1.1, 1.3, 1.8, 2.1];
  for (const [time, index] of [[0, 0], [1.1, 0], [1.5, 1], [1.8, 2], [2.1, 3], [3, 3]]) {
    assert.equal(sampleAtOrBefore(times, time), index);
    assert.equal(times[sampleAtOrBefore(times, time)], times[index]);
  }
  assert.equal(times[sampleAtOrBefore(times, 1.5)], 1.3);
  assert.equal(sampleAtOrBefore([], 1), -1);
  assert.equal(sampleAtOrBefore([2], 5), 0);
});

test('opacity rises linearly toward the cursor, is symmetric, and hides the coinciding arm', () => {
  const range = [0, 10], cursor = 5;
  assert.equal(onionOpacity(cursor, cursor, range), 0);
  assert.equal(onionOpacity(0, 0, [0, 0]), 0);
  assert.equal(onionOpacity(ONION_CURSOR_HIDE_S, 0, range), 0);
  const near = onionOpacity(5.01, cursor, range), middle = onionOpacity(6, cursor, range), far = onionOpacity(9, cursor, range);
  assert(near > middle && middle > far);
  assert(near < ONION_MAX_OPACITY && far > ONION_MIN_OPACITY);
  assert.equal(onionOpacity(1, cursor, range), far);
  assert.equal(onionOpacity(0, 10, range), ONION_MIN_OPACITY);
  assert.equal(onionOpacity(0, 20, 10), ONION_MIN_OPACITY);
});

test('Live reveal hides future ghosts while growing, and completed history shows all', () => {
  const times = [0, 1, 2, 3];
  assert.deepEqual(visibleOnionKeyframes(times, 1.5, true), [0, 1]);
  assert.deepEqual(visibleOnionKeyframes(times, 1, true), [0, 1]);
  assert.equal(visibleOnionKeyframes(times, 1.5, false), times);
  const snapped = [{ time: 0, q: [1] }, { time: 1, q: [2] }, { time: 2, q: [3] }];
  assert.deepEqual(visibleOnionKeyframes(snapped, 1.5, true), snapped.slice(0, 2));
  assert.deepEqual(visibleOnionKeyframes([], 0, true), []);
});
