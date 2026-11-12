import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EXECUTION, validateExecution, parseSolveLatency, intervalSeverity, intervalDescription, createHistoryClock } from './live-execution.js';
import { createLiveHistory } from './live-history.js';

// The schema supplies the native timing fields (tiago_mpc's run_virtual_time defaults).
const EXECUTION = { ...DEFAULT_EXECUTION, control_hz: 500, to_hz: 100, solve_latency_s: .01, latency_compensation: true };
const execution = value => validateExecution({ ...EXECUTION, ...value });

test('execution rates are independent of knot spacing and ordered physics ≥ control ≥ TO', () => {
  assert.deepEqual(execution({ simulation_hz: 1000, control_hz: 200, to_hz: 33.5 }).to_hz, 33.5);
  for (const value of [{ simulation_hz: 10, control_hz: 20 }, { control_hz: 20, to_hz: 30 }, { duration_s: 0 }, { to_hz: NaN }, { calculation: 'other' }]) assert.throws(() => execution(value));
});

test('the visualizer has no default for native timing: every execution field is required', () => {
  for (const key of ['control_hz', 'to_hz', 'solve_latency_s', 'latency_compensation']) {
    assert.equal(key in DEFAULT_EXECUTION, false);
    const { [key]: _, ...missing } = EXECUTION;
    assert.throws(() => validateExecution(missing), /need/);
  }
  assert.throws(() => validateExecution({}), /need/);
  assert.equal('record_every' in DEFAULT_EXECUTION, false);
});

test('solve latency accepts measured, declared seconds and TO zero round-trip', () => {
  assert.equal(execution({ to_hz: 0 }).to_hz, 0);
  assert.equal(execution({ solve_latency_s: 'measured' }).solve_latency_s, 'measured');
  assert.equal(parseSolveLatency(' measured '), 'measured');
  for (const value of ['0', '.0055', '1e-2']) assert.equal(parseSolveLatency(value), Number(value));
  for (const value of ['', '-1', 'NaN', 'ideal']) assert.throws(() => parseSolveLatency(value));
  for (const value of [null, true, '0.01', -1, NaN, Infinity]) assert.throws(() => execution({ solve_latency_s: value }));
});

test('latency compensation is one boolean execution toggle', () => {
  assert.equal(execution({ latency_compensation: false }).latency_compensation, false);
  assert.equal(execution({ latency_compensation: true }).latency_compensation, true);
  for (const value of [0, 1, 'true', null]) assert.throws(() => execution({ latency_compensation: value }));
});

test('plan age expiry is disabled by default and accepts positive finite seconds', () => {
  assert.equal(DEFAULT_EXECUTION.max_plan_age_s, null);
  assert.equal(execution({ max_plan_age_s: .25 }).max_plan_age_s, .25);
  assert.equal(execution({ max_plan_age_s: null }).max_plan_age_s, null);
  for (const value of [0, -1, true, '0.1', NaN, Infinity]) {
    assert.throws(() => execution({ max_plan_age_s: value }), /Maximum plan age/);
  }
});

test('MPC overrun is red even when simulation is slower, combined-only overrun is yellow', () => {
  assert.equal(intervalSeverity({ mpc_overrun: true, physics_overrun: true, physics_wall_s: 1 }), 'red');
  assert.equal(intervalSeverity({ severity: 'red', total_ratio: 4 }), 'red');
  assert.equal(intervalSeverity({ severity: 'yellow', physics_ratio: .4, total_ratio: 1.1 }), 'yellow');
  assert.equal(intervalSeverity({ severity: 'none' }), 'normal');
  assert.match(intervalDescription({ severity: 'red', solve_wall_s: .03, physics_wall_s: .08, to_budget_s: .02 }), /MPC exceeded budget.*30.00 ms.*80.00 ms.*20.00 ms/);
});

