import { createFloatingDialog } from './floating-dialog.js';
import { createSettingResets } from './setting-resets.js';

export function parseBuildCounts(value) {
  const parts = value.trim().split(/[\s,]+/).filter(Boolean);
  if (!parts.length || parts.some(item => !/^\d+$/.test(item) || Number(item) < 2 || Number(item) > 4096)) {
    throw new Error('Choose integer knot counts between 2 and 4096, separated by spaces or commas.');
  }
  return [...new Set(parts.map(Number))].sort((a, b) => a - b);
}

export async function sourceRequest(path, body, fetcher = fetch) {
  const response = await fetcher(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Source settings request failed.');
  return result;
}

/**
 * Interpreter and cache fields hold path templates; `<checkout>` stands for the
 * selected checkout. Saved templates stay valid when the checkout changes, so
 * only a field still holding the default text follows the default (the default
 * interpreter can differ between checkouts). An edited template stays as a
 * visible override until its reset arrow restores the default; a template
 * equal to the default is sent as null. The tooltip shows the resolved path and
 * an unresolvable template is marked invalid with the reason as its tooltip.
 */
export function trackCheckoutDefaults({ fields, resets, request = sourceRequest, group = 'checkout-defaults', label = '', delay = 250, schedule = setTimeout, unschedule = clearTimeout }) {
  const defaults = { python: null, cache: null };
  let token = 0, root = '', timer;
  const names = { python: `${label}Python interpreter`, cache: `${label}binary cache` };
  const value = key => { const text = fields[key].value.trim(); return text && text !== defaults[key] ? text : null; };
  for (const key of Object.keys(defaults)) {
    resets.bind({ key: `${group}.${key}`, name: names[key], input: fields[key], host: fields[key], group,
      getValue: () => fields[key].value.trim(), getDefault: () => defaults[key] ?? fields[key].value.trim(),
      reset: text => { fields[key].value = text; fields[key].dispatchEvent?.(new Event('input', { bubbles: true })); } });
  }
  function apply(next) {
    for (const key of Object.keys(defaults)) {
      const text = fields[key].value.trim();
      if (!text || text === defaults[key]) fields[key].value = next?.[key] || '';
      defaults[key] = next?.[key] || null;
      const entered = next?.entered?.[key];
      fields[key].title = entered?.error || entered?.path || next?.resolved?.[key] || '';
      fields[key].dataset.invalid = String(Boolean(entered?.error));
      const reset = resets.entries.find(entry => entry.key === `${group}.${key}`)?.button;
      if (reset) reset.title = defaults[key] ? `Reset to ${defaults[key]}` : 'Reset to the checkout default';
    }
    resets.update();
  }
  /** Load defaults and the resolution of the edited templates; stale answers are ignored. */
  async function follow(path) {
    root = path;
    const attempt = ++token;
    if (!root) { apply(null); return; }
    let next = null;
    try { next = await request('/api/source/defaults', { mpc_root: root, python: value('python'), cache: value('cache') }); } catch { next = null; }
    if (attempt === token) apply(next);
  }
  for (const key of Object.keys(defaults)) {
    fields[key].addEventListener?.('input', () => { unschedule(timer); timer = schedule(() => follow(root), delay); });
  }
  return { defaults, apply, follow, value };
}

const textField = (name, title, attrs = '') => `<div class="dialog-field"><label for="source-${name}">${title}</label><input id="source-${name}" name="${name}" type="text" spellcheck="false" autocomplete="off" ${attrs}></div>`;

export function setupSourceSettings({ button, beforeApply = () => {}, reload = () => location.reload(), onPlottersReload = () => {}, onOpen = () => {}, request = sourceRequest, storage = globalThis.localStorage } = {}) {
  const content = document.createElement('div'); content.className = 'source-settings-form';
  content.innerHTML = `<section class="dialog-section"><h3>Simulator source</h3>
    ${textField('mpc_root', 'tiago_mpc checkout', 'required')}
    ${textField('python', 'Python interpreter')}
    ${textField('cache', 'Binary cache')}
    <dl class="source-identity"></dl>
    <div class="source-actions"><button type="button" data-action="inspect" title="Check the environment and binary identities; never compiles">Check source</button><button type="button" class="source-apply" data-action="apply" title="Restart the backend with this source. Starts a fresh Live session; saved replays and disk history remain.">Apply and restart backend</button></div></section>
    <div class="solver-profile-slot"></div>
    <section class="dialog-section"><h3>Binaries</h3>
    <div class="dialog-field" title="Knot counts the visualizer offers: 8, 16, 24, 32, 48, 64, 96, 128"><label for="source-counts">Knot counts N</label><input id="source-counts" name="counts" type="text" inputmode="numeric" placeholder="e.g. 48 96"></div>
    <label class="source-rebuild" title="Off builds loss-free predictors. On builds predictors with the URDF Coulomb + viscous friction (tanh width 0.03 rad/s, compiled in)."><input name="prediction_friction" type="checkbox">Predictor friction modules</label>
    <label class="source-rebuild" title="Rebuild selected counts even when already compiled; the old module file is replaced"><input name="rebuild" type="checkbox">Rebuild compiled counts</label>
    <div class="source-actions"><button type="button" data-action="build" title="Compiles with half the CPU cores and keeps Live running. Normal setting changes never compile.">Build selected N</button></div>
    <pre class="source-build-log" hidden></pre></section>
    <section class="dialog-section"><h3>Plotting</h3>
    <div class="dialog-field" title="Bundled plots are always available. Reload saves this directory and reloads Python plotters without restarting MPC."><label for="source-plotters">Python plotting directory</label><input id="source-plotters" name="plotters" type="text" spellcheck="false" autocomplete="off"></div>
    <div class="source-actions"><button type="button" data-action="plotters">Reload plotters</button></div></section>
    <p class="source-message" role="status" aria-live="polite"></p>`;
  const dialog = createFloatingDialog({ id: 'source-build-settings', title: 'Settings', content: null, storage,
    tabs: [{ id: 'backend', label: 'Backend', title: 'Source, solver, binaries and plotting: computation and backend processes' }, { id: 'ui', label: 'UI', title: 'Presentation and display preferences' }] });
  const backend = dialog.panels.backend || dialog.body, ui = dialog.panels.ui || dialog.body;
  backend.append(content);
  const field = name => content.querySelector(`[name="${name}"]`);
  const action = name => content.querySelector(`[data-action="${name}"]`);
  const message = content.querySelector('.source-message'), identity = content.querySelector('.source-identity'), log = content.querySelector('.source-build-log');
  const resets = createSettingResets({ document });
  const checkout = trackCheckoutDefaults({ fields: { python: field('python'), cache: field('cache') }, resets, request, group: 'source' });
  let plottersInitialized = false, plottersDefault = null;
  resets.bind({ key: 'source.plotters', name: 'Python plotting directory', input: field('plotters'), host: field('plotters'), group: 'source',
    getValue: () => field('plotters').value.trim(), getDefault: () => plottersDefault ?? field('plotters').value.trim(), reset: value => { field('plotters').value = value; } });
  let initialized = false, busy = false, buildRunning = false, restarting = false, timer;
  const selection = () => ({ mpc_root: field('mpc_root').value.trim(), python: checkout.value('python'), cache: checkout.value('cache') });
  function say(text, error = false) { message.textContent = text; message.dataset.error = String(error); }
  function controls() {
    action('inspect').disabled = busy || restarting;
    action('plotters').disabled = busy || restarting;
    action('apply').disabled = busy || buildRunning || restarting;
    action('build').disabled = busy || buildRunning || restarting;
  }
  function describe(result) {
    const source = result.source || {};
    const rows = [['Revision', `${source.mpc_branch || 'detached'} · ${source.mpc_commit || 'unknown'}${source.mpc_dirty ? ' · modified' : ''}`], ['Compiled N', ['off', 'on'].map(mode => `${mode === 'on' ? 'friction' : 'loss-free'}: ${(result.available_N_by_friction?.[mode] || []).join(', ') || 'none'}`).join(' · ')]];
    identity.replaceChildren?.(...rows.flatMap(([term, value]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = term; dd.textContent = value; return [dt, dd]; }));
    identity.dataset.compatible = String(Boolean(result.compatible));
    if (!result.compatible) say(result.error || (result.errors || []).join('; ') || 'Selected source is incompatible.', true);
    else say(result.available_N?.length ? '' : 'Nothing compiled yet; build selected N explicitly.');
  }
  async function refresh() {
    if (!initialized) field('mpc_root').placeholder = 'Checking selected source…';
    try {
      const result = await request('/api/source');
      if (!initialized) {
        const selected = result.current?.selection || {};
        field('mpc_root').value = selected.mpc_root || result.current?.source?.mpc_root || '';
        // Show the effective templates so an existing explicit cache/environment
        // override survives Apply; checkout defaults decide what counts as one.
        field('python').value = selected.templates?.python || selected.python || '';
        field('cache').value = selected.templates?.cache || selected.cache || '';
        await checkout.follow(field('mpc_root').value.trim());
        describe(result.current || {}); initialized = true; field('mpc_root').placeholder = '';
      }
      if (!plottersInitialized) {
        const plots = await request('/api/plots/settings');
        plottersDefault = plots.default_directory || null;
        field('plotters').value = plots.override || plots.directory || plottersDefault || '';
        const reset = resets.entries.find(entry => entry.key === 'source.plotters')?.button;
        if (reset && plottersDefault) reset.title = `Reset to ${plottersDefault} (follows the applied checkout)`;
        resets.update(); plottersInitialized = true;
      }
      const build = result.build;
      buildRunning = build?.state === 'running';
      if (build) {
        log.hidden = false; log.textContent = build.log || build.error || 'Preparing build…'; log.scrollTop = log.scrollHeight;
        say(buildRunning ? `Building N=${build.N.join(', ')}. Live remains available.` : build.state === 'complete' ? build.live_refreshed ? 'Build complete. Live lists the new knot counts.' : 'Build complete. Apply to reload the available knot counts.' : `Build failed: ${build.error || `exit ${build.returncode}`}. See the retained build log.`, build.state === 'failed');
        log.title = build.log_path;
      }
      controls();
      if (buildRunning) timer = setTimeout(refresh, 1000);
    } catch (error) { say(error.message, true); }
  }
  async function run(callback) {
    busy = true; controls();
    try { await callback(); } catch (error) { say(error.message, true); }
    finally { busy = false; controls(); }
  }
  action('plotters').addEventListener('click', () => run(async () => {
    const directory = field('plotters').value.trim();
    await request('/api/plots/settings', { directory: directory && directory !== plottersDefault ? directory : null });
    const result = await request('/api/plots/reload', {});
    say(result.errors?.length ? `Plotters reloaded with errors: ${result.errors.join('; ')}` : 'Plotters reloaded.');
    onPlottersReload();
  }));
  action('inspect').addEventListener('click', () => run(async () => { say('Checking selected environment and binary identities…'); describe(await request('/api/source/inspect', selection())); if (!message.textContent) say('Source checked.'); }));
  action('build').addEventListener('click', () => run(async () => {
    const counts = parseBuildCounts(field('counts').value);
    await request('/api/source/build', { selection: selection(), N: counts, rebuild: field('rebuild').checked, prediction_friction: field('prediction_friction').checked });
    clearTimeout(timer); await refresh();
  }));
  action('apply').addEventListener('click', () => run(async () => {
    const old = await request('/api/health');
    await request('/api/source/apply', selection());
    beforeApply(); restarting = true; say('Restarting backend and reloading the robot model…'); controls();
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 750));
      try {
        const health = await request('/api/health');
        if (health.backend_id !== old.backend_id) { reload(); return; }
      } catch { /* The listening socket closes briefly during exec. */ }
    }
    restarting = false; throw new Error('Backend has not returned yet; it may be waiting for an active solve or GPU timing window. Check its terminal output, then reload this page.');
  }));
  field('mpc_root').addEventListener('change', () => checkout.follow(field('mpc_root').value.trim()));
  button?.addEventListener('click', () => { dialog.open(); clearTimeout(timer); refresh(); onOpen(); });
  return { dialog, refresh, panels: { backend, ui, solverProfiles: content.querySelector('.solver-profile-slot') || backend }, get selection() { return selection(); } };
}
