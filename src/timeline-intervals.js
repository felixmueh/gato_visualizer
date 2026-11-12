import { intervalSeverity } from './live-execution.js';

const valid = item => Number.isFinite(item.start_time_s) && Number.isFinite(item.end_time_s) && item.end_time_s > item.start_time_s;
const entry = item => ({ start: item.start_time_s, end: item.end_time_s, severity: intervalSeverity(item), item });
const append = (index, value) => index.push({ ...value, maxEnd: Math.max(index.at(-1)?.maxEnd ?? -Infinity, value.end) });
const firstEndingAfter = (index, time) => {
  let lo = 0, hi = index.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (index[mid].maxEnd <= time) lo = mid + 1; else hi = mid; }
  return lo;
};

// Prefix maxima also support overlapping and out-of-order imported intervals.
export function indexTimelineIntervals(intervals = []) {
  const result = [];
  for (const value of intervals.filter(valid).map(entry).sort((a, b) => a.start - b.start)) append(result, value);
  return result;
}
export function visibleTimelineIntervals(index, [start, end]) {
  const result = [];
  for (let i = firstEndingAfter(index, start); i < index.length && index[i].start < end; i++) if (index[i].end > start) result.push(index[i]);
  return result;
}

// Native records are immutable and append in time order. Index only the new tail;
// a replaced/truncated source or an out-of-order append rebuilds the same exact index.
export function createTimelineIntervalIndex() {
  let source = null, count = 0, last = null, entries = [], bySeverity;
  const resetSeverities = () => { bySeverity = { normal: [], yellow: [], red: [] }; };
  resetSeverities();
  const add = value => { append(entries, value); append(bySeverity[value.severity], value); };
  const api = {
    update(items = []) {
      if (items !== source || items.length < count || (count && items[count - 1] !== last)) {
        source = items; count = 0; entries = []; resetSeverities();
      }
      let ordered = true;
      for (let i = count; i < items.length; i++) {
        if (!valid(items[i])) continue;
        const value = entry(items[i]);
        if (value.start < (entries.at(-1)?.start ?? -Infinity)) { ordered = false; break; }
        add(value);
      }
      if (!ordered) {
        entries = indexTimelineIntervals(items); resetSeverities();
        for (const value of entries) append(bySeverity[value.severity], value);
      }
      count = items.length; last = items.at(-1);
      return api;
    },
    at(time) {
      for (let i = firstEndingAfter(entries, time); i < entries.length && entries[i].start <= time; i++) {
        if (entries[i].end > time) return entries[i].item;
      }
      return null;
    },
    // Display-only pixel bands. A red or yellow interval remains visible even when
    // shorter than a pixel; raw records and exact hover statistics stay untouched.
    bands([start, end], pixels, { normal = false } = {}) {
      if (!(end > start)) return [];
      const width = Math.max(1, Math.min(4096, Math.ceil(pixels) || 1)), result = [];
      const severities = normal ? ['red', 'yellow', 'normal'] : ['red', 'yellow'];
      for (let pixel = 0; pixel < width; pixel++) {
        const left = start + pixel / width * (end - start), right = start + (pixel + 1) / width * (end - start);
        const severity = severities.find(name => {
          const list = bySeverity[name], item = list[firstEndingAfter(list, left)];
          return item && item.start < right;
        });
        if (!severity) continue;
        const previous = result.at(-1);
        if (previous?.severity === severity && previous.end === pixel) previous.end++;
        else result.push({ start: pixel, end: pixel + 1, severity });
      }
      return result.map(value => ({ ...value, start: start + value.start / width * (end - start), end: start + value.end / width * (end - start) }));
    },
    get entries() { return entries; },
  };
  return api;
}
