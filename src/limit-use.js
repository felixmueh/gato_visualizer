// Joint limit use, shared by the 3D tint, the Joints gauges and limit plots.
// The reference (100 %) is the physical URDF limit (`joint_limits`), never the
// tighter MPC bounds. Mirrors gato_visualizer/plotting/limit_use.py (the plot
// side); tests/fixtures/limit_use_cases.json checks that both agree.
//
// Utilisation: position |q − centre| / half range; velocity |qd| / limit;
// torque |τ| / effort. Distance: to the bound on the value's side of the
// centre, in physical units, positive inside and negative beyond. States, in
// increasing severity: inside, near (utilisation × 100 ≥ limit_near_percent),
// at (|distance| ≤ the quantity's at-tolerance, either side), beyond
// (distance < −tolerance).

export const DEFAULT_LIMIT_USE = Object.freeze({
  limit_near_percent: 90,
  limit_at_position_rad: 0.003,
  limit_at_velocity_rad_s: 0.01,
  limit_at_torque_percent: 0.2,
});
// Inclusive ranges, also enforced by the backend presentation settings.
export const LIMIT_USE_RANGES = Object.freeze({
  limit_near_percent: [1, 100],
  limit_at_position_rad: [0, 0.1],
  limit_at_velocity_rad_s: [0, 1],
  limit_at_torque_percent: [0, 10],
});
export const LIMIT_QUANTITIES = Object.freeze(['position', 'velocity', 'torque']);
export const LIMIT_STATES = Object.freeze(['inside', 'near', 'at', 'beyond']);
export const LIMIT_UNITS = Object.freeze({ position: 'rad', velocity: 'rad/s', torque: 'Nm' });
// CSS custom properties defined on :root in style.css. The 3D tint resolves
// them at runtime; these fallbacks apply only where no stylesheet is loaded.
export const LIMIT_COLOR_TOKENS = Object.freeze({
  position: '--limit-position', velocity: '--limit-velocity', torque: '--limit-torque',
  near: '--limit-near', at: '--limit-at', beyond: '--limit-beyond',
});
export const LIMIT_COLOR_FALLBACKS = Object.freeze({
  position: '#57c7dc', velocity: '#b398f3', torque: '#85c99c',
  near: '#f2b544', at: '#ff4b4b', beyond: '#ff4b4b',
});

export function limitColor(name, element = globalThis.document?.documentElement) {
  let value = '';
  try { value = element ? globalThis.getComputedStyle?.(element).getPropertyValue(LIMIT_COLOR_TOKENS[name]).trim() : ''; } catch { value = ''; }
  return value || LIMIT_COLOR_FALLBACKS[name];
}

export function validateLimitUse(value = {}) {
  const result = { ...DEFAULT_LIMIT_USE };
  for (const [name, [low, high]] of Object.entries(LIMIT_USE_RANGES)) {
    if (value?.[name] !== undefined) result[name] = value[name];
    if (typeof result[name] !== 'number' || !Number.isFinite(result[name]) || result[name] < low || result[name] > high) throw new Error(`${name} must be between ${low} and ${high}.`);
  }
  return result;
}

// Only the limit-use fields, e.g. from the full presentation settings.
export function pickLimitUse(settings = {}) {
  return Object.fromEntries(Object.keys(DEFAULT_LIMIT_USE).map(name => [name, settings[name] ?? DEFAULT_LIMIT_USE[name]]));
}

const finite = Number.isFinite;

/** [lower, upper] of one joint's URDF limit, or null when unknown. */
export function limitBounds(limits, quantity, index) {
  if (!limits) return null;
  if (quantity === 'position') {
    const lower = limits.lower_position_rad?.[index], upper = limits.upper_position_rad?.[index];
    return finite(lower) && finite(upper) && upper > lower ? [lower, upper] : null;
  }
  const limit = quantity === 'velocity' ? limits.velocity_rad_s?.[index] : quantity === 'torque' ? limits.effort_nm?.[index] : undefined;
  return finite(limit) && limit > 0 ? [-limit, limit] : null;
}

// Same arithmetic as limit_use.limit_use(), so both sides agree to the bit.
function measure(quantity, value, limits, index) {
  const bounds = limitBounds(limits, quantity, index);
  if (!bounds || !finite(value)) return null;
  if (quantity !== 'position') return { utilisation: Math.abs(value) / bounds[1], distance: bounds[1] - Math.abs(value), side: value < 0 ? 'lower' : 'upper', bounds };
  const [lower, upper] = bounds, centre = (upper + lower) / 2, half = (upper - lower) / 2, high = value >= centre;
  return { utilisation: Math.abs(value - centre) / half, distance: high ? upper - value : value - lower, side: high ? 'upper' : 'lower', bounds };
}

export function limitUtilisation(quantity, value, limits, index) { return measure(quantity, value, limits, index)?.utilisation ?? null; }
export function limitDistance(quantity, value, limits, index) { return measure(quantity, value, limits, index)?.distance ?? null; }

/** At-tolerance in the quantity's physical unit (torque: % of effort). */
export function atTolerance(quantity, limits, index, settings = DEFAULT_LIMIT_USE) {
  if (quantity === 'position') return settings.limit_at_position_rad;
  if (quantity === 'velocity') return settings.limit_at_velocity_rad_s;
  const bounds = limitBounds(limits, quantity, index);
  return bounds ? settings.limit_at_torque_percent / 100 * bounds[1] : null;
}

/** Full limit use of one value, or null when the value or its limit is unknown. */
export function quantityLimitUse(quantity, value, limits, index, settings = DEFAULT_LIMIT_USE) {
  const measured = measure(quantity, value, limits, index);
  if (!measured) return null;
  const { utilisation, distance, side, bounds } = measured;
  const tolerance = atTolerance(quantity, limits, index, settings);
  const state = distance < -tolerance ? 'beyond' : Math.abs(distance) <= tolerance ? 'at'
    : utilisation * 100 >= settings.limit_near_percent ? 'near' : 'inside';
  return { quantity, value, utilisation, distance, tolerance, state, unit: LIMIT_UNITS[quantity], side, lower: bounds[0], upper: bounds[1] };
}

export const stateRank = state => LIMIT_STATES.indexOf(state);

/** Limit use of each quantity the sample has, and the worst of them. */
export function jointLimitUse({ q, qd, torque, limits }, index, settings = DEFAULT_LIMIT_USE) {
  const values = { position: q?.[index], velocity: qd?.[index], torque: torque?.[index] };
  const result = { worst: null };
  for (const quantity of LIMIT_QUANTITIES) {
    const use = quantityLimitUse(quantity, values[quantity], limits, index, settings);
    result[quantity] = use;
    if (use && (!result.worst || stateRank(use.state) > stateRank(result.worst.state)
      || stateRank(use.state) === stateRank(result.worst.state) && use.utilisation > result.worst.utilisation)) result.worst = use;
  }
  return result;
}

const precision = { position: 3, velocity: 3, torque: 2 };
export function formatLimitDistance(use) {
  const digits = precision[use.quantity];
  const amount = Math.abs(use.distance).toFixed(digits);
  const bound = use.quantity === 'position' ? `${use.side} bound` : `${use.side === 'lower' ? '−' : '+'}limit`;
  return use.distance < 0 ? `${amount} ${use.unit} beyond ${bound}` : `${amount} ${use.unit} from ${bound}`;
}

/** e.g. "arm_right_4 position · at · 0.002 rad from lower bound" */
export function describeLimitUse(name, use) {
  return `${name} ${use.quantity} · ${use.state} · ${formatLimitDistance(use)}`;
}
