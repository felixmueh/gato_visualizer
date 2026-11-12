import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSolveRun } from './solve-run.js';
import { plotDOM } from './plot-dom-test-helper.js';

const context = id => ({ source: { kind: 'live', generation: 4 }, selection: { solve_id: id }, profile_id: 'candidate', switching: false });
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(handler) {
  const { document } = plotDOM(), container = document.createElement('div'), requests = [], timers = new Map(), completed = []; let clock = 1000, timerId = 0, started = 0;
  const request = async (path, body) => { requests.push({ path, body: structuredClone(body) }); return handler(path, body); };
  const ui = setupSolveRun({ container, request, onStart: () => started++, onComplete: result => completed.push(result), now: () => clock, schedule: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, unschedule: id => timers.delete(id) });
  return { ui, requests, completed, timers, get started() { return started; }, async tick() { const [id, timer] = timers.entries().next().value; timers.delete(id); clock += timer.delay; await timer.fn(); }, advance(ms) { clock += ms; } };
}

test('plain selection only checks capability; bounded fresh run posts exact captured selection and adopts completed source', async () => {
  let polls = 0;
  const h = fixture((path) => path.endsWith('/capability') ? { available: true, initialization: 'cold_state' } : path === '/api/solve-inspections' ? { id: 'job-1', job_id: 'job-1', state: 'pending' } : ++polls === 1 ? { id: 'job-1', state: 'running' } : { id: 'job-1', state: 'completed', source: { kind: 'inspection', id: 'fresh-1' }, iterations_run: 3, stop_reason: 'iteration_limit' });
  const selected = context('recorded-7'); h.ui.update(selected); await flush(); for (let i = 0; i < 10; i++) h.ui.update(selected);
  assert.equal(h.requests.length, 1); assert.equal(h.ui.run.disabled, false); assert.equal(h.ui.reason, ''); assert(h.ui.run.title.includes('Independent cold solves')); assert(h.ui.run.title.includes('actual iterations may stop below its cap'));
  h.ui.cap.value = '1.5'; await h.ui.run.emit('click'); assert.equal(h.requests.length, 1); assert(h.ui.status.textContent.includes('integer'));
  h.ui.cap.value = '5'; h.ui.budget.value = '.2'; await h.ui.run.emit('click');
  assert.deepEqual(h.requests[1], { path: '/api/solve-inspections', body: { source: selected.source, selection: selected.selection, profile_id: 'candidate', sqp_iters: 5, budget_s: .2 } });
  assert.equal(h.started, 1); assert.equal(h.ui.run.disabled, true); assert.equal(h.ui.stop.disabled, false);
  await h.tick(); assert.equal(h.ui.run.textContent, 'Running…'); await h.tick();
  assert.deepEqual(h.completed[0].source, { kind: 'inspection', id: 'fresh-1' }); assert.equal(h.ui.status.textContent, ''); assert.equal(h.ui.run.textContent, 'Run again'); assert.equal(h.ui.stop.disabled, true);
  assert(h.requests.every(item => item.path.startsWith('/api/solve-inspections'))); h.ui.destroy();
});

test('capability requests are throttled and stale results cannot overwrite a newly selected Solve', async () => {
  let releaseOld;
  const h = fixture((_path, body) => body.selection.solve_id === 'old' ? new Promise(resolve => { releaseOld = resolve; }) : { available: true, profile_id: 'candidate' });
  h.ui.update(context('old')); h.ui.update(context('new')); assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 1);
  await h.tick(); assert.equal(h.requests.length, 2); assert.equal(h.ui.run.disabled, false);
  releaseOld({ available: false, reason: 'old recording has no exact bounds' }); await flush(); assert.equal(h.ui.run.disabled, false); assert(!h.ui.reason.includes('old recording'));
  h.ui.update({ ...context('new'), switching: true }); assert.equal(h.ui.run.disabled, true); assert(h.ui.reason.includes('switching'));
  h.ui.destroy();
});

