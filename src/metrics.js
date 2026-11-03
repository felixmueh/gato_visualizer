import { intervalSeverity } from './live-execution.js';
import { referencePosition } from './replay-library.js';

const finite = Number.isFinite;
const numeric = value => finite(value) ? value : null;
const vector = value => Array.isArray(value) && value.length === 3 && value.every(finite);
const fmt = value => finite(value) ? Number(value.toPrecision(4)).toString() : 'unavailable';
const distance = state => finite(state.distance_m) ? state.distance_m : vector(state.ee_xyz) && vector(state.target_xyz) ? Math.hypot(...state.ee_xyz.map((v, i) => v - state.target_xyz[i])) : null;
const point = (t, y) => ({ t, y: numeric(y) });
const scale = (value, factor) => finite(value) ? value * factor : null;
const replayCache = new WeakMap();

// Replay uses elapsed time on its existing playback clock, even for exports
// whose recorded time starts far from zero. Never synthesize velocities/torques.
export function replayMetricSnapshot(trajectory) {
  if (!trajectory) return EMPTY;
  if (replayCache.has(trajectory)) return replayCache.get(trajectory);
  const origin = trajectory.time_s[0];
  const states = trajectory.time_s.map((time, i) => ({ sim_time_s: time - origin, q: trajectory.q?.[i], qd: trajectory.qd_rad_s?.[i], ee_xyz: trajectory.ee_xyz?.[i], target_xyz: referencePosition(trajectory, time) }));
  const torqueTimes = trajectory.torque_time_s || trajectory.time_s;
  const torqueSamples = (trajectory.torque_nm || []).map((torque, i) => ({ sim_time_s: torqueTimes[i] - origin, torque_nm: torque }));
  if (trajectory.torque_kind === 'predicted' && torqueSamples.length) torqueSamples.push({ sim_time_s: (trajectory.torque_end_time_s ?? trajectory.time_s.at(-1)) - origin, torque_nm: null });
  const result = { revision: trajectory, states, torqueSamples, plans: [], intervals: [], selectedPlan: trajectory.kind === 'prediction' ? trajectory : null, sourceKind: trajectory.kind, sourceLabel: trajectory.label || 'Imported recording' };
  replayCache.set(trajectory, result);
  return result;
}
const EMPTY = { revision: null, states: [], plans: [], intervals: [] };
export const METRIC_CATEGORIES = [
  { id: 'solve', label: 'MPC wall / TO budget', unit: 'ms' },
  { id: 'physics', label: 'Physics wall time', unit: 'ms' },
  { id: 'total', label: 'Total interval wall time', unit: 'ms' },
  { id: 'iterations', label: 'Solver iterations', unit: 'iterations' },
  { id: 'distance', label: 'EE target distance', unit: 'mm' },
  { id: 'q', label: 'Joint position', unit: 'rad' },
  { id: 'qd', label: 'Joint velocity', unit: 'rad/s' },
  { id: 'torque', label: 'Actuator torque', unit: 'Nm' },
];

