import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleTelemetry, createJointTable, updateJointTable, setupJointViewToggle, loadJointView, saveJointView, JOINT_VIEW_KEY, createGaugeTooltip} from './joint-telemetry.js';

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
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.title = ''; this.textContent = ''; this.hidden = false; this.className = ''; this.ownerDocument = doc; this.listeners = {}; this.classList = {toggle() {}}; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  dispatch(type, event = {}) { for (const handler of this.listeners[type] || []) handler(event); }
  toggle() {}
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this.attributes[name] = value; }
}
const doc = { createElement: tag => new Node(tag), get body() { return this.bodyNode ||= new Node('body'); } };

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
  assert.equal(position.text.textContent, '+0.950'); assert.equal(velocity.text.textContent, '+2.500');
  assert.equal(rows[1][1].text.textContent, '—');
  assert.match(position.gauge.dataset.tip, /Native joint position \+0\.950 rad/);
  assert.match(position.gauge.dataset.tip, /URDF −1\.000 … \+1\.000 rad/);
  assert.match(position.gauge.dataset.tip, /near · 0\.050 rad from upper bound/);
  assert.match(position.gauge.dataset.tip, /MPC bound −0\.900 … \+0\.900 rad/);
  assert.match(velocity.gauge.dataset.tip, /125 % · beyond · 0\.500 rad\/s beyond \+limit/);
  // Without limits a value is still shown as text, never a guessed gauge.
  updateJointTable(rows, {q: [.5, 0], qd: null, torque: null, limits: null});
  assert.equal(rows[0][0].gauge.dataset.state, 'unbounded'); assert.equal(rows[0][0].text.textContent, '+0.500');
});

const memory = (initial = {}) => { const data = {...initial}; return {data, getItem: k => data[k] ?? null, setItem: (k, v) => { data[k] = v; }}; };

test('the Gauges/Numbers choice defaults to Gauges, is remembered and survives broken storage', () => {
  const make = storage => {
    const container = new Node('div'), buttons = {gauges: new Node('button'), numbers: new Node('button')};
    setupJointViewToggle({container, buttons, storage});
    return {container, buttons};
  };
  const storage = memory();
  const first = make(storage);
  assert.equal(first.container.dataset.view, 'gauges');
  assert.equal(first.buttons.gauges.attributes['aria-pressed'], 'true');
  first.buttons.numbers.dispatch('click');
  assert.equal(first.container.dataset.view, 'numbers');
  assert.equal(first.buttons.numbers.attributes['aria-pressed'], 'true');
  assert.equal(first.buttons.gauges.attributes['aria-pressed'], 'false');
  assert.equal(storage.data[JOINT_VIEW_KEY], 'numbers');
  assert.equal(make(storage).container.dataset.view, 'numbers');
  assert.equal(loadJointView(memory({[JOINT_VIEW_KEY]: 'bogus'})), 'gauges');
  const broken = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }};
  assert.equal(loadJointView(broken), 'gauges');
  assert.doesNotThrow(() => saveJointView(broken, 'numbers'));
  const third = make(broken); third.buttons.numbers.dispatch('click');
  assert.equal(third.container.dataset.view, 'numbers');
});

test('the Numbers cells carry signed values with units in the heading and a dash when missing', () => {
  const container = new Node('div');
  const rows = createJointTable(container, ['a']);
  const limits = {lower_position_rad: [-1], upper_position_rad: [1], velocity_rad_s: [2], effort_nm: [40]};
  updateJointTable(rows, {q: [-.5], qd: [.004], torque: [41.256], limits});
  assert.deepEqual(rows[0].map(p => p.text.textContent), ['−0.500', '+0.004', '+41.26']);
  assert.deepEqual(rows[0].map(p => p.gauge.dataset.state), ['inside', 'inside', 'beyond']);
  assert.deepEqual(rows.heading.children.map(c => c.textContent), ['JOINT', 'POS', 'VEL', 'TORQUE']);
  assert.deepEqual(rows.heading.children.slice(1).map(c => c.children[0].textContent), [' rad', ' rad/s', ' N m']);
  updateJointTable(rows, {q: [-.5], qd: null, torque: null, limits});
  assert.deepEqual(rows[0].map(p => p.text.textContent), ['−0.500', '—', '—']);
});

test('hovering shows the tooltip at once with value, bounds, utilisation, distance and state, and follows updates', () => {
  const container = new Node('div');
  const rows = createJointTable(container, ['a']);
  const limits = {lower_position_rad: [-1], upper_position_rad: [1], velocity_rad_s: [2], effort_nm: [40]};
  updateJointTable(rows, {q: [.95], qd: [2.5], torque: [10], limits});
  const tip = rows.tooltip.element;
  assert.equal(tip.hidden, true);
  const [position, velocity] = rows[0];
  const hover = (parts, clientX = 10, clientY = 20) => container.dispatch('pointermove', {clientX, clientY, target: {closest: () => parts.gauge}});
  hover(position);
  assert.equal(tip.hidden, false);
  assert.equal(tip.dataset.state, 'near');
  assert.match(tip.textContent, /\+0\.950 rad/);
  assert.match(tip.textContent, /URDF −1\.000 … \+1\.000 rad/);
  assert.match(tip.textContent, /near · 0\.050 rad from upper bound/);
  assert.equal(tip.style.left, '24px'); assert.equal(tip.style.top, '34px');
  hover(velocity);
  assert.match(tip.textContent, /\+2\.500 rad\/s/);
  assert.match(tip.textContent, /125 % · beyond · 0\.500 rad\/s beyond \+limit/);
  updateJointTable(rows, {q: [0], qd: [1], torque: [10], limits});
  assert.match(tip.textContent, /50 % · inside · 1\.000 rad\/s from \+limit/);
  container.dispatch('pointerleave');
  assert.equal(tip.hidden, true);
  // Nothing under the pointer: no tooltip.
  container.dispatch('pointermove', {clientX: 1, clientY: 1, target: {closest: () => null}});
  assert.equal(tip.hidden, true);
});
