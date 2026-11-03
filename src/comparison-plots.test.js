import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonSources, setupComparisonPlots } from './comparison-plots.js';
import { createSession } from './session.js';
import { plotDOM } from './plot-dom-test-helper.js';

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const tracking = { id: 'comparison.tracking_error', scope: 'comparison', title: 'Tracking error', inputs: {} };
const channel = { id: 'comparison.channel', scope: 'comparison', title: 'Recorded channel', inputs: {
  channel: { type: 'choice', label: 'Channel', default: 'states.q.0', choices: [{ value: 'states.q.0', label: 'Joint 1 position' }, { value: 'plans.stats.wall_s', label: 'Solve wall time' }] },
  cutoff_hz: { type: 'number', label: 'Cutoff', unit: 'Hz', min: .1, max: 1000, default: 10 },
} };
function sessionFixture() {
  const session = createSession();
  session.addTrack({ trackId: 'a', source: { kind: 'replay', id: 'record/a', revision: 'r1' }, displayName: 'Default', color: 0x6fa8ff,
    offset_s: -2, motion: { time_basis: 'simulation', time_s: [2, 7], q: [Array(7).fill(0), Array(7).fill(.1)] } });
  session.addTrack({ trackId: 'b', source: { kind: 'replay', id: 'record/b', revision: 'r2' }, displayName: 'Combined', color: 0x6fdc8c,
    offset_s: 1, motion: { time_basis: 'simulation', time_s: [0, 5], q: [Array(7).fill(0), Array(7).fill(.2)] } });
  return session;
}
function response(body, title = 'Recorded comparison') {
  return { state: 'complete', catalog: [tracking, channel], context: { clock: 'session:test', bounds: [0, 6], common_bounds: [1, 5], runs: body.sources },
    results: (body.plots || []).map(item => ({ instance_id: item.instance_id, spec: { version: 1, kind: 'lines', title,
      x: { identity: 'session_time', label: 'Session time', unit: 's', clock: 'session:test' }, y: { unit: 'mm' },
      series: body.sources.map(source => ({ label: source.label, color: source.color, x: [1, 5], y: [2, 0] })) } })) };
}
function setup({ session = sessionFixture(), request, view = { visible: true, cursor: 2, aggregate: { start: 1, end: null } }, stored = new Map() } = {}) {
  const dom = plotDOM(), original = globalThis.document; globalThis.document = dom.document;
  const container = dom.document.createElement('section'), calls = [], availability = [];
  const ui = setupComparisonPlots({ container, getSession: () => session, getView: () => view,
    onAvailability: item => availability.push(item),
    request: request || (async (path, body) => { calls.push({ path, body: structuredClone(body) }); return response(body); }),
    storage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) } });
  return { ...dom, container, calls, availability, session, view, stored, ui,
    close() { ui.destroy(); globalThis.document = original; } };
}

test('comparison sources use recorded active runs with labels/colors/offsets; Replay omits Live and predictions', () => {
  const session = sessionFixture();
  session.updateMain({ source: { kind: 'live', generation: 5 }, span: [0, 2], empty: false });
  session.addTrack({ trackId: 'prediction', motion: { kind: 'prediction', time_s: [0, .9], q: [Array(7).fill(0), Array(7).fill(.1)] }, source: { kind: 'replay', id: 'prediction' } });
  session.setVisible('b', false); // Hide geometry without unloading the run.
  const before = JSON.stringify(session.tracks), sources = comparisonSources(session);
  assert.deepEqual(sources.map(item => item.key), ['live', 'a', 'b']);
  assert.deepEqual(sources[1], { key: 'a', label: 'Default', color: '#6fa8ff', offset_s: -2, source: { kind: 'replay', id: 'record/a', revision: 'r1' } });
  sources[1].source.id = 'only a detached copy'; assert.equal(JSON.stringify(session.tracks), before);
  session.setReplayOnly(true); assert.deepEqual(comparisonSources(session).map(item => item.key), ['a', 'b']);
  session.updateMain({ span: [0, 0], empty: true }); session.setReplayOnly(false);
  assert.deepEqual(comparisonSources(session).map(item => item.key), ['a', 'b']);
});

test('canonical kind-less recorded-motion API payload enables Comparison and reaches Python without browser arrays', async () => {
  const ctx = setup();
  try {
    assert(ctx.session.tracks.slice(1).every(track => !('kind' in track.motion)));
    ctx.ui.update(); await flush();
    assert.equal(ctx.availability.at(-1).visible, true); assert.equal(ctx.ui.snapshot.usableCount, 2);
    ctx.ui.state.add(tracking, 'comparison'); await ctx.ui.refresh();
    const body = ctx.calls.at(-1).body;
    assert.deepEqual(body.sources.map(item => item.source.id), ['record/a', 'record/b']);
    assert(body.sources.every(item => !('motion' in item) && !('q' in item) && !('time_s' in item)));
    assert(ctx.container.querySelector('svg'));
  } finally { ctx.close(); }
});

