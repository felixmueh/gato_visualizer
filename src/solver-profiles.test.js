import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSolverProfiles } from './solver-profiles.js';
import { plotDOM } from './plot-dom-test-helper.js';

const profile = (id, name = id) => ({ id, name, mpc_root: `/solvers/${id}`, python: null, cache: null });
const initialCatalog = () => ({ profiles: [profile('main', 'Main'), profile('candidate', 'Candidate')], active_profile_id: 'main', simulator_source: { mpc_root: '/simulator', python: '/simulator/bin/python', cache: '/simulator/cache' }, switch: { state: 'idle' }, generation: 4 });
const fixture = ({ beforeActivate = () => undefined, onSettled = () => {}, activate } = {}) => {
  const { document } = plotDOM(), liveContainer = document.createElement('section'), editorContainer = document.createElement('section'), requests = [], timers = new Map(); let nextTimer = 0, catalog = initialCatalog();
  const request = async (path, body) => {
    requests.push({ path, body: structuredClone(body) });
    if (path === '/api/solver-profiles' && body) { catalog.profiles = [...catalog.profiles.filter(item => item.id !== body.profile.id), body.profile]; return structuredClone(catalog); }
    if (path === '/api/solver-profiles') return structuredClone(catalog);
    if (path === '/api/source/defaults') return { mpc_root: body.mpc_root, python: `${body.mpc_root}/venv-host/bin/python`, cache: `${body.mpc_root}/.cache/gato` };
    if (path === '/api/solver-profiles/activate') { catalog.switch = { state: 'switching', profile_id: body.profile_id }; return activate ? activate(body) : { state: 'switching' }; }
    throw new Error(`Unexpected request ${path}`);
  };
  const ui = setupSolverProfiles({ liveContainer, editorContainer, beforeActivate, onSettled, request, schedule: fn => { timers.set(++nextTimer, fn); return nextTimer; }, unschedule: id => timers.delete(id) });
  return { ui, requests, timers, get catalog() { return catalog; }, liveContainer, editorContainer };
};

test('profile editor saves named choices separately from simulator Apply and activates with one native anchor', async () => {
  const anchor = { sim_time_s: 1.25, q: [0, 1, -.2], qd: [.1, 0, -.3] }; let captures = 0; const events = [];
  const h = fixture({ beforeActivate: () => { captures++; return structuredClone(anchor); }, onSettled: item => events.push(item) });
  await h.ui.refresh(); assert.equal(h.ui.select.value, 'main'); assert.equal(h.ui.fields.name.value, 'Main');
  // The active profile is shown by the select alone; no duplicate status text.
  assert.equal(h.liveContainer.querySelector('p').textContent, '');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.ui.fields.cache.value, '/solvers/main/.cache/gato');
  const editorSelect = h.ui.editor.querySelector('select'); editorSelect.value = ''; await editorSelect.emit('change');
  h.ui.fields.name.value = 'New revision'; h.ui.fields.mpc_root.value = '/solvers/revision'; h.ui.fields.python.value = '/env/bin/python'; await h.ui.fields.name.emit('input');
  assert.equal(h.ui.activateButton.disabled, true); await h.ui.save.emit('click');
  assert.deepEqual(h.requests.filter(item => item.path === '/api/solver-profiles' && item.body).at(-1).body, { profile: { id: 'new-revision', name: 'New revision', mpc_root: '/solvers/revision', python: '/env/bin/python', cache: null } });
  assert.equal(h.ui.snapshot.catalog.active_profile_id, 'main'); assert.equal(h.ui.activateButton.disabled, false);
  await h.ui.activateButton.emit('click'); assert.equal(captures, 1); assert.equal(h.ui.select.disabled, true); assert.equal(h.ui.save.disabled, true);
  assert.deepEqual(h.requests.filter(item => item.path.endsWith('/activate')).at(-1).body, { profile_id: 'new-revision', anchor });
  h.catalog.active_profile_id = 'new-revision'; h.catalog.switch = { state: 'idle' }; h.catalog.generation = 5;
  await h.ui.handleEvent({ type: 'solver_profile', state: 'active', profile_id: 'new-revision', generation: 5 });
  assert.equal(h.ui.select.value, 'new-revision'); assert.equal(h.ui.select.disabled, false); assert.equal(events.length, 1); assert.equal(h.timers.size, 0);
  assert(h.requests.every(item => item.path.startsWith('/api/solver-profiles') || item.path === '/api/source/defaults')); h.ui.destroy();
});

test('SSE completion before activation HTTP reply cannot re-lock UI or schedule stale polling', async () => {
  let resolveActivation, settles = 0;
  const h = fixture({ activate: () => new Promise(resolve => { resolveActivation = resolve; }), onSettled: () => settles++ });
  await h.ui.refresh(); const activation = h.ui.activate('candidate'); await new Promise(resolve => setImmediate(resolve));
  h.catalog.active_profile_id = 'candidate'; h.catalog.switch = { state: 'idle' }; h.catalog.generation = 5;
  const event = { type: 'solver_profile', state: 'active', profile_id: 'candidate', generation: 5 };
  await h.ui.handleEvent(event); await h.ui.handleEvent(event); resolveActivation({ state: 'switching' }); await activation;
  assert.equal(settles, 1); assert.equal(h.ui.snapshot.switching, false); assert.equal(h.timers.size, 0); h.ui.destroy();
});

test('switch polling supports Replay and failed selection keeps profile retry available', async () => {
  const events = [], h = fixture({ onSettled: item => events.push(item) });
  await h.ui.refresh(); await h.ui.activate('candidate');
  h.catalog.active_profile_id = null; h.catalog.switch = { state: 'failed', profile_id: 'candidate', error: 'N=32 is unavailable' };
  const poll = [...h.timers.values()][0]; await poll();
  assert.equal(events[0].state, 'failed'); assert.equal(h.ui.select.value, ''); assert.equal(h.ui.select.disabled, false);
  assert(h.liveContainer.querySelector('p').textContent.includes('N=32 is unavailable'));
  h.ui.fields.name.value = 'Draft stays'; await h.ui.fields.name.emit('input'); await h.ui.refresh(); assert.equal(h.ui.fields.name.value, 'Draft stays');
  h.ui.destroy();
});

test('preflight failure reports the retained active solver to Live controls', async () => {
  const events = [], h = fixture({ onSettled: item => events.push(item) });
  await h.ui.refresh(); await h.ui.activate('candidate');
  h.catalog.switch = { state: 'failed', profile_id: 'candidate', error: 'N unavailable' };
  await h.ui.handleEvent({ state: 'failed', profile_id: 'candidate', error: 'N unavailable' });
  assert.equal(events[0].active_profile_id, 'main'); assert.equal(h.ui.select.value, 'main'); assert.equal(h.ui.select.disabled, false);
  h.ui.destroy();
});
