import { createFloatingDialog } from './floating-dialog.js';

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

export function setupSourceSettings({ button, beforeApply = () => {}, reload = () => location.reload(), request = sourceRequest } = {}) {
  const content = document.createElement('div'); content.className = 'source-settings-form';
  content.innerHTML = `<label>tiago_mpc checkout<input name="mpc_root" type="text" spellcheck="false" autocomplete="off" required></label>
    <label>Python interpreter override<input name="python" type="text" spellcheck="false" autocomplete="off" placeholder="Selected checkout environment"></label>
    <label>Binary cache override<input name="cache" type="text" spellcheck="false" autocomplete="off" placeholder="Selected checkout/.cache/gato"></label>
    <p class="source-identity"></p><div class="source-actions"><button type="button" data-action="inspect">Check source and binaries</button><button type="button" class="source-apply" data-action="apply">Apply and restart backend</button></div>
    <hr><label>Additional knot counts N<input name="counts" type="text" inputmode="numeric" placeholder="e.g. 48 96"></label>
    <label class="source-rebuild"><input name="rebuild" type="checkbox">Rebuild selected counts even when already compatible</label>
    <div class="source-actions"><button type="button" data-action="build">Build selected N</button></div>
    <p>Compilation uses half the available CPU cores and keeps Live running. Normal setting changes never compile. Apply starts a fresh Live session; saved replays and disk history remain.</p>
    <p class="source-message" role="status" aria-live="polite"></p><pre class="source-build-log" hidden></pre>`;
  const dialog = createFloatingDialog({ id: 'source-build-settings', title: 'Source / Build settings', content });
  const field = name => content.querySelector(`[name="${name}"]`);
  const action = name => content.querySelector(`[data-action="${name}"]`);
  const message = content.querySelector('.source-message'), identity = content.querySelector('.source-identity'), log = content.querySelector('.source-build-log');
  let initialized = false, busy = false, buildRunning = false, restarting = false, timer;
  const selection = () => ({ mpc_root: field('mpc_root').value.trim(), python: field('python').value.trim() || null, cache: field('cache').value.trim() || null });
  function say(text, error = false) { message.textContent = text; message.dataset.error = String(error); }
  function controls() {
    action('inspect').disabled = busy || restarting;
    action('apply').disabled = busy || buildRunning || restarting;
    action('build').disabled = busy || buildRunning || restarting;
  }
  function describe(result) {
    const source = result.source || {}, resolved = result.selection || {};
    identity.textContent = `${source.mpc_branch || 'Detached / unknown branch'} · ${source.mpc_commit || 'Unknown commit'}${source.mpc_dirty ? ' · modified checkout' : ''}\nPython: ${resolved.python || result.python || 'Unknown'}\nCache: ${resolved.cache || result.cache || 'Unknown'}\nCompatible N: ${(result.available_N || []).join(', ') || 'none'}`;
    if (!result.compatible) say(result.error || (result.errors || []).join('; ') || 'Selected source is incompatible.', true);
    else say(result.available_N?.length ? 'Source checked. Apply reloads the model and compatible binaries.' : 'Source checked. No compatible binaries found; build selected N explicitly.');
  }
  async function refresh() {
    try {
      const result = await request('/api/source');
      if (!initialized) {
        const selected = result.current?.selection || {};
        field('mpc_root').value = selected.mpc_root || result.current?.source?.mpc_root || '';
        // Show the effective paths so an existing explicit cache/environment
        // override survives Apply. Changing checkout clears project defaults.
        field('python').value = selected.python || '';
        field('cache').value = selected.cache || '';
        describe(result.current || {}); initialized = true;
      }
      const build = result.build;
      buildRunning = build?.state === 'running';
      if (build) {
        log.hidden = false; log.textContent = build.log || build.error || 'Preparing build…'; log.scrollTop = log.scrollHeight;
        say(buildRunning ? `Building N=${build.N.join(', ')}. Live remains available.` : build.state === 'complete' ? 'Build complete. Apply to reload the available knot counts.' : `Build failed: ${build.error || `exit ${build.returncode}`}. See the retained build log.`, build.state === 'failed');
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
  action('inspect').addEventListener('click', () => run(async () => { say('Checking selected environment and binary identities…'); describe(await request('/api/source/inspect', selection())); }));
  action('build').addEventListener('click', () => run(async () => {
    const counts = parseBuildCounts(field('counts').value);
    await request('/api/source/build', { selection: selection(), N: counts, rebuild: field('rebuild').checked });
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
  let priorRoot;
  field('mpc_root').addEventListener('focus', () => { priorRoot = field('mpc_root').value.trim(); });
  field('mpc_root').addEventListener('change', () => {
    if (priorRoot && field('mpc_root').value.trim() !== priorRoot) {
      if ([`${priorRoot}/venv-host/bin/python`, `${priorRoot}/.venv/bin/python`].includes(field('python').value)) field('python').value = '';
      if (field('cache').value === `${priorRoot}/.cache/gato`) field('cache').value = '';
    }
  });
  button?.addEventListener('click', () => { dialog.open(); clearTimeout(timer); refresh(); });
  return { dialog, refresh, get selection() { return selection(); } };
}