test('contextual availability retains selected/configured comparison when a run is removed, without hidden work', async () => {
  const ctx = setup({ view: { visible: false, aggregate: {}, cursor: 0 } });
  try {
    ctx.container.hidden = true; ctx.ui.update(); await flush();
    assert.equal(ctx.calls.length, 0); assert.equal(ctx.availability.at(-1).visible, true);
    ctx.session.removeTrack('b'); ctx.ui.update(); assert.equal(ctx.availability.at(-1).visible, false);
    ctx.view.visible = true; ctx.container.hidden = false; ctx.ui.update();
    assert.equal(ctx.availability.at(-1).visible, true); assert.equal(ctx.availability.at(-1).retained, true);
    const item = ctx.ui.state.add(tracking, 'comparison'); ctx.ui.invalidate();
    assert.match(ctx.container.querySelector('.plot-message').textContent, /at least two recorded runs/);
    assert.equal(ctx.container.querySelectorAll('.plot-card').length, 1);
    assert.equal(ctx.calls.length, 0); assert.equal(ctx.ui.snapshot.instances[0].id, item.id);
    ctx.ui.state.remove(item.id); ctx.ui.invalidate(); assert.equal(ctx.availability.at(-1).visible, true);
    ctx.view.visible = false; ctx.ui.update(); assert.equal(ctx.availability.at(-1).visible, false);
  } finally { ctx.close(); }
});

test('comparison jobs use session aggregate time; cursor/zoom never evaluate, offsets/labels/revisions do', async () => {
  const ctx = setup(); const before = { cursor: ctx.session.cursor, focused: ctx.session.focusedId, replayOnly: ctx.session.replayOnly };
  try {
    ctx.ui.state.add(tracking, 'comparison'); await ctx.ui.refresh(); ctx.ui.update(); await flush();
    const jobs = () => ctx.calls.filter(item => !item.body.client_id.endsWith('-catalog'));
    assert.equal(jobs().length, 1);
    const body = jobs()[0].body;
    assert.equal(body.context, 'comparison'); assert.equal(body.source, undefined);
    assert.deepEqual(body.range, { mode: 'window', start_s: 1 });
    assert.deepEqual(body.sources.map(item => item.offset_s), [-2, 1]);
    assert.deepEqual(ctx.container.querySelectorAll('.plot-legend').at(-1).querySelectorAll('span').map(item => item.style.color), ['#6fa8ff', '#6fdc8c']);
    const svg = ctx.container.querySelector('svg');
    ctx.view.cursor = 3; ctx.view.window = [2, 4]; ctx.ui.update(); await flush();
    assert.equal(jobs().length, 1); assert.equal(ctx.container.querySelector('svg'), svg);
    ctx.session.setOffset('b', 3); await ctx.ui.refresh();
    assert.equal(jobs().at(-1).body.sources[1].offset_s, 3);
    ctx.session.setName('b', 'Retuned'); await ctx.ui.refresh();
    assert.equal(jobs().at(-1).body.sources[1].label, 'Retuned');
    ctx.session.track('b').source.revision = 'r3'; await ctx.ui.refresh();
    assert.equal(jobs().at(-1).body.sources[1].source.revision, 'r3');
    ctx.view.aggregate = { start: 2, end: 4 }; await ctx.ui.refresh();
    assert.deepEqual(jobs().at(-1).body.range, { mode: 'window', start_s: 2, end_s: 4 });
    assert.deepEqual({ cursor: ctx.session.cursor, focused: ctx.session.focusedId, replayOnly: ctx.session.replayOnly }, before);
    assert(ctx.calls.every(item => item.path.startsWith('/api/plots/')));
  } finally { ctx.close(); }
});

