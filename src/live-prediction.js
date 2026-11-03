// Prediction geometry follows a 60 Hz display-time grid while motion keeps
// every recorded sample. Paused/scrubbed selection remains exact. Lookahead
// contains only samples already recorded, independent of geometry downloads.
export function livePredictionWindow(plan, history, { playing, time, effectiveRate }) {
  const lookahead = [];
  if (plan?.summary && playing && time != null) {
    const step = effectiveRate / 60, [start, end] = history.bounds;
    const index = Math.floor((time - start) / step + 1e-9);
    plan = history.at(start + index * step, { trace: false })?.plan || plan;
    for (let i = 0; i <= 18; i++) {
      const at = start + (index + i) * step;
      if (at > end) break;
      const next = history.at(at, { trace: false })?.plan;
      if (next?.summary) lookahead.push(next);
    }
  }
  return { plan, lookahead };
}

// Export has frozen samples and its own exact frame schedule. Load only the
// applicable predictions, retaining immutable payload references across cache
// eviction. Failed/cancelled loads reject the export rather than omit geometry.
export async function hydrateLiveAnimationHistory(samples, schedule, ensurePlans, { signal } = {}) {
  const indices = new Set();
  for (let frame = 0; frame < schedule.frameCount; frame++) {
    const time = schedule.time(frame);
    let low = 0, high = samples.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (samples[middle].state.sim_time_s <= time) low = middle + 1;
      else high = middle;
    }
    if (samples.length) indices.add(Math.max(0, low - 1));
  }
  const ids = [...new Set([...indices].map(index => samples[index].plan).filter(item => item?.summary).map(item => item.seq))];
  if (!ids.length) return samples;
  const records = await ensurePlans(ids, { signal }), byId = new Map(records.map(item => [String(item.seq), item]));
  return Object.freeze(samples.map(({ state, plan }) => Object.freeze({ state,
    plan: plan?.summary ? byId.get(String(plan.seq)) || null : plan })));
}
