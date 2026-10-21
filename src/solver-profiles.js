import { sourceRequest } from './source-settings.js';

/** Named solver choices are independent of the simulator source and page life. */
export function setupSolverProfiles({ liveContainer, editorContainer, beforeActivate = () => undefined, onSettled = () => {}, request = sourceRequest, schedule = setTimeout, unschedule = clearTimeout } = {}) {
  const doc = liveContainer.ownerDocument || document;
  const el = (tag, text) => { const node = doc.createElement(tag); if (text != null) node.textContent = text; return node; };
  const button = (text, action) => { const node = el('button', text); node.type = 'button'; node.addEventListener('click', action); return node; };
  const compact = el('div'); compact.className = 'solver-profile-selector';
  const label = el('label', 'Solver '), select = el('select'), status = el('p'); status.className = 'settings-note'; status.setAttribute('role', 'status'); select.setAttribute('aria-label', 'Active solver profile'); label.append(select); compact.append(label, status);
  if (liveContainer.prepend) liveContainer.prepend(compact); else liveContainer.append(compact);
  const editor = el('section'); editor.className = 'source-settings-form solver-profile-editor';
  editor.append(el('hr'), el('h3', 'Solver profiles'));
  const simulator = el('p'); simulator.className = 'settings-note'; editor.append(simulator);
  const editorLabel = el('label', 'Saved profile'), editorSelect = el('select'); editorSelect.setAttribute('aria-label', 'Edit solver profile'); editorLabel.append(editorSelect); editor.append(editorLabel);
  const fields = {};
  for (const [name, title, placeholder] of [['name', 'Profile name', 'e.g. Current main'], ['mpc_root', 'Solver tiago_mpc checkout', 'Absolute checkout path'], ['python', 'Solver Python override', 'Selected checkout environment'], ['cache', 'Solver binary cache override', 'Selected checkout/.cache/gato']]) {
    const row = el('label', title), input = el('input'); input.type = 'text'; input.name = `profile_${name}`; input.spellcheck = false; input.placeholder = placeholder;
    input.addEventListener('input', () => { editorDirty = true; controls(); }); row.append(input); editor.append(row); fields[name] = input;
  }
  const actions = el('div'); actions.className = 'source-actions';
  const save = button('Save profile', saveProfile), activateButton = button('Use this solver', () => activate(editorId)); actions.append(save, activateButton); editor.append(actions);
  const note = el('p'); note.className = 'settings-note'; note.textContent = 'Switching pauses calculation and uses the displayed native robot state. The simulator, replay library and page stay open. Source Apply above restarts the full simulator.'; editor.append(note);
  const feedback = el('p'); feedback.className = 'source-message'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); editor.append(feedback); editorContainer.append(editor);
  let catalog = { profiles: [], active_profile_id: null, switch: { state: 'idle' } }, editorId = null, editorDirty = false, saving = false, switching = false, timer, epoch = 0, settledKey, settling;
  function say(text, error = false) { status.textContent = text; feedback.textContent = text; feedback.dataset.error = String(error); }
  function controls() {
    select.disabled = switching || !catalog.profiles.length;
    editorSelect.disabled = switching || saving; save.disabled = switching || saving;
    activateButton.disabled = switching || saving || !editorId || editorDirty;
  }
  function fillEditor() {
    const profile = catalog.profiles.find(item => item.id === editorId);
    for (const key of Object.keys(fields)) fields[key].value = profile?.[key] || '';
    editorDirty = false;
  }
  function render() {
    select.replaceChildren(...[...(catalog.active_profile_id ? [] : [{ id: '', name: 'No active solver' }]), ...catalog.profiles].map(profile => { const option = el('option', profile.name); option.value = profile.id; return option; }));
    select.value = catalog.active_profile_id || '';
    if (editorId == null) { editorId = catalog.active_profile_id || ''; fillEditor(); }
    editorSelect.replaceChildren(...[{ id: '', name: 'New profile…' }, ...catalog.profiles].map(profile => { const option = el('option', profile.name); option.value = profile.id; return option; })); editorSelect.value = editorId;
    const source = catalog.simulator_source || {};
    simulator.textContent = `Simulator source: ${source.mpc_root || 'unavailable'}${source.python ? ` · ${source.python}` : ''}${source.cache ? ` · cache ${source.cache}` : ''}`;
    const active = catalog.profiles.find(item => item.id === catalog.active_profile_id);
    select.title = active ? `Solver: ${active.mpc_root}${active.python ? ` · ${active.python}` : ''}` : 'Select a prepared solver profile';
    controls();
  }
  async function refresh({ observeSwitch = true } = {}) {
    try { catalog = await request('/api/solver-profiles'); }
    catch (error) { say(`Solver profiles unavailable: ${error.message}`, true); throw error; }
    if (!Array.isArray(catalog.profiles)) throw new Error('Solver profile catalog is unavailable.');
    render();
    if (observeSwitch && catalog.switch?.state === 'switching') {
      if (!switching) { switching = true; beforeActivate(); }
      say('Switching solver · calculation paused…'); controls(); poll();
    } else if (!switching) {
      const active = catalog.profiles.find(profile => profile.id === catalog.active_profile_id);
      say(catalog.switch?.state === 'failed' ? `Solver switch failed: ${catalog.switch.error || 'No solver is active.'}` : active ? `Active solver: ${active.name}` : 'No solver is active. Select a prepared profile.', catalog.switch?.state === 'failed');
    }
    return catalog;
  }
  function poll() {
    unschedule(timer); timer = schedule(async () => {
      try {
        const result = await refresh({ observeSwitch: false });
        if (result.switch?.state === 'switching') poll();
        else await handleEvent({ type: 'solver_profile', state: result.switch?.state === 'failed' ? 'failed' : 'active', profile_id: result.active_profile_id || result.switch?.profile_id, generation: result.generation, error: result.switch?.error });
      } catch (error) { say(`Checking solver switch: ${error.message}`, true); if (switching) poll(); }
    }, 500);
  }
  async function saveProfile() {
    if (saving || switching) return;
    const name = fields.name.value.trim(), mpc_root = fields.mpc_root.value.trim();
    if (!name || !mpc_root) { say('Profile name and solver checkout are required.', true); return; }
    let id = editorId || name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'solver';
    if (!editorId) { const base = id; let suffix = 2; while (catalog.profiles.some(item => item.id === id)) id = `${base}-${suffix++}`; }
    saving = true; controls();
    try {
      catalog = await request('/api/solver-profiles', { profile: { id, name, mpc_root, python: fields.python.value.trim() || null, cache: fields.cache.value.trim() || null } });
      editorId = id; editorDirty = false; render(); fillEditor(); say('Solver profile saved. Select Use this solver to activate it.');
    } catch (error) { say(error.message, true); }
    finally { saving = false; controls(); }
  }
  async function activate(id) {
    if (!id || switching) return;
    switching = true; settledKey = undefined; const attempt = ++epoch; controls();
    try {
      const anchor = await beforeActivate();
      say('Switching solver · calculation paused…');
      await request('/api/solver-profiles/activate', { profile_id: id, ...(anchor ? { anchor } : {}) });
      if (attempt === epoch && switching) poll();
    } catch (error) {
      if (attempt === epoch) await handleEvent({ type: 'solver_profile', state: 'failed', profile_id: id, error: error.message });
    }
  }
  async function handleEvent(item) {
    if (!['active', 'failed'].includes(item.state)) return;
    const key = JSON.stringify([item.state, item.profile_id, item.generation, item.error]);
    if (key === settledKey) return settling;
    settledKey = key; ++epoch; unschedule(timer); switching = true; controls();
    settling = (async () => {
      try {
        await Promise.all([refresh({ observeSwitch: false }), onSettled(item)]);
        say(item.state === 'failed' ? `Solver switch failed: ${item.error || 'No solver is active.'}` : 'Solver ready · simulation paused.', item.state === 'failed');
      } catch (error) { say(`Solver setup: ${error.message}`, true); }
      finally { switching = false; render(); }
    })();
    return settling;
  }
  select.addEventListener('change', () => activate(select.value));
  editorSelect.addEventListener('change', () => { editorId = editorSelect.value; fillEditor(); controls(); });
  controls();
  return { refresh, handleEvent, activate, editor, select, fields, save, activateButton, get snapshot() { return { catalog, switching, editorId }; }, destroy() { unschedule(timer); compact.remove(); editor.remove(); } };
}
