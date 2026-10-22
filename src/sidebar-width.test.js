import test from 'node:test';
import assert from 'node:assert/strict';
import { clampSidebarWidth, loadSidebarWidths, saveSidebarWidths, SIDEBAR_MIN, SIDEBAR_MAX, VIEWPORT_MIN, SIDEBAR_STORAGE_KEY } from './sidebar-width.js';

const memory = (initial) => { const data = new Map(initial === undefined ? [] : [[SIDEBAR_STORAGE_KEY, initial]]); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), data }; };

test('width clamps to the sidebar limits', () => {
  assert.equal(clampSidebarWidth(10), SIDEBAR_MIN);
  assert.equal(clampSidebarWidth(5000), SIDEBAR_MAX);
  assert.equal(clampSidebarWidth(301.4), 301);
  assert.equal(clampSidebarWidth(NaN), SIDEBAR_MIN);
});

test('the viewport keeps its minimum next to the other sidebar', () => {
  assert.equal(clampSidebarWidth(540, { windowWidth: 1200, otherWidth: 300 }), 1200 - 300 - VIEWPORT_MIN);
  assert.equal(clampSidebarWidth(540, { windowWidth: 1200, otherWidth: 0 }), 540);
  assert.equal(clampSidebarWidth(400, { windowWidth: 700, otherWidth: 300 }), SIDEBAR_MIN);
});

test('widths persist per side and tolerate bad or throwing storage', () => {
  const storage = memory();
  saveSidebarWidths(storage, { left: 320, right: 410 });
  assert.deepEqual(loadSidebarWidths(storage), { left: 320, right: 410 });
  assert.deepEqual(loadSidebarWidths(memory(JSON.stringify({ left: 9999, right: 'x' }))), { left: SIDEBAR_MAX });
  assert.deepEqual(loadSidebarWidths(memory('not json')), {});
  assert.deepEqual(loadSidebarWidths(undefined), {});
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadSidebarWidths(broken), {});
  assert.doesNotThrow(() => saveSidebarWidths(broken, { left: 300 }));
});
