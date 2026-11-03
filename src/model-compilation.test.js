import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createModelCompilation, createModelCompilePrompt, modelCheckInputs } from './model-compilation.js';

const clone = value => JSON.parse(JSON.stringify(value));
function harness() {
  let draft = { scope: { profile: 'one', epoch: 0, selection: { mpc_root: '/one', python: '/one/python', cache: null, effective_cache: '/cache/one' } },
    request: { selection: { mpc_root: '/one', python: '/one/python', cache: null }, params: { N: 32, solver: { cost: 4 } },
      source_settings: { armature_on: true }, source_settings_module: { path: '/one/adapter.py', sha256: 'one' } } };
  const calls = [], applied = [], compiled = new Set(), timers = [];
  const key = body => `${body.params.N}:${body.source_settings.armature_on}`;
  let job, modelHandler;
  const request = async (url, body) => {
    calls.push({ url, body: body && clone(body) });
    if (url === '/api/source/model') {
      if (modelHandler) return modelHandler(body);
      const available = [16, 32, 64].filter(N => compiled.has(`${N}:${body.source_settings.armature_on}`));
      return { compatible: true, compilation: { ready: compiled.has(key(body)), N: body.params.N,
        supported_N: [16, 32, 64], available_N: available, binary_path: compiled.has(key(body)) ? '/actual/native.so' : null } };
    }
    if (url === '/api/source/build') { job = { id: 'build-1', state: 'running', N: body.N, log: 'Compiling…', ...clone(body),
      selection: { ...body.selection, effective_cache: draft.scope.selection.effective_cache } }; return clone(job); }
    if (url === '/api/source') return { build: clone(job) };
    throw new Error(url);
  };
  const schema = { parameters: [{ path: 'solver.cost', effect: 'runtime' }],
    source_settings: { predictor: { parameters: [{ path: 'runtime_gain', effect: 'runtime' }] } } };
  const controller = createModelCompilation({ getDraft: () => ({ ...draft, modelInputs: modelCheckInputs(draft.request, schema) }), request,
    onReady: () => applied.push(clone(draft)), schedule: fn => { timers.push(fn); return fn; }, unschedule() {} });
  return { controller, calls, applied, compiled, timers,
    get draft() { return draft; }, set draft(next) { draft = next; },
    get job() { return clone(job); },
    setModelHandler(next) { modelHandler = next; },
    finish(state = 'complete') { job = { ...job, state, error: state === 'failed' ? 'Compiler exited' : undefined, log: 'Retained compiler output' }; },
  };
}

test('missing draft checks never compile; explicit Compile freezes the exact native request and pin', async () => {
  const h = harness();
  assert.equal((await h.controller.check()).compilation.ready, false);
  assert.equal(h.controller.snapshot.phase, 'missing'); assert.equal(h.calls.length, 1);
  const frozen = clone(h.draft.request);
  assert.equal(await h.controller.compile(), true);
  const build = h.calls.find(call => call.url === '/api/source/build').body;
  assert.deepEqual(build, { ...frozen, N: [32] });
  h.draft.request.params.solver.cost = 7;
  assert.equal(build.params.solver.cost, 4); assert.equal(h.applied.length, 0);
  h.controller.dispose();
});

test('cached model is applied without invoking Build', async () => {
  const h = harness(); h.compiled.add('32:true');
  await h.controller.compile();
  assert.equal(h.applied.length, 1);
  assert.equal(h.calls.some(call => call.url === '/api/source/build'), false);
  h.controller.dispose();
});

test('annotated runtime edits reuse readiness without a lookup or checking state', async () => {
  const h = harness(); h.compiled.add('32:true'); await h.controller.check();
  const calls = h.calls.length;
  h.draft.request.params.solver.cost = 9; h.controller.invalidate();
  assert.equal(h.controller.snapshot.phase, 'ready');
  assert.equal((await h.controller.check()).compilation.ready, true);
  assert.equal(h.calls.length, calls);
  h.controller.dispose();
});

