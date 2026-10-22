import { sourceRequest } from './source-settings.js';

export const DEFAULT_PRESENTATION = { report_hz: 20, buffer_ms: 200, interpolate: false, limit_tint: true };

export function validatePresentation(value) {
  const next = { ...DEFAULT_PRESENTATION, ...value };
  if (!Number.isFinite(next.report_hz) || next.report_hz < 1 || next.report_hz > 120) throw new Error('Reporting Hz must be between 1 and 120.');
  if (!Number.isFinite(next.buffer_ms) || next.buffer_ms < 0 || next.buffer_ms > 10000) throw new Error('Playback buffer must be between 0 and 10000 ms.');
  if (typeof next.interpolate !== 'boolean') throw new Error('Interpolate motion must be on or off.');
  if (typeof next.limit_tint !== 'boolean') throw new Error('Joint limit tint must be on or off.');
  return next;
}

const FIELD_RULES = {
  report_hz: { number: true, message: 'Reporting Hz must be between 1 and 120.' },
  buffer_ms: { number: true, message: 'Playback buffer must be between 0 and 10000 ms.' },
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
  };
  content.innerHTML = `<h3 class="presentation-title">Presentation / Playback</h3>
    <label>Reporting Hz<input name="report_hz" type="number" min="1" max="120" step="any" required></label>
    <label>Playback buffer (ms)<input name="buffer_ms" type="number" min="0" max="10000" step="any" required></label>
    <label class="source-rebuild" title="Off: display the recorded sample at the cursor. On: interpolate motion between recorded samples. Imported Replay playback is independent."><input name="interpolate" type="checkbox">Interpolate motion</label>
    <label class="source-rebuild" title="Colours each link red as its joint nears a position, velocity or torque limit (from 80 % use). Hover a tinted link for the limit."><input name="limit_tint" type="checkbox">Tint links near joint limits</label>`;
  container.append(content);
  const field = name => content.querySelector(`[name="${name}"]`);
  const title = content.querySelector('.presentation-title');
  const names = ['report_hz', 'buffer_ms', 'interpolate', 'limit_tint'], numeric = ['report_hz', 'buffer_ms'];
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
