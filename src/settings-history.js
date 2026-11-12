// Undo and redo of the Live settings document ({config, task, execution, source_settings},
// what /api/live/settings versions): one entry per accepted settings version, whoever made
// it (this viewer, another viewer, an agent). Undo returns the previous document, which the
// caller submits like any edit; the version that accepts it moves the cursor instead of
// adding an entry. Presentation, view, source/profile, transport and tracks are no part of it.
const clone = value => JSON.parse(JSON.stringify(value));

export function createSettingsHistory({ equal, limit = 200 } = {}) {
  if (typeof equal !== 'function') throw new Error('Settings history needs an equality test.');
  let entries = [], cursor = -1, expected = null;
  function accept(version, doc, { coalesce = false } = {}) {
    if (!Number.isInteger(version) || !doc) return;
    if (cursor >= 0 && (entries[cursor].version === version || (coalesce && equal(entries[cursor].doc, doc)))) {
      entries[cursor] = { version, doc: clone(doc) }; return;
    }
    if (expected && equal(entries[expected.index]?.doc, doc)) {
      // The undone or redone document came back as a new version: move, keep both sides.
      cursor = expected.index; entries[cursor] = { version, doc: clone(doc) }; expected = null; return;
    }
    expected = null;
    entries = entries.slice(0, cursor + 1); entries.push({ version, doc: clone(doc) });
    if (entries.length > limit) entries.shift();
    cursor = entries.length - 1;
  }
  function step(offset) {
    const index = cursor + offset;
    if (cursor < 0 || index < 0 || index >= entries.length) return null;
    expected = { index };
    return clone(entries[index].doc);
  }
  return {
    accept,
    undo: () => step(-1),
    redo: () => step(1),
    clear() { entries = []; cursor = -1; expected = null; },
    get snapshot() { return { undo: Math.max(0, cursor), redo: Math.max(0, entries.length - cursor - 1), versions: entries.map(entry => entry.version), cursor }; },
  };
}

/** Ctrl or Cmd with Z (Shift: redo) or Y, outside text fields: 'undo', 'redo' or null. */
export function historyShortcut(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.target?.isContentEditable ||
      /^(INPUT|SELECT|TEXTAREA)$/i.test(event.target?.tagName || '')) return null;
  const key = event.key.toLowerCase();
  return key === 'z' ? (event.shiftKey ? 'redo' : 'undo') : key === 'y' ? 'redo' : null;
}
