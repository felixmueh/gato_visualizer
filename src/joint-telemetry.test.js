import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleTelemetry, createJointTable, updateJointTable} from './joint-telemetry.js';

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

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.title = ''; this.textContent = ''; this.hidden = false; this.className = ''; this.ownerDocument = doc; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this.attributes[name] = value; }
}
const doc = { createElement: tag => new Node(tag) };

test('gauges show URDF limit states, MPC bounds and exact values in tooltips, and dashes for missing data', () => {
  const container = new Node('div');
  const rows = createJointTable(container, ['arm_right_1_joint', 'arm_right_2_joint']);
  const limits = {lower_position_rad: [-1, -2], upper_position_rad: [1, 2], velocity_rad_s: [2, 2], effort_nm: [40, 40]};
  const mpcBounds = {lower_position_rad: [-.9, -1.9], upper_position_rad: [.9, 1.9], velocity_rad_s: [1.6, 1.6]};
  updateJointTable(rows, {q: [.95, 0], qd: [2.5, null], torque: null, limits, mpcBounds});
  const [position, velocity, torque] = rows[0];
  assert.equal(position.gauge.dataset.state, 'near');
  assert.equal(velocity.gauge.dataset.state, 'beyond');
  assert.ok(parseFloat(velocity.over.style.width) > 0);
  assert.equal(torque.gauge.dataset.state, 'missing'); assert.equal(torque.text.textContent, '—'); assert.equal(torque.track.hidden, true);
  assert.equal(rows[1][1].text.textContent, '—');
  assert.match(position.gauge.title, /Native joint position \+0\.950 rad/);
  assert.match(position.gauge.title, /URDF −1\.000 … \+1\.000 rad/);
  assert.match(position.gauge.title, /near · 0\.050 rad from upper bound/);
  assert.match(position.gauge.title, /MPC bound −0\.900 … \+0\.900 rad/);
  assert.match(velocity.gauge.title, /125 % · beyond · 0\.500 rad\/s beyond \+limit/);
  // Without limits a value is still shown as text, never a guessed gauge.
  updateJointTable(rows, {q: [.5, 0], qd: null, torque: null, limits: null});
  assert.equal(rows[0][0].gauge.dataset.state, 'unbounded'); assert.equal(rows[0][0].text.textContent, '+0.500');
});