test('catalog multi-add, dynamic channel inputs, unit-aware configuration and duplication persist without switching runs', async () => {
  const ctx = setup();
  try {
    ctx.ui.update(); await flush();
    await ctx.find(ctx.container, 'button', '+').emit('click'); await flush();
    assert.equal(ctx.ui.catalogDialog.isOpen, true);
    await ctx.ui.catalogDialog.element.querySelectorAll('button').find(item => item.title === 'Add Recorded channel').emit('click');
    await ctx.ui.refresh(); await flush();
    assert.equal(ctx.ui.catalogDialog.isOpen, true); assert.equal(ctx.ui.snapshot.instances.length, 1);
    await ctx.container.querySelectorAll('button').find(item => item.title === 'Configure plot').emit('click');
    const config = ctx.document.body.querySelectorAll('dialog').find(item => item.id.startsWith('comparison-config-'));
    const choice = config.querySelector('select'); choice.value = 'plans.stats.wall_s';
    const cutoff = config.querySelectorAll('input').find(item => item.dataset.timeUnit === 'Hz');
    assert.equal(cutoff.type, 'text'); cutoff.value = '20 ms';
    await config.querySelector('form').emit('submit'); await ctx.ui.refresh();
    assert.deepEqual(ctx.ui.snapshot.instances[0].parameters, { channel: 'plans.stats.wall_s', cutoff_hz: 50 });
    await ctx.container.querySelectorAll('button').find(item => item.title === 'Duplicate plot').emit('click'); await ctx.ui.refresh();
    assert.equal(ctx.ui.snapshot.instances.length, 2);
    assert.deepEqual(ctx.ui.snapshot.instances[1].parameters, ctx.ui.snapshot.instances[0].parameters);
    assert.notEqual(ctx.ui.snapshot.instances[0].id, ctx.ui.snapshot.instances[1].id);
    const persisted = JSON.parse(ctx.stored.get('comparison-plots-v1'));
    assert.equal(persisted.instances.length, 2); assert(persisted.instances.every(item => item.context === 'comparison'));
    ctx.session.removeTrack('b'); ctx.ui.update(); await flush();
    assert.equal(ctx.ui.snapshot.instances.length, 2); assert.equal(ctx.container.querySelectorAll('svg').length, 0);
    assert.match(ctx.container.querySelector('.plot-card-body').querySelector('p').textContent, /Two recorded runs/);
    const restore = setup({ stored: ctx.stored, view: { visible: false } });
    try { assert.deepEqual(restore.ui.snapshot.instances, persisted.instances); }
    finally { restore.close(); }
    globalThis.document = ctx.document;
  } finally { ctx.close(); }
});

test('removed sources and changed offsets reject stale results before any old plot reaches the screen', async () => {
  let finish, calls = 0;
  const ctx = setup({ request: async (_path, body) => { calls++; if (calls === 1) return new Promise(resolve => { finish = () => resolve(response(body, 'Old offset')); }); return response(body, 'Current offset'); } });
  try {
    ctx.ui.state.add(tracking, 'comparison'); const pending = ctx.ui.refresh(); await flush();
    ctx.session.setOffset('b', 10); ctx.ui.update(); finish(); await pending; await flush();
    assert.equal(ctx.container.querySelector('svg'), undefined);
    await ctx.ui.refresh(); assert.equal(ctx.container.querySelector('.plot-card-grip').textContent, 'Current offset');
    assert.equal(ctx.ui.snapshot.context.runs[1].offset_s, 10);
    ctx.session.removeTrack('b'); ctx.ui.update(); assert.equal(ctx.container.querySelector('svg'), undefined);
  } finally { ctx.close(); }
});

test('Live growth refreshes actual history; Replay removes Live without adding work or modifying playback', async () => {
  const session = sessionFixture(); session.removeTrack('b');
  session.updateMain({ source: { kind: 'live', generation: 2 }, span: [0, 1], empty: false, historyRevision: 1 });
  const ctx = setup({ session });
  try {
    ctx.ui.state.add(tracking, 'comparison'); await ctx.ui.refresh();
    session.updateMain({ span: [0, 2], historyRevision: 2 }); await ctx.ui.refresh();
    assert.equal(ctx.calls.length, 2); assert.equal(ctx.calls[1].body.sources[0].source.generation, 2);
    session.setReplayOnly(true); ctx.ui.update(); await flush();
    assert.equal(ctx.ui.snapshot.usableCount, 1); assert.equal(ctx.calls.length, 2);
    assert.equal(session.replayOnly, true); assert.equal(session.cursor, 0);
  } finally { ctx.close(); }
});

