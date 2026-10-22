import test from 'node:test';
import assert from 'node:assert/strict';
import { setupPlotInspection } from './plot-inspection.js';
import { plotDOM } from './plot-dom-test-helper.js';

const jointDef = { id: 'episode.joint', scope: 'episode', title: 'Joint data', inputs: { joint: { type: 'joint', default: 'arm_right_1_joint', label: 'Joint' }, quantity: { type: 'choice', default: 'q', choices: ['q', 'qd'] } } };
const summaryDef = { id: 'episode.summary', scope: 'episode', title: 'Episode summary', inputs: {} };
const solveDef = { id: 'solve.trace', scope: 'solve', title: 'SQP trace', inputs: {} };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

test('hidden Solve inspector does not probe capabilities or evaluate Solve plots; reopening checks the current selection', async () => {
  const { document } = plotDOM(), original = { document: globalThis.document, now: Date.now }; globalThis.document = document;
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section');
  let now = 1000; Date.now = () => now;
  const view = { window: [0, 10], cursor: 0, inspectSolve: false }, requests = [];
  const request = async (path, body) => {
    requests.push({ path, body });
    if (path.endsWith('/capability')) return { available: true };
    return { state: 'complete', catalog: [], context: { selected_solve: { id: `s${view.cursor}`, seq: view.cursor, iterations: [] } }, results: [] };
  };
  const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => ({ source: { kind: 'live', generation: 1 }, revision: view.cursor }), getView: () => view, getSolverProfile: () => ({ id: 'candidate' }), request, storage: null });
  try {
    for (let i = 0; i < 12; i++) { view.cursor = i; now += 250; ui.update(); await flush(); }
    assert.equal(requests.filter(item => item.path.endsWith('/capability')).length, 0);
    assert.equal(requests.filter(item => item.body.context === 'solve').length, 0);
    view.inspectSolve = true; ui.update(); await flush();
    assert.equal(requests.filter(item => item.path.endsWith('/capability')).length, 1);
    assert.equal(ui.runAgain.run.disabled, false); assert.equal(ui.snapshot.selectedSolve.id, 's11');
    // The tab can remain selected while its whole sidebar is hidden.
    solve.hidden = true;
    for (let i = 12; i < 20; i++) { view.cursor = i; now += 250; ui.update(); await flush(); }
    assert.equal(requests.filter(item => item.path.endsWith('/capability')).length, 1);
    solve.hidden = false; ui.update(); await flush();
    assert.equal(requests.filter(item => item.path.endsWith('/capability')).length, 2);
    assert.equal(ui.snapshot.selectedSolve.id, 's19');
  } finally { ui.destroy(); globalThis.document = original.document; Date.now = original.now; }
});

test('streaming ranges redraw graphs at most five times a second while timeline cursors update every frame', async () => {
  const { document } = plotDOM(), original = { document: globalThis.document, now: Date.now }; globalThis.document = document;
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section');
  let now = 1000; Date.now = () => now;
  const view = { window: [0, 10], cursor: 2, inspectSolve: false }, source = { source: { kind: 'replay', id: 'r' } };
  const request = async (_path, body) => ({ state: 'complete', catalog: [jointDef], context: { clock: 'replay:r', bounds: [0, 20] }, results: (body.plots || []).map(item => ({ instance_id: item.instance_id, spec: { version: 1, kind: 'lines', title: 'Recorded data', x: { identity: 'episode_time', clock: 'replay:r' }, y: {}, series: [{ x: [0, 20], y: [0, 1] }] } })) });
  const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => source, getView: () => view, request, storage: null });
  try {
    ui.update(); await flush(); const item = ui.state.add(jointDef, 'episode'); item.timeline = true; view.aggregate = { start: null, end: 2 }; await ui.refresh();
    const graphs = new Set([episode.querySelector('svg')]), markers = new Set();
    for (let i = 1; i <= 60; i++) {
      now = 1000 + i * 16; view.cursor = 2 + i * .01; view.aggregate = { start: null, end: 2 + i * .01 }; view.window = [i * .001, 10 + i * .001];
      ui.update(); await flush(); graphs.add(episode.querySelector('svg'));
      markers.add(bottom.querySelectorAll('line').at(-1).getAttribute('x1'));
    }
    assert(graphs.size >= 4); assert(graphs.size <= 6, `Expected at most 5 redraws, saw ${graphs.size - 1}`);
    assert.equal(markers.size, 60);
    const beforeGesture = episode.querySelector('svg'); view.aggregate = { start: null, end: 1.234 };
    await document.emit('pointerup'); ui.update();
    assert.notEqual(episode.querySelector('svg'), beforeGesture);
    assert.deepEqual(episode.querySelectorAll('.plot-x-range').map(item => Number(item.textContent)), [0, 1.234]);
    // Hidden placements do not retain graph DOM; showing them restores cached data immediately.
    episode.hidden = true; ui.update(); assert.equal(episode.querySelector('svg'), undefined);
    episode.hidden = false; ui.update(); assert(episode.querySelector('svg'));
  } finally { ui.destroy(); globalThis.document = original.document; Date.now = original.now; }
});

test('ordinary robot views do not request unused Episode data; a visible docked plot still evaluates', async () => {
  const { document } = plotDOM(), original = globalThis.document; globalThis.document = document;
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section');
  episode.hidden = solve.hidden = bottom.hidden = true;
  const calls = [], view = { window: [0, 10], cursor: 2, inspectSolve: false };
  const request = async (path, body) => { calls.push({ path, body }); return { state: 'complete', catalog: [jointDef], context: { clock: 'live:1', bounds: [0, 10] }, results: [] }; };
  const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => ({ source: { kind: 'live', generation: 1 } }), getView: () => view, request, storage: null });
  try {
    ui.update(); await flush(); assert.equal(calls.length, 0);
    const item = ui.state.add(jointDef, 'episode'); item.timeline = true; bottom.hidden = false;
    ui.update(); await flush();
    assert.equal(calls.length, 1); assert.equal(calls[0].body.context, 'episode');
    assert.equal(calls[0].body.plots[0].plot_id, jointDef.id);
  } finally { ui.destroy(); globalThis.document = original; }
});

