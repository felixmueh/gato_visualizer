export const ONION_MIN_OPACITY = .25;
export const ONION_MAX_OPACITY = .55;
export const ONION_CURSOR_HIDE_S = .005;
export const DEFAULT_GHOST_SETTINGS = Object.freeze({ opacity: ONION_MAX_OPACITY, interval_s: .5, maxCount: 16 });

export function validateGhostSettings(value = {}) {
  const settings = { ...DEFAULT_GHOST_SETTINGS, ...value };
  if (!Number.isFinite(settings.opacity) || settings.opacity < 0 || settings.opacity > 1) throw new Error('Ghost opacity must be between 0 and 1.');
  if (!Number.isFinite(settings.interval_s) || settings.interval_s < .01 || settings.interval_s > 3600) throw new Error('Ghost spacing must be between 0.01 and 3600 seconds.');
  if (!Number.isInteger(settings.maxCount) || settings.maxCount < 1 || settings.maxCount > 64) throw new Error('Maximum ghost arms must be an integer from 1 to 64.');
  return settings;
}

/** Fixed-spacing prefix anchored at the selected range's left edge. Intersect
 * the grid with recorded time; a cap never widens it or adds an endpoint. */
export function onionKeyframes(times, { range, maxCount = DEFAULT_GHOST_SETTINGS.maxCount, interval_s = DEFAULT_GHOST_SETTINGS.interval_s } = {}) {
  if (!times?.length) return { step: null, times: [] };
  const recordedStart = times[0], recordedEnd = times[times.length - 1];
  const start = Number.isFinite(range?.[0]) ? range[0] : recordedStart;
  const end = Number.isFinite(range?.[1]) ? range[1] : recordedEnd;
  maxCount = Number.isInteger(maxCount) ? Math.max(1, Math.min(64, maxCount)) : DEFAULT_GHOST_SETTINGS.maxCount;
  interval_s = Number.isFinite(interval_s) && interval_s > 0 ? interval_s : DEFAULT_GHOST_SETTINGS.interval_s;
  const lower = Math.max(start, recordedStart), upper = Math.min(end, recordedEnd), keyframes = [];
  if (lower > upper) return { step: interval_s, times: [] };
  const firstGrid = (lower - start) / interval_s, lastGrid = (upper - start) / interval_s;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(firstGrid), Math.abs(lastGrid), Math.abs(start) / interval_s, Math.abs(upper) / interval_s) * 4;
  const first = Math.max(0, Math.ceil(firstGrid - tolerance)), last = Math.floor(lastGrid + tolerance);
  for (let count = 0; count < maxCount && first + count <= last; count++) {
    const time = Number((start + (first + count) * interval_s).toPrecision(15));
    keyframes.push(Math.max(lower, Math.min(upper, time)));
  }
  return { step: interval_s, times: keyframes };
}

/** Divide one strict temporal-ghost budget across nonempty recorded sources. */
export function onionBudgets(sources, maxCount, { interval_s = DEFAULT_GHOST_SETTINGS.interval_s } = {}) {
  const budgets = sources.map(() => 0);
  const eligible = sources.map((source, index) => onionKeyframes(source.times, { range: source.range, interval_s, maxCount: 1 }).times.length ? index : -1).filter(index => index >= 0);
  for (let count = 0; count < maxCount && eligible.length; count++) budgets[eligible[count % eligible.length]]++;
  return budgets;
}

/** Hold the recorded sample, never interpolate. Endpoints match playback. */
export function sampleAtOrBefore(times, time) {
  if (!times?.length) return -1;
  let low = 0, high = times.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (times[middle] <= time) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

export function onionOpacity(time, cursor, range, opacity = ONION_MAX_OPACITY) {
  const distance = Math.abs(time - cursor);
  if (distance <= ONION_CURSOR_HIDE_S) return 0;
  const span = typeof range === 'number' ? range : range[1] - range[0];
  const fraction = span > 0 ? Math.min(1, distance / span) : 1;
  return opacity * (1 - fraction * (1 - ONION_MIN_OPACITY / ONION_MAX_OPACITY));
}

export function visibleOnionKeyframes(keyframes, cursor, reveal) {
  return reveal ? keyframes.filter(keyframe => (typeof keyframe === 'number' ? keyframe : keyframe.time) <= cursor) : keyframes;
}
