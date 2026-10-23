export function isStartingScene(recording) {
  return recording.source?.bootstrap === true && Array.isArray(recording.trajectories) && recording.trajectories.length === 0;
}

export function recordingLabel(item, items = []) {
  const duplicate = items.some((other) => other.id !== item.id && other.name === item.name);
  const namespace = item.source === 'upload' ? 'uploads' : item.source;
  return duplicate && namespace && namespace !== 'default' ? `${namespace}/${item.name}` : item.name;
}

// A direct link names a recording by its library path without ".npz"; uploads
// carry an "uploads/" prefix. It is only ever matched against the catalog, so a
// link cannot reach a file outside the configured library roots.
export function replayLinkKey(item) {
  if (!item || item.source === 'default' || item.source === 'freeze' || !item.name) return null;
  return item.source === 'upload' ? `uploads/${item.name}` : item.name;
}

export function findLinkedItem(items, key) {
  if (!key) return undefined;
  return items.find((item) => item.source === 'ingest' && replayLinkKey(item) === key)
    || items.find((item) => item.source === 'upload' && replayLinkKey(item) === key);
}

export function linkedKey(href) {
  const key = new URL(href).searchParams.get('replay');
  return key ? key : null;
}

export function replayLinkUrl(href, key) {
  const url = new URL(href);
  url.searchParams.delete('replay');
  const rest = url.searchParams.toString();
  const base = `${url.origin}${url.pathname}`;
  const params = [rest, key ? `replay=${encodeURIComponent(key).replace(/%2F/g, '/')}` : ''].filter(Boolean).join('&');
  return `${base}${params ? `?${params}` : ''}${url.hash}`;
}

// Tooltip of the marker shown when a recording names another full-URDF file
// than the displayed one (joints and frames were still checked).
export function modelWarningText(warning) {
  if (!warning) return '';
  return 'Recorded with a different robot-model file than the one displayed.\n'
    + `Recorded: ${warning.recorded_model_sha256}\nDisplayed: ${warning.current_model_sha256}`;
}

export function itemRevision(item) {
  if (!item) return null;
  return JSON.stringify(Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))));
}

export function uploadPath(file) {
  const path = file.webkitRelativePath || file.name;
  if (!path || !/\.npz$/i.test(path)) throw new Error('Choose compressed .npz recordings.');
  return path;
}

export function validateReference(trajectory) {
  const times = trajectory.reference_time_s;
  const points = trajectory.reference_xyz;
  if (times == null && points == null) return;
  if (!Array.isArray(times) || !times.length || !Array.isArray(points) || points.length !== times.length) {
    throw new Error('The recording has invalid reference samples.');
  }
  times.forEach((time, i) => {
    if (!Number.isFinite(time) || (i > 0 && time <= times[i - 1]) || !Array.isArray(points[i]) || points[i].length !== 3 || !points[i].every(Number.isFinite)) {
      throw new Error('The recording has invalid reference timestamps or points.');
    }
  });
}

export function referencePosition(trajectory, time) {
  const times = trajectory.reference_time_s;
  const points = trajectory.reference_xyz;
  if (!times?.length || !points?.length) return trajectory.target_xyz?.length === 3 ? [...trajectory.target_xyz] : null;
  if (time <= times[0]) return [...points[0]];
  const last = times.length - 1;
  if (time >= times[last]) return [...points[last]];
  let low = 0, high = last;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (times[mid] <= time) low = mid;
    else high = mid;
  }
  const fraction = (time - times[low]) / (times[high] - times[low]);
  return points[low].map((value, i) => value + fraction * (points[high][i] - value));
}

export function playbackClock(trajectory) {
  const basis = trajectory.metadata?.time_basis || trajectory.time_basis;
  return basis === 'wall' ? 'wall' : basis === 'simulation' ? 'simulation' : 'recorded';
}

