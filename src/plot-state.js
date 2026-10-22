/** Inspection state is presentation only; it never mutates execution settings. */
export function createPlotState(saved = {}, persist = () => {}) {
  let sequence = 0;
  const instances = (saved.instances || []).filter(item => item.id && item.plot_id && ['episode', 'solve'].includes(item.context)).map(item => ({ ...item, parameters: { ...item.parameters } }));
  let timelineHeight = plotHeight(saved.timelineHeight, 60, 900);
  let sourceKey, pinned = null, selected = null, iteration = null;
  const save = () => persist({ instances, ...(timelineHeight ? { timelineHeight } : {}) });
  const find = id => instances.find(item => item.id === id);
  return {
    instances,
    add(definition, context) {
      const item = { id: `plot-${Date.now().toString(36)}-${++sequence}`, plot_id: definition.id, context, parameters: Object.fromEntries(Object.entries(definition.inputs || definition.controls || {}).map(([key, value]) => [key, value.default])), timeline: false };
      instances.push(item); save(); return item;
    },
    duplicate(id) { const original = find(id); if (!original) return; const item = { ...structuredClone(original), id: `plot-${Date.now().toString(36)}-${++sequence}`, timeline: false }; instances.splice(instances.indexOf(original) + 1, 0, item); save(); return item; },
    remove(id) { const index = instances.findIndex(item => item.id === id); if (index >= 0) instances.splice(index, 1); save(); },
    configure(id, parameters, display) { const item = find(id); if (item) { item.parameters = structuredClone(parameters); if (display !== undefined) item.display = displayLimits(display); } save(); },
    /** Plot heights per placement are presentation only, like display limits. */
    resize(id, placement, height, persistNow = true) { const item = find(id), value = plotHeight(height); if (!item || !['sidebar', 'timeline'].includes(placement)) return; item.sizes = { ...item.sizes, [placement]: value }; if (persistNow) save(); },
    height(id, placement) { return plotHeight(find(id)?.sizes?.[placement]); },
    get timelineHeight() { return timelineHeight; },
    set timelineHeight(value) { timelineHeight = plotHeight(value, 60, 900); save(); },
    reorder(id, before) { const item = find(id), target = find(before); if (!item || item === target) return; instances.splice(instances.indexOf(item), 1); instances.splice(target ? instances.indexOf(target) : instances.length, 0, item); save(); },
    place(id, value, eligible = true) { const item = find(id); if (item && item.context === 'episode' && eligible) item.timeline = value; save(); },
    setSource(key) { if (key !== sourceKey) { sourceKey = key; pinned = selected = null; iteration = null; } },
    follow(solve, source) {
      if (pinned) {
        // Only hydrate this exact historical solve, never follow a new cursor
        // association while pinned. The owner supplies its request source key.
        if (source === sourceKey && source != null && solve?.id === pinned.id) pinned = selected = { ...solve };
      } else { if (selected?.id !== solve?.id) iteration = null; selected = solve || null; }
    },
    pin(value = true) { pinned = value && selected ? { ...selected } : null; },
    selectIteration(index) { if (index == null || selected?.iterations?.some(item => item.index === index)) iteration = index; },
    get selected() { return pinned || selected; }, get pinned() { return Boolean(pinned); }, get iteration() { return iteration; },
    range(view) { return aggregateRange(view.aggregate, view.cursor); },
  };
}

/** Viewer y limits: each side a finite value or automatic (null). */
export function displayLimits(value = {}) {
  const side = number => number === '' || number == null || !Number.isFinite(Number(number)) ? null : Number(number);
  const limits = { min: side(value.min), max: side(value.max), clipOutliers: Boolean(value.clipOutliers) };
  return limits.min != null && limits.max != null && limits.min >= limits.max ? { ...limits, max: null } : limits;
}

function plotHeight(value, low = 40, high = 900) { return Number.isFinite(value) && value > 0 ? Math.round(Math.max(low, Math.min(high, value))) : undefined; }


/** The timeline's aggregate window as an episode analysis range. Omitted
 * bounds are unbounded; an open end follows newly retained history. */
export function aggregateRange(aggregate, cursor) {
  const start = Number.isFinite(aggregate?.start) ? aggregate.start : null, end = Number.isFinite(aggregate?.end) ? aggregate.end : null;
  if (start == null && end == null) return { mode: 'entire', cursor_s: cursor };
  return { mode: 'window', cursor_s: cursor, ...(start != null ? { start_s: start } : {}), ...(end != null ? { end_s: end } : {}) };
}
/** Sidebar episode-time axes show the aggregate window within the data bounds. */
export function aggregateAxis(aggregate, bounds) {
  if (!bounds) return undefined;
  const start = Number.isFinite(aggregate?.start) ? Math.max(bounds[0], aggregate.start) : bounds[0];
  return [start, Math.max(start, Number.isFinite(aggregate?.end) ? Math.min(bounds[1], aggregate.end) : bounds[1])];
}

export function timelineEligible(definition, spec) {
  return (definition?.scope || definition?.context) === 'episode' && (spec ? ['lines', 'bars', 'spans'].includes(spec.kind) && spec.x?.identity === 'episode_time' : definition.timeline_eligible === true);
}

/** Backend jobs are CPU only. Stale responses never replace newer inspection. */
export async function awaitPlotJob(request, path, payload, { alive = () => true, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let job = await request(path, payload);
  while (['pending', 'running'].includes(job.state)) {
    if (!alive()) return null;
    await wait(80);
    if (!alive()) return null;
    job = await request(`/api/plots/jobs/${encodeURIComponent(job.job_id || job.id)}`);
  }
  if (!alive() || job.state === 'superseded') return null;
  if (job.state === 'error' || job.state === 'failed') throw new Error(typeof job.error === 'string' ? job.error : JSON.stringify(job.error));
  return job.result ?? job;
}
