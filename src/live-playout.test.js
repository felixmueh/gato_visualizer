import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivePlayout } from './live-playout.js';

const sample = (time, value, extra = {}) => ({ sim_time_s: time, q: [value], qd: [value * 2], ee_xyz: [value, 0, 1], torque_nm: [value * 10], arrived: value > 1, rtf: .4, ...extra });

test('nonuniform arrival cadence interpolates only received brackets and preserves slow simulated progress', () => {
  const buffer = createLivePlayout({ delayMs: 50 });
  const first = sample(0, 0), second = sample(.04, 1), third = sample(.1, 2);
  buffer.add(first, 100);buffer.add(second, 200);buffer.add(third, 350);
  assert.equal(buffer.at(120), first);
  const between = buffer.at(325); // arrival clock275, halfway200..350
  assert.equal(between.q[0], 1.5);
  assert.equal(between.sim_time_s, .07); // .15wall seconds represent .06sim seconds
  assert.equal(between.rtf, .4);
  assert.deepEqual(between.torque_nm, second.torque_nm);
  assert.equal(between.arrived, false);
  assert.equal(buffer.at(5000), third); // no extrapolation during stalls
  assert.equal(third.render_interpolated, undefined);
});

test('reset, settings versions and changed effective limits prevent cross-boundary interpolation', () => {
  const buffer = createLivePlayout();
  buffer.add(sample(.2, 1), 100, 1);buffer.add(sample(.3, 2), 200, 1);
  const changed = sample(.3, 3);buffer.add(changed, 250, 2);
  assert.equal(buffer.length, 1);assert.equal(buffer.at(300), changed);
  const reset = sample(0, 0);buffer.add(reset, 350, 2);
  assert.equal(buffer.length, 1);assert.equal(buffer.at(400), reset);
  const bounded = sample(.1, 1, { joint_limits: { effort_nm: [2] } });buffer.add(bounded, 450, 2);
  assert.equal(buffer.length, 1);assert.equal(buffer.at(500), bounded);
  buffer.clear();assert.equal(buffer.at(1000), null);
});

test('latest saved state remains exact and available for immediate pause, and buffering is bounded', () => {
  const buffer = createLivePlayout({ maxSamples: 3 });
  let newest;
  for (let i = 0; i < 10; i++) { newest = sample(i * .01, i);buffer.add(newest, i * 30); }
  assert.equal(buffer.length, 3);
  assert.equal(buffer.at(1000), newest);
  buffer.clear();buffer.add(newest, 1000);
  assert.equal(buffer.at(1000), newest); // pause/reconnect seeds exactly one state
});
