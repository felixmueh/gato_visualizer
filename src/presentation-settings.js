import { sourceRequest } from './source-settings.js';
import { DEFAULT_LIMIT_USE, LIMIT_USE_RANGES } from './limit-use.js';
import { parseTimeValue, configureTimeInput, setTimeInputValue } from './time-input.js';

export const DEFAULT_PRESENTATION = { report_hz: 20, buffer_ms: 200, interpolate: false, limit_tint: true, ghost_start_opacity_percent: 55, ghost_end_opacity_percent: 25, ...DEFAULT_LIMIT_USE };
const LIMIT_MESSAGES = {
  limit_near_percent: 'Near limit must be between 1 and 100 %.',
  limit_at_position_rad: 'Position at-tolerance must be between 0 and 0.1 rad.',
  limit_at_velocity_rad_s: 'Velocity at-tolerance must be between 0 and 1 rad/s.',
  limit_at_torque_percent: 'Torque at-tolerance must be between 0 and 10 % of effort.',
};

export function migratePresentation(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Presentation settings must be an object.');
  const next = { ...value };
  if ('ghost_opacity_percent' in next) {
    const legacy = next.ghost_opacity_percent; delete next.ghost_opacity_percent;
    if (!('ghost_start_opacity_percent' in next) || !('ghost_end_opacity_percent' in next)) {
      if (!Number.isFinite(legacy) || legacy < 0 || legacy > 100) throw new Error('Ghost opacity must be between 0 and 100 %.');
      if (!('ghost_start_opacity_percent' in next)) next.ghost_start_opacity_percent = legacy;
      if (!('ghost_end_opacity_percent' in next)) next.ghost_end_opacity_percent = legacy * (25 / 55);
    }
  }
  return next;
}

export function validatePresentation(value) {
  const next = { ...DEFAULT_PRESENTATION, ...migratePresentation(value) };
  if (Object.keys(next).some(name => !Object.hasOwn(DEFAULT_PRESENTATION, name))) throw new Error('Unknown presentation setting.');
  if (!Number.isFinite(next.report_hz) || next.report_hz < 1 || next.report_hz > 120) throw new Error('Reporting Hz must be between 1 and 120.');
  if (!Number.isFinite(next.buffer_ms) || next.buffer_ms < 0 || next.buffer_ms > 10000) throw new Error('Playback buffer must be between 0 and 10000 ms.');
  if (typeof next.interpolate !== 'boolean') throw new Error('Interpolate motion must be on or off.');
  if (typeof next.limit_tint !== 'boolean') throw new Error('Joint limit tint must be on or off.');
  for (const [name, label] of [['ghost_start_opacity_percent', 'Ghost start opacity'], ['ghost_end_opacity_percent', 'Ghost end opacity']]) {
    if (!Number.isFinite(next[name]) || next[name] < 0 || next[name] > 100) throw new Error(`${label} must be between 0 and 100 %.`);
  }
  for (const [name, [low, high]] of Object.entries(LIMIT_USE_RANGES)) {
    if (typeof next[name] !== 'number' || !Number.isFinite(next[name]) || next[name] < low || next[name] > high) throw new Error(LIMIT_MESSAGES[name]);
  }
  return next;
}

const FIELD_RULES = {
  report_hz: { number: true, message: 'Reporting Hz must be between 1 and 120.' },
  buffer_ms: { number: true, message: 'Playback buffer must be between 0 and 10000 ms.' },
  ghost_start_opacity_percent: { number: true },
  ghost_end_opacity_percent: { number: true },
  ...Object.fromEntries(Object.keys(LIMIT_MESSAGES).map(name => [name, { number: true }])),
};
const TIME_FIELDS = { report_hz: { unit: 'Hz', label: 'Reporting rate' },
  buffer_ms: { unit: 'ms', label: 'Playback buffer' } };

// Parses one field; returns { value } or { error } with the reason for a tooltip.
export function parsePresentationField(name, raw) {
  try {
    const value = TIME_FIELDS[name] ? parseTimeValue(raw, TIME_FIELDS[name]) : FIELD_RULES[name]?.number ? (String(raw).trim() === '' ? NaN : Number(raw)) : raw;
    return { value: validatePresentation({ [name]: value })[name] };
  } catch (error) { return { error: error.message }; }
}

