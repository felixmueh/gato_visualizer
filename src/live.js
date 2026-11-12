import { settingsGroups } from './task-settings.js';
import { createTaskSettingsDialog } from './task-settings-dialog.js';
import { createSettingResets, canonicalOrientation, settingValuesEqual } from './setting-resets.js';
import { targetWorldPosition, targetWorldOffset, normalizeQuaternion } from './target-gizmo.js';
import { orientationGoal, taskReference, taskReferencePoint } from './task-reference.js';
import { quaternionToRotvec, rotvecToQuaternion } from './rotations.js';
import { DEFAULT_PRESENTATION, validatePresentation } from './presentation-settings.js';

// The API uses native joint values and full robot-root coordinates. No sign or
// frame conversions belong in the browser.
import { createLiveHistory } from './live-history.js';
import { createTimelineIntervalIndex } from './timeline-intervals.js';
import { createLiveHistoryPaging } from './live-history-paging.js';
import { createLivePlanCache } from './live-plan-cache.js';
import { livePredictionWindow, hydrateLiveAnimationHistory } from './live-prediction.js';
import { DEFAULT_EXECUTION, validateExecution, intervalDescription, createHistoryClock } from './live-execution.js';
import { sessionSpan } from './session.js';
import { settingsPatch, rebaseSettings } from './shared-settings.js';
import { createVectorField, createWorktreeFields, restoreWorktreeSettings, fieldValue, resolvedValueText, validateField, parameterTooltip } from './worktree-fields.js';
import { worldToRoot } from './live-obstacles.js';
import { shapeToWorld } from './collision-shapes.js';
import { clampShape } from './shape-layouts.js';
import { createSettingsHistory } from './settings-history.js';
import { createModelCompilation, createModelCompilePrompt, modelCheckInputs } from './model-compilation.js';
import { canonicalTimeUnit, parseTimeValue, configureTimeInput, readTimeInput, setTimeInputValue } from './time-input.js';

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

// config.friction is the predictor friction of MpcParams: null when loss-free.
export function availableKnotCounts(schema, config) {
  if (schema.exact_availability) return schema.available_N;
  const mode = config?.friction ? 'on' : 'off';
  return schema.available_N_by_friction?.[mode] ?? schema.available_N;
}

export const supportedKnotCounts = schema => schema.fixed_horizon_N != null ? [schema.fixed_horizon_N] : schema.supported_N ?? schema.available_N;

export function initialLiveSettings(schema) {
  const supported = supportedKnotCounts(schema);
  if (!Array.isArray(supported) || !supported.length) {
    throw new Error('No knot counts are ready. Open Settings › Backend to select a compatible cache or build them. Replay is available.');
  }
  if (!supported.every((value) => Number.isInteger(value) && value > 1)) {
    throw new Error('The live knot-count list is invalid. Restart the visualizer server and reload this page.');
  }
  const settings = cloneSettings(schema.defaults);
  if (!settings?.config || typeof settings.config !== 'object') throw new Error('The live settings could not load.');
  if (!supported.includes(settings.config.N)) settings.config.N = supported[0];
  return settings;
}

export function restoreCompatibleSettings(schema, saved) {
  const settings = initialLiveSettings(schema);
  if (!saved || typeof saved !== 'object') return settings;
  const previousFriction = saved.config?.friction;
  if (previousFriction && Object.hasOwn(previousFriction, 'law') && settings.config.friction_law) {
    const { law, ...coefficients } = previousFriction;
    const choices = schema.parameters?.find(parameter => parameter.path.replace(/^config\./, '') === 'friction')?.choices || [];
    if (!settingValuesEqual(law, settings.config.friction_law) ||
        !choices.some(choice => settingValuesEqual(choiceValue(choice), coefficients))) {
      throw new Error('Saved predictor friction cannot be restored with the current coefficients and fixed tanh width. Reload to use current defaults.');
    }
    saved = { ...saved, config: { ...saved.config, friction: coefficients } };
  }
  for (const parameter of schema.parameters || []) {
    const path = parameter.path.replace(/^config\./, ''), value = readPath(saved.config, path);
    if (value === undefined) continue;
    try {
      if (parameter.kind === 'choice') {
        const choices = path === 'N' ? supportedKnotCounts(schema) : parameter.choices;
        if (!choices.some(choice => settingValuesEqual(choiceValue(choice), value))) continue;
      } else if (parameter.kind === 'joints') {
        if (!Array.isArray(value) || value.length !== parameter.lower.length ||
            !value.every((x, i) => Number.isFinite(x) && x >= parameter.lower[i] && x <= parameter.upper[i])) continue;
      } else if (parameter.kind === 'vector') {
        validateField(parameter, value);
      } else if (parameter.kind === 'bool') {
        if (typeof value !== 'boolean') continue;
      } else if (value === null) {
        if (!parameter.nullable) continue;
      } else {
        if (typeof value !== 'number') continue;
        parseParameter(parameter, { value: String(value) });
      }
      writePath(settings.config, path, value);
    } catch { /* A source can remove or narrow settings; retain its own default. */ }
  }
  // Plant friction needs semi-implicit Euler: friction saved before the integrator setting restores off.
  const plant = settings.config.plant;
  if (plant?.friction && plant.integrator === 'rk4') plant.friction = false;
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
    const goal = orientationGoal(saved.task);
    if (goal && orientationGoalSupported(schema) && Math.hypot(...goal) <= Math.PI + 1e-6) settings.task.orientation_rad = goal;
  }
  try { settings.execution = validateExecution(saved.execution); } catch {}
  if (schema.source_settings) settings.source_settings = restoreWorktreeSettings(schema, saved.source_settings);
  return settings;
}

// Orientation references are a native-menu capability, independent of whether the
// profile offers scalar convenience weight controls (custom menus retain their terms).
export const orientationGoalSupported = schema => schema?.orientation_goal_supported ??
  Boolean(schema?.parameters?.some(parameter => parameter.enabled_with === 'orientation_goal'));

export function solverProfileSettings(schema, saved) {
  const restored = restoreCompatibleSettings(schema, saved);
  // A profile switch must not silently replace the user's horizon. An
  // unsupported N remains visible until the user explicitly chooses another.
  if (Number.isInteger(saved?.config?.N)) restored.config.N = saved.config.N;
  return restored;
}

// A schema choice is a plain value or {value, label}.
export function choiceValue(choice) {
  return choice && typeof choice === 'object' && 'value' in choice && 'label' in choice ? choice.value : choice;
}

export function parseParameter(parameter, input) {
  if (parameter.kind === 'bool') return input.checked;
  if (parameter.kind === 'choice') {
    const index = Number(input.value);
    if (String(input.value).trim() === '' || !Number.isInteger(index) || index < 0 || index >= parameter.choices.length) {
      throw new Error(`${parameter.label || parameter.path || 'Setting'} needs an available choice.`);
    }
    const value = choiceValue(parameter.choices[index]);
    if (value === undefined) throw new Error(`${parameter.label || parameter.path || 'Setting'} needs an available choice.`);
    return value;
  }
  if (parameter.gato_default && input.dataset?.gatoValue && input.value === input.dataset.gatoValue) return null;  // still GATO's
  if (input.value.trim() === '') {
    if (parameter.nullable) return null;
    throw new Error(`${parameter.label} needs a value.`);
  }
  const timeUnit = canonicalTimeUnit(parameter);
  const value = timeUnit ? parseTimeValue(input.value, { ...parameter, unit: timeUnit }) : Number(input.value);
  if (timeUnit && value === null) return null;
  if (!Number.isFinite(value) || (parameter.kind === 'int' && !Number.isInteger(value))) {
    throw new Error(`${parameter.label} needs a finite ${parameter.kind === 'int' ? 'integer' : 'number'}.`);
  }
  if (parameter.min != null && value < parameter.min) throw new Error(`${parameter.label} must be at least ${parameter.min}.`);
  if (parameter.max != null && value > parameter.max) throw new Error(`${parameter.label} must be at most ${parameter.max}.`);
  return value;
}

