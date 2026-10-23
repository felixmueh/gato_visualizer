import { intervalDescription, intervalSeverity } from './live-execution.js';
import { snapOffset } from './session.js';
import { createFloatingDialog } from './floating-dialog.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export function timelineTypingTarget(target) {
  return Boolean(target?.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName));
}
export function timelineBounds(bounds) {
  const start = Number.isFinite(bounds?.[0]) ? bounds[0] : 0;
  return [start, Math.max(start, Number.isFinite(bounds?.[1]) ? bounds[1] : start)];
}
export function clampTimelineWindow(window, bounds) {
  const [start, end] = timelineBounds(bounds), total = end - start;
  if (!total) return [start, end];
  const span = clamp(window[1] - window[0], Math.min(.001, total), total);
  const left = clamp(window[0], start, end - span);
  return [left, left + span];
}
export function zoomTimeline(window, bounds, factor, fraction = .5) {
  fraction = clamp(fraction, 0, 1);
  const span = window[1] - window[0];
  const next = clamp(span * factor, Math.min(.001, bounds[1] - bounds[0]), bounds[1] - bounds[0]);
  const anchor = window[0] + span * clamp(fraction, 0, 1);
  return clampTimelineWindow([anchor - next * fraction, anchor + next * (1 - fraction)], bounds);
}
export function timelineTicks(window, width) {
  const span = window[1] - window[0];
  if (!(span > 0) || !(width > 0)) return [];
  const desired = span / Math.max(1, Math.floor(width / 95));
  const power = 10 ** Math.floor(Math.log10(desired));
  const step = [1, 2, 5, 10].find(value => value * power >= desired) * power;
  const decimals = Math.min(6, Math.max(0, -Math.floor(Math.log10(step))));
  const ticks = [];
  for (let i = Math.ceil(window[0] / step); i * step <= window[1] + step * 1e-8; i++) {
    const time = i * step;
    ticks.push({ time, fraction: (time - window[0]) / span, label: `${time.toFixed(decimals)} s` });
  }
  return ticks;
}

// Aggregate window: a bound of null is unbounded. An unbounded end follows
// the history tip, so aggregates grow with Live data; an unbounded start
// begins at the first retained sample. The playback cursor is independent.
export const UNBOUNDED_AGGREGATE = Object.freeze({ start: null, end: null });
export const aggregateBounded = aggregate => Number.isFinite(aggregate?.start) || Number.isFinite(aggregate?.end);
export function aggregateSpan(aggregate, bounds) {
  const [low, high] = timelineBounds(bounds);
  const start = Number.isFinite(aggregate?.start) ? clamp(aggregate.start, low, high) : low;
  return [start, Number.isFinite(aggregate?.end) ? clamp(aggregate.end, start, high) : high];
}
// Moving a bound onto (or past) its outer data edge, within snap seconds,
// makes it unbounded. A bound never crosses the opposite one.
export function moveAggregateBound(aggregate, side, time, bounds, snap = 0) {
  const [low, high] = timelineBounds(bounds), next = { start: aggregate?.start ?? null, end: aggregate?.end ?? null };
  if (side === 'start') next.start = time <= low + snap ? null : Math.min(time, Number.isFinite(next.end) ? next.end : high);
  else next.end = time >= high - snap ? null : Math.max(time, Number.isFinite(next.start) ? next.start : low);
  return next;
}
export function aggregateLabel(aggregate, digits = 3) {
  if (!aggregateBounded(aggregate)) return 'Entire episode';
  const time = value => `${value.toFixed(digits)} s`;
  return `${Number.isFinite(aggregate.start) ? time(aggregate.start) : 'start'} → ${Number.isFinite(aggregate.end) ? time(aggregate.end) : 'latest'}`;
}

// Parse only on interval revision. Prefix maxima allow visible-range lookup
// even when intervals overlap or arrive in a different order.
export function indexTimelineIntervals(intervals = []) {
  let maxEnd = -Infinity;
  return intervals.filter(item => Number.isFinite(item.start_time_s) && Number.isFinite(item.end_time_s) && item.end_time_s > item.start_time_s)
    .map(item => ({ start: item.start_time_s, end: item.end_time_s, severity: intervalSeverity(item), item }))
    .sort((a, b) => a.start - b.start)
    .map(entry => ({ ...entry, maxEnd: maxEnd = Math.max(maxEnd, entry.end) }));
}
export function visibleTimelineIntervals(index, [start, end]) {
  let lo = 0, hi = index.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (index[mid].maxEnd <= start) lo = mid + 1; else hi = mid; }
  const result = [];
  for (let i = lo; i < index.length && index[i].start < end; i++) if (index[i].end > start) result.push(index[i]);
  return result;
}

// Compact isometric projection of actual recorded EE positions. The preview
// owns display coordinates only, and keeps both endpoints when subsampling.
export function trackPreviewGeometry(points = [], maxPoints = 384) {
  if (!points.length) return { path: '', start: null, end: null };
  const count = Math.min(points.length, maxPoints), projected = [];
  for (let i = 0; i < count; i++) {
    const point = points[count === 1 ? 0 : Math.round(i * (points.length - 1) / (count - 1))];
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) throw new Error('Recorded path contains invalid positions.');
    projected.push([(point[0] - point[1]) * .866025403784, .5 * (point[0] + point[1]) - point[2]]);
  }
  const xs = projected.map(point => point[0]), ys = projected.map(point => point[1]);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  const scale = Math.min(292 / (right - left || 1), 66 / (bottom - top || 1));
  const fitted = projected.map(([x, y]) => [160 + (x - (left + right) / 2) * scale, 45 + (y - (top + bottom) / 2) * scale]);
  return { path: fitted.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' '), start: fitted[0], end: fitted.at(-1) };
}

