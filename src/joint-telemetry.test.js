import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleTelemetry, limitStatus, magnitudeStatus} from './joint-telemetry.js';

test('missing telemetry stays unknown; recorded velocities interpolate and controls hold', () => {
  assert.deepEqual(sampleTelemetry({time_s: [0, 1]}, .5), {qd: null, torque: null});
  const record = {time_s: [0, .1, .4], qd_rad_s: [[0], [2], [8]], torque_nm: [[4], [-3]], torque_time_s: [0, .1]};
  assert.deepEqual(sampleTelemetry(record, .05), {qd: [1], torque: [4]});
  assert.ok(Math.abs(sampleTelemetry(record, .25).qd[0] - 5) < 1e-12);
  assert.deepEqual(sampleTelemetry(record, .25).torque, [-3]);
  assert.deepEqual(sampleTelemetry(record, .4), {qd: [8], torque: [-3]});
  assert.equal(sampleTelemetry({...record, torque_kind: 'predicted', torque_end_time_s: .4}, .4).torque, null);
  assert.equal(sampleTelemetry({...record, torque_time_s: [.05, .1]}, 0).torque, null);
});

test('positions warn in outer tenth of range; symmetric velocity and torque warn at90 percent', () => {
  assert.equal(limitStatus(0, -2, 1), '');
  assert.equal(limitStatus(-1.8, -2, 1), 'near-limit');
  assert.equal(limitStatus(.8, -2, 1), 'near-limit');
  assert.equal(limitStatus(1, -2, 1), 'at-limit');
  assert.equal(limitStatus(-3, -2, 1), 'at-limit');
  assert.equal(magnitudeStatus(-9, 10), 'near-limit');
  assert.equal(magnitudeStatus(10, 10), 'at-limit');
  assert.equal(magnitudeStatus(-11, 10), 'at-limit');
  assert.equal(magnitudeStatus(null, 10), '');
  assert.equal(limitStatus(0, undefined, 1), '');
});
