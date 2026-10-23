import { sourceRequest } from './source-settings.js';
import { DEFAULT_LIMIT_USE, LIMIT_USE_RANGES } from './limit-use.js';

export const DEFAULT_PRESENTATION = { report_hz: 20, buffer_ms: 200, interpolate: false, limit_tint: true, ghost_opacity_percent: 55, ...DEFAULT_LIMIT_USE };
const LIMIT_MESSAGES = {
  limit_near_percent: 'Near limit must be between 1 and 100 %.',
  limit_at_position_rad: 'Position at-tolerance must be between 0 and 0.1 rad.',
  limit_at_velocity_rad_s: 'Velocity at-tolerance must be between 0 and 1 rad/s.',
  limit_at_torque_percent: 'Torque at-tolerance must be between 0 and 10 % of effort.',
};

export function validatePresentation(value) {
  const next = { ...DEFAULT_PRESENTATION, ...value };
  if (!Number.isFinite(next.report_hz) || next.report_hz < 1 || next.report_hz > 120) throw new Error('Reporting Hz must be between 1 and 120.');
  if (!Number.isFinite(next.buffer_ms) || next.buffer_ms < 0 || next.buffer_ms > 10000) throw new Error('Playback buffer must be between 0 and 10000 ms.');
  if (typeof next.interpolate !== 'boolean') throw new Error('Interpolate motion must be on or off.');
  if (typeof next.limit_tint !== 'boolean') throw new Error('Joint limit tint must be on or off.');
  if (!Number.isFinite(next.ghost_opacity_percent) || next.ghost_opacity_percent < 0 || next.ghost_opacity_percent > 100) throw new Error('Ghost arms opacity must be between 0 and 100 %.');
  for (const [name, [low, high]] of Object.entries(LIMIT_USE_RANGES)) {
    if (typeof next[name] !== 'number' || !Number.isFinite(next[name]) || next[name] < low || next[name] > high) throw new Error(LIMIT_MESSAGES[name]);
  }
  return next;
}

const FIELD_RULES = {
  report_hz: { number: true, message: 'Reporting Hz must be between 1 and 120.' },
  buffer_ms: { number: true, message: 'Playback buffer must be between 0 and 10000 ms.' },
  ghost_opacity_percent: { number: true },
  ...Object.fromEntries(Object.keys(LIMIT_MESSAGES).map(name => [name, { number: true }])),
};

// Parses one field; returns { value } or { error } with the reason for a tooltip.
export function parsePresentationField(name, raw) {
  const value = FIELD_RULES[name]?.number ? (String(raw).trim() === '' ? NaN : Number(raw)) : raw;
  try { return { value: validatePresentation({ [name]: value })[name] }; } catch (error) { return { error: error.message }; }
}

