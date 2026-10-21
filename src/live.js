import { targetWorldPosition, targetWorldOffset } from './target-gizmo.js';

// The API uses native joint values and full robot-root coordinates. No sign or
// frame conversions belong in the browser.
import { createLiveHistory } from './live-history.js';
import { DEFAULT_EXECUTION, validateExecution, intervalSeverity, intervalDescription, createHistoryClock } from './live-execution.js';
export function cloneSettings(value) {
  return JSON.parse(JSON.stringify(value));
}

export function readPath(value, path) {
  return path.split('.').reduce((item, key) => item?.[key], value);
}

export function writePath(value, path, next) {
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((item, key) => item[key], value);
  parent[last] = next;
}

export function initialLiveSettings(schema) {
  if (!Array.isArray(schema.available_N) || !schema.available_N.length) {
    throw new Error('No knot counts are ready. Run visualizer setup, restart its server, then reload this page. Replay is available.');
  }
  if (!schema.available_N.every((value) => Number.isInteger(value) && value > 1)) {
    throw new Error('The live knot-count list is invalid. Restart the visualizer server and reload this page.');
  }
  const settings = cloneSettings(schema.defaults);
  if (!settings?.config || typeof settings.config !== 'object') throw new Error('The live settings could not load.');
  if (!schema.available_N.includes(settings.config.N)) settings.config.N = schema.available_N[0];
  return settings;
}

export function parseParameter(parameter, input) {
  if (parameter.kind === 'bool') return input.checked;
  if (parameter.kind === 'choice') {
    const index = Number(input.value);
    if (String(input.value).trim() === '' || !Number.isInteger(index) || index < 0 || index >= parameter.choices.length) {
      throw new Error(`${parameter.label || parameter.path || 'Setting'} needs an available choice.`);
    }
    const choice = parameter.choices[index];
    const value = choice && typeof choice === 'object' && 'value' in choice ? choice.value : choice;
    if (value === undefined) throw new Error(`${parameter.label || parameter.path || 'Setting'} needs an available choice.`);
    return value;
  }
  if (input.value.trim() === '') throw new Error(`${parameter.label} needs a value.`);
  const value = Number(input.value);
  if (!Number.isFinite(value) || (parameter.kind === 'int' && !Number.isInteger(value))) {
    throw new Error(`${parameter.label} needs a finite ${parameter.kind === 'int' ? 'integer' : 'number'}.`);
  }
  if (parameter.min != null && value < parameter.min) throw new Error(`${parameter.label} must be at least ${parameter.min}.`);
  if (parameter.max != null && value > parameter.max) throw new Error(`${parameter.label} must be at most ${parameter.max}.`);
  return value;
}

export function maxViolation(value) {
  const values = Array.isArray(value) ? value.flat(Infinity) : [value];
  const finite = values.filter((item) => typeof item === 'number' && Number.isFinite(item));
  return finite.length ? Math.max(0, ...finite) : null;
}

export function validPoints(points) {
  return Array.isArray(points) && points.length > 0 && points.every((point) =>
    Array.isArray(point) && point.length === 3 && point.every(Number.isFinite));
}