test('mock browser catalog keeps open for multi-add, config duplicates differ, timeline shares instance and drag-out preserves card', async () => {
  const { document, find } = plotDOM(), original = globalThis.document; globalThis.document = document;
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section');
  const source = { source: { kind: 'replay', id: 'recording', trajectory_index: 0 }, label: 'Recording' }, view = { window: [0, 5], cursor: 2 };
  const requests = [], seek = [], persisted = new Map();
  const request = async (_path, body) => {
    requests.push(structuredClone(body));
    return { state: 'complete', catalog: body.context === 'episode' ? [jointDef, summaryDef] : [solveDef], context: { episode_available: true, clock: 'replay:recording:0', joint_names: ['arm_right_1_joint', 'arm_right_2_joint'], selected_solve: { id: 'p1', seq: 'p1', sim_time_s: 1, iterations: [{ index: 1, status: 'accepted' }, { index: 4, status: 'zero-PCG shortcut' }], final_prediction: { ee_xyz: [[1, 2, 3]] } } }, results: (body.plots || []).map(item => ({ instance_id: item.instance_id, spec: item.plot_id === 'episode.summary' ? { version: 1, kind: 'table', title: 'Summary', rows: [] } : { version: 1, kind: 'lines', title: 'Joint', x: { identity: body.context === 'solve' ? 'sqp_iteration' : 'episode_time', clock: 'replay:recording:0', unit: 's' }, y: { unit: 'rad' }, series: [{ label: item.inputs.joint || 'Trace', x: [0, 5], y: [1, 2] }] } })) };
  };
  try {
    const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => source, getView: () => view, onSeek: x => seek.push(x), request, storage: { getItem: key => persisted.get(key), setItem: (key, value) => persisted.set(key, value) } });
    ui.update(); await flush();
    await find(episode, 'button', '+').emit('click'); await flush();
    assert.equal(ui.catalogDialog.isOpen, true); assert.equal(ui.catalogDialog.element.method, 'show');
    const search = ui.catalogDialog.body.querySelector('input'); search.value = 'joint'; await search.emit('input');
    assert.equal(ui.catalogDialog.body.querySelectorAll('.plot-catalog-item').length, 1);
    await find(ui.catalogDialog.body, 'button', 'Add').emit('click'); await find(ui.catalogDialog.body, 'button', 'Add').emit('click');
    assert.equal(ui.state.instances.length, 2); assert.equal(ui.catalogDialog.isOpen, true);
    await ui.refresh();
    let cards = episode.querySelectorAll('.plot-card'); await find(cards[0], 'button', '⧉').emit('click'); assert.equal(ui.state.instances.length, 3);
    cards = episode.querySelectorAll('.plot-card'); await find(cards[1], 'button', '⚙').emit('click');
    const config = document.body.children.find(item => item.id?.startsWith('config-'));
    const selects = config.querySelectorAll('select'); selects[0].value = 'arm_right_2_joint'; selects[1].value = 'qd'; await config.querySelector('form').emit('submit');
    assert.equal(ui.state.instances[0].parameters.joint, 'arm_right_1_joint'); assert.equal(ui.state.instances[1].parameters.joint, 'arm_right_2_joint');
    await ui.refresh(); cards = episode.querySelectorAll('.plot-card'); const timelineToggle = cards[0].querySelector('.plot-timeline-toggle'); assert.equal(timelineToggle.getAttribute('aria-label'), 'Show on timeline'); assert.equal(timelineToggle.parentElement, cards[0].querySelector('header')); assert.equal(cards[0].querySelectorAll('h3').length, 0); await timelineToggle.emit('click');
    assert.equal(bottom.querySelectorAll('.plot-card').length, 1); const id = bottom.querySelector('.plot-card').dataset.instance; assert.equal(id, ui.state.instances[0].id);
    const transfer = { setData() {}, dropEffect: 'none' };
    let grip = bottom.querySelector('.plot-card-grip'); await grip.emit('dragstart', { dataTransfer: transfer }); await grip.emit('dragend');
    assert.equal(bottom.querySelectorAll('.plot-card').length, 0); assert.equal(ui.state.instances.length, 3);
    cards = episode.querySelectorAll('.plot-card'); grip = cards[2].querySelector('.plot-card-grip'); const last = cards[2].dataset.instance;
    await grip.emit('dragstart', { dataTransfer: transfer }); await episode.querySelector('.plot-cards').emit('drop', { target: cards[0], dataTransfer: transfer }); await grip.emit('dragend'); assert.equal(ui.state.instances[0].id, last);
    assert.equal(seek.length, 0); assert(persisted.has('plot-inspection-v1'));
    ui.destroy();
  } finally { globalThis.document = original; }
});

