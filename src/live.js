import { targetWorldPosition, targetWorldOffset } from './target-gizmo.js';

// The API uses native joint values and full robot-root coordinates. No sign or
// frame conversions belong in the browser.
import { createLiveHistory } from './live-history.js';
import { createLivePlayout } from './live-playout.js';
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
  const $ = (id) => document.getElementById(id);
  let schema;
  let settings;
  let submittedSettings;
  let liveReady = false;
  let mode = 'replay';
  let source;
  let status = 'idle';
  let state;
  let plan;
  let dirty = false;
  let pending = false;
  let settingsTimer;
  let settingsVersion;
  let expectedVersion;
  let needsInitialPreview = false;
  let queuedPreview = false;
  let commandPending = false;
  let submission = 0;
  const history = createLiveHistory();
  let historyTime = null;
  let renderedPlan;
  let presentedState;
  let renderDirty = true;
  const playout = createLivePlayout();
  let defaultTargetWorld;
  const inputs = [];

  const message = (text, error = false) => {
    $('live-message').textContent = text;
    $('live-message').classList.toggle('error', error);
  };
  const controlsEnabled = () => {
    const unavailable = !liveReady || !source || source.readyState !== EventSource.OPEN || needsInitialPreview;
    $('live-play').disabled = unavailable || commandPending || (pending && status !== 'playing');
    $('live-preview').disabled = unavailable || commandPending || pending;
    $('live-reset').disabled = unavailable || commandPending || pending;
    refreshHistoryControls();
  };
  const send = async (command) => {
    try {
      const response = await fetch('/api/live/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      });
      const result = await response.json();
      if (!response.ok || !result.accepted) throw new Error(result.error || `HTTP ${response.status}`);
      return result;
    } catch (error) {
      message(`Command failed: ${error.message}`, true);
      return false;
    }
  };
  const refreshPlanLabel = (shownPlan = plan) => {
    const selected = historyTime == null ? null : history.at(historyTime);
    if (selected) {
      $('live-plan-label').textContent = selected.plan
        ? `History · plan ${selected.plan.seq} · settings v${selected.plan.settings_version}`
        : 'History · prediction not recorded';
      $('live-plan-label').classList.remove('stale');
      return;
    }
    const stale = needsInitialPreview || dirty || pending || (plan && expectedVersion != null && plan.settings_version < expectedVersion);
    $('live-plan-label').textContent = stale
      ? 'Previous prediction · settings pending'
      : shownPlan ? `${shownPlan.origin === 'play' ? 'Closed-loop' : 'Reset preview'} · plan ${shownPlan.seq} · settings v${shownPlan.settings_version}` : 'Waiting for a prediction';
    $('live-plan-label').classList.toggle('stale', Boolean(stale));
  };
  // The browser owns its Live draft. Replay data and stream snapshots never
  // replace it; requests carry a copy so edits made during a solve stay local.
  const readSettings = (reportErrors = false) => {
    const next = cloneSettings(settings);
    try {
      for (const { parameter, input } of inputs) {
        input.setCustomValidity('');
        let value;
        try { value = parseParameter(parameter, input); }
        catch (error) { input.setCustomValidity(error.message); if (reportErrors) input.reportValidity(); throw error; }
        writePath(next.config, parameter.path, value);
      }
      if (!schema.available_N.includes(next.config.N)) throw new Error('Choose an available knot count before running Live MPC.');
      const kind = $('live-task').value;
      const descriptor = schema.tasks?.find((task) => task.kind === kind);
      next.task = { ...(descriptor?.defaults || {kind: 'reach'}), kind };
      for (const parameter of descriptor?.parameters || []) {
        next.task[parameter.path] = parseParameter(parameter, document.querySelector(`[data-task-path="${parameter.path}"]`));
      }
      next.task.target_offset_m = [0, 1, 2].map((i) => {
        const input = $(`target-offset-${i}`);
        const value = Number(input.value);
        if (input.value.trim() === '' || !Number.isFinite(value)) throw new Error('Target offsets need finite values in metres.');
        return value;
      });
    } catch (error) {
      if (reportErrors) message(error.message, true);
      return null;
    }
    return next;
  };
  const submitSettings = async () => {
    clearTimeout(settingsTimer);
    if (mode !== 'live' || !liveReady) return false;
    if (pending) { queuedPreview = true; return false; }
    const next = readSettings(true);
    if (!next) return false;
    settings = next;
    submittedSettings = cloneSettings(next);
    pending = true;
    dirty = false;
    expectedVersion = settingsVersion == null ? undefined : settingsVersion + 1;
    controlsEnabled();
    refreshPlanLabel();
    message(status === 'playing' ? 'Applying settings at the next interval; controller will restart at the current state.' : 'Computing a reset preview from the current state…');
    const request = ++submission;
    const accepted = await send({ type: 'set_settings', ...next });
    if (request === submission) {
      if (!accepted) { pending = false; dirty = true; }
      else if (Number.isInteger(accepted.settings_version)) {
        expectedVersion = accepted.settings_version;
        pending = !plan || plan.settings_version < expectedVersion;
      }
      refreshPlanLabel();
      controlsEnabled();
    }
    return Boolean(accepted);
  };
  const change = () => {
    // Capture valid edits before the debounce or a mode switch can interrupt it.
    // Invalid text remains in its input for correction, without a partial POST.
    settings = readSettings() || settings;
    showLatest();
    dirty = true;
    refreshPlanLabel();
    message('Settings changed · updating prediction…');
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(submitSettings, 350);
  };
  const populate = () => {
    const tasks = schema.tasks || [{kind: 'reach', label: 'Reaching', defaults: {kind: 'reach'}}];
    $('live-task').replaceChildren(...tasks.map((task) => {
      const option = document.createElement('option'); option.value = task.kind; option.textContent = task.label; return option;
    }));
    $('live-task').value = settings.task.kind;
    const taskFields = () => {
      const descriptor = tasks.find((task) => task.kind === $('live-task').value);
      $('live-task-parameters').replaceChildren();
      for (const parameter of descriptor?.parameters || []) {
        const label = document.createElement('label'); label.className = 'parameter-row';
        const caption = document.createElement('span'); caption.textContent = parameter.label;
        const input = document.createElement('input'); input.type = 'number'; input.step = 'any'; input.required = true;
        input.dataset.taskPath = parameter.path; input.min = parameter.min; input.max = parameter.max;
        input.value = settings.task.kind === descriptor.kind ? settings.task[parameter.path] : descriptor.defaults[parameter.path];
        input.addEventListener('input', change); label.append(caption, input); $('live-task-parameters').append(label);
      }
      $('live-task-note').textContent = descriptor?.kind === 'figure8'
        ? 'Horizontal figure eight in world XY. Offsets move the path; Reset restarts its phase. Width and height are full spans.'
        : 'Offset from the default reaching target. Click the target to move it along an axis.';
    };
    taskFields();
    $('live-task').addEventListener('change', () => { taskFields(); change(); });
    const groups = new Map();
    for (const supplied of schema.parameters) {
      const parameter = { ...supplied };
      parameter.path = parameter.path.replace(/^config\./, '');
      if (parameter.path === 'N') {
        parameter.kind = 'choice';
        parameter.choices = schema.available_N;
      }
      const name = parameter.group || 'Settings';
      if (!groups.has(name)) {
        const details = document.createElement('details');
        details.className = 'settings-group';
        details.open = groups.size === 0;
        const summary = document.createElement('summary');
        summary.textContent = name;
        const fields = document.createElement('div');
        fields.className = 'settings-fields';
        details.append(summary, fields);
        $('live-settings').append(details);
        groups.set(name, fields);
      }
      const label = document.createElement('label');
      label.className = 'parameter-row';
      const text = document.createElement('span');
      text.textContent = parameter.label || parameter.path;
      const input = document.createElement(parameter.kind === 'choice' ? 'select' : 'input');
      input.dataset.path = parameter.path;
      input.name = parameter.path;
      const value = readPath(settings.config, parameter.path);
      if (parameter.kind === 'choice') {
        for (const [i, choice] of parameter.choices.entries()) {
          const item = document.createElement('option');
          const object = choice && typeof choice === 'object';
          const typedValue = object && 'value' in choice ? choice.value : choice;
          item.value = String(i);
          item.textContent = object ? choice.label || String(typedValue ?? 'Default') : String(choice ?? 'Default');
          item.selected = Object.is(typedValue, value);
          input.append(item);
        }
      } else if (parameter.kind === 'bool') {
        input.type = 'checkbox';
        input.checked = Boolean(value);
      } else {
        input.type = 'number';
        input.step = parameter.kind === 'int' ? '1' : 'any';
        if (parameter.min != null) input.min = parameter.min;
        if (parameter.max != null) input.max = parameter.max;
        input.value = value;
        input.required = true;
      }
      input.disabled = Boolean(parameter.disabled);
      input.title = parameter.path + (parameter.scale === 'log' ? ' · logarithmic range' : '');
      input.addEventListener('input', change);
      label.append(text, input);
      groups.get(name).append(label);
      inputs.push({ parameter, input });
    }
    settings.task.target_offset_m.forEach((value, i) => {
      $(`target-offset-${i}`).value = value;
      $(`target-offset-${i}`).addEventListener('input', change);
    });
    const commit = schema.source?.mpc_commit;
    $('live-source').textContent = `tiago_mpc ${commit ? String(commit).slice(0, 8) : 'local'}${schema.source?.mpc_dirty ? ' · local changes' : ''} · prebuilt N: ${schema.available_N.join(', ') || 'none'}`;
    $('live-source').title = schema.source?.mpc_root || '';
    $('live-mode').disabled = false;
    message('Choose Live MPC to compute a prediction.');
  };
  const receive = (event) => {
    let item;
    try { item = JSON.parse(event.data); } catch { message('Invalid live event received.', true); return; }
    if (item.type === 'status') {
      status = item.state;
      if (Number.isInteger(item.settings_version)) settingsVersion = item.settings_version;
      $('live-status').textContent = String(status).replaceAll('_', ' ').toUpperCase();
      $('live-status').classList.toggle('is-playing', status === 'playing');
      $('live-status').classList.toggle('error', status === 'error' || status === 'gpu_busy');
      $('live-play').textContent = status === 'playing' ? 'Pause' : 'Play';
      $('live-play').setAttribute('aria-label', status === 'playing' ? 'Pause closed-loop MPC' : 'Play closed-loop MPC');
      message(item.message || `Live MPC ${status}.`, status === 'error');
      if (item.state === 'error' || item.state === 'gpu_busy') { pending = false; refreshPlanLabel(); }
      if (status === 'playing') { historyTime = null; renderDirty = true; }
      else {
        playout.clear();
        if (state) playout.add(state, performance.now(), state.settings_version ?? plan?.settings_version);
        renderView(); // Pause/scrub must show an exact saved state immediately.
      }
      controlsEnabled();
      if (needsInitialPreview) { needsInitialPreview = false; submitSettings(); }
    } else if (item.type === 'plan') {
      // An SSE subscription starts with the server's cached plan, which can
      // belong to a different Live configuration (or another browser). Keep
      // our retained prediction until this connection's draft has been applied.
      if (needsInitialPreview || (expectedVersion != null && item.settings_version < expectedVersion)) return;
      if (!validPoints(item.ee_xyz) || !validPoints(item.reference_xyz)) {
        message('Invalid prediction received; keeping the last valid plan.', true); return;
      }
      if (plan && item.settings_version !== plan.settings_version) playout.clear();
      plan = item;
      history.addPlan(item);
      if (Number.isInteger(item.settings_version)) settingsVersion = Math.max(settingsVersion ?? 0, item.settings_version);
      const applied = pending && expectedVersion != null && item.settings_version >= expectedVersion;
      if (applied) pending = false;
      if (!defaultTargetWorld && (item.task_kind || submittedSettings?.task.kind) === 'reach' && expectedVersion != null && item.settings_version >= expectedVersion) {
        defaultTargetWorld = item.reference_xyz[0].map((value, i) => value - submittedSettings.task.target_offset_m[i]);
      }
      controlsEnabled();
      refreshPlanLabel();
      if (status === 'playing') renderDirty = true;
      else renderView();
      if (applied && (dirty || queuedPreview)) { queuedPreview = false; submitSettings(); }
    } else if (item.type === 'state') {
      if (!Number.isFinite(item.sim_time_s) || !Array.isArray(item.q) || item.q.length !== 7 || !item.q.every(Number.isFinite) || !validPoints([item.ee_xyz])) return;
      state = item;
      history.addState(item);
      playout.add(item, performance.now(), item.settings_version ?? plan?.settings_version);
      if (status === 'playing') historyTime = null;
      if (status === 'playing') renderDirty = true;
      else renderView();
    } else if (item.type === 'error') {
      pending = false;
      refreshPlanLabel();
      message(item.message || item.detail || 'Live solver error.', true);
      controlsEnabled();
    }
  };
  const number = (value, precision = 0) => Number.isFinite(value) ? value.toFixed(precision) : '—';
  function refreshHistoryControls() {
    const [start, end] = history.bounds;
    const selected = history.at(historyTime);
    const timeline = $('live-history');
    timeline.min = start;
    timeline.max = end;
    timeline.value = selected?.state.sim_time_s ?? end;
    timeline.disabled = history.length < 2 || status === 'playing' || pending || commandPending || needsInitialPreview || !source || source.readyState !== EventSource.OPEN;
    const progress = end > start ? ((Number(timeline.value) - start) / (end - start)) * 100 : 0;
    timeline.style.setProperty('--progress', `${progress}%`);
    $('live-history-latest').disabled = historyTime == null;
    $('live-history-position').textContent = selected ? `${number(selected.state.sim_time_s, 2)} / ${number(end, 2)} s` : 'No state history yet';
    $('live-history-note').textContent = historyTime == null
      ? (status === 'playing' ? 'Following newest state. Pause to scrub.' : 'Showing newest state. Scrub while paused; Play continues from here.')
      : `Viewing saved history. Play resumes the newest backend state at ${number(end, 2)} s.`;
    const { maxSeconds, maxSamples, maxPlans } = history.limits;
    $('live-history-window').textContent = `Retained ${number(start, 2)}–${number(end, 2)} s · ${history.length} states · browser limits: ${maxSeconds} s / ${maxSamples} states / ${maxPlans} plans. Reset clears history.`;
  }
  function renderView(bufferedState = null) {
    const selected = history.at(historyTime ?? bufferedState?.sim_time_s ?? null);
    const shownPlan = historyTime == null && !bufferedState ? plan : selected?.plan;
    const shownState = bufferedState || selected?.state || state;
    const stats = shownPlan?.stats || {};
    $('live-sqp').textContent = number(stats.sqp_iters);
    $('live-pcg').textContent = number(stats.pcg_iters);
    $('live-admm').textContent = number(stats.admm_iters);
    $('live-linsys').textContent = number(stats.admm_linsys_iters);
    $('live-solve').textContent = number(stats.solve_time_ms, 2);
    const violation = maxViolation(stats.row_violation);
    $('live-violation').textContent = violation === null ? '—' : violation.toExponential(2);
    $('live-horizon').textContent = shownPlan ? `${shownPlan.N} knots · ${number(shownPlan.dt_s * 1000, 1)} ms · horizon ${number(shownPlan.dt_s * (shownPlan.N - 1), 2)} s` : 'No saved prediction';
    $('live-restarted').hidden = !stats.controller_restarted;
    if (shownState) {
      $('live-sim-time').textContent = number(shownState.sim_time_s, 2);
      $('live-rtf').textContent = Number.isFinite(shownState.rtf) ? `${shownState.rtf.toFixed(2)}×` : '—';
      $('live-distance').textContent = Number.isFinite(shownState.distance_m) ? `${(shownState.distance_m * 1000).toFixed(1)} mm` : '—';
      $('live-arrival').textContent = shownState.arrived ? 'Arrival flag reached · holding target' : 'Following target';
    }
    refreshPlanLabel(shownPlan);
    refreshHistoryControls();
    if (mode === 'live') {
      if (renderedPlan !== (shownPlan || null)) {
        onPlan(shownPlan || null);
        renderedPlan = shownPlan || null;
      }
      if (shownState) {
        const tracePoints = selected?.tracePoints || [shownState.ee_xyz];
        if (shownState.render_interpolated) tracePoints.push(shownState.ee_xyz);
        onState(shownState, { tracePoints, historical: historyTime != null, interpolated: Boolean(shownState.render_interpolated) });
        presentedState = shownState;
      }
    }
    renderDirty = false;
  }
  function showLatest() {
    historyTime = null;
    playout.clear();
    if (state) playout.add(state, performance.now(), state.settings_version ?? plan?.settings_version);
    renderView();
  }
  function frame(timestamp) {
    if (mode !== 'live') return;
    const buffered = status === 'playing' && historyTime == null ? playout.at(timestamp) : null;
    if (renderDirty || (buffered && buffered !== presentedState)) renderView(buffered);
  }
  const switchMode = async (next) => {
    if (next === mode || (next === 'live' && !liveReady)) return;
    clearTimeout(settingsTimer);
    // Detach callbacks for a request made by the previous Live subscription.
    // Its server-side work may finish, but cannot settle the next draft.
    submission++;
    mode = next;
    document.body.classList.toggle('live-mode', mode === 'live');
    $('live-panel').hidden = mode !== 'live';
    $('live-controls').hidden = mode !== 'live';
    $('replay-section').hidden = mode === 'live';
    $('replay-controls').hidden = mode === 'live';
    $('replay-mode').classList.toggle('active', mode === 'replay');
    $('live-mode').classList.toggle('active', mode === 'live');
    $('replay-mode').setAttribute('aria-pressed', mode === 'replay');
    $('live-mode').setAttribute('aria-pressed', mode === 'live');
    $('mode-label').textContent = mode === 'live' ? 'LIVE MPC · SIMULATION' : 'TRAJECTORY REPLAY';
    onMode(mode);
    if (mode === 'live') {
      needsInitialPreview = true;
      const connection = new EventSource('/api/live/events');
      source = connection;
      controlsEnabled();
      refreshPlanLabel();
      source.onmessage = (event) => { if (source === connection && mode === 'live') receive(event); };
      source.onopen = () => {
        historyTime = null;
        showLatest();
        controlsEnabled();
        message('Connected · waiting for current solver status…');
      };
      source.onerror = () => {
        playout.clear();
        controlsEnabled();
        message('Live stream disconnected · reconnecting. The displayed state is held.', true);
      };
      showLatest();
    } else {
      if (source) {
        const connection = source;
        source = null;
        connection.close();
        pending = false;
        queuedPreview = false;
        needsInitialPreview = false;
        await send({ type: 'pause' });
      }
    }
  };
  $('replay-mode').addEventListener('click', () => switchMode('replay'));
  $('live-mode').addEventListener('click', () => switchMode('live'));
  $('live-preview').addEventListener('click', async () => {
    showLatest();
    commandPending = true;
    controlsEnabled();
    if (status === 'playing' && !await send({type: 'pause'})) { commandPending = false; controlsEnabled(); return; }
    await submitSettings();
    commandPending = false;
    controlsEnabled();
  });
  $('live-play').addEventListener('click', async () => {
    showLatest();
    clearTimeout(settingsTimer);
    commandPending = true;
    controlsEnabled();
    if (status === 'playing') { message('Pause requested · waiting for the current solve to finish…'); await send({ type: 'pause' }); }
    else if ((!dirty && !pending) || await submitSettings()) { message('Play requested · waiting for the solver…'); await send({ type: 'play' }); }
    commandPending = false;
    controlsEnabled();
  });
  $('live-reset').addEventListener('click', async () => {
    clearTimeout(settingsTimer);
    if (dirty && !await submitSettings()) return;
    showLatest();
    history.clear();
    playout.clear();
    plan = null;
    state = undefined;
    historyTime = null;
    onReset();
    renderView();
    await send({ type: 'reset' });
  });
  $('live-history').addEventListener('input', (event) => {
    if (event.target.disabled) return;
    const time = Number(event.target.value);
    historyTime = time >= history.bounds[1] ? null : time;
    renderView();
  });
  $('live-history-latest').addEventListener('click', showLatest);
  fetch('/api/live/schema').then(async (response) => {
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Live settings unavailable.');
    schema = result;
    settings = initialLiveSettings(schema);
    liveReady = true;
    populate();
  }).catch((error) => {
    liveReady = false;
    controlsEnabled();
    $('live-mode').disabled = true;
    $('live-mode').title = error.message;
    $('live-availability').textContent = `Live MPC needs setup: ${error.message}`;
  });
  return {
    get targetInteraction() {
      const offset = [0, 1, 2].map(i => Number($(`target-offset-${i}`).value));
      const available = mode === 'live' && historyTime == null && $('live-task').value === 'reach' && liveReady && source?.readyState === EventSource.OPEN && !needsInitialPreview
        && Boolean(defaultTargetWorld) && settings.task.kind === 'reach' && offset.every(value => Number.isFinite(value) && Math.abs(value) <= 1)
        && [0, 1, 2].every(i => $(`target-offset-${i}`).value.trim() !== '')
        && status !== 'gpu_busy' && status !== 'error';
      return { available, position_world: defaultTargetWorld ? targetWorldPosition(defaultTargetWorld, offset) : null,
        pending: dirty || pending, offset_m: offset };
    },
    setTargetWorld(position) {
      if (!this.targetInteraction.available) return null;
      const offset = targetWorldOffset(defaultTargetWorld, position);
      if (!offset) return null;
      offset.forEach((value, i) => { $(`target-offset-${i}`).value = String(Number(value.toFixed(6))); });
      change();
      return this.targetInteraction.position_world;
    },
    get mode() { return mode; },
    get plan() { return plan; },
    get state() { return state; },
    get displayedState() { return presentedState || history.at(historyTime)?.state || state; },
    get history() { return { length: history.length, bounds: history.bounds, selectedTime: historyTime, limits: history.limits }; },
    get settings() { return settings ? cloneSettings(settings) : null; },
    get status() { return status; },
    get pending() { return pending || commandPending || (mode === 'live' && (needsInitialPreview || !source || source.readyState !== EventSource.OPEN)); },
    frame,
    togglePlay: () => { if (mode === 'live' && !$('live-play').disabled) $('live-play').click(); },
  };
}
