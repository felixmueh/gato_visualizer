export function settingValuesEqual(value, baseline) {
  if (typeof value !== typeof baseline) return false;
  if (typeof value === 'number') return Number.isFinite(value) && Number.isFinite(baseline)
    && Math.abs(value - baseline) <= 1e-12 + 1e-9 * Math.max(Math.abs(value), Math.abs(baseline));
  if (Array.isArray(value) || Array.isArray(baseline)) return Array.isArray(value) && Array.isArray(baseline)
    && value.length === baseline.length && value.every((item, index) => settingValuesEqual(item, baseline[index]));
  if (value && baseline && typeof value === 'object') {
    const keys = Object.keys(value), other = Object.keys(baseline);
    return keys.length === other.length && keys.every(key => Object.hasOwn(baseline, key) && settingValuesEqual(value[key], baseline[key]));
  }
  return Object.is(value, baseline);
}

export function canonicalOrientation(quaternion = [0, 0, 0, 1]) {
  if (!Array.isArray(quaternion) || quaternion.length !== 4 || !quaternion.every(Number.isFinite)) throw new Error('Invalid orientation');
  const norm = Math.hypot(...quaternion);
  if (norm <= 1e-12) throw new Error('Invalid orientation');
  const normalized = quaternion.map(value => value / norm);
  const sign = (Math.abs(normalized[3]) > 1e-12 ? normalized[3] : normalized.find(value => Math.abs(value) > 1e-12)) < 0 ? -1 : 1;
  return normalized.map(value => value * sign);
}

export function createSettingResets({ document: doc = document } = {}) {
  let entries = [];
  const bind = ({ key, name, input, host = input?.closest?.('label') || input, getValue, getDefault, reset, event = 'input', group = 'settings', focusTarget = input }) => {
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'setting-reset';
    button.dataset.resetSetting = key; button.setAttribute('aria-label', `Reset ${name} to default`);
    button.title = `Reset ${name} to default`; button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.1 7a6.6 6.6 0 1 1-.5 5M4 3.5V7h3.5"/></svg>';
    const wrapper = doc.createElement('div'); wrapper.className = 'setting-reset-field';
    // Keep the reset outside the label: clicking it must not also toggle a
    // checkbox or focus a different field through label activation.
    host?.replaceWith?.(wrapper); wrapper.append(button, host);
    const update = () => {
      let modified = false;
      if (!input?.disabled) {
        try { modified = !settingValuesEqual(getValue(), getDefault()); }
        catch { modified = true; }
      }
      button.disabled = !modified; button.style.visibility = modified ? 'visible' : 'hidden';
      button.setAttribute('aria-hidden', String(!modified)); button.tabIndex = modified ? 0 : -1;
      wrapper.classList.toggle('setting-modified', modified);
      return modified;
    };
    button.addEventListener('click', eventObject => {
      eventObject.preventDefault(); eventObject.stopPropagation();
      if (button.disabled) return;
      const focused = doc.activeElement === button;
      reset(getDefault());
      update();
      if (focused) focusTarget?.focus?.({ preventScroll: true });
    });
    input?.addEventListener('input', update); input?.addEventListener('change', update);
    const entry = { key, group, input, button, update }; entries.push(entry); update();
    return entry;
  };
  return {
    bind,
    update() { for (const entry of entries) entry.update(); },
    forget(group) { entries = entries.filter(entry => entry.group !== group); },
    get entries() { return [...entries]; },
  };
}
