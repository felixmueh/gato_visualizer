import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleTelemetry, createJointTable, updateJointTable, setupJointViewToggle, loadJointView, saveJointView, JOINT_VIEW_KEY, createGaugeTooltip, setupJointLock, loadJointLock, JOINT_LOCK_KEY, OUTSIDE_PLANNING} from './joint-telemetry.js';

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
  assert.deepEqual(rows.heading.children.map(c => c.children[0].textContent), ['JOINT', 'POS', 'VEL', 'TORQUE']);
  assert.deepEqual(rows.heading.children.slice(1).map(c => c.children[1].textContent), [' rad', ' rad/s', ' N m']);
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

// Start pose editing (Felix, 2026-10-23): behind the lock, in Live at the run start.
const LIMITS = {lower_position_rad: [-2, -1], upper_position_rad: [2, 1], velocity_rad_s: [2, 2], effort_nm: [40, 40]};
const pose = (changes = {}) => ({editable: true, value: [.5, 0], defaults: [.5, 0], lower: [-2, -1], upper: [2, 1],
  planning: {lower: [-1.9, -.9], upper: [1.9, .9]}, ...changes});
function editableTable(storage = memory()) {
  const container = new Node('div'), drafts = [], commits = [];
  const rows = createJointTable(container, ['a', 'b'], {onStartPoseDraft: q => drafts.push(q), onStartPoseCommit: q => commits.push(q)});
  const button = new Node('button');
  setupJointLock({button, rows, storage});
  // A 200 px track: the URDF range spans its inner 86 % (7 % inset each side).
  rows[0][0].track.getBoundingClientRect = () => ({left: 100, width: 200});
  rows[0][0].gauge.setPointerCapture = () => {};
  return {container, rows, button, drafts, commits, storage};
}

test('the lock is locked by default, remembered per viewer, and locked joints are read-only as before', () => {
  const {container, rows, button, drafts, commits, storage} = editableTable();
  assert.equal(rows.locked, true); assert.equal(button.dataset.locked, 'true');
  assert.match(button.title, /Locked/);
  updateJointTable(rows, {q: [.5, 0], limits: LIMITS, startPose: pose()});
  assert.equal(container.dataset.startPose, '');
  assert.equal(rows.positionLabel.textContent, 'POS');
  assert.equal(rows[0].input.disabled, true);
  rows[0][0].gauge.dispatch('pointerdown', {button: 0, clientX: 200, pointerId: 1, preventDefault() {}});
  rows[0][0].gauge.dispatch('pointerup', {});
  assert.deepEqual([drafts, commits], [[], []]);
  button.dispatch('click');
  assert.equal(rows.locked, false); assert.equal(storage.data[JOINT_LOCK_KEY], 'unlocked');
  assert.equal(loadJointLock(storage), false);
  assert.equal(loadJointLock({getItem() { throw new Error('blocked'); }}), true);
  assert.equal(editableTable(storage).rows.locked, false);
});

test('unlocked at the run start, dragging a position previews and commits the start pose once on release', () => {
  const {container, rows, button, drafts, commits} = editableTable();
  button.dispatch('click');
  updateJointTable(rows, {q: [.5, 0], limits: LIMITS, startPose: pose()});
  assert.equal(container.dataset.startPose, 'edit');
  assert.equal(rows.positionLabel.textContent, 'START');
  assert.match(rows[0][0].gauge.dataset.tip, /^Start pose \+0\.500 rad/m);
  const gauge = rows[0][0].gauge;
  gauge.dispatch('pointerdown', {button: 0, clientX: 200, pointerId: 1, preventDefault() {}});  // the centre: 0 rad
  gauge.dispatch('pointermove', {clientX: 214});  // +0.14 rad of 0.86 * 200 px per 4 rad
  gauge.dispatch('pointermove', {clientX: 500});  // clamped to the URDF upper limit
  assert.deepEqual(drafts.slice(0, 2).map(q => q[0]), [0, Number((14 / 172 * 4).toFixed(4))]);
  assert.deepEqual(drafts.at(-1), [2, 0]);
  assert.equal(commits.length, 0);
  gauge.dispatch('pointerup', {});
  assert.equal(drafts.at(-1), null);  // the scene returns to the shown state until the run arrives
  assert.deepEqual(commits, [[2, 0]]);
  // A cancelled drag commits nothing; velocity and torque gauges have no editing.
  gauge.dispatch('pointerdown', {button: 0, clientX: 150, pointerId: 2, preventDefault() {}});
  gauge.dispatch('pointercancel', {});
  assert.deepEqual(commits, [[2, 0]]);
  assert.equal(rows[0][1].input, undefined);
  // Away from the run start the table is read-only again.
  updateJointTable(rows, {q: [.3, 0], limits: LIMITS, startPose: pose({editable: false})});
  assert.equal(container.dataset.startPose, ''); assert.equal(rows[0].input.disabled, true);
  gauge.dispatch('pointerdown', {button: 0, clientX: 200, pointerId: 3, preventDefault() {}});
  assert.equal(drafts.length, 6);
});

test('typing a start pose commits on change (Enter), clamps to the URDF range and Escape restores it', () => {
  const {rows, button, commits} = editableTable();
  button.dispatch('click');
  updateJointTable(rows, {q: [.5, 0], limits: LIMITS, startPose: pose()});
  const input = rows[1].input;
  assert.equal(input.value, '0.000'); assert.equal(input.disabled, false);
  assert.deepEqual([input.min, input.max], ['-1', '1']);
  input.value = '0.25'; input.dispatch('change');
  input.value = '7'; input.dispatch('change');
  assert.deepEqual(commits, [[.5, .25], [.5, 1]]);
  assert.equal(input.value, '1.000');
  input.value = 'abc'; input.dispatch('change');
  assert.equal(input.value, '0.000'); assert.equal(commits.length, 2);
  input.value = '0.4'; input.dispatch('keydown', {key: 'Escape'});
  assert.equal(input.value, '0.000');
  input.value = '0.000'; input.dispatch('change');  // unchanged: no settings change
  assert.equal(commits.length, 2);
});

test('reset arrows return one joint or all to the default, and a pose outside the planning box is flagged', () => {
  const {rows, button, commits} = editableTable();
  button.dispatch('click');
  updateJointTable(rows, {q: [1.95, .3], limits: LIMITS, startPose: pose({value: [1.95, .3]})});
  assert.deepEqual([rows[0].reset.hidden, rows[1].reset.hidden, rows.resetAll.hidden], [false, false, false]);
  assert.equal(rows[0].row.dataset.planning, 'outside'); assert.equal(rows[1].row.dataset.planning, '');
  assert(rows[0].label.title.endsWith(OUTSIDE_PLANNING));
  assert.match(rows[0][0].gauge.dataset.tip, /Planning box −1\.900 … \+1\.900 rad · default \+0\.500 rad/);
  assert.match(button.title, /Start pose modified: J1 \+1\.950 rad \(default \+0\.500\), J2 \+0\.300 rad/);
  rows[1].reset.dispatch('click', {preventDefault() {}, stopPropagation() {}});
  rows.resetAll.dispatch('click', {preventDefault() {}});
  assert.deepEqual(commits, [[1.95, 0], [.5, 0]]);
  // Locked, the modification stays visible on the lock only.
  button.dispatch('click');
  updateJointTable(rows, {q: [1.95, .3], limits: LIMITS, startPose: pose({value: [1.95, .3]})});
  assert.equal(rows.resetAll.hidden, true); assert.equal(rows[0].row.dataset.planning, '');
  assert.equal(button.dataset.modified, 'true');
});