test('pinned actual SQP iteration persists while episode advances; ranges and source switches leave execution alone', async () => {
  const { document, find } = plotDOM(), original = globalThis.document; globalThis.document = document;
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section');
  let source = { source: { kind: 'live', generation: 4 }, revision: 1 }, view = { window: [5, 15], cursor: 7 }, picked = [], requests = [], seeks = 0;
  const solver = seq => ({ id: seq, seq, time_s: Number(seq), iterations: [{ index: 0, prediction: { ee_xyz: [[0, 0, 0]] } }, { index: 3, status: 'rejected', has_prediction: false }], final_prediction: { ee_xyz: [[1, 2, 3]] } });
  const request = async (_path, body) => { requests.push(structuredClone(body)); return { state: 'complete', catalog: [], context: { episode_available: true, clock: `live:${body.source.generation}`, selected_solve: solver(body.selection.solve_seq || String(Math.floor(view.cursor))), association: body.selection.solve_seq ? 'explicit' : 'recorded' }, results: [] }; };
  try {
    const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => source, getView: () => view, onSeek: () => seeks++, onPrediction: p => picked.push(p), request, storage: null });
    ui.update(); await flush(); assert.equal(ui.snapshot.selectedSolve.seq, '7');
    await find(solve, 'button', 'Pin solve').emit('click'); assert(solve.className.includes('solve-pinned')); assert(solve.querySelector('.solve-identity').textContent.includes('Pinned'));
    const slider = solve.querySelector('input'); slider.value = '1'; await slider.emit('input'); assert.equal(ui.snapshot.iteration, 3); assert.deepEqual(picked.at(-1).prediction, { ee_xyz: [[1, 2, 3]] }); assert.equal(picked.at(-1).predictionSource, 'final-context'); assert.equal(seeks, 0);
    assert.equal(solve.querySelector('.plot-message').textContent, 'Final prediction shown; iteration trajectory not recorded.');
    view.cursor = 12; await ui.refresh(); assert.equal(ui.snapshot.selectedSolve.seq, '7'); assert.equal(ui.snapshot.iteration, 3); assert.equal(requests.at(-1).selection.solve_seq, '7'); assert.equal(picked.at(-1).predictionSource, 'final-context'); assert.equal(view.cursor, 12);
    view.aggregate = { start: 5, end: null }; await ui.refresh(); assert.deepEqual(requests.at(-1).range, { mode: 'window', cursor_s: 12, start_s: 5 });
    // A real recorded seed snapshot takes precedence over the final context.
    slider.value = '0'; await slider.emit('input'); assert.equal(ui.snapshot.iteration, 0); assert.deepEqual(picked.at(-1).prediction.ee_xyz, [[0, 0, 0]]); assert.equal(picked.at(-1).predictionSource, 'iteration'); assert.equal(view.cursor, 12); assert.equal(seeks, 0);
    assert(!solve.querySelector('.plot-message').textContent.includes('Final prediction shown'));
    assert.equal(ui.snapshot.selectedSolve.iterations[1].prediction, undefined);
    assert.equal(ui.snapshot.selectedSolve.iterations[1].has_prediction, false);
    assert(requests.filter(item => item.context === 'solve').some(item => item.selection.iteration === 3));
    await find(solve, 'button', 'Final result').emit('click'); assert.equal(ui.snapshot.iteration, null); assert.deepEqual(picked.at(-1).prediction.ee_xyz, [[1, 2, 3]]); assert.equal(picked.at(-1).predictionSource, 'final');
    await find(solve, 'button', 'Follow cursor').emit('click'); await ui.refresh(); assert.equal(ui.snapshot.selectedSolve.seq, '12'); assert.equal(ui.snapshot.pinned, false);
    source = { source: { kind: 'replay', id: 'new', trajectory_index: 0 } }; ui.update(); await flush(); assert.equal(ui.snapshot.pinned, false); assert.equal(seeks, 0);
    assert.equal(find(solve, 'button', 'Run again').disabled, true); assert(solve.querySelectorAll('p').some(item => item.textContent.includes('active solver profile'))); ui.destroy();
  } finally { globalThis.document = original; }
});

test('Live reset clears pinned inspection; zoom and cursor never rerun Python aggregates, a window change does', async () => {
  const { document, find } = plotDOM(), original = { document: globalThis.document, now: Date.now }; globalThis.document = document;
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section');
  let now = 1000, source = { source: { kind: 'live', generation: 1 }, revision: 1 }, view = { cursor: 5, window: [0, 10], episodeClock: true }; Date.now = () => now;
  const calls = [];
  const request = async (path, body) => { calls.push({ path, body: structuredClone(body) }); return { state: 'complete', catalog: [], context: { episode_available: true, selected_solve: { id: '5', seq: '5', iterations: [{ index: 2 }], final_prediction: {} } }, results: [] }; };
  try {
    const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => source, getView: () => view, request, storage: null });
    ui.update(); await flush(); const evaluations = () => calls.filter(item => item.path === '/api/plots/evaluate').length;
    const initial = evaluations(); assert.equal(initial, 2);
    now += 210; view.window = [2, 6]; ui.update(); await flush(); assert.equal(evaluations(), initial);
    now += 210; view.cursor = 5.04; ui.update(); await flush(); assert.equal(evaluations(), initial); assert(calls.filter(item => item.path === '/api/plots/catalog').length >= 2);
    await find(solve, 'button', 'Pin solve').emit('click'); ui.state.selectIteration(2); assert.equal(ui.snapshot.pinned, true);
    source = { source: { kind: 'live', generation: 2 }, revision: 1 }; now += 210; ui.update();
    assert.equal(ui.snapshot.pinned, false); assert.equal(ui.snapshot.iteration, null); assert.equal(ui.snapshot.selectedSolve, null); await flush();
    const afterReset = evaluations();
    view.aggregate = { start: 2, end: null }; now += 210; ui.update(); await flush(); assert(evaluations() > afterReset);
    assert(calls.some(item => item.path === '/api/plots/evaluate' && item.body.context === 'episode' && item.body.range.mode === 'window' && item.body.range.start_s === 2 && !('end_s' in item.body.range)));
    // The aggregate window is independent of the playback cursor.
    const windowCount = evaluations();
    view.cursor = 5.08; now += 210; ui.update(); await flush(); assert.equal(evaluations(), windowCount);
    ui.destroy();
  } finally { globalThis.document = original.document; Date.now = original.now; }
});

