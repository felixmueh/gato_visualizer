import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveHistory } from './live-history.js';

const plan = (time, version = 1, seq = 1) => ({ sim_time_s: time, settings_version: version, seq, ee_xyz: [[time, 1, 0]] });
const state = (time) => ({ sim_time_s: time, q: [time], ee_xyz: [time, 0, 0] });

test('history scrubs saved native states and matching plans without changing the newest state', () => {
  const history = createLiveHistory();
  const first = plan(0), second = plan(.05, 1, 2);
  history.addPlan(first);history.addState(state(0));history.addState(state(.02));
  history.addPlan(second);history.addState(state(.05));history.addState(state(.09));
  assert.equal(history.at(.03).state.sim_time_s, .02);
  assert.equal(history.at(.03).plan, first);
  assert.deepEqual(history.at(.03).tracePoints, [[0, 0, 0], [.02, 0, 0]]);
  assert.equal(history.at(.06).plan, second);
  assert.equal(history.at().state.sim_time_s, .09);
  assert.equal(history.at(-4).state.sim_time_s, 0);
});

test('same-time settings previews replace the current plan while older history retains its configuration', () => {
  const history = createLiveHistory();
  const old = plan(0), updated = plan(.1, 2);
  history.addPlan(old);history.addState(state(0));history.addState(state(.1));
  history.addPlan(updated);history.addState(state(.1));
  assert.equal(history.length, 2);
  assert.equal(history.at(0).plan, old);
  assert.equal(history.at().plan, updated);
  // Sequence numbers may restart during reset/rebuild and are never dedup keys.
  const replacement = { ...plan(.1, 2, 1), stats: { solve_time_ms: 4 } };history.addPlan(replacement);
  assert.equal(history.at().plan, replacement);
});

test('reset and server time rollback discard incompatible history, and snapshot repeats do not append', () => {
  const history = createLiveHistory();
  history.addPlan(plan(0));history.addState(state(0));history.addState(state(.4));
  history.addState(state(.4));assert.equal(history.length, 2);
  const reset = plan(0);history.addPlan(reset);history.addState(state(0));
  assert.equal(history.length, 1);assert.deepEqual(history.at().plan, reset);
  history.addState(state(.3));history.addState(state(0));
  assert.equal(history.length, 1);assert.equal(history.at().plan, null);
  history.clear();assert.equal(history.at(), null);
});

test('a reconnect snapshot may contain a plan older than the newest plant state', () => {
  const history = createLiveHistory({ maxPlans: 2 });
  history.addPlan(plan(0));history.addState(state(0));
  history.addPlan(plan(.1));history.addState(state(.1));history.addState(state(.2));
  const snapshotPlan = plan(.1);
  history.addPlan(snapshotPlan);history.addState(state(.2));
  assert.equal(history.length, 3);
  assert.deepEqual(history.bounds, [0, .2]);
  assert.deepEqual(history.at().plan, snapshotPlan);
  assert.equal(history.at(0).plan.sim_time_s, 0);
});

test('retention caps time, state count, and distinct prediction count with an accurate remaining path', () => {
  for (const options of [{ maxSamples: 3 }, { maxSeconds: 2 }, { maxPlans: 3 }]) {
    const history = createLiveHistory(options);
    for (let t = 0; t < 10; t++) { history.addPlan(plan(t));history.addState(state(t)); }
    assert.equal(history.length, 3);
    assert.deepEqual(history.bounds, [7, 9]);
    assert.deepEqual(history.at().tracePoints, [[7, 0, 0], [8, 0, 0], [9, 0, 0]]);
  }
});

test('breach records are kept in order and found where playback crosses them', () => {
  const history = createLiveHistory();
  history.addState({ sim_time_s: 0, q: [], ee_xyz: [0, 0, 0] });
  for (const time of [.03, .2]) history.addRecord({ type: 'breach', sim_time_s: time, message: `at ${time}` });
  assert.equal(history.breaches.length, 2);
  assert.equal(history.breachCrossed(0, .02), null);
  assert.equal(history.breachCrossed(0, .03).message, 'at 0.03');
  assert.equal(history.breachCrossed(.03, .25).message, 'at 0.2'); // Play from a breach continues past it.
  history.clear(); assert.equal(history.breaches.length, 0);
});

test('requested plans remain inspectable while command and state sequence own activation', () => {
  const history = createLiveHistory({ maxPlans: Infinity });
  const first = { ...plan(0, 1, 1), available_time_s: .0055 };
  const second = { ...plan(.01, 1, 2), available_time_s: .0155 };
  history.addState({ ...state(0), control_updates: 0 }); history.addPlan(first);
  history.addState({ ...state(.004), control_updates: 0 });
  assert.equal(history.at().plan, null);
  history.addState({ ...state(.006), control_updates: 0 });
  history.addRecord({ type: 'control', sim_time_s: .006, plan_seq: 1 });
  history.addState({ ...state(.01), control_updates: 2, plan_seq: 1 }); history.addPlan(second);
  history.addState({ ...state(.014), control_updates: 4, plan_seq: 1 });
  assert.equal(history.at(.014).plan, first);
  history.addState({ ...state(.016), control_updates: 5, plan_seq: 1 });
  history.addRecord({ type: 'control', sim_time_s: .016, plan_seq: 2 });
  assert.equal(history.at(.016).plan, second);
  assert.deepEqual(history.metricSnapshot.plans, [first, second]);
  // A canceled pending request cannot acquire a new session's uncommanded state.
  history.addState({ ...state(.02), control_updates: 0 });
  assert.equal(history.at().plan, null);
});

test('finite retention keeps a just-activated plan when the next request precedes its control record', () => {
  const history = createLiveHistory({ maxPlans: 1 });
  const p0 = { ...plan(0, 1, 1), available_time_s: .006 };
  const p1 = { ...plan(.006, 1, 2), available_time_s: .012 };
  history.addState({ ...state(0), control_updates: 0 }); history.addPlan(p0);
  history.addState({ ...state(.006), control_updates: 0 });
  history.addPlan(p1);
  history.addRecord({ type: 'control', sim_time_s: .006, plan_seq: 1 });
  assert.equal(history.at(.006).plan, p0);
  history.addState({ ...state(.008), control_updates: 1, plan_seq: 1 });
  assert.equal(history.at(.008).plan, p0);
});