test('runtime edits during a slow lookup share its result and preserve the current values', async () => {
  const h = harness(); let release;
  h.setModelHandler(() => new Promise(resolve => { release = resolve; }));
  const first = h.controller.check();
  h.draft.request.params.solver.cost = 11; h.controller.invalidate();
  const second = h.controller.check();
  assert.equal(h.calls.length, 1);
  release({ compatible: true, compilation: { ready: true, N: 32, available_N: [32] } });
  assert.equal((await first).compilation.ready, true);
  assert.equal((await second).compilation.ready, true);
  assert.equal(h.controller.snapshot.phase, 'ready');
  assert.equal(h.controller.snapshot.draft.request.params.solver.cost, 11);
  h.controller.dispose();
});

test('unknown predictor settings and compiled fields still invalidate native readiness', async () => {
  const h = harness(); h.compiled.add('32:true'); await h.controller.check();
  h.draft.request.params.unknown_future_feature = true; h.controller.invalidate();
  assert.equal(h.controller.snapshot.phase, 'checking'); await h.controller.check();
  assert.equal(h.calls.length, 2);
  h.draft.request.source_settings.armature_on = false; h.controller.invalidate();
  assert.equal((await h.controller.check()).compilation.ready, false);
  assert.equal(h.controller.snapshot.phase, 'missing');
  h.controller.dispose();
});

test('Compile freezes the latest runtime values even if they change during its precheck', async () => {
  const h = harness(); let release;
  h.setModelHandler(() => new Promise(resolve => { release = resolve; }));
  const compiling = h.controller.compile();
  h.draft.request.params.solver.cost = 13; h.controller.invalidate();
  release({ compatible: true, compilation: { ready: false, N: 32, available_N: [] } });
  assert.equal(await compiling, true);
  assert.equal(h.calls.find(call => call.url === '/api/source/build').body.params.solver.cost, 13);
  h.controller.dispose();
});

test('a lookup started before a draft/profile/environment change cannot mark the new model ready', async () => {
  const h = harness(); let release;
  h.setModelHandler(() => new Promise(resolve => { release = resolve; }));
  const checking = h.controller.check();
  h.draft.scope.profile = 'two'; h.draft.scope.selection.effective_cache = '/cache/two';
  h.draft.request.params.N = 64; h.controller.invalidate();
  release({ compatible: true, compilation: { ready: true, N: 32, available_N: [32] } });
  assert.equal(await checking, null); assert.equal(h.controller.snapshot.phase, 'checking'); assert.equal(h.applied.length, 0);
  h.controller.dispose();
});

test('a changed effective default cache in the native response cannot mark the active environment ready', async () => {
  const h = harness();
  h.setModelHandler(async () => ({ compatible: true, selection: { ...h.draft.scope.selection, effective_cache: '/changed-cache' },
    compilation: { ready: true, N: 32, available_N: [32] } }));
  assert.equal(await h.controller.check(), null);
  assert.equal(h.controller.snapshot.phase, 'failed'); assert.match(h.controller.snapshot.error, /cache changed/);
  assert.equal(h.applied.length, 0); h.controller.dispose();
});

test('build completion rechecks fresh runtime edits and applies those values with the cached model', async () => {
  const h = harness(); await h.controller.compile();
  h.draft.request.params.solver.cost = 9; h.controller.invalidate();
  h.compiled.add('32:true'); h.finish(); await h.controller.poll();
  assert.equal(h.applied.length, 1); assert.equal(h.applied[0].request.params.solver.cost, 9);
  assert.equal(h.calls.filter(call => call.url === '/api/source/model').at(-1).body.params.solver.cost, 9);
  assert.equal(h.calls.find(call => call.url === '/api/source/build').body.params.solver.cost, 4);
  h.controller.dispose();
});

