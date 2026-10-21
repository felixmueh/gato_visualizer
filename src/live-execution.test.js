import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExecution, intervalSeverity, intervalDescription, createHistoryClock } from './live-execution.js';
import { createLiveHistory } from './live-history.js';

test('execution rates are independent of knot spacing and ordered physics ≥ control ≥ TO', () => {
  assert.deepEqual(validateExecution({ simulation_hz: 1000, control_hz: 200, to_hz: 33.5 }).to_hz, 33.5);
  for (const value of [{ simulation_hz: 10, control_hz: 20 }, { control_hz: 20, to_hz: 30 }, { duration_s: 0 }, { to_hz: NaN }, { calculation: 'other' }]) assert.throws(() => validateExecution(value));
});

test('MPC overrun is red even when simulation is slower, combined-only overrun is yellow', () => {
  assert.equal(intervalSeverity({ mpc_overrun: true, physics_overrun: true, physics_wall_s: 1 }), 'red');
  assert.equal(intervalSeverity({ severity: 'red', total_ratio: 4 }), 'red');
  assert.equal(intervalSeverity({ severity: 'yellow', physics_ratio: .4, total_ratio: 1.1 }), 'yellow');
  assert.equal(intervalSeverity({ severity: 'none' }), 'normal');
  assert.match(intervalDescription({ severity: 'red', solve_wall_s: .03, physics_wall_s: .08, to_budget_s: .02 }), /MPC exceeded budget.*30.00 ms.*80.00 ms.*20.00 ms/);
});

test('history clock plays saved simulated time at1x regardless compute speed, holds tail and never jumps ahead', () => {
  const clock = createHistoryClock(); clock.seek(.5); clock.play(100);
  assert.equal(clock.tick(200, [0, 1]).time, .6);
  assert.equal(clock.tick(1200, [0, 1]).time, 1);
  assert.equal(clock.tick(1500, [0, 1]).time, 1);
  assert.equal(clock.tick(1600, [0, 10]).time, 1.1); // new10-second backlog never jumps
  clock.pause(); assert.equal(clock.tick(2000, [0, 10]).time, 1.1);
  clock.seek(.1); clock.play(3000); assert.equal(clock.tick(3100, [0, 10]).time, .2);
});

test('authoritative chunks interpolate native motion at recorded timestamps and hold applied torque', () => {
  const history = createLiveHistory({ maxSamples: Infinity, maxSeconds: Infinity, maxPlans: Infinity });
  history.addRecord({ type: 'plan', sim_time_s: 2, settings_version: 3, seq: 1 });
  history.addRecord({ type: 'state', sim_time_s: 2, settings_version: 3, q: [1], qd: [2], ee_xyz: [0, 0, 1], torque_nm: [3] });
  history.addRecord({ type: 'state', sim_time_s: 2.2, settings_version: 3, q: [3], qd: [4], ee_xyz: [2, 0, 1], torque_nm: [8] });
  history.addRecord({ type: 'interval', severity: 'red', start_time_s: 2, end_time_s: 2.2 });
  const selected = history.interpolateAt(2.1);
  assert(Math.abs(selected.state.q[0] - 2) < 1e-9);
  assert.deepEqual(selected.state.torque_nm, [3]);
  assert.equal(selected.plan.seq, 1); assert.equal(history.intervals.length, 1);
  assert.deepEqual(history.pathPoints, [[0, 0, 1], [2, 0, 1]]);
});