export function metricSeries(data = EMPTY, joint = 0) {
  const states = data.states || [], intervals = data.intervals || [], plans = data.plans || [];
  const series = (label, samples, step = false) => ({ label, points: samples, step });
  // Explicit interval-end breaks prevent bridging gaps in recorded timing data.
  const intervalPoints = getter => {
    const points = [];
    for (const item of intervals) {
      // Touching intervals are contiguous held samples, not artificial gaps.
      if (points.at(-1)?.t === item.start_time_s && points.at(-1)?.y === null) points.pop();
      points.push(point(item.start_time_s, getter(item)), point(item.end_time_s, null));
    }
    return points;
  };
  const statePoints = getter => states.map(state => point(state.sim_time_s, getter(state)));
  const planPoints = getter => {
    const result = plans.map(plan => point(plan.sim_time_s, getter(plan))).filter(p => finite(p.t));
    if (result.length && states.at(-1)?.sim_time_s > result.at(-1).t) result.push({ ...result.at(-1), t: states.at(-1).sim_time_s });
    return result;
  };
  return {
    solve: [series('MPC wall', intervalPoints(i => scale(i.solve_wall_s ?? i.mpc_wall_s, 1000)), true), series('Nominal TO budget', intervalPoints(i => i.to_back_to_back ? null : scale(i.to_budget_s ?? i.budget_s, 1000)), true)],
    physics: [series('Physics wall', intervalPoints(i => scale(i.physics_wall_s ?? i.simulation_wall_s, 1000)), true)],
    total: [series('Total wall', intervalPoints(i => scale(i.total_wall_s, 1000)), true)],
    iterations: ['sqp', 'pcg', 'admm'].map(key => series(key.toUpperCase(), planPoints(p => p.stats?.[`${key}_iters`]), true)),
    distance: [series('Target distance', statePoints(s => scale(distance(s), 1000)))],
    q: [series(`J${joint + 1} position`, statePoints(s => s.q?.[joint]))],
    qd: [series(`J${joint + 1} velocity`, statePoints(s => s.qd?.[joint]))],
    torque: [series(`J${joint + 1} ${data.sourceKind === 'prediction' ? 'predicted' : 'last applied'} torque`, (data.torqueSamples || states).map(s => point(s.sim_time_s, s.torque_nm?.[joint])), true)],
  };
}

function pathLength(points = []) {
  let length = 0, edges = 0;
  for (let i = 1; i < points.length; i++) if (vector(points[i - 1]) && vector(points[i])) { length += Math.hypot(...points[i].map((v, j) => v - points[i - 1][j])); edges++; }
  return { value: edges ? length : null, count: edges, total: Math.max(0, points.length - 1) };
}
function peak(values) {
  let maximum = null;
  for (const row of values || []) for (const value of Array.isArray(row) ? row : [row]) if (finite(value)) maximum = Math.max(maximum ?? 0, Math.abs(value));
  return maximum;
}
function quantile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b), pos = (ordered.length - 1) * fraction;
  return ordered[Math.floor(pos)] + (ordered[Math.ceil(pos)] - ordered[Math.floor(pos)]) * (pos % 1);
}

// Merge overlapping interval spans by severity: red takes precedence; coverage
// is a union of recorded intervals rather than a sum that double-counts overlap.
export function intervalShares(intervals, bounds = [-Infinity, Infinity]) {
  const events = [];
  for (const interval of intervals) {
    const start = Math.max(bounds[0], interval.start_time_s), end = Math.min(bounds[1], interval.end_time_s);
    if (!finite(start) || !finite(end) || end <= start) continue;
    const severity = intervalSeverity(interval);
    events.push({ t: start, severity, delta: 1 }, { t: end, severity, delta: -1 });
  }
  events.sort((a, b) => a.t - b.t);
  const active = { red: 0, yellow: 0, normal: 0 }, durations = { red: 0, yellow: 0, normal: 0 };
  let previous = events[0]?.t;
  for (const event of events) {
    const severity = active.red ? 'red' : active.yellow ? 'yellow' : active.normal ? 'normal' : null;
    if (severity) durations[severity] += event.t - previous;
    active[event.severity] += event.delta; previous = event.t;
  }
  const covered = durations.red + durations.yellow + durations.normal;
  return { ...durations, covered, redShare: covered ? durations.red / covered : null, yellowShare: covered ? durations.yellow / covered : null };
}