// Presentation preferences have their own endpoint: they never submit MPC
// settings, replace a history generation, or request a preview. Every valid
// change applies at once (`onChange`) and is saved after a short debounce; the
// only edited fields are saved and at most one save is in flight. Polling also
// runs in Replay, where the Live event stream is intentionally disconnected.
export function setupPresentationSettings({ container, onChange = () => {}, request = sourceRequest, inputDelayMs = 700, saveDelayMs = 400, pollDelayMs = 1000 } = {}) {
  const content = document.createElement('section'); content.className = 'source-settings-form presentation-settings';
  const tips = {
    report_hz: 'Batches per wall-clock second. Each batch retains every simulation sample; simulation, control and replanning rates stay independent. Range 1 to 120.',
    buffer_ms: 'Recorded simulation time to collect before starting or resuming a starved Live view. Fully downloaded recordings start immediately. Range 0 to 10000 ms.',
    ghost_start_opacity_percent: 'Opacity of ghost arms at the beginning of the aggregate range. Range 0 to 100 %.',
    ghost_end_opacity_percent: 'Opacity of ghost arms at the end of the aggregate range. Range 0 to 100 %.',
    limit_near_percent: 'Near (amber) from this limit use: position |q − centre| / half range, velocity |qd| / limit, torque |τ| / effort, all against the URDF limits. Range 1 to 100 %.',
    limit_at_position_rad: 'At the limit (red) within this distance of a URDF position bound, on either side; further beyond is outlined. Range 0 to 0.1 rad.',
    limit_at_velocity_rad_s: 'At the limit (red) within this distance of the URDF velocity limit, on either side. Range 0 to 1 rad/s.',
    limit_at_torque_percent: 'At the limit (red) within this share of the URDF effort limit, on either side. Range 0 to 10 %.',
  };
  content.innerHTML = `<h3 class="presentation-title">Presentation / Playback</h3>
    <label>Reporting Hz<input name="report_hz" type="number" min="1" max="120" step="any" required></label>
    <label>Playback buffer (ms)<input name="buffer_ms" type="number" min="0" max="10000" step="any" required></label>
    <label class="source-rebuild" title="Off: display the recorded sample at the cursor. On: interpolate motion between recorded samples. Imported Replay playback is independent."><input name="interpolate" type="checkbox">Interpolate motion</label>
    <label>Ghost start opacity (%)<input name="ghost_start_opacity_percent" type="number" min="0" max="100" step="any" required></label>
    <label>Ghost end opacity (%)<input name="ghost_end_opacity_percent" type="number" min="0" max="100" step="any" required></label>
    <label class="source-rebuild" title="Colours each link by its joint's worst limit state: amber near, red at, red outlined beyond a URDF position, velocity or torque limit. Hover a tinted link for the distance to the bound."><input name="limit_tint" type="checkbox">Tint links near joint limits</label>
    <h3 class="presentation-subtitle">Joint limit states</h3>
    <label>Near from (%)<input name="limit_near_percent" type="number" min="1" max="100" step="any" required></label>
    <label>At: position (rad)<input name="limit_at_position_rad" type="number" min="0" max="0.1" step="any" required></label>
    <label>At: velocity (rad/s)<input name="limit_at_velocity_rad_s" type="number" min="0" max="1" step="any" required></label>
    <label>At: torque (% effort)<input name="limit_at_torque_percent" type="number" min="0" max="10" step="any" required></label>`;
  container.append(content);
  const field = name => content.querySelector(`[name="${name}"]`);
  const title = content.querySelector('.presentation-title');
  const numeric = ['report_hz', 'buffer_ms', 'ghost_start_opacity_percent', 'ghost_end_opacity_percent', ...Object.keys(LIMIT_MESSAGES)], names = [...numeric, 'interpolate', 'limit_tint'];
  for (const name of numeric) { field(name).title = tips[name]; if (TIME_FIELDS[name]) configureTimeInput(field(name), TIME_FIELDS[name]); }
  let settings = { ...DEFAULT_PRESENTATION }, loaded = false, disposed = false;
  const drafts = new Set();
  function populate(selected = names) { for (const name of selected) { if (name === 'interpolate' || name === 'limit_tint') field(name).checked = settings[name]; else if (TIME_FIELDS[name]) setTimeInputValue(field(name), settings[name], TIME_FIELDS[name]); else field(name).value = settings[name]; } }
  function markInvalid(name, error) {
    const input = field(name);
    if (error) { input.dataset.invalid = 'true'; input.title = error; input.setAttribute?.('aria-invalid', 'true'); }
    else { delete input.dataset.invalid; input.title = tips[name]; input.removeAttribute?.('aria-invalid'); if (TIME_FIELDS[name]) configureTimeInput(input, TIME_FIELDS[name]); }
  }
  function markSaveFailed(error) {
    if (error) { title.dataset.saveFailed = 'true'; title.title = `Not saved: ${error.message || error}. The setting is applied for this session; the next change retries.`; }
    else { delete title.dataset.saveFailed; title.title = ''; }
  }

  let saveTimer = null, pollTimer = null, saving = false, pending = {}, saveAgain = false, requestEpoch = 0, refreshing = false;
  function accept(value) {
    if (disposed) return;
    const next = { ...validatePresentation(value), ...pending };
    const changed = names.filter(name => next[name] !== settings[name]);
    settings = next;
    for (const name of changed) if (!drafts.has(name)) { populate([name]); markInvalid(name, null); }
    if (changed.length) onChange({ ...settings });
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, saveDelayMs); }
  async function flush() {
    saveTimer = null;
    if (disposed || !Object.keys(pending).length) return;
    if (saving) { saveAgain = true; return; }
    const sent = pending; pending = {};
    saving = true; saveAgain = false; ++requestEpoch;
    let retry = false, succeeded = false;
    try {
      const value = await request('/api/presentation/settings/patch', sent);
      if (!disposed) { accept(value); markSaveFailed(null); succeeded = true; }
    } catch (error) {
      retry = Object.keys(pending).length > 0;
      pending = { ...sent, ...pending };
      if (!disposed) markSaveFailed(error);
    } finally {
      saving = false; ++requestEpoch;
      if (!disposed && (retry || saveAgain || (succeeded && Object.keys(pending).length))) scheduleSave();
    }
  }
  async function refresh() {
    if (disposed || saving || refreshing) return;
    const epoch = requestEpoch; refreshing = true;
    try {
      const value = await request('/api/presentation/settings');
      if (!disposed && !saving && epoch === requestEpoch) accept(value);
    } catch { /* A transient disconnect keeps the last displayed preferences. */ }
    finally { refreshing = false; }
  }
  function schedulePoll() {
    if (disposed || !(pollDelayMs > 0)) return;
    pollTimer = setTimeout(async () => { await refresh(); schedulePoll(); }, pollDelayMs);
    pollTimer?.unref?.();
  }

  function commit(name) {
    if (!loaded || disposed) return;
    clearTimeout(timers[name]);
    drafts.delete(name);
    const input = field(name);
    const parsed = numeric.includes(name) ? parsePresentationField(name, input.value) : { value: input.checked };
    markInvalid(name, parsed.error);
    if (parsed.error || parsed.value === settings[name]) return;
    settings = { ...settings, [name]: parsed.value };
    pending[name] = parsed.value;
    onChange({ ...settings }); scheduleSave();
  }
  const timers = {};
  for (const name of names) {
    const input = field(name);
    if (numeric.includes(name)) {
      input.addEventListener('input', () => { drafts.add(name); clearTimeout(timers[name]); markInvalid(name, parsePresentationField(name, input.value).error); timers[name] = setTimeout(() => commit(name), inputDelayMs); });
      input.addEventListener('change', () => commit(name));
      input.addEventListener('keydown', event => { if (event.key === 'Enter') commit(name); });
    } else input.addEventListener('change', () => commit(name));
  }

  populate(); for (const name of names) field(name).disabled = true;
  const ready = request('/api/presentation/settings').then(value => {
    if (disposed) return { ...settings };
    settings = validatePresentation(value); populate(); onChange({ ...settings }); return { ...settings };
  }).catch(error => { markSaveFailed(error); return { ...settings }; })
    .finally(() => { if (!disposed) { loaded = true; for (const name of names) field(name).disabled = false; schedulePoll(); } });
  function dispose() {
    disposed = true; ++requestEpoch;
    clearTimeout(saveTimer); clearTimeout(pollTimer);
    for (const timer of Object.values(timers)) clearTimeout(timer);
  }
  return { ready, refresh, dispose, get settings() { return { ...settings }; } };
}
