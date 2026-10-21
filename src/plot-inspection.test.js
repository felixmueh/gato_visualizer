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
    await ui.refresh(); cards = episode.querySelectorAll('.plot-card'); await find(cards[0], 'button', 'Show on timeline').emit('click');
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
    assert.equal(find(solve, 'button', 'Continue SQP').disabled, true); ui.destroy();
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
    now += 210; view.cursor = 5.4; ui.update(); await flush(); assert.equal(evaluations(), initial); assert(calls.filter(item => item.path === '/api/plots/catalog').length >= 2);
    await find(solve, 'button', 'Pin solve').emit('click'); ui.state.selectIteration(2); assert.equal(ui.snapshot.pinned, true);
    source = { source: { kind: 'live', generation: 2 }, revision: 1 }; now += 210; ui.update();
    assert.equal(ui.snapshot.pinned, false); assert.equal(ui.snapshot.iteration, null); assert.equal(ui.snapshot.selectedSolve, null); await flush();
    const range = episode.querySelector('select'); range.value = 'visible'; await range.emit('change'); now += 210; ui.update(); await flush(); assert(evaluations() > initial);
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
