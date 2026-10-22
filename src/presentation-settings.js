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

// Presentation preferences have their own endpoint: they never submit MPC
// settings, replace a history generation, or request a preview.
export function setupPresentationSettings({ container, onChange = () => {}, request = sourceRequest } = {}) {
  const content = document.createElement('section'); content.className = 'source-settings-form presentation-settings';
  content.innerHTML = `<hr><h3>Presentation / Playback</h3>
    <label>Reporting Hz<input name="report_hz" type="number" min="1" max="120" step="any" required></label>
    <p class="settings-note">Batches per wall-clock second. Each batch retains every simulation sample; simulation, control and replanning rates stay independent.</p>
    <label>Playback buffer (ms)<input name="buffer_ms" type="number" min="0" max="10000" step="any" required></label>
    <p class="settings-note">Recorded simulation time to collect before starting or resuming a starved Live view. Fully downloaded recordings start immediately.</p>
    <label class="source-rebuild"><input name="interpolate" type="checkbox">Interpolate motion</label>
    <p class="settings-note">Off: display the recorded sample at the cursor. On: interpolate motion between recorded samples. Imported Replay playback is independent.</p>
    <label class="source-rebuild"><input name="limit_tint" type="checkbox">Tint links near joint limits</label>
    <p class="settings-note">Colours each link red as its joint nears a position, velocity or torque limit (from 80 % use). Hover a tinted link for the limit.</p>
    <div class="source-actions"><button type="button" data-action="save-presentation">Save presentation settings</button></div>
    <p class="presentation-message settings-note" role="status" aria-live="polite"></p>`;
  container.append(content);
  const field = name => content.querySelector(`[name="${name}"]`);
  const save = content.querySelector('[data-action="save-presentation"]'), message = content.querySelector('.presentation-message');
  let settings = { ...DEFAULT_PRESENTATION }, revision = 0;
  function populate() {
    field('report_hz').value = settings.report_hz; field('buffer_ms').value = settings.buffer_ms; field('interpolate').checked = settings.interpolate; field('limit_tint').checked = settings.limit_tint;
  }
  function say(text, error = false) { message.textContent = text; message.dataset.error = String(error); }
  populate(); save.disabled = true;
  const ready = request('/api/presentation/settings').then(value => {
    settings = validatePresentation(value); populate(); onChange({ ...settings }); return { ...settings };
  }).catch(error => { say(`Presentation settings: ${error.message}`, true); return { ...settings }; })
    .finally(() => { save.disabled = false; });
  save.addEventListener('click', async () => {
    const token = ++revision;
    try {
      const value = validatePresentation({ report_hz: field('report_hz').value.trim() === '' ? NaN : Number(field('report_hz').value),
        buffer_ms: field('buffer_ms').value.trim() === '' ? NaN : Number(field('buffer_ms').value), interpolate: field('interpolate').checked, limit_tint: field('limit_tint').checked });
      save.disabled = true; say('Saving presentation settings…');
      const accepted = await request('/api/presentation/settings', value);
      if (token !== revision) return;
      settings = validatePresentation(accepted); populate(); onChange({ ...settings }); say('Presentation settings saved.');
    } catch (error) { if (token === revision) say(error.message, true); }
    finally { if (token === revision) save.disabled = false; }
  });
  return { ready, get settings() { return { ...settings }; } };
}