export function setupLive({ onMode, onPlan, onState, onReset }) {
  const $ = id => document.getElementById(id);
  let schema, settings, submittedSettings, source, state, plan, presentedState, renderedPlan;
  let mode = 'replay', status = 'idle', liveReady = false, pending = false, dirty = false;
  let settingsVersion, expectedVersion, needsInitialPreview = false, settingsTimer, submission = 0;
  let historyEpoch = 0;
  let generation = null, cursor = 0, historyComplete = false, fetching = false, fetchAgain = false;
  let historyRevision = 0, paintedRevision = -1, job = {}, extensionPending = false, extensionStartTime = null, frozenAnchor;
  let inspectingPreview = false, inspectionPlan = null;
  let defaultTargetWorld, renderDirty = true, traceRevision = -1, displayPath = { points: [], stride: 1 };
  const history = createLiveHistory({ maxSamples: Infinity, maxSeconds: Infinity, maxPlans: Infinity }), clock = createHistoryClock(), inputs = [];
  const number = (value, precision = 0) => Number.isFinite(value) ? value.toFixed(precision) : '—';
  const message = (text, error = false) => { $('live-message').textContent = text; $('live-message').classList.toggle('error', error); };
  const connected = () => liveReady && source?.readyState === EventSource.OPEN && !needsInitialPreview;
  const displayedAnchor = () => {
    const value = presentedState || history.at(clock.time)?.state || state;
    return value && Array.isArray(value.q) && Array.isArray(value.qd)
      ? { sim_time_s: value.sim_time_s, q: [...value.q], qd: [...value.qd] } : undefined;
  };
  async function send(command) {
    try {
      const response = await fetch('/api/live/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
      const result = await response.json();
      if (!response.ok || !result.accepted) throw new Error(result.error || `HTTP ${response.status}`);
      return result;
    } catch (error) { message(`Command failed: ${error.message}`, true); return false; }
  }
  function controlsEnabled() {
    const unavailable = !connected();
    $('live-play').disabled = unavailable || (!clock.playing && pending && history.length < 2);
    $('live-preview').disabled = unavailable;
    $('live-reset').disabled = unavailable;
    $('live-precalculate').disabled = unavailable;
    $('live-cancel').disabled = unavailable || (!job.job_active && !pending);
    $('live-play').textContent = clock.playing ? 'Pause' : 'Play';
    $('live-play').setAttribute('aria-label', clock.playing ? 'Pause live history' : 'Play live history');
    refreshHistoryControls();
  }
  function readSettings(reportErrors = false) {
    const next = cloneSettings(settings);
    try {
      for (const { parameter, input } of inputs) {
        input.setCustomValidity('');
        try { writePath(next.config, parameter.path, parseParameter(parameter, input)); }
        catch (error) { input.setCustomValidity(error.message); if (reportErrors) input.reportValidity(); throw error; }
      }
      if (!schema.available_N.includes(next.config.N)) throw new Error('Choose an available knot count.');
      const kind = $('live-task').value, descriptor = schema.tasks?.find(task => task.kind === kind);
      next.task = { ...(descriptor?.defaults || { kind: 'reach' }), kind };
      for (const parameter of descriptor?.parameters || []) next.task[parameter.path] = parseParameter(parameter, document.querySelector(`[data-task-path="${parameter.path}"]`));
      next.task.target_offset_m = [0, 1, 2].map(i => {
        const input = $(`target-offset-${i}`), value = Number(input.value);
        if (!input.value.trim() || !Number.isFinite(value)) throw new Error('Target offsets need finite values in metres.');
        return value;
      });
      const execution = { ...DEFAULT_EXECUTION, ...next.execution };
      for (const [key, id] of [['simulation_hz', 'live-simulation-hz'], ['control_hz', 'live-control-hz'], ['to_hz', 'live-to-hz'], ['duration_s', 'live-duration']]) {
        if ($(id).value === '') throw new Error(`${key.replaceAll('_', ' ')} needs a value.`);
        execution[key] = Number($(id).value);
      }
      execution.calculation = $('live-calculation').value || execution.calculation;
      execution.continue_at_end = Boolean($('live-continue').checked);
      next.execution = validateExecution(execution);
    } catch (error) { if (reportErrors) message(error.message, true); return null; }
    return next;
  }
  async function submitSettings() {
    clearTimeout(settingsTimer);
    if (mode !== 'live' || !liveReady) return false;
    const next = readSettings(true);
    if (!next) return false;
    settings = next; submittedSettings = cloneSettings(next); pending = true; dirty = false;
    expectedVersion = Math.max(expectedVersion ?? 0, settingsVersion ?? 0) + 1;
    const request = ++submission;
    const anchor = frozenAnchor || displayedAnchor();
    clock.pause(); controlsEnabled(); refreshPlanLabel();
    message(next.execution.calculation === 'automatic' ? 'Replacing calculation from the displayed starting state…' : 'Updating one-horizon preview…');
    const accepted = await send({ type: 'set_settings', ...next, ...(anchor ? { anchor } : {}) });
    if (request !== submission) return Boolean(accepted);
    if (!accepted) { pending = false; dirty = true; }
    else {
      if (Number.isInteger(accepted.settings_version)) expectedVersion = accepted.settings_version;
      if (accepted.generation != null) useGeneration(accepted.generation, true);
      pending = !plan || plan.settings_version < expectedVersion;
    }
    controlsEnabled(); refreshPlanLabel(); return Boolean(accepted);
  }
  function change() {
    if (!dirty && !pending) frozenAnchor = displayedAnchor();
    settings = readSettings() || settings;
    dirty = true; renderDirty = true; clock.pause(); refreshPlanLabel();
    message('Settings changed · replacing obsolete calculation…');
    clearTimeout(settingsTimer); settingsTimer = setTimeout(submitSettings, 350);
  }
  function populate() {
    const tasks = schema.tasks || [{ kind: 'reach', label: 'Reaching', defaults: { kind: 'reach' } }];
    $('live-task').replaceChildren(...tasks.map(task => { const option = document.createElement('option'); option.value = task.kind; option.textContent = task.label; return option; }));
    $('live-task').value = settings.task.kind;
    const taskFields = () => {
      const descriptor = tasks.find(task => task.kind === $('live-task').value);
      $('live-task-parameters').replaceChildren();
      for (const parameter of descriptor?.parameters || []) {
        const label = document.createElement('label'); label.className = 'parameter-row';
        const caption = document.createElement('span'); caption.textContent = parameter.label;
        const input = document.createElement('input'); input.type = 'number'; input.step = 'any'; input.required = true;
        input.dataset.taskPath = parameter.path; input.min = parameter.min; input.max = parameter.max;
        input.value = settings.task.kind === descriptor.kind ? settings.task[parameter.path] : descriptor.defaults[parameter.path];
        input.addEventListener('input', change); label.append(caption, input); $('live-task-parameters').append(label);
      }
      $('live-task-note').textContent = descriptor?.kind === 'figure8' ? 'Horizontal figure eight in world XY. Offsets move the path; Reset restarts its phase.' : 'Offset from the default reaching target. Click the target to move it along an axis.';
    };
    taskFields(); $('live-task').addEventListener('change', () => { taskFields(); change(); });
    const groups = new Map();
    for (const supplied of schema.parameters) {
      const parameter = { ...supplied, path: supplied.path.replace(/^config\./, '') };
      // Retain this upstream value in the complete config, without a timing UI.
      if (parameter.path.endsWith('warm_start')) continue;
      if (parameter.path === 'N') { parameter.kind = 'choice'; parameter.choices = schema.available_N; }
      const name = parameter.group || 'Settings';
      if (!groups.has(name)) {
        const details = document.createElement('details'); details.className = 'settings-group'; details.open = groups.size === 0;
        const summary = document.createElement('summary'); summary.textContent = name;
        const fields = document.createElement('div'); fields.className = 'settings-fields'; details.append(summary, fields); $('live-settings').append(details); groups.set(name, fields);
      }
      const label = document.createElement('label'); label.className = 'parameter-row';
      const text = document.createElement('span'); text.textContent = parameter.label || parameter.path;
      const input = document.createElement(parameter.kind === 'choice' ? 'select' : 'input'); input.dataset.path = parameter.path; input.name = parameter.path;
      const value = readPath(settings.config, parameter.path);
      if (parameter.kind === 'choice') {
        for (const [i, choice] of parameter.choices.entries()) {
          const item = document.createElement('option'), object = choice && typeof choice === 'object', typedValue = object && 'value' in choice ? choice.value : choice;
          item.value = String(i); item.textContent = object ? choice.label || String(typedValue ?? 'Default') : String(choice ?? 'Default'); item.selected = Object.is(typedValue, value); input.append(item);
        }
      } else if (parameter.kind === 'bool') { input.type = 'checkbox'; input.checked = Boolean(value); }
      else { input.type = 'number'; input.step = parameter.kind === 'int' ? '1' : 'any'; if (parameter.min != null) input.min = parameter.min; if (parameter.max != null) input.max = parameter.max; input.value = value; input.required = true; }
      input.disabled = Boolean(parameter.disabled); input.title = parameter.path; input.addEventListener('input', change);
      label.append(text, input); groups.get(name).append(label); inputs.push({ parameter, input });
    }
    settings.task.target_offset_m.forEach((value, i) => { $(`target-offset-${i}`).value = value; $(`target-offset-${i}`).addEventListener('input', change); });
    settings.execution = validateExecution({ ...DEFAULT_EXECUTION, ...(schema.defaults.execution || {}) });
    for (const [key, id] of [['simulation_hz', 'live-simulation-hz'], ['control_hz', 'live-control-hz'], ['to_hz', 'live-to-hz'], ['duration_s', 'live-duration'], ['calculation', 'live-calculation']]) { $(id).value = settings.execution[key]; $(id).addEventListener('input', change); }
    $('live-continue').checked = settings.execution.continue_at_end;
    $('live-continue').addEventListener('change', () => { settings.execution.continue_at_end = $('live-continue').checked; });
    const commit = schema.source?.mpc_commit;
    $('live-source').textContent = `tiago_mpc ${commit ? String(commit).slice(0, 8) : 'local'} · prebuilt N: ${schema.available_N.join(', ')}`;
    $('live-mode').disabled = false; message('Choose Live MPC to compute a prediction.');
  }
  function useGeneration(next, force = false) {
    if (!force && generation != null && next < generation) return false;
    if (!force && next === generation) return true;
    historyEpoch++;
    generation = next; cursor = 0; historyComplete = false; history.clear(); historyRevision++; paintedRevision = -1;
    state = undefined; clock.seek(null); extensionPending = false; renderedPlan = undefined; renderDirty = true;
    fetchHistory();
    return true;
  }
  async function fetchHistory() {
    if (generation == null || mode !== 'live') return;
    if (fetching) { fetchAgain = true; return; }
    fetching = true;
    try {
      let more = true;
      while (more && mode === 'live') {
        const requestedGeneration = generation, requestedCursor = cursor, requestedEpoch = historyEpoch;
        const response = await fetch(`/api/live/history?generation=${encodeURIComponent(generation)}&after=${cursor}&limit=256`);
        const batch = await response.json();
        if (requestedGeneration !== generation || requestedEpoch !== historyEpoch) continue;
        if (response.status === 409) { if (batch.generation != null) useGeneration(batch.generation); break; }
        if (!response.ok) throw new Error(batch.error || 'History unavailable');
        if (batch.generation !== generation || requestedCursor !== cursor) continue;
        const records = batch.records || [];
        let appliedRecords = 0;
        for (const record of records) {
          if (record.generation !== generation || (expectedVersion != null && record.settings_version < expectedVersion)) continue;
          history.addRecord(record); appliedRecords++;
          if (record.type === 'state') state = record;
          if (record.type === 'plan') plan = record;
        }
        const nextCursor = batch.next_cursor;
        more = Number.isInteger(nextCursor) && nextCursor > cursor && records.length >= 256;
        if (Number.isInteger(nextCursor)) cursor = nextCursor;
        historyComplete = Boolean(batch.complete);
        if (extensionPending && historyComplete && history.bounds[1] > extensionStartTime + 1e-8) extensionPending = false;
        if (appliedRecords) historyRevision++; renderDirty = true;
        if (!clock.playing && clock.time == null && history.length) clock.seek(history.bounds[0]);
      }
    } catch (error) { message(`History download failed: ${error.message}`, true); }
    finally { fetching = false; if (fetchAgain) { fetchAgain = false; fetchHistory(); } controlsEnabled(); }
  }
  function receive(event) {
    let item; try { item = JSON.parse(event.data); } catch { message('Invalid live event.', true); return; }
    if (!needsInitialPreview && generation != null && item.generation != null && item.generation < generation) return;
    if (!needsInitialPreview && item.type === 'status' && expectedVersion != null && item.settings_version < expectedVersion) return;
    if (item.type === 'status') {
      status = item.state; job = item;
      if (Number.isInteger(item.settings_version)) settingsVersion = Math.max(settingsVersion ?? 0, item.settings_version);
      $('live-status').textContent = status.replaceAll('_', ' ').toUpperCase();
      $('live-status').classList.toggle('is-playing', Boolean(item.job_active)); $('live-status').classList.toggle('error', status === 'error' || status === 'gpu_busy');
      if (item.generation != null && !needsInitialPreview && (expectedVersion == null || item.settings_version >= expectedVersion)) useGeneration(item.generation);
      if (item.message) message(item.message, status === 'error');
      if (status === 'error' || status === 'gpu_busy') { pending = false; extensionPending = false; clock.pause(); }
      // A queued Play can receive the preceding preview's paused status first.
      // Keep its intent until generation actually starts (or fails).
      if (item.job_active) extensionPending = false;
      if (needsInitialPreview) {
        needsInitialPreview = false;
        if (!dirty && expectedVersion != null && item.settings_version === expectedVersion && plan?.settings_version === expectedVersion) {
          if (item.generation != null) useGeneration(item.generation);
          fetchHistory();
        } else submitSettings();
      }
      renderDirty = true; controlsEnabled();
    } else if (item.type === 'history') {
      if (needsInitialPreview || (expectedVersion != null && item.settings_version < expectedVersion)) return;
      if (!useGeneration(item.generation)) return; historyComplete = Boolean(item.complete); renderDirty = true;
      if (!Number.isInteger(item.history_cursor) || item.history_cursor > cursor || !history.length) fetchHistory();
    } else if (item.type === 'plan') {
      if (needsInitialPreview || (expectedVersion != null && item.settings_version < expectedVersion)) return;
      if (!validPoints(item.ee_xyz) || !validPoints(item.reference_xyz)) return;
      plan = item;
      if (inspectingPreview && item.origin === 'preview') inspectionPlan = item;
      if (generation == null) history.addPlan(item);
      if (Number.isInteger(item.settings_version)) settingsVersion = Math.max(settingsVersion ?? 0, item.settings_version);
      if (pending && item.settings_version >= expectedVersion) { pending = false; if (!dirty) frozenAnchor = undefined; }
      if (!defaultTargetWorld && (item.task_kind || submittedSettings?.task.kind) === 'reach' && submittedSettings) defaultTargetWorld = item.reference_xyz[0].map((value, i) => value - submittedSettings.task.target_offset_m[i]);
      renderDirty = true; controlsEnabled(); if (!clock.playing) renderView();
    } else if (item.type === 'state') {
      if (needsInitialPreview || (expectedVersion != null && item.settings_version < expectedVersion)) return;
      if (!Number.isFinite(item.sim_time_s) || !Array.isArray(item.q) || !validPoints([item.ee_xyz])) return;
      if (generation == null) { state = item; history.addState(item); historyRevision++; }
      renderDirty = true; if (!clock.playing) renderView();
    } else if (item.type === 'error') {
      pending = false; extensionPending = false; job = { ...job, job_active: false }; clock.pause();
      message(item.message || item.detail || 'Live solver error.', true); controlsEnabled(); renderDirty = true;
    }
  }
  function refreshPlanLabel(shownPlan = plan) {
    const historical = clock.time != null && clock.time < history.bounds[1] - 1e-7;
    const stale = needsInitialPreview || dirty || pending || (shownPlan && expectedVersion != null && shownPlan.settings_version < expectedVersion);
    $('live-plan-label').textContent = stale ? 'Previous prediction · settings pending' : shownPlan ? `${historical ? 'History' : shownPlan.origin === 'preview' ? 'Preview' : 'Closed-loop'} · plan ${shownPlan.seq} · settings v${shownPlan.settings_version}` : 'Waiting for a prediction';
    $('live-plan-label').classList.toggle('stale', stale);
  }
  function paintIntervals() {
    if (paintedRevision === historyRevision) return;
    paintedRevision = historyRevision;
    const [start, end] = history.bounds, span = end - start;
    const segments = [];
    // Merge adjacent matching causes into a small number of paint elements.
    for (const interval of history.intervals) {
      const severity = intervalSeverity(interval); if (severity === 'normal') continue;
      const left = Math.max(start, interval.start_time_s), right = Math.min(end, interval.end_time_s);
      if (right <= left) continue;
      const previous = segments.at(-1);
      if (previous?.severity === severity && Math.abs(previous.end - left) < 1e-8) previous.end = right;
      else segments.push({ start: left, end: right, severity });
    }
    $('live-history-intervals').replaceChildren(...segments.map(segment => {
      const el = document.createElement('span'); el.className = segment.severity;
      el.style.left = `${100 * Math.max(0, segment.start - start) / (span || 1)}%`; el.style.width = `${100 * (Math.min(end, segment.end) - Math.max(start, segment.start)) / (span || 1)}%`; return el;
    }));
  }
  function refreshHistoryControls() {
    const [start, end] = history.bounds, timeline = $('live-history'), time = clock.time ?? end;
    timeline.min = start; timeline.max = end; timeline.value = Math.max(start, Math.min(end, time)); timeline.disabled = history.length < 2;
    timeline.style.setProperty('--progress', `${end > start ? 100 * (time - start) / (end - start) : 0}%`);
    $('live-history-latest').disabled = !history.length || Math.abs(time - end) < 1e-8;
    $('live-history-position').textContent = history.length ? `${number(time, 2)} / ${number(end, 2)} s` : 'No state history yet';
    const interval = history.intervals.find(value => value.start_time_s <= time && value.end_time_s > time) || history.intervals.at(-1);
    if (!timeline.matches?.(':hover')) timeline.title = interval ? intervalDescription(interval) : 'Recorded simulation time';
    timeline.setAttribute('aria-valuetext', `${number(time, 3)} seconds${interval ? ` · ${intervalDescription(interval)}` : ''}`);
    $('live-history-window').textContent = `Retained ${number(start, 2)}–${number(end, 2)} s · ${history.length} states · display path ≤5000 points${fetching ? ' · downloading recording' : ''}${historyComplete ? ' · calculation complete' : job.job_active ? ` · calculating ${number((job.progress || 0) * 100)}%` : ''}`;
    $('live-history-note').textContent = clock.playing ? 'History playback at 1×. At the recorded end, calculation may limit progress.' : 'Scrub or Play recorded history. Go latest only moves the view; Continue controls new motion at the end.';
    paintIntervals();
  }
  function renderView() {
    const selected = history.interpolateAt(clock.time, { trace: false });
    if (traceRevision !== historyRevision) { displayPath = history.displayPath(); traceRevision = historyRevision; }
    const shownState = selected?.state || state, shownPlan = inspectingPreview ? inspectionPlan || plan : selected?.plan || plan;
    const stats = shownPlan?.stats || {};
    for (const [id, value] of [['live-sqp', stats.sqp_iters], ['live-pcg', stats.pcg_iters], ['live-admm', stats.admm_iters], ['live-linsys', stats.admm_linsys_iters]]) $(id).textContent = number(value);
    $('live-solve').textContent = number(stats.solve_time_ms, 2);
    const violation = maxViolation(stats.row_violation); $('live-violation').textContent = violation == null ? '—' : violation.toExponential(2);
    $('live-horizon').textContent = shownPlan ? `${shownPlan.N} knots · ${number(shownPlan.dt_s * 1000, 1)} ms · horizon ${number(shownPlan.dt_s * (shownPlan.N - 1), 2)} s` : 'No prediction';
    $('live-restarted').hidden = !stats.controller_restarted;
    $('live-sim-time').textContent = number(shownState?.sim_time_s, 2);
    $('live-rtf').textContent = Number.isFinite(job.calculation_rtf) ? `${number(job.calculation_rtf, 2)}×` : '—';
    $('live-playback-rate').textContent = clock.playing ? (clock.time >= history.bounds[1] - 1e-7 && (job.job_active || extensionPending) ? 'Waiting' : '1×') : 'Paused';
    $('live-distance').textContent = Number.isFinite(shownState?.distance_m) ? `${number(shownState.distance_m * 1000, 1)} mm` : '—';
    $('live-arrival').textContent = shownState?.arrived ? 'Arrival flag reached · holding target' : 'Following task reference';
    const execution = settings?.execution || DEFAULT_EXECUTION;
    $('live-rates').textContent = `Nominal simulated Hz: TO ${number(execution.to_hz)} · control ${number(execution.control_hz)} · physics ${number(execution.simulation_hz)}. Achieved per calculation-wall second: TO ${number(job.mpc_hz, 1)} · control ${number(job.control_hz, 1)} · physics ${number(job.simulation_hz, 1)}.`;
    $('live-play').classList.toggle('compute-limited', clock.playing && clock.time >= history.bounds[1] - .001 && Boolean(job.job_active) && job.calculation_rtf < .99);
    refreshPlanLabel(shownPlan); refreshHistoryControls();
    if (mode === 'live') {
      if (renderedPlan !== (shownPlan || null)) { onPlan(shownPlan || null); renderedPlan = shownPlan || null; }
      if (shownState) {
        const tracePoints = selected ? displayPath.points : [shownState.ee_xyz];
        const traceCount = selected ? Math.min(tracePoints.length, Math.floor(selected.index / displayPath.stride) + 1 + (selected.index === history.length - 1 && selected.index % displayPath.stride ? 1 : 0)) : 1;
        onState(shownState, { tracePoints, traceCount, historical: clock.time != null && clock.time < history.bounds[1] - 1e-7, interpolated: Boolean(shownState.render_interpolated) }); presentedState = shownState;
      }
    }
    renderDirty = false;
  }
  async function extendHistory() {
    if (extensionPending || job.job_active) return true;
    if (!connected()) return false;
    const previousJob = job, previousComplete = historyComplete;
    extensionPending = true; extensionStartTime = history.bounds[1];
    job = { ...job, job_active: true }; historyComplete = false;
    const result = await send({ type: 'play' });
    if (!result) {
      extensionPending = false; job = previousJob; historyComplete = previousComplete;
      clock.pause(); controlsEnabled();
    }
    else {
      if (result.generation != null) useGeneration(result.generation);
    }
    return Boolean(result);
  }
  function frame(timestamp) {
    if (mode !== 'live') return;
    if (clock.playing) {
      const tick = clock.tick(timestamp, history.bounds);
      if (tick.atEnd && !job.job_active && !fetching) {
        if (settings.execution.continue_at_end) extendHistory();
        else if (!extensionPending) { clock.pause(); controlsEnabled(); }
      }
      renderDirty = true;
    }
    if (renderDirty) renderView();
  }
  function showLatest() { inspectingPreview = false; clock.seek(history.bounds[1]); renderView(); }
  async function switchMode(next) {
    if (next === mode || (next === 'live' && !liveReady)) return;
    clearTimeout(settingsTimer); submission++; mode = next; clock.pause();
    document.body.classList.toggle('live-mode', mode === 'live');
    for (const id of ['live-panel', 'live-controls']) $(id).hidden = mode !== 'live';
    for (const id of ['replay-section', 'replay-controls']) $(id).hidden = mode === 'live';
    for (const name of ['replay', 'live']) { $(`${name}-mode`).classList.toggle('active', name === mode); $(`${name}-mode`).setAttribute('aria-pressed', name === mode); }
    $('mode-label').textContent = mode === 'live' ? 'LIVE MPC · SIMULATION' : 'TRAJECTORY REPLAY'; onMode(mode);
    if (mode === 'live') {
      needsInitialPreview = true;
      const connection = new EventSource('/api/live/events'); source = connection; controlsEnabled(); refreshPlanLabel();
      connection.onmessage = event => { if (source === connection && mode === 'live') receive(event); };
      connection.onopen = () => { controlsEnabled(); message('Connected · waiting for solver status…'); };
      connection.onerror = () => { controlsEnabled(); message('Live stream disconnected · reconnecting. Playback remains local.', true); };
      renderView();
    } else if (source) { const connection = source; source = null; connection.close(); pending = false; needsInitialPreview = false; await send({ type: 'pause' }); }
  }
  $('replay-mode').addEventListener('click', () => switchMode('replay'));
  $('live-mode').addEventListener('click', () => switchMode('live'));
  $('live-preview').addEventListener('click', async () => {
    clock.pause();
    const anchor = displayedAnchor();
    if (dirty && !await submitSettings()) return;
    inspectingPreview = true; inspectionPlan = null; pending = true; refreshPlanLabel();
    const result = await send({ type: 'preview', ...(anchor ? { anchor } : {}) });
    if (!result) pending = false;
    controlsEnabled(); renderView();
  });
  $('live-precalculate').addEventListener('click', async () => {
    clock.pause(); if (dirty && !await submitSettings()) return;
    const anchor = frozenAnchor || displayedAnchor();
    const result = await send({ type: 'precalculate', ...(anchor ? { anchor } : {}) });
    if (result?.generation != null) useGeneration(result.generation);
  });
  $('live-cancel').addEventListener('click', async () => {
    if (await send({ type: 'cancel' })) {
      pending = false; extensionPending = false; job = { ...job, job_active: false }; clock.pause();
      message('Cancellation requested · stopping after the current numerical operation.');
      controlsEnabled(); renderView();
    }
  });
  $('live-play').addEventListener('click', async () => {
    inspectingPreview = false;
    clearTimeout(settingsTimer);
    if (clock.playing) {
      clock.pause(); extensionPending = false;
      await send({ type: 'pause' });
      if (settings.execution.calculation === 'on_play') { pending = false; job = { ...job, job_active: false }; }
      controlsEnabled(); renderView(); return;
    }
    if (dirty && !await submitSettings()) return;
    const noMotion = history.length < 2;
    if (clock.time == null) clock.seek(history.bounds[0]);
    if (noMotion || (clock.time >= history.bounds[1] - 1e-7 && settings.execution.continue_at_end)) { if (!await extendHistory()) return; }
    clock.play(performance.now()); controlsEnabled(); renderView();
  });
  $('live-reset').addEventListener('click', async () => {
    clearTimeout(settingsTimer); clock.pause(); frozenAnchor = undefined;
    if (dirty && !await submitSettings()) return;
    history.clear(); historyRevision++; plan = null; state = undefined; presentedState = undefined; clock.seek(null); onReset();
    const result = await send({ type: 'reset' }); if (result?.generation != null) useGeneration(result.generation); renderView();
  });
  $('live-history').addEventListener('input', event => { if (!event.target.disabled) { inspectingPreview = false; clock.seek(Number(event.target.value)); renderView(); } });
  $('live-history').addEventListener('pointermove', event => {
    const bounds = event.target.getBoundingClientRect(), [start, end] = history.bounds;
    const time = start + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * (end - start);
    const interval = history.intervals.find(value => value.start_time_s <= time && value.end_time_s > time);
    event.target.title = `${number(time, 3)} s · ${interval ? intervalDescription(interval) : 'Recorded simulation time'}`;
  });
  $('live-history-latest').addEventListener('click', showLatest);
  fetch('/api/live/schema').then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Live settings unavailable.'); schema = result; settings = initialLiveSettings(schema); liveReady = true; populate(); }).catch(error => { liveReady = false; controlsEnabled(); $('live-mode').disabled = true; $('live-mode').title = error.message; $('live-availability').textContent = `Live MPC needs setup: ${error.message}`; });
  return {
    get targetInteraction() {
      const offset = [0, 1, 2].map(i => Number($(`target-offset-${i}`).value));
      const available = mode === 'live' && (clock.time == null || clock.time >= history.bounds[1] - 1e-7) && $('live-task').value === 'reach' && connected() && Boolean(defaultTargetWorld) && settings.task.kind === 'reach' && offset.every(value => Number.isFinite(value) && Math.abs(value) <= 1) && [0, 1, 2].every(i => $(`target-offset-${i}`).value.trim() !== '') && status !== 'gpu_busy' && status !== 'error';
      return { available, position_world: defaultTargetWorld ? targetWorldPosition(defaultTargetWorld, offset) : null, pending: dirty || pending, offset_m: offset };
    },
    setTargetWorld(position) { if (!this.targetInteraction.available) return null; const offset = targetWorldOffset(defaultTargetWorld, position); if (!offset) return null; offset.forEach((value, i) => { $(`target-offset-${i}`).value = String(Number(value.toFixed(6))); }); change(); return this.targetInteraction.position_world; },
    get mode() { return mode; }, get plan() { return plan; }, get state() { return state; }, get displayedState() { return presentedState || history.at(clock.time)?.state || state; },
    get history() { return { length: history.length, bounds: history.bounds, selectedTime: clock.time, limits: history.limits, generation, cursor, complete: historyComplete, intervals: history.intervals }; },
    get fitAvailable() { return Boolean(history.length || plan?.ee_xyz?.length || plan?.task_path_xyz?.length); },
    get precomputedPath() { return historyComplete && !fetching && history.length > 1 && settings.execution.calculation !== 'on_play' ? history.pathPoints : undefined; },
    get settings() { return settings ? cloneSettings(settings) : null; }, get status() { return status; },
    get pending() { return pending || (mode === 'live' && !connected()); }, get playing() { return clock.playing; },
    frame, togglePlay: () => { if (mode === 'live' && !$('live-play').disabled) $('live-play').click(); },
  };
}
