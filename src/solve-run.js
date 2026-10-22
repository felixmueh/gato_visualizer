import { sourceRequest } from './source-settings.js';

/** One bounded fresh inspection. This never sends ordinary Live commands. */
export function setupSolveRun({ container, onStart = () => {}, onComplete = () => {}, request = sourceRequest, schedule = setTimeout, unschedule = clearTimeout, now = Date.now } = {}) {
  const doc = container.ownerDocument;
  const el = (tag, text, cls) => { const item = doc.createElement(tag); if (text != null) item.textContent = text; if (cls) item.className = cls; return item; };
  const controls = el('div', null, 'solve-run-controls');
  const capLabel = el('label', 'SQP cap'), cap = el('input'); cap.type = 'number'; cap.min = '1'; cap.max = '10000'; cap.step = '1'; cap.value = '20'; cap.setAttribute('aria-label', 'Run again SQP iteration cap'); capLabel.append(cap);
  const budgetLabel = el('label', 'Wall budget (s)'), budget = el('input'); budget.type = 'number'; budget.min = '0'; budget.step = 'any'; budget.placeholder = 'Optional'; budget.setAttribute('aria-label', 'Optional inspection wall budget in seconds'); budgetLabel.append(budget);
  const run = el('button', 'Run again'), stop = el('button', 'Stop'); run.type = stop.type = 'button'; run.setAttribute('aria-label', 'Run a fresh solve from the captured state');
  stop.title = 'Cancel a queued inspection or terminate its isolated worker. No partial trace is retained.'; stop.setAttribute('aria-label', stop.title);
  controls.append(capLabel, budgetLabel, run, stop);
  // Why Run again is unavailable, and what it does, live in its tooltip. The
  // buttons show progress; the status line holds only failures and a stop.
  const status = el('p', '', 'plot-message'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  container.append(controls, status);
  let reason = '';
  let context, contextKey, capability, capabilityToken = 0, capabilityTimer, lastCapability = -Infinity, job, jobToken = 0, jobTimer, active = false, stopping = false, stopRequested = false, destroyed = false, adopt = true;
  const capabilities = new Map();
  const paint = () => {
    run.disabled = active || !capability?.available;
    stop.disabled = !active || stopping;
    run.textContent = active ? (job?.state === 'running' ? 'Running…' : 'Queued…') : 'Run again';
    stop.textContent = stopping ? 'Stopping…' : 'Stop';
    run.title = active ? (job?.state === 'running' ? 'Fresh inspection running · collecting recorded SQP snapshots' : 'Inspection queued · waiting for the single compute slot') : capability?.available ? 'Fresh solve from the captured state and reference with a cold optimizer start, not a continuation of the recorded solve. Live calculation pauses while it runs; the original solve, Episode and plant stay unchanged.' : reason;
    cap.disabled = budget.disabled = active;
  };
  function update(next) {
    const key = JSON.stringify(next || null);
    context = next;
    if (key === contextKey) return;
    contextKey = key; ++capabilityToken; unschedule(capabilityTimer); capability = null;
    if (!active && !stopping) status.textContent = '';
    if (!next?.source || !next.selection || !next.profile_id || next.switching) {
      reason = next?.switching ? 'Run again unavailable while the solver profile is switching.' : !next?.profile_id ? 'Run again needs an active solver profile.' : 'Select a recorded solve with captured inputs.';
      paint(); return;
    }
    if (capabilities.has(key)) { capability = capabilities.get(key); showCapability(); return; }
    reason = 'Checking captured solve inputs…'; paint();
    const token = capabilityToken, delay = Math.max(0, 300 - (now() - lastCapability));
    if (delay) capabilityTimer = schedule(() => checkCapability(token, key, structuredClone(next)), delay);
    else checkCapability(token, key, structuredClone(next));
  }
  function showCapability() {
    reason = capability.available ? '' : capability.reason || 'Captured inputs are unavailable for a fresh inspection.';
    paint();
  }
  async function checkCapability(token, key, value) {
    lastCapability = now();
    try {
      const result = await request('/api/solve-inspections/capability', { source: value.source, selection: value.selection, profile_id: value.profile_id });
      if (destroyed || token !== capabilityToken) return;
      capability = result; capabilities.set(key, result); showCapability();
    } catch (error) { if (!destroyed && token === capabilityToken) { capability = { available: false, reason: error.message }; showCapability(); } }
  }
  async function start() {
    if (destroyed || active || !capability?.available) return;
    const sqp_iters = Number(cap.value), budget_s = budget.value.trim() ? Number(budget.value) : undefined;
    if (!Number.isInteger(sqp_iters) || sqp_iters < 1 || sqp_iters > 10000 || budget_s != null && (!Number.isFinite(budget_s) || budget_s <= 0)) {
      status.textContent = 'Choose an integer SQP cap from 1 to 10000 and a positive optional wall budget.'; return;
    }
    const body = { source: structuredClone(context.source), selection: structuredClone(context.selection), profile_id: context.profile_id, sqp_iters, ...(budget_s != null ? { budget_s } : {}) };
    const token = ++jobToken; active = true; stopping = false; stopRequested = false; adopt = true; job = null;
    status.textContent = ''; paint(); onStart();
    try { const result = await request('/api/solve-inspections', body); if (!destroyed && token === jobToken) acceptJob(result, token); }
    catch (error) { if (!destroyed && token === jobToken) { active = false; status.textContent = `Inspection failed: ${error.message}`; paint(); } }
  }
  function acceptJob(result, token) {
    job = result; const state = result.state;
    active = ['pending', 'running'].includes(state);
    stopping = false;
    // A completed inspection shows itself in the Solve inspector.
    status.textContent = ['pending', 'running', 'completed'].includes(state) ? '' : state === 'cancelled' ? 'Stopped · no partial trace retained.' : `Inspection ${state || 'failed'}: ${result.error || result.reason || 'No result is available.'}`;
    paint();
    if (state === 'completed' && result.source?.kind === 'inspection') { if (adopt) onComplete(result); }
    else if (active && stopRequested) stopJob();
    else if (active) jobTimer = schedule(() => poll(token), 200);
  }
  async function poll(token) {
    if (destroyed || token !== jobToken || !job) return;
    try {
      const result = await request(`/api/solve-inspections/jobs/${encodeURIComponent(job.job_id || job.id)}`);
      if (!destroyed && token === jobToken) acceptJob(result, token);
    } catch (error) { if (!destroyed && token === jobToken) { status.textContent = `Inspection status unavailable: ${error.message}. Retrying; Stop remains available.`; paint(); jobTimer = schedule(() => poll(token), 500); } }
  }
  async function stopJob() {
    if (!active || stopping) return;
    // The POST may still be acknowledging a queued job. Keep Stop available
    // once its id exists rather than inventing a cancellation target.
    if (!job) { stopRequested = true; stopping = true; paint(); return; }
    const token = ++jobToken; unschedule(jobTimer); stopping = true; paint();
    try { const result = await request(`/api/solve-inspections/jobs/${encodeURIComponent(job.job_id || job.id)}/stop`, {}); if (!destroyed && token === jobToken) acceptJob(result, token); }
    catch (error) { if (!destroyed && token === jobToken) { stopping = false; status.textContent = `Stop failed: ${error.message}`; paint(); jobTimer = schedule(() => poll(token), 200); } }
  }
  run.addEventListener('click', start); stop.addEventListener('click', stopJob); paint();
  return { update, run, stop, cap, budget, status, get reason() { return reason; }, invalidateAdoption() { adopt = false; }, refresh() { capabilities.clear(); contextKey = undefined; update(context); }, get snapshot() { return { capability, job, active, stopping }; }, destroy() { destroyed = true; ++capabilityToken; ++jobToken; unschedule(capabilityTimer); unschedule(jobTimer); } };
}
