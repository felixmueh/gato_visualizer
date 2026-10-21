import test from 'node:test';
import assert from 'node:assert/strict';
import { setupPlotInspection } from './plot-inspection.js';
import { plotDOM } from './plot-dom-test-helper.js';

const jointDef = { id: 'episode.joint', scope: 'episode', title: 'Joint data', inputs: { joint: { type: 'joint', default: 'arm_right_1_joint', label: 'Joint' }, quantity: { type: 'choice', default: 'q', choices: ['q', 'qd'] } } };
const summaryDef = { id: 'episode.summary', scope: 'episode', title: 'Episode summary', inputs: {} };
const solveDef = { id: 'solve.trace', scope: 'solve', title: 'SQP trace', inputs: {} };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

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
    const select = episode.querySelector('select'); select.value = 'visible'; await select.emit('change'); await ui.refresh(); assert.deepEqual(requests.at(-1).range, { mode: 'visible', cursor_s: 12, start_s: 5, end_s: 15 });
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

test('Live reset clears pinned inspection; zoom-only Entire mode never reruns Python aggregates', async () => {
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
    const range = episode.querySelector('select'); range.value = 'visible'; await range.emit('change'); now += 210; ui.update(); await flush(); assert(evaluations() > initial);
    range.value = 'through_cursor'; await range.emit('change'); now += 210; ui.update(); await flush();
    const throughCount = evaluations();
    view.cursor = 5.08; now += 210; ui.update(); await flush();
    assert(evaluations() > throughCount); assert(calls.some(item => item.path === '/api/plots/evaluate' && item.body.context === 'episode' && item.body.range.cursor_s === 5.08));
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
    ui.update(); await flush(); const item = ui.state.add(jointDef, 'episode'); item.timeline = true; ui.state.rangeMode = 'visible'; await ui.refresh();
    assert.equal(bottom.querySelectorAll('.plot-card').length, 0); assert.equal(episode.querySelector('select').disabled, true);
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
    view.inspectSolve = true; ui.update(); assert.equal(callbacks.at(-1).active, true);
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
  const domain = root => root.querySelectorAll('text').slice(5, 7).map(item => Number(item.textContent));
  const cursor = root => root.querySelectorAll('line').at(-1);
  try {
    const ui = setupPlotInspection({ episodeContainer: episode, solveContainer: solve, bottomContainer: bottom, getSource: () => ({ source: { kind: 'replay', id: 'r', trajectory_index: 0 } }), getView: () => view, onSeek: x => { seeks.push(x); view.cursor = x; }, request, storage: null });
    ui.update(); await flush(); const item = ui.state.add(jointDef, 'episode'); item.timeline = true; await ui.refresh();
    assert.deepEqual(domain(episode), [0, 20]); assert.equal(cursor(episode).getAttribute('visibility'), 'visible');
    const timelineCursor = () => Number(cursor(bottom).getAttribute('x1')); assert.equal(timelineCursor(), 300);
    const evaluationCount = () => requests.filter(item => item.path === '/api/plots/evaluate').length;
    const beforeZoom = evaluationCount(); view.window = [5, 9]; ui.update(); await flush(); assert.deepEqual(domain(episode), [0, 20]); assert.equal(evaluationCount(), beforeZoom); assert.equal(timelineCursor(), 150);
    const scope = episode.querySelector('select'); scope.value = 'through_cursor'; await scope.emit('change'); await ui.refresh();
    assert.deepEqual(domain(episode), [0, 6]); assert.equal(cursor(episode).getAttribute('visibility'), 'hidden'); assert.equal(cursor(bottom).getAttribute('visibility'), 'visible'); assert.equal(timelineCursor(), 150);
    view.cursor = 0; ui.update(); assert.deepEqual(domain(episode), [0, .001]); assert.equal(cursor(episode).getAttribute('visibility'), 'hidden');
    scope.value = 'visible'; await scope.emit('change'); await ui.refresh(); assert.deepEqual(domain(episode), [5, 9]);
    // The async rebuild replaces SVGs, while the active scrub keeps its original domain.
    await episode.querySelector('svg').emit('pointerdown', { pointerId: 12, button: 0, clientX: 62 }); assert.equal(seeks.at(-1), 5);
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
    assert.equal(ui.snapshot.iteration, 1); assert.equal(picked.at(-1).predictionSource, 'final-context'); assert(solve.querySelector('.plot-message').textContent.includes('loading'));
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
