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

function gridBounds(start, end, step) {
  const first = start / step, last = end / step;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(first), Math.abs(last)) * 4;
  return [Math.ceil(first - tolerance), Math.floor(last + tolerance)];
}

/** Absolute grids cover the full recording. Widen the requested spacing by
 * integer multiples to respect the strict cap, including the final endpoint. */
export function onionKeyframes(times, { maxCount = DEFAULT_GHOST_SETTINGS.maxCount, interval_s = DEFAULT_GHOST_SETTINGS.interval_s, previousStep } = {}) {
  if (!times?.length) return { step: null, times: [] };
  const start = times[0], end = times[times.length - 1];
  maxCount = Number.isInteger(maxCount) ? Math.max(1, Math.min(64, maxCount)) : DEFAULT_GHOST_SETTINGS.maxCount;
  interval_s = Number.isFinite(interval_s) && interval_s > 0 ? interval_s : DEFAULT_GHOST_SETTINGS.interval_s;
  let step = interval_s;
  if (maxCount === 1 || !(end > start)) return { step, times: [end] };
  step *= Math.max(1, Math.ceil((end - start) / ((maxCount - 1) * interval_s)));
  if (Number.isFinite(previousStep) && previousStep >= step) step = previousStep;
  for (;;) {
    const [first, last] = gridBounds(start, end, step), keyframes = [];
    for (let i = first; i <= last; i++) {
      const time = Math.max(start, Math.min(end, Number((i * step).toPrecision(15))));
      if (end - time >= step / 4) keyframes.push(time);
    }
    keyframes.push(end);
    if (keyframes.length <= maxCount) return { step, times: keyframes };
    step += interval_s;
  }
}

/** Divide one strict temporal-ghost budget across nonempty recorded sources. */
export function onionBudgets(sources, maxCount) {
  const budgets = sources.map(() => 0);
  const eligible = sources.map((source, index) => source.times?.length ? index : -1).filter(index => index >= 0);
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
