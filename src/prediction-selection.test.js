import test from 'node:test';
import assert from 'node:assert/strict';
import { livePredictionForView, createIterationPathCache, iterationPredictionForView, inspectedPathStyle } from './prediction-selection.js';
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

test('iteration path cache is bounded, solve-scoped and serves chunks and snapshots', () => {
  const cache = createIterationPathCache({ maxChunks: 2, maxSingles: 2 });
  const chunk = (start, count) => ({ start, ee_xyz: Array.from({ length: count }, (_, i) => [[start + i, 0, 0]]) });
  cache.reset('a'); cache.addChunk('a', chunk(0, 4));
  assert.deepEqual(cache.get(3).ee_xyz, [[3, 0, 0]]); assert.equal(cache.get(4), null); assert.equal(cache.get(null), null);
  cache.addChunk('stale', chunk(4, 4)); assert.equal(cache.hasChunk(4), false); // late response for another solve
  cache.addChunk('a', chunk(4, 4)); cache.addChunk('a', chunk(8, 4));
  assert.equal(cache.hasChunk(0), false); assert.equal(cache.hasChunk(9), true); // oldest chunk evicted
  for (const index of [20, 21, 22]) cache.addSnapshot('a', index, { ee_xyz: [[index, 1, 1]] });
  assert.equal(cache.get(20), null); assert.deepEqual(cache.get(22).ee_xyz, [[22, 1, 1]]);
  cache.addSnapshot('a', 23, { ee_xyz: [] }); assert.equal(cache.get(23), null); // a missing trajectory is never cached
  cache.reset('b'); assert.equal(cache.get(9), null); assert.equal(cache.get(22), null);
});

test('SQP cursor holds the shown trajectory while loading and never substitutes final for a recorded iteration', () => {
  const final = { ee_xyz: [[9, 0, 0]] }, held = { ee_xyz: [[1, 0, 0]] }, cached = { ee_xyz: [[2, 0, 0]] };
  const recorded = { index: 2, has_prediction: true }, metricsOnly = { index: 2, has_prediction: false };
  assert.deepEqual(iterationPredictionForView({ iteration: null, finalPrediction: final, held }), { prediction: final, source: 'final', status: 'final' });
  assert.deepEqual(iterationPredictionForView({ iteration: null, held }), { prediction: held, source: 'held', status: 'loading' });
  assert.deepEqual(iterationPredictionForView({ iteration: 2, record: recorded, cached, finalContext: final, held }), { prediction: cached, source: 'iteration', status: 'recorded' });
  assert.deepEqual(iterationPredictionForView({ iteration: 2, record: recorded, finalContext: final, held }), { prediction: held, source: 'held', status: 'loading' });
  assert.deepEqual(iterationPredictionForView({ iteration: 2, record: recorded, finalContext: final }), { prediction: null, source: null, status: 'loading' });
  assert.deepEqual(iterationPredictionForView({ iteration: 2, record: metricsOnly, finalContext: final, held }), { prediction: final, source: 'final-context', status: 'missing' });
  assert.deepEqual(iterationPredictionForView({ iteration: 2, record: metricsOnly, held }), { prediction: null, source: null, status: 'missing' });
});

test('only the pinned Solve\'s own prediction is drawn in the pin colour; final context is faded', () => {
  const captured = plan(0, 1), episodePlan = plan(1, 2);
  const pinned = { active: true, pinned: true, iteration: null, prediction: captured, predictionSource: 'final' };
  assert.deepEqual(inspectedPathStyle(pinned, livePredictionForView(episodePlan, pinned)), { pinned: true, context: false });
  assert.deepEqual(inspectedPathStyle({ ...pinned, pinned: false, iteration: 1 }, captured), { pinned: false, context: false });
  assert.deepEqual(inspectedPathStyle({ ...pinned, predictionSource: 'final-context' }, captured), { pinned: true, context: true });
  assert.deepEqual(inspectedPathStyle(pinned, episodePlan), { pinned: false, context: false });
  assert.deepEqual(inspectedPathStyle({ ...pinned, active: false }, captured), { pinned: false, context: false });
  assert.deepEqual(inspectedPathStyle(null, episodePlan), { pinned: false, context: false });
});