export function metricAggregates(data = EMPTY, { recording = true } = {}) {
  const states = data.states || [], plans = data.plans || [], intervals = data.intervals || [], plan = data.selectedPlan;
  const stats = plan?.stats || plan?.metadata?.stats || {};
  const violations = (Array.isArray(stats.row_violation) ? stats.row_violation.flat(Infinity) : [stats.row_violation]).filter(finite);
  const row = (label, value, unit = '', note = '') => ({ label, value: numeric(value), unit, note });
  const predictedPath = pathLength(plan?.ee_xyz);
  const prediction = [
    row('Prediction duration', plan?.time_s?.length ? plan.time_s.at(-1) - plan.time_s[0] : finite(plan?.dt_s) && finite(plan?.N) ? plan.dt_s * (plan.N - 1) : null, 's'),
    row('Predicted EE path length', predictedPath.value, 'm', `${predictedPath.count}/${predictedPath.total} valid segments`),
    row('Peak predicted joint speed', peak(plan?.qd_rad_s || plan?.qd), 'rad/s'),
    row('Peak predicted actuator torque', peak(plan?.torque_nm), 'Nm', 'nonterminal controls only'),
    row('Maximum reported row violation', violations.length ? violations.reduce((a, b) => Math.max(a, b), 0) : null, '', 'reported scale; no convergence claim'),
    row('Solver reported solve time', stats.solve_time_ms, 'ms', 'selected prediction; distinct from controller wall time'),
    ...['sqp', 'pcg', 'admm'].map(key => row(`${key.toUpperCase()} iterations`, stats[`${key}_iters`])),
  ];
  if (!recording) return { prediction, recording: [] };
  const bounds = states.length ? [states[0].sim_time_s, states.at(-1).sim_time_s] : [0, 0];
  const path = pathLength(states.map(state => state.ee_xyz));
  const wall = intervals.map(i => scale(i.solve_wall_s ?? i.mpc_wall_s, 1000)).filter(finite);
  const shares = intervalShares(intervals, bounds);
  const distances = states.map(distance).filter(finite);
  const recordedPlans = plans.filter(p => p.origin !== 'preview');
  const recorded = [
    row('Recording duration', states.length ? bounds[1] - bounds[0] : null, 's', `${states.length} retained states`),
    row('Retained unique TO plans', recordedPlans.length || null, '', 'unique recorded plan payloads; previews excluded'),
    row('MPC wall median', quantile(wall, .5), 'ms', `${wall.length}/${intervals.length} recorded intervals with timing`),
    row('MPC wall p95', quantile(wall, .95), 'ms', 'interpolated sample percentile; visualizer diagnostics'),
    row('MPC over-budget share', scale(shares.redShare, 100), '%', `by duration of ${fmt(shares.covered)} s covered intervals`),
    row('Simulation / combined share', scale(shares.yellowShare, 100), '%', 'by covered duration; red takes precedence'),
    row('Recorded EE path length', path.value, 'm', `${path.count}/${path.total} valid segments`),
    row('Final target error', scale(distance(states.at(-1) || {}), 1000), 'mm'),
    row('Minimum target error', distances.length ? distances.reduce((a, b) => Math.min(a, b), Infinity) * 1000 : null, 'mm', `${distances.length}/${states.length} valid states`),
  ];
  return { prediction, recording: data.sourceKind === 'prediction' ? [] : recorded };
}

// Keep each pixel's extrema and boundaries in chronological order. Null markers
// break lines; interval end markers also finish held values at the exact end.
// This is a display reduction only: source arrays and aggregate inputs stay full.
export function decimateSeries(points, window, pixels = 400) {
  const [start, end] = window;
  if (!(end > start) || !points.length) return [];
  let low = 0, high = points.length;
  while (low < high) { const mid = (low + high) >>> 1; if (points[mid].t < start) low = mid + 1; else high = mid; }
  const first = Math.max(0, low - 1), output = [];
  let bucket = [], bucketId;
  const flush = () => {
    if (!bucket.length) return;
    let minimum = 0, maximum = 0;
    bucket.forEach((p, i) => { if (p.y < bucket[minimum].y) minimum = i; if (p.y > bucket[maximum].y) maximum = i; });
    [...new Set([0, minimum, maximum, bucket.length - 1])].sort((a, b) => a - b).forEach(i => output.push(bucket[i]));
    bucket = [];
  };
  for (let i = first; i < points.length; i++) {
    const p = points[i], id = Math.floor((p.t - start) / (end - start) * Math.max(1, pixels));
    if (!finite(p.y)) { flush(); if (output.at(-1)?.y !== null || output.at(-1)?.t !== p.t) output.push(p); }
    else { if (id !== bucketId) flush(); bucketId = id; bucket.push(p); }
    if (p.t > end) break;
  }
  flush();
  return output;
}

