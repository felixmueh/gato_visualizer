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
