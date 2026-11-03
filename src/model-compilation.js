import { sourceRequest } from './source-settings.js';

const copy = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const environment = selection => [selection?.mpc_root, selection?.python, selection?.effective_cache || selection?.cache || null];

// This is a check dependency list, not a binary/cache key. Explicit runtime
// annotations allow readiness reuse; unknown predictor fields stay conservative.
// The native lookup still decides compatibility for every model combination.
export function modelCheckInputs(request, schema) {
  function withoutRuntime(values, parameters) {
    const result = copy(values || {});
    for (const parameter of parameters || []) {
      if (parameter.effect !== 'runtime') continue;
      const path = parameter.path.replace(/^config\./, '').split('.'), last = path.pop();
      const parent = path.reduce((value, key) => value?.[key], result);
      if (parent && typeof parent === 'object') delete parent[last];
    }
    return result;
  }
  return { params: withoutRuntime(request.params, schema.parameters),
    predictor: withoutRuntime(request.source_settings, schema.source_settings?.predictor?.parameters),
    module: request.source_settings_module ?? null };
}

export function createModelCompilation({ getDraft, onState = () => {}, onReady = () => {}, request = sourceRequest,
  schedule = setTimeout, unschedule = clearTimeout, intervalMs = 1000 }) {
  let state = { phase: 'idle' }, revision = 0, checking, build, timer, disposed = false;
  const completed = new Set();
  const current = () => { try { return copy(getDraft()); } catch { return null; } };
  const model = draft => draft && { scope: draft.scope, inputs: draft.modelInputs ?? draft.request };
  const sameModel = (a, b) => same(model(a), model(b));
  const matching = draft => !disposed && sameModel(draft, current());
  const sameScope = draft => !disposed && same(draft?.scope, current()?.scope);
  function publish(next = {}) { state = { ...state, ...next, build: build ? copy(build) : null }; onState(copy(state)); }
  function invalidate() {
    if (state.draft && matching(state.draft) && ['ready', 'missing', 'checking'].includes(state.phase)) return;
    ++revision; checking = null; publish({ phase: 'checking', draft: null, probe: null, error: null });
  }
  async function check({ force = false } = {}) {
    const draft = current();
    if (!draft) { publish({ phase: 'invalid', draft: null, probe: null, error: 'Complete the settings to check the model.' }); return null; }
    if (!force && sameModel(state.draft, draft) && ['ready', 'missing'].includes(state.phase)) return state.probe;
    if (!force && checking && sameModel(checking.draft, draft)) return checking.promise;
    const attempt = ++revision;
    publish({ phase: 'checking', draft, probe: null, error: null });
    const promise = (async () => {
      try {
        const probe = await request('/api/source/model', draft.request);
        if (attempt !== revision || !matching(draft)) return null;
        if (!probe.compatible || !probe.compilation) throw new Error(probe.error || 'The requested model could not be checked.');
        if (probe.selection && !same(environment(probe.selection), environment(draft.scope.selection))) {
          throw new Error('The solver environment or cache changed. Reapply the solver profile before compiling.');
        }
        publish({ phase: probe.compilation.ready ? 'ready' : 'missing', draft: current(), probe, error: null });
        return probe;
      } catch (error) {
        if (attempt === revision && matching(draft)) publish({ phase: 'failed', draft, probe: null, error: error.message });
        return null;
      } finally { if (checking?.attempt === attempt) checking = null; }
    })();
    checking = { attempt, draft, promise };
    return promise;
  }
  async function afterBuild(job, draft) {
    if (disposed || !sameScope(draft)) return;
    if (job.selection && !same(environment(job.selection), environment(draft.scope.selection))) return;
    const probe = await check({ force: true });
    if (probe?.compilation.ready && sameScope(draft)) await onReady();
    else if (job.state === 'failed' && sameScope(draft)) publish({ error: job.error || `Compilation failed${job.returncode == null ? '' : ` (exit ${job.returncode})`}. See the build log.`, lastBuild: job });
  }
  function pollLater() { unschedule(timer); timer = schedule(poll, intervalMs); }
  async function poll() {
    if (!build || disposed) return;
    const pending = build;
    try {
      const result = await request('/api/source'), job = result.build;
      if (disposed || build !== pending) return;
      if (!job || job.id !== pending.job?.id) throw new Error('The build status changed. Check the current model again.');
      build = { ...pending, job }; publish();
      if (job.state === 'running') { pollLater(); return; }
      if (completed.has(job.id)) { build = null; publish({ lastBuild: job }); return; }
      build = null; completed.add(job.id); publish({ lastBuild: job });
      await afterBuild(job, pending.draft);
    } catch (error) {
      if (!disposed && build === pending) { build = null; publish({ error: error.message, phase: 'failed' }); }
    }
  }
  async function compile() {
    if (disposed || build) return false;
    const probe = await check({ force: true });
    if (!probe || !matching(state.draft)) return false;
    if (probe.compilation.ready) { await onReady(); return true; }
    const draft = current(), pending = { draft, job: { state: 'running', N: [draft.request.params.N], log: 'Starting compilation…' } };
    build = pending; publish({ error: null, lastBuild: null });
    try {
      const job = await request('/api/source/build', { ...draft.request, N: [draft.request.params.N] });
      if (disposed) return false;
      build = { ...pending, job }; publish(); pollLater(); return true;
    } catch (error) { if (!disposed) { build = null; publish({ phase: 'failed', error: error.message }); } return false; }
  }
  async function builtExternally(job) {
    const draft = current();
    if (disposed || !draft || !job?.live_refreshed || job.state !== 'complete' || completed.has(job.id) ||
        !same(environment(job.selection), environment(draft.scope.selection)) ||
        !same(job.source_settings_module ?? null, draft.request.source_settings_module)) return false;
    completed.add(job.id); await afterBuild(job, draft); return true;
  }
  return { check, compile, invalidate, builtExternally, poll,
    get snapshot() { return copy(state); },
    dispose() { disposed = true; ++revision; unschedule(timer); checking = null; },
  };
}