test('metrics-only SQP inspection without a final prediction stays unavailable', async () => {
  const { document } = plotDOM(), original = globalThis.document; globalThis.document = document;
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section');
  const selected = { id: 'recorded:1', seq: 1, iterations: [{ index: 2, has_prediction: false }], final_prediction: null }, picked = [];
  const view = { window: [0, 5], cursor: 2, episodeClock: true, inspectSolve: true };
  const request = async () => ({ state: 'complete', catalog: [], context: { episode_available: true, selected_solve: selected }, results: [] });
  try {
    const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => ({ source: { kind: 'replay', id: 'r', trajectory_index: 0 } }), getView: () => view, request, onPrediction: p => picked.push(p), storage: null });
    ui.update(); await flush();
    const slider = solve.querySelector('input'); slider.value = '0'; await slider.emit('input');
    assert.equal(ui.snapshot.iteration, 2); assert.equal(picked.at(-1).active, true);
    assert.equal(picked.at(-1).prediction, null); assert.equal(picked.at(-1).predictionSource, null);
    assert.equal(solve.querySelector('.plot-message').textContent, 'Metrics are recorded for this iteration; its prediction trajectory is unavailable.');
    assert.equal(view.cursor, 2); assert.equal(selected.iterations[0].prediction, undefined);
    ui.destroy();
  } finally { globalThis.document = original; }
});

test('a saved prediction horizon never accepts companion episode plots on its timeline', async () => {
  const { document } = plotDOM(), original = globalThis.document; globalThis.document = document;
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section');
  const calls = [];
  const request = async (path, body) => { calls.push({ path, body }); return { state: 'complete', catalog: [jointDef], context: { episode_available: true, clock: 'replay:r:1', bounds: [0, 20] }, results: (body.plots || []).map(item => ({ instance_id: item.instance_id, spec: { version: 1, kind: 'lines', title: 'Recorded motion', x: { identity: 'episode_time', clock: 'replay:r:1' }, y: {}, series: [{ label: 'Position', x: [0, 20], y: [1, 2] }] } })) }; };
  try {
    const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => ({ source: { kind: 'replay', id: 'r', trajectory_index: 1 } }), getView: () => ({ window: [0, .5], cursor: .2, episodeClock: false }), request, storage: null });
    ui.update(); await flush(); const item = ui.state.add(jointDef, 'episode'); item.timeline = true; await ui.refresh();
    assert.equal(bottom.querySelectorAll('.plot-card').length, 0); assert.equal(episode.querySelector('.aggregate-window').querySelector('span').textContent, 'All available history');
    assert(calls.filter(item => item.body.context === 'episode').every(item => item.body.range.mode === 'entire'));
    assert(episode.querySelectorAll('text').some(item => item.textContent === '20')); ui.destroy();
  } finally { globalThis.document = original; }
});

test('ordinary views retain immediate Live prediction; Solve tab or explicit pin opts into inspection path', async () => {
  const { document, find } = plotDOM(), original = { document: globalThis.document, now: Date.now }; globalThis.document = document;
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section');
  let now = 1000, view = { window: [0, 5], cursor: 1, episodeClock: true, inspectSolve: false }, callbacks = []; Date.now = () => now;
  const request = async () => ({ state: 'complete', catalog: [], context: { episode_available: true, selected_solve: { id: 'preview:3', seq: 'preview:3', origin: 'preview', iterations: [], final_prediction: { ee_xyz: [[1, 0, 0]] } } }, results: [] });
  try {
    const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => ({ source: { kind: 'live', generation: 1 }, revision: [3], solveSeq: 'preview:3' }), getView: () => view, onPrediction: p => callbacks.push(p), request, storage: null });
    ui.update(); await flush(); assert.equal(callbacks.at(-1).active, false);
    view.inspectSolve = true; ui.update(); await flush(); assert.equal(callbacks.at(-1).active, true);
    view.inspectSolve = false; ui.update(); assert.equal(callbacks.at(-1).active, false);
    await find(solve, 'button', 'Pin solve').emit('click'); assert.equal(callbacks.at(-1).active, true);
    await find(solve, 'button', 'Follow cursor').emit('click'); assert.equal(callbacks.at(-1).active, false); ui.destroy();
  } finally { globalThis.document = original.document; Date.now = original.now; }
});

test('sidebar episode scopes have distinct domains and cursor rules; docked copies retain viewport and clock', async () => {
  const { document } = plotDOM(), original = globalThis.document; globalThis.document = document;
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section');
  const view = { window: [4, 8], cursor: 6, episodeClock: true }, seeks = [], requests = [];
  const request = async (path, body) => { requests.push({ path, body }); return { state: 'complete', catalog: [jointDef], context: { episode_available: true, clock: 'replay:r:0', bounds: [0, 20] }, results: (body.plots || []).map(item => ({ instance_id: item.instance_id, spec: { version: 1, kind: 'lines', title: 'Recorded motion', x: { identity: 'episode_time', clock: 'replay:r:0' }, y: {}, series: [{ x: [0, 20], y: [0, 1] }] } })) }; };
  const domain = root => root.querySelectorAll('.plot-x-range').map(item => Number(item.textContent));
  const cursor = root => root.querySelectorAll('line').at(-1);
  try {
    let cleared = 0;
    const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => ({ source: { kind: 'replay', id: 'r', trajectory_index: 0 } }), getView: () => view, onSeek: x => { seeks.push(x); view.cursor = x; }, onClearAggregate: () => cleared++, request, storage: null });
    ui.update(); await flush(); const item = ui.state.add(jointDef, 'episode'); item.timeline = true; await ui.refresh();
    assert.deepEqual(domain(episode), [0, 20]); assert.equal(cursor(episode).getAttribute('visibility'), 'visible');
    const timelineCursor = () => Number(cursor(bottom).getAttribute('x1')); assert.equal(timelineCursor(), 300);
    const evaluationCount = () => requests.filter(item => item.path === '/api/plots/evaluate').length;
    const beforeZoom = evaluationCount(); view.window = [5, 9]; await document.emit('wheel'); ui.update(); await flush(); assert.deepEqual(domain(episode), [0, 20]); assert.equal(evaluationCount(), beforeZoom); assert.equal(timelineCursor(), 150);
    const chip = episode.querySelector('.aggregate-window'), clear = chip.querySelector('button');
    assert.equal(chip.querySelector('span').textContent, 'Entire episode'); assert.equal(clear.hidden, true);
    // An open start begins at the first sample; the cursor stays an independent marker.
    view.aggregate = { start: null, end: 6 }; await ui.refresh();
    assert.deepEqual(domain(episode), [0, 6]); assert.equal(cursor(episode).getAttribute('visibility'), 'visible'); assert.equal(cursor(bottom).getAttribute('visibility'), 'visible'); assert.equal(timelineCursor(), 150);
    assert.equal(chip.querySelector('span').textContent, 'start → 6.000 s'); assert.equal(clear.hidden, false);
    await clear.emit('click'); assert.equal(cleared, 1);
    view.aggregate = { start: 15, end: null }; await ui.refresh(); assert.deepEqual(domain(episode), [15, 20]); assert.equal(chip.querySelector('span').textContent, '15.000 s → latest');
    view.aggregate = { start: 5, end: 9 }; await ui.refresh(); assert.deepEqual(domain(episode), [5, 9]);
    // The async rebuild replaces SVGs, while the active scrub keeps its original domain.
    await episode.querySelector('svg').emit('pointerdown', { pointerId: 12, button: 0, clientX: Number(episode.querySelector('rect').getAttribute('x')) }); assert.equal(seeks.at(-1), 5);
    await ui.refresh(); await document.emit('pointermove', { pointerId: 12, clientX: 588 }); assert.equal(seeks.at(-1), 9);
    await document.emit('pointerup', { pointerId: 12 }); ui.destroy();
  } finally { globalThis.document = original; }
});

