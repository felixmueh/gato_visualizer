import { createSettingResets, canonicalOrientation, settingValuesEqual } from './setting-resets.js';
import { targetWorldPosition, targetWorldOffset, normalizeQuaternion } from './target-gizmo.js';
import { taskReference, taskReferencePoint } from './task-reference.js';

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
    throw new Error('No knot counts are ready. Open Source / Build settings to select a compatible cache or build them. Replay is available.');
  }
  if (!schema.available_N.every((value) => Number.isInteger(value) && value > 1)) {
    throw new Error('The live knot-count list is invalid. Restart the visualizer server and reload this page.');
  }
  const settings = cloneSettings(schema.defaults);
  if (!settings?.config || typeof settings.config !== 'object') throw new Error('The live settings could not load.');
  if (!schema.available_N.includes(settings.config.N)) settings.config.N = schema.available_N[0];
  return settings;
}

export function restoreCompatibleSettings(schema, saved) {
  const settings = initialLiveSettings(schema);
  if (!saved || typeof saved !== 'object') return settings;
  for (const parameter of schema.parameters || []) {
    const path = parameter.path.replace(/^config\./, ''), value = readPath(saved.config, path);
    if (value === undefined) continue;
    try {
      if (parameter.kind === 'choice') {
        const choices = path === 'N' ? schema.available_N : parameter.choices;
        if (!choices.some(choice => Object.is(choice && typeof choice === 'object' && 'value' in choice ? choice.value : choice, value))) continue;
      } else if (parameter.kind === 'bool') {
        if (typeof value !== 'boolean') continue;
      } else {
        if (typeof value !== 'number') continue;
        parseParameter(parameter, { value: String(value) });
      }
      writePath(settings.config, path, value);
    } catch { /* A source can remove or narrow settings; retain its own default. */ }
  }
  const task = (schema.tasks || []).find(item => item.kind === saved.task?.kind);
  if (task) {
    settings.task = { ...cloneSettings(task.defaults || {}), kind: task.kind };
    const offset = saved.task.target_offset_m;
    settings.task.target_offset_m = Array.isArray(offset) && offset.length === 3 && offset.every(value => Number.isFinite(value) && Math.abs(value) <= 1) ? [...offset] : settings.task.target_offset_m || [0, 0, 0];
    for (const parameter of task.parameters || []) {
      const value = saved.task[parameter.path];
      if (typeof value !== 'number') continue;
      try { settings.task[parameter.path] = parseParameter({ kind: 'float', ...parameter }, { value: String(value) }); } catch {}
    }
    const orientation = normalizeQuaternion(saved.task.orientation_xyzw);
    if (orientation && task.kind === 'figure8') settings.task.orientation_xyzw = orientation;
  }
  try { settings.execution = validateExecution(saved.execution); } catch {}
  return settings;
}