export function createModelCompilePrompt({ container, onCompile }) {
  const doc = container.ownerDocument || document;
  const root = doc.createElement('section'); root.className = 'model-compile-prompt'; root.hidden = true;
  root.setAttribute('aria-label', 'Predictor model compilation');
  const text = doc.createElement('div'), title = doc.createElement('strong'), message = doc.createElement('p');
  title.setAttribute('role', 'status'); text.append(title, message);
  const action = doc.createElement('button'); action.type = 'button'; action.textContent = 'Compile'; action.addEventListener('click', onCompile);
  const details = doc.createElement('details'), summary = doc.createElement('summary'), log = doc.createElement('pre');
  summary.textContent = 'Build log'; details.append(summary, log); root.append(text, action, details); container.append(root);
  return {
    update(state, { visible = true } = {}) {
      const running = state.build?.job?.state === 'running';
      root.hidden = !visible || (!running && ['idle', 'ready', 'checking', 'invalid'].includes(state.phase) && !state.error);
      root.dataset.state = state.error ? 'failed' : running ? 'building' : state.phase;
      const n = state.draft?.request.params.N;
      title.textContent = running ? `Compiling N=${state.build.job.N.join(', ')}…` : state.error ? 'Model needs attention' : state.phase === 'checking' ? 'Checking model…' : `N=${n ?? '—'} model is not compiled`;
      message.textContent = state.error || (running ? 'Your draft stays editable. The active model is unchanged until a matching model is ready.' : state.phase === 'checking' ? 'Checking the selected interpreter and cache.' : 'Compile this predictor combination to use it. Cached modules are reused.');
      action.textContent = state.error ? 'Check / compile' : 'Compile'; action.disabled = running || ['checking', 'invalid'].includes(state.phase);
      const job = state.build?.job || state.lastBuild;
      details.hidden = !job; log.textContent = job?.log || job?.error || ''; log.title = job?.log_path || '';
    },
    get element() { return root; },
    dispose() { action.removeEventListener('click', onCompile); root.remove?.(); },
  };
}