test('SQP plot drag selects recorded iterations across card rebuilds without seeking episode time', async () => {
  const { document } = plotDOM(), original = globalThis.document; globalThis.document = document;
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section'); let seeks = 0;
  const request = async (_path, body) => ({ state: 'complete', catalog: [solveDef], context: { selected_solve: { id: 's1', seq: 1, iterations: [{ index: 1 }, { index: 7 }] } }, results: (body.plots || []).map(item => ({ instance_id: item.instance_id, spec: { version: 1, kind: 'lines', title: 'SQP', x: { identity: 'sqp_iteration' }, y: {}, series: [{ x: [1, 7], y: [3, 1] }] } })) });
  try {
    const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => ({ source: { kind: 'replay', id: 'r', trajectory_index: 0 } }), getView: () => ({ window: [0, 5], cursor: 2 }), onSeek: () => seeks++, request, storage: null });
    ui.update(); await flush(); ui.state.add(solveDef, 'solve'); await ui.refresh();
    await solve.querySelector('svg').emit('pointerdown', { pointerId: 2, button: 0, clientX: 62 }); assert.equal(ui.snapshot.iteration, 1);
    await ui.refresh(); await document.emit('pointermove', { pointerId: 2, clientX: 588 }); assert.equal(ui.snapshot.iteration, 7); assert.equal(seeks, 0);
    await document.emit('pointercancel', { pointerId: 2 }); await document.emit('pointermove', { pointerId: 2, clientX: 62 }); assert.equal(ui.snapshot.iteration, 7);
    ui.destroy();
  } finally { globalThis.document = original; }
});

test('Replay Run again selects one retained solve identity for capability and submission', async () => {
  const { document } = plotDOM(), original = globalThis.document; globalThis.document = document;
  const source = { kind: 'replay', id: 'recording', trajectory_index: 4 }, requests = [];
  const request = async (path, body) => {
    requests.push({ path, body: structuredClone(body) });
    if (path.endsWith('/capability')) return { available: Object.keys(body.selection).length === 1 };
    if (path === '/api/solve-inspections') return { id: 'job', state: 'failed', error: 'Fixture stops before native execution' };
    return { state: 'complete', catalog: [], context: { selected_solve: { id: 'retained-17', seq: 17, iterations: [] } }, results: [] };
  };
  let ui;
  try {
    ui = setupPlotInspection({ episodeContainer: document.createElement('section'), solveContainer: document.createElement('section'), bottomContainer: document.createElement('section'), getSource: () => ({ source }), getView: () => ({ window: [0, 5], cursor: 2 }), getSolverProfile: () => ({ id: 'candidate' }), request, storage: null });
    ui.update(); await flush();
    assert.equal(ui.runAgain.run.disabled, false);
    await ui.runAgain.run.emit('click');
    for (const path of ['/api/solve-inspections/capability', '/api/solve-inspections']) {
      const body = requests.find(item => item.path === path)?.body;
      assert.deepEqual(body?.source, source);
      assert.deepEqual(body?.selection, { solve_id: 'retained-17' });
    }
  } finally { ui?.destroy(); globalThis.document = original; }
});