// Gestures are discoverable on hover (surface and the footer's ?), not as permanent text.
const GESTURE_HINT = 'Scroll to zoom; Alt-drag, middle-drag or horizontal scroll to pan; drag to scrub. Shift-drag selects an aggregate window; drag its edge handles to adjust, onto the data end for unbounded; Esc clears it. Arrow keys seek, Shift+arrows seek 1 ms, +/− zoom, 0 fits.';
const KEYFRAME_TICK_TOP = 23, KEYFRAME_TICK_BOTTOM = 34, KEYFRAME_HIT_RADIUS = 4;

export function expandedTimelineShell() {
  return `<section id="expanded-timeline" class="expanded-timeline" aria-label="Timeline inspection" hidden>
    <div id="timeline-strip-resize" class="timeline-strip-resize" role="separator" aria-orientation="horizontal" aria-label="Resize timeline plots" hidden></div>
    <div class="timeline-inspection-heading"><span id="timeline-clock-label">Recorded time</span><span id="timeline-timing-note">No timing data</span><div class="timeline-track-picker" id="timeline-track-picker" hidden><button id="timeline-add-track" aria-haspopup="dialog" aria-expanded="false" aria-controls="track-catalog">+ Add track</button><div id="timeline-track-menu" class="track-catalog" hidden></div></div><div class="timeline-zoom-controls"><button id="timeline-window-clear" class="timeline-window-clear" aria-label="Clear aggregate window" title="Clear aggregate window (Esc)" hidden><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.1 7a6.6 6.6 0 1 1-.5 5M4 3.5V7h3.5"/></svg></button><button id="timeline-zoom-out" aria-label="Zoom timeline out" title="Zoom out (−)">−</button><button id="timeline-zoom-in" aria-label="Zoom timeline in" title="Zoom in (+)">+</button><button id="timeline-fit" title="Fit entire recording (0)">Fit</button></div></div>
    <p id="timeline-track-message" class="timeline-track-message" role="status" hidden></p>
    <div id="timeline-linked-graphs"></div>
    <div id="timeline-surface-stack" class="timeline-surface-stack">
      <div id="timeline-inspector" class="timeline-inspector" role="slider" tabindex="0" aria-label="Inspect simulation time" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-describedby="timeline-gesture-hint"><canvas id="timeline-bands" aria-hidden="true"></canvas><div id="timeline-playhead" class="timeline-playhead" aria-hidden="true"><span></span></div></div>
      <div id="timeline-lanes" class="timeline-lanes" aria-label="Session tracks" hidden></div>
      <div id="timeline-aggregate-overlay" class="timeline-aggregate-overlay"><div id="timeline-window-shade-start" class="timeline-window-shade" aria-hidden="true"></div><div id="timeline-window-shade-end" class="timeline-window-shade" aria-hidden="true"></div><div id="timeline-window-start" class="timeline-window-handle" data-side="start" role="slider" tabindex="-1" aria-label="Aggregate window start"></div><div id="timeline-window-end" class="timeline-window-handle" data-side="end" role="slider" tabindex="-1" aria-label="Aggregate window end"></div></div>
    </div>
    <div class="timeline-inspection-footer"><span id="timeline-gesture-hint" class="timeline-gesture-help" title="${GESTURE_HINT}"><span aria-hidden="true">?</span><span class="sr-only">${GESTURE_HINT}</span></span><span id="timeline-selection">0.000 s</span></div>
    <div id="timeline-inspection-tooltip" class="timeline-inspection-tooltip" role="tooltip" hidden></div>
  </section>`;
}