export function solverProfileSettings(schema, saved) {
  const restored = restoreCompatibleSettings(schema, saved);
  // A profile switch must not silently replace the user's horizon. An
  // unsupported N remains visible until the user explicitly chooses another.
  if (Number.isInteger(saved?.config?.N)) restored.config.N = saved.config.N;
  return restored;
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

export function setupLive({ onMode, onPlan, onState, onReset, onReference = () => {}, onSolverProfile = () => {} }) {
  const $ = id => document.getElementById(id);
  let schema, settings, defaultSettings, submittedSettings, source, state, plan, presentedState, renderedPlan;
  let mode = 'replay', status = 'idle', liveReady = false, pending = false, dirty = false;
  let settingsVersion, expectedVersion, needsInitialPreview = false, settingsTimer, submission = 0;
  let historyEpoch = 0, initialResetPending = true;
  let generation = null, cursor = 0, historyComplete = false, fetching = false, fetchAgain = false;
  let historyRevision = 0, paintedRevision = -1, job = {}, extensionPending = false, extensionStartTime = null, frozenAnchor;
  let inspectingPreview = false, inspectionPlan = null;
  let defaultTargetWorld, figure8BaseWorld, renderDirty = true, traceRevision = -1, displayPath = { points: [], stride: 1 };
  let desiredReference, referenceKey, renderedReference;
  let profileSwitching = false, profileUnavailable = false, profileNError = false, schemaReload = 0, suppressInitialPreview = false;
  let populationBindings = [];
  const latestServerEvents = new Map();
  const taskDrafts = new Map();
  const resetIndicators = createSettingResets();
  const history = createLiveHistory({ maxSamples: Infinity, maxSeconds: Infinity, maxPlans: Infinity }), clock = createHistoryClock(), inputs = [];
  const number = (value, precision = 0) => Number.isFinite(value) ? value.toFixed(precision) : '—';
  const message = (text, error = false) => { $('live-message').textContent = text; $('live-message').classList.toggle('error', error); };
  const connected = () => liveReady && !profileSwitching && !profileUnavailable && !profileNError && source?.readyState === EventSource.OPEN && !needsInitialPreview;
  const continueAtEnd = () => settings.execution.calculation === 'on_play' || settings.execution.continue_at_end;
  const acceptTaskAnchors = item => {
    if (validPoints([item?.task_anchors?.reach])) defaultTargetWorld = [...item.task_anchors.reach];
    if (validPoints([item?.task_anchors?.figure8])) figure8BaseWorld = [...item.task_anchors.figure8];
  };
  const displayedAnchor = () => {
    const value = presentedState || history.at(clock.time)?.state || state;
    return value && Array.isArray(value.q) && Array.isArray(value.qd)
      ? { sim_time_s: value.sim_time_s, q: [...value.q], qd: [...value.qd] } : undefined;
  };
  async function send(command) {
    if ((profileSwitching || profileUnavailable || profileNError) && !['pause', 'cancel'].includes(command.type)) return false;
    try {
      const response = await fetch('/api/live/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
      const result = await response.json();
      if (!response.ok || !result.accepted) throw new Error(result.error || `HTTP ${response.status}`);
      return result;
    } catch (error) { if (!profileSwitching) message(`Command failed: ${error.message}`, true); return false; }
  }
  function calculationControls() {
    const stop = $('live-stop-at-end'), continuous = settings?.execution?.calculation === 'on_play';
    stop.disabled = continuous;
    stop.title = continuous ? 'Live Play continues until paused. Stop at end applies to precalculated playback.'
      : 'Stop at the recorded end; uncheck to continue simulation';
    stop.closest('label')?.setAttribute('title', stop.title);
    $('live-duration').title = 'Precalculation duration; Live Play continues until paused.';
  }
  function controlsEnabled() {
    const unavailable = !connected();
    $('live-play').disabled = unavailable;
    $('live-preview').disabled = unavailable;
    $('live-reset').disabled = unavailable;
    $('live-precalculate').disabled = unavailable;
    $('live-cancel').disabled = unavailable || (!job.job_active && !pending);
    $('live-play').textContent = clock.playing ? 'Pause' : 'Play';
    $('live-play').setAttribute('aria-label', clock.playing ? 'Pause live history' : 'Play live history');
    calculationControls();
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
      next.task = { ...(descriptor?.defaults || { kind: 'reach' }), ...(settings.task.kind === kind ? settings.task : {}), kind };
      for (const parameter of descriptor?.parameters || []) {
        const input = document.querySelector(`[data-task-path="${parameter.path}"]`);
        input.setCustomValidity('');
        try { next.task[parameter.path] = parseParameter(parameter, input); }
        catch (error) { input.setCustomValidity(error.message); if (reportErrors) input.reportValidity(); throw error; }
      }
      next.task.target_offset_m = [0, 1, 2].map(i => {
        const input = $(`target-offset-${i}`), value = Number(input.value);
        input.setCustomValidity('');
        if (!input.value.trim() || !Number.isFinite(value) || Math.abs(value) > 1) {
          const error = 'Target offsets must be finite within −1 to 1 m.';
          input.setCustomValidity(error); if (reportErrors) input.reportValidity(); throw new Error(error);
        }
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
    if (mode !== 'live' || !liveReady || profileSwitching || profileUnavailable || profileNError) return false;
    const next = readSettings(true);
    if (!next) return false;
    settings = next; taskDrafts.set(next.task.kind, cloneSettings(next.task)); submittedSettings = cloneSettings(next); pending = true; dirty = false; inspectingPreview = false;
    const previousExpectedVersion = expectedVersion;
    expectedVersion = Math.max(expectedVersion ?? 0, settingsVersion ?? 0) + 1;
    const request = ++submission;
    const resetting = initialResetPending;
    const anchor = resetting ? undefined : frozenAnchor || displayedAnchor();
    clock.pause(); controlsEnabled(); refreshPlanLabel();
    message(next.execution.calculation === 'automatic' ? 'Replacing calculation from the displayed starting state…' : 'Updating one-horizon preview…');
    const accepted = await send({ type: 'set_settings', ...next, ...(resetting ? { reset: true } : anchor ? { anchor } : {}) });
    if (request !== submission) return Boolean(accepted);
    if (!accepted) { pending = false; dirty = true; expectedVersion = previousExpectedVersion; }
    else {
      if (resetting) { initialResetPending = false; onReset(); }
      if (Number.isInteger(accepted.settings_version)) expectedVersion = settingsVersion = accepted.settings_version;
      if (accepted.generation != null) useGeneration(accepted.generation, true);
      pending = !plan || plan.settings_version < expectedVersion;
      // A short job can finish before the POST response reaches this browser.
      // Reconcile its cached notices instead of waiting for another SSE event.
      const matching = ['status', 'history', 'plan', 'state'].map(type => latestServerEvents.get(type))
        .filter(item => item?.settings_version === expectedVersion);
      const notice = matching.find(item => item.generation != null);
      if (notice && generation != null && notice.generation < generation) useGeneration(notice.generation, true);
      for (const item of matching) receiveItem(item);
      if (generation != null) fetchHistory();
    }
    controlsEnabled(); refreshPlanLabel(); return Boolean(accepted);
  }
  function change() {
    if (!dirty && !pending) frozenAnchor = displayedAnchor();
    const next = readSettings();
    if (next) { settings = next; taskDrafts.set(next.task.kind, cloneSettings(next.task)); profileNError = false; }
    calculationControls();
    resetIndicators.update();
    dirty = true; renderDirty = true; clock.pause(); refreshPlanLabel();
    controlsEnabled();
    message(profileSwitching ? 'Solver switching · settings draft retained.' : profileUnavailable ? 'No solver is active · settings draft retained.' : 'Settings changed · replacing obsolete calculation…');
    clearTimeout(settingsTimer); if (!profileSwitching && !profileUnavailable) settingsTimer = setTimeout(submitSettings, 350);
  }
  function populate() {
    populationBindings.forEach(([input, type, callback]) => input.removeEventListener?.(type, callback)); populationBindings = [];
    resetIndicators.clear(); inputs.length = 0;
    $('live-settings').replaceChildren(); $('live-horizon-settings')?.replaceChildren();
    const listen = (input, type, callback) => { input.addEventListener(type, callback); populationBindings.push([input, type, callback]); };
    const resetInput = (input, value, parameter = {}) => {
      input.setCustomValidity('');
      if (parameter.kind === 'bool') input.checked = value;
      else if (parameter.kind === 'choice') input.value = parameter.choices.findIndex(choice => settingValuesEqual(choice && typeof choice === 'object' && 'value' in choice ? choice.value : choice, value));
      else input.value = String(value);
      input.dispatchEvent(new Event(parameter.event || 'input', { bubbles: true }));
    };
    const bindReset = (input, parameter, getDefault, { key = parameter.path, host, group = 'settings', event = 'input' } = {}) => resetIndicators.bind({
      key, name: parameter.label || parameter.path, input, host, group,
      getValue: () => parseParameter(parameter, input), getDefault,
      reset: value => resetInput(input, value, { ...parameter, event }),
    });
    const tasks = schema.tasks || [{ kind: 'reach', label: 'Reaching', defaults: { kind: 'reach' } }];
    $('live-task').replaceChildren(...tasks.map(task => { const option = document.createElement('option'); option.value = task.kind; option.textContent = task.label; return option; }));
    $('live-task').value = settings.task.kind;
    const activeTaskDefaults = () => {
      const kind = $('live-task').value, descriptor = tasks.find(task => task.kind === kind);
      const fallback = defaultSettings.task.kind === kind ? defaultSettings.task : {};
      return { ...fallback, ...descriptor?.defaults, kind,
        target_offset_m: descriptor?.defaults?.target_offset_m || fallback.target_offset_m || [0, 0, 0],
        orientation_xyzw: descriptor?.defaults?.orientation_xyzw || fallback.orientation_xyzw || [0, 0, 0, 1] };
    };
    const taskFields = () => {
      resetIndicators.forget('task-parameters');
      const descriptor = tasks.find(task => task.kind === $('live-task').value);
      $('live-task-parameters').replaceChildren();
      for (const parameter of descriptor?.parameters || []) {
        const label = document.createElement('label'); label.className = 'parameter-row';
        const caption = document.createElement('span'); caption.textContent = parameter.label;
        const input = document.createElement('input'); input.type = 'number'; input.step = 'any'; input.required = true;
        input.dataset.taskPath = parameter.path; input.min = parameter.min; input.max = parameter.max;
        input.value = settings.task.kind === descriptor.kind ? settings.task[parameter.path] : descriptor.defaults[parameter.path];
        listen(input, 'input', change); label.append(caption, input); $('live-task-parameters').append(label);
        bindReset(input, { ...parameter, kind: parameter.kind || 'float' }, () => activeTaskDefaults()[parameter.path], { key: `task.${parameter.path}`, group: 'task-parameters' });
      }
      const poseCaption = document.createElement('span'); poseCaption.className = 'task-pose-reset-caption'; poseCaption.textContent = 'Task pose';
      $('live-task-parameters').append(poseCaption);
      resetIndicators.bind({ key: 'task.pose', name: 'task pose', host: poseCaption, group: 'task-parameters', focusTarget: $('target-offset-0'),
        getValue: () => ({ offset: [0, 1, 2].map(i => parseParameter({ kind: 'float', label: 'Target offset', min: -1, max: 1 }, $(`target-offset-${i}`))),
          orientation: canonicalOrientation(settings.task.kind === $('live-task').value ? settings.task.orientation_xyzw : undefined) }),
        getDefault: () => ({ offset: activeTaskDefaults().target_offset_m, orientation: canonicalOrientation(activeTaskDefaults().orientation_xyzw) }),
        reset: value => {
          value.offset.forEach((offset, i) => { $(`target-offset-${i}`).value = String(offset); $(`target-offset-${i}`).setCustomValidity(''); });
          if ($('live-task').value === 'figure8') settings.task.orientation_xyzw = [...value.orientation];
          change();
        },
      });
      $('live-task-note').textContent = descriptor?.kind === 'figure8' ? 'G moves the path in world coordinates; R rotates and S scales width/height about its start. Period sets speed. Reset restarts phase.' : 'Offset from the default reaching target. Click the target to move it along an axis.';
    };
    taskDrafts.set(settings.task.kind, cloneSettings(settings.task));
    taskFields(); listen($('live-task'), 'change', () => {
      taskDrafts.set(settings.task.kind, cloneSettings(settings.task));
      const kind = $('live-task').value, descriptor = tasks.find(task => task.kind === kind);
      const fallback = defaultSettings.task.kind === kind ? defaultSettings.task : {};
      const defaults = { ...fallback, ...descriptor?.defaults, kind };
      defaults.target_offset_m ||= [0, 0, 0];
      settings.task = cloneSettings(taskDrafts.get(kind) || defaults);
      // Hydrate the visible task before parsing the form. Reach and tracking
      // keep independent positions, and tracking keeps its size/orientation.
      settings.task.target_offset_m.forEach((offset, i) => {
        $(`target-offset-${i}`).value = String(offset);
        $(`target-offset-${i}`).setCustomValidity('');
      });
      taskFields(); change();
    });
    resetIndicators.bind({ key: 'task.kind', name: 'task', input: $('live-task'), host: $('live-task').parentElement,
      getValue: () => $('live-task').value, getDefault: () => defaultSettings.task.kind,
      reset: value => { $('live-task').value = value; $('live-task').dispatchEvent(new Event('change', { bubbles: true })); } });
    const groups = new Map();
    const horizonRow = document.createElement('div'); horizonRow.className = 'horizon-row';
    ($('live-horizon-settings') || $('live-settings')).append(horizonRow);
    let horizonInput;
    const syncHorizon = () => {
      const n = inputs.find(item => item.parameter.path === 'N');
      const dt = inputs.find(item => item.parameter.path === 'dt_s');
      if (!n || !dt || !horizonInput) return;
      const count = parseParameter(n.parameter, n.input), seconds = Number(dt.input.value);
      horizonInput.min = (count - 1) * dt.parameter.min; horizonInput.max = (count - 1) * dt.parameter.max;
      horizonInput.value = dt.input.value.trim() && Number.isFinite(seconds) ? String(Number(((count - 1) * seconds).toPrecision(12))) : '';
      horizonInput.setCustomValidity('');
    };
    for (const supplied of schema.parameters) {
      const parameter = { ...supplied, path: supplied.path.replace(/^config\./, '') };
      // Retain this upstream value in the complete config, without a timing UI.
      if (parameter.path.endsWith('warm_start')) continue;
      if (parameter.path === 'N') { parameter.kind = 'choice'; parameter.choices = schema.available_N; }
      const name = parameter.group || 'Settings';
      const isHorizon = ['N', 'dt_s'].includes(parameter.path);
      if (!isHorizon && !groups.has(name)) {
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
        if (parameter.path === 'N' && !schema.available_N.includes(value)) {
          const unavailable = document.createElement('option'); unavailable.value = '-1'; unavailable.textContent = `${value} · unavailable`; unavailable.disabled = true; unavailable.selected = true; input.append(unavailable); input.value = '-1';
        }
      } else if (parameter.kind === 'bool') { input.type = 'checkbox'; input.checked = Boolean(value); }
      else { input.type = 'number'; input.step = parameter.kind === 'int' ? '1' : 'any'; if (parameter.min != null) input.min = parameter.min; if (parameter.max != null) input.max = parameter.max; input.value = value; input.required = true; }
      input.disabled = Boolean(parameter.disabled); input.title = parameter.path; listen(input, 'input', () => {
        if (isHorizon) {
          if (parameter.path === 'N' && input.value !== '-1') profileNError = false;
          if (!profileNError) { if (horizonInput) horizonInput.disabled = false; syncHorizon(); }
        }
        change();
      });
      if (isHorizon) { label.className = 'horizon-field'; text.textContent = parameter.path === 'N' ? 'N' : 'Δt (s)'; }
      label.append(text, input); (isHorizon ? horizonRow : groups.get(name)).append(label); inputs.push({ parameter, input });
      bindReset(input, parameter, () => readPath(defaultSettings.config, parameter.path), { key: `config.${parameter.path}` });
    }
    if (inputs.some(item => item.parameter.path === 'dt_s')) {
      const label = document.createElement('label'); label.className = 'horizon-field';
      const text = document.createElement('span'); text.textContent = 'Horizon (s)';
      horizonInput = document.createElement('input'); horizonInput.type = 'number'; horizonInput.step = 'any'; horizonInput.required = true;
      horizonInput.disabled = profileNError;
      horizonInput.dataset.horizon = 'seconds'; horizonInput.title = 'Horizon = (N − 1) × Δt';
      listen(horizonInput, 'input', () => {
        const n = inputs.find(item => item.parameter.path === 'N'), dt = inputs.find(item => item.parameter.path === 'dt_s');
        const count = parseParameter(n.parameter, n.input);
        dt.input.value = horizonInput.value.trim() ? String(Number((Number(horizonInput.value) / (count - 1)).toPrecision(12))) : '';
        change();
        horizonInput.setCustomValidity(dt.input.validationMessage || '');
      });
      label.append(text, horizonInput); horizonRow.append(label); if (!profileNError) syncHorizon();
      resetIndicators.bind({ key: 'config.horizon_s', name: 'horizon', input: horizonInput,
        getValue: () => parseParameter({ kind: 'float', label: 'Horizon', min: Number(horizonInput.min), max: Number(horizonInput.max) }, horizonInput),
        getDefault: () => (parseParameter(inputs.find(item => item.parameter.path === 'N').parameter, inputs.find(item => item.parameter.path === 'N').input) - 1) * defaultSettings.config.dt_s,
        reset: () => { resetInput(inputs.find(item => item.parameter.path === 'dt_s').input, defaultSettings.config.dt_s); },
      });
    }
    settings.task.target_offset_m.forEach((value, i) => {
      const input = $(`target-offset-${i}`); input.value = value; listen(input, 'input', change);
      bindReset(input, { kind: 'float', path: `target_offset_m.${i}`, label: `target ${['X', 'Y', 'Z'][i]}`, min: -1, max: 1 }, () => activeTaskDefaults().target_offset_m[i], { key: `task.target_offset_m.${i}` });
    });
    settings.execution = validateExecution({ ...DEFAULT_EXECUTION, ...(settings.execution || schema.defaults.execution || {}) });
    for (const [key, id] of [['simulation_hz', 'live-simulation-hz'], ['control_hz', 'live-control-hz'], ['to_hz', 'live-to-hz'], ['duration_s', 'live-duration'], ['calculation', 'live-calculation']]) {
      const input = $(id); input.value = settings.execution[key]; listen(input, 'input', change);
      const baseline = { ...DEFAULT_EXECUTION, ...defaultSettings.execution };
      if (key === 'calculation') resetIndicators.bind({ key: `execution.${key}`, name: 'calculation mode', input,
        getValue: () => input.value, getDefault: () => baseline[key], reset: value => resetInput(input, value) });
      else bindReset(input, { kind: 'float', path: key, label: key.replaceAll('_', ' '), min: Number.MIN_VALUE }, () => baseline[key], { key: `execution.${key}` });
    }
    $('live-continue').checked = settings.execution.continue_at_end;
    listen($('live-continue'), 'change', () => { settings.execution.continue_at_end = $('live-continue').checked; });
    const commit = schema.source?.mpc_commit;
    $('live-source').textContent = `tiago_mpc ${commit ? String(commit).slice(0, 8) : 'local'} · prebuilt N: ${schema.available_N.join(', ')}`;
    resetIndicators.update();
    calculationControls();
    $('live-mode').disabled = false; message('Choose Live MPC to compute a prediction.');
  }
  function useGeneration(next, force = false) {
    if (!force && generation != null && next < generation) return false;
    if (!force && next === generation) return true;
    historyEpoch++;
    generation = next; cursor = 0; historyComplete = false; history.clear(); historyRevision++; paintedRevision = -1;
    const following = clock.following;
    state = undefined; clock.seek(null); if (following) clock.follow();
    extensionPending = false; renderedPlan = undefined; renderDirty = true;
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
          acceptTaskAnchors(record);
          if (record.type === 'state') state = record;
          if (record.type === 'plan') acceptPlan(record, false);
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
  function acceptPlan(item, presentation = true) {
    if (!validPoints(item.ee_xyz) || !validPoints(item.reference_xyz)) return false;
    plan = item;
    acceptTaskAnchors(item);
    if (presentation && inspectingPreview && item.origin === 'preview') inspectionPlan = item;
    if (Number.isInteger(item.settings_version)) settingsVersion = Math.max(settingsVersion ?? 0, item.settings_version);
    // Authoritative history can contain plans whose presentation SSE was
    // coalesced. Those plans settle settings just as an SSE prediction does.
    // A historical plan must not settle an explicit inspection still solving.
    if (pending && item.settings_version >= expectedVersion && (presentation || !inspectingPreview)) {
      pending = false;
      if (!dirty) frozenAnchor = undefined;
    }
    if (!defaultTargetWorld && (item.task_kind || submittedSettings?.task.kind) === 'reach' && submittedSettings?.task.kind === 'reach') {
      defaultTargetWorld = item.reference_xyz[0].map((value, i) => value - submittedSettings.task.target_offset_m[i]);
    }
    if (!figure8BaseWorld && item.task_kind === 'figure8' && submittedSettings?.task.kind === 'figure8' && validPoints(item.task_path_xyz)) {
      figure8BaseWorld = item.task_path_xyz[0].map((value, i) => value - submittedSettings.task.target_offset_m[i]);
    }
    return true;
  }
  function receive(event) {
    let item; try { item = JSON.parse(event.data); } catch { message('Invalid live event.', true); return; }
    if (['status', 'history', 'plan', 'state'].includes(item.type)) latestServerEvents.set(item.type, item);
    receiveItem(item);
  }
  function receiveItem(item) {
    if (item.type === 'solver_profile') { Promise.resolve(onSolverProfile(item)).catch(error => message(`Solver setup: ${error.message}`, true)); return; }
    if (profileSwitching) return;
    if (!needsInitialPreview && generation != null && item.generation != null && item.generation < generation) return;
    if (!needsInitialPreview && item.type === 'status' && expectedVersion != null && item.settings_version < expectedVersion) return;
    acceptTaskAnchors(item);
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
      if (!acceptPlan(item)) return;
      if (generation == null) history.addPlan(item);
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
    const [start, end] = clock.presentationBounds(history.bounds), timeline = $('live-history'), time = clock.time ?? end;
    const recordedEnd = history.bounds[1];
    timeline.min = start; timeline.max = end; timeline.value = Math.max(start, Math.min(end, time)); timeline.disabled = history.length < 2;
    timeline.style.setProperty('--progress', `${end > start ? 100 * (time - start) / (end - start) : 0}%`);
    $('live-history-latest').disabled = !history.length || Math.abs(time - recordedEnd) < 1e-8;
    $('live-history-position').textContent = history.length ? clock.following ? `${number(time, 2)} s · Live` : `${number(time, 2)} / ${number(end, 2)} s` : 'No state history yet';
    const interval = history.intervals.find(value => value.start_time_s <= time && value.end_time_s > time) || history.intervals.at(-1);
    if (!timeline.matches?.(':hover')) timeline.title = interval ? intervalDescription(interval) : 'Recorded simulation time';
    timeline.setAttribute('aria-valuetext', `${number(time, 3)} seconds${interval ? ` · ${intervalDescription(interval)}` : ''}`);
    $('live-history-window').textContent = `Recorded ${number(start, 2)}–${number(recordedEnd, 2)} s · ${history.length} states · display path ≤5000 points${fetching ? ' · downloading recording' : ''}${historyComplete ? ' · calculation complete' : job.job_active ? ` · calculating ${number((job.progress || 0) * 100)}%` : ''}`;
    $('live-history-note').textContent = clock.following ? `Following Live at 1× · recorded through ${number(recordedEnd, 2)} s. Calculation may limit progress. Pause or scrub to inspect the full recording.` : clock.playing ? 'History playback at 1×. At the recorded end, calculation may limit progress.' : 'Scrub or Play recorded history. Go latest only moves the view; Continue controls new motion at the end.';
    paintIntervals();
    // Paint only on recorded changes, then rescale its full-history coordinates
    // to the presented end without rebuilding interval DOM on animation frames.
    const span = recordedEnd - start, visibleFraction = span > 0 ? (end - start) / span : 1;
    const intervals = $('live-history-intervals');
    intervals.style.width = `${100 / (visibleFraction || 1)}%`;
    intervals.style.clipPath = `inset(0 ${100 * (1 - visibleFraction)}% 0 0)`;
  }
  function renderView() {
    const selected = history.interpolateAt(clock.time, { trace: false });
    if (traceRevision !== historyRevision) { displayPath = history.displayPath(); traceRevision = historyRevision; }
    const shownState = selected?.state || state, shownPlan = inspectingPreview ? inspectionPlan || plan : selected?.plan || plan;
    const historical = clock.time != null && clock.time < history.bounds[1] - 1e-7;
    const editing = dirty || pending;
    // A growing recording can alternate between its tip and an interpolated
    // historical sample every time another batch arrives. Its task is fixed
    // for this settings generation; keep the independent reference geometry
    // stable throughout playback instead of rebuilding it at each transition.
    const draft = (!historical || editing || clock.playing) && settings?.task;
    const base = draft?.kind === 'figure8' ? figure8BaseWorld : defaultTargetWorld;
    const nextReferenceKey = draft ? JSON.stringify([draft, base]) : shownPlan;
    if (referenceKey !== nextReferenceKey) {
      referenceKey = nextReferenceKey;
      desiredReference = draft ? taskReference(draft, base) : shownPlan ? {
        kind: shownPlan.task_kind, points: shownPlan.task_path_xyz || shownPlan.reference_xyz,
        target_xyz: shownPlan.target_xyz || shownPlan.reference_xyz[0], draft: false,
      } : null;
    }
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
      // An old optimizer output must not look like a prediction of the edited
      // task. Desired geometry still redraws while its replacement is pending.
      const currentPlan = editing ? null : shownPlan || null;
      if (renderedPlan !== currentPlan) { onPlan(currentPlan); renderedPlan = currentPlan; }
      if (renderedReference !== desiredReference) { onReference(desiredReference); renderedReference = desiredReference; }
      if (shownState) {
        const tracePoints = selected ? displayPath.points : [shownState.ee_xyz];
        const traceCount = selected ? Math.min(tracePoints.length, Math.floor(selected.index / displayPath.stride) + 1 + (selected.index === history.length - 1 && selected.index % displayPath.stride ? 1 : 0)) : 1;
        onState(shownState, { tracePoints, traceCount,
          referenceTarget: desiredReference?.draft ? taskReferencePoint(draft, base, shownState.sim_time_s) : shownState.target_xyz,
          historical: clock.time != null && clock.time < history.bounds[1] - 1e-7, interpolated: Boolean(shownState.render_interpolated) }); presentedState = shownState;
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
      const tick = clock.tick(timestamp, history.bounds, { followAtEnd: continueAtEnd() });
      if (tick.atEnd && !job.job_active && !fetching) {
        if (continueAtEnd()) extendHistory();
        else if (!extensionPending) { clock.pause(); controlsEnabled(); }
      }
      renderDirty = true;
    }
    if (renderDirty) renderView();
  }
  function showLatest() { inspectingPreview = false; clock.seek(history.bounds[1]); if (clock.playing && continueAtEnd()) clock.follow(); renderView(); }
  async function switchMode(next) {
    if (next === mode || (next === 'live' && !liveReady)) return;
    clearTimeout(settingsTimer); submission++; mode = next; clock.pause();
    document.body.classList.toggle('live-mode', mode === 'live');
    for (const id of ['live-panel', 'live-controls']) $(id).hidden = mode !== 'live';
    for (const id of ['replay-section', 'replay-controls']) $(id).hidden = mode === 'live';
    for (const name of ['replay', 'live']) { $(`${name}-mode`).classList.toggle('active', name === mode); $(`${name}-mode`).setAttribute('aria-pressed', name === mode); }
    $('mode-label').textContent = mode === 'live' ? 'LIVE MPC · SIMULATION' : 'TRAJECTORY REPLAY'; onMode(mode);
    if (mode === 'live') {
      needsInitialPreview = !suppressInitialPreview && !profileSwitching && !profileUnavailable; suppressInitialPreview = false;
      const connection = new EventSource('/api/live/events'); source = connection; controlsEnabled(); refreshPlanLabel();
      connection.onmessage = event => { if (source === connection && mode === 'live') receive(event); };
      connection.onopen = () => { latestServerEvents.clear(); controlsEnabled(); message('Connected · waiting for solver status…'); if (!needsInitialPreview && generation != null) fetchHistory(); };
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
    // Finite precalculations replay from the start when Stop is selected.
    // On Play resumes continuous computation from the existing recording tip.
    if (!noMotion && !job.job_active && !extensionPending && !continueAtEnd() && clock.time >= history.bounds[1] - 1e-7) clock.seek(history.bounds[0]);
    if (noMotion || (clock.time >= history.bounds[1] - 1e-7 && continueAtEnd())) { if (!await extendHistory()) return; }
    clock.play(performance.now(), { follow: continueAtEnd() && (noMotion || clock.time >= history.bounds[1] - 1e-7) }); controlsEnabled(); renderView();
  });
  $('live-reset').addEventListener('click', async () => {
    clearTimeout(settingsTimer); clock.pause(); frozenAnchor = undefined;
    if (dirty && !await submitSettings()) return;
    history.clear(); historyRevision++; plan = null; state = undefined; presentedState = undefined; clock.seek(null); onReset();
    const result = await send({ type: 'reset' }); if (result?.generation != null) useGeneration(result.generation); renderView();
  });
  $('live-history').addEventListener('input', event => { if (!event.target.disabled) { inspectingPreview = false; clock.pause(); clock.seek(Number(event.target.value)); controlsEnabled(); renderView(); } });
  $('live-history').addEventListener('pointermove', event => {
    const bounds = event.target.getBoundingClientRect(), [start, end] = clock.presentationBounds(history.bounds);
    const time = start + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * (end - start);
    const interval = history.intervals.find(value => value.start_time_s <= time && value.end_time_s > time);
    event.target.title = `${number(time, 3)} s · ${interval ? intervalDescription(interval) : 'Recorded simulation time'}`;
  });
  $('live-history-latest').addEventListener('click', showLatest);
  function beginSolverProfileSwitch() {
    const anchor = displayedAnchor();
    clearTimeout(settingsTimer); ++submission; ++schemaReload;
    clock.pause(); profileSwitching = true; pending = false; extensionPending = false; needsInitialPreview = false;
    expectedVersion = settingsVersion;
    job = { ...job, job_active: false };
    $('live-status').textContent = 'SWITCHING SOLVER';
    message('Switching solver · calculation paused.'); controlsEnabled(); renderDirty = true;
    return anchor;
  }
  async function finishSolverProfileSwitch(item) {
    const reload = ++schemaReload;
    clearTimeout(settingsTimer); clock.pause();
    profileSwitching = true; controlsEnabled();
    try {
      const response = await fetch('/api/live/schema'), nextSchema = await response.json();
      if (reload !== schemaReload) return;
      if (item.state === 'failed') {
        profileUnavailable = !item.active_profile_id || !response.ok;
        status = 'paused'; job = { ...job, job_active: false };
        $('live-status').textContent = 'PAUSED';
        message(`Solver switch failed: ${item.error || 'No solver is active.'}`, true);
        return;
      }
      if (!response.ok) throw new Error(nextSchema.error || 'Live settings unavailable for the selected solver.');
      const nextSettings = solverProfileSettings(nextSchema, settings);
      const retainedDrafts = [...taskDrafts];
      schema = nextSchema; acceptTaskAnchors(schema); defaultSettings = initialLiveSettings(schema); settings = nextSettings;
      taskDrafts.clear();
      for (const [kind, draft] of retainedDrafts) if (schema.tasks?.some(task => task.kind === kind)) taskDrafts.set(kind, restoreCompatibleSettings(schema, { ...settings, task: draft }).task);
      profileNError = !schema.available_N.includes(settings.config.N);
      liveReady = true; profileUnavailable = false; needsInitialPreview = false; initialResetPending = false;
      suppressInitialPreview = mode !== 'live';
      populate();
      // Activation already retained backend settings and opened a paused
      // segment at the supplied native anchor. Do not send set_settings here.
      const notice = latestServerEvents.get('status');
      if (notice?.generation === item.generation && Number.isInteger(notice.settings_version)) expectedVersion = settingsVersion = notice.settings_version;
      if (item.generation != null) useGeneration(item.generation);
      plan = undefined; inspectionPlan = null; inspectingPreview = false;
      status = 'paused'; job = { ...job, job_active: false };
      $('live-status').textContent = 'PAUSED'; $('live-status').classList.toggle('error', false);
      $('live-availability').textContent = '';
      message(profileNError ? `N=${settings.config.N} is unavailable in this solver profile. Choose an available knot count before calculating.` : 'Solver ready · simulation paused.', profileNError);
    } catch (error) {
      if (reload !== schemaReload) return;
      profileUnavailable = true;
      message(`Solver setup: ${error.message}`, true);
      throw error;
    } finally {
      if (reload === schemaReload) { profileSwitching = false; controlsEnabled(); renderDirty = true; }
    }
  }
  const initialSchemaRequest = schemaReload;
  fetch('/api/live/schema').then(async response => { const result = await response.json(); if (initialSchemaRequest !== schemaReload) return; if (!response.ok) throw new Error(result.error || 'Live settings unavailable.'); schema = result; acceptTaskAnchors(schema); defaultSettings = initialLiveSettings(schema); settings = cloneSettings(defaultSettings);
    try {
      const retained = sessionStorage.getItem('source-restart-live-settings');
      sessionStorage.removeItem('source-restart-live-settings');
      if (retained) { settings = restoreCompatibleSettings(schema, JSON.parse(retained)); dirty = !settingValuesEqual(settings, defaultSettings); }
    } catch {}
    liveReady = true; populate(); }).catch(error => { if (initialSchemaRequest !== schemaReload) return; liveReady = false; controlsEnabled(); $('live-mode').disabled = true; $('live-mode').title = error.message; $('live-availability').textContent = `Live MPC needs setup: ${error.message}`; });
  return {
    get targetInteraction() {
      const offset = [0, 1, 2].map(i => Number($(`target-offset-${i}`).value));
      const kind = $('live-task').value, base = kind === 'figure8' ? figure8BaseWorld : defaultTargetWorld;
      const available = mode === 'live' && !clock.playing && (clock.time == null || clock.time >= history.bounds[1] - 1e-7) && connected() && Boolean(base) && settings.task.kind === kind && Boolean(readSettings()) && status !== 'gpu_busy' && status !== 'error';
      return { available, kind, position_world: base ? targetWorldPosition(base, offset) : null,
        quaternion_xyzw: settings?.task.orientation_xyzw || [0, 0, 0, 1],
        size_m: kind === 'figure8' ? [settings?.task.width_m, settings?.task.height_m] : null,
        pending: dirty || pending, offset_m: offset };
    },
    setTargetWorld(position) {
      if (!this.targetInteraction.available) return null;
      const base = settings.task.kind === 'figure8' ? figure8BaseWorld : defaultTargetWorld;
      const offset = targetWorldOffset(base, position); if (!offset) return null;
      offset.forEach((value, i) => { $(`target-offset-${i}`).value = String(Number(value.toFixed(6))); });
      change(); return this.targetInteraction.position_world;
    },
    setTaskTransform(pose) {
      if (!this.targetInteraction.available || settings.task.kind !== 'figure8') return null;
      const quaternion = normalizeQuaternion(pose.quaternion_xyzw || settings.task.orientation_xyzw || [0, 0, 0, 1]);
      if (!quaternion || (pose.size_m && (!Array.isArray(pose.size_m) || pose.size_m.length !== 2 || !pose.size_m.every(Number.isFinite)))) return null;
      settings.task.orientation_xyzw = quaternion;
      if (pose.size_m) ['width_m', 'height_m'].forEach((path, i) => {
        document.querySelector(`[data-task-path="${path}"]`).value = String(Number(Math.max(.01, Math.min(.6, pose.size_m[i])).toFixed(6)));
      });
      change(); return this.targetInteraction;
    },
    get reference() { return desiredReference; },
    get mode() { return mode; }, get plan() { return plan; }, get state() { return state; }, get displayedState() { return presentedState || history.at(clock.time)?.state || state; },
    get metricHistory() { return history.metricSnapshot; },
    get history() { return { length: history.length, bounds: history.bounds, presentationBounds: clock.presentationBounds(history.bounds), following: clock.following, selectedTime: clock.time, limits: history.limits, generation, cursor, complete: historyComplete, intervals: history.intervals }; },
    get fitAvailable() { return Boolean(history.length || plan?.ee_xyz?.length || plan?.task_path_xyz?.length); },
    get precomputedPath() { return !dirty && !pending && historyComplete && !fetching && history.length > 1 && settings.execution.calculation !== 'on_play' ? history.pathPoints : undefined; },
    get settings() { return settings ? cloneSettings(settings) : null; }, get status() { return status; },
    get pending() { return profileSwitching || pending || (mode === 'live' && !connected()); }, get playing() { return clock.playing; },
    holdForInspection() {
      // The inspection endpoint owns cooperative numerical pausing. This only
      // holds the browser's clock and queued edits, preserving its displayed
      // native pose/cursor and the private Live controller state.
      clearTimeout(settingsTimer); ++submission; clock.pause(); extensionPending = false;
      controlsEnabled(); renderDirty = true;
    },
    beginSolverProfileSwitch, finishSolverProfileSwitch,
    frame, togglePlay: () => { if (mode === 'live' && !$('live-play').disabled) $('live-play').click(); },
  };
}
