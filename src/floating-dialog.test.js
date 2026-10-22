import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloatingDialog } from './floating-dialog.js';
import { plotDOM } from './plot-dom-test-helper.js';

test('tabbed dialog shows one panel and remembers the last tab per viewer', async () => {
  const { document } = plotDOM(), original = globalThis.document; globalThis.document = document;
  const saved = new Map(), storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const tabs = [{ id: 'backend', label: 'Backend' }, { id: 'ui', label: 'UI' }];
  try {
    const first = createFloatingDialog({ id: 'settings', title: 'Settings', tabs, storage });
    assert.deepEqual(Object.keys(first.panels), ['backend', 'ui']);
    assert.equal(first.activeTab, 'backend'); assert.equal(first.panels.ui.hidden, true); assert.equal(saved.size, 0);
    const uiTab = first.body.querySelectorAll('button').find(button => button.textContent === 'UI');
    await uiTab.emit('click');
    assert.equal(first.panels.backend.hidden, true); assert.equal(first.panels.ui.hidden, false); assert.equal(uiTab.getAttribute('aria-selected'), 'true');
    first.destroy();
    const reopened = createFloatingDialog({ id: 'settings', title: 'Settings', tabs, storage });
    assert.equal(reopened.activeTab, 'ui'); reopened.destroy();
    const blocked = createFloatingDialog({ id: 'settings', title: 'Settings', tabs, storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
    assert.equal(blocked.activeTab, 'backend'); blocked.selectTab('ui'); assert.equal(blocked.activeTab, 'ui'); blocked.destroy();
  } finally { globalThis.document = original; }
});
