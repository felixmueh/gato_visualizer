import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveHistory } from './live-history.js';
import { livePredictionWindow, hydrateLiveAnimationHistory } from './live-prediction.js';

function recording(start = 5, count = 501) {
  const history = createLiveHistory({ maxSamples: Infinity, maxSeconds: Infinity, maxPlans: Infinity });
  for (let seq = 0; seq < count; seq++) {
    history.addPlan({ seq, summary: true, sim_time_s: start + seq / 1000, available_time_s: start + seq / 1000 });
    history.addState({ sim_time_s: start + seq / 1000, plan_seq: seq });
  }
  return history;
}

test('playing selects a display-grid solve and prefetches 18 more samples without changing motion', () => {
  const history = recording(), time = 5.0239, selected = history.at(time, { trace: false });
  const window = livePredictionWindow(selected.plan, history, { playing: true, time, effectiveRate: 1 });
  assert.equal(selected.plan.seq, 23); assert.equal(window.plan.seq, 16);
  assert.equal(window.lookahead.length, 19);
  assert.deepEqual(window.lookahead.slice(0, 4).map(plan => plan.seq), [16, 33, 50, 66]);
  assert.equal(history.at(time, { trace: false }).state.sim_time_s, 5.023);
});

test('prediction display grid uses effective playback rate, with no prefetch beyond recorded time', () => {
  const history = recording(), selected = history.at(5.0239, { trace: false });
  const fast = livePredictionWindow(selected.plan, history, { playing: true, time: 5.0239, effectiveRate: 2 });
  assert.equal(fast.plan.seq, 0);
  assert.deepEqual(fast.lookahead.slice(0, 4).map(plan => plan.seq), [0, 33, 66, 100]);
  assert.equal(fast.lookahead.at(-1).seq, 500);
  const tip = livePredictionWindow(history.at(5.49, { trace: false }).plan, history, { playing: true, time: 5.49, effectiveRate: 1 });
  assert.equal(tip.plan.seq, 483);
  assert.deepEqual(tip.lookahead.map(plan => plan.seq), [483, 500]);
});

test('paused scrubs, unset cursors and full preview predictions keep their exact solve', () => {
  const history = recording(), plan = history.at(5.0239, { trace: false }).plan;
  for (const clock of [{ playing: false, time: 5.0239, effectiveRate: 1 }, { playing: true, time: null, effectiveRate: 1 }]) {
    assert.deepEqual(livePredictionWindow(plan, history, clock), { plan, lookahead: [] });
  }
  const preview = { seq: 99, ee_xyz: [[1, 2, 3]] };
  assert.deepEqual(livePredictionWindow(preview, history, { playing: true, time: 5.0239, effectiveRate: 1 }), { plan: preview, lookahead: [] });
  assert.deepEqual(livePredictionWindow(null, history, { playing: true, time: 5, effectiveRate: 1 }), { plan: null, lookahead: [] });
});

test('an earlier display-grid sample can select a full preview with an overlapping play ID', () => {
  const history = createLiveHistory(), preview = { seq: 1, origin: 'preview', sim_time_s: 0, ee_xyz: [[0, 0, 1]] };
  history.addPlan(preview); history.addState({ sim_time_s: 0, plan_seq: 1 });
  history.addPlan({ seq: 1, origin: 'play', summary: true, sim_time_s: .001, available_time_s: .001 });
  history.addState({ sim_time_s: .001, plan_seq: 1 });
  const selected = history.at(.001, { trace: false }).plan;
  const window = livePredictionWindow(selected, history, { playing: true, time: .001, effectiveRate: 1 });
  assert.equal(selected.summary, true);
  assert.equal(window.plan, preview);
});

test('export hydrates exact frozen frame samples and keeps immutable payload references', async () => {
  const history = recording(0, 101), samples = history.animationSnapshot;
  const frames = [-1, .011, .0189, .011, .1, 1], controller = new AbortController();
  let requested;
  const plans = new Map();
  const hydrated = await hydrateLiveAnimationHistory(samples, { frameCount: frames.length, time: i => frames[i] }, async (ids, { signal }) => {
    requested = ids; assert.equal(signal, controller.signal);
    for (const seq of ids) plans.set(seq, { seq, ee_xyz: [[seq, 0, 0]] });
    return [...plans.values()];
  }, { signal: controller.signal });
  assert.deepEqual(requested, [0, 11, 18, 100]);
  for (const index of requested) {
    assert.equal(hydrated[index].state, samples[index].state);
    assert.equal(hydrated[index].plan, plans.get(index));
    assert.equal(Object.isFrozen(hydrated[index]), true);
  }
  assert.equal(Object.isFrozen(hydrated), true);
  assert.equal(hydrated[12].plan, null);
  assert.equal(samples[11].plan.summary, true);
});

test('export needs no HTTP for empty/full histories and propagates failed or cancelled geometry', async () => {
  const full = Object.freeze([{ state: { sim_time_s: 0 }, plan: { seq: 1, ee_xyz: [[1, 0, 0]] } }]);
  const schedule = { frameCount: 1, time: () => 0 };
  const unexpected = () => assert.fail('No geometry request is needed');
  assert.equal(await hydrateLiveAnimationHistory(full, schedule, unexpected), full);
  const empty = Object.freeze([]);
  assert.equal(await hydrateLiveAnimationHistory(empty, schedule, unexpected), empty);
  const samples = recording(0, 2).animationSnapshot;
  for (const error of [new Error('Prediction unavailable'), Object.assign(new Error('Cancelled'), { name: 'AbortError' })]) {
    await assert.rejects(hydrateLiveAnimationHistory(samples, schedule, async () => { throw error; }), value => value === error);
    assert.equal(samples[0].plan.summary, true);
  }
});
