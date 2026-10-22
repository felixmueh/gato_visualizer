import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPlot } from './plot-renderer.js';
import { plotDOM } from './plot-dom-test-helper.js';

const base = { version: 1, title: 'Recorded data', x: { identity: 'episode_time', label: 'Episode', unit: 's' }, y: { label: 'Velocity', unit: 'rad/s' } };
test('line gaps and step endpoints retain exact finite x extent; cursor updates without transforms', () => {
  const { document } = plotDOM(), container = document.createElement('div'); let seek;
  const handle = renderPlot(container, { ...base, kind: 'lines', series: [{ label: 'Joint', x: [10, 11, 12, 13], y: [1, null, 2, null], style: 'step' }] }, { cursor: 10, onSeek: x => { seek = x; } });
  const path = container.querySelector('path').getAttribute('d'), left = container.querySelector('rect').getAttribute('x');
  assert(path.includes(`M${left},`)); assert(Number(left) < 50, 'y labels reserve only the width they need'); assert(path.includes('H588')); assert.equal((path.match(/M/g) || []).length, 2);
  assert.equal(handle.axisIdentity, 'episode_time');
  handle.updateCursor(14); const cursor = container.querySelectorAll('line').at(-1); assert.equal(cursor.getAttribute('visibility'), 'hidden');
  handle.updateCursor(11); assert.equal(cursor.getAttribute('visibility'), 'visible');
  container.querySelector('svg').emit('click', { clientX: 588 }); assert.equal(seek, 13);
  handle.setView({ window: [11, 12] }); assert(container.querySelector('svg')); handle.destroy(); assert.equal(container.children.length, 0);
});
test('Python histogram edges determine actual bar widths and full extent, with units and guides', () => {
  const { document } = plotDOM(), container = document.createElement('div');
  renderPlot(container, { ...base, kind: 'bars', series: [{ label: 'Intervals', x: [1, 4], y: [3, 2], bin_edges: [0, 2, 6], style: 'bar' }], guides: [{ axis: 'y', value: 5, label: 'Bound' }] });
  const bars = container.querySelectorAll('rect').filter(item => item.attributes.fill);
  assert.equal(bars.length, 2); assert(Number(bars[1].getAttribute('width')) > Number(bars[0].getAttribute('width')) * 1.9);
  assert(container.querySelectorAll('text').some(item => item.textContent === 'Bound'));
  assert(container.querySelectorAll('div').some(item => item.textContent === 'Velocity (rad/s)'));
});
test('tables show missing records explicitly; spans use measured start/end and lanes', () => {
  const { document } = plotDOM(), container = document.createElement('div');
  renderPlot(container, { version: 1, kind: 'table', title: 'Summary', rows: [{ label: 'Error', value: null, note: 'Not recorded' }] });
  assert(container.querySelectorAll('td').some(item => item.textContent === 'unavailable'));
  renderPlot(container, { ...base, kind: 'spans', spans: [{ lane: 'MPC', start: 10, end: 12, label: 'Solve wall' }, { lane: 'Physics', start: 11, end: 13, label: 'Step' }] });
  assert.equal(container.querySelectorAll('rect').filter(item => item.attributes.fill).length, 2);
  assert(container.querySelectorAll('text').some(item => item.textContent === 'Physics'));
});

test('category labels render their actual measured values rather than dropping string x', () => {
  const { document } = plotDOM(), container = document.createElement('div');
  renderPlot(container, { ...base, kind: 'bars', x: { identity: 'category', label: 'Joint', unit: '' }, series: [{ label: 'Maximum', x: ['Joint A', 'Joint B'], y: [1, 3], style: 'bar' }] });
  assert.equal(container.querySelectorAll('rect').filter(item => item.attributes.fill).length, 2);
  assert(container.querySelectorAll('text').some(item => item.textContent === 'Joint A'));
  assert(container.querySelectorAll('text').some(item => item.textContent === 'Joint B'));
  assert(!container.querySelectorAll('p').some(item => item.textContent.includes('No recorded')));
});

