import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPlot } from './plot-renderer.js';
import { plotDOM } from './plot-dom-test-helper.js';

const base = { version: 1, title: 'Recorded data', x: { identity: 'episode_time', label: 'Episode', unit: 's' }, y: { label: 'Velocity', unit: 'rad/s' } };
test('line gaps and step endpoints retain exact finite x extent; cursor updates without transforms', () => {
  const { document } = plotDOM(), container = document.createElement('div'); let seek;
  const handle = renderPlot(container, { ...base, kind: 'lines', series: [{ label: 'Joint', x: [10, 11, 12, 13], y: [1, null, 2, null], style: 'step' }] }, { cursor: 10, onSeek: x => { seek = x; } });
  const path = container.querySelector('path').getAttribute('d');
  assert(path.includes('M62,')); assert(path.includes('H588')); assert.equal((path.match(/M/g) || []).length, 2);
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
  await container.querySelector('svg').emit('pointerdown', { pointerId: 4, button: 0, clientX: 62 });
  assert.deepEqual(seeks, [0]);
  handle.update(spec);
  await document.emit('pointermove', { pointerId: 9, clientX: 588 }); assert.deepEqual(seeks, [0]);
  await document.emit('pointermove', { pointerId: 4, clientX: 325 }); assert.equal(seeks.at(-1), 5);
  await document.emit('pointermove', { pointerId: 4, clientX: 700 }); assert.equal(seeks.at(-1), 10);
  await document.emit('pointerup', { pointerId: 4 });
  const count = seeks.length; await document.emit('pointermove', { pointerId: 4, clientX: 62 }); assert.equal(seeks.length, count);
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
  const ticks = () => container.querySelectorAll('text').slice(0, 5).map(item => Number(item.textContent));
  try {
    const handle = renderPlot(container, spec([0, 1]), { fitKey: 'entire' }), initial = ticks();
    assert(initial[0] < 0 && initial[4] > 1);
    handle.update(spec([.1, 1.01])); assert.deepEqual(ticks(), initial); assert.equal(frames.size, 0);
    const path = container.querySelector('path').getAttribute('d');
    handle.update(spec([0, 4])); assert.deepEqual(ticks(), initial);
    frame(0); frame(90); const halfway = ticks(); assert(halfway[4] > initial[4] && halfway[4] < 5);
    assert.notEqual(container.querySelector('path').getAttribute('d'), path);
    frame(180); const expanded = ticks(); assert(expanded[4] > 4);
    handle.update(spec([.1, .2])); assert.deepEqual(ticks(), expanded); assert.equal(frames.size, 0);
    handle.update(spec([.1, .2]), { fitKey: 'visible' }); assert(ticks()[4] < 1);
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
