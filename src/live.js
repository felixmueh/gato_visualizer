// The API uses native joint values and full robot-root coordinates. No sign or
// frame conversions belong in the browser.
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
  const refreshPlanLabel = () => {
    const stale = needsInitialPreview || dirty || pending || (plan && expectedVersion != null && plan.settings_version < expectedVersion);
    $('live-plan-label').textContent = stale
      ? 'Previous prediction · settings pending'
      : plan ? `${plan.origin === 'play' ? 'Closed-loop' : 'Reset preview'} · plan ${plan.seq} · settings v${plan.settings_version}` : 'Waiting for a prediction';
    $('live-plan-label').classList.toggle('stale', Boolean(stale));
  };
  const submitSettings = async () => {
    clearTimeout(settingsTimer);
    if (mode !== 'live' || !liveReady) return false;
    if (pending) { queuedPreview = true; return false; }
    const next = cloneSettings(settings);
    try {
      for (const { parameter, input } of inputs) {
        input.setCustomValidity('');
        let value;
        try { value = parseParameter(parameter, input); }
        catch (error) { input.setCustomValidity(error.message); input.reportValidity(); throw error; }
        writePath(next.config, parameter.path, value);
      }
      if (!schema.available_N.includes(next.config.N)) throw new Error('Choose an available knot count before running Live MPC.');
      next.task.target_offset_m = [0, 1, 2].map((i) => {
        const input = $(`target-offset-${i}`);
        const value = Number(input.value);
        if (input.value.trim() === '' || !Number.isFinite(value)) throw new Error('Target offsets need finite values in metres.');
        return value;
      });
    } catch (error) {
      message(error.message, true);
      return false;
    }
    settings = next;
    pending = true;
    dirty = false;
    expectedVersion = settingsVersion == null ? undefined : settingsVersion + 1;
    controlsEnabled();
    refreshPlanLabel();
    message(status === 'playing' ? 'Applying settings at the next interval; controller will restart at the current state.' : 'Computing a reset preview from the current state…');
    const request = ++submission;
    const accepted = await send({ type: 'set_settings', ...settings });
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
    dirty = true;
    refreshPlanLabel();
    message('Settings changed · updating prediction…');
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(submitSettings, 350);
  };
  const populate = () => {
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
      controlsEnabled();
      if (needsInitialPreview) { needsInitialPreview = false; submitSettings(); }
    } else if (item.type === 'plan') {
      if (!validPoints(item.ee_xyz) || !validPoints(item.reference_xyz)) {
        message('Invalid prediction received; keeping the last valid plan.', true); return;
      }
      plan = item;
      if (Number.isInteger(item.settings_version)) settingsVersion = Math.max(settingsVersion ?? 0, item.settings_version);
      const applied = pending && expectedVersion != null && item.settings_version >= expectedVersion;
      if (applied) pending = false;
      controlsEnabled();
      refreshPlanLabel();
      const stats = item.stats || {};
      const number = (v, precision = 0) => Number.isFinite(v) ? v.toFixed(precision) : '—';
      $('live-sqp').textContent = number(stats.sqp_iters);
      $('live-pcg').textContent = number(stats.pcg_iters);
      $('live-admm').textContent = number(stats.admm_iters);
      $('live-linsys').textContent = number(stats.admm_linsys_iters);
      $('live-solve').textContent = number(stats.solve_time_ms, 2);
      const violation = maxViolation(stats.row_violation);
      $('live-violation').textContent = violation === null ? '—' : violation.toExponential(2);
      $('live-horizon').textContent = `${item.N} knots · ${number(item.dt_s * 1000, 1)} ms · horizon ${number(item.dt_s * (item.N - 1), 2)} s`;
      $('live-restarted').hidden = !stats.controller_restarted;
      if (mode === 'live') onPlan(item);
      if (applied && (dirty || queuedPreview)) { queuedPreview = false; submitSettings(); }
    } else if (item.type === 'state') {
      if (!Array.isArray(item.q) || item.q.length !== 7 || !item.q.every(Number.isFinite) || !validPoints([item.ee_xyz])) return;
      state = item;
      $('live-sim-time').textContent = Number(item.sim_time_s).toFixed(2);
      $('live-rtf').textContent = Number.isFinite(item.rtf) ? `${item.rtf.toFixed(2)}×` : '—';
      $('live-distance').textContent = Number.isFinite(item.distance_m) ? `${(item.distance_m * 1000).toFixed(1)} mm` : '—';
      $('live-arrival').textContent = item.arrived ? 'Arrival flag reached · holding target' : 'Following target';
      if (mode === 'live') onState(item);
    } else if (item.type === 'error') {
      pending = false;
      refreshPlanLabel();
      message(item.message || item.detail || 'Live solver error.', true);
      controlsEnabled();
    }
  };
  const switchMode = async (next) => {
    if (next === mode || (next === 'live' && !liveReady)) return;
    clearTimeout(settingsTimer);
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
        controlsEnabled();
        message('Connected · waiting for current solver status…');
      };
      source.onerror = () => {
        controlsEnabled();
        message('Live stream disconnected · reconnecting. The displayed state is held.', true);
      };
      if (plan) onPlan(plan);
      if (state) onState(state);
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
    commandPending = true;
    controlsEnabled();
    if (status === 'playing' && !await send({type: 'pause'})) { commandPending = false; controlsEnabled(); return; }
    await submitSettings();
    commandPending = false;
    controlsEnabled();
  });
  $('live-play').addEventListener('click', async () => {
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
    if (await send({ type: 'reset' })) onReset();
  });
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
    get mode() { return mode; },
    get plan() { return plan; },
    get state() { return state; },
    get settings() { return settings ? cloneSettings(settings) : null; },
    get status() { return status; },
    get pending() { return pending || commandPending || (mode === 'live' && (needsInitialPreview || !source || source.readyState !== EventSource.OPEN)); },
    togglePlay: () => { if (mode === 'live' && !$('live-play').disabled) $('live-play').click(); },
  };
}
