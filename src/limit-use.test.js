import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMIT_USE, atTolerance, describeLimitUse, jointLimitUse, limitDistance, limitUtilisation, pickLimitUse, quantityLimitUse, validateLimitUse } from './limit-use.js';

const limits = { lower_position_rad: [-1, -2], upper_position_rad: [1, 0], velocity_rad_s: [2, 2], effort_nm: [40, 26] };
const state = (quantity, value, index = 0, settings = DEFAULT_LIMIT_USE) => quantityLimitUse(quantity, value, limits, index, settings).state;

test('utilisation and signed distance are measured against the URDF limits', () => {
  assert.equal(limitUtilisation('position', .5, limits, 1), 1.5);
  assert.ok(Math.abs(limitDistance('position', -1.9, limits, 1) - .1) < 1e-12);
  assert.ok(Math.abs(limitDistance('position', .2, limits, 1) + .2) < 1e-12);
  assert.ok(Math.abs(limitUtilisation('velocity', -1.8, limits, 0) - .9) < 1e-12);
  assert.equal(limitDistance('torque', -26.5, limits, 1), -.5);
  assert.equal(limitUtilisation('velocity', null, limits, 0), null);
  assert.equal(quantityLimitUse('torque', 1, null, 0), null);
});

test('near, at on either side within the tolerance, and beyond', () => {
  assert.equal(state('position', .5), 'inside');
  assert.equal(state('position', .9), 'near');
  assert.equal(state('position', .9975), 'at');
  assert.equal(state('position', 1.0025), 'at');
  assert.equal(state('position', 1.0031), 'beyond');
  assert.equal(state('velocity', 1.991), 'at');
  assert.equal(state('velocity', -2.02), 'beyond');
  assert.ok(Math.abs(atTolerance('torque', limits, 1) - .052) < 1e-12);
  assert.equal(state('torque', 26.05, 1), 'at');
  assert.equal(state('torque', 26.06, 1), 'beyond');
  assert.equal(state('position', .8, 0, { ...DEFAULT_LIMIT_USE, limit_near_percent: 80 }), 'near');
});

test('joint use reports each available quantity and the worst state', () => {
  const use = jointLimitUse({ q: [.95], qd: [2.001], torque: null, limits }, 0);
  assert.equal(use.torque, null);
  assert.equal(use.position.state, 'near');
  assert.equal(use.worst.quantity, 'velocity');
  assert.equal(describeLimitUse('arm_right_1', use.worst), 'arm_right_1 velocity · at · 0.001 rad/s beyond +limit');
  assert.equal(describeLimitUse('arm_right_4', quantityLimitUse('position', -.998, limits, 0)), 'arm_right_4 position · at · 0.002 rad from lower bound');
  assert.equal(jointLimitUse({ q: [0], limits: null }, 0).worst, null);
});

test('settings validate and pick only limit-use fields', () => {
  assert.deepEqual(validateLimitUse(), DEFAULT_LIMIT_USE);
  assert.throws(() => validateLimitUse({ limit_near_percent: 0 }));
  assert.deepEqual(pickLimitUse({ report_hz: 3, limit_near_percent: 70 }), { ...DEFAULT_LIMIT_USE, limit_near_percent: 70 });
});

test('shared fixture: the same utilisation, distance and state as the Python plot helper', async () => {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/limit_use_cases.json', import.meta.url)));
  for (const item of fixture.cases) {
    const use = quantityLimitUse(item.quantity, item.value, fixture.limits, item.joint, { ...DEFAULT_LIMIT_USE, ...item.settings });
    assert.deepEqual(use && [use.utilisation, use.distance, use.state], item.state === null ? null : [item.utilisation, item.distance, item.state], JSON.stringify(item));
  }
});
