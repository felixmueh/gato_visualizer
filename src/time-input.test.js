import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalTimeUnit, parseTimeValue, configureTimeInput, readTimeInput, setTimeInputValue } from './time-input.js';

test('rates and periods accept either spelling while preserving the canonical API unit', () => {
  for (const text of ['50Hz', '50 Hz', ' 5e1 hZ ', '0.02s', '20 ms', '20000 us', '20000µs', '20000 μs', '.05 kHz']) {
    assert.equal(parseTimeValue(text, { unit: 'Hz' }), 50, text);
    assert.equal(parseTimeValue(text, { unit: 's' }), .02, text);
    assert.equal(parseTimeValue(text, { unit: 'ms' }), 20, text);
  }
  assert.equal(parseTimeValue('50', { unit: 'Hz' }), 50);
  assert.equal(parseTimeValue('50', { unit: 'ms' }), 50);
  assert.equal(parseTimeValue('.02', { unit: 's' }), .02);
  assert.equal(parseTimeValue('1e3Hz', { unit: 's' }), .001);
  assert.equal(parseTimeValue('350ms', { unit: 's' }), .35);
  assert.equal(parseTimeValue('.35s', { unit: 'ms' }), 350);
  for (const unit of ['s', 'ms', 'Hz']) for (const value of [49, 350, 1000]) assert.equal(parseTimeValue(value, { unit }), value);
});

test('constraints apply after conversion, with separate positive rates and nonnegative durations', () => {
  assert.equal(parseTimeValue('0ms', { unit: 's', min: 0 }), 0);
  assert.equal(parseTimeValue('20ms', { unit: 'Hz', min: 1, max: 120 }), 50);
  assert.throws(() => parseTimeValue('200ms', { unit: 'Hz', min: 10 }), /at least 10 Hz/);
  assert.throws(() => parseTimeValue('1kHz', { unit: 's', min: .01 }), /at least 0.01 s/);
  assert.throws(() => parseTimeValue('0s', { unit: 's', min: 0, minExclusive: true }), /greater than/);
  assert.throws(() => parseTimeValue('20ms', { unit: 's', max: .02, maxExclusive: true }), /less than/);
  for (const text of ['0Hz', '-50Hz', '0s', '-20ms']) assert.throws(() => parseTimeValue(text, { unit: 'Hz' }), /positive/);
  for (const text of ['0Hz', '-50Hz']) assert.throws(() => parseTimeValue(text, { unit: 's' }), /positive/);
});

test('signed offsets and timestamps allow time units while optional bounds stay explicit', () => {
  assert.equal(parseTimeValue('-20ms', { unit: 's', allowFrequency: false }), -.02);
  assert.equal(parseTimeValue('+2s', { unit: 's', allowFrequency: false }), 2);
  assert.throws(() => parseTimeValue('50Hz', { unit: 's', allowFrequency: false }), /in s, ms or µs/);
  assert.equal(parseTimeValue('', { unit: 's', nullable: true }), null);
  assert.equal(parseTimeValue('None', { unit: 'ms', nullable: true }), null);
  assert.throws(() => parseTimeValue('none', { unit: 's' }));
  for (const text of ['measured', 'asap', 'fastest']) assert.throws(() => parseTimeValue(text, { unit: 's', nullable: true }));
});

test('malformed expressions, unknown dimensions, nonfinite and reciprocal overflow are rejected', () => {
  for (const text of ['', ' ', 'NaN', 'Infinity', '1/50s', '50 Hz + 1', '20msfoo', '1rad/s', '0.02,', '0,02s', '0x20', '1_000Hz', '1e', '1e999Hz', '1e-999s']) {
    assert.throws(() => parseTimeValue(text, { unit: 'Hz' }), text);
  }
  assert.throws(() => parseTimeValue('1e-320Hz', { unit: 's' }), /finite timing range/);
  assert.throws(() => parseTimeValue('1e308kHz', { unit: 's' }), /finite timing range/);
  assert.throws(() => parseTimeValue('20ms', { unit: 'rad/s' }), /Unsupported canonical/);
});

test('time metadata takes precedence and velocity/friction spellings never become time fields', () => {
  assert.equal(canonicalTimeUnit({ unit: 'Hz', path: 'anything' }), 'Hz');
  assert.equal(canonicalTimeUnit({ unit: 'ms', path: 'anything' }), 'ms');
  assert.equal(canonicalTimeUnit('config.dt_s'), 's');
  assert.equal(canonicalTimeUnit({ path: 'buffer_ms' }), 'ms');
  assert.equal(canonicalTimeUnit({ path: 'report_hz' }), 'Hz');
  assert.equal(canonicalTimeUnit({ unit: 'rad/s', path: 'width_s' }), null);
  for (const path of ['friction_width_rad_s', 'velocity_m_s', 'angular_velocity_rad_s', 'impulse_nm_s', 'qd_cost', 'N', 'viscous_nm_s_per_rad']) {
    assert.equal(canonicalTimeUnit({ path }), null, path);
  }
});

function input(value = '') {
  return { value, type: 'number', dataset: {}, title: 'Existing field help', ownerDocument: { activeElement: null },
    setCustomValidity(message) { this.validityMessage = message; } };
}

test('input reads validate without rewriting unit text and equivalent server echoes retain it', () => {
  const field = configureTimeInput(input('20 ms'), { unit: 'Hz' });
  assert.equal(field.type, 'text'); assert.equal(field.inputMode, 'decimal');
  assert.match(field.title, /Existing field help[\s\S]*Bare numbers use Hz/);
  assert.equal(readTimeInput(field, { unit: 'Hz' }), 50); assert.equal(field.value, '20 ms');
  assert.equal(setTimeInputValue(field, 50, { unit: 'Hz' }), false); assert.equal(field.value, '20 ms');
  assert.equal(setTimeInputValue(field, 100, { unit: 'Hz' }), true); assert.equal(field.value, '100');
  field.value = '1e'; assert.throws(() => readTimeInput(field, { unit: 'Hz' }));
  assert.match(field.validityMessage, /enter a number/); assert.equal(field.value, '1e');
});

test('focused partial edits survive hydration, while explicit Reset can restore canonical defaults', () => {
  const field = input('20 m'); field.ownerDocument.activeElement = field;
  assert.equal(setTimeInputValue(field, .03, { unit: 's' }), false); assert.equal(field.value, '20 m');
  assert.equal(setTimeInputValue(field, .03, { unit: 's', force: true }), true); assert.equal(field.value, '0.03');
  field.ownerDocument.activeElement = null; field.value = 'none';
  assert.equal(setTimeInputValue(field, null, { unit: 's', nullable: true }), false); assert.equal(field.value, 'none');
});