test('sidebar pointer scrubbing survives replacement, stops on release, and leaves linked timeline input alone', async () => {
  const { document } = plotDOM(), container = document.createElement('div'), seeks = [];
  const spec = { ...base, kind: 'lines', series: [{ x: [0, 10], y: [0, 1] }] };
  const handle = renderPlot(container, spec, { onSeek: x => seeks.push(x) });
  const left = Number(container.querySelector('rect').getAttribute('x'));
  await container.querySelector('svg').emit('pointerdown', { pointerId: 4, button: 0, clientX: left });
  assert.deepEqual(seeks, [0]);
  handle.update(spec);
  await document.emit('pointermove', { pointerId: 9, clientX: 588 }); assert.deepEqual(seeks, [0]);
  await document.emit('pointermove', { pointerId: 4, clientX: (left + 588) / 2 }); assert.equal(seeks.at(-1), 5);
  await document.emit('pointermove', { pointerId: 4, clientX: 700 }); assert.equal(seeks.at(-1), 10);
  await document.emit('pointerup', { pointerId: 4 });
  const count = seeks.length; await document.emit('pointermove', { pointerId: 4, clientX: left }); assert.equal(seeks.length, count);
  handle.update(spec, { linked: true, onSeek: x => seeks.push(x) });
  await container.querySelector('svg').emit('pointerdown', { pointerId: 5, button: 0, clientX: 62 });
  await document.emit('pointermove', { pointerId: 5, clientX: 588 }); assert.equal(seeks.length, count);
  handle.destroy();
});

test('automatic y scaling holds headroom, expands smoothly, and refits only on explicit scope changes', () => {
  const { document } = plotDOM(), container = document.createElement('div');
  const original = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame }, frames = new Map(); let seq = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++seq, callback); return seq; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const frame = time => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time)); };
  const spec = y => ({ ...base, kind: 'lines', series: [{ x: [0, 1], y }] });
  const ticks = () => container.querySelectorAll('.plot-y-tick').map(item => Number(item.textContent));
  try {
    const handle = renderPlot(container, spec([0, 1]), { fitKey: 'entire' }), initial = ticks();
    assert(initial[0] <= 0 && initial.at(-1) >= 1);
    handle.update(spec([.1, 1.01])); assert.deepEqual(ticks(), initial); assert.equal(frames.size, 0);
    const path = container.querySelector('path').getAttribute('d');
    handle.update(spec([0, 4])); assert.deepEqual(ticks(), initial);
    frame(0); frame(90); const halfway = ticks(); assert(halfway.at(-1) > initial.at(-1) && halfway.at(-1) < 5);
    assert.notEqual(container.querySelector('path').getAttribute('d'), path);
    frame(180); const expanded = ticks(); assert(expanded.at(-1) >= 4);
    handle.update(spec([.1, .2])); assert.deepEqual(ticks(), expanded); assert.equal(frames.size, 0);
    handle.update(spec([.1, .2]), { fitKey: 'visible' }); assert(ticks().at(-1) < 1);
    handle.update({ ...spec([0, 4]), y: { ...base.y, range: [-2, 6] } }); assert.deepEqual(ticks(), [-2, 0, 2, 4, 6]); assert.equal(frames.size, 0);
    handle.destroy();
  } finally { globalThis.requestAnimationFrame = original.request; globalThis.cancelAnimationFrame = original.cancel; }
});

test('embedded titles can be suppressed while standalone preview titles remain', () => {
  const { document } = plotDOM(), container = document.createElement('div');
  const spec = { ...base, kind: 'table', rows: [] };
  renderPlot(container, spec); assert.equal(container.querySelector('h3').textContent, base.title);
  renderPlot(container, spec, { hideTitle: true }); assert.equal(container.querySelector('h3'), undefined);
});

