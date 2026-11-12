import test from 'node:test';
import assert from 'node:assert/strict';
import { differenceTree, mergeTaskSettings, selectionState, settingsGroups, taskSession, transferDifferences, treeLeaves } from './task-settings.js';

const baseline = kind => ({ config: { N: 32, cost: { type: 'CostMenu', frame_pos: { weight: [4, 8] } }, cost_weights: { position: 4, terminal_position: 8 }, plant: { start_pose_rad: [1, 2] } },
  task: { kind, target_offset_m: [0, 0, 0] }, execution: { to_hz: 100, control_hz: 500 }, source_settings: { predictor: { enabled: true }, simulation: {} } });

test('task snapshots resolve independent four-group overrides without mutating defaults or metadata', () => {
  const catalog = { defaults: { reach: baseline('reach'), tracking: baseline('tracking') },
    overrides: { reach: { config: { N: 64 }, execution: { to_hz: 20 }, source_settings: { predictor: { enabled: false } } } } };
  const before = structuredClone(catalog), resolved = taskSession(catalog, 'reach');
  assert.equal(resolved.config.N, 64); assert.equal(resolved.execution.to_hz, 20); assert.equal(resolved.source_settings.predictor.enabled, false);
  assert.equal(taskSession(catalog, 'tracking').execution.to_hz, 100); assert.equal(taskSession(catalog, 'missing'), null);
  assert.deepEqual(catalog, before);
  assert.deepEqual(settingsGroups({ ...resolved, task_settings: catalog, settings_version: 7 }), resolved);
  assert.deepEqual(mergeTaskSettings({ a: [1, 2], b: { x: 3 } }, { a: null, b: { x: 4 } }), { a: null, b: { x: 4 } });
});

test('copy preview mirrors shared compatible leaves and excludes native derived cost and metadata', () => {
  const source = baseline('figure8'), current = baseline('reach');
  Object.assign(source.config, { type: 'OtherTag', N: 64, source_only: 1 });
  source.config.cost.frame_pos.weight = [500, 1000]; source.config.cost_weights.position = 500;
  source.config.plant.start_pose_rad = [3, 4]; source.task.width_m = .5; source.execution.to_hz = 500;
  const differences = transferDifferences(source, current);
  assert.deepEqual(differences.map(item => item.path), ['config.N', 'config.cost_weights.position', 'config.plant.start_pose_rad', 'execution.to_hz']);
  assert.deepEqual(differences[2].source, [3, 4]); assert.deepEqual(differences[2].current, [1, 2]);
  differences[2].source[0] = 9; assert.equal(source.config.plant.start_pose_rad[0], 3);
});

test('custom menus remain atomic', () => {
  const source = baseline('figure8'), current = baseline('reach');
  delete source.config.cost_weights;
  source.config.cost.frame_pos.weight = [500, 1000];
  assert.deepEqual(transferDifferences(source, current).map(item => item.path), ['config.cost']);
});

test('nested branches and Select all derive tristate from their complete leaf selection', () => {
  const tree = differenceTree([{ path: 'config.solver.max_sqp_iters', source: 5, current: 2 }, { path: 'config.solver.rho', source: 1, current: 2 }]);
  const paths = treeLeaves(tree[0]).map(leaf => leaf.path), selected = new Set([paths[0]]);
  assert.deepEqual(selectionState(paths, selected), { checked: false, indeterminate: true });
  selected.add(paths[1]); assert.deepEqual(selectionState(paths, selected), { checked: true, indeterminate: false });
});


test('atomic objects compare structurally regardless of key order while arrays keep their order', () => {
  const left = { config: { cost: { type: 'CostMenu', input: { weight: 1, target: [1, 2] } } } };
  const right = { config: { cost: { input: { target: [1, 2], weight: 1 }, type: 'CostMenu' } } };
  assert.deepEqual(transferDifferences(left, right), []);
  right.config.cost.input.target.reverse();
  assert.deepEqual(transferDifferences(left, right).map(item => item.path), ['config.cost']);
});

test('resolved server sessions own custom menu semantics and local merges replace atomic objects whole', () => {
  const base = baseline('reach');
  const patch = { config: { cost: { type: 'CostMenu', input: { weight: 7 } } } };
  const merged = mergeTaskSettings(base, patch);
  assert.deepEqual(merged.config.cost, patch.config.cost);
  const custom = structuredClone(merged); delete custom.config.cost_weights;
  const catalog = { defaults: { reach: base }, overrides: { reach: patch }, sessions: { reach: custom } };
  assert.deepEqual(taskSession(catalog, 'reach'), custom);
});