test('ASAP never reports a missed TO deadline; throughput overload remains yellow', () => {
  const interval = { to_back_to_back: true, severity: 'red', mpc_overrun: true,
    start_time_s: 0, end_time_s: .004, solve_wall_s: .006, physics_wall_s: .001,
    total_wall_s: .007, to_budget_s: .004, total_ratio: 1.75 };
  assert.equal(intervalSeverity(interval), 'yellow');
  assert.match(intervalDescription(interval), /Combined computation slower than real time[\s\S]*no TO deadline/);
  assert.doesNotMatch(intervalDescription(interval), /MPC exceeded budget|actual TO interval budget/);
  assert.equal(intervalSeverity({ ...interval, severity: 'none', mpc_overrun: false, total_wall_s: .003, total_ratio: .75 }), 'normal');
  assert.equal(intervalSeverity({ ...interval, to_back_to_back: false }), 'red');
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

test('live following pins the presented end without skipping a recorded batch or advancing through a stall', () => {
  const clock = createHistoryClock(); clock.seek(.2); clock.play(0, { follow: true });
  const recorded = [0, .4];
  assert(Math.abs(clock.tick(10, recorded).time - .21) < 1e-12);
  assert.deepEqual(clock.presentationBounds(recorded), [0, clock.time]);
  assert.deepEqual(recorded, [0, .4]); // Full recording is independent of its presented range.
  assert.equal(clock.tick(1000, recorded).time, .4);
  assert.equal(clock.tick(2000, recorded).time, .4); // No extrapolation at a blocked producer.
  assert(Math.abs(clock.tick(2010, [0, .8]).time - .41) < 1e-12);
  clock.pause();
  assert.equal(clock.following, false);
  assert.deepEqual(clock.presentationBounds([0, .8]), [0, .8]);
});

test('historical playback follows only when it reaches the end and continuation is enabled', () => {
  for (const followAtEnd of [false, true]) {
    const clock = createHistoryClock(); clock.seek(.1); clock.play(0);
    clock.tick(100, [0, .4], { followAtEnd });
    assert.equal(clock.following, false);
    assert.deepEqual(clock.presentationBounds([0, .4]), [0, .4]);
    clock.tick(1000, [0, .4], { followAtEnd });
    assert.equal(clock.following, followAtEnd);
    clock.seek(.15);
    assert.equal(clock.following, false);
    assert.deepEqual(clock.presentationBounds([0, .5]), [0, .5]);
  }
});

test('200 ms startup buffer plays 1000 Hz samples delivered in 10 Hz batches at 1×', () => {
  const clock = createHistoryClock({ bufferMs: 200 });
  const history = createLiveHistory({ maxSamples: Infinity, maxSeconds: Infinity });
  let lastSample = -1;
  function batch(endMs) {
    for (let ms = lastSample + 1; ms <= endMs; ms++) history.addRecord({ type: 'state', sim_time_s: ms / 1000, q: [ms], qd: [1], ee_xyz: [ms, 0, 0] });
    lastSample = endMs;
  }
  batch(0); clock.play(0, { growing: true, follow: true });
  batch(100); assert.equal(clock.tick(100, history.bounds, { growing: true }).time, 0);
  assert.equal(clock.buffering, true);
  batch(200); assert.equal(clock.tick(200, history.bounds, { growing: true }).time, 0);
  assert.equal(clock.buffering, false);
  for (let wallMs = 210; wallMs <= 1000; wallMs += 10) {
    if (wallMs % 100 === 0) batch(wallMs);
    clock.tick(wallMs, history.bounds, { growing: true });
    assert(Math.abs(clock.time - (wallMs - 200) / 1000) < 1e-12);
    assert.equal(clock.buffering, false);
    assert.deepEqual(clock.presentationBounds(history.bounds), [0, clock.time]);
    const selected = history.at(clock.time).state;
    assert(selected.sim_time_s <= clock.time);
    assert(clock.time - selected.sim_time_s < .001 + 1e-12);
    assert.equal(selected.q[0], Math.round(selected.sim_time_s * 1000));
  }
});

test('starvation re-buffers without wall-time debt and completed short tails drain', () => {
  const clock = createHistoryClock({ bufferMs: 200 });
  clock.seek(0); clock.play(0, { growing: true });
  clock.tick(1000, [0, .3], { growing: true }); // release, no startup debt
  assert.equal(clock.time, 0);
  clock.tick(1300, [0, .3], { growing: true });
  assert.equal(clock.buffering, true);
  clock.tick(5000, [0, .4], { growing: true });
  assert.equal(clock.time, .3);
  clock.tick(9000, [0, .5], { growing: true });
  assert.equal(clock.time, .3); assert.equal(clock.buffering, false);
  assert(Math.abs(clock.tick(9010, [0, .5], { growing: true }).time - .31) < 1e-12);
  clock.tick(9500, [0, .5], { growing: true });
  assert.equal(clock.buffering, true);
  clock.tick(9600, [0, .55], { growing: false });
  assert.equal(clock.buffering, false); assert.equal(clock.time, .5);
  assert.equal(clock.tick(9700, [0, .55], { growing: false }).time, .55);
});

test('pause and seek cancel buffer waits; finite recordings and zero buffer play immediately', () => {
  const clock = createHistoryClock({ bufferMs: 200 });
  clock.seek(0); clock.play(0, { growing: true }); clock.tick(100, [0, .1], { growing: true });
  clock.pause(); assert.equal(clock.buffering, false);
  clock.tick(10000, [0, 1], { growing: true }); assert.equal(clock.time, 0);
  clock.seek(.8); clock.play(10000, { growing: true });
  clock.tick(10010, [0, .9], { growing: true }); assert.equal(clock.time, .8);
  clock.seek(.2); assert.equal(clock.buffering, false);
  clock.pause(); clock.play(20000); // fully downloaded precomputation
  assert(Math.abs(clock.tick(20010, [0, .9]).time - .21) < 1e-12);
  clock.setBuffer(0); clock.play(30000, { growing: true });
  assert(Math.abs(clock.tick(30010, [0, .9], { growing: true }).time - .22) < 1e-12);
});


test('interval descriptions count the commands clipped to the effort limit', () => {
  assert.match(intervalDescription({ severity: 'none', clipped_commands: 3, start_time_s: 0, end_time_s: .01 }), /^Within budget · 3 commands clipped to the effort limit · MPC/);
  assert.match(intervalDescription({ severity: 'none', clipped_commands: 1 }), /1 command clipped/);
  assert.doesNotMatch(intervalDescription({ severity: 'none', clipped_commands: 0 }), /clipped/);
});

test('session playback rate covers comparison bounds beyond the recorded Live end', () => {
  const clock = createHistoryClock({ rate: 2 }); clock.seek(.5); clock.play(0);
  assert.equal(clock.tick(500, [0, 3], { followBounds: [0, 1], followAtEnd: false }).time, 1.5);
  clock.setRate(.5); assert.equal(clock.tick(1500, [0, 3], { followBounds: [0, 1] }).time, 2);
  assert.equal(clock.tick(5000, [0, 3]).time, 3);
  assert.equal(clock.rate, .5); assert.equal(clock.effectiveRate, .5);
});

test('Continue holds every track at the main tip and forces 1x only while following growing Live', () => {
  const clock = createHistoryClock({ rate: 4 }); clock.seek(0); clock.play(0);
  let tick = clock.tick(500, [0, 10], { followBounds: [0, 1], followAtEnd: true, growing: true });
  assert.equal(tick.time, 1); assert.equal(tick.atEnd, true); assert.equal(tick.atSessionEnd, false);
  assert.equal(clock.following, true); assert.equal(clock.effectiveRate, 1); assert.equal(clock.rateForced, true);
  tick = clock.tick(750, [0, 10], { followBounds: [0, 2], followAtEnd: true, growing: true });
  assert.equal(tick.time, 1.25);
  clock.tick(1000, [0, 10], { followBounds: [0, 2], followAtEnd: true, growing: false });
  assert.equal(clock.rateForced, false); assert.equal(clock.effectiveRate, 4);
  clock.seek(.1); clock.play(1000, { growing: true });
  assert.equal(clock.rateForced, false); // Historical playback may choose a speed.
});