test('Stop waits for a queued id and cancellation never adopts a partial result', async () => {
  let acknowledge;
  const h = fixture(path => path.endsWith('/capability') ? { available: true } : path === '/api/solve-inspections' ? new Promise(resolve => { acknowledge = resolve; }) : { id: 'queued', state: 'cancelled' });
  h.ui.update(context('s1')); await flush(); const start = h.ui.run.emit('click'); await flush(); await h.ui.stop.emit('click');
  assert.equal(h.ui.stop.textContent, 'Stopping…'); assert.equal(h.ui.status.textContent, ''); acknowledge({ id: 'queued', job_id: 'queued', state: 'pending' }); await start; await flush();
  assert.deepEqual(h.requests.at(-1), { path: '/api/solve-inspections/jobs/queued/stop', body: {} });
  assert.equal(h.ui.snapshot.active, false); assert.equal(h.completed.length, 0); assert(h.ui.status.textContent.includes('no partial result')); h.ui.destroy();
});

test('late running poll after Stop is ignored; transient status failure retains the Stop control', async () => {
  let releasePoll, fail = true;
  const h = fixture(path => path.endsWith('/capability') ? { available: true } : path === '/api/solve-inspections' ? { id: 'j', state: 'running' } : path.endsWith('/stop') ? { id: 'j', state: 'cancelled' } : fail ? (fail = false, Promise.reject(new Error('connection dropped'))) : new Promise(resolve => { releasePoll = resolve; }));
  h.ui.update(context('s1')); await flush(); await h.ui.run.emit('click'); await h.tick();
  assert.equal(h.ui.snapshot.active, true); assert.equal(h.ui.stop.disabled, false); assert(h.ui.status.textContent.includes('Retrying'));
  const pending = h.tick(); await flush(); await h.ui.stop.emit('click'); releasePoll({ id: 'j', state: 'completed', source: { kind: 'inspection', id: 'late' } }); await pending;
  assert.equal(h.completed.length, 0); assert.equal(h.ui.snapshot.job.state, 'cancelled'); h.ui.destroy();
});

test('missing exact inputs disable Run again with the backend reason and never post a native job', async () => {
  const h = fixture(() => ({ available: false, reason: 'This replay did not retain its exact installed constraint bounds.' }));
  h.ui.update(context('legacy')); await flush(); assert.equal(h.ui.run.disabled, true); assert(h.ui.reason.includes('constraint bounds'));
  await h.ui.run.emit('click'); assert.equal(h.requests.length, 1); h.ui.destroy();
});

test('hiding the inspector cancels capability work but an active job keeps polling and can be stopped', async () => {
  const h = fixture(path => path.endsWith('/capability') ? { available: true } : path.endsWith('/stop') ? { id: 'j', state: 'cancelled' } : { id: 'j', job_id: 'j', state: 'running' });
  h.ui.update(context('s1')); await flush(); await h.ui.run.emit('click');
  h.ui.update(context('s2')); // A new capability check is waiting for its throttle.
  h.ui.update(null); // Hidden inspector: cancel only that check.
  assert.equal(h.timers.size, 1); assert.equal(h.ui.snapshot.active, true);
  assert.equal(h.ui.run.disabled, true); assert.equal(h.ui.stop.disabled, false);
  await h.tick();
  assert.equal(h.requests.at(-1).path, '/api/solve-inspections/jobs/j');
  assert.equal(h.requests.filter(item => item.path.endsWith('/capability')).length, 1);
  await h.ui.stop.emit('click');
  assert.equal(h.requests.at(-1).path, '/api/solve-inspections/jobs/j/stop');
  assert.equal(h.ui.snapshot.active, false); assert.equal(h.timers.size, 0); h.ui.destroy();
});

test('inspection wall budget accepts units or frequency, preserves its text and keeps none optional', async () => {
  const h = fixture(path => path.endsWith('/capability') ? { available: true } : { id: 'done', state: 'completed', source: { kind: 'inspection', id: 'result' } });
  h.ui.update(context('s1')); await flush();
  assert.equal(h.ui.budget.type, 'text');
  for (const text of ['20ms', '50 Hz']) {
    h.ui.budget.value = text; await h.ui.run.emit('click');
    assert.equal(h.requests.at(-1).body.budget_s, .02); assert.equal(h.ui.budget.value, text);
  }
  for (const text of ['', 'none']) {
    h.ui.budget.value = text; await h.ui.run.emit('click');
    assert.equal('budget_s' in h.requests.at(-1).body, false);
  }
  const before = h.requests.length;
  h.ui.budget.value = '0ms'; await h.ui.run.emit('click');
  assert.equal(h.requests.length, before); assert.match(h.ui.status.textContent, /greater than 0 s/);
  h.ui.destroy();
});
