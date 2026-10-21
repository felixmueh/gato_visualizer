import test from 'node:test';
import assert from 'node:assert/strict';
import { initialLiveSettings, cloneSettings, readPath, writePath, parseParameter, maxViolation, validPoints } from './live.js';

test('settings edits preserve the complete configuration and native typed choices', () => {
  const defaults = { config: { N: 32, solver_params: { linsys: null, q_cost: 4 }, controller: { limits_kw: { rho: .01 } } }, task: { kind: 'reach', target_offset_m: [0, 0, 0] } };
  const settings = cloneSettings(defaults);
  writePath(settings.config, 'controller.limits_kw.rho', .02);
  assert.equal(readPath(settings.config, 'controller.limits_kw.rho'), .02);
  assert.equal(defaults.config.controller.limits_kw.rho, .01);
  assert.equal(settings.config.solver_params.q_cost, 4);
  assert.equal(parseParameter({kind: 'choice', choices: [null, 'pcg']}, {value: '0'}), null);
  assert.equal(parseParameter({kind: 'choice', choices: [16, 32]}, {value: '1'}), 32);
  assert.equal(parseParameter({kind: 'choice', choices: [{value: false, label: 'Off'}]}, {value: '0'}), false);
});

test('numeric settings reject empty, nonfinite, fractional integer and out-of-bounds values', () => {
  const parameter = {kind: 'int', label: 'SQP', min: 1, max: 50};
  assert.equal(parseParameter(parameter, {value: '5'}), 5);
  for (const value of ['', 'Infinity', 'abc', '2.5', '0', '51']) assert.throws(() => parseParameter(parameter, {value}));
  assert.equal(parseParameter({kind: 'bool'}, {checked: true}), true);
});

test('diagnostic row violations and world points handle missing and invalid values', () => {
  assert.equal(maxViolation([[-.1, .02], [.01]]), .02);
  assert.equal(maxViolation([]), null);
  assert.equal(maxViolation([-.1, -.2]), 0);
  assert.equal(validPoints([[1, 2, 3], [3, 4, 5]]), true);
  assert.equal(validPoints([[1, NaN, 3]]), false);
  assert.equal(validPoints([[1, 2]]), false);
});


test('live setup requires available horizons and selects an available default explicitly', () => {
  const defaults = {config: {N: 32, solver_params: {q_cost: 4}}, task: {kind: 'reach', target_offset_m: [0, 0, 0]}};
  assert.throws(() => initialLiveSettings({defaults, available_N: []}), /No knot counts are ready/);
  assert.throws(() => initialLiveSettings({defaults}), /No knot counts are ready/);
  assert.equal(initialLiveSettings({defaults, available_N: [16, 64]}).config.N, 16);
  assert.equal(initialLiveSettings({defaults, available_N: [16, 32]}).config.N, 32);
  assert.equal(initialLiveSettings({defaults: {...defaults, config: {solver_params: {q_cost: 4}}}, available_N: [64]}).config.N, 64);
  assert.equal(defaults.config.N, 32);
});

test('empty and unavailable choices cannot turn required config values into undefined', () => {
  for (const value of ['', '-1', '2', '0.5', 'NaN']) {
    assert.throws(() => parseParameter({kind: 'choice', label: 'Knot points', choices: [16, 32]}, {value}), /available choice/);
  }
  assert.throws(() => parseParameter({kind: 'choice', label: 'Knot points', choices: []}, {value: ''}), /available choice/);
  assert.throws(() => parseParameter({kind: 'choice', label: 'Knot points', choices: []}, {value: '0'}), /available choice/);
});