test('backend unavailability keeps cards and explains unusable recordings without displaying stale metrics', async () => {
  const ctx = setup({ request: async (_path, body) => ({ ...response(body), context: { bounds: [0, 6], usable_runs: 1,
    runs: [{ key: 'a', label: 'Default', episode_available: true }, { key: 'b', label: 'Combined', episode_available: false, error: 'Recording was removed from the library.' }] } }) });
  try {
    ctx.ui.state.add(tracking, 'comparison'); await ctx.ui.refresh(); ctx.ui.update();
    assert.equal(ctx.ui.snapshot.usableCount, 1); assert.equal(ctx.ui.snapshot.instances.length, 1);
    assert.equal(ctx.availability.at(-1).visible, true); assert.equal(ctx.container.querySelector('svg'), undefined);
    const message = ctx.container.querySelector('.plot-message');
    assert.match(message.textContent, /at least two/); assert.match(message.title, /Combined.*removed/);
  } finally { ctx.close(); }
});

test('first use seeds useful comparison cards once and an explicitly empty saved configuration stays empty', async () => {
  const defaults = [tracking, { id: 'comparison.tracking_summary', scope: 'comparison', title: 'Tracking summary', inputs: { metric: { type: 'choice', choices: ['rms', 'peak'], default: 'rms' } } },
    { id: 'comparison.smoothness', scope: 'comparison', title: 'Smoothness', inputs: { metric: { type: 'choice', choices: ['command_tv_rate'], default: 'command_tv_rate' } } }, channel];
  const request = async (_path, body) => ({ ...response(body), catalog: defaults });
  const stored = new Map(), ctx = setup({ request, stored });
  try {
    await ctx.ui.refresh(); ctx.ui.update(); await flush();
    assert.deepEqual(ctx.ui.snapshot.instances.map(item => item.plot_id), ['comparison.tracking_error', 'comparison.tracking_summary', 'comparison.smoothness']);
    assert.equal(ctx.container.querySelectorAll('svg').length, 3);
    for (const item of [...ctx.ui.state.instances]) ctx.ui.state.remove(item.id);
    await ctx.ui.refresh(); assert.equal(ctx.ui.snapshot.instances.length, 0);
  } finally { ctx.close(); }
  const restored = setup({ request, stored });
  try { await restored.ui.refresh(); restored.ui.update(); await flush(); assert.equal(restored.ui.snapshot.instances.length, 0); }
  finally { restored.close(); }
});

test('Live numerical work defers catalog, previews and evaluations, then refreshes while retained playback remains allowed', async () => {
  const ctx = setup();
  try {
    ctx.ui.state.add(tracking, 'comparison'); await ctx.ui.refresh();
    const svg = ctx.container.querySelector('svg'), before = ctx.calls.length;
    ctx.view.liveComputing = true; ctx.ui.update(); await flush();
    assert.equal(ctx.container.querySelector('svg'), svg);
    assert.match(ctx.container.querySelector('.plot-message').textContent, /after Live calculation stops/);
    await ctx.find(ctx.container, 'button', '+').emit('click'); await flush();
    assert.equal(ctx.ui.catalogDialog.isOpen, true);
    assert.match(ctx.ui.catalogDialog.element.querySelector('.plot-message').textContent, /after Live calculation stops/);
    await ctx.ui.refresh(); ctx.view.cursor = 4; ctx.ui.update(); await flush();
    assert.equal(ctx.calls.length, before); assert.equal(ctx.ui.snapshot.deferred, true); assert.equal(ctx.ui.snapshot.pending, true);
    ctx.view.liveComputing = false; ctx.view.playing = true;
    ctx.ui.update(); await flush();
    assert(ctx.calls.length > before); assert(ctx.calls.some(item => item.body.client_id.endsWith('-catalog')));
    assert.equal(ctx.ui.snapshot.deferred, false); assert(ctx.container.querySelector('svg'));
    assert.equal(ctx.container.querySelector('.plot-message').textContent, '');
  } finally { ctx.close(); }
});

test('a new Live calculation invalidates an in-flight comparison and its response cannot replace paused data', async () => {
  let finish, calls = 0;
  const ctx = setup({ request: async (_path, body) => { calls++; if (calls === 1) return new Promise(resolve => { finish = () => resolve(response(body, 'Before Live started')); }); return response(body, 'After Live stopped'); } });
  try {
    ctx.ui.state.add(tracking, 'comparison'); const inFlight = ctx.ui.refresh(); await flush();
    ctx.view.liveComputing = true; ctx.ui.update(); finish(); await inFlight; await flush();
    assert.equal(ctx.ui.snapshot.context.clock, undefined); assert.equal(ctx.container.querySelector('svg'), undefined);
    ctx.ui.update(); await flush(); assert.equal(calls, 1);
    ctx.view.liveComputing = false; ctx.ui.update(); await flush();
    assert.equal(calls, 2); assert.equal(ctx.container.querySelector('.plot-card-grip').textContent, 'After Live stopped');
  } finally { ctx.close(); }
});
