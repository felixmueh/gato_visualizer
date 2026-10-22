import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlotState, timelineEligible, awaitPlotJob, displayLimits } from './plot-state.js';

test('independent duplicate configs, reorder, shared placements and persistence', () => {
  let stored; const state = createPlotState({}, value => { stored = structuredClone(value); });
  const definition = { id: 'episode.joint', inputs: { joint: { default: 'J1' }, quantity: { default: 'q' } } };
  const first = state.add(definition, 'episode'), second = state.duplicate(first.id);
  state.configure(second.id, { joint: 'J2', quantity: 'qd' });
  assert.equal(first.parameters.joint, 'J1'); assert.equal(second.parameters.joint, 'J2');
  state.place(first.id, true); state.configure(first.id, { joint: 'J3' });
  assert.equal(first.timeline, true); assert.equal(first.parameters.joint, 'J3');
  state.place(first.id, false); assert.equal(state.instances.length, 2);
  state.reorder(second.id, first.id); assert.equal(state.instances[0].id, second.id);
  state.place(second.id, true, false); assert.equal(second.timeline, false);
  const restored = createPlotState(stored); assert.deepEqual(restored.instances, state.instances);
  state.remove(first.id); assert.equal(state.instances.length, 1);
});

test('episode range changes only with selected scope; pin fixes solve and actual iteration independently of robot cursor', () => {
  const state = createPlotState(); state.setSource('live');
  const a = { id: 'a', iterations: [{ index: 0 }, { index: 3 }] }, b = { id: 'b', iterations: [] };
  state.follow(a); assert.equal(state.iteration, null); state.selectIteration(2); assert.equal(state.iteration, null);
  state.selectIteration(3); state.pin(); state.follow(b); assert.equal(state.selected.id, 'a'); assert.equal(state.iteration, 3);
  let view = { cursor: 5, window: [2, 8] };
  assert.deepEqual(state.range(view), { mode: 'entire', cursor_s: 5 });
  view.window = [4, 6]; assert.deepEqual(state.range(view), { mode: 'entire', cursor_s: 5 });
  state.rangeMode = 'visible'; assert.deepEqual(state.range(view), { mode: 'visible', cursor_s: 5, start_s: 4, end_s: 6 });
  state.pin(false); state.follow(b); assert.equal(state.selected.id, 'b'); assert.equal(state.iteration, null);
  state.setSource('replay:recording'); assert.equal(state.selected, null);
});

test('only episode-clock curves or measured spans can share timeline', () => {
  for (const kind of ['lines', 'bars', 'spans']) assert.equal(timelineEligible({ scope: 'episode' }, { kind, x: { identity: 'episode_time' } }), true);
  for (const identity of ['sqp_iteration', 'wall_time', 'prediction_time']) assert.equal(timelineEligible({ scope: 'episode' }, { kind: 'lines', x: { identity } }), false);
  assert.equal(timelineEligible({ scope: 'episode' }, { kind: 'table' }), false);
});

test('pinned snapshot hydration requires the exact Solve and request source, preserving its selected iteration', () => {
  const state = createPlotState(), solve = { id: 'same-id', iterations: [{ index: 0 }, { index: 2 }] };
  state.setSource('live:4'); state.follow(solve); state.pin(true); state.selectIteration(2);
  state.follow({ ...solve, selected_iteration: 2, selected_prediction: { ee_xyz: [[2, 0, 0]] } }, 'live:5'); assert.equal(state.selected.selected_prediction, undefined);
  state.follow({ ...solve, id: 'different', selected_prediction: {} }, 'live:4'); assert.equal(state.selected.id, 'same-id');
  const update = { ...solve, selected_iteration: 2, selected_prediction: { ee_xyz: [[2, 0, 0]] } };
  state.follow(update, 'live:4'); assert.deepEqual(state.selected.selected_prediction, update.selected_prediction); assert.equal(state.iteration, 2); assert.equal(state.pinned, true);
});

test('async jobs poll job_id, reject local errors and discard stale completions', async () => {
  const calls = []; const request = async (path, body) => { calls.push([path, body]); return calls.length === 1 ? { job_id: 'abc', state: 'running' } : { state: 'complete', catalog: [], results: [] }; };
  const result = await awaitPlotJob(request, '/api/plots/evaluate', { plots: [] }, { wait: async () => {} });
  assert.deepEqual(result.results, []); assert.equal(calls[1][0], '/api/plots/jobs/abc');
  await assert.rejects(awaitPlotJob(async () => ({ state: 'failed', error: 'Bad plugin' }), '/api/plots/evaluate', {}), /Bad plugin/);
  assert.equal(await awaitPlotJob(request, '/api/plots/evaluate', {}, { alive: () => false }), null);
});

test('display limits and placement heights persist per instance and survive duplication', () => {
  let stored; const state = createPlotState({}, value => { stored = structuredClone(value); });
  const item = state.add({ id: 'episode.timing', inputs: {} }, 'episode');
  state.configure(item.id, {}, { min: '', max: '50', clipOutliers: true });
  assert.deepEqual(item.display, { min: null, max: 50, clipOutliers: true });
  state.resize(item.id, 'timeline', 140); state.resize(item.id, 'sidebar', 10);
  assert.equal(state.height(item.id, 'timeline'), 140); assert.equal(state.height(item.id, 'sidebar'), 40);
  state.timelineHeight = 400;
  const copy = state.duplicate(item.id); assert.deepEqual(copy.display, item.display); assert.equal(state.height(copy.id, 'timeline'), 140);
  state.resize(item.id, 'timeline', 90, false); assert.equal(stored.instances[0].sizes.timeline, 140, 'drag moves do not persist each step');
  const restored = createPlotState(stored); assert.equal(restored.timelineHeight, 400); assert.equal(restored.height(item.id, 'timeline'), 140);
  // An inverted pair keeps the bottom and returns the top to automatic.
  assert.deepEqual(displayLimits({ min: 3, max: 1 }), { min: 3, max: null, clipOutliers: false });
});
