export const ONION_MIN_OPACITY = .12;
export const ONION_MAX_OPACITY = .4;
export const ONION_CURSOR_HIDE_S = .005;

const niceMultipliers = [1, 2, 5];

function gridBounds(start, end, step) {
  const first = start / step, last = end / step;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(first), Math.abs(last)) * 4;
  return [Math.ceil(first - tolerance), Math.floor(last + tolerance)];
}

function chooseStep(start, end, maxCount) {
  // Start below the possible spacing, then check actual absolute multiples:
  // merely dividing the duration by the count misses a tick at a range edge.
  const power = Math.floor(Math.log10((end - start) / (maxCount + 1)));
  for (let exponent = power; ; exponent++) {
    for (const multiplier of niceMultipliers) {
      const step = multiplier * 10 ** exponent;
      if (!(step > 0)) continue;
      const [first, last] = gridBounds(start, end, step);
      if (last - first + 1 <= maxCount) return step;
    }
  }
}

/** Round absolute keyframe times for an ascending recorded timestamp array.
 * maxCount counts grid points; the final recorded time may add one more.
 * During Live growth a previous step survives up to twice that grid count.
 */
export function onionKeyframes(times, { maxCount = 8, previousStep } = {}) {
  if (!times?.length) return { step: null, times: [] };
  const start = times[0], end = times[times.length - 1];
  const retainedStep = Number.isFinite(previousStep) && previousStep > 0 ? previousStep : null;
  if (!(end > start)) return { step: retainedStep, times: [end] };
  maxCount = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 8;
  let step = retainedStep;
  if (step) {
    const [first, last] = gridBounds(start, end, step);
    // Grow to the next sufficient nice step rather than restarting at the
    // initial eight-point density. A large incoming batch may skip steps.
    if (last - first + 1 > maxCount * 2) step = chooseStep(start, end, maxCount * 2);
  }
  step ??= chooseStep(start, end, maxCount);
  const [first, last] = gridBounds(start, end, step), keyframes = [];
  for (let i = first; i <= last; i++) {
    // Remove multiplication noise, while retaining absolute rather than
    // range-relative grid alignment. Clamp roundoff at recorded boundaries.
    const time = Math.max(start, Math.min(end, Number((i * step).toPrecision(15))));
    if (end - time >= step / 4) keyframes.push(time);
  }
  keyframes.push(end);
  return { step, times: keyframes };
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

/** range is [start, end], or its duration in seconds. */
export function onionOpacity(time, cursor, range) {
  const distance = Math.abs(time - cursor);
  if (distance <= ONION_CURSOR_HIDE_S) return 0;
  const span = typeof range === 'number' ? range : range[1] - range[0];
  const fraction = span > 0 ? Math.min(1, distance / span) : 1;
  return ONION_MAX_OPACITY - fraction * (ONION_MAX_OPACITY - ONION_MIN_OPACITY);
}

/** Reveal accepts numeric times or keyframe records with a snapped time. */
export function visibleOnionKeyframes(keyframes, cursor, reveal) {
  return reveal ? keyframes.filter(keyframe => (typeof keyframe === 'number' ? keyframe : keyframe.time) <= cursor) : keyframes;
}
