// Settings transactions replace arrays/null and merge objects. Only changed
// leaves are sent, so an unrelated edit cannot restore an older agent value.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function settingsPatch(before, after) {
  const patch = {};
  for (const [key, value] of Object.entries(after)) {
    if (equal(before?.[key], value)) continue;
    // A task switch is a whole new task; the server supplies its defaults.
    patch[key] = object(value) && object(before?.[key]) && !(key === 'task' && before[key].kind !== value.kind)
      ? settingsPatch(before[key], value) : copy(value);
  }
  return patch;
}

// Preserve pending edits on untouched fields. A newer remote value wins when
// both writers changed a field, and a task-kind switch replaces the whole task.
export function rebaseSettings(before, draft, remote) {
  if (equal(before, remote)) return copy(draft);
  if (!object(before) || !object(draft) || !object(remote)) return copy(remote);
  if ('kind' in remote && remote.kind !== before.kind) return copy(remote);
  return Object.fromEntries(Object.entries(remote).map(([key, value]) =>
    [key, Object.hasOwn(draft, key) ? rebaseSettings(before[key], draft[key], value) : copy(value)]));
}
