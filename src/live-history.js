export const LIVE_HISTORY_LIMITS = { maxSeconds: 60, maxSamples: 2000, maxPlans: 256 };

// Samples keep references to immutable SSE plans, so plant samples between two
// solves share one saved prediction. No history operation issues solver commands.
export function createLiveHistory(options = {}) {
  const limits = { ...LIVE_HISTORY_LIMITS, ...options };
  let samples = [];
  let currentPlan = null;
  let planAfterState = false;
  const clear = () => { samples = []; currentPlan = null; planAfterState = false; };
  const trim = () => {
    const newest = samples.at(-1)?.state.sim_time_s;
    while (samples.length > 1 && (samples.length > limits.maxSamples || newest - samples[0].state.sim_time_s > limits.maxSeconds)) samples.shift();
    const plans = new Map();
    for (const sample of samples) if (sample.plan) plans.set(sample.plan, (plans.get(sample.plan) || 0) + 1);
    while (samples.length > 1 && plans.size > limits.maxPlans) {
      const { plan } = samples.shift();
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
    if (samples.length && Math.abs(samples.at(-1).state.sim_time_s - state.sim_time_s) < 1e-9) samples[samples.length - 1] = sample;
    else samples.push(sample);
    planAfterState = false;
    trim();
  };
  const at = (time = null) => {
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
    return { ...samples[index], index, tracePoints: samples.slice(0, index + 1).map((sample) => sample.state.ee_xyz) };
  };
  return {
    clear, addPlan, addState, at,
    get length() { return samples.length; },
    get bounds() { return samples.length ? [samples[0].state.sim_time_s, samples.at(-1).state.sim_time_s] : [0, 0]; },
    get limits() { return { ...limits }; },
  };
}