test('hover readouts retain all recorded values and clear when leaving the plot', async () => {
  const { document } = plotDOM(), container = document.createElement('div');
  renderPlot(container, { ...base, kind: 'lines', series: [
    { label: 'A long joint label', x: [0, 1], y: [2, 3] },
    { label: 'Another joint', x: [0, 1], y: [4, null] },
  ] }, { linked: true });
  const svg = container.querySelector('svg'), readout = container.querySelector('.plot-hover');
  await svg.emit('pointermove', { clientX: 600 });
  assert.equal(readout.textContent, '1 s · A long joint label: 3 · Another joint: 4');
  assert.equal(readout.getAttribute('title'), readout.textContent);
  assert.equal(container.querySelector('.plot-renderer').getAttribute('title'), readout.textContent);
  await svg.emit('pointerleave');
  assert.equal(readout.textContent, '');
  assert.equal(readout.getAttribute('title'), '');
  assert.equal(container.querySelector('.plot-renderer').getAttribute('title'), '');
});

test('histogram bars report their own bin edges on hover; notes can move out of the plot body', async () => {
  const { document } = plotDOM(), container = document.createElement('div');
  const spec = { ...base, kind: 'bars', x: { identity: 'wall_time', label: 'MPC wall', unit: 'ms' }, notes: ['3 intervals.'], series: [{ label: 'Intervals', x: [1, 4], y: [3, 2], bin_edges: [0, 2, 6], style: 'bar' }] };
  renderPlot(container, spec);
  assert(container.querySelectorAll('p').some(item => item.textContent === '3 intervals.'));
  renderPlot(container, spec, { notes: false });
  assert(!container.querySelectorAll('p').some(item => item.textContent === '3 intervals.'));
  const svg = container.querySelector('svg'), left = Number(container.querySelector('rect').getAttribute('x'));
  await svg.emit('pointermove', { clientX: left + (588 - left) * .75 });
  assert.equal(container.querySelector('.plot-hover').textContent, '2–6 ms · Intervals: 2');
  const bars = container.querySelectorAll('rect').filter(item => item.attributes.fill);
  assert.equal(bars[1].getAttribute('stroke'), '#eefbff');
  await svg.emit('pointerleave'); assert.equal(bars[1].getAttribute('stroke'), 'none');
});

test('viewer y limits fix chosen sides; clipping ignores isolated outliers for automatic sides', () => {
  const { document } = plotDOM(), container = document.createElement('div');
  const values = Array.from({ length: 100 }, (_, i) => i === 50 ? 1000 : 10 + i % 5);
  const spec = { ...base, kind: 'lines', series: [{ x: values.map((_, i) => i), y: values }] };
  const ticks = () => container.querySelectorAll('.plot-y-tick').map(item => Number(item.textContent));
  renderPlot(container, spec); assert(ticks().at(-1) >= 1000);
  renderPlot(container, spec, { yLimits: { clipOutliers: true } }); assert(ticks().at(-1) < 20);
  renderPlot(container, spec, { yLimits: { min: 0, max: 40 } }); assert.equal(ticks()[0], 0); assert.equal(ticks().at(-1), 40);
  renderPlot(container, spec, { yLimits: { min: 0, clipOutliers: true } }); assert.equal(ticks()[0], 0); assert(ticks().at(-1) < 20);
});

test('hosts choose pixel height and legend placement; linked rows keep a y axis inside the plot', () => {
  const { document } = plotDOM(), container = document.createElement('div'), header = document.createElement('div');
  const spec = { ...base, kind: 'lines', series: [{ label: 'Joint', x: [0, 1], y: [0, 2] }] };
  renderPlot(container, spec, { linked: true, height: 120, legendTarget: header });
  const svg = container.querySelector('svg');
  assert.equal(svg.style.height, '120px'); assert(svg.getAttribute('viewBox').endsWith(' 120'));
  assert(header.querySelector('.plot-legend')); assert.equal(container.querySelector('.plot-legend'), undefined);
  const labels = container.querySelectorAll('.plot-y-tick');
  assert(labels.length >= 2); assert(labels.every(item => item.getAttribute('x') === '3'));
  assert.equal(container.querySelector('rect').getAttribute('x'), '0');
});
