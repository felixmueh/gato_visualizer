export const PLAYOUT_DELAY_MS = 80;

const interpolate = (left, right, fraction) => left.map((value, index) => value + (right[index] - value) * fraction);
const compatibleArray = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every(Number.isFinite) && right.every(Number.isFinite);

// Browser arrival time is the display clock, not a replacement simulation clock.
// Only interpolate between delivered states; stalls hold the newest known state.
export function createLivePlayout({ delayMs = PLAYOUT_DELAY_MS, maxSamples = 16 } = {}) {
  let samples = [];
  const clear = () => { samples = []; };
  function add(state, arrivalMs, version = state.settings_version ?? null) {
    const bounds = JSON.stringify(state.joint_limits || null);
    const last = samples.at(-1);
    if (last && (state.sim_time_s < last.state.sim_time_s || version !== last.version || bounds !== last.bounds)) clear();
    const item = { state, arrivalMs, version, bounds };
    if (samples.length && state.sim_time_s === samples.at(-1).state.sim_time_s) samples[samples.length - 1] = item;
    else samples.push(item);
    if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
  }
  function at(nowMs) {
    if (!samples.length) return null;
    const time = nowMs - delayMs;
    if (time <= samples[0].arrivalMs) return samples[0].state;
    for (let index = 1; index < samples.length; index++) {
      const left = samples[index - 1], right = samples[index];
      if (time >= right.arrivalMs) continue;
      const fraction = (time - left.arrivalMs) / (right.arrivalMs - left.arrivalMs);
      const state = {
        ...left.state,
        sim_time_s: left.state.sim_time_s + (right.state.sim_time_s - left.state.sim_time_s) * fraction,
        render_interpolated: true,
      };
      for (const key of ['q', 'qd', 'ee_xyz', 'target_xyz']) {
        if (compatibleArray(left.state[key], right.state[key])) state[key] = interpolate(left.state[key], right.state[key], fraction);
      }
      // Torque, active bounds, solver statistics, and arrival flags retain their
      // saved left-sample values. They are not synthetic continuous telemetry.
      return state;
    }
    return samples.at(-1).state;
  }
  return { add, at, clear, get length() { return samples.length; }, delayMs };
}