// The start pose (config.plant.start_pose_rad): the native joint positions the
// simulated arm starts from at t = 0. It is edited in the Joints tab, not the
// settings panel; changing it starts a new run there, as Reset (Felix, 2026-10-23).
export const START_POSE_PATH = 'plant.start_pose_rad';
export function startPoseValue(config) {
  const value = readPath(config, START_POSE_PATH);
  return Array.isArray(value) ? [...value] : null;
}
export function startPoseOf(schema, settings, defaults) {
  const spec = schema?.parameters?.find(parameter => parameter.path.replace(/^config\./, '') === START_POSE_PATH);
  const value = readPath(settings?.config, START_POSE_PATH);
  if (!spec || !Array.isArray(value)) return null;
  const margin = Number(settings.config.joint_margin_rad) || 0;
  return { value: [...value], defaults: [...readPath(defaults.config, START_POSE_PATH)], lower: [...spec.lower], upper: [...spec.upper],
    planning: { lower: spec.lower.map(v => v + margin), upper: spec.upper.map(v => v - margin) } };
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

export function setupLive({ presentationSettings = DEFAULT_PRESENTATION, replayOnly = false, onReplayMode = () => {}, onMode, onPlan, onState, onReset, onReference = () => {}, onSolverProfile = () => {}, onFreeze = async () => {}, graspOrientation = () => null, settingsPollMs = typeof window === 'undefined' ? 0 : 1000 }) {
  const $ = id => document.getElementById(id);
  let schema, settings, defaultSettings, submittedSettings, source, state, plan, presentedState, renderedPlan;
  let mode = 'replay', status = 'idle', liveReady = false, pending = false, dirty = false;
  let settingsVersion, expectedVersion, needsInitialPreview = false, settingsTimer, submission = 0;
  let historyEpoch = 0, playbackIntent = 0, initialResetPending = true;
  let generation = null, cursor = 0, historyComplete = false;
  let historyRevision = 0, paintedRevision = -1, job = {}, extensionPending = false, extensionStartTime = null, frozenAnchor;
  let inspectingPreview = false, inspectionPlan = null;
  let defaultTargetWorld, figure8BaseWorld, renderDirty = true, traceRevision = -1, displayPath = { points: [], stride: 1 };
  let desiredReference, referenceKey, renderedReference;
  // The last orientation goal switched off, restored when it is switched on again.
  let orientationDraft = null;
  let profileSwitching = false, profileUnavailable = false, profileNError = false, schemaReload = 0, suppressInitialPreview = false;
  let populationBindings = [];
  let session, unsubscribeSession, freezing = false;
  let calculateWhilePlaying = false;
  let precomputedRevision = -1, precomputedPoints;
  // The start pose shown while a position gauge is dragged: scene only, no settings change.
  let poseDraft = null, acceptedStartPose;
  let acceptedSettings, serverSettingsVersion, settingsPoll, disposed = false, settingsEpoch = 0;
  const settingsRequests = [];
  const latestServerEvents = new Map();
  // Each history segment's constant context (task, limits, identities), sent once
  // in its `segment` record; plans and states name their segment by generation.
  const segments = new Map();
  const segmentOf = item => segments.get(item?.generation)?.context;
  let taskCatalog = null, taskSwitching = false, copyDialog = null, copyButton = null, resetAllButton = null;
  const baselineForTask = kind => {
    const defaults = taskCatalog?.defaults?.[kind] || schema?.task_defaults?.[kind];
    if (!defaults) throw new Error(`Task settings defaults are unavailable for ${kind}; reload the backend.`);
    return initialLiveSettings({ ...schema, defaults });
  };
  function updateTaskBaseline(kind) {
    defaultSettings = baselineForTask(kind);
  }
  function refreshTaskCopy() { if (copyDialog?.isOpen) copyDialog.refresh(); }
  function taskDialogContext() {
    return { schema, catalog: taskCatalog || { defaults: schema?.task_defaults, overrides: {} },
      current: settingsGroups(settings), version: serverSettingsVersion, readonly: replayOnly || mode !== 'live' || taskSwitching || profileSwitching || profileUnavailable };
  }
  const resetIndicators = createSettingResets();
  let presentation = validatePresentation(presentationSettings);
  const timelineIntervals = createTimelineIntervalIndex();
  const history = createLiveHistory({ maxSamples: Infinity, maxSeconds: Infinity, maxPlans: Infinity }), clock = createHistoryClock({ bufferMs: presentation.buffer_ms }), inputs = [];
  const planCache = createLivePlanCache({ fetch, onChange: () => { renderDirty = true; if (!clock.playing && !disposed) renderView(); },
    onError: error => message(`Prediction download failed: ${error.message}`, true) });
  const compactPlayback = () => schema?.live_playback?.version === 1;
  const historyPaging = createLiveHistoryPaging({ fetch,
    getRequest: () => !disposed && generation != null && mode === 'live' && !replayOnly
      ? { generation, cursor, epoch: historyEpoch, compact: compactPlayback() } : null,
    onBatch: acceptHistoryBatch, onGeneration: useGeneration,
    onError: error => message(`History download failed: ${error.message}`, true),
    onIdle: () => { if (!disposed) controlsEnabled(); } });
  let sourceFields = null, nativeVectors = [], resolvedFields = [], effectiveSettings = null;
  // Fields whose empty value (None) follows GATO's default look as if GATO's value were chosen.
  // The configured solver reports that value (effective_settings) while the accepted settings
  // follow GATO; before any solver reports it they read "GATO default".
  let gatoDefaultFields = [];
  const gatoValues = new Map();  // path -> GATO's value, kept once a solver reported it
  function refreshGatoDefaults() {
    for (const field of gatoDefaultFields) {
      // undefined: not reported yet; null: GATO's own None (for example re-seeding off)
      const reported = fieldValue(effectiveSettings || schema?.effective_settings, `params.${field.path}`);
      if (readPath(acceptedSettings?.config, field.path) == null && reported !== undefined) gatoValues.set(field.path, reported);
      const value = gatoValues.get(field.path), known = gatoValues.has(field.path);
      if (field.option) {
        // GATO's option takes the label of the choice equal to GATO's value, which is hidden.
        const options = [...field.input.children].filter(option => option !== field.option);
        const twin = value == null ? null : options.find(option =>
          settingValuesEqual(choiceValue(field.parameter.choices[Number(option.value)]), value));
        for (const option of options) option.hidden = option === twin;
        field.option.textContent = twin ? twin.textContent : 'GATO default';
      } else {
        // The number shows GATO's value; parseParameter reads it back as None while unchanged.
        const shown = value == null ? '' : String(value);
        if (field.input.value === '' || field.input.value === field.input.dataset.gatoValue) field.input.value = shown;
        field.input.dataset.gatoValue = shown;
        field.input.placeholder = known && value == null ? field.parameter.gato_none || 'none' : 'GATO default';
      }
    }
  }
  let modelCompilation, modelPrompt, modelState = { phase: 'idle' };
  let declaredLatencyDraft = .005, fixedToDraft = DEFAULT_EXECUTION.to_hz, maxPlanAgeDraft = .1;
  // An obstacle edit while On Play plays keeps playing: its settings change starts the
  // new segment at the displayed state and Play continues there (no pause).
  let playingEdit = false, obstacleAdded = null;
  // The recorded state a playing edit continued from: drawn (and the anchor of a further
  // playing edit) until the new segment's first records arrive, instead of the start pose.
  let playingHold = null;
  // A drag or scale of an obstacle is one gesture: it submits once, on release.
  let obstacleGesture = false, obstacleHighlight = null;
  // Accepted documents stay in their task's history; switching never rewinds another
  // task's session. A whole obstacle gesture still submits as one accepted entry.
  const settingsHistories = new Map();
  function taskSettingsHistory(kind = acceptedSettings?.task.kind || settings?.task.kind) {
    if (!settingsHistories.has(kind)) settingsHistories.set(kind, createSettingsHistory({ equal: settingValuesEqual }));
    return settingsHistories.get(kind);
  }
  // The predictor's obstacle lists (an adapter's descriptors of kind shapes).
  const shapeSettings = () => schema?.source_settings?.predictor?.parameters?.filter(parameter => parameter.kind === 'shapes') || [];
  const latestContext = () => segments.get(generation)?.context || [...segments.values()].at(-1)?.context;
  const compilationEnabled = () => Array.isArray(schema?.supported_N) && Boolean(schema.compile_selection);
  const number = (value, precision = 0) => Number.isFinite(value) ? value.toFixed(precision) : '—';
  const message = (text, error = false) => { $('live-message').textContent = text; $('live-message').classList.toggle('error', error); };
  const transportConnected = () => !replayOnly && liveReady && !profileSwitching && !profileUnavailable && source?.readyState === EventSource.OPEN && !needsInitialPreview;
  const connected = () => transportConnected() && !profileNError;
  const continueAtEnd = () => connected() && (calculateWhilePlaying || Boolean(settings?.execution.continue_at_end));
  // Completion metadata can precede later history pages. Do not drain a short
  // final tail until the local download is caught up.
  const growingHistory = () => !replayOnly && Boolean((connected() && (job.job_active || extensionPending)) || historyPaging.fetching || historyPaging.queued);
  const activeTracks = () => session?.activeTracks || [];
  const sessionBounds = () => session ? sessionSpan(activeTracks().map(track => track.kind === 'live' ? { ...track, span: history.bounds, empty: !history.length } : track)) : replayOnly ? [0, 0] : history.bounds;
  const presentationBounds = () => session ? sessionSpan(activeTracks().map(track => track.kind === 'live' ? { ...track, span: clock.presentationBounds(history.bounds), empty: !history.length } : track)) : replayOnly ? [0, 0] : clock.presentationBounds(history.bounds);
  const hasComparison = () => Boolean(session?.tracks.some(track => track.kind === 'replay' && track.visible !== false && track.span?.[1] > track.span?.[0]));
  const anyPlayableSessionSpan = () => {
    const [start, end] = sessionBounds();
    return end > start && ((!replayOnly && history.length >= 2) || hasComparison());
  };
  const playbackDisabled = () => !connected() && (!anyPlayableSessionSpan() || (dirty && profileNError && !hasComparison()));
  function historySnapshot() { return { length: history.length, bounds: history.bounds, sessionBounds: sessionBounds(), presentationBounds: presentationBounds(), following: clock.following, buffering: clock.buffering, playing: clock.playing, growing: growingHistory(), selectedTime: clock.time, limits: history.limits, generation, cursor, complete: historyComplete, intervals: history.intervals, breaches: history.breaches }; }
  function precomputedPath() {
    if (dirty || pending || !historyComplete || historyPaging.fetching || history.length < 2 || settings?.execution.calculation === 'on_play') return undefined;
    if (precomputedRevision !== historyRevision) { precomputedPoints = history.pathPoints; precomputedRevision = historyRevision; }
    return precomputedPoints;
  }
  function syncSession(shownState = presentedState || state, shownPlan = renderedPlan) {
    if (!session) return;
    const segment = segments.get(generation), context = segment?.context;
    session.updateMain({ source: { kind: 'live', generation }, span: history.bounds, empty: !history.length, segment, context,
      settings: context?.settings || null, endEffectorFrame: context?.end_effector_frame || session.track('live').endEffectorFrame,
      state, displayedState: shownState, plan: shownPlan, reference: desiredReference, limits: history.limits,
      historyRevision, history: historySnapshot(),
      precomputedPath: precomputedPath(),
      fitAvailable: Boolean(history.length || plan?.ee_xyz?.length || segmentOf(plan)?.task_path_xyz?.length) });
    session.setCursor(clock.time ?? (history.length ? history.bounds[0] : session.span[0]));
  }
  function pausePlayback() { ++playbackIntent; clock.pause(); calculateWhilePlaying = false; extensionPending = false; renderDirty = true; }
  const taskBaseWorld = kind => kind === 'figure8' ? figure8BaseWorld : defaultTargetWorld;
  const acceptTaskAnchors = item => {
    if (validPoints([item?.task_anchors?.reach])) defaultTargetWorld = [...item.task_anchors.reach];
    if (validPoints([item?.task_anchors?.figure8])) figure8BaseWorld = [...item.task_anchors.figure8];
  };
  function acceptSegment(record) {
    segments.set(record.generation, record);
    while (segments.size > 4) segments.delete(segments.keys().next().value);
    acceptTaskAnchors(record.context); renderDirty = true;
    syncSession();
  }
  function acceptSettings(item, { initial = false, discardDraft = false } = {}) {
    if (!schema || !item?.config || !item.task || !item.execution || !Number.isInteger(item.settings_version)) return;
    if (serverSettingsVersion != null && item.settings_version < serverSettingsVersion) return;
    if (item.effective_settings) {
      effectiveSettings = cloneSettings(item.effective_settings);
      for (const { output, path } of resolvedFields) output.textContent = resolvedValueText(fieldValue(effectiveSettings, path));
      refreshGatoDefaults();
    }
    if (Array.isArray(item.available_N)) {
      schema.available_N = [...item.available_N];
      if (item.available_N_by_friction) schema.available_N_by_friction = cloneSettings(item.available_N_by_friction);
      if (item.exact_availability != null) schema.exact_availability = item.exact_availability;
      const spec = schema.parameters?.find(parameter => parameter.path.replace(/^config\./, '') === 'N');
      if (spec) spec.choices = [...supportedKnotCounts(schema)];
    }
    const previousBaseline = defaultSettings;
    if (item.task_settings) taskCatalog = cloneSettings(item.task_settings);
    updateTaskBaseline(initial && item.settings_version === 0 ? settings.task.kind : item.task.kind);
    const baselineChanged = !settingValuesEqual(previousBaseline, defaultSettings);
    const remote = cloneSettings({ config: item.config, task: item.task, execution: item.execution,
      ...(item.source_settings ? { source_settings: item.source_settings } : {}) });
    if (!discardDraft && serverSettingsVersion === item.settings_version && settingValuesEqual(acceptedSettings, remote)) {
      if (baselineChanged) populate();
      refreshTaskCopy();
      return;
    }
    const numericalChange = serverSettingsVersion != null && item.settings_version !== serverSettingsVersion;
    const ownRequest = settingsRequests.find(request => request.version === item.settings_version && settingValuesEqual(request.settings, remote));
    const switchedTask = acceptedSettings && acceptedSettings.task.kind !== remote.task.kind;
    // Task switches restore their cursor; a changed document (also another viewer's)
    // is an edit, but returning to an unchanged session adds no undo step.
    if (item.settings_version > 0) taskSettingsHistory(remote.task.kind).accept(item.settings_version, remote, { coalesce: switchedTask });
    const before = ownRequest?.settings || acceptedSettings || submittedSettings || defaultSettings;
    const next = discardDraft || switchedTask || (initial && item.settings_version > 0) ? cloneSettings(remote) : rebaseSettings(before, settings, remote);
    acceptedSettings = remote; serverSettingsVersion = item.settings_version; refreshGatoDefaults();
    settingsVersion = item.settings_version;
    // Version zero is the unconfigured backend. Its first viewer still chooses
    // the initial zero-time state, including controls retained across Apply.
    if (item.settings_version === 0 && initial) return;
    clearTimeout(settingsTimer);
    // Our submission already paused playback. Its delayed echo must not cancel
    // a Play requested after that submission; remote edits still pause normally.
    if (numericalChange && !initial && !ownRequest) pausePlayback();
    settings = next; submittedSettings = cloneSettings(remote);
    expectedVersion = item.settings_version;
    dirty = !settingValuesEqual(settings, remote);
    acceptedStartPose = startPoseValue(remote.config); poseDraft = null;
    initialResetPending = false; needsInitialPreview = false;
    pending = !replayOnly && (!plan || plan.settings_version < expectedVersion);
    if (initial && item.settings_version > 0) suppressInitialPreview = true;
    populate(); refreshTaskCopy(); renderDirty = true;
    if (!replayOnly && item.generation != null) useGeneration(item.generation);
    if (dirty && !taskSwitching && (connected() || compilationEnabled())) settingsTimer = setTimeout(submitSettings, 350);
    controlsEnabled(); refreshPlanLabel();
  }
  async function refreshSettings({ initial = false, discardDraft = false } = {}) {
    const profileEpoch = schemaReload;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (disposed || profileSwitching || profileUnavailable || profileEpoch !== schemaReload) return;
      const epoch = settingsEpoch;
      try {
        const response = await fetch('/api/live/settings'), item = await response.json();
        if (disposed || profileSwitching || profileUnavailable || profileEpoch !== schemaReload || !response.ok) return;
        // A settings echo may beat this GET. Read once more rather than report
        // unavailable while discarding a snapshot that predates that echo.
        if (epoch !== settingsEpoch) continue;
        acceptSettings(item, { initial, discardDraft });
        return item;
      } catch { return; } // The event stream or next poll recovers disconnects.
    }
  }
  function scheduleSettingsRefresh() {
    clearTimeout(settingsPoll);
    if (disposed || !settingsPollMs) return;
    settingsPoll = setTimeout(async () => { await refreshSettings(); scheduleSettingsRefresh(); }, settingsPollMs);
  }
  const atRunStart = item => Math.abs(item?.sim_time_s ?? 0) < 1e-9;
  // The recorded Live state on display (never a start-pose draft), or the latest one.
  const displayedRecord = () => [presentedState, state, playingHold].find(value => value && !value.start_pose_draft
    && Number.isFinite(value.sim_time_s) && Array.isArray(value.q) && Array.isArray(value.qd) && validPoints([value.ee_xyz])) || null;
  const displayedAnchor = () => {
    const value = presentedState || history.at(clock.time)?.state || state;
    return value && Array.isArray(value.q) && Array.isArray(value.qd)
      ? { sim_time_s: value.sim_time_s, q: [...value.q], qd: [...value.qd] } : undefined;
  };
  async function send(command) {
    if (replayOnly && !['pause', 'cancel'].includes(command.type)) return false;
    if ((profileSwitching || profileUnavailable) && !['pause', 'cancel'].includes(command.type)) return false;
    if (profileNError && !['pause', 'cancel', 'reset_task_settings'].includes(command.type)) return false;
    try {
      const response = await fetch('/api/live/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
      const result = await response.json();
      if (response.status === 409 && result.settings) {
        acceptSettings(result.settings);
        message('Settings changed elsewhere · synchronized with the current values.');
        return { conflict: true };
      }
      if (!response.ok || !result.accepted) throw new Error(result.error || `HTTP ${response.status}`);
      return result;
    } catch (error) { if (!profileSwitching) message(`Command failed: ${error.message}`, true); return false; }
  }
  async function flushTaskDraft() {
    clearTimeout(settingsTimer);
    const draft = readSettings(true);
    if (!draft) throw new Error('Correct the highlighted settings before changing tasks.');
    settings = draft;
    dirty ||= !settingValuesEqual(settingsGroups(acceptedSettings || submittedSettings || defaultSettings), settingsGroups(draft));
    if (dirty && !await submitSettings()) throw new Error($('live-message').textContent || 'The current settings could not be saved.');
    const snapshot = await refreshSettings();
    if (!snapshot) throw new Error('Current task settings are unavailable. Try again.');
  }
  async function taskTransaction(command, reviewedVersion = null) {
    if (replayOnly || mode !== 'live' || taskSwitching || profileSwitching || profileUnavailable) throw new Error('Task settings are available in Live.');
    taskSwitching = true; controlsEnabled();
    try {
      await flushTaskDraft();
      if (reviewedVersion != null && reviewedVersion !== serverSettingsVersion) throw new Error('Task settings changed. Review the refreshed differences and apply again.');
      const response = await send({ ...command, expected_settings_version: reviewedVersion ?? serverSettingsVersion });
      if (!response || response.conflict) throw new Error(response?.conflict
        ? 'Task settings changed. Review the current values and try again.'
        : $('live-message').textContent || 'Task settings could not be changed.');
      const snapshot = await refreshSettings();
      if (!snapshot) throw new Error('Settings were accepted; reconnect to view the current task.');
      return snapshot;
    } finally { taskSwitching = false; controlsEnabled(); refreshTaskCopy(); }
  }
  async function switchTask(kind) {
    if (kind === settings.task.kind) return true;
    // Keep the outgoing form selected while reading and saving its latest draft.
    $('live-task').value = settings.task.kind;
    try { await taskTransaction({ type: 'switch_task', task_kind: kind }); return true; }
    catch (error) { $('live-task').value = settings.task.kind; message(error.message, true); return false; }
  }
  async function openTaskCopy() {
    if (taskDialogContext().readonly) return;
    try {
      await flushTaskDraft();
      copyDialog ||= createTaskSettingsDialog({ getContext: taskDialogContext,
        onApply: (sourceTask, paths, version) => taskTransaction({ type: 'transfer_settings', source_task: sourceTask, paths }, version) });
      copyDialog.open();
    } catch (error) { message(error.message, true); }
  }
  async function resetAllSettings() {
    if (taskDialogContext().readonly || !Number.isInteger(serverSettingsVersion)) return false;
    const profileEpoch = schemaReload, kind = settings.task.kind, version = serverSettingsVersion;
    clearTimeout(settingsTimer); ++submission;
    taskSwitching = true; controlsEnabled();
    try {
      const result = await send({ type: 'reset_task_settings', expected_settings_version: version });
      if (!result || result.conflict) throw new Error(result?.conflict
        ? 'Task settings changed. Review the current task and try again.'
        : $('live-message').textContent || 'Task settings could not be reset.');
      if (disposed || profileEpoch !== schemaReload || settings.task.kind !== kind) throw new Error('The task or solver changed while resetting settings.');
      const snapshot = await refreshSettings({ discardDraft: true });
      if (!snapshot) throw new Error('Settings were reset; reconnect to view the current task.');
      return true;
    } catch (error) { message(error.message, true); return false; }
    finally { taskSwitching = false; controlsEnabled(); refreshTaskCopy(); }
  }
  function calculationControls() {
    const stop = $('live-stop-at-end');
    stop.disabled = replayOnly;
    stop.title = 'Stop at the session end when replaying recorded motion; uncheck to continue simulation';
    stop.closest('label')?.setAttribute('title', stop.title);
    $('live-duration').title = 'Precalculation duration; Live Play continues until paused.';
  }
  function controlsEnabled() {
    $('live-task').disabled = replayOnly || mode !== 'live' || taskSwitching || profileSwitching || profileUnavailable;
    if (copyButton) copyButton.disabled = $('live-task').disabled;
    if (resetAllButton) resetAllButton.disabled = $('live-task').disabled;
    refreshTaskCopy();
    const unavailable = !connected();
    $('live-play').disabled = playbackDisabled();
    $('live-preview').disabled = unavailable;
    $('live-reset').disabled = replayOnly ? !anyPlayableSessionSpan() : unavailable;
    $('live-precalculate').disabled = unavailable;
    $('live-cancel').disabled = !transportConnected() || (!job.job_active && !pending);
    if ($('live-freeze')) $('live-freeze').disabled = unavailable || history.length < 2 || Boolean(job.job_active) || dirty || pending || freezing;
    $('live-play').textContent = clock.playing ? 'Pause' : 'Play';
    $('live-play').setAttribute('aria-label', clock.playing ? 'Pause session' : 'Play session');
    $('live-reset').setAttribute('aria-label', replayOnly ? 'Rewind replay' : 'Reset state');
    $('live-reset').title = replayOnly ? 'Rewind replay' : 'Reset state';
    $('live-panel').inert = replayOnly || taskSwitching;
    sourceFields?.setDisabled(replayOnly || taskSwitching);
    $('mode-label').textContent = replayOnly || mode !== 'live' ? 'TRAJECTORY REPLAY' : 'LIVE MPC · SIMULATION';
    $('live-calculation').disabled = replayOnly;
    $('live-latency-compensation').disabled = replayOnly;
    $('live-duration').disabled = replayOnly;
    $('live-to-asap').disabled = replayOnly;
    $('live-latency-measured').disabled = replayOnly;
    $('live-plan-age-enabled').disabled = replayOnly;
    $('live-to-hz').disabled = replayOnly || $('live-to-asap').checked;
    $('live-solve-latency').disabled = replayOnly || $('live-latency-measured').checked;
    $('live-max-plan-age').disabled = replayOnly || !$('live-plan-age-enabled').checked;
    if ($('session-replay-mode')) {
      $('session-replay-mode').setAttribute('aria-pressed', String(replayOnly));
      $('session-replay-mode').title = replayOnly ? 'Return to Live; keep recording tracks' : 'Replay recordings without simulation';
    }
    calculationControls();
    refreshHistoryControls();
    modelPrompt?.update(modelState, { visible: compilationEnabled() && mode === 'live' && !replayOnly && !profileSwitching && !profileUnavailable });
  }
  function readSettings(reportErrors = false, { allowUncompiled = false } = {}) {
    const next = cloneSettings(settings);
    try {
      for (const { parameter, input } of inputs) {
        input.setCustomValidity('');
        if (allowUncompiled && parameter.path === 'N' && input.value === '-1' && Number.isInteger(next.config.N)) continue;
        try { writePath(next.config, parameter.path, parseParameter(parameter, input)); }
        catch (error) { input.setCustomValidity(error.message); if (reportErrors) input.reportValidity(); throw error; }
      }
      for (const { parameter, widget } of nativeVectors) writePath(next.config, parameter.path, widget.read());
      if (schema.source_settings) next.source_settings = sourceFields?.read() || restoreWorktreeSettings(schema, next.source_settings);
      if (!allowUncompiled && !(compilationEnabled() ? supportedKnotCounts(schema) : schema.available_N).includes(next.config.N)) throw new Error('Choose an available knot count.');
      const kind = $('live-task').value, descriptor = schema.tasks?.find(task => task.kind === kind);
      next.task = { ...(descriptor?.defaults || { kind: 'reach' }), ...(settings.task.kind === kind ? settings.task : {}), kind };
      for (const parameter of descriptor?.parameters || []) {
        const input = document.querySelector(`[data-task-path="${parameter.path}"]`);
        if (!input) continue;  // the task setup is being rebuilt for another kind
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
      for (const [key, id] of [['simulation_hz', 'live-simulation-hz'], ['control_hz', 'live-control-hz'], ['duration_s', 'live-duration']]) {
        execution[key] = readTimeInput($(id), { unit: key.endsWith('_hz') ? 'Hz' : 's', min: 0, minExclusive: true, label: key.replaceAll('_', ' ') });
      }
      execution.to_hz = $('live-to-asap').checked ? 0 : readTimeInput($('live-to-hz'), { unit: 'Hz', min: 0, minExclusive: true, label: 'TO rate' });
      execution.calculation = $('live-calculation').value || execution.calculation;
      const latencyInput = $('live-solve-latency');
      latencyInput.setCustomValidity('');
      try { execution.solve_latency_s = $('live-latency-measured').checked ? 'measured' : readTimeInput(latencyInput, { unit: 's', min: 0, label: 'Solve latency' }); }
      catch (error) { latencyInput.setCustomValidity(error.message); if (reportErrors) latencyInput.reportValidity(); throw error; }
      const ageInput = $('live-max-plan-age');
      ageInput.setCustomValidity('');
      try { execution.max_plan_age_s = $('live-plan-age-enabled').checked ? readTimeInput(ageInput, { unit: 's', min: 0, minExclusive: true, label: 'Maximum plan age' }) : null; }
      catch (error) { ageInput.setCustomValidity(error.message); if (reportErrors) ageInput.reportValidity(); throw error; }
      execution.latency_compensation = Boolean($('live-latency-compensation').checked);
      execution.continue_at_end = Boolean($('live-continue').checked);
      next.execution = validateExecution(execution);
    } catch (error) { if (reportErrors) message(error.message, true); return null; }
    return next;
  }
  async function submitSettings() {
    clearTimeout(settingsTimer);
    if (obstacleGesture) return false;  // the gesture submits once, when it ends
    if (mode !== 'live' || replayOnly || !liveReady || profileSwitching || profileUnavailable || (!compilationEnabled() && profileNError)) return false;
    const request = ++submission;
    let next = readSettings(true);
    if (!next) return false;
    // Pause before the first await so Play can retain its newer intent while
    // model readiness and the settings acknowledgement arrive asynchronously.
    pausePlayback();
    if (compilationEnabled()) {
      const checked = await modelCompilation.check();
      if (!checked?.compilation.ready || request !== submission || profileSwitching || profileUnavailable || replayOnly || mode !== 'live') return false;
      // Runtime/task edits may arrive while the native lookup is in flight.
      // Never submit the older local snapshot after that asynchronous boundary.
      next = readSettings(true);
      if (!next) return false;
    }
    const patch = acceptedSettings ? settingsPatch(acceptedSettings, next) : null;
    if (patch && !initialResetPending && Object.keys(patch).length === 0) {
      settings = next; submittedSettings = cloneSettings(acceptedSettings); dirty = false;
      resetIndicators.update(); controlsEnabled(); refreshPlanLabel();
      return true;
    }
    settings = next; submittedSettings = cloneSettings(next); pending = true; dirty = false; inspectingPreview = false;
    const previousExpectedVersion = expectedVersion;
    expectedVersion = Math.max(expectedVersion ?? 0, settingsVersion ?? 0) + 1;
    // A new start pose starts a new run at t = 0 from it, as Reset.
    const resetting = initialResetPending || !settingValuesEqual(startPoseValue(next.config), acceptedStartPose);
    // An edit made while playing continues from the recorded state displayed now, not from
    // where the edit began; that state stays drawn until the new segment's history arrives.
    const keepPlaying = playingEdit && clock.playing && !resetting; playingEdit = false;
    const shown = keepPlaying ? displayedRecord() : null;
    playingHold = shown;
    const anchor = resetting ? undefined : shown ? { sim_time_s: shown.sim_time_s, q: [...shown.q], qd: [...shown.qd] }
      : frozenAnchor || displayedAnchor();
    controlsEnabled(); refreshPlanLabel();
    message(next.execution.calculation === 'automatic' ? 'Replacing calculation from the displayed starting state…' : 'Updating one-horizon preview…');
    const transaction = patch && !initialResetPending ? { type: 'patch_settings', patch } : { type: 'set_settings', ...next };
    if (serverSettingsVersion != null) transaction.expected_settings_version = serverSettingsVersion;
    const trackedRequest = { version: expectedVersion, settings: cloneSettings(next), keepPlaying };
    settingsRequests.push(trackedRequest); if (settingsRequests.length > 16) settingsRequests.shift();
    const accepted = await send({ ...transaction, ...(resetting ? { reset: true } : anchor ? { anchor } : {}) });
    if (Number.isInteger(accepted?.settings_version)) trackedRequest.version = accepted.settings_version;
    if (request !== submission) return Boolean(accepted);
    if (accepted?.conflict) return false;
    if (accepted && serverSettingsVersion != null && accepted.settings_version < serverSettingsVersion) return false;
    if (!accepted) { pending = false; dirty = true; expectedVersion = previousExpectedVersion; }
    else {
      if (resetting) { initialResetPending = false; onReset(); }
      acceptedStartPose = startPoseValue(next.config);
      if (Number.isInteger(accepted.settings_version)) expectedVersion = settingsVersion = accepted.settings_version;
      // A playing edit keeps a generation its events already switched to (and its records).
      if (accepted.generation != null) useGeneration(accepted.generation, !keepPlaying);
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
  function refreshFrictionAvailability() {
    if (compilationEnabled()) {
      const available = modelState.probe?.compilation.available_N ?? (modelState.phase === 'idle' ? schema.available_N : null);
      profileNError = modelState.phase === 'ready' ? false : modelState.phase === 'idle' ? !schema.available_N.includes(settings.config.N) : true;
      const missing = modelState.phase === 'missing';
      const knot = inputs.find(item => item.parameter.path === 'N');
      if (knot) {
        for (const option of knot.input.children) {
          const n = knot.parameter.choices[Number(option.value)], absent = n != null && available != null && !available.includes(n);
          option.disabled = n == null; option.className = absent ? 'model-uncompiled' : '';
          if (n != null) option.textContent = `${n}${absent ? ' · not compiled' : ''}`;
        }
        knot.input.classList.toggle('model-uncompiled', missing);
      }
      sourceFields?.setModelMissing(missing);
      for (const { parameter, input } of inputs) if (parameter.effect === 'compiled_model') input.closest('label')?.classList.toggle('model-uncompiled', missing);
      for (const { parameter, row } of resolvedFields) row.classList.toggle('model-uncompiled', missing && parameter.effect === 'compiled_model');
      $('live-source').textContent = available ? `${modelState.phase === 'ready' ? 'Model ready · ' : ''}compiled N for this predictor: ${available.join(', ') || 'none'}` : 'Checking the exact predictor model…';
      $('live-source').title = modelState.probe?.compilation.binary_path || '';
      return;
    }
    const available = availableKnotCounts(schema, settings.config);
    profileNError = !available.includes(settings.config.N);
    const knot = inputs.find(item => item.parameter.path === 'N');
    if (knot) for (const option of knot.input.children) {
      const value = knot.parameter.choices[Number(option.value)];
      option.disabled = !available.includes(value);
      if (value != null) option.textContent = `${value}${option.disabled ? ' · unavailable' : ''}`;
    }
    const commit = schema.source?.mpc_commit;
    $('live-source').textContent = `tiago_mpc ${commit ? String(commit).slice(0, 8) : 'local'} · compiled N${schema.exact_availability ? ' (current predictor)' : schema.available_N_by_friction ? settings.config.friction ? ' (predictor friction)' : ' (loss-free predictor)' : ''}: ${available.join(', ') || 'none'}`;
  }
  // A Build into the active solver's checkout adds modules without a backend
  // restart: list them, and calculate a draft whose N just became available.
  function acceptCompiledModules(item) {
    if (!schema || !Array.isArray(item.available_N) || !item.available_N_by_friction) return;
    if (item.settings_version != null && settingsVersion != null && item.settings_version < settingsVersion) return;
    schema.available_N = [...item.available_N]; schema.available_N_by_friction = structuredClone(item.available_N_by_friction);
    if (item.exact_availability != null) schema.exact_availability = item.exact_availability;
    const spec = schema.parameters?.find(parameter => parameter.path.replace(/^config\./, '') === 'N');
    if (spec) spec.choices = supportedKnotCounts(schema);
    if (compilationEnabled()) { refreshFrictionAvailability(); controlsEnabled(); return; }
    const knot = inputs.find(entry => entry.parameter.path === 'N');
    if (!knot) return;
    if (knot.parameter.disabled) { refreshFrictionAvailability(); controlsEnabled(); return; }
    const value = settings.config.N, wasUnavailable = profileNError;
    knot.parameter.choices = schema.available_N;
    const options = schema.available_N.map((n, i) => { const option = document.createElement('option'); option.value = String(i); option.textContent = String(n); return option; });
    if (!schema.available_N.includes(value)) { const option = document.createElement('option'); option.value = '-1'; option.textContent = `${value} · unavailable`; option.disabled = true; options.push(option); }
    knot.input.replaceChildren(...options); knot.input.value = String(schema.available_N.includes(value) ? schema.available_N.indexOf(value) : -1);
    refreshFrictionAvailability();
    if (wasUnavailable && !profileNError) knot.input.dispatchEvent(new Event('input', { bubbles: true }));
    else controlsEnabled();
  }
  // Plant friction needs semi-implicit Euler (RK4 is loss-free); the Coulomb law applies
  // only with plant friction, and the width only to the tanh law (Felix, 2026-10-23).
  function syncPlantFriction() {
    const field = path => inputs.find(item => item.parameter.path === path);
    const integrator = field('plant.integrator'), friction = field('plant.friction'), law = field('plant.coulomb_law'), width = field('plant.friction_width_rad_s');
    if (!integrator || !friction) return;
    const rk4 = parseParameter(integrator.parameter, integrator.input) === 'rk4';
    if (rk4) friction.input.checked = false;
    friction.input.disabled = rk4;
    friction.input.title = rk4 ? 'RK4 is loss-free: choose semi-implicit Euler for plant friction' : parameterTooltip(friction.parameter);
    if (law) { law.input.disabled = !friction.input.checked; law.input.title = law.input.disabled ? 'Plant friction is off' : parameterTooltip(law.parameter); }
    if (width) {
      const host = width.input.closest('label'); if (host?.parentElement) host.parentElement.hidden = !law || parseParameter(law.parameter, law.input) !== 'tanh';
      width.input.disabled = !friction.input.checked;
    }
  }
  // Switching the goal on starts from the last goal switched off, or else from the grasp
  // frame's orientation as displayed.
  function setOrientationGoal(on) {
    if (settings?.task.kind !== 'reach') return;
    if (on && !orientationGoal(settings.task)) {
      const goal = orientationDraft || graspOrientation();
      if (!goal) return;
      settings.task.orientation_rad = [...goal];
    } else if (!on && orientationGoal(settings.task)) {
      orientationDraft = orientationGoal(settings.task);
      settings.task.orientation_rad = null;
    } else return;
    change();
  }
  const unavailableFrictionMessage = () => compilationEnabled() ? 'This predictor model is not compiled. Use Compile above the viewport; the active settings are unchanged.' : `N=${settings.config.N} is not compiled for this predictor. Choose a compiled N or build the current predictor in Settings › Backend.`;
  function change({ keepPlaying = false } = {}) {
    if (replayOnly) return;
    const wasCompatible = !profileNError, obsoleteWork = job.job_active || pending || extensionPending;
    // Only an edit that keeps playing (obstacles) leaves On Play running; any other edit pauses.
    playingEdit = keepPlaying && clock.playing && settings?.execution.calculation === 'on_play' && (playingEdit || !dirty);
    if (!dirty && !pending && !playingEdit) frozenAnchor = displayedAnchor();
    syncPlantFriction();
    const next = readSettings();
    const sourceChanged = next && !settingValuesEqual(next.source_settings, (acceptedSettings || submittedSettings)?.source_settings);
    if (next) {
      settings = next;
      if (next.execution.to_hz > 0) fixedToDraft = next.execution.to_hz;
      if (typeof next.execution.solve_latency_s === 'number') declaredLatencyDraft = next.execution.solve_latency_s;
      if (typeof next.execution.max_plan_age_s === 'number') maxPlanAgeDraft = next.execution.max_plan_age_s;
    }
    if (compilationEnabled()) modelCompilation?.invalidate();
    if (compilationEnabled() && !next) modelCompilation?.check();
    refreshFrictionAvailability();
    calculationControls();
    dirty = true; renderDirty = true; if (!playingEdit) pausePlayback(); refreshPlanLabel();
    controlsEnabled();
    resetIndicators.update();
    const missingModel = profileNError && (!compilationEnabled() || modelState.phase === 'missing');
    message(profileSwitching ? 'Solver switching · settings draft retained.' : profileUnavailable ? 'No solver is active · settings draft retained.' : missingModel ? unavailableFrictionMessage() : 'Settings changed · replacing obsolete calculation…', missingModel);
    // An unsupported draft cannot reach set_settings, which normally stops
    // obsolete numerical work. Cancel it now; keep the frozen edit anchor and
    // let authoritative status report completion rather than a late HTTP reply.
    if (wasCompatible && profileNError && obsoleteWork && mode === 'live' && transportConnected()) send({ type: 'cancel' });
    else if (sourceChanged && obsoleteWork && !playingEdit && mode === 'live' && transportConnected()) send({ type: 'cancel' });
    clearTimeout(settingsTimer); if (!profileSwitching && !profileUnavailable) settingsTimer = setTimeout(submitSettings, 350);
  }
  // The viewport's selected obstacle, outlined in the list (also after a repopulation).
  function outlineObstacle() {
    for (const parameter of shapeSettings()) sourceFields?.field('predictor', parameter.path)?.highlight?.(
      obstacleHighlight?.path === parameter.path ? obstacleHighlight.index : null);
  }
  // An earlier settings document becomes the draft and is submitted as an ordinary edit:
  // the same anchor, model check, Compile prompt and start-pose rule; Play keeps playing.
  const historyEditable = () => !disposed && mode === 'live' && !replayOnly && liveReady
    && !taskSwitching && !profileSwitching && !profileUnavailable && !obstacleGesture;
  function applySettingsDocument(doc) {
    if (!historyEditable() || !doc || doc.task.kind !== settings.task.kind) return false;
    settings = cloneSettings({ ...settings, ...doc }); poseDraft = null;
    populate(); change({ keepPlaying: true });
    clearTimeout(settingsTimer); submitSettings();
    return true;
  }
  // A new obstacle, in the rows' root frame, around the point halfway between the displayed
  // grasp point and the task target (without both, ahead of the torso): a sphere, a capsule
  // along y, an upright box, or a plane: a wall ahead of that point, free towards the robot.
  // Selected in the viewport once added.
  function newObstacle(parameter) {
    const transform = latestContext()?.world_from_root, shown = presentedState || state;
    const target = desiredReference?.target_xyz, size = parameter.default_size ?? .05;
    // Halfway between the displayed grasp point and the target, else whichever of them exists.
    const points = [shown?.ee_xyz, target].filter(point => validPoints([point]));
    const [x, y, z] = transform && points.length
      ? worldToRoot(transform, [0, 1, 2].map(i => points.reduce((sum, point) => sum + point[i], 0) / points.length)) : [.4, -.4, -.3];
    obstacleAdded = { path: parameter.path, serial: (obstacleAdded?.serial ?? 0) + 1 };
    const created = { sphere: [x, y, z, size], capsule: [x, y - .1, z, x, y + .1, z, size * .6],
      box: [x, y, z, 0, 0, 0, 1, size, size, size], plane: [-1, 0, 0, -(x + .25)] }[parameter.shape];
    return created && clampShape(parameter, created);
  }
  function populate() {
    const groupsOpen = new Map([...($('live-settings').querySelectorAll?.('details') || [])].map(group => [group.querySelector('summary')?.textContent, group.open]));
    const timeDrafts = new Map(inputs.filter(({ parameter }) => canonicalTimeUnit(parameter)).map(({ parameter, input }) => [parameter.path, input.value]));
    const horizonDraft = document.querySelector('[data-horizon="seconds"]')?.value;
    const taskTimeDrafts = new Map((schema.tasks || []).flatMap(task => (task.parameters || []).filter(canonicalTimeUnit)
      .map(parameter => [parameter.path, document.querySelector(`[data-task-path="${parameter.path}"]`)?.value])).filter(([, value]) => value != null));
    const focusPath = document.activeElement?.dataset?.path;
    const focusSource = { ...document.activeElement?.dataset };
    const horizonSelection = focusSource.horizon === 'seconds'
      ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    sourceFields?.destroy(); sourceFields = null;
    nativeVectors.forEach(({ widget }) => widget.destroy()); nativeVectors = [];
    resolvedFields = []; gatoDefaultFields = [];
    populationBindings.forEach(([input, type, callback]) => input.removeEventListener?.(type, callback)); populationBindings = [];
    resetIndicators.clear(); inputs.length = 0;
    $('live-settings').replaceChildren(); $('live-horizon-settings')?.replaceChildren();
    const sourceHost = document.createElement('div'); sourceHost.className = 'worktree-settings-host';
    if (schema.source_settings) $('live-settings').append(sourceHost);
    const listen = (input, type, callback) => { input.addEventListener(type, callback); populationBindings.push([input, type, callback]); };
    const resetInput = (input, value, parameter = {}) => {
      input.setCustomValidity('');
      if (parameter.kind === 'bool') input.checked = value;
      else if (parameter.kind === 'choice') input.value = parameter.choices.findIndex(choice => settingValuesEqual(choiceValue(choice), value));
      else input.value = value == null ? '' : String(value);
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
    const activeTaskDefaults = () => baselineForTask($('live-task').value).task;
    const taskFields = () => {
      resetIndicators.forget('task-parameters');
      const descriptor = tasks.find(task => task.kind === $('live-task').value);
      $('live-task-parameters').replaceChildren();
      const current = settings.task.kind === descriptor?.kind ? settings.task : descriptor?.defaults;
      let orientationCheckbox = null;
      for (const parameter of descriptor?.parameters || []) {
        const label = document.createElement('label'); label.className = 'parameter-row';
        const caption = document.createElement('span'); caption.textContent = parameter.label;
        const input = document.createElement('input'); input.type = 'number'; input.step = 'any'; input.required = true;
        input.dataset.taskPath = parameter.path; input.min = parameter.min; input.max = parameter.max;
        input.value = current?.[parameter.path];
        if (canonicalTimeUnit(parameter)) {
          const canonical = input.value, unit = canonicalTimeUnit(parameter);
          configureTimeInput(input, { unit });
          if (taskTimeDrafts.has(parameter.path)) input.value = taskTimeDrafts.get(parameter.path);
          setTimeInputValue(input, canonical, { ...parameter, unit });
        }
        listen(input, 'input', change); label.append(caption, input); $('live-task-parameters').append(label);
        bindReset(input, { ...parameter, kind: parameter.kind || 'float' }, () => activeTaskDefaults()[parameter.path], { key: `task.${parameter.path}`, group: 'task-parameters' });
      }
      if (descriptor?.kind === 'reach' && orientationGoalSupported(schema)) {
        const label = document.createElement('label'); label.className = 'parameter-row orientation-goal';
        label.title = 'Also hold the grasp frame at a goal orientation. R in the viewport rotates the goal; its weights are under Costs.';
        const caption = document.createElement('span'); caption.textContent = 'Orientation goal';
        const input = document.createElement('input'); input.type = 'checkbox'; input.id = 'target-orientation'; orientationCheckbox = input;
        input.checked = settings.task.kind === 'reach' && Boolean(orientationGoal(settings.task));
        listen(input, 'change', () => { setOrientationGoal(input.checked); input.checked = Boolean(orientationGoal(settings.task)); });
        label.append(caption, input); $('live-task-parameters').append(label);
      }
      const poseCaption = document.createElement('span'); poseCaption.className = 'task-pose-reset-caption'; poseCaption.textContent = 'Task pose';
      $('live-task-parameters').append(poseCaption);
      resetIndicators.bind({ key: 'task.pose', name: 'task pose', host: poseCaption, group: 'task-parameters', focusTarget: $('target-offset-0'),
        getValue: () => ({ offset: [0, 1, 2].map(i => parseParameter({ kind: 'float', label: 'Target offset', min: -1, max: 1 }, $(`target-offset-${i}`))),
          orientation: canonicalOrientation(settings.task.kind === $('live-task').value ? settings.task.orientation_xyzw : undefined),
          goal: orientationGoal(settings.task) }),
        getDefault: () => ({ offset: activeTaskDefaults().target_offset_m, orientation: canonicalOrientation(activeTaskDefaults().orientation_xyzw),
          goal: orientationGoal(activeTaskDefaults()) }),
        reset: value => {
          value.offset.forEach((offset, i) => { $(`target-offset-${i}`).value = String(offset); $(`target-offset-${i}`).setCustomValidity(''); });
          if ($('live-task').value === 'figure8') settings.task.orientation_xyzw = [...value.orientation];
          else if ($('live-task').value === 'reach' && orientationGoalSupported(schema)) {
            settings.task.orientation_rad = value.goal ? [...value.goal] : null;
            orientationDraft = null;
            if (orientationCheckbox) orientationCheckbox.checked = Boolean(value.goal);
          }
          change();
        },
      });
      $('live-task-note').textContent = descriptor?.kind === 'figure8' ? 'G moves the path in world coordinates; R rotates and S scales width/height about its start. Period sets speed. Reset restarts phase.'
        : 'Offset from the default reaching target. Click the target to move it along an axis; with an orientation goal, R rotates it.';
    };
    taskFields(); listen($('live-task'), 'change', () => switchTask($('live-task').value));
    if (!copyButton) {
      const actions = document.createElement('div'); actions.className = 'task-settings-actions';
      copyButton = document.createElement('button'); copyButton.type = 'button'; copyButton.className = 'task-copy-button';
      copyButton.id = 'live-task-copy'; copyButton.textContent = 'Copy settings from…';
      copyButton.addEventListener('click', openTaskCopy);
      resetAllButton = document.createElement('button'); resetAllButton.type = 'button'; resetAllButton.className = 'task-copy-button';
      resetAllButton.id = 'live-task-reset-all'; resetAllButton.textContent = 'Reset all';
      resetAllButton.title = 'Restore all settings for the selected task to its defaults';
      resetAllButton.addEventListener('click', resetAllSettings);
      actions.append(copyButton, resetAllButton);
      $('live-task').parentElement?.insertAdjacentElement?.('afterend', actions);
    }
    if (schema.source_settings) sourceFields = createWorktreeFields({ container: sourceHost, schema: { ...schema, source_settings: Object.fromEntries(Object.entries(schema.source_settings).map(([role, section]) => [role, { ...section, defaults: defaultSettings.source_settings?.[role] || section.defaults }])) },
      values: settings.source_settings, groupsOpen, onChange: change, onResetBinding: options => resetIndicators.bind(options), newShape: newObstacle });
    outlineObstacle();
    const groups = new Map(), rows = new Map();
    const horizonRow = document.createElement('div'); horizonRow.className = 'horizon-row';
    ($('live-horizon-settings') || $('live-settings')).append(horizonRow);
    let horizonInput;
    const syncHorizon = () => {
      const n = inputs.find(item => item.parameter.path === 'N');
      const dt = inputs.find(item => item.parameter.path === 'dt_s');
      if (!n || !dt || !horizonInput) return;
      const count = parseParameter(n.parameter, n.input);
      let seconds;
      try { seconds = parseParameter(dt.parameter, dt.input); } catch { seconds = NaN; }
      horizonInput.min = (count - 1) * dt.parameter.min; horizonInput.max = (count - 1) * dt.parameter.max;
      if (Number.isFinite(seconds)) setTimeInputValue(horizonInput, Number(((count - 1) * seconds).toPrecision(12)), { unit: 's' });
      else horizonInput.value = '';
      horizonInput.setCustomValidity('');
    };
    const customFriction = ['simulation', 'predictor'].some(role =>
      schema.source_settings?.[role]?.controls?.some(path => path === 'friction' || path.startsWith('friction.')));
    for (const supplied of schema.parameters) {
      const parameter = { ...supplied, path: supplied.path.replace(/^config\./, '') };
      if (parameter.path === 'N') { parameter.kind = 'choice'; parameter.choices = supportedKnotCounts(schema); }
      if (parameter.kind === 'joints') continue;  // the start pose: edited in the Joints tab
      const name = parameter.path.startsWith('plant.') ? parameter.group === 'Limit handling' ? 'Plant limit handling' : 'Plant dynamics'
        : ['friction', 'armature'].includes(parameter.path) ? 'Predictor dynamics'
        : parameter.group === 'Limits' ? 'MPC bounds' : parameter.group || 'Settings';
      const isHorizon = ['N', 'dt_s'].includes(parameter.path);
      if (!groups.has(name)) {
        // A native field shares its adapter's group (e.g. the resolved Collision row).
        const existing = sourceFields?.groupFields(name === 'Plant dynamics' ? 'simulation' : 'predictor', name)
          || sourceFields?.groupFields('simulation', name);
        if (existing) groups.set(name, existing);
      }
      if (!isHorizon && !groups.has(name)) {
        const details = document.createElement('details'); details.className = 'settings-group'; details.open = groupsOpen.get(name) ?? (groups.size === 0 || ['Plant dynamics', 'Predictor dynamics', 'Plant limit handling'].includes(name));
        const summary = document.createElement('summary'); summary.textContent = name;
        const fields = document.createElement('div'); fields.className = 'settings-fields'; details.append(summary);
        if (name === 'Plant dynamics' && !customFriction) {
          const coefficients = schema.friction?.coefficients;
          for (const [key, unit] of [['coulomb_nm', 'Coulomb (Nm)'], ['viscous_nm_s_per_rad', 'Viscous (Nm s/rad)']]) {
            if (!Array.isArray(coefficients?.[key])) continue;
            const values = document.createElement('p'); values.className = 'settings-note';
            values.textContent = `${unit}, joints 1–7: ${coefficients[key].join(', ')}`;
            values.title = `From the ${schema.friction.source || 'URDF'}; used by plant and predictor friction`; details.append(values);
          }
        }
        details.append(fields); $('live-settings').append(details); groups.set(name, fields);
      }
      const label = document.createElement(parameter.kind === 'vector' ? 'div' : 'label'); label.className = 'parameter-row';
      const text = document.createElement('span'); text.textContent = parameter.label || parameter.path;
      text.title = parameterTooltip(parameter);
      if (parameter.controlled_by_source) {
        const output = document.createElement('output'); output.className = 'resolved-native-setting';
        const effective = fieldValue(effectiveSettings || schema.effective_settings, parameter.effective_path || `params.${parameter.path}`);
        output.textContent = resolvedValueText(effective); output.title = parameterTooltip(parameter);
        resolvedFields.push({ output, path: parameter.effective_path || `params.${parameter.path}`, row: label, parameter });
        label.classList.add('resolved-row'); label.append(text, output); groups.get(name).append(label);
        continue;
      }
      if (parameter.kind === 'vector') {
        const widget = createVectorField(parameter, readPath(settings.config, parameter.path), change);
        label.className = 'parameter-row vector-row'; label.append(text, widget.element); groups.get(name).append(label);
        widget.disable(Boolean(parameter.disabled)); nativeVectors.push({ parameter, widget });
        resetIndicators.bind({ key: `config.${parameter.path}`, name: parameter.label || parameter.path,
          input: widget.focus, host: label, getValue: widget.read, getDefault: () => readPath(defaultSettings.config, parameter.path),
          reset: value => { widget.set(value); change(); } });
        continue;
      }
      const input = document.createElement(parameter.kind === 'choice' ? 'select' : 'input'); input.dataset.path = parameter.path; input.name = parameter.path;
      const value = readPath(settings.config, parameter.path);
      if (parameter.kind === 'choice') {
        for (const [i, choice] of parameter.choices.entries()) {
          const item = document.createElement('option'), object = choice && typeof choice === 'object', typedValue = choiceValue(choice);
          item.value = String(i); item.textContent = object ? choice.label || String(typedValue ?? 'Default') : String(choice ?? 'Default'); item.selected = settingValuesEqual(typedValue, value); input.append(item);
          if (parameter.gato_default && typedValue === null) gatoDefaultFields.push({ path: parameter.path, option: item, input, parameter });
        }
        if (parameter.path === 'N' && !supportedKnotCounts(schema).includes(value)) {
          const unavailable = document.createElement('option'); unavailable.value = '-1'; unavailable.textContent = `${value} · unavailable`; unavailable.disabled = true; unavailable.selected = true; input.append(unavailable); input.value = '-1';
        }
      } else if (parameter.kind === 'bool') { input.type = 'checkbox'; input.checked = Boolean(value); }
      else {
        input.type = 'number'; input.step = parameter.kind === 'int' ? '1' : 'any'; if (parameter.min != null) input.min = parameter.min; if (parameter.max != null) input.max = parameter.max;
        input.value = value == null ? '' : value; input.required = !parameter.nullable;
        if (parameter.nullable) input.placeholder = 'none';
        if (parameter.gato_default) gatoDefaultFields.push({ path: parameter.path, input, parameter });
      }
      input.disabled = Boolean(parameter.disabled); input.title = parameterTooltip(parameter); listen(input, 'input', () => {
        if (isHorizon) {
          if (parameter.path === 'N' && input.value !== '-1') profileNError = false;
          if (!profileNError) { if (horizonInput) horizonInput.disabled = false; syncHorizon(); }
        }
        change();
      });
      const timeUnit = canonicalTimeUnit(parameter);
      if (timeUnit) {
        configureTimeInput(input, { unit: timeUnit });
        if (timeDrafts.has(parameter.path)) input.value = timeDrafts.get(parameter.path);
        setTimeInputValue(input, value, { ...parameter, unit: timeUnit });
      }
      if (isHorizon) { label.className = 'horizon-field'; text.textContent = parameter.path === 'N' ? 'N' : 'Δt (s)'; }
      let host = isHorizon ? horizonRow : groups.get(name);
      if (parameter.row) {
        // Checkboxes sharing a row (Stop on breach: joint limits, velocity, torque) sit side by side.
        if (!rows.has(parameter.row)) {
          const row = document.createElement('div'); row.className = 'parameter-row check-row';
          const caption = document.createElement('span'); caption.textContent = parameter.row;
          const checks = document.createElement('div'); checks.className = 'row-checks';
          row.append(caption, checks); host.append(row); rows.set(parameter.row, checks);
        }
        host = rows.get(parameter.row); label.className = 'row-check'; label.title = input.title;
        label.append(input, text);
      } else label.append(text, input);
      host.append(label); inputs.push({ parameter, input });
      bindReset(input, parameter, () => readPath(defaultSettings.config, parameter.path), { key: `config.${parameter.path}` });
    }
    const groupOrder = ['Plant dynamics', 'Plant limit handling', 'Execution controller', 'Execution law', 'Predictor dynamics', 'Collision rows', 'MPC bounds', 'Costs', 'Solver', 'ADMM'];
    const groupContainer = schema.source_settings ? sourceHost : $('live-settings');
    const details = [...sourceHost.children, ...$('live-settings').children].filter(node => node.tagName?.toLowerCase() === 'details');
    const order = node => { const index = groupOrder.indexOf(node.children[0]?.textContent); return index < 0 ? groupOrder.length : index; };
    details.sort((a, b) => order(a) - order(b)).forEach(node => groupContainer.append(node));
    refreshGatoDefaults();
    if (inputs.some(item => item.parameter.path === 'dt_s')) {
      const label = document.createElement('label'); label.className = 'horizon-field';
      const text = document.createElement('span'); text.textContent = 'Horizon (s)';
      horizonInput = document.createElement('input'); horizonInput.type = 'number'; horizonInput.step = 'any'; horizonInput.required = true;
      horizonInput.disabled = profileNError;
      horizonInput.dataset.horizon = 'seconds'; horizonInput.title = 'Horizon = (N − 1) × Δt';
      configureTimeInput(horizonInput, { unit: 's' });
      if (horizonDraft != null) horizonInput.value = horizonDraft;
      listen(horizonInput, 'input', () => {
        const n = inputs.find(item => item.parameter.path === 'N'), dt = inputs.find(item => item.parameter.path === 'dt_s');
        const count = parseParameter(n.parameter, n.input);
        try { dt.input.value = String(Number((readTimeInput(horizonInput, { unit: 's', min: Number(horizonInput.min), max: Number(horizonInput.max) }) / (count - 1)).toPrecision(12))); }
        catch { dt.input.value = ''; }
        change();
        horizonInput.setCustomValidity(dt.input.validationMessage || '');
      });
      label.append(text, horizonInput); horizonRow.append(label); if (!profileNError) syncHorizon();
      resetIndicators.bind({ key: 'config.horizon_s', name: 'horizon', input: horizonInput,
        getValue: () => readTimeInput(horizonInput, { unit: 's', label: 'Horizon', min: Number(horizonInput.min), max: Number(horizonInput.max) }),
        getDefault: () => (parseParameter(inputs.find(item => item.parameter.path === 'N').parameter, inputs.find(item => item.parameter.path === 'N').input) - 1) * defaultSettings.config.dt_s,
        reset: () => { resetInput(inputs.find(item => item.parameter.path === 'dt_s').input, defaultSettings.config.dt_s); },
      });
    }
    settings.task.target_offset_m.forEach((value, i) => {
      const input = $(`target-offset-${i}`); input.value = value; listen(input, 'input', change);
      bindReset(input, { kind: 'float', path: `target_offset_m.${i}`, label: `target ${['X', 'Y', 'Z'][i]}`, min: -1, max: 1 }, () => activeTaskDefaults().target_offset_m[i], { key: `task.target_offset_m.${i}` });
    });
    settings.execution = validateExecution({ ...DEFAULT_EXECUTION, ...(settings.execution || schema.defaults.execution || {}) });
    $('live-to-asap').checked = settings.execution.to_hz === 0;
    if (settings.execution.to_hz > 0) fixedToDraft = settings.execution.to_hz;
    for (const [key, id] of [['simulation_hz', 'live-simulation-hz'], ['control_hz', 'live-control-hz'], ['to_hz', 'live-to-hz'], ['duration_s', 'live-duration'], ['calculation', 'live-calculation']]) {
      const input = $(id), unit = key.endsWith('_hz') ? 'Hz' : 's';
      if (key === 'calculation') input.value = settings.execution[key];
      else { configureTimeInput(input, { unit }); setTimeInputValue(input, key === 'to_hz' ? fixedToDraft : settings.execution[key], { unit }); }
      listen(input, 'input', change);
      const baseline = { ...DEFAULT_EXECUTION, ...defaultSettings.execution };
      if (key === 'calculation') resetIndicators.bind({ key: `execution.${key}`, name: 'calculation mode', input,
        getValue: () => input.value, getDefault: () => baseline[key], reset: value => resetInput(input, value) });
      else if (key === 'to_hz') resetIndicators.bind({ key: 'execution.to_hz', name: 'TO rate', input,
        getValue: () => $('live-to-asap').checked ? 0 : readTimeInput(input, { unit: 'Hz', min: 0, minExclusive: true }),
        getDefault: () => baseline.to_hz,
        reset: value => { $('live-to-asap').checked = value === 0; if (value > 0) { fixedToDraft = value; setTimeInputValue(input, value, { unit: 'Hz', force: true }); } change(); } });
      else bindReset(input, { kind: 'float', path: key, unit, label: key.replaceAll('_', ' '), min: Number.MIN_VALUE }, () => baseline[key], { key: `execution.${key}` });
    }
    listen($('live-to-asap'), 'change', change);
    const latencyInput = $('live-solve-latency');
    const measured = $('live-latency-measured');
    measured.checked = settings.execution.solve_latency_s === 'measured';
    if (!measured.checked) declaredLatencyDraft = settings.execution.solve_latency_s;
    configureTimeInput(latencyInput, { unit: 's' });
    setTimeInputValue(latencyInput, declaredLatencyDraft, { unit: 's', min: 0 });
    listen(latencyInput, 'input', change);
    listen(measured, 'change', change);
    resetIndicators.bind({ key: 'execution.solve_latency_s', name: 'solve latency', input: latencyInput,
      getValue: () => measured.checked ? 'measured' : readTimeInput(latencyInput, { unit: 's', min: 0 }), getDefault: () => defaultSettings.execution?.solve_latency_s ?? DEFAULT_EXECUTION.solve_latency_s,
      reset: value => { measured.checked = value === 'measured'; if (!measured.checked) { declaredLatencyDraft = value; setTimeInputValue(latencyInput, value, { unit: 's', min: 0, force: true }); } change(); } });
    const ageInput = $('live-max-plan-age'), ageEnabled = $('live-plan-age-enabled');
    ageEnabled.checked = settings.execution.max_plan_age_s !== null;
    if (ageEnabled.checked) maxPlanAgeDraft = settings.execution.max_plan_age_s;
    configureTimeInput(ageInput, { unit: 's' });
    setTimeInputValue(ageInput, maxPlanAgeDraft, { unit: 's', min: 0, minExclusive: true });
    listen(ageInput, 'input', change);
    listen(ageEnabled, 'change', change);
    resetIndicators.bind({ key: 'execution.max_plan_age_s', name: 'maximum plan age', input: ageInput,
      getValue: () => ageEnabled.checked ? readTimeInput(ageInput, { unit: 's', min: 0, minExclusive: true }) : null,
      getDefault: () => defaultSettings.execution?.max_plan_age_s ?? DEFAULT_EXECUTION.max_plan_age_s,
      reset: value => { ageEnabled.checked = value !== null; if (ageEnabled.checked) { maxPlanAgeDraft = value; setTimeInputValue(ageInput, value, { unit: 's', min: 0, minExclusive: true, force: true }); } change(); } });
    const compensationInput = $('live-latency-compensation');
    compensationInput.checked = settings.execution.latency_compensation;
    listen(compensationInput, 'change', change);
    resetIndicators.bind({ key: 'execution.latency_compensation', name: 'latency compensation', input: compensationInput,
      getValue: () => compensationInput.checked, getDefault: () => defaultSettings.execution?.latency_compensation ?? false,
      reset: value => { compensationInput.checked = value; change(); } });
    $('live-continue').checked = settings.execution.continue_at_end;
    listen($('live-continue'), 'change', () => {
      settings.execution.continue_at_end = $('live-continue').checked;
      // This changes playback intent only: keep the simulation and clock intact.
      if (serverSettingsVersion != null && !replayOnly) {
        ++settingsEpoch;
        send({ type: 'patch_settings', patch: { execution: { continue_at_end: settings.execution.continue_at_end } } });
      }
    });
    ensureModelCompilation();
    refreshFrictionAvailability();
    syncPlantFriction();
    controlsEnabled();
    resetIndicators.update();
    $('live-mode').disabled = false; message(replayOnly ? '' : profileNError ? unavailableFrictionMessage() : 'Choose Live MPC to compute a prediction.', !replayOnly && profileNError);
    if (focusPath) inputs.find(item => item.parameter.path === focusPath)?.input.focus?.();
    if (horizonSelection && horizonInput) {
      horizonInput.focus();
      horizonInput.setSelectionRange?.(...horizonSelection);
    }
    if (focusSource.sourcePath) [...document.querySelectorAll('[data-source-path]')].find(input =>
      input.dataset.sourceRole === focusSource.sourceRole && input.dataset.sourcePath === focusSource.sourcePath &&
      input.dataset.vectorIndex === focusSource.vectorIndex && ['INPUT', 'SELECT'].includes(input.tagName))?.focus?.();
    if (compilationEnabled() && mode === 'live' && !replayOnly && !profileSwitching && !profileUnavailable) modelCompilation.check();
  }

  function compileDraft() {
    if (!compilationEnabled() || profileSwitching || profileUnavailable || disposed) throw new Error('The solver profile is unavailable.');
    // change() retains the latest valid values. Partial runtime/task input must
    // not invalidate an otherwise known model or abort an in-flight lookup.
    const draft = settings;
    const selection = schema.compile_selection, params = cloneSettings(draft.config); delete params.plant;
    const request = { selection: { mpc_root: selection.mpc_root, python: selection.python, cache: selection.cache ?? null }, params,
      source_settings: cloneSettings(draft.source_settings?.predictor || {}),
      source_settings_module: schema.source_settings?.predictor?.module || null };
    return { scope: { epoch: schemaReload, profile: schema.compile_profile_id, selection,
      source: schema.source, module: schema.source_settings?.predictor?.module || null },
      request, modelInputs: modelCheckInputs(request, schema) };
  }
  const compileCurrentModel = () => readSettings(true) ? modelCompilation?.compile() : false;
  function ensureModelCompilation() {
    if (!compilationEnabled() || modelCompilation) return;
    modelCompilation = createModelCompilation({ getDraft: compileDraft,
      onState: next => { modelState = next; refreshFrictionAvailability(); controlsEnabled(); },
      onReady: () => mode === 'live' && !replayOnly && (dirty || initialResetPending) ? submitSettings() : false });
    modelPrompt = createModelCompilePrompt({ container: $('viewport'), onCompile: compileCurrentModel });
  }
  function useGeneration(next, force = false) {
    if (!force && generation != null && next < generation) return false;
    if (!force && next === generation) return true;
    historyEpoch++;
    generation = next; cursor = 0; historyComplete = false; history.clear(); historyRevision++; paintedRevision = -1;
    if (force) planCache.setGeneration(null);
    planCache.setGeneration(next);
    const following = clock.following, wasPlaying = clock.playing;
    state = undefined; clock.seek(null);
    if (wasPlaying) clock.play(performance.now(), { follow: following, growing: true });
    extensionPending = false; renderedPlan = undefined; renderDirty = true;
    syncSession();
    fetchHistory();
    return true;
  }
  function fetchHistory() { return historyPaging.refresh(); }
  function acceptHistoryBatch(batch) {
    let appliedRecords = 0;
    for (const record of batch.records || []) {
      if (record.generation !== generation || (expectedVersion != null && record.settings_version < expectedVersion)) continue;
      if (record.type === 'segment') acceptSegment(record);
      history.addRecord(record); appliedRecords++;
      if (record.type === 'state') state = record;
      if (record.type === 'plan') acceptPlan(record, false);
    }
    if (Number.isInteger(batch.next_cursor)) cursor = batch.next_cursor;
    historyComplete = Boolean(batch.complete);
    if (extensionPending && historyComplete && history.bounds[1] > extensionStartTime + 1e-8) extensionPending = false;
    if (appliedRecords) { historyRevision++; playingHold = null; } renderDirty = true;
    if (!clock.playing && clock.time == null && history.length) clock.seek(history.bounds[0]);
    syncSession();
  }
  function acceptPlan(item, presentation = true) {
    if (!item.summary && (!validPoints(item.ee_xyz) || !validPoints(item.reference_xyz))) return false;
    plan = item;
    if (presentation && inspectingPreview && item.origin === 'preview') inspectionPlan = item;
    if (Number.isInteger(item.settings_version)) settingsVersion = Math.max(settingsVersion ?? 0, item.settings_version);
    // Authoritative history can contain plans whose presentation SSE was
    // coalesced. Those plans settle settings just as an SSE prediction does.
    // A historical plan must not settle an explicit inspection still solving.
    if (pending && item.settings_version >= expectedVersion && (presentation || !inspectingPreview)) {
      pending = false;
      if (!dirty) frozenAnchor = undefined;
    }
    const context = segmentOf(item);
    if (!defaultTargetWorld && validPoints(item.reference_xyz) && (context?.task.kind || submittedSettings?.task.kind) === 'reach' && submittedSettings?.task.kind === 'reach') {
      defaultTargetWorld = item.reference_xyz[0].map((value, i) => value - submittedSettings.task.target_offset_m[i]);
    }
    if (!figure8BaseWorld && context?.task.kind === 'figure8' && submittedSettings?.task.kind === 'figure8' && validPoints(context.task_path_xyz)) {
      figure8BaseWorld = context.task_path_xyz[0].map((value, i) => value - submittedSettings.task.target_offset_m[i]);
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
    if (item.type === 'settings') { ++settingsEpoch; acceptSettings(item); return; }
    if (item.type === 'compiled_modules') { acceptCompiledModules(item); return; }
    if (!needsInitialPreview && generation != null && item.generation != null && item.generation < generation) return;
    if (!needsInitialPreview && item.type === 'status' && expectedVersion != null && item.settings_version < expectedVersion) return;
    if (item.type === 'segment') { acceptSegment(item); return; }
    if (item.type === 'status') {
      status = item.state; job = item;
      if (Number.isInteger(item.settings_version)) settingsVersion = Math.max(settingsVersion ?? 0, item.settings_version);
      $('live-status').textContent = status.replaceAll('_', ' ').toUpperCase();
      $('live-status').classList.toggle('is-playing', Boolean(item.job_active)); $('live-status').classList.toggle('error', status === 'error' || status === 'gpu_busy');
      if (item.generation != null && !needsInitialPreview && (expectedVersion == null || item.settings_version >= expectedVersion)) useGeneration(item.generation);
      if (item.message) message(item.message, status === 'error');
      if (status === 'error' || status === 'gpu_busy') { pending = false; extensionPending = false; pausePlayback(); }
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
      pending = false; extensionPending = false; job = { ...job, job_active: false }; pausePlayback();
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
    // Only the small timebar is rasterized to screen-width bands. All original
    // intervals remain in history for exact hover statistics, plots and export.
    const segments = timelineIntervals.update(history.intervals).bands([start, end], $('live-history').clientWidth || 1000);
    // Limit breaches where Live stopped: a tick in the limit colour.
    const breaches = history.breaches.filter(item => item.sim_time_s >= start - 1e-9 && item.sim_time_s <= end + 1e-9).map(item => {
      const el = document.createElement('span'); el.className = 'breach';
      el.style.left = `${100 * (item.sim_time_s - start) / (span || 1)}%`; return el;
    });
    $('live-history-intervals').replaceChildren(...segments.map(segment => {
      const el = document.createElement('span'); el.className = segment.severity;
      el.style.left = `${100 * Math.max(0, segment.start - start) / (span || 1)}%`; el.style.width = `${100 * (Math.min(end, segment.end) - Math.max(start, segment.start)) / (span || 1)}%`; return el;
    }), ...breaches);
  }
  function refreshHistoryControls() {
    const [start, end] = presentationBounds(), timeline = $('live-history'), time = clock.time ?? end;
    const mainStart = history.bounds[0];
    const recordedEnd = history.bounds[1];
    timeline.min = start; timeline.max = end; timeline.value = Math.max(start, Math.min(end, time)); timeline.disabled = end <= start;
    timeline.style.setProperty('--progress', `${end > start ? 100 * (time - start) / (end - start) : 0}%`);
    $('live-history-latest').disabled = !history.length || Math.abs(time - recordedEnd) < 1e-8;
    $('live-history-position').textContent = history.length || end > start ? clock.buffering ? `${number(time, 2)} s · Buffering` : clock.following ? `${number(time, 2)} s · Live` : `${number(time, 2)} / ${number(end, 2)} s` : 'No state history yet';
    const interval = replayOnly ? null : timelineIntervals.update(history.intervals).at(time) || history.intervals.at(-1);
    if (!timeline.matches?.(':hover')) timeline.title = interval ? intervalDescription(interval) : 'Recorded simulation time';
    timeline.setAttribute('aria-valuetext', `${number(time, 3)} seconds${interval ? ` · ${intervalDescription(interval)}` : ''}`);
    $('live-history-window').textContent = `Recorded ${number(mainStart, 2)}–${number(recordedEnd, 2)} s · ${history.length} states · display path ≤5000 points${historyPaging.fetching ? ' · downloading recording' : ''}${historyComplete ? ' · calculation complete' : job.job_active ? ` · calculating ${number((job.progress || 0) * 100)}%` : ''}`;
    $('live-history-note').textContent = clock.buffering ? `Buffering ${number(Math.max(0, recordedEnd - time) * 1000)} / ${number(presentation.buffer_ms)} ms of recorded simulation time. Pause or scrub to inspect history.` : clock.following ? `Following Live at ${clock.effectiveRate}× · recorded through ${number(recordedEnd, 2)} s. Calculation may limit progress. Pause or scrub to inspect the full recording.` : clock.playing ? `Session playback at ${clock.effectiveRate}×. At the Live tip, Continue may wait for calculation.` : 'Scrub or Play recorded history. Go latest only moves the view; Continue controls new motion at the end.';
    const speed = $('live-speed');
    if (speed) { speed.value = String(clock.effectiveRate); speed.disabled = clock.rateForced; speed.title = clock.rateForced ? 'Following a growing Live tip at 1×' : 'Session playback speed'; }
    paintIntervals();
    // Paint only on recorded changes, then rescale its full-history coordinates
    // to the presented end without rebuilding interval DOM on animation frames.
    const span = recordedEnd - mainStart, visibleSpan = end - start;
    const intervals = $('live-history-intervals');
    intervals.hidden = replayOnly;
    intervals.style.left = `${visibleSpan > 0 ? 100 * (mainStart - start) / visibleSpan : 0}%`;
    intervals.style.width = `${visibleSpan > 0 ? 100 * span / visibleSpan : 100}%`;
    intervals.style.clipPath = `inset(0 ${span > 0 ? Math.max(0, 100 * (recordedEnd - end) / span) : 0}% 0 0)`;
  }
  function renderView() {
    const selected = presentation.interpolate ? history.interpolateAt(clock.time, { trace: false }) : history.at(clock.time, { trace: false });
    if (traceRevision !== historyRevision) { displayPath = history.displayPath(); traceRevision = historyRevision; }
    let shownState = selected?.state || state || playingHold;
    let shownPlan = inspectingPreview ? inspectionPlan || plan : selected?.plan || (plan && !('available_time_s' in plan) ? plan : null);
    if (shownPlan?.summary) {
      const window = livePredictionWindow(shownPlan, history, clock);
      shownPlan = window.plan;
      if (shownPlan?.summary) {
        planCache.setWindow([shownPlan], window.lookahead);
        shownPlan = planCache.get(shownPlan.seq) || shownPlan;
      } else planCache.setWindow([]);
    }
    const historical = clock.time != null && clock.time < history.bounds[1] - 1e-7;
    const editing = dirty || pending || Boolean(poseDraft);
    // At the run start the arm shows the start pose being dragged or not yet run.
    const startQ = poseDraft || readPath(settings?.config, START_POSE_PATH);
    if (mode === 'live' && Array.isArray(startQ) && (!shownState || atRunStart(shownState)) && !settingValuesEqual(shownState?.q, startQ)) {
      shownState = { type: 'state', sim_time_s: 0, q: [...startQ], qd: startQ.map(() => 0), torque_nm: null, generation, start_pose_draft: true };
    }
    // A growing recording can alternate between its tip and an interpolated
    // historical sample every time another batch arrives. Its task is fixed
    // for this settings generation; keep the independent reference geometry
    // stable throughout playback instead of rebuilding it at each transition.
    const draft = (!historical || editing || clock.playing) && settings?.task;
    const base = taskBaseWorld(draft?.kind);
    const nextReferenceKey = draft ? JSON.stringify([draft, base]) : shownPlan;
    if (referenceKey !== nextReferenceKey) {
      referenceKey = nextReferenceKey;
      const context = segmentOf(shownState) || segmentOf(shownPlan);
      desiredReference = draft ? taskReference(draft, base) : shownPlan?.summary && validPoints([shownState?.target_xyz]) ? {
        kind: context?.task.kind, points: context?.task_path_xyz || [shownState.target_xyz],
        target_xyz: shownState.target_xyz, orientation_rotvec: orientationGoal(context?.task), draft: false,
      } : shownPlan && !shownPlan.summary ? {
        kind: segmentOf(shownPlan)?.task.kind, points: segmentOf(shownPlan)?.task_path_xyz || shownPlan.reference_xyz,
        target_xyz: shownPlan.target_xyz || shownPlan.reference_xyz[0],
        orientation_rotvec: orientationGoal(segmentOf(shownPlan)?.task), draft: false,
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
    $('live-playback-rate').textContent = clock.buffering ? 'Buffering' : clock.playing ? (continueAtEnd() && clock.time >= history.bounds[1] - 1e-7 && (job.job_active || extensionPending) ? 'Waiting' : `${clock.effectiveRate}×`) : 'Paused';
    $('live-distance').textContent = Number.isFinite(shownState?.distance_m) ? `${number(shownState.distance_m * 1000, 1)} mm` : '—';
    // Shown with an orientation goal, in the settings or in the displayed run.
    const angle = shownState?.orientation_error_rad;
    $('live-orientation-stat').hidden = !Number.isFinite(angle) && !orientationGoal(settings?.task);
    $('live-orientation-error').textContent = Number.isFinite(angle) ? `${number(angle * 180 / Math.PI, 1)}°` : '—';
    $('live-arrival').textContent = shownState?.arrived ? 'Arrival flag reached · holding target' : 'Following task reference';
    const execution = settings?.execution || DEFAULT_EXECUTION;
    $('live-rates').textContent = `Nominal simulated Hz: TO ${number(execution.to_hz)} · control ${number(execution.control_hz)} · physics ${number(execution.simulation_hz)}. Achieved per calculation-wall second: TO ${number(job.mpc_hz, 1)} · control ${number(job.control_hz, 1)} · physics ${number(job.simulation_hz, 1)}.`;
    $('live-play').classList.toggle('compute-limited', clock.playing && continueAtEnd() && clock.time >= history.bounds[1] - .001 && Boolean(job.job_active) && job.calculation_rtf < .99);
    refreshPlanLabel(shownPlan); refreshHistoryControls();
    // Callbacks (including Joints) read the public displayed state and start
    // pose eligibility, so publish this frame before notifying any observer.
    if (mode === 'live' && shownState) presentedState = shownState;
    syncSession(shownState, editing ? null : shownPlan || null);
    if (mode === 'live' && !replayOnly) {
      // An old optimizer output must not look like a prediction of the edited
      // task. Desired geometry still redraws while its replacement is pending.
      const currentPlan = editing ? null : shownPlan || null;
      if (renderedPlan !== currentPlan) { onPlan(currentPlan); renderedPlan = currentPlan; }
      if (renderedReference !== desiredReference) { onReference(desiredReference); renderedReference = desiredReference; }
      if (shownState) {
        const tracePoints = selected ? displayPath.points : [shownState.ee_xyz];
        const traceCount = selected ? Math.min(tracePoints.length, Math.floor(selected.index / displayPath.stride) + 1 + (selected.index === history.length - 1 && selected.index % displayPath.stride ? 1 : 0)) : 1;
        onState(shownState, { tracePoints, traceCount, segment: segmentOf(shownState) || segments.get(generation)?.context,
          referenceTarget: desiredReference?.draft ? taskReferencePoint(draft, base, shownState.sim_time_s) : shownState.target_xyz,
          historical: clock.time != null && clock.time < history.bounds[1] - 1e-7, interpolated: Boolean(shownState.render_interpolated) });
      }
    }
    renderDirty = false;
  }
  async function extendHistory(intent = playbackIntent) {
    if (extensionPending || job.job_active) return true;
    if (!connected()) return false;
    const previousJob = job, previousComplete = historyComplete;
    extensionPending = true; extensionStartTime = history.bounds[1];
    job = { ...job, job_active: true }; historyComplete = false;
    const result = await send({ type: 'play' });
    if (intent !== playbackIntent) return false;
    if (!result) {
      extensionPending = false; job = previousJob; historyComplete = previousComplete;
      pausePlayback(); controlsEnabled();
    }
    else {
      if (result.generation != null) useGeneration(result.generation);
    }
    return Boolean(result);
  }
  function frame(timestamp) {
    if (mode !== 'live') return;
    if (clock.playing) {
      const before = clock.time;
      const tick = clock.tick(timestamp, sessionBounds(), { followBounds: history.bounds, followAtEnd: continueAtEnd(), growing: growingHistory() });
      // Playback stops at a recorded limit breach; Play continues from it.
      const breach = !replayOnly && before != null && history.breachCrossed(before, tick.time);
      if (breach) { clock.seek(breach.sim_time_s); pausePlayback(); message(breach.message, true); controlsEnabled(); }
      else if (tick.atEnd && ((!job.job_active && !historyPaging.fetching) || !connected())) {
        // A calculation stopped by a breach never extends past it: playback stops at
        // its tip once that is downloaded (also for a breach at the time it resumed from).
        if (job.breach && continueAtEnd()) { if (history.bounds[1] >= job.breach.sim_time_s - 1e-9) { pausePlayback(); message(job.message, true); controlsEnabled(); } }
        else if (continueAtEnd()) extendHistory();
        else if (!extensionPending || !connected()) { pausePlayback(); controlsEnabled(); }
      }
      renderDirty = true;
    }
    if (renderDirty) renderView();
  }
  function seek(time) {
    const [start, end] = sessionBounds();
    inspectingPreview = false; pausePlayback(); clock.seek(Math.max(start, Math.min(end, time)));
    controlsEnabled(); renderView();
  }
  function showLatest() { inspectingPreview = false; clock.seek(history.bounds[1]); if (clock.playing && continueAtEnd()) clock.follow(); renderView(); }
  function connectLive() {
    if (replayOnly || !liveReady || source) return;
    needsInitialPreview = !suppressInitialPreview && !profileSwitching && !profileUnavailable && (serverSettingsVersion == null || serverSettingsVersion === 0 || dirty); suppressInitialPreview = false;
    const connection = new EventSource(compactPlayback() ? '/api/live/events?compact=1' : '/api/live/events'); source = connection;
    connection.onmessage = event => { if (source === connection && mode === 'live' && !replayOnly) receive(event); };
    connection.onopen = () => {
      latestServerEvents.clear(); controlsEnabled(); message('Connected · waiting for solver status…');
      if (!needsInitialPreview && generation != null) fetchHistory();
      if (compilationEnabled()) modelCompilation.check();
    };
    connection.onerror = () => { controlsEnabled(); message('Live stream disconnected · reconnecting. Playback remains local.', true); };
  }
  let replayTransition = Promise.resolve();
  async function setReplayOnly(value) {
    value = Boolean(value);
    if (value === replayOnly) return replayTransition;
    clearTimeout(settingsTimer); ++submission; pausePlayback();
    replayOnly = value;
    // Disconnect before rendering: no initial preview or stale event may enqueue
    // numerical work while the session is showing recordings only.
    if (value) {
      const connection = source; source = null; connection?.close();
      needsInitialPreview = false; pending = false;
      job = { ...job, job_active: false };
      // Pause deliberately leaves Manual/Automatic jobs running; cancel stops
      // every calculation kind without resetting Live's retained history.
      if (connection) replayTransition = send({ type: 'cancel' });
    } else if (submittedSettings) {
      // The retained run is already configured. Reconnecting must not repeat a
      // cancelled preview (or restart Automatic calculation); Play applies any draft.
      suppressInitialPreview = true;
      await refreshSettings();
    }
    session?.setReplayOnly(value);
    document.body.classList.toggle('session-replay-mode', value);
    if ($('replay-mode-exit')) $('replay-mode-exit').hidden = !value;
    $('live-message').textContent = '';
    onReplayMode(value);
    const [start, end] = sessionBounds();
    clock.seek(Math.max(start, Math.min(end, clock.time ?? start)));
    controlsEnabled(); renderView();
    await replayTransition;
    if (!replayOnly && mode === 'live') { connectLive(); controlsEnabled(); }
  }
  async function switchMode(next) {
    if (next === mode) return;
    clearTimeout(settingsTimer); submission++; mode = next; pausePlayback();
    document.body.classList.toggle('live-mode', mode === 'live');
    for (const id of ['live-panel', 'live-controls']) $(id).hidden = mode !== 'live';
    for (const id of ['replay-section', 'replay-controls']) $(id).hidden = mode === 'live';
    for (const name of ['replay', 'live']) { $(`${name}-mode`).classList.toggle('active', name === mode); $(`${name}-mode`).setAttribute('aria-pressed', name === mode); }
    $('mode-label').textContent = mode === 'live' ? 'LIVE MPC · SIMULATION' : 'TRAJECTORY REPLAY'; onMode(mode);
    if (mode === 'live') {
      if (!liveReady) { needsInitialPreview = false; controlsEnabled(); refreshPlanLabel(); renderView(); return; }
      connectLive(); controlsEnabled(); refreshPlanLabel();
      renderView();
    } else if (source) {
      const shouldPause = transportConnected() && (connected() || job.job_active || pending);
      const connection = source; source = null; connection.close(); pending = false; needsInitialPreview = false;
      if (shouldPause) await send({ type: 'pause' });
    }
  }
  $('replay-mode').addEventListener('click', () => switchMode('replay'));
  $('live-mode').addEventListener('click', () => switchMode('live'));
  $('session-replay-mode')?.addEventListener('click', () => setReplayOnly(!replayOnly));
  $('replay-mode-exit')?.addEventListener('click', () => setReplayOnly(false));
  $('live-preview').addEventListener('click', async () => {
    if (replayOnly) return;
    pausePlayback();
    const anchor = displayedAnchor();
    if (dirty && !await submitSettings()) return;
    inspectingPreview = true; inspectionPlan = null; pending = true; refreshPlanLabel();
    const result = await send({ type: 'preview', ...(anchor ? { anchor } : {}) });
    if (!result) pending = false;
    controlsEnabled(); renderView();
  });
  $('live-precalculate').addEventListener('click', async () => {
    if (replayOnly) return;
    pausePlayback(); if (dirty && !await submitSettings()) return;
    const anchor = frozenAnchor || displayedAnchor();
    const result = await send({ type: 'precalculate', ...(anchor ? { anchor } : {}) });
    if (result?.generation != null) useGeneration(result.generation);
  });
  $('live-freeze')?.addEventListener('click', async () => {
    if ($('live-freeze').disabled) return;
    const frozenGeneration = generation, start = history.bounds[0];
    freezing = true; controlsEnabled();
    try {
      const response = await fetch('/api/live/freeze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation: frozenGeneration }) });
      const result = await response.json();
      if (!response.ok || !result.accepted || !result.item) throw new Error(result.error || `HTTP ${response.status}`);
      await onFreeze(result.item);
      // A new user edit can replace the generation while the export downloads.
      // Keep that edit's captured anchor instead of seeking its replacement.
      if (generation === frozenGeneration && !dirty && !pending) { frozenAnchor = undefined; seek(start); }
    } catch (error) { message(`Freeze failed: ${error.message}`, true); }
    finally { freezing = false; controlsEnabled(); }
  });
  $('live-speed')?.addEventListener('change', event => {
    if (clock.rateForced) { refreshHistoryControls(); return; }
    const rate = Number(event.target.value);
    if (!Number.isFinite(rate) || rate < .25 || rate > 4) return;
    clock.setRate(rate); session?.setRate(rate); renderDirty = true; renderView();
  });
  $('live-cancel').addEventListener('click', async () => {
    if (await send({ type: 'cancel' })) {
      pending = false; extensionPending = false; job = { ...job, job_active: false }; pausePlayback();
      message('Cancellation requested · stopping after the current numerical operation.');
      controlsEnabled(); renderView();
    }
  });
  $('live-play').addEventListener('click', async () => {
    if (playbackDisabled()) return;
    inspectingPreview = false;
    clearTimeout(settingsTimer);
    if (clock.playing) {
      pausePlayback(); extensionPending = false;
      const intent = playbackIntent;
      controlsEnabled(); renderView();
      if (transportConnected() && (connected() || job.job_active || pending)) await send({ type: 'pause' });
      if (intent !== playbackIntent) return;
      if (settings?.execution.calculation === 'on_play') { pending = false; job = { ...job, job_active: false }; }
      controlsEnabled(); renderView(); return;
    }
    // Settings submission pauses synchronously; capture this Play intent after
    // that pause, but before its HTTP acknowledgement can interleave user input.
    const settingsRequest = dirty && connected() ? submitSettings() : null;
    const intent = ++playbackIntent;
    if (settingsRequest && !await settingsRequest) return;
    if (intent !== playbackIntent) return;
    const noMotion = history.length < 2;
    if (clock.time == null) clock.seek(sessionBounds()[0]);
    // A calculation stopped by a limit breach continues from its tip on Play, in every mode.
    const atTip = Math.abs(clock.time - history.bounds[1]) < 1e-7;
    const breachResume = !replayOnly && !noMotion && atTip && history.breaches.at(-1)?.sim_time_s >= history.bounds[1] - 1e-7;
    // Starting a new On Play run follows its calculation. Replaying an idle
    // recording respects Stop, even when that recording was made On Play.
    // Capture the intent before incoming states can make an empty run nonempty.
    calculateWhilePlaying = settings?.execution.calculation === 'on_play'
      && (noMotion || (job.job_active && atTip) || breachResume);
    const resume = continueAtEnd() || breachResume;
    // An idle finite session replays from its start when Stop is selected.
    if (anyPlayableSessionSpan() && (!job.job_active || !connected()) && (!extensionPending || !connected()) && !resume && clock.time >= sessionBounds()[1] - 1e-7) clock.seek(sessionBounds()[0]);
    const shouldExtend = connected() && ((noMotion && (resume || sessionBounds()[1] <= sessionBounds()[0])) || (clock.time >= history.bounds[1] - 1e-7 && resume));
    const follow = resume && (noMotion || clock.time >= history.bounds[1] - 1e-7);
    // Publish local intent immediately. Arriving history may grow the recorded
    // end while Play is acknowledged; it must not change the chosen follow mode.
    clock.play(performance.now(), { follow, growing: shouldExtend || growingHistory() }); controlsEnabled(); renderView();
    if (shouldExtend && !await extendHistory(intent) && intent === playbackIntent) { pausePlayback(); controlsEnabled(); renderView(); }
  });
  $('live-reset').addEventListener('click', async () => {
    if (replayOnly) { seek(sessionBounds()[0]); return; }
    clearTimeout(settingsTimer); pausePlayback(); frozenAnchor = undefined;
    if (dirty && !await submitSettings()) return;
    history.clear(); historyRevision++; plan = null; state = undefined; presentedState = undefined; playingHold = null; clock.seek(null); onReset();
    const result = await send({ type: 'reset' }); if (result?.generation != null) useGeneration(result.generation); renderView();
  });
  $('live-history').addEventListener('input', event => { if (!event.target.disabled) seek(Number(event.target.value)); });
  $('live-history').addEventListener('pointermove', event => {
    const bounds = event.target.getBoundingClientRect(), [start, end] = presentationBounds();
    const time = start + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * (end - start);
    const interval = !replayOnly && timelineIntervals.update(history.intervals).at(time);
    const breach = !replayOnly && history.breaches.find(item => Math.abs(item.sim_time_s - time) <= .01 * (end - start));
    event.target.title = `${number(time, 3)} s · ${breach ? `${breach.message} · ` : ''}${interval ? intervalDescription(interval) : replayOnly ? 'Recorded session time' : 'Recorded simulation time'}`;
  });
  $('live-history-latest').addEventListener('click', showLatest);
  function beginSolverProfileSwitch() {
    const anchor = displayedAnchor();
    clearTimeout(settingsTimer); ++submission; ++schemaReload;
    pausePlayback(); profileSwitching = true; pending = false; extensionPending = false; needsInitialPreview = false;
    modelCompilation?.invalidate();
    expectedVersion = settingsVersion;
    job = { ...job, job_active: false };
    $('live-status').textContent = 'SWITCHING SOLVER';
    message('Switching solver · calculation paused.'); controlsEnabled(); renderDirty = true;
    return anchor;
  }
  async function finishSolverProfileSwitch(item) {
    const reload = ++schemaReload;
    clearTimeout(settingsTimer); pausePlayback();
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
      schema = nextSchema; taskCatalog = null; effectiveSettings = schema.effective_settings || null;
      settingsHistories.clear();  // documents of the previous profile need not fit this one
      modelCompilation?.invalidate();
      acceptTaskAnchors(schema); defaultSettings = initialLiveSettings(schema); settings = nextSettings; updateTaskBaseline(settings.task.kind);
      profileNError = !availableKnotCounts(schema, settings.config).includes(settings.config.N);
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
      $('live-availability').textContent = ''; $('live-availability').title = '';
      message(profileNError ? `N=${settings.config.N} is unavailable in this solver profile. Choose an available knot count before calculating.` : 'Solver ready · simulation paused.', profileNError);
    } catch (error) {
      if (reload !== schemaReload) return;
      profileUnavailable = true;
      message(`Solver setup: ${error.message}`, true);
      throw error;
    } finally {
      if (reload === schemaReload) {
        profileSwitching = false; controlsEnabled(); renderDirty = true;
        if (compilationEnabled() && !profileUnavailable && mode === 'live' && !replayOnly) modelCompilation.check();
      }
    }
  }
  // The notice stays short: the reason is its tooltip and the fix is one click away.
  function showSetupNotice(reason) {
    const notice = $('live-availability'), link = document.createElement('button');
    link.type = 'button'; link.className = 'availability-link'; link.textContent = 'Settings › Backend';
    link.addEventListener('click', () => document.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'backend' } })));
    notice.replaceChildren('Live MPC needs setup · ', link); notice.title = reason;
  }
  const initialSchemaRequest = schemaReload;
  const ready = fetch('/api/live/schema').then(async response => { const result = await response.json(); if (initialSchemaRequest !== schemaReload) return; if (!response.ok) throw new Error(result.error || 'Live settings unavailable.'); schema = result; if (!schema.task_defaults || typeof schema.task_defaults !== 'object') throw new Error('Live task settings defaults are unavailable; restart the backend.'); acceptTaskAnchors(schema); defaultSettings = initialLiveSettings(schema); updateTaskBaseline(defaultSettings.task.kind); settings = cloneSettings(defaultSettings);
    acceptedStartPose = startPoseValue(defaultSettings.config);
    try {
      const retained = sessionStorage.getItem('source-restart-live-settings');
      sessionStorage.removeItem('source-restart-live-settings');
      if (retained) { settings = restoreCompatibleSettings(schema, JSON.parse(retained)); dirty = !settingValuesEqual(settings, defaultSettings); }
    } catch (error) { if (error.message?.startsWith('Saved predictor friction')) throw error; }
    liveReady = true; populate(); await refreshSettings({ initial: true }); scheduleSettingsRefresh(); }).catch(error => { if (initialSchemaRequest !== schemaReload) return; liveReady = false; controlsEnabled(); $('live-mode').disabled = false; $('live-mode').title = error.message; showSetupNotice(error.message); });
  return {
    ready,
    refreshSettings,
    refreshView: () => renderView(),
    dispose() { disposed = true; clearTimeout(settingsPoll); clearTimeout(settingsTimer); planCache.dispose(); copyDialog?.destroy(); modelCompilation?.dispose(); modelPrompt?.dispose(); source?.close(); unsubscribeSession?.(); },
    async enterLive() { await ready; await switchMode('live'); },
    setReplayOnly,
    get replayOnly() { return replayOnly; },
    setSession(value) {
      unsubscribeSession?.(); session = value; session.setReplayOnly(replayOnly); clock.setRate(session.rate);
      document.body.classList.toggle('session-replay-mode', replayOnly);
      if ($('replay-mode-exit')) $('replay-mode-exit').hidden = !replayOnly;
      unsubscribeSession = session.subscribe(() => {
        clock.setRate(session.rate); renderDirty = true;
        const disabled = playbackDisabled();
        const [start, end] = sessionBounds(), emptied = disabled && clock.playing && end <= start;
        if (emptied) pausePlayback();
        if (emptied || $('live-play').disabled !== disabled) controlsEnabled();
      });
      syncSession(); renderDirty = true;
    },
    seek,
    get sessionTime() { return clock.time ?? session?.cursor ?? history.bounds[0]; },
    get playbackRate() { return clock.effectiveRate; },
    get segment() { return segments.get(generation); },
    get currentSegment() { return segments.get(generation); },
    get endEffector() { return schema?.end_effector || null; },
    get targetInteraction() {
      const offset = [0, 1, 2].map(i => Number($(`target-offset-${i}`).value));
      const kind = $('live-task').value, base = taskBaseWorld(kind);
      const available = mode === 'live' && !replayOnly && !clock.playing && (clock.time == null || clock.time >= history.bounds[1] - 1e-7) && liveReady && !profileSwitching && !profileUnavailable && source?.readyState === EventSource.OPEN && Boolean(base) && settings.task.kind === kind && Boolean(readSettings()) && status !== 'gpu_busy' && status !== 'error';
      const goal = kind === 'reach' ? orientationGoal(settings?.task) : null;
      return { available, kind, position_world: base ? targetWorldPosition(base, offset) : null,
        quaternion_xyzw: goal ? rotvecToQuaternion(goal) : settings?.task.orientation_xyzw || [0, 0, 0, 1],
        tools: kind === 'figure8' ? ['translate', 'rotate', 'scale'] : goal ? ['translate', 'rotate'] : ['translate'],
        rotation_space: kind === 'figure8' ? 'world' : 'local',
        size_m: kind === 'figure8' ? [settings?.task.width_m, settings?.task.height_m] : null,
        pending: dirty || pending, offset_m: offset };
    },
    setTargetWorld(position) {
      if (!this.targetInteraction.available) return null;
      const base = taskBaseWorld(settings.task.kind);
      const offset = targetWorldOffset(base, position); if (!offset) return null;
      offset.forEach((value, i) => { $(`target-offset-${i}`).value = String(Number(value.toFixed(6))); });
      change(); return this.targetInteraction.position_world;
    },
    setTaskTransform(pose) {
      if (!this.targetInteraction.available) return null;
      if (settings.task.kind === 'reach') {
        // A reach rotates only its orientation goal, when it has one.
        const goal = orientationGoal(settings.task) && quaternionToRotvec(pose.quaternion_xyzw);
        if (!goal) return null;
        settings.task.orientation_rad = goal;
        change(); return this.targetInteraction;
      }
      if (settings.task.kind !== 'figure8') return null;
      const quaternion = normalizeQuaternion(pose.quaternion_xyzw || settings.task.orientation_xyzw || [0, 0, 0, 1]);
      if (!quaternion || (pose.size_m && (!Array.isArray(pose.size_m) || pose.size_m.length !== 2 || !pose.size_m.every(Number.isFinite)))) return null;
      settings.task.orientation_xyzw = quaternion;
      if (pose.size_m) ['width_m', 'height_m'].forEach((path, i) => {
        document.querySelector(`[data-task-path="${path}"]`).value = String(Number(Math.max(.01, Math.min(.6, pose.size_m[i])).toFixed(6)));
      });
      change(); return this.targetInteraction;
    },
    // The draft obstacles (an adapter's sphere list in the rows' root frame) and the rows'
    // spheres of the current segment, for the viewport. Editable whenever Live settings
    // are, also while playing: such an edit keeps On Play running.
    get obstacleInteraction() {
      const parameters = shapeSettings();
      if (!parameters.length || mode !== 'live' || replayOnly || !settings) return null;
      const context = latestContext(), transform = context?.world_from_root;
      // As the settings fields: an edit made while the GPU is busy waits like any other.
      const available = Boolean(transform) && liveReady && !profileSwitching && !profileUnavailable
        && source?.readyState === EventSource.OPEN;
      const lists = parameters.map(parameter => {
        const values = fieldValue(settings.source_settings?.predictor, parameter.path) || [];
        return { path: parameter.path, shape: parameter.shape, parameter, values,
          world: transform ? values.map(item => shapeToWorld(parameter.shape, item, transform)) : [] };
      });
      return { available, lists, world_from_root: transform || null, added: obstacleAdded,
        reference: transform ? [transform[0][3], transform[1][3], transform[2][3]] : [0, 0, 0],
        collision: context?.collision || null };
    },
    /** Replace one list's draft obstacles (root frame); commit submits at once instead of after the debounce. */
    setObstacles(path, values, { commit = false } = {}) {
      const parameter = shapeSettings().find(item => item.path === path);
      if (!parameter || !this.obstacleInteraction?.available || !sourceFields) return false;
      try { validateField(parameter, values); } catch { return false; }
      sourceFields.setValue('predictor', path, values);
      change({ keepPlaying: true });
      if (commit) this.commitSettings();
      return true;
    },
    commitSettings() { if (dirty && !replayOnly && !obstacleGesture) { clearTimeout(settingsTimer); submitSettings(); } },
    /** A drag or scale: its edits stay a draft, submitted once (commit) when it ends. */
    beginObstacleGesture() { obstacleGesture = true; },
    endObstacleGesture({ commit = true } = {}) { obstacleGesture = false; if (commit) this.commitSettings(); },
    // Each retained segment's collision rows (null without) and root placement, for exports.
    get collisionSegments() {
      return [...segments.values()].map(record => ({ generation: record.generation,
        world_from_root: record.context?.world_from_root || null, collision: record.context?.collision || null }));
    },
    highlightObstacle(selection) { obstacleHighlight = selection ?? null; outlineObstacle(); },
    /** Undo or redo one accepted settings version; false when there is none or an obstacle gesture runs. */
    undoSettings() { return historyEditable() && applySettingsDocument(taskSettingsHistory().undo()); },
    redoSettings() { return historyEditable() && applySettingsDocument(taskSettingsHistory().redo()); },
    get settingsHistory() { return taskSettingsHistory().snapshot; },
    // Editable in Live at the run start (t = 0), where the Joints tab shows the start
    // pose; the Joints lock decides whether it is edited. null outside Live.
    get startPose() {
      if (mode !== 'live' || replayOnly || !schema || !settings) return null;
      const pose = startPoseOf(schema, settings, defaultSettings);
      if (!pose) return null;
      if (poseDraft) pose.value = [...poseDraft];
      const shown = presentedState;
      pose.resettable = connected() && status !== 'gpu_busy';
      pose.editable = pose.resettable && !clock.playing && (!shown || atRunStart(shown));
      return pose;
    },
    // The Joints tab's Reset: the default start pose at any point of a run (running,
    // paused or after t = 0); like every start-pose change it starts a new run at t = 0.
    resetStartPose() {
      const pose = this.startPose;
      if (!pose?.resettable) return false;
      poseDraft = null;
      writePath(settings.config, START_POSE_PATH, [...pose.defaults]);
      change(); renderView(); return true;
    },
    previewStartPose(q) {
      if (q && !this.startPose?.editable) return;
      poseDraft = q ? [...q] : null; renderDirty = true; renderView();
    },
    setStartPose(q) {
      const pose = this.startPose;
      if (!pose?.editable || !Array.isArray(q) || q.length !== pose.value.length || !q.every(Number.isFinite)) return false;
      poseDraft = null;
      writePath(settings.config, START_POSE_PATH, q.map((v, i) => Math.max(pose.lower[i], Math.min(pose.upper[i], v))));
      change(); renderView(); return true;
    },
    setPresentationSettings(value) {
      presentation = validatePresentation(value); clock.setBuffer(presentation.buffer_ms);
      renderDirty = true;
    },
    get presentationSettings() { return { ...presentation }; },
    get reference() { return desiredReference; },
    // The run's setup: Live, not playing, the displayed state at the run start (t = 0),
    // as for start-pose editing (without its connection requirement).
    get setupPhase() { return mode === 'live' && !replayOnly && !clock.playing && (!presentedState || atRunStart(presentedState)); },
    get mode() { return mode; }, get plan() { return plan; }, get state() { return state; }, get displayedState() { return presentedState || history.at(clock.time, { trace: false })?.state || state; },
    // Onion skin reads recorded sample holds, never the interpolated display pose.
    historyStates(times) { return times.map(time => {
      const sample = history.at(time, { trace: false });
      return sample ? { time: sample.state.sim_time_s, q: sample.state.q.slice() } : null;
    }); },
    get historyRevision() { return historyRevision; },
    get generation() { return generation; },
    get metricHistory() { return history.metricSnapshot; },
    get animationHistory() { return history.animationSnapshot; },
    hydrateAnimationHistory(samples, schedule, options) {
      return hydrateLiveAnimationHistory(samples, schedule, planCache.ensure, options);
    },
    get history() { return historySnapshot(); },
    get fitAvailable() { return Boolean(history.length || plan?.ee_xyz?.length || segmentOf(plan)?.task_path_xyz?.length); },
    segmentOf,
    get precomputedPath() { return precomputedPath(); },
    get settings() { return settings ? cloneSettings(settings) : null; }, get status() { return status; },
    buildSettingsFor(root) {
      const normalized = value => String(value || '').replace(/\/+$/, '');
      if (!schema || normalized(root) !== normalized(schema.source?.mpc_root)) return null;
      const draft = readSettings(true, { allowUncompiled: true });
      if (!draft) throw new Error('Complete the predictor settings before building.');
      const params = cloneSettings(draft.config); delete params.plant;
      return { params, source_settings: cloneSettings(draft.source_settings?.predictor || {}),
        source_settings_module: schema.source_settings?.predictor?.module || null };
    },
    async retryBuiltSettings(build) {
      if (compilationEnabled()) return modelCompilation.builtExternally(build);
      if (!build?.result || !build.live_refreshed || !build.params || !dirty || replayOnly) return false;
      const current = this.buildSettingsFor(build.selection?.mpc_root);
      if (!current || !settingValuesEqual(current.params, build.params) ||
          !settingValuesEqual(current.source_settings, build.source_settings || {}) ||
          !settingValuesEqual(current.source_settings_module, build.source_settings_module ?? null)) return false;
      acceptCompiledModules(build.result);
      if (profileNError) { message(unavailableFrictionMessage(), true); return false; }
      return submitSettings();
    },
    get compilation() { return modelCompilation?.snapshot ?? null; },
    // Numerical work/preview intent, independent of retained-history playback.
    get computing() { return mode === 'live' && !replayOnly && !profileUnavailable
      && Boolean(profileSwitching || job.job_active || extensionPending || (pending && source?.readyState === EventSource.OPEN)); },
    compileModel: compileCurrentModel,
    get pending() { return profileSwitching || pending || (mode === 'live' && !connected()); }, get playing() { return clock.playing; },
    holdForInspection() {
      // The inspection endpoint owns cooperative numerical pausing. This only
      // holds the browser's clock and queued edits, preserving its displayed
      // native pose/cursor and the private Live controller state.
      clearTimeout(settingsTimer); ++submission; pausePlayback(); extensionPending = false;
      controlsEnabled(); renderDirty = true;
    },
    beginSolverProfileSwitch, finishSolverProfileSwitch,
    frame, togglePlay: () => { if (mode === 'live' && !$('live-play').disabled) $('live-play').click(); },
  };
}