// Presentation preferences have their own endpoint: they never submit MPC
// settings, replace a history generation, or request a preview. Every valid
// change applies at once (`onChange`) and is saved after a short debounce; the
// last value wins and at most one save is in flight.
export function setupPresentationSettings({ container, onChange = () => {}, request = sourceRequest, inputDelayMs = 700, saveDelayMs = 400 } = {}) {
  const content = document.createElement('section'); content.className = 'source-settings-form presentation-settings';
  const tips = {
    report_hz: 'Batches per wall-clock second. Each batch retains every simulation sample; simulation, control and replanning rates stay independent. Range 1 to 120.',
    buffer_ms: 'Recorded simulation time to collect before starting or resuming a starved Live view. Fully downloaded recordings start immediately. Range 0 to 10000 ms.',
    ghost_opacity_percent: 'Opacity of ghost arms. Poses further from the cursor fade from this value. Range 0 to 100 %.',
    limit_near_percent: 'Near (amber) from this limit use: position |q − centre| / half range, velocity |qd| / limit, torque |τ| / effort, all against the URDF limits. Range 1 to 100 %.',
    limit_at_position_rad: 'At the limit (red) within this distance of a URDF position bound, on either side; further beyond is outlined. Range 0 to 0.1 rad.',
    limit_at_velocity_rad_s: 'At the limit (red) within this distance of the URDF velocity limit, on either side. Range 0 to 1 rad/s.',
    limit_at_torque_percent: 'At the limit (red) within this share of the URDF effort limit, on either side. Range 0 to 10 %.',
  };
  content.innerHTML = `<h3 class="presentation-title">Presentation / Playback</h3>
    <label>Reporting Hz<input name="report_hz" type="number" min="1" max="120" step="any" required></label>
    <label>Playback buffer (ms)<input name="buffer_ms" type="number" min="0" max="10000" step="any" required></label>
    <label class="source-rebuild" title="Off: display the recorded sample at the cursor. On: interpolate motion between recorded samples. Imported Replay playback is independent."><input name="interpolate" type="checkbox">Interpolate motion</label>
    <label>Ghost arms opacity (%)<input name="ghost_opacity_percent" type="number" min="0" max="100" step="1" required></label>
    <label class="source-rebuild" title="Colours each link by its joint's worst limit state: amber near, red at, red outlined beyond a URDF position, velocity or torque limit. Hover a tinted link for the distance to the bound."><input name="limit_tint" type="checkbox">Tint links near joint limits</label>
    <h3 class="presentation-subtitle">Joint limit states</h3>
    <label>Near from (%)<input name="limit_near_percent" type="number" min="1" max="100" step="any" required></label>
    <label>At: position (rad)<input name="limit_at_position_rad" type="number" min="0" max="0.1" step="any" required></label>
    <label>At: velocity (rad/s)<input name="limit_at_velocity_rad_s" type="number" min="0" max="1" step="any" required></label>
    <label>At: torque (% effort)<input name="limit_at_torque_percent" type="number" min="0" max="10" step="any" required></label>`;
  container.append(content);
  const field = name => content.querySelector(`[name="${name}"]`);
  const title = content.querySelector('.presentation-title');
  const numeric = ['report_hz', 'buffer_ms', 'ghost_opacity_percent', ...Object.keys(LIMIT_MESSAGES)], names = [...numeric, 'interpolate', 'limit_tint'];
  for (const name of numeric) field(name).title = tips[name];
  let settings = { ...DEFAULT_PRESENTATION }, loaded = false;
  function populate() { for (const name of names) { if (name === 'interpolate' || name === 'limit_tint') field(name).checked = settings[name]; else field(name).value = settings[name]; } }
  function markInvalid(name, error) {
    const input = field(name);
    if (error) { input.dataset.invalid = 'true'; input.title = error; input.setAttribute?.('aria-invalid', 'true'); }
    else { delete input.dataset.invalid; input.title = tips[name]; input.removeAttribute?.('aria-invalid'); }
  }
  function markSaveFailed(error) {
    if (error) { title.dataset.saveFailed = 'true'; title.title = `Not saved: ${error.message || error}. The setting is applied for this session; the next change retries.`; }
    else { delete title.dataset.saveFailed; title.title = ''; }
  }

  let saveTimer = null, saving = false, dirty = false;
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, saveDelayMs); }
  async function flush() {
    saveTimer = null;
    if (saving) { dirty = true; return; }
    saving = true; dirty = false;
    try { await request('/api/presentation/settings', { ...settings }); markSaveFailed(null); }
    catch (error) { markSaveFailed(error); }
    finally { saving = false; if (dirty) scheduleSave(); }
  }

  function commit(name) {
    if (!loaded) return;
    clearTimeout(timers[name]);
    const input = field(name);
    const parsed = numeric.includes(name) ? parsePresentationField(name, input.value) : { value: input.checked };
    markInvalid(name, parsed.error);
    if (parsed.error || parsed.value === settings[name]) return;
    settings = { ...settings, [name]: parsed.value };
    onChange({ ...settings }); scheduleSave();
  }
  const timers = {};
  for (const name of names) {
    const input = field(name);
    if (numeric.includes(name)) {
      input.addEventListener('input', () => { clearTimeout(timers[name]); markInvalid(name, parsePresentationField(name, input.value).error); timers[name] = setTimeout(() => commit(name), inputDelayMs); });
      input.addEventListener('change', () => commit(name));
      input.addEventListener('keydown', event => { if (event.key === 'Enter') commit(name); });
    } else input.addEventListener('change', () => commit(name));
  }

  populate(); for (const name of names) field(name).disabled = true;
  const ready = request('/api/presentation/settings').then(value => {
    settings = validatePresentation(value); populate(); onChange({ ...settings }); return { ...settings };
  }).catch(error => { markSaveFailed(error); return { ...settings }; })
    .finally(() => { loaded = true; for (const name of names) field(name).disabled = false; });
  return { ready, get settings() { return { ...settings }; } };
}
