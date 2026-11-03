import { sourceRequest, trackCheckoutDefaults } from './source-settings.js';
import { createSettingResets } from './setting-resets.js';

/** Named solver choices are independent of the simulator source and page life. */
export function setupSolverProfiles({ liveContainer, editorContainer, beforeActivate = () => undefined, onSettled = () => {}, request = sourceRequest, schedule = setTimeout, unschedule = clearTimeout,
  intervalMs = typeof window === 'undefined' ? 0 : 1000 } = {}) {
  const doc = liveContainer.ownerDocument || document;
  const el = (tag, text) => { const node = doc.createElement(tag); if (text != null) node.textContent = text; return node; };
  const button = (text, action) => { const node = el('button', text); node.type = 'button'; node.addEventListener('click', action); return node; };
  // Same label/select idiom as Task and Recording; status only for transitions and failures.
  const compact = el('div'); compact.className = 'solver-profile-selector';
  const label = el('label', 'SOLVER'), wrap = el('div'), select = el('select'), status = el('p');
  label.className = 'field-label'; label.htmlFor = 'live-solver-profile'; select.id = 'live-solver-profile'; wrap.className = 'select-wrap';
  status.className = 'settings-note solver-profile-status'; status.setAttribute('role', 'status'); select.setAttribute('aria-label', 'Active solver profile'); wrap.append(select); compact.append(label, wrap, status);
  if (liveContainer.prepend) liveContainer.prepend(compact); else liveContainer.append(compact);
  const editor = el('section'); editor.className = 'source-settings-form solver-profile-editor';
  editor.className += ' dialog-section'; editor.append(el('h3', 'Solver profiles'));
  const editorRow = el('div'), editorLabel = el('label', 'Saved profile'), editorWrap = el('div'), editorSelect = el('select');
  editorRow.className = 'dialog-field'; editorWrap.className = 'select-wrap'; editorSelect.id = 'solver-profile-edit'; editorLabel.htmlFor = editorSelect.id;
  editorSelect.setAttribute('aria-label', 'Edit solver profile'); editorWrap.append(editorSelect); editorRow.append(editorLabel, editorWrap); editor.append(editorRow);
  const fields = {};
  for (const [name, title, placeholder] of [['name', 'Profile name', 'e.g. Current main'], ['mpc_root', 'tiago_mpc checkout', 'Absolute checkout path'], ['python', 'Python interpreter', ''], ['cache', 'Binary cache', '']]) {
    const row = el('div'), rowLabel = el('label', title), input = el('input'); row.className = 'dialog-field';
    input.type = 'text'; input.name = `profile_${name}`; input.id = `solver-profile-${name}`; rowLabel.htmlFor = input.id; input.spellcheck = false; input.autocomplete = 'off'; if (placeholder) input.placeholder = placeholder;
    input.addEventListener('input', () => { editorDirty = true; controls(); }); row.append(rowLabel, input); editor.append(row); fields[name] = input;
  }
  const resets = createSettingResets({ document: doc });
  const checkout = trackCheckoutDefaults({ fields, resets, request, group: 'solver-profile', label: 'solver ' });
  fields.mpc_root.addEventListener('change', () => checkout.follow(fields.mpc_root.value.trim()));
  const actions = el('div'); actions.className = 'source-actions';
  const save = button('Save profile', saveProfile), activateButton = button('Use this solver', () => activate(editorId)); actions.append(save, activateButton); editor.append(actions);
  activateButton.title = 'Pauses calculation and continues from the displayed native robot state; simulator, replay library and page stay open';
  const feedback = el('p'); feedback.className = 'source-message'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); editor.append(feedback); editorContainer.append(editor);
  let catalog = { profiles: [], active_profile_id: null, switch: { state: 'idle' } }, editorId = null, editorDirty = false, saving = false, switching = false, timer, epoch = 0, settledKey, settling;
  let disposed = false, initialized = false, reading = Promise.resolve(), completionGeneration = -1, completionRevision = -1, activationPending = null;
  function say(text, error = false) { status.textContent = text; feedback.textContent = text; feedback.dataset.error = String(error); }
  function controls() {
    select.disabled = switching || !catalog.profiles.length;
    editorSelect.disabled = switching || saving; save.disabled = switching || saving;
    activateButton.disabled = switching || saving || !editorId || editorDirty;
  }
  function fillEditor() {
    const profile = catalog.profiles.find(item => item.id === editorId);
    for (const key of Object.keys(fields)) fields[key].value = profile?.templates?.[key] || profile?.[key] || '';
    checkout.apply(null); checkout.follow(fields.mpc_root.value.trim());
    editorDirty = false;
  }
  function render() {
    select.replaceChildren(...[...(catalog.active_profile_id ? [] : [{ id: '', name: 'No active solver' }]), ...catalog.profiles].map(profile => { const option = el('option', profile.name); option.value = profile.id; return option; }));
    select.value = catalog.active_profile_id || '';
    if (editorId == null) { editorId = catalog.active_profile_id || ''; fillEditor(); }
    editorSelect.replaceChildren(...[{ id: '', name: 'New profile…' }, ...catalog.profiles].map(profile => { const option = el('option', profile.name); option.value = profile.id; return option; })); editorSelect.value = editorId;
    const active = catalog.profiles.find(item => item.id === catalog.active_profile_id);
    select.title = active ? `Solver: ${active.mpc_root}${active.python ? ` · ${active.python}` : ''}` : 'Select a prepared solver profile';
    controls();
  }
  async function refresh({ observeSwitch = true } = {}) {
    // Polling, dialog refreshes and SSE settlement share one read stream. A
    // reply started before an activation cannot overwrite its new catalog.
    const load = reading.catch(() => {}).then(async () => {
      if (disposed) return null;
      const revision = epoch, result = await request('/api/solver-profiles');
      if (disposed || revision !== epoch) return null;
      if (!Array.isArray(result.profiles)) throw new Error('Solver profile catalog is unavailable.');
      const previous = catalog, seen = initialized;
      const changed = !seen || JSON.stringify(result) !== JSON.stringify(previous);
      const editorChanged = JSON.stringify(previous.profiles.find(item => item.id === editorId)) !== JSON.stringify(result.profiles.find(item => item.id === editorId));
      catalog = result; initialized = true;
      if (changed) { render(); if (editorChanged && !editorDirty) fillEditor(); }
      return { previous, seen, changed };
    });
    reading = load;
    try {
      const loaded = await load;
      if (!loaded || disposed) return catalog;
      if (observeSwitch && catalog.switch?.state === 'switching') {
        if (!switching) { switching = true; settledKey = undefined; ++epoch; await beforeActivate(); }
        say('Switching solver · calculation paused…'); controls();
      } else if (observeSwitch && activationPending == null && (switching || (loaded.seen && (
        loaded.previous.active_profile_id !== catalog.active_profile_id ||
        (Number.isInteger(catalog.switch_revision) && loaded.previous.switch_revision !== catalog.switch_revision) ||
        (catalog.switch?.state === 'failed' && JSON.stringify(loaded.previous.switch) !== JSON.stringify(catalog.switch)))))) {
        await handleEvent(eventFromCatalog());
      } else if (!switching && loaded.changed) {
        const active = catalog.profiles.find(profile => profile.id === catalog.active_profile_id);
        // The select already names the active solver; status only for failures or none.
        say(catalog.switch?.state === 'failed' ? `Solver switch failed: ${catalog.switch.error || 'No solver is active.'}` : active ? '' : 'No solver is active. Select a prepared profile.', catalog.switch?.state === 'failed');
      }
      return catalog;
    } catch (error) { if (!disposed) say(`Solver profiles unavailable: ${error.message}`, true); throw error; }
    finally { if (observeSwitch) poll(); }
  }
  function eventFromCatalog() {
    return { type: 'solver_profile', state: catalog.switch?.state === 'failed' ? 'failed' : 'active',
      profile_id: catalog.switch?.profile_id || catalog.active_profile_id,
      active_profile_id: catalog.active_profile_id, generation: catalog.generation,
      switch_revision: catalog.switch_revision, error: catalog.switch?.error };
  }
  function poll() {
    unschedule(timer); timer = null;
    if (disposed || (!switching && intervalMs <= 0)) return;
    timer = schedule(async () => { unschedule(timer); timer = null; if (!disposed) await refresh().catch(() => {}); }, switching ? 500 : intervalMs);
  }
  async function saveProfile() {
    if (saving || switching) return;
    const name = fields.name.value.trim(), mpc_root = fields.mpc_root.value.trim();
    if (!name || !mpc_root) { say('Profile name and solver checkout are required.', true); return; }
    let id = editorId || name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'solver';
    if (!editorId) { const base = id; let suffix = 2; while (catalog.profiles.some(item => item.id === id)) id = `${base}-${suffix++}`; }
    saving = true; ++epoch; controls();
    try {
      catalog = await request('/api/solver-profiles', { profile: { id, name, mpc_root, python: checkout.value('python'), cache: checkout.value('cache') } });
      editorId = id; editorDirty = false; render(); fillEditor(); say('Solver profile saved. Select Use this solver to activate it.');
    } catch (error) { say(error.message, true); }
    finally { saving = false; controls(); }
  }
  async function activate(id) {
    if (!id || switching || disposed) return;
    unschedule(timer); timer = null;
    switching = true; settledKey = undefined; const attempt = ++epoch; activationPending = attempt; controls();
    try {
      const anchor = await beforeActivate();
      say('Switching solver · calculation paused…');
      await request('/api/solver-profiles/activate', { profile_id: id, ...(anchor ? { anchor } : {}) });
      if (attempt === epoch && switching) poll();
    } catch (error) {
      if (attempt === epoch) await handleEvent({ type: 'solver_profile', state: 'failed', profile_id: id, error: error.message });
    } finally { if (activationPending === attempt) activationPending = null; }
  }
  async function handleEvent(item) {
    if (disposed || !['active', 'failed'].includes(item.state)) return;
    const eventGeneration = item.generation ?? catalog.generation;
    const eventRevision = item.switch_revision;
    const revised = Number.isInteger(eventRevision) && eventRevision >= 0;
    if (revised ? eventRevision < completionRevision : eventGeneration < completionGeneration) return;
    // SSE omits active_profile_id on success; a polling completion includes it.
    // Both identify the same switch and must settle once.
    const key = revised ? JSON.stringify(['switch_revision', eventRevision, item.state])
      : JSON.stringify([item.state, item.profile_id, eventGeneration, item.error]);
    if (key === settledKey) return settling;
    const needsPause = !switching;
    settledKey = key; completionGeneration = Math.max(completionGeneration, eventGeneration);
    if (revised) completionRevision = Math.max(completionRevision, eventRevision);
    const attempt = ++epoch; unschedule(timer); switching = true; controls();
    settling = (async () => {
      try {
        if (needsPause) await beforeActivate();
        if (disposed || attempt !== epoch) return;
        await refresh({ observeSwitch: false });
        if (disposed || attempt !== epoch) return;
        await onSettled({ ...item, active_profile_id: Object.hasOwn(item, 'active_profile_id') ? item.active_profile_id : catalog.active_profile_id });
        say(item.state === 'failed' ? `Solver switch failed: ${item.error || 'No solver is active.'}` : 'Solver ready · simulation paused.', item.state === 'failed');
      } catch (error) { say(`Solver setup: ${error.message}`, true); }
      finally { if (attempt === epoch) { switching = false; if (!disposed) { render(); poll(); } } }
    })();
    return settling;
  }
  select.addEventListener('change', () => activate(select.value));
  editorSelect.addEventListener('change', () => { editorId = editorSelect.value; fillEditor(); controls(); });
  controls();
  function dispose() { disposed = true; ++epoch; unschedule(timer); timer = null; compact.remove(); editor.remove(); }
  return { refresh, handleEvent, activate, editor, select, fields, save, activateButton, get snapshot() { return { catalog, switching, editorId }; }, dispose, destroy: dispose };
}
