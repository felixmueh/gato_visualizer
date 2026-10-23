export const ONION_MIN_OPACITY = .25;
export const ONION_MAX_OPACITY = .55;
export const ONION_CURSOR_HIDE_S = .005;
export const DEFAULT_GHOST_SETTINGS = Object.freeze({ opacityStart: ONION_MAX_OPACITY, opacityEnd: ONION_MIN_OPACITY, spacingEnabled: true, interval_s: .5, maxCount: 16 });

export function validateGhostSettings(value = {}) {
  const settings = { ...DEFAULT_GHOST_SETTINGS, ...value };
  for (const name of ['opacityStart', 'opacityEnd']) if (!Number.isFinite(settings[name]) || settings[name] < 0 || settings[name] > 1) throw new Error('Ghost opacity must be between 0 and 1.');
  if (typeof settings.spacingEnabled !== 'boolean') throw new Error('Fixed spacing must be on or off.');
  if (!Number.isFinite(settings.interval_s) || settings.interval_s < .01 || settings.interval_s > 3600) throw new Error('Ghost spacing must be between 0.01 and 3600 seconds.');
  if (!Number.isInteger(settings.maxCount) || settings.maxCount < 1 || settings.maxCount > 64) throw new Error('Maximum ghost arms must be an integer from 1 to 64.');
  const { opacityStart, opacityEnd, spacingEnabled, interval_s, maxCount } = settings;
  return { opacityStart, opacityEnd, spacingEnabled, interval_s, maxCount };
}

/** Fixed-spacing prefix anchored at the selected range's left edge. Intersect
 * the grid with recorded time; a cap never widens it or adds an endpoint.
 * Without fixed spacing, distribute the budget across the full aggregate
 * range first, then intersect recording support. Never stretch a short track. */
export function onionKeyframes(times, { range, maxCount = DEFAULT_GHOST_SETTINGS.maxCount, interval_s = DEFAULT_GHOST_SETTINGS.interval_s, spacingEnabled = DEFAULT_GHOST_SETTINGS.spacingEnabled } = {}) {
  if (!times?.length) return { step: null, times: [] };
  const recordedStart = times[0], recordedEnd = times[times.length - 1];
  const start = Number.isFinite(range?.[0]) ? range[0] : recordedStart;
  const end = Number.isFinite(range?.[1]) ? range[1] : recordedEnd;
  maxCount = Number.isInteger(maxCount) ? Math.max(1, Math.min(64, maxCount)) : DEFAULT_GHOST_SETTINGS.maxCount;
  interval_s = Number.isFinite(interval_s) && interval_s > 0 ? interval_s : DEFAULT_GHOST_SETTINGS.interval_s;
  const lower = Math.max(start, recordedStart), upper = Math.min(end, recordedEnd), keyframes = [];
  if (!spacingEnabled) {
    if (lower > upper) return { step: null, times: [] };
    const count = start === end ? 1 : maxCount;
    for (let i = 0; i < count; i++) {
      const time = count === 1 ? start : start + (end - start) * i / (count - 1);
      const tolerance = Number.EPSILON * Math.max(1, Math.abs(time), Math.abs(lower), Math.abs(upper)) * 4;
      if (time >= lower - tolerance && time <= upper + tolerance) keyframes.push(Math.max(lower, Math.min(upper, time)));
    }
    return { step: null, times: keyframes };
  }
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

/** Divide one strict temporal-ghost budget fairly across eligible sources.
 * Even distributions skip disjoint support. A narrow partial recording may
 * miss its assigned grid: the cap is a maximum, never a target to fill. */
export function onionBudgets(sources, maxCount, { interval_s = DEFAULT_GHOST_SETTINGS.interval_s, spacingEnabled = DEFAULT_GHOST_SETTINGS.spacingEnabled } = {}) {
  const budgets = sources.map(() => 0);
  const eligible = sources.map((source, index) => {
    if (!source.times?.length) return -1;
    if (spacingEnabled) return onionKeyframes(source.times, { range: source.range, interval_s, maxCount: 1 }).times.length ? index : -1;
    const start = Number.isFinite(source.range?.[0]) ? source.range[0] : source.times[0];
    const end = Number.isFinite(source.range?.[1]) ? source.range[1] : source.times.at(-1);
    return Math.max(start, source.times[0]) <= Math.min(end, source.times.at(-1)) ? index : -1;
  }).filter(index => index >= 0);
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

export function onionOpacity(time, cursor, range, { opacityStart = ONION_MAX_OPACITY, opacityEnd = ONION_MIN_OPACITY, hideCursor = true } = {}) {
  if (hideCursor && Math.abs(time - cursor) <= ONION_CURSOR_HIDE_S) return 0;
  const start = range?.[0] ?? 0, end = range?.[1] ?? start, span = end - start;
  const fraction = span > 0 ? Math.max(0, Math.min(1, (time - start) / span)) : 0;
  return opacityStart + (opacityEnd - opacityStart) * fraction;
}

export function visibleOnionKeyframes(keyframes, cursor, reveal) {
  return reveal ? keyframes.filter(keyframe => (typeof keyframe === 'number' ? keyframe : keyframe.time) <= cursor) : keyframes;
}