test('fresh inspection pins only Solve, hydrates true snapshots safely, and leaves original Episode source/cursor/settings unchanged', async () => {
  const { document, find } = plotDOM(), original = { document: globalThis.document, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  globalThis.document = document;
  const timers = new Map(); let timerId = 0; globalThis.setTimeout = (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }; globalThis.clearTimeout = id => timers.delete(id);
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section');
  const source = { source: { kind: 'live', generation: 4 }, revision: 1 }, view = { window: [0, 10], cursor: 2, episodeClock: true, inspectSolve: true }, settings = { config: { N: 32, solver_params: { max_sqp_iters: 5 } } }, retainedSettings = structuredClone(settings), requests = [], picked = [];
  const finalPrediction = { ee_xyz: [[10, 0, 0], [11, 0, 0]] }, originalSolve = { id: 'original-7', seq: 7, iterations: [{ index: 1 }], final_prediction: structuredClone(finalPrediction) };
  let deferFirst = true, releaseFirst;
  const inspection = { id: 'job1', state: 'completed', source: { kind: 'inspection', id: 'fresh1' }, iterations_run: 2, requested: { sqp_iters: 8 }, initialization: 'cold_state', original: { source: source.source }, original_solve_id: 'original-7', actual_solver_profile: { profile: { id: 'candidate' } } };
  const summary = iteration => ({ id: 'fresh-solve', seq: 'fresh-solve', iterations: [0, 1, 2].map(index => ({ index, has_prediction: true })), selected_iteration: iteration, selected_prediction: { ee_xyz: [[iteration ?? 2, 0, 1], [iteration ?? 2, 1, 1]] }, final_prediction: iteration == null ? { ee_xyz: [[2, 0, 1], [2, 1, 1]] } : {}, provenance: { initialization: 'cold_state', solver_profile: { profile: { id: 'candidate' } }, original_solver_profile: { profile: { id: 'main' } }, original: { source: source.source, solve_id: 'original-7' } } });
  const request = async (path, body) => {
    requests.push({ path, body: structuredClone(body) });
    if (path.endsWith('/capability')) return { available: true, initialization: 'cold_state', profile_id: 'candidate' };
    if (path === '/api/solve-inspections') return { id: 'job1', job_id: 'job1', state: 'pending' };
    if (path === '/api/solve-inspections/jobs/job1') return inspection;
    const fresh = body.context === 'solve' && body.source.kind === 'inspection';
    const response = { state: 'complete', catalog: body.context === 'episode' ? [jointDef] : [solveDef], context: { episode_available: body.context === 'episode', clock: 'live:4', bounds: [0, 10], selected_solve: fresh ? summary(body.selection.iteration) : structuredClone(originalSolve) }, results: (body.plots || []).map(item => ({ instance_id: item.instance_id, spec: { version: 1, title: 'Recorded data', kind: 'lines', x: { identity: body.context === 'episode' ? 'episode_time' : 'sqp_iteration', clock: 'live:4' }, y: {}, series: [{ x: [0, 2], y: [2, 0] }] } })) };
    if (fresh && path === '/api/plots/catalog' && body.selection.iteration === 1 && deferFirst) { deferFirst = false; return new Promise(resolve => { releaseFirst = () => resolve(response); }); }
    return response;
  };
  try {
    let seeks = 0;
    const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => source, getView: () => view, getSolverProfile: () => ({ id: 'candidate', switching: false }), onSeek: () => seeks++, onPrediction: item => picked.push(item), request, storage: null });
    ui.update(); await flush(); ui.state.add(jointDef, 'episode'); ui.state.add(solveDef, 'solve'); await ui.refresh(); await flush();
    // A refresh may throttle a duplicate capability check; release only that timer.
    for (const [id, timer] of [...timers]) if (timer.delay !== 200) { timers.delete(id); await timer.fn(); }
    ui.runAgain.cap.value = '8'; await ui.runAgain.run.emit('click');
    assert.deepEqual(requests.find(item => item.path === '/api/solve-inspections').body, { source: { kind: 'live', generation: 4 }, selection: { solve_id: 'original-7' }, profile_id: 'candidate', sqp_iters: 8 });
    const [id, timer] = [...timers].find(([, value]) => value.delay === 200); timers.delete(id); await timer.fn();
    await ui.refresh(); assert.deepEqual(ui.snapshot.solveSource, { kind: 'inspection', id: 'fresh1' }); assert.equal(ui.snapshot.pinned, true);
    assert(solve.querySelector('.solve-identity').textContent.includes('Fresh / cold')); assert(solve.querySelector('.solve-identity').textContent.includes('solver profile candidate')); assert(solve.querySelector('.solve-identity').textContent.includes('original solver profile main'));
    const slider = solve.querySelector('input'); slider.value = '1'; await slider.emit('input'); const pending = ui.refresh(); await flush();
    // The final trajectory already on screen stays while the snapshot loads; no context message flickers.
    assert.equal(ui.snapshot.iteration, 1); assert.equal(picked.at(-1).predictionSource, 'held'); assert.deepEqual(picked.at(-1).prediction.ee_xyz, [[2, 0, 1], [2, 1, 1]]);
    assert(!solve.querySelector('.plot-message').textContent.includes('Final prediction shown')); assert(solve.querySelector('.sqp-strip').className.includes('loading'));
    slider.value = '2'; await slider.emit('input'); releaseFirst(); await pending; await ui.refresh();
    assert.equal(ui.snapshot.iteration, 2); assert.equal(ui.snapshot.pinned, true); assert.deepEqual(picked.at(-1).prediction.ee_xyz, [[2, 0, 1], [2, 1, 1]]); assert.equal(picked.at(-1).predictionSource, 'iteration');
    assert.equal(ui.snapshot.selectedSolve.iterations[2].prediction, undefined); // only the selected snapshot is transported
    view.cursor = 4; await ui.refresh(); assert.equal(ui.snapshot.iteration, 2); assert.equal(view.cursor, 4); assert.equal(seeks, 0); assert.deepEqual(settings, retainedSettings);
    assert(requests.filter(item => item.body?.context === 'episode').every(item => item.body.source.kind === 'live' && item.body.source.generation === 4));
    assert(!requests.some(item => item.path === '/api/live/command')); assert.deepEqual(originalSolve.final_prediction, finalPrediction);
    await find(solve, 'button', 'Follow episode').emit('click'); await ui.refresh(); assert.equal(ui.snapshot.inspection, null); assert.equal(ui.snapshot.selectedSolve.id, 'original-7'); assert.deepEqual(picked.at(-1).prediction, finalPrediction); assert.equal(ui.snapshot.instances.length, 2); assert.equal(view.cursor, 4);
    ui.destroy();
  } finally { Object.assign(globalThis, original); }
});