test('building X cannot apply X after the current draft has become uncompiled Z', async () => {
  const h = harness(); await h.controller.compile();
  h.draft.request.params.N = 64; h.draft.request.source_settings.armature_on = false; h.controller.invalidate();
  h.compiled.add('32:true'); h.finish(); await h.controller.poll();
  assert.equal(h.applied.length, 0); assert.equal(h.controller.snapshot.phase, 'missing');
  assert.equal(h.controller.snapshot.draft.request.params.N, 64);
  h.controller.dispose();
});

test('build completion after a profile/cache switch does not probe or apply the new scope', async () => {
  const h = harness(); await h.controller.compile(); const before = h.calls.length;
  h.draft.scope.profile = 'two'; h.draft.scope.selection.effective_cache = '/cache/two'; h.controller.invalidate();
  h.compiled.add('32:true'); h.finish(); await h.controller.poll();
  assert.equal(h.applied.length, 0); assert.deepEqual(h.calls.slice(before).map(call => call.url), ['/api/source']);
  h.controller.dispose();
});

test('advanced Build callback respects the active environment and provider pin', async () => {
  const h = harness(); h.compiled.add('32:true');
  const job = { id: 'advanced', state: 'complete', live_refreshed: true,
    selection: clone(h.draft.scope.selection), source_settings_module: clone(h.draft.request.source_settings_module) };
  assert.equal(await h.controller.builtExternally({ ...job, selection: { ...job.selection, effective_cache: '/other-cache' } }), false);
  assert.equal(await h.controller.builtExternally({ ...job, source_settings_module: { ...job.source_settings_module, sha256: 'other' } }), false);
  assert.equal(h.applied.length, 0);
  assert.equal(await h.controller.builtExternally(job), true); assert.equal(h.applied.length, 1);
  h.controller.dispose();
});

test('failed compilation retains its error and log without applying or retrying automatically', async () => {
  const h = harness(); await h.controller.compile(); h.finish('failed'); await h.controller.poll();
  assert.equal(h.applied.length, 0); assert.match(h.controller.snapshot.error, /Compiler exited/);
  assert.match(h.controller.snapshot.lastBuild.log, /Retained compiler output/);
  assert.equal(h.calls.filter(call => call.url === '/api/source/build').length, 1);
  h.controller.dispose();
});

test('viewport polling and the advanced dialog settle the same completed build once', async () => {
  const h = harness(); await h.controller.compile(); h.compiled.add('32:true'); h.finish();
  await h.controller.builtExternally({ ...h.job, live_refreshed: true });
  const before = h.calls.length;
  await h.controller.poll();
  assert.equal(h.applied.length, 1);
  assert.deepEqual(h.calls.slice(before).map(call => call.url), ['/api/source']);
  h.controller.dispose();
});

test('viewport prompt shows one explicit Compile action, progress and retained failure details', () => {
  const { document } = parseHTML('<html><body><div id="viewport"></div></body></html>');
  let clicks = 0;
  const prompt = createModelCompilePrompt({ container: document.getElementById('viewport'), onCompile: () => clicks++ });
  prompt.update({ phase: 'missing', draft: { request: { params: { N: 64 } } } });
  assert.equal(prompt.element.hidden, false); assert.match(prompt.element.textContent, /N=64 model is not compiled/);
  assert.equal(prompt.element.querySelector('button').disabled, false); prompt.element.querySelector('button').click(); assert.equal(clicks, 1);
  prompt.update({ phase: 'missing', build: { job: { state: 'running', N: [64], log: 'Compiling exact model' } } });
  assert.equal(prompt.element.querySelector('button').disabled, true); assert.match(prompt.element.querySelector('pre').textContent, /exact model/);
  prompt.update({ phase: 'missing', error: 'Compiler exited', lastBuild: { log: 'retained' } });
  assert.match(prompt.element.textContent, /Compiler exited/);
  prompt.update({ phase: 'ready' }); assert.equal(prompt.element.hidden, true);
  prompt.update({ phase: 'checking' }); assert.equal(prompt.element.hidden, true);
  prompt.dispose();
});