export function plotPath(points, window, range, width, height, step = false) {
  const x = t => (t - window[0]) / (window[1] - window[0]) * width;
  const y = value => height - (value - range[0]) / (range[1] - range[0]) * height;
  let path = '', previous = null;
  for (const p of points) {
    if (!finite(p.y)) { if (step && previous) path += `H${x(p.t).toFixed(2)}`; previous = null; continue; }
    const px = x(p.t).toFixed(2), py = y(p.y).toFixed(2);
    path += !previous ? `M${px},${py}` : step ? `H${px}V${py}` : `L${px},${py}`;
    previous = p;
  }
  return path;
}

const COLORS = ['#57c7dc', '#e6b961', '#b398f3'];
export function setupMetrics({ rightContainer, bottomContainer, getData, getView, onSeek }) {
  const doc = rightContainer.ownerDocument;
  const element = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
  const selected = { right: new Set(['solve', 'distance']), bottom: new Set(['solve']) };
  let joint = 0, expanded = false, dirty = true, lastData, lastRevision, lastPlan, series, lastWindow = '', resizeVersion = 0, lastResize = -1, lastWidth = '', plots = [];
  let lastReadMs = -Infinity, dragging = false;
  let recordedAggregates = [];
  const shell = element('div', 'metrics-workbench');
  const source = element('p', 'metrics-note'); shell.append(source);
  const controls = element('fieldset', 'metrics-selection'); controls.append(element('legend', '', 'Choose time series'));
  const columns = element('div', 'metrics-selection-head'); columns.append(element('span', '', 'Metric'), element('span', '', 'Right'), element('span', '', 'Timeline')); controls.append(columns);
  for (const category of METRIC_CATEGORIES) {
    const row = element('div', 'metrics-selection-row'); row.append(element('span', '', category.label));
    for (const location of ['right', 'bottom']) {
      const label = element('label', 'metrics-checkbox');
      const input = element('input'); input.type = 'checkbox'; input.checked = selected[location].has(category.id);
      input.setAttribute('aria-label', `${category.label}: ${location === 'right' ? 'right panel' : 'timeline'}`);
      input.addEventListener('change', () => { if (input.checked) selected[location].add(category.id); else selected[location].delete(category.id); dirty = true; update(); });
      label.append(input); row.append(label);
    }
    controls.append(row);
  }
  const jointLabel = element('label', 'metrics-joint', 'Joint for position, velocity and torque ');
  const jointSelect = element('select'); jointSelect.setAttribute('aria-label', 'Joint for metric plots');
  for (let i = 0; i < 7; i++) { const option = element('option', '', `J${i + 1}`); option.value = i; jointSelect.append(option); }
  jointSelect.addEventListener('change', () => { joint = Number(jointSelect.value); series = metricSeries(lastData, joint); dirty = true; update(); });
  jointLabel.append(jointSelect); controls.append(jointLabel); shell.append(controls);
  const rightPlots = element('div', 'metrics-right-plots'), aggregates = element('div', 'metrics-aggregates'); shell.append(rightPlots, aggregates); rightContainer.replaceChildren(shell);
  const toggle = element('button', 'metrics-expand', 'Show timeline graphs'); toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false');
  const bottomPlots = element('div', 'metrics-bottom-plots'); bottomPlots.hidden = true;
  const scrollTools = element('span', 'metrics-scroll-tools'); scrollTools.hidden = true;
  scrollTools.append(element('span', '', 'Scroll rows '));
  for (const [label, amount] of [['↑', -90], ['↓', 90]]) {
    const button = element('button', '', label); button.type = 'button'; button.setAttribute('aria-label', `Scroll timeline graph rows ${amount < 0 ? 'up' : 'down'}`);
    button.addEventListener('click', () => bottomPlots.scrollBy({ top: amount, behavior: 'smooth' })); scrollTools.append(button);
  }
  toggle.addEventListener('click', () => { expanded = !expanded; bottomPlots.hidden = scrollTools.hidden = !expanded; toggle.textContent = expanded ? 'Hide timeline graphs' : 'Show timeline graphs'; toggle.setAttribute('aria-expanded', String(expanded)); dirty = true; update(); });
  bottomContainer.replaceChildren(toggle, scrollTools, bottomPlots);
  function aggregateView(data, dataChanged) {
    const values = metricAggregates(data, { recording: dataChanged });
    if (dataChanged) recordedAggregates = values.recording;
    values.recording = recordedAggregates;
    aggregates.replaceChildren();
    for (const [key, title] of [['prediction', 'Selected predicted plan'], ['recording', data.truncated ? 'Retained recorded closed loop' : data.sourceKind === 'live' ? 'Full recording · simulated closed loop' : 'Full recorded trajectory']]) {
      if (!values[key].length) continue;
      const details = element('details', 'metrics-statistics'); details.open = true; details.append(element('summary', '', title));
      const table = element('dl');
      for (const item of values[key]) { const term = element('dt', '', item.label); const value = element('dd', '', `${fmt(item.value)}${finite(item.value) && item.unit ? ` ${item.unit}` : ''}`); if (item.note) { term.title = item.note; value.append(element('small', '', item.note)); } table.append(term, value); }
      details.append(table); aggregates.append(details);
    }
  }
  function makePlot(category, location, window) {
    const block = element('section', 'metrics-plot'); block.dataset.metric = category.id;
    const heading = element('div', 'metrics-plot-heading'); heading.append(element('span', '', `${category.label} · ${category.unit}`));
    const readings = element('span', 'metrics-reading'); heading.append(readings); block.append(heading);
    const list = series[category.id];
    const legend = element('div', 'metrics-legend'); list.forEach((line, i) => { const label = element('span', '', line.label); label.style.color = COLORS[i]; legend.append(label); }); block.append(legend);
    const width = Math.max(20, (location === 'bottom' ? bottomContainer.clientWidth : rightContainer.clientWidth) || 300), height = location === 'bottom' ? 52 : 84;
    const reduced = list.map(line => decimateSeries(line.points, window, width));
    let min = Infinity, max = -Infinity;
    for (const points of reduced) for (const p of points) if (finite(p.y)) { min = Math.min(min, p.y); max = Math.max(max, p.y); }
    const available = finite(min);
    if (!available) block.append(element('p', 'metrics-empty', 'No recorded values in this window'));
    else {
      if (min === max) { const margin = Math.max(Math.abs(min) * .05, .01); min -= margin; max += margin; }
      const ns = 'http://www.w3.org/2000/svg';
      const svg = doc.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${category.label}, ${category.unit}. Timeline range ${fmt(window[0])} to ${fmt(window[1])} seconds.`); svg.classList.add('metrics-svg');
      reduced.forEach((points, i) => { const path = doc.createElementNS(ns, 'path'); path.setAttribute('d', plotPath(points, window, [min, max], width, height, list[i].step)); path.setAttribute('stroke', COLORS[i]); svg.append(path); });
      const cursor = doc.createElementNS(ns, 'line'); cursor.classList.add('metrics-cursor'); cursor.setAttribute('y1', 0); cursor.setAttribute('y2', height); svg.append(cursor);
      const seek = event => { const rect = svg.getBoundingClientRect(); if (!rect.width) return; onSeek(window[0] + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * (window[1] - window[0])); };
      // The stable bottom mount is bound once by timeline.bindSurface: it owns
      // seeking, wheel zoom and Alt/middle-drag panning without double capture.
      if (location === 'right') {
        svg.addEventListener('pointerdown', event => { if (event.button !== 0) return; dragging = true; svg.setPointerCapture?.(event.pointerId); seek(event); });
        svg.addEventListener('pointermove', event => { if (svg.hasPointerCapture?.(event.pointerId)) seek(event); });
        svg.addEventListener('pointerup', event => { dragging = false; if (svg.hasPointerCapture?.(event.pointerId)) svg.releasePointerCapture(event.pointerId); });
        svg.addEventListener('pointercancel', () => { dragging = false; });
        svg.addEventListener('lostpointercapture', () => { dragging = false; });
        svg.setAttribute('tabindex', '0');
        svg.addEventListener('keydown', event => {
          const cursor = getView()?.cursor ?? window[0], step = (window[1] - window[0]) / 100;
          const value = { ArrowLeft: cursor - step, ArrowRight: cursor + step, Home: window[0], End: window[1] }[event.key];
          if (value == null) return;
          event.preventDefault(); onSeek(Math.max(window[0], Math.min(window[1], value)));
        });
      }
      block.append(svg); block.append(element('div', 'metrics-range', `${fmt(min)}–${fmt(max)} ${category.unit}`));
      plots.push({ cursor, width, window, readings, lines: list });
    }
    return block;
  }
  function update() {
    // Hidden graphs do not materialize history snapshots. Growing recordings
    // rebuild at most ~8 Hz; the cursor remains cheap on every animation frame.
    if (lastData && rightContainer.closest?.('[hidden]') && (!expanded || bottomContainer.closest?.('[hidden]'))) return;
    const now = Date.now(), read = !lastData || now - lastReadMs >= 120;
    const data = read ? getData() || EMPTY : lastData, view = getView() || {}, window = view.window || [0, 1];
    if (read) lastReadMs = now;
    const dataChanged = !lastData || data.revision !== lastRevision || data.states !== lastData.states || data.sourceKind !== lastData.sourceKind;
    if (dataChanged) { series = metricSeries(data, joint); lastRevision = data.revision; dirty = true; }
    if (dataChanged || lastPlan !== data.selectedPlan) { aggregateView(data, dataChanged); lastPlan = data.selectedPlan; }
    lastData = data;
    const windowKey = window.join(','), widthKey = `${rightContainer.clientWidth},${bottomContainer.clientWidth}`;
    if (!dragging && (dirty || lastWindow !== windowKey || lastResize !== resizeVersion || lastWidth !== widthKey)) {
      source.textContent = `${data.sourceLabel || (data.sourceKind === 'live' ? 'Live recording' : 'Recording')} · ${data.sourceKind === 'prediction' ? 'predicted motion' : 'recorded motion'} · time in seconds. Display uses per-pixel extrema; aggregates use all retained samples.`;
      plots = []; rightPlots.replaceChildren(); bottomPlots.replaceChildren();
      for (const category of METRIC_CATEGORIES) {
        if (selected.right.has(category.id)) rightPlots.append(makePlot(category, 'right', window));
        if (expanded && selected.bottom.has(category.id)) bottomPlots.append(makePlot(category, 'bottom', window));
      }
      if (!selected.right.size) rightPlots.append(element('p', 'metrics-empty', 'Select a right-panel time series above.'));
      if (expanded && !selected.bottom.size) bottomPlots.append(element('p', 'metrics-empty', 'Select Timeline checkboxes in Graphs.'));
      dirty = false; lastWindow = windowKey; lastResize = resizeVersion; lastWidth = widthKey;
    }
    const cursorTime = view.cursor;
    for (const plot of plots) {
      const x = (cursorTime - plot.window[0]) / (plot.window[1] - plot.window[0]) * plot.width;
      plot.cursor.setAttribute('x1', x); plot.cursor.setAttribute('x2', x); plot.cursor.style.display = finite(cursorTime) && x >= 0 && x <= plot.width ? '' : 'none';
      const values = plot.lines.map(line => {
        let low = 0, high = line.points.length;
        while (low < high) { const mid = (low + high) >>> 1; if (line.points[mid].t <= cursorTime) low = mid + 1; else high = mid; }
        return fmt(line.points[low - 1]?.y);
      });
      plot.readings.textContent = values.join(' / ');
    }
  }
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { resizeVersion++; }) : null;
  observer?.observe(rightContainer); observer?.observe(bottomContainer);
  update();
  return { update, destroy() { observer?.disconnect(); rightContainer.replaceChildren(); bottomContainer.replaceChildren(); } };
}