test('changing between real SQP snapshots keeps the previous snapshot visible while the next one loads', async () => {
  const { document, find } = plotDOM(), original = globalThis.document; globalThis.document = document;
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section'), picked = [];
  let source = { source: { kind: 'live', generation: 1 } }, releaseSecond;
  const final = { ee_xyz: [[3, 0, 1], [3, 1, 1]] };
  const request = async (path, body) => {
    const iteration = body.selection.iteration, missingSourceFinal = body.source.generation === 2;
    const summary = { id: 'recorded-trace', iterations: [0, 1, 2, 3].map(index => ({ index, has_prediction: true })), selected_iteration: iteration, selected_prediction: missingSourceFinal ? null : { ee_xyz: [[iteration ?? 3, 0, 1], [iteration ?? 3, 1, 1]] }, final_prediction: iteration == null && !missingSourceFinal ? structuredClone(final) : {} };
    const response = { state: 'complete', catalog: [], context: { episode_available: true, selected_solve: summary }, results: [] };
    if (body.context === 'solve' && path === '/api/plots/catalog' && iteration === 2 && !missingSourceFinal) return new Promise(resolve => { releaseSecond = () => resolve(response); });
    return response;
  };
  try {
    const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => source, getView: () => ({ window: [0, 5], cursor: 1 }), request, onPrediction: item => picked.push(item), storage: null });
    ui.update(); await flush(); await find(solve, 'button', 'Pin solve').emit('click');
    const slider = solve.querySelector('input'); slider.value = '1'; await slider.emit('input'); await ui.refresh();
    assert.equal(ui.snapshot.selectedSolve.selected_iteration, 1); assert.deepEqual(ui.snapshot.selectedSolve.final_prediction, {}); assert.deepEqual(picked.at(-1).prediction.ee_xyz, [[1, 0, 1], [1, 1, 1]]);
    slider.value = '2'; await slider.emit('input'); const pending = ui.refresh(); await flush();
    assert.deepEqual(picked.at(-1).prediction.ee_xyz, [[1, 0, 1], [1, 1, 1]]); assert.equal(picked.at(-1).predictionSource, 'held'); assert.equal(solve.querySelector('.plot-message').textContent, 'Recorded SQP inspection leaves the episode clock unchanged.');
    assert(solve.querySelector('.sqp-strip').className.includes('loading'));
    assert.deepEqual(ui.snapshot.selectedSolve.final_prediction, {}); assert.equal(ui.snapshot.selectedSolve.selected_iteration, 1);
    releaseSecond(); await pending;
    assert.equal(picked.at(-1).predictionSource, 'iteration'); assert.deepEqual(picked.at(-1).prediction.ee_xyz, [[2, 0, 1], [2, 1, 1]]); assert.equal(ui.snapshot.iteration, 2); assert.equal(ui.snapshot.pinned, true);
    assert(!solve.querySelector('.sqp-strip').className.includes('loading'));
    // Snapshots already seen return without waiting for the backend.
    slider.value = '1'; await slider.emit('input'); assert.equal(picked.at(-1).predictionSource, 'iteration'); assert.deepEqual(picked.at(-1).prediction.ee_xyz, [[1, 0, 1], [1, 1, 1]]);
    await ui.refresh();
    source = { source: { kind: 'live', generation: 2 } }; ui.update(); await ui.refresh();
    const newSlider = solve.querySelector('input'); newSlider.value = '2'; await newSlider.emit('input');
    // Another source's solve never inherits the previous trajectory.
    assert.equal(picked.at(-1).prediction, null); assert.equal(picked.at(-1).predictionSource, null); assert(solve.querySelector('.sqp-strip').className.includes('loading'));
    ui.destroy();
  } finally { globalThis.document = original; }
});

test('a recorded trace prefetches its iteration paths once so scrubbing needs no per-iteration response', async () => {
  const { document } = plotDOM(), original = globalThis.document; globalThis.document = document;
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section'), picked = [], calls = [];
  const solveFor = iteration => ({ id: 'trace', iterations: [0, 1, 2, 3].map(index => ({ index, has_prediction: true })), selected_iteration: iteration, selected_prediction: iteration == null ? { ee_xyz: [[3, 0, 0]] } : null, final_prediction: iteration == null ? { ee_xyz: [[3, 0, 0]] } : {}, capabilities: { iteration_paths: true } });
  let plotResponses = true;
  const request = async (path, body) => {
    calls.push({ path, body: structuredClone(body) });
    const paths = body.selection?.iteration_paths;
    if (paths == null && !plotResponses) return new Promise(() => {}); // the plot worker is busy
    return { state: 'complete', catalog: [], context: { selected_solve: solveFor(body.selection?.iteration ?? null) }, results: [], ...(paths != null ? { iteration_paths: { start: 0, stop: 4, ee_xyz: [0, 1, 2, 3].map(i => [[i, 0, 0]]) } } : {}) };
  };
  try {
    const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => ({ source: { kind: 'inspection', id: 'fresh' } }), getView: () => ({ window: [0, 1], cursor: 0 }), request, onPrediction: item => picked.push(item), storage: null });
    ui.update(); await flush(); await ui.refresh(); await flush();
    const prefetch = calls.filter(item => item.body.selection?.iteration_paths != null);
    assert.equal(prefetch.length, 1); assert.equal(prefetch[0].body.selection.iteration_paths, 3); assert.equal(prefetch[0].body.selection.iteration, null); assert.notEqual(prefetch[0].body.client_id, calls[0].body.client_id);
    plotResponses = false;
    const slider = solve.querySelector('input');
    for (const position of [1, 0, 2]) {
      slider.value = String(position); await slider.emit('input');
      assert.equal(picked.at(-1).predictionSource, 'iteration'); assert.deepEqual(picked.at(-1).prediction.ee_xyz, [[position, 0, 0]]);
      assert(!solve.querySelector('.sqp-strip').className.includes('loading'));
    }
    await flush(); assert.equal(calls.filter(item => item.body.selection?.iteration_paths != null).length, 1);
    ui.destroy();
  } finally { globalThis.document = original; }
});

