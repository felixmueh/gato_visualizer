export const LIVE_HISTORY_LIMITS = { maxSeconds: 300, maxSamples: 100000, maxPlans: 1024 };

// Samples keep references to immutable SSE plans, so plant samples between two
// solves share one saved prediction. No history operation issues solver commands.
export function createLiveHistory(options = {}) {
  const limits = { ...LIVE_HISTORY_LIMITS, ...options };
  let samples = [];
  let currentPlan = null;
  let intervals = [];
  // Limit breaches where Live stopped (records of type 'breach'), in time order.
  let breaches = [];
  let planAfterState = false;
  let revision = 0, metricCache = null, truncated = false, recordEvery = 1;
  const changed = () => { revision++; metricCache = null; };
  const clear = () => { samples = []; intervals = []; breaches = []; currentPlan = null; planAfterState = false; truncated = false; recordEvery = 1; changed(); };
  const trim = () => {
    const newest = samples.at(-1)?.state.sim_time_s;
    while (samples.length > 1 && (samples.length > limits.maxSamples || newest - samples[0].state.sim_time_s > limits.maxSeconds)) { samples.shift(); truncated = true; }
    if (!Number.isFinite(limits.maxPlans)) return;
    const plans = new Map();
    for (const sample of samples) if (sample.plan) plans.set(sample.plan, (plans.get(sample.plan) || 0) + 1);
    while (samples.length > 1 && plans.size > limits.maxPlans) {
      const { plan } = samples.shift();
      truncated = true;
      if (plan) {
        const remaining = plans.get(plan) - 1;
        if (remaining) plans.set(plan, remaining);
        else plans.delete(plan);
      }
    }
  };
  const addPlan = (plan) => {
    // Pause/reconnect republishes the last solve. Reuse an identical payload's
    // reference for the retention budget, while still processing every event.
    // A restarted sequence with changed data must remain a new prediction.
    const repeated = currentPlan && ['seq', 'settings_version', 'sim_time_s'].every((key) => currentPlan[key] === plan[key]) && JSON.stringify(currentPlan) === JSON.stringify(plan);
    currentPlan = repeated ? currentPlan : plan;
    planAfterState = true;
    if (samples.length && Math.abs(samples.at(-1).state.sim_time_s - plan.sim_time_s) < 1e-9) samples.at(-1).plan = currentPlan;
    trim();
    changed();
  };
  const addState = (state) => {
    if (!Number.isFinite(state.sim_time_s)) return;
    const last = samples.at(-1);
    if (last && state.sim_time_s < last.state.sim_time_s - 1e-9) {
      const resetPlan = planAfterState && Math.abs(currentPlan.sim_time_s - state.sim_time_s) < 1e-9 ? currentPlan : null;
      clear();
      currentPlan = resetPlan;
    }
    const plan = currentPlan && currentPlan.sim_time_s <= state.sim_time_s + 1e-9 ? currentPlan : null;
    const sample = { state, plan };
    // Recordings record states at every record_every-th physics step (1: all).
    if (state.record_every > recordEvery) recordEvery = state.record_every;
    if (samples.length && Math.abs(samples.at(-1).state.sim_time_s - state.sim_time_s) < 1e-9) samples[samples.length - 1] = sample;
    else samples.push(sample);
    planAfterState = false;
    trim();
    changed();
  };
  const at = (time = null, { trace = true } = {}) => {
    if (!samples.length) return null;
    let index = samples.length - 1;
    if (time != null) {
      let low = 0, high = samples.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (samples[middle].state.sim_time_s <= time) low = middle + 1;
        else high = middle;
      }
      index = Math.max(0, low - 1);
    }
    if (!trace) return { ...samples[index], index };
    const stride = Math.max(1, Math.ceil((index + 1) / 5000));
    const tracePoints = [];
    for (let i = 0; i <= index; i += stride) tracePoints.push(samples[i].state.ee_xyz);
    if (index % stride) tracePoints.push(samples[index].state.ee_xyz);
    return { ...samples[index], index, tracePoints };
  };
  const interpolateAt = (time, options) => {
    const selected = at(time, options);
    if (!selected) return null;
    const right = samples[selected.index + 1]?.state, left = selected.state;
    if (!right || time <= left.sim_time_s || right.sim_time_s <= left.sim_time_s || left.settings_version !== right.settings_version) return selected;
    const fraction = Math.min(1, (time - left.sim_time_s) / (right.sim_time_s - left.sim_time_s));
    const state = { ...left, sim_time_s: time, render_interpolated: true };
    for (const key of ['q', 'qd', 'ee_xyz', 'target_xyz']) {
      if (Array.isArray(left[key]) && Array.isArray(right[key]) && left[key].length === right[key].length) state[key] = left[key].map((value, i) => value + (right[key][i] - value) * fraction);
    }
    return { ...selected, state };
  };
  const addRecord = (record) => {
    if (record.type === 'plan') addPlan(record);
    else if (record.type === 'state') addState(record);
    else if (record.type === 'interval') { intervals.push(record); changed(); }
    else if (record.type === 'breach' && Number.isFinite(record.sim_time_s)) { breaches.push(record); changed(); }
  };
  // The first breach in (after, until]: where playback crossing it stops.
  const breachCrossed = (after, until) => breaches.find(item => item.sim_time_s > after + 1e-9 && item.sim_time_s <= until + 1e-9) || null;
  return {
    clear, addPlan, addState, at, interpolateAt, addRecord, breachCrossed,
    get intervals() { return intervals; },
    get breaches() { return breaches; },
    // Read-only convention: rebuild views only on recorded changes, never RAF.
    // Copies contain original immutable payload references, not copied states.
    get metricSnapshot() {
      if (!metricCache) {
        const states = samples.map(sample => sample.state);
        const plans = [...new Set(samples.map(sample => sample.plan).filter(Boolean))];
        if (currentPlan && !plans.includes(currentPlan)) plans.push(currentPlan);
        const start = states[0]?.sim_time_s ?? -Infinity;
        metricCache = { revision, states, plans, intervals: intervals.filter(item => item.end_time_s > start), truncated, sourceKind: 'live' };
      }
      return metricCache;
    },
    displayPath(maxPoints = 5000) {
      const stride = Math.max(1, Math.ceil(samples.length / maxPoints));
      const points = [];
      for (let i = 0; i < samples.length; i += stride) points.push(samples[i].state.ee_xyz);
      if ((samples.length - 1) % stride && samples.length) points.push(samples.at(-1).state.ee_xyz);
      return { points, stride };
    },
    get pathPoints() { return samples.map(sample => sample.state.ee_xyz); },
    get length() { return samples.length; },
    get recordEvery() { return recordEvery; },
    get bounds() { return samples.length ? [samples[0].state.sim_time_s, samples.at(-1).state.sim_time_s] : [0, 0]; },
    get limits() { return { ...limits }; },
  };
}
