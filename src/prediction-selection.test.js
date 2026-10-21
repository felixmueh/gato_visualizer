import test from 'node:test';
import assert from 'node:assert/strict';
import { livePredictionForView } from './prediction-selection.js';
import { createLiveHistory } from './live-history.js';
import { createHistoryClock } from './live-execution.js';

const plan = (time, seq) => ({ sim_time_s: time, settings_version: 1, seq, ee_xyz: [[time, 0, 0], [time + 1, 0, 0]] });

test('recorded playback changes predictions at the solve timestamp even with stale Solve pane metadata', () => {
  const history = createLiveHistory();
  const first = plan(0, 1), second = plan(.1, 2);
  for (const prediction of [first, second]) {
    history.addPlan(prediction);
    history.addState({ sim_time_s: prediction.sim_time_s, settings_version: 1, q: [prediction.sim_time_s], ee_xyz: prediction.ee_xyz[0] });
  }
  history.addState({ sim_time_s: .2, settings_version: 1, q: [.2], ee_xyz: [.2, 0, 0] });
  // Python's inspector still describes solve1 while local playback crosses .1s.
  for (const active of [false, true]) {
    const inspection = { active, pinned: false, iteration: null, prediction: structuredClone(first) };
    const clock = createHistoryClock(); clock.seek(0); clock.play(0);
    clock.tick(99, history.bounds);
    assert.equal(livePredictionForView(history.interpolateAt(clock.time).plan, inspection), first);
    clock.tick(100, history.bounds);
    assert.equal(livePredictionForView(history.interpolateAt(clock.time).plan, inspection), second);
    assert.equal(inspection.prediction.seq, 1); // No asynchronous refresh required.
    clock.seek(.05);
    assert.equal(livePredictionForView(history.interpolateAt(clock.time).plan, { ...inspection, prediction: second }), first);
  }
});

test('explicit pinned solve, fresh result, and recorded SQP selection retain prediction ownership', () => {
  const episodePlan = plan(1, 10), captured = plan(0, 1);
  assert.equal(livePredictionForView(episodePlan, { active: true, pinned: true, iteration: null, prediction: captured }), captured);
  assert.equal(livePredictionForView(null, { active: true, pinned: true, iteration: null, prediction: captured }), captured);
  for (const iteration of [0, 1, 3]) {
    assert.equal(livePredictionForView(episodePlan, { active: true, pinned: false, iteration, prediction: captured }), captured);
    assert.equal(livePredictionForView(episodePlan, { active: true, pinned: false, iteration, prediction: null }), null);
  }
  assert.equal(livePredictionForView(episodePlan, { active: false, pinned: false, iteration: 1, prediction: captured }), episodePlan);
  assert.equal(livePredictionForView(null, { active: true, pinned: false, iteration: null, prediction: captured }), null);
  assert.equal(livePredictionForView(episodePlan, null), episodePlan);
});
