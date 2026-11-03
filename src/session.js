// Presentation only: recorded times, native states and settings stay untouched.
export const TRACK_PALETTE = Object.freeze([0xb48cff, 0x6fa8ff, 0x6fdc8c, 0xff7eb6, 0xc8a27a]);
export const TRACK_OPACITY = .35;
export const TRACK_OUTSIDE_OPACITY = .15;

const finiteSpan = span => Array.isArray(span) && span.length === 2 && span.every(Number.isFinite) && span[1] >= span[0];
const offsetOf = track => track.kind === 'live' ? 0 : track.offset_s || 0;

export function sessionSpan(value) {
  const tracks = Array.isArray(value) ? value : value.activeTracks || value.tracks;
  const spans = tracks.filter(track => (track.kind === 'live' || track.visible !== false) && finiteSpan(track.span) && !track.empty)
    .map(track => track.span.map(time => time + offsetOf(track)));
  return spans.length ? [Math.min(...spans.map(span => span[0])), Math.max(...spans.map(span => span[1]))] : [0, 0];
}

export function trackTime(track, sessionTime) { return sessionTime - offsetOf(track); }
export function outsideSpan(track, sessionTime) {
  const time = trackTime(track, sessionTime);
  return !finiteSpan(track.span) || track.empty || time < track.span[0] - 1e-9 || time > track.span[1] + 1e-9;
}

export function defaultOffset(track, main) {
  if (track.kind === 'live' || track.defaultOffset === 'zero' || track.source?.source === 'freeze' || track.catalogSource === 'freeze') return 0;
  const start = finiteSpan(main?.span) && !main.empty ? main.span[0] : 0;
  return start - (finiteSpan(track.span) ? track.span[0] : 0);
}

// Snap either clip edge to session targets. Threshold is the timeline's six
// pixels converted to seconds, so zoom never changes its screen-space reach.
export function snapOffset(offset, candidates, secondsPerPixel, { alt = false, span = [0, 0], pixels = 6 } = {}) {
  if (alt || !Number.isFinite(secondsPerPixel) || secondsPerPixel <= 0) return offset;
  let result = offset, distance = pixels * secondsPerPixel;
  for (const candidate of candidates) for (const edge of span) {
    const target = candidate - edge, delta = Math.abs(target - offset);
    if (delta <= distance) { result = target; distance = delta; }
  }
  return result;
}

function settingsValue(value) {
  const context = value?.context || value?.segment?.context;
  const settings = context?.settings || value?.settings || value?.provenance?.live?.settings || value?.motion?.provenance?.live?.settings;
  if (settings) return { value: settings, partial: false };
  const params = value?.provenance?.params || value?.motion?.provenance?.params;
  if (params) return { value: { config: params }, partial: true };
  return { value: value?.config || value?.task || value?.execution ? value : {}, partial: false };
}
function flatten(value, prefix = '', result = {}) {
  for (const [key, item] of Object.entries(value || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item && !Array.isArray(item) && typeof item === 'object' && Object.keys(item).length) flatten(item, path, result);
    else result[path] = item;
  }
  return result;
}
const displayValue = value => value === undefined ? 'unavailable' : value === null ? 'none' : typeof value === 'object' ? JSON.stringify(value) : String(value);

export function settingsDiff(main, other) {
  const first = settingsValue(main), second = settingsValue(other), a = flatten(first.value), b = flatten(second.value);
  // Experiment params describe only the predictor, never omitted Live groups.
  const keys = second.partial ? Object.keys(b) : [...new Set([...Object.keys(a), ...Object.keys(b)])];
  if (!Object.keys(a).length || !Object.keys(b).length) return [];
  return keys.sort().filter(path => JSON.stringify(a[path]) !== JSON.stringify(b[path])).map(path => {
    const text = `${path.split('.').at(-1)}: ${displayValue(b[path])}`;
    return { path, main: a[path], other: b[path], value: b[path], label: text, text };
  });
}

function letter(index) {
  let result = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
}