export function setupExpandedTimeline({ document: doc = document, onSeek, onLayout = () => {}, onAggregate = () => {}, onAddTrack = () => {}, onTrackChange = () => {}, onTrackReset = () => {}, onTrackRemove = () => {}, onFreeze = () => {}, onUploadTracks, requestMotion = async id => { const response = await fetch(`/api/replays/motion?id=${encodeURIComponent(id)}`); const motion = await response.json(); if (!response.ok) throw new Error(motion.error || `HTTP ${response.status}`); return motion; }, dialogFactory = createFloatingDialog }) {
  const $ = id => doc.getElementById(id), panel = $('expanded-timeline'), surface = $('timeline-inspector');
  const canvas = $('timeline-bands'), playhead = $('timeline-playhead'), tooltip = $('timeline-inspection-tooltip');
  const toggles = ['live-timeline-expand', 'replay-timeline-expand'].map($);
  let expanded = false, identity, bounds = [0, 0], window = [0, 0], selected = 0, fitted = true;
  let source, sourceCount = -1, revision, index = [], paintKey = '', width = 0, paints = 0, drag = null, mode = 'replay';
  let keyframes = [], keyframeSource, keyframeRevision;
  let aggregate = { ...UNBOUNDED_AGGREGATE };
  let freezeAvailable = false;
  let tracks = [], catalog = [], breaches = [], laneKey = '', catalogKey = '', lanePaints = 0, laneDrag = null;
  const lanes = $('timeline-lanes'), picker = $('timeline-track-picker'), addTrack = $('timeline-add-track'), menu = $('timeline-track-menu');
  const laneNodes = new Map(), workspaces = new Map();
  const colorText = color => typeof color === 'number' ? `#${color.toString(16).padStart(6, '0')}` : color || '#ffffff';
  const offsetText = offset => `${offset >= 0 ? '+' : ''}${offset.toFixed(3)}`;
  const diffText = diff => typeof diff === 'string' ? diff : diff.text || diff.label || `${diff.path}: ${JSON.stringify(diff.other)}`;
  const element = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
  const search = element('input', 'track-catalog-search'); search.type = 'search'; search.placeholder = 'Search tracks'; search.setAttribute('aria-label', 'Search track catalog');
  const toolbar = element('div', 'track-catalog-toolbar'), list = element('div', 'track-catalog-list');
  toolbar.append(search);
  if (onUploadTracks) for (const [kind, label] of [['files', 'Upload .npz'], ['folder', 'Upload folder']]) {
    const upload = element('button', 'track-catalog-upload', label); upload.type = 'button'; upload.addEventListener('click', () => onUploadTracks(kind)); toolbar.append(upload);
  }
  menu.replaceChildren(toolbar, list);
  let catalogDialog;
  const previewCache = new Map();
  let activePreview, queuedPreview, previewTimer, catalogVersion = 0;
  const previewKey = item => JSON.stringify([item.id, item.revision || '', item.modified_ns || '', item.size || '']);
  function closedCatalog() { menu.hidden = true; clearTimeout(previewTimer); queuedPreview?.resolve(null); queuedPreview = null; addTrack.setAttribute('aria-expanded', 'false'); }
  function closeMenu() { catalogDialog?.close(); closedCatalog(); }
  function openMenu() {
    if (!catalogDialog) catalogDialog = dialogFactory({ id: 'track-catalog', title: 'Add track', content: menu, onClose: closedCatalog });
    search.value = ''; menu.hidden = false; catalogDialog.open(); addTrack.setAttribute('aria-expanded', 'true'); renderCatalog(); search.focus();
  }
  addTrack.addEventListener('click', () => { if (catalogDialog?.isOpen) closeMenu(); else openMenu(); });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape' && catalogDialog?.isOpen) closeMenu(); });
  search.addEventListener('input', renderCatalog);
  function paintPreview(node, preview) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 320 90'); svg.setAttribute('aria-hidden', 'true');
    if (preview.geometry.path) {
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', preview.geometry.path); svg.append(path);
      for (const [point, role] of [[preview.geometry.start, 'start'], [preview.geometry.end, 'end']]) {
        const dot = doc.createElementNS('http://www.w3.org/2000/svg', 'circle'); dot.setAttribute('cx', point[0]); dot.setAttribute('cy', point[1]); dot.setAttribute('r', '2.5'); dot.setAttribute('class', `track-preview-${role}`); svg.append(dot);
      }
    }
    node.replaceChildren(svg); node.setAttribute('aria-busy', 'false'); node.setAttribute('aria-label', `Recorded tool path · ${preview.summary}`); node.title = preview.title;
  }
  // At most one motion read and one latest waiting request. Store only the
  // small SVG summary, never a recording's large q/time/EE arrays.
  function requestPreview(item) {
    const key = previewKey(item), cached = previewCache.get(key);
    if (cached) return Promise.resolve(cached);
    if (activePreview?.key === key) return activePreview.promise;
    if (queuedPreview?.key === key) return queuedPreview.promise;
    const job = { key, item };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    if (activePreview) { queuedPreview?.resolve(null); queuedPreview = job; }
    else startPreview(job);
    return job.promise;
  }
  function startPreview(job) {
    activePreview = job;
    Promise.resolve().then(() => requestMotion(job.item.id, job.item)).then(motion => {
      const times = motion.time_s || [], duration = times.length ? times.at(-1) - times[0] : 0;
      const summary = `${Number(duration.toPrecision(4))} s · ${times.length} states · ${motion.time_basis || 'recorded'}`;
      const preview = { geometry: trackPreviewGeometry(motion.ee_xyz), summary, title: `Recorded end-effector path${motion.end_effector_frame ? ` · ${motion.end_effector_frame}` : ''}` };
      previewCache.set(job.key, preview); while (previewCache.size > 8) previewCache.delete(previewCache.keys().next().value);
      job.resolve(preview);
    }).catch(error => job.reject(error)).finally(() => {
      activePreview = null;
      const next = queuedPreview; queuedPreview = null; if (next) startPreview(next);
    });
  }
  async function loadPreview(item, node, detail) {
    if (menu.hidden) return;
    const version = catalogVersion, alive = () => !menu.hidden && catalogVersion === version;
    node.setAttribute('aria-busy', 'true');
    try {
      const preview = await requestPreview(item);
      if (alive()) { if (preview) { paintPreview(node, preview); detail.textContent = preview.summary; } else node.setAttribute('aria-busy', 'false'); }
    } catch (error) {
      if (alive()) { node.replaceChildren(element('span', 'track-catalog-preview-error', 'Preview unavailable')); node.title = error.message; node.setAttribute('aria-busy', 'false'); }
    }
  }
  function renderCatalog() {
    catalogVersion++; clearTimeout(previewTimer); queuedPreview?.resolve(null); queuedPreview = null; list.replaceChildren();
    const query = search.value.trim().toLowerCase(), items = catalog.filter(item => item.status === 'ready' && item.source !== 'default')
      .filter(item => `${item.name || ''} ${item.label || ''} ${item.path || ''} ${item.source || ''}`.toLowerCase().includes(query));
    let firstPreview;
    for (const [title, entries] of [['Temporary', items.filter(item => item.source === 'freeze')], ['Library', items.filter(item => !['freeze', 'upload'].includes(item.source))], ['Uploads', items.filter(item => item.source === 'upload')]]) {
      if (!entries.length) continue;
      const group = element('section', 'track-catalog-group'), heading = element('h3', 'track-catalog-group-heading', title); group.append(heading);
      for (const item of entries) {
        const row = element('section', 'track-catalog-item'), header = element('header'), name = element('strong', '', item.label || item.name), add = element('button', 'track-catalog-add', 'Add');
        row.dataset.id = item.id; name.title = item.path || item.name || ''; add.type = 'button'; add.setAttribute('aria-label', `Add ${item.label || item.name}`);
        add.addEventListener('click', () => { onAddTrack(item.id); }); header.append(name, add);
        const preview = element('div', 'track-catalog-preview'), detail = element('p', 'track-catalog-detail'); preview.setAttribute('role', 'img'); preview.setAttribute('aria-label', 'Recorded tool path preview'); preview.title = 'Preview recorded tool path';
        const cached = previewCache.get(previewKey(item)); if (cached) { paintPreview(preview, cached); detail.textContent = cached.summary; }
        row.append(header, preview, detail);
        row.addEventListener('pointerenter', () => { clearTimeout(previewTimer); previewTimer = setTimeout(() => loadPreview(item, preview, detail), 120); });
        row.addEventListener('pointerleave', () => clearTimeout(previewTimer));
        row.addEventListener('focusin', () => { clearTimeout(previewTimer); return loadPreview(item, preview, detail); });
        group.append(row); firstPreview ||= () => loadPreview(item, preview, detail);
      }
      list.append(group);
    }
    if (!items.length) list.append(element('p', 'track-catalog-empty', query ? 'No matching tracks.' : 'No recordings yet.'));
    if (catalogDialog?.isOpen) firstPreview?.();
  }
  function paintCatalog() {
    const key = JSON.stringify(catalog.map(item => [item.id, item.name, item.label, item.source, item.status, item.revision]));
    if (key === catalogKey) return;
    catalogKey = key; addTrack.disabled = false; renderCatalog();
  }
  function buildLane(track) {
    const row = doc.createElement('div'); row.className = 'timeline-lane'; row.dataset.trackId = track.id;
    const header = doc.createElement('div'); header.className = 'timeline-lane-header';
    const chip = doc.createElement('span'); chip.className = 'timeline-lane-chip';
    const label = doc.createElement(track.kind === 'live' ? 'span' : 'input'); label.className = 'timeline-lane-label';
    if (track.kind !== 'live') { label.type = 'text'; label.setAttribute('aria-label', 'Track name'); label.classList.toggle('timeline-lane-name', true); }
    const information = doc.createElement('div'); information.className = 'timeline-lane-information';
    const badges = doc.createElement('span'); badges.className = 'timeline-lane-badges';
    const differences = doc.createElement('span'); differences.className = 'timeline-lane-differences';
    const offset = doc.createElement('input'); offset.type = 'text'; offset.className = 'timeline-lane-offset'; offset.setAttribute('inputmode', 'decimal');
    offset.setAttribute('aria-label', `Track ${track.letter || track.id} offset in seconds`);
    const unit = doc.createElement('span'); unit.className = 'timeline-lane-offset-unit'; unit.textContent = 's';
    const eye = doc.createElement('button'); eye.type = 'button'; eye.className = 'timeline-lane-visibility';
    const display = doc.createElement('button'); display.type = 'button'; display.className = 'timeline-lane-display';
    const remove = doc.createElement('button'); remove.type = 'button'; remove.className = 'timeline-lane-remove'; remove.textContent = '×';
    const freeze = doc.createElement('button'); freeze.type = 'button'; freeze.className = 'timeline-lane-freeze'; freeze.title = 'Freeze for comparison'; freeze.setAttribute('aria-label', 'Freeze for comparison');
    freeze.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="12" height="12" rx="2"/><path d="M8 20h10a2 2 0 0 0 2-2V8M10 7v6M7 10h6"/></svg>';
    const action = doc.createElement('div'); action.className = 'timeline-lane-action'; action.append(freeze, remove);
    const rail = doc.createElement('div'); rail.className = 'timeline-lane-rail';
    const clip = doc.createElement('div'); clip.className = 'timeline-lane-clip'; clip.tabIndex = track.kind === 'live' ? -1 : 0;
    const bands = doc.createElement('canvas'); bands.className = 'timeline-lane-bands'; bands.setAttribute('aria-hidden', 'true');
    const cursor = doc.createElement('div'); cursor.className = 'timeline-lane-cursor'; cursor.setAttribute('aria-hidden', 'true');
    clip.append(bands); rail.append(clip, cursor); information.append(label, badges, differences); header.append(chip, information, offset, unit, eye, display, action); row.append(header, rail);
    const node = { row, chip, label, badges, differences, offset, eye, display, remove, freeze, rail, clip, bands, cursor, track, bandsKey: '' };
    function applyOffset() {
      const value = Number(offset.value.replace(/s\s*$/, '').trim());
      if (!offset.value.trim() || !Number.isFinite(value)) { offset.value = offsetText(node.track.offset_s || 0); return; }
      onTrackChange(track.id, { offset_s: value });
    }
    if (track.kind !== 'live') {
      const applyName = () => onTrackChange(track.id, { displayName: label.value.trim() || node.track.defaultName || node.track.displayName });
      label.addEventListener('change', applyName);
      label.addEventListener('keydown', event => {
        if (event.key === 'Enter') { applyName(); label.blur?.(); }
        if (event.key === 'Escape') { label.value = node.track.displayName || node.track.defaultName; label.blur?.(); event.stopPropagation(); }
      });
    }
    freeze.addEventListener('click', () => { if (node.track.kind === 'live' && !freeze.disabled) onFreeze(); });
    offset.addEventListener('change', applyOffset);
    offset.addEventListener('keydown', event => { if (event.key === 'Enter') { applyOffset(); offset.blur?.(); } else if (event.key === 'Escape') { offset.value = offsetText(node.track.offset_s || 0); offset.blur?.(); event.stopPropagation(); } });
    eye.addEventListener('click', () => onTrackChange(track.id, { visible: node.track.visible === false }));
    display.addEventListener('click', () => onTrackChange(track.id, { display: node.track.kind === 'live' ? node.track.display === 'hidden' ? 'arm' : 'hidden' : node.track.display === 'dot' ? 'arm' : 'dot' }));
    remove.addEventListener('click', () => onTrackRemove(track.id));
    clip.addEventListener('dblclick', event => { event.preventDefault(); if (node.track.kind !== 'live') onTrackReset(track.id); });
    clip.addEventListener('keydown', event => {
      if (node.track.kind === 'live') return;
      if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); onTrackReset(track.id); }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); onTrackChange(track.id, { offset_s: node.track.offset_s + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? .001 : .01) }); }
    });
    clip.addEventListener('pointerdown', event => {
      if (node.track.kind === 'live' || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault(); event.stopPropagation(); hideTooltip();
      laneDrag = { id: track.id, pointer: event.pointerId, x: event.clientX, offset: node.track.offset_s || 0, span: [...window], width: Math.max(1, rail.clientWidth) };
      clip.setPointerCapture(event.pointerId); clip.classList.toggle('dragging', true);
    });
    rail.addEventListener('pointermove', event => {
      const item = node.track;
      if (laneDrag?.id === track.id && laneDrag.pointer === event.pointerId) {
        const secondsPerPixel = (laneDrag.span[1] - laneDrag.span[0]) / laneDrag.width;
        const raw = laneDrag.offset + (event.clientX - laneDrag.x) * secondsPerPixel;
        const candidates = [0, selected, ...tracks.filter(other => other.id !== track.id).flatMap(other => other.span.map(time => time + (other.offset_s || 0)))];
        onTrackChange(track.id, { offset_s: snapOffset(raw, candidates, secondsPerPixel, { alt: event.altKey, span: item.span }) });
        return;
      }
      if (drag) return;
      const rect = rail.getBoundingClientRect(), sessionTime = window[0] + (event.clientX - rect.left) / Math.max(1, rail.clientWidth) * (window[1] - window[0]);
      const entries = item.kind === 'live' ? visibleTimelineIntervals(index, [sessionTime - .000001, sessionTime + .000001]) : [];
      const entry = entries.find(entry => entry.severity === 'red') || entries.find(entry => entry.severity === 'yellow') || entries[0];
      tooltip.textContent = `${item.displayName || (item.kind === 'live' ? 'Live' : item.letter) || ''} · ${(sessionTime - (item.offset_s || 0)).toFixed(3)} s${entry ? ` · ${intervalDescription(entry.item)}` : ''}`; tooltip.hidden = false;
    });
    function endLaneDrag(event) {
      if (laneDrag?.id !== track.id || laneDrag.pointer !== event.pointerId) return;
      laneDrag = null; clip.classList.toggle('dragging', false);
      if (clip.hasPointerCapture(event.pointerId)) clip.releasePointerCapture(event.pointerId);
    }
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) clip.addEventListener(type, endLaneDrag);
    rail.addEventListener('pointerleave', hideTooltip);
    bindSurface(rail, { lane: true });
    lanes.append(row); return node;
  }
  function paintLanes() {
    const shown = mode === 'live' && tracks.length > 0;
    lanes.hidden = !shown; picker.hidden = mode !== 'live'; panel.classList.toggle('has-tracks', shown);
    const count = tracks.filter(track => track.kind !== 'live').length;
    const liveToggle = $('live-timeline-expand'); liveToggle.dataset.trackCount = String(count); liveToggle.classList.toggle('has-track-count', count > 0);
    if (!shown || !expanded) return;
    const ids = new Set(tracks.map(track => track.id));
    for (const [id, node] of laneNodes) if (!ids.has(id)) { node.row.remove(); laneNodes.delete(id); }
    const key = JSON.stringify([window, revision, freezeAvailable, surface.clientWidth, doc.defaultView?.devicePixelRatio || 1, breaches, tracks.map(track => [track.id, track.label, track.displayName, track.defaultName, track.letter, track.color, track.span, track.offset_s, track.visible, track.display, track.empty, track.differences, track.badges])]);
    if (key === laneKey) return;
    laneKey = key; lanePaints++;
    const span = window[1] - window[0], x = time => span ? (time - window[0]) / span * 100 : 0;
    for (const track of tracks) {
      let node = laneNodes.get(track.id); if (!node) { node = buildLane(track); laneNodes.set(track.id, node); }
      node.track = track;
      const main = track.kind === 'live', offset = track.offset_s || 0, differences = track.differences || [];
      node.row.classList.toggle('muted', track.visible === false); node.row.classList.toggle('main-track', main);
      node.chip.style.backgroundColor = colorText(track.color); node.clip.style.backgroundColor = colorText(track.color);
      const name = main ? 'Live' : track.displayName || track.defaultName || String.fromCharCode(64 + tracks.indexOf(track));
      if (main) node.label.textContent = name;
      else if (doc.activeElement !== node.label) node.label.value = name;
      node.label.title = [track.catalogName || track.label || name, ...differences.map(diffText)].join('\n');
      node.differences.textContent = differences.slice(0, 2).map(diffText).join(' · '); node.differences.title = differences.map(diffText).join('\n');
      node.badges.replaceChildren(...(track.badges || []).filter(badge => badge.label !== 'Incomplete').map(badge => { const element = doc.createElement('span'); element.className = 'timeline-lane-badge'; element.textContent = badge.label || '⚠'; element.title = badge.title || ''; return element; }));
      if (doc.activeElement !== node.offset) node.offset.value = offsetText(offset);
      node.offset.disabled = main; node.offset.title = main ? 'Live offset is fixed at 0 s' : 'Offset in session time; double-click the lane to reset';
      node.eye.textContent = track.visible === false ? '○' : '●'; node.eye.title = track.visible === false ? 'Show track' : 'Hide track';
      node.eye.setAttribute('aria-label', `${track.visible === false ? 'Show' : 'Hide'} track ${name}`); node.eye.setAttribute('aria-pressed', String(track.visible !== false)); node.eye.disabled = main;
      node.display.textContent = !main && track.display === 'dot' ? 'Dot' : 'Arm'; node.display.title = main ? track.display === 'hidden' ? 'Show Live arm' : 'Hide Live arm' : 'Toggle ghost arm / end-effector dot'; node.display.disabled = false;
      if (main) node.display.setAttribute('aria-pressed', String(track.display !== 'hidden'));
      node.display.setAttribute('aria-label', main ? node.display.title : `Track ${name} display: ${track.display === 'dot' ? 'dot' : 'arm'}`);
      node.remove.hidden = main; node.remove.title = 'Remove track'; node.remove.setAttribute('aria-label', `Remove track ${name}`);
      node.freeze.hidden = !main; node.freeze.disabled = !freezeAvailable;
      const left = x(track.span[0] + offset), right = x(track.span[1] + offset);
      node.clip.hidden = track.empty || right < 0 || left > 100; node.clip.style.left = `${Math.max(0, left)}%`; node.clip.style.width = `${Math.max(0, Math.min(100, right) - Math.max(0, left))}%`;
      node.clip.title = main ? 'Live' : 'Drag to offset; Alt disables snapping; double-click resets';
      node.bands.hidden = !main;
      if (main) {
        const railWidth = Math.max(1, node.rail.clientWidth), ratio = doc.defaultView?.devicePixelRatio || 1;
        const canvasKey = [window, revision, railWidth, ratio, left, right, breaches.length].join('|');
        if (canvasKey !== node.bandsKey) {
          node.bandsKey = canvasKey;
          const width = railWidth * (Math.min(100, right) - Math.max(0, left)) / 100;
          node.bands.width = Math.max(1, Math.round(width * ratio)); node.bands.height = Math.round(20 * ratio);
          const context = node.bands.getContext('2d'); context.scale(ratio, ratio); context.clearRect(0, 0, width, 20);
          const at = time => (x(time) - Math.max(0, left)) / 100 * railWidth;
          for (const severity of ['normal', 'yellow', 'red']) {
            context.fillStyle = { normal: '#476371', yellow: '#e8c65a', red: '#ed716c' }[severity];
            for (const item of visibleTimelineIntervals(index, window)) if (item.severity === severity) context.fillRect(at(item.start), 0, Math.max(1, at(item.end) - at(item.start)), 20);
          }
          context.fillStyle = '#ff8b83';
          for (const breach of breaches) { const time = breach.sim_time_s ?? breach.time_s; if (Number.isFinite(time)) context.fillRect(at(time) - 1, 0, 2, 20); }
        }
      }
    }
  }
  function positionLanes() {
    const span = window[1] - window[0], left = span ? (selected - window[0]) / span * 100 : 0;
    for (const node of laneNodes.values()) { node.cursor.style.left = `${left}%`; node.cursor.hidden = left < 0 || left > 100; }
  }
  const handles = { start: $('timeline-window-start'), end: $('timeline-window-end') };
  const shades = { start: $('timeline-window-shade-start'), end: $('timeline-window-shade-end') }, clearWindow = $('timeline-window-clear');
  surface.title = GESTURE_HINT;
  function paint() {
    if (!expanded) return;
    width = Math.max(1, surface.clientWidth);
    const ratio = doc.defaultView?.devicePixelRatio || 1;
    const key = [window[0], window[1], width, ratio, sourceCount, revision, mode, keyframeRevision, tracks.length].join('|');
    if (paintKey === key) return;
    paintKey = key; paints++;
    const hasLanes = mode === 'live' && tracks.length > 0, height = hasLanes ? 20 : 74;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio); context.clearRect(0, 0, width, height);
    const span = window[1] - window[0], x = time => (time - window[0]) / (span || 1) * width;
    if (!hasLanes) { context.fillStyle = '#263548'; context.fillRect(0, 39, width, 25); }
    // Render normal, then yellow, then red so MPC retains priority at every zoom.
    const visible = visibleTimelineIntervals(index, window);
    for (const severity of ['normal', 'yellow', 'red']) {
      context.fillStyle = { normal: '#476371', yellow: '#e8c65a', red: '#ed716c' }[severity];
      for (const item of visible) if (!hasLanes && item.severity === severity) {
        const left = clamp(x(item.start), 0, width), right = clamp(x(item.end), 0, width);
        context.fillRect(left, 39, Math.max(1, right - left), 25);
      }
    }
    context.font = '10px "IBM Plex Mono", monospace';
    for (const tick of timelineTicks(window, width)) {
      const left = tick.fraction * width;
      context.strokeStyle = '#526174'; context.beginPath(); context.moveTo(left, hasLanes ? 15 : 24); context.lineTo(left, height); context.stroke();
      context.fillStyle = '#b3c7d7';
      context.fillText(tick.label, clamp(left + 4, 2, Math.max(2, width - context.measureText(tick.label).width - 2)), hasLanes ? 11 : 16);
    }
    for (const keyframe of keyframes) {
      if (keyframe.time < window[0] || keyframe.time > window[1]) continue;
      const left = clamp(x(keyframe.time), 1, Math.max(1, width - 1));
      context.fillStyle = typeof keyframe.color === 'number' ? `#${keyframe.color.toString(16).padStart(6, '0')}` : keyframe.color || '#aeb9c5';
      context.fillRect(left - 1, hasLanes ? 15 : KEYFRAME_TICK_TOP, 2, hasLanes ? 5 : KEYFRAME_TICK_BOTTOM - KEYFRAME_TICK_TOP);
    }
    $('timeline-timing-note').innerHTML = index.length ? '<span class="timeline-mpc-key">MPC over budget</span> · <span class="timeline-simulation-key">Simulation / combined</span>' : 'No timing data';
    $('timeline-timing-note').classList.toggle('has-timing', Boolean(index.length));
  }
  function position() {
    if (!expanded) return;
    const span = window[1] - window[0], fraction = span ? (selected - window[0]) / span : 0;
    playhead.hidden = fraction < 0 || fraction > 1;
    playhead.style.left = `${clamp(fraction, 0, 1) * 100}%`;
    surface.setAttribute('aria-valuemin', String(bounds[0])); surface.setAttribute('aria-valuemax', String(bounds[1]));
    surface.setAttribute('aria-valuenow', String(selected)); surface.setAttribute('aria-valuetext', `${selected.toFixed(6)} seconds`);
    $('timeline-selection').textContent = `${selected.toFixed(6)} s`;
    positionAggregate();
  }
  // Handles sit at the data edges while unbounded; the open style shows that
  // the aggregate extends there (and, at the Live tip, keeps growing).
  function positionAggregate() {
    const span = window[1] - window[0], [low, high] = aggregateSpan(aggregate, bounds);
    const at = time => span ? (time - window[0]) / span * 100 : 0;
    const left = clamp(at(low), 0, 100), right = clamp(at(high), 0, 100);
    shades.start.style.left = '0%'; shades.start.style.width = `${aggregateBounded(aggregate) ? left : 0}%`;
    shades.end.style.left = `${right}%`; shades.end.style.width = `${aggregateBounded(aggregate) ? 100 - right : 0}%`;
    for (const [side, time] of [['start', low], ['end', high]]) {
      const handle = handles[side], open = !Number.isFinite(aggregate[side]), position = at(time);
      handle.hidden = position < -1e-9 || position > 100 + 1e-9;
      handle.style.left = `${clamp(position, 0, 100)}%`;
      handle.classList.toggle('open', open);
      handle.classList.toggle('dragging', drag?.aggregate === side);
      handle.setAttribute('aria-valuenow', String(time)); handle.setAttribute('aria-valuetext', open ? 'Unbounded' : `${time.toFixed(6)} seconds`);
      handle.title = `Aggregate ${side}: ${open ? side === 'end' ? 'unbounded, follows new data' : 'unbounded, from the first sample' : `${time.toFixed(3)} s`}. Drag to move; drag onto the data ${side === 'end' ? 'end' : 'start'} or double-click for unbounded.`;
    }
    clearWindow.hidden = !aggregateBounded(aggregate);
    clearWindow.title = `Clear aggregate window ${aggregateLabel(aggregate)} (Esc)`;
  }
  function setAggregate(next) {
    next = { start: Number.isFinite(next?.start) ? next.start : null, end: Number.isFinite(next?.end) ? next.end : null };
    if (next.start === aggregate.start && next.end === aggregate.end) return;
    aggregate = next; positionAggregate(); onAggregate({ ...aggregate });
  }
  const snapSeconds = () => 6 / Math.max(1, width) * (window[1] - window[0]);
  const rawTimeAt = event => window[0] + (event.clientX - surface.getBoundingClientRect().left) / Math.max(1, surface.clientWidth) * (window[1] - window[0]);
  function redraw() { paintLanes(); paint(); position(); positionLanes(); }
  function setExpanded(value) {
    expanded = value; panel.hidden = !value;
    for (const button of toggles) {
      button.setAttribute('aria-expanded', String(value)); button.setAttribute('aria-label', `${value ? 'Collapse' : 'Expand'} timeline`);
      button.title = `${value ? 'Collapse' : 'Expand'} timeline`;
    }
    paintKey = ''; redraw(); onLayout();
  }
  const fractionAt = event => clamp((event.clientX - surface.getBoundingClientRect().left) / Math.max(1, surface.clientWidth), 0, 1);
  const timeAt = event => window[0] + fractionAt(event) * (window[1] - window[0]);
  function keyframeAt(event, element) {
    // Linked plots share the timeline gestures, but only the ruler has ticks.
    if (element !== surface) return null;
    const rect = surface.getBoundingClientRect(), y = event.clientY - rect.top;
    const compact = mode === 'live' && tracks.length > 0;
    if (y < (compact ? 15 : KEYFRAME_TICK_TOP) - 3 || y > (compact ? 20 : KEYFRAME_TICK_BOTTOM) + 3) return null;
    const span = window[1] - window[0], x = event.clientX - rect.left;
    let closest = null, distance = KEYFRAME_HIT_RADIUS;
    for (const keyframe of keyframes) {
      if (keyframe.time < window[0] || keyframe.time > window[1]) continue;
      const dx = Math.abs((span ? (keyframe.time - window[0]) / span : 0) * surface.clientWidth - x);
      if (dx <= distance) { closest = keyframe; distance = dx; }
    }
    return closest;
  }
  function seek(time) { selected = clamp(time, ...bounds); onSeek(selected); position(); positionLanes(); }
  function zoom(factor, fraction = .5) { window = zoomTimeline(window, bounds, factor, fraction); fitted = false; redraw(); }
  function pan(seconds) { window = clampTimelineWindow(window.map(time => time + seconds), bounds); fitted = false; redraw(); }
  function fit() { window = [...bounds]; fitted = true; redraw(); }
  function hideTooltip() { tooltip.hidden = true; }
  for (const button of toggles) button.addEventListener('click', () => setExpanded(!expanded));
  $('timeline-fit').addEventListener('click', fit);
  clearWindow.addEventListener('click', () => setAggregate(UNBOUNDED_AGGREGATE));
  for (const [side, handle] of Object.entries(handles)) {
    handle.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); setAggregate({ ...aggregate, [side]: null }); });
  }
  $('timeline-zoom-in').addEventListener('click', () => zoom(.5));
  $('timeline-zoom-out').addEventListener('click', () => zoom(2));
  function bindSurface(element, { lane = false } = {}) {
  element.addEventListener('wheel', event => {
    event.preventDefault(); hideTooltip();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientWidth : 1;
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) pan((event.deltaX || event.deltaY) * unit / Math.max(1, width) * (window[1] - window[0]));
    else zoom(Math.exp(clamp(event.deltaY * unit, -500, 500) * .002), fractionAt(event));
  }, { passive: false });
  element.addEventListener('pointerdown', event => {
    if (event.target.closest?.('button, input, select, label, [draggable="true"]')) return;
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault(); hideTooltip(); surface.focus();
    const side = event.button === 0 && event.target.closest?.('.timeline-window-handle')?.dataset.side;
    const select = event.button === 0 && !side && event.shiftKey;
    const plain = event.button === 0 && !side && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    drag = { pointer: event.pointerId, pan: !side && !select && (event.button === 1 || event.altKey), x: event.clientX, y: event.clientY, window: [...window], element, aggregate: side || null, anchor: select ? clamp(timeAt(event), ...bounds) : null, keyframe: plain ? keyframeAt(event, element) : null };
    element.setPointerCapture(event.pointerId); element.classList.toggle('panning', drag.pan);
    if (drag.aggregate) positionAggregate();
    else if (!drag.pan && drag.anchor == null && !drag.keyframe) seek(timeAt(event));
  });
  element.addEventListener('pointermove', event => {
    if (drag) {
      if (event.pointerId !== drag.pointer) return;
      if (drag.aggregate) setAggregate(moveAggregateBound(aggregate, drag.aggregate, rawTimeAt(event), bounds, snapSeconds()));
      else if (drag.anchor != null) {
        // Shift-drag selects [press, pointer]; reaching an outer data edge leaves that side open.
        const time = rawTimeAt(event), low = Math.min(drag.anchor, time), high = Math.max(drag.anchor, time);
        if (high - low > snapSeconds()) setAggregate(moveAggregateBound(moveAggregateBound(UNBOUNDED_AGGREGATE, 'end', high, bounds, snapSeconds()), 'start', low, bounds, snapSeconds()));
      } else if (drag.pan) {
        const delta = (event.clientX - drag.x) / Math.max(1, surface.clientWidth) * (drag.window[1] - drag.window[0]);
        window = clampTimelineWindow(drag.window.map(time => time - delta), bounds); fitted = false; redraw();
      } else {
        if (drag.keyframe && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < KEYFRAME_HIT_RADIUS) return;
        drag.keyframe = null; seek(timeAt(event));
      }
      return;
    }
    if (lane) return;
    const keyframe = keyframeAt(event, element);
    if (keyframe) { tooltip.textContent = `${(keyframe.sampleTime ?? keyframe.time).toFixed(3)} s`; tooltip.hidden = false; return; }
    const time = timeAt(event), epsilon = Math.max(Number.EPSILON, (window[1] - window[0]) / Math.max(width, 1) / 2);
    const entries = visibleTimelineIntervals(index, [time - epsilon, time + epsilon]);
    const entry = entries.find(value => value.severity === 'red') || entries.find(value => value.severity === 'yellow') || entries[0];
    tooltip.textContent = `${time.toFixed(6)} s · ${entry ? `${entry.start.toFixed(6)}–${entry.end.toFixed(6)} s · ${intervalDescription(entry.item)}` : 'No timing data at this time'}`;
    tooltip.hidden = false;
  });
  function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (event.type === 'pointerup' && drag.keyframe && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < KEYFRAME_HIT_RADIUS) seek(drag.keyframe.time);
    const target = drag.element, wasAggregate = drag.aggregate; drag = null; target.classList.remove('panning');
    if (wasAggregate) positionAggregate();
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(type, endDrag);
  element.addEventListener('pointerleave', hideTooltip);
  element.addEventListener('keydown', event => {
    if (timelineTypingTarget(event.target)) return;
    const span = window[1] - window[0], step = event.shiftKey ? .001 : span / 100;
    if (event.key === 'Escape' && aggregateBounded(aggregate)) { event.preventDefault(); event.stopPropagation(); setAggregate(UNBOUNDED_AGGREGATE); return; }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', '+', '=', '-', '_', '0'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); hideTooltip();
      if (event.key === 'Home') seek(bounds[0]);
      else if (event.key === 'End') seek(bounds[1]);
      else if (['+', '='].includes(event.key)) zoom(.5);
      else if (['-', '_'].includes(event.key)) zoom(2);
      else if (event.key === '0') fit();
      else if (event.altKey) pan((event.key === 'ArrowRight' ? 1 : -1) * span / 10);
      else seek(selected + (event.key === 'ArrowRight' ? 1 : -1) * step);
    }
  });
  }
  bindSurface(surface);
  bindSurface($('timeline-aggregate-overlay'));
  const observer = new ResizeObserver(() => redraw()); observer.observe(surface);
  return {
    seek, zoom, pan, bindSurface, setAggregate, clearAggregate: () => setAggregate(UNBOUNDED_AGGREGATE),
    refreshLayout: redraw,
    update(next) {
      const reset = identity !== next.identity || mode !== next.mode;
      if (reset && laneDrag) { const node = laneNodes.get(laneDrag.id), pointer = laneDrag.pointer; laneDrag = null; node?.clip.classList.toggle('dragging', false); if (node?.clip.hasPointerCapture(pointer)) node.clip.releasePointerCapture(pointer); }
      if (reset && mode === 'live' && identity != null) workspaces.set(identity, { aggregate: { ...aggregate }, window: [...window], fitted });
      identity = next.identity; mode = next.mode; bounds = timelineBounds(next.bounds);
      tracks = next.tracks || []; catalog = next.catalog || []; breaches = next.breaches || [];
      freezeAvailable = next.freezeAvailable ?? !$('live-freeze')?.disabled; paintCatalog();
      selected = clamp(Number.isFinite(next.time) ? next.time : bounds[0], ...bounds);
      if (reset) {
        // Live uses one stable session identity across generation changes.
        // Returning from Replay restores that session's presentation windows.
        const previous = mode === 'live' ? workspaces.get(identity) : undefined;
        fitted = previous?.fitted ?? true; window = previous?.window ?? [...bounds];
        paintKey = ''; laneKey = ''; hideTooltip(); setAggregate(previous?.aggregate ?? UNBOUNDED_AGGREGATE);
        if (drag) {
          const previous = drag; drag = null; previous.element.classList.remove('panning');
          if (previous.element.hasPointerCapture(previous.pointer)) previous.element.releasePointerCapture(previous.pointer);
        }
        $('timeline-clock-label').textContent = next.clockLabel || (mode === 'live' ? 'Session time' : 'Recorded time');
      }
      window = fitted ? [...bounds] : mode === 'live' ? window : clampTimelineWindow(window, bounds);
      const items = next.intervals || [];
      if (reset || source !== items || sourceCount !== items.length || revision !== next.revision) {
        source = items; sourceCount = items.length; revision = next.revision;
        index = indexTimelineIntervals(items); paintKey = ''; laneKey = ''; laneNodes.forEach(node => { node.bandsKey = ''; });
      }
      if (reset || keyframeSource !== next.keyframes || keyframeRevision !== next.keyframeRevision) {
        keyframeSource = next.keyframes; keyframeRevision = next.keyframeRevision;
        keyframes = (next.keyframes || []).filter(keyframe => Number.isFinite(keyframe.time)); paintKey = '';
      }
      redraw();
    },
    get snapshot() { return { expanded, mode, bounds: [...bounds], visible: [...window], selectedTime: selected, intervalCount: index.length, paints, lanePaints, trackCount: tracks.length, aggregate: { ...aggregate } }; },
  };
}