test('cards keep notes on hover, resize per placement, configure y limits, and the catalog previews default plots', async () => {
  const { document, find } = plotDOM(), original = globalThis.document; globalThis.document = document;
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section');
  const source = { source: { kind: 'replay', id: 'r', trajectory_index: 0 } }, view = { window: [0, 5], cursor: 2, aggregate: { start: 1, end: null } }, requests = [], persisted = new Map();
  const timingDef = { id: 'episode.timing', scope: 'episode', title: 'Timing', description: 'Recorded host wall times.', inputs: {} };
  const request = async (path, body) => { requests.push({ path, body: structuredClone(body) }); return { state: 'complete', catalog: [timingDef, summaryDef], context: { clock: 'replay:r:0', bounds: [0, 5] }, results: (body.plots || []).map(item => ({ instance_id: item.instance_id, spec: item.plot_id === 'episode.summary' ? { version: 1, kind: 'table', title: 'Summary', rows: [] } : { version: 1, kind: 'lines', title: 'Timing', notes: ['Wall time is not episode time.'], display_reduction: [{ series: 'MPC wall', original: 9000, displayed: 1200 }], x: { identity: 'episode_time', clock: 'replay:r:0' }, y: { unit: 'ms' }, series: [{ label: 'MPC wall', x: [0, 5], y: [1, 2] }] } })) }; };
  const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => source, getView: () => view, request, storage: { getItem: key => persisted.get(key), setItem: (key, value) => persisted.set(key, value) } });
  try {
    ui.update(); await flush();
    await find(episode, 'button', '+').emit('click'); await flush();
    const previews = requests.filter(item => item.body.client_id?.endsWith('-catalog'));
    assert.equal(previews.length, 1); assert.deepEqual(previews[0].body.plots.map(item => item.instance_id), ['preview:episode.timing', 'preview:episode.summary']);
    // Previews show the plot over the current aggregate window, like an added card.
    assert.equal(previews[0].body.range.mode, 'window'); assert.equal(previews[0].body.range.start_s, 1); assert(!('end_s' in previews[0].body.range));
    const items = ui.catalogDialog.body.querySelectorAll('.plot-catalog-item');
    assert(items[0].querySelector('.plot-catalog-preview').querySelector('svg')); assert(items[1].querySelector('.plot-catalog-preview').querySelector('table'));
    await find(items[0], 'button', 'Add').emit('click'); await ui.refresh();
    let card = episode.querySelector('.plot-card'); const grip = card.querySelector('.plot-card-grip');
    assert(!card.querySelectorAll('p').some(item => item.textContent.includes('Wall time')));
    assert.match(grip.title, /Recorded host wall times\.\nWall time is not episode time\.\nDisplay shows 1200 of 9000 points of MPC wall/);
    // Resizing redraws live and persists once on release.
    await card.querySelector('.plot-resize-handle').emit('pointerdown', { pointerId: 3, button: 0, clientY: 100 });
    await document.emit('pointermove', { pointerId: 3, clientY: 160 }); assert.equal(episode.querySelector('svg').style.height, '230px');
    const before = persisted.get('plot-inspection-v1'); await document.emit('pointerup', { pointerId: 3 });
    assert.notEqual(persisted.get('plot-inspection-v1'), before); assert.equal(ui.state.height(ui.state.instances[0].id, 'sidebar'), 230);
    card = episode.querySelector('.plot-card'); await find(card, 'button', '⚙').emit('click');
    const config = document.body.children.find(item => item.id?.startsWith('config-'));
    assert(config.querySelectorAll('p').some(item => item.textContent.includes('Wall time is not episode time.')));
    const [low, high] = config.querySelectorAll('input').filter(item => item.type === 'number'); low.value = '0'; high.value = '';
    config.querySelectorAll('input').find(item => item.type === 'checkbox').checked = true;
    await config.querySelector('form').emit('submit');
    assert.deepEqual(ui.state.instances[0].display, { min: 0, max: null, clipOutliers: true });
    ui.destroy();
  } finally { globalThis.document = original; }
});

test('Live growth reveals docked and sidebar plots through the cursor every frame without rebuilding them', async () => {
  const { document } = plotDOM(), original = { document: globalThis.document, now: Date.now }; globalThis.document = document;
  const episode = document.createElement('section'), solve = document.createElement('section'), bottom = document.createElement('section');
  let now = 1000; Date.now = () => now;
  const view = { window: [0, 4], cursor: 4, reveal: 4, aggregate: { start: null, end: null }, inspectSolve: false }, source = { source: { kind: 'live', generation: 1 }, revision: 1 };
  const request = async (_path, body) => ({ state: 'complete', catalog: [jointDef], context: { clock: 'live:1', bounds: [0, 5] }, results: (body.plots || []).map(item => ({ instance_id: item.instance_id, spec: { version: 1, kind: 'lines', title: 'Recorded data', x: { identity: 'episode_time', clock: 'live:1' }, y: {}, series: [{ x: [0, 2.5, 5], y: [0, 1, 0] }] } })) });
  const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => source, getView: () => view, request, storage: null });
  try {
    ui.update(); await flush(); const item = ui.state.add(jointDef, 'episode'); item.timeline = true; await ui.refresh();
    const dock = bottom.querySelector('svg'), side = episode.querySelector('svg');
    const clipWidth = svg => Number(svg.querySelector('rect').getAttribute('width')), full = svg => Number(svg.getAttribute('viewBox').split(' ')[2]);
    // Data reach 5 s; the following docked window ends at the cursor and the sidebar's open end follows it.
    assert.equal(clipWidth(dock), full(dock));
    now += 16; view.cursor = view.reveal = 4.05; view.window = [0, 4.05]; ui.update();
    assert.equal(bottom.querySelector('svg'), dock, 'no rebuild within the 5 Hz cadence');
    const data = dock.querySelectorAll('g').find(node => node.attributes.class === 'plot-data');
    assert.match(data.getAttribute('transform'), /^matrix\(0\.98/);
    assert.match(side.querySelectorAll('g').find(node => node.attributes.class === 'plot-data').getAttribute('transform'), /^matrix\(/);
    // Paused: no reveal, the sidebar shows all fetched data again.
    now += 16; delete view.reveal; ui.update();
    assert.equal(side.querySelectorAll('text').filter(node => node.attributes.class === 'plot-x-range').at(-1).textContent, '5');
    // Playing a docked window wider than the cursor clips at the cursor.
    now += 16; view.window = [0, 5]; view.reveal = 2.5; ui.update();
    const current = bottom.querySelector('svg'); assert.equal(clipWidth(current), full(current) / 2);
  } finally { ui.destroy(); globalThis.document = original.document; Date.now = original.now; }
});
