import { DEFAULT_GHOST_SETTINGS as GHOST_DEFAULTS, validateGhostSettings as validateRenderSettings } from './onion-skin.js';
import { configureTimeInput, readTimeInput, setTimeInputValue } from './time-input.js';
const SPACING_TIME = { unit: 's', min: .01, max: 3600, label: 'Ghost spacing' };

// Hover and keyboard access share the same small settings panel. Keeping the
// panel inside its control makes the upward pointer path continuous.
export function setupTransportPopovers(doc = document) {
  const closeAll = [];
  for (const wrapper of doc.querySelectorAll('[data-transport-popover]')) {
    const trigger = wrapper.querySelector('[data-popover-trigger]');
    const panel = wrapper.querySelector('[data-popover-panel]');
    let hovered = false, dismissed = false;
    function show() { if (dismissed) return; panel.hidden = false; trigger.setAttribute('aria-expanded', 'true'); }
    function hide() { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
    wrapper.addEventListener('pointerenter', () => { hovered = true; dismissed = false; show(); });
    wrapper.addEventListener('pointerleave', () => { hovered = false; dismissed = false; if (!panel.contains(doc.activeElement)) hide(); });
    wrapper.addEventListener('focusin', show);
    wrapper.addEventListener('focusout', event => { if (!hovered && !wrapper.contains(event.relatedTarget)) { dismissed = false; hide(); } });
    wrapper.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault(); dismissed = true; hide(); trigger.focus();
      } else if (event.key === 'ArrowUp' && event.target === trigger) {
        event.preventDefault(); dismissed = false; show(); panel.querySelector('input')?.focus();
      }
    });
    closeAll.push(hide);
  }
  return { close: () => closeAll.forEach(close => close()) };
}

export const GHOST_SETTINGS_KEY = 'motion-studio-ghost-settings';
export const DEFAULT_GHOST_SETTINGS = Object.freeze({ spacingEnabled: GHOST_DEFAULTS.spacingEnabled, interval_s: GHOST_DEFAULTS.interval_s, maxCount: GHOST_DEFAULTS.maxCount });

export function validateGhostSettings(value) {
  const { spacingEnabled, interval_s, maxCount } = validateRenderSettings(value);
  return { spacingEnabled, interval_s, maxCount };
}

export function setupGhostControls({ onChange, doc = document, storage }) {
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch {} }
  let settings = { ...DEFAULT_GHOST_SETTINGS };
  try { settings = validateGhostSettings({ ...settings, ...JSON.parse(storage.getItem(GHOST_SETTINGS_KEY)) }); } catch {}
  const fields = ['live', 'replay'].flatMap(mode => ['spacingEnabled', 'interval_s', 'maxCount'].map(name => ({
    name, input: doc.getElementById(`${mode}-ghost-${name}`),
  })));
  function populate() { for (const { name, input } of fields) {
    if (name === 'spacingEnabled') input.checked = settings[name];
    else if (name === 'interval_s') setTimeInputValue(input, settings[name], SPACING_TIME);
    else input.value = settings[name];
    input.removeAttribute('aria-invalid'); input.title = input.dataset.tip;
    if (name === 'interval_s') { input.disabled = !settings.spacingEnabled; configureTimeInput(input, SPACING_TIME); }
  } }
  function commit({ name, input }) {
    try {
      const value = name === 'spacingEnabled' ? input.checked : name === 'interval_s' ? readTimeInput(input, SPACING_TIME) : input.value.trim() === '' ? NaN : Number(input.value);
      const next = validateGhostSettings({ ...settings, [name]: value });
      input.removeAttribute('aria-invalid'); input.title = input.dataset.tip;
      settings = next; populate();
      try { storage.setItem(GHOST_SETTINGS_KEY, JSON.stringify(settings)); } catch {}
      onChange({ ...settings });
    } catch (error) { input.setAttribute('aria-invalid', 'true'); input.title = error.message; }
  }
  for (const field of fields) {
    field.input.addEventListener('change', () => commit(field));
    field.input.addEventListener('keydown', event => { if (event.key === 'Enter') commit(field); });
  }
  populate(); onChange({ ...settings });
  return { get settings() { return { ...settings }; } };
}