let sessionSequence = 0;
export function createSession() {
  const main = { id: 'live', kind: 'live', source: { kind: 'live', generation: null }, letter: 'A', label: 'Live', displayName: 'Live', color: 0xffffff,
    offset_s: 0, defaultOffset: 'zero', visible: true, display: 'arm', span: [0, 0], empty: true, timeBasis: 'simulation', settings: null };
  const tracks = [main], listeners = new Set();
  let cursor = 0, rate = 1, aggregate = { start: null, end: null }, nextTrack = 1, revision = 0, replayOnly = false;
  const notify = () => { revision++; for (const listener of listeners) listener(session); };
  const getTrack = id => tracks.find(track => track.id === id);
  const comparisons = () => {
    for (const track of tracks.slice(1)) {
      track.differences = settingsDiff(main, track);
      track.badges = [
        main.endEffectorFrame && track.endEffectorFrame && main.endEffectorFrame !== track.endEffectorFrame ? { label: 'Frame', title: `End-effector frame ${track.endEffectorFrame} differs from Live ${main.endEffectorFrame}; tool paths are not comparable.` } : null,
        track.timeBasis === 'wall' ? { label: 'Wall', title: 'Recorded wall time differs from Live simulation time.' } : null,
        track.motion?.model_warning ? { label: 'Model', title: typeof track.motion.model_warning === 'string' ? track.motion.model_warning : JSON.stringify(track.motion.model_warning) } : null,
      ].filter(Boolean);
    }
  };
  const session = {
    id: `session-${++sessionSequence}`, timeBasis: 'simulation', tracks,
    get focusedId() { return main.id; }, get focused() { return main; },
    get replayOnly() { return replayOnly; },
    get activeTracks() { return replayOnly ? tracks.filter(track => track.kind !== 'live') : tracks; },
    get span() { return sessionSpan(session.activeTracks); }, get cursor() { return cursor; }, get rate() { return rate; },
    get aggregate() { return { ...aggregate }; }, get revision() { return revision; },
    track: getTrack,
    setReplayOnly(value) { const next = Boolean(value); if (replayOnly !== next) { replayOnly = next; notify(); } },
    updateMain(fields) {
      const compare = fields.context !== main.context || fields.settings !== main.settings || fields.endEffectorFrame !== main.endEffectorFrame;
      const changed = compare || fields.empty !== main.empty || fields.span?.[0] !== main.span?.[0] || fields.span?.[1] !== main.span?.[1] || fields.source?.generation !== main.source?.generation;
      Object.assign(main, fields, { id: 'live', kind: 'live', displayName: 'Live', offset_s: 0, defaultOffset: 'zero' });
      if (compare) comparisons(); if (changed) notify(); return main;
    },
    addTrack(input) {
      const motion = input.motion || {}, catalogSource = input.catalogSource || input.item?.source;
      const index = nextTrack++;
      const track = { ...input, id: input.trackId || `track-${index}`, kind: 'replay', source: input.source || { kind: 'replay', id: motion.id || input.id, revision: motion.revision || input.revision },
        motion, letter: letter(index), defaultName: letter(index - 1), displayName: String(input.displayName || '').trim() || letter(index - 1), label: input.label || motion.label || input.item?.name || 'Replay', color: input.color ?? TRACK_PALETTE[(index - 1) % TRACK_PALETTE.length],
        catalogSource, defaultOffset: input.defaultOffset || (catalogSource === 'freeze' ? 'zero' : 'align-start'),
        visible: input.visible !== false, display: input.display === 'dot' ? 'dot' : 'arm',
        span: input.span || [motion.time_s?.[0] ?? 0, motion.time_s?.at(-1) ?? 0],
        timeBasis: input.timeBasis || motion.time_basis, endEffectorFrame: input.endEffectorFrame || motion.end_effector_frame,
        settings: input.settings || motion.provenance?.live?.settings || null };
      if (!finiteSpan(track.span)) throw new Error('A track needs a finite recorded time span.');
      track.offset_s = input.offset_s ?? defaultOffset(track, main);
      if (!Number.isFinite(track.offset_s)) throw new Error('Track offset must be finite.');
      if (getTrack(track.id)) throw new Error('Track id already exists.');
      tracks.push(track); comparisons(); notify(); return track;
    },
    removeTrack(id) { const index = tracks.findIndex(track => track.id === id); if (index < 1) return false; tracks.splice(index, 1); notify(); return true; },
    setName(id, value) { const track = getTrack(id); if (!track || track.kind === 'live') return false; const name = String(value ?? '').trim() || track.defaultName; if (track.displayName !== name) { track.displayName = name; notify(); } return true; },
    setOffset(id, value) {
      const track = getTrack(id); if (!track || track.kind === 'live') return false;
      if (!Number.isFinite(value)) throw new Error('Track offset must be finite.');
      track.offset_s = value; notify(); return true;
    },
    resetOffset(id) { const track = getTrack(id); return track ? session.setOffset(id, defaultOffset(track, main)) : false; },
    setVisible(id, value) { const track = getTrack(id); if (!track) return false; track.visible = Boolean(value); notify(); return true; },
    setDisplay(id, value) { const track = getTrack(id); if (!track || !(track.kind === 'live' ? ['arm', 'hidden'] : ['arm', 'dot']).includes(value)) return false; track.display = value; notify(); return true; },
    setCursor(value) { if (value != null && !Number.isFinite(value)) throw new Error('Session time must be finite.'); if (cursor !== value) { cursor = value; notify(); } },
    setRate(value) { if (!Number.isFinite(value) || value <= 0) throw new Error('Playback rate must be positive.'); if (rate !== value) { rate = value; notify(); } },
    setAggregate(value) { aggregate = { start: value?.start ?? null, end: value?.end ?? null }; notify(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return session;
}