export function setupReplayLibrary({ onScene, initialId = 'default', initialName = 'Starting pose' }) {
  const $ = (id) => document.getElementById(id);
  let selectedId = initialId;
  let selectedItem = { id: initialId, name: initialName, path: '', status: 'ready' };
  let selectedRevision;
  let items = [];
  let loading = false;
  let uploading = false;
  let refreshPending = false;
  let disposed = false;
  let selectionRequest = 0;
  let lastChoices = '';
  let timer;
  let pendingLink = linkedKey(location.href);
  let attemptedLink = '';
  let liveMode = false;
  const syncUrl = () => {
    if (pendingLink) return;
    const key = liveMode ? null : replayLinkKey(selectedItem);
    const next = replayLinkUrl(location.href, key);
    if (next !== location.href) history.replaceState(history.state, '', next);
    $('recording-link').hidden = !key;
  };
  const copyLink = async () => {
    const text = replayLinkUrl(location.href, replayLinkKey(selectedItem));
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch {}
    if (!copied) {
      // Plain-HTTP LAN origins are not secure contexts, so the async API is unavailable there.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;opacity:0';
      document.body.append(area);
      area.select();
      try { copied = document.execCommand('copy'); } catch {}
      area.remove();
    }
    const button = $('recording-link');
    const label = 'Copy a direct link to this recording';
    button.classList.toggle('copied', copied);
    button.classList.toggle('copy-failed', !copied);
    button.title = copied ? `Copied ${text}` : 'Copy failed';
    setTimeout(() => {
      button.classList.remove('copied', 'copy-failed');
      button.title = label;
    }, 1500);
  };
  const notify = (message, error = false) => {
    $('library-message').textContent = message;
    $('library-message').classList.toggle('error', error);
  };
  const updateSelection = () => {
    const latest = items.find((item) => item.id === selectedId);
    const changed = latest && selectedRevision != null && itemRevision(latest) !== selectedRevision;
    $('recording-reload').hidden = !changed;
    $('recording-reload').disabled = loading || latest?.status !== 'ready';
    $('recording-select').disabled = loading;
    const duplicate = items.some((item) => item.id !== selectedItem.id && item.name === selectedItem.name);
    const namespace = selectedItem.source === 'upload' ? 'uploads' : selectedItem.source;
    const path = selectedItem.path || selectedItem.name;
    const displayedPath = duplicate && namespace && namespace !== 'default' ? `${namespace}/${path}` : path;
    $('recording-path').textContent = displayedPath;
    $('recording-path').title = displayedPath;
    const warning = $('recording-model-warning');
    warning.hidden = !selectedItem.model_warning;
    warning.title = modelWarningText(selectedItem.model_warning);
    warning.setAttribute('aria-label', warning.title);
    if (changed) {
      $('recording-update').textContent = latest.status === 'ready'
        ? 'This recording changed. Reload when ready; playback keeps its loaded copy.'
        : `The updated file could not load: ${latest.error || 'invalid recording'}. Playback keeps its loaded copy.`;
    } else if (!latest && items.length) {
      $('recording-update').textContent = 'This recording is no longer in the library. Playback keeps its loaded copy.';
    } else $('recording-update').textContent = '';
  };
  const render = () => {
    const listed = [...items];
    const currentIndex = listed.findIndex((item) => item.id === selectedId);
    if (currentIndex < 0 || listed[currentIndex].status !== 'ready') {
      if (currentIndex >= 0) listed.splice(currentIndex, 1);
      listed.unshift({ ...selectedItem, status: 'ready', snapshot: true });
    }
    const descriptor = JSON.stringify(listed.map((item) => [item.id, item.name, item.source, item.status, Boolean(item.snapshot), Boolean(item.model_warning)]));
    if (descriptor !== lastChoices) {
      $('recording-select').replaceChildren(...listed.map((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = `${recordingLabel(item, listed)}${item.snapshot ? ' · loaded copy' : item.status !== 'ready' ? ' · unreadable' : ''}${item.model_warning ? ' ⚠' : ''}`;
        option.disabled = item.status !== 'ready';
        return option;
      }));
      lastChoices = descriptor;
    }
    $('recording-select').value = selectedId;
    const failures = items.filter((item) => item.status === 'error');
    $('library-errors').hidden = !failures.length;
    $('library-errors-summary').textContent = `${failures.length} unreadable recording${failures.length === 1 ? '' : 's'}`;
    $('library-errors-list').replaceChildren(...failures.map((item) => {
      const row = document.createElement('li');
      row.textContent = `${recordingLabel(item, items)}: ${item.error || 'Cannot read this recording.'}`;
      return row;
    }));
    updateSelection();
    syncUrl();
  };
  const refresh = async () => {
    if (disposed || refreshPending) return;
    refreshPending = true;
    try {
      const response = await fetch('/api/replays');
      const catalog = await response.json();
      if (!response.ok || !Array.isArray(catalog.items)) throw new Error(catalog.error || 'The recording library could not load.');
      items = catalog.items;
      const current = items.find((item) => item.id === selectedId);
      if (selectedRevision == null && current) { selectedItem = current; selectedRevision = itemRevision(current); }
      render();
      await openLinked();
    } catch (error) {
      if (!uploading) notify(`Library unavailable: ${error.message} Current playback is retained.`, true);
    } finally {
      refreshPending = false;
    }
  };
  // Opens the recording named by the address bar once the catalog lists it. A
  // missing or unreadable file keeps the link pending and shows the library's
  // usual error; it is retried when the catalog entry changes (for example
  // after a producer finishes writing it).
  const openLinked = async () => {
    if (!pendingLink || loading || uploading) return;
    const key = pendingLink;
    const item = findLinkedItem(items, key);
    const state = item ? `${item.id}:${item.revision}` : 'missing';
    if (state === attemptedLink) return;
    attemptedLink = state;
    if (!item) {
      notify(`Linked recording ${key} is not in the library. The link opens it once it appears.`, true);
    } else if (item.status !== 'ready') {
      notify(`Could not open linked recording ${key}: ${item.error || 'invalid recording'}`, true);
    } else {
      if (await choose(item.id)) { if (pendingLink === key) pendingLink = null; }
      else attemptedLink = '';
      render();
    }
  };
  const choose = async (id, reload = false) => {
    if (loading || (id === selectedId && !reload)) return false;
    const item = items.find((entry) => entry.id === id);
    if (!item || item.status !== 'ready') { $('recording-select').value = selectedId; return false; }
    loading = true;
    updateSelection();
    const request = ++selectionRequest;
    notify(`Opening ${item.name}…`);
    try {
      const response = await fetch(`/api/replays/scene?id=${encodeURIComponent(id)}`);
      const next = await response.json();
      if (!response.ok) throw new Error(next.error || next.detail || 'The recording could not load.');
      if (request !== selectionRequest || disposed) return;
      await onScene(next, item);
      selectedId = id;
      selectedItem = item;
      selectedRevision = itemRevision(item);
      notify(''); // The selector shows what opened; only errors stay.
      return true;
    } catch (error) {
      notify(`Could not open ${item.name}: ${error.message} Current playback is retained.`, true);
      return false;
    } finally {
      loading = false;
      render();
    }
  };
  const uploadFiles = async (files) => {
    if (uploading) return;
    const npz = [...files].filter((file) => /\.npz$/i.test(file.webkitRelativePath || file.name));
    if (!npz.length) { notify('Choose compressed .npz recordings or a folder containing them.', true); return; }
    uploading = true;
    $('upload-files').disabled = $('upload-folder').disabled = true;
    let added = 0;
    const errors = [];
    for (const [index, file] of npz.entries()) {
      const path = uploadPath(file);
      notify(`Uploading ${index + 1} / ${npz.length} · ${path}`);
      try {
        const response = await fetch(`/api/replays/upload?path=${encodeURIComponent(path)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
        });
        const result = await response.json();
        if (!response.ok || !result.accepted) throw new Error(result.error || 'Upload failed.');
        added++;
      } catch (error) { errors.push(`${path}: ${error.message}`); }
    }
    uploading = false;
    $('upload-files').disabled = $('upload-folder').disabled = false;
    $('recording-files').value = $('recording-folder').value = '';
    await refresh();
    notify(`${added} recording${added === 1 ? '' : 's'} added.${errors.length ? ` ${errors.join(' · ')}` : ''}`, errors.length > 0);
  };
  $('recording-select').addEventListener('change', (event) => { pendingLink = null; choose(event.target.value); });
  $('recording-link').addEventListener('click', copyLink);
  $('recording-reload').addEventListener('click', () => choose(selectedId, true));
  $('upload-files').addEventListener('click', () => $('recording-files').click());
  $('upload-folder').addEventListener('click', () => $('recording-folder').click());
  $('recording-files').addEventListener('change', (event) => uploadFiles(event.target.files));
  $('recording-folder').addEventListener('change', (event) => uploadFiles(event.target.files));
  render();
  refresh();
  const poll = async () => { await refresh(); if (!disposed) timer = setTimeout(poll, 1500); };
  timer = setTimeout(poll, 1500);
  return {
    refresh,
    get selectedId() { return selectedId; },
    get items() { return items.map((item) => ({...item})); },
    get loading() { return loading; },
    // Live mode has no replay selection, so its address carries no replay link.
    setLive(live) { liveMode = Boolean(live); syncUrl(); },
    dispose() { disposed = true; clearTimeout(timer); selectionRequest++; },
  };
}
