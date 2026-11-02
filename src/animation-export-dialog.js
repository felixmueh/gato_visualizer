import { createFloatingDialog } from './floating-dialog.js';

const STORAGE_KEY = 'animation-export-settings';
const RESOLUTIONS = [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]];
const ORIENTATIONS = ['current', 'isometric', 'front', 'back', 'left', 'right', 'top'];
const DEFAULTS = { width: 1920, height: 1080, views: 'main', orientation: 'current' };

/** Export settings only. The caller freezes the session and camera in onExport. */
export function createAnimationExportDialog({ getContext = () => ({ canExport: true }), onExport, storage = globalThis.localStorage } = {}) {
  if (typeof onExport !== 'function') throw new Error('Animation export needs an onExport callback.');
  let saved;
  try { saved = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null'); } catch { /* Viewer preferences are optional. */ }
  const initial = { ...DEFAULTS };
  if (RESOLUTIONS.some(([width, height]) => saved?.width === width && saved?.height === height)) { initial.width = saved.width; initial.height = saved.height; }
  if (['main', 'main-principal'].includes(saved?.views)) initial.views = saved.views;
  if (ORIENTATIONS.includes(saved?.orientation)) initial.orientation = saved.orientation;

  const form = document.createElement('form'); form.className = 'animation-export-form';
  form.innerHTML = `
    <label>Resolution<select name="resolution" aria-label="Resolution">
      ${RESOLUTIONS.map(([width, height]) => `<option value="${height}">${height}p · ${width} × ${height}</option>`).join('')}
    </select></label>
    <label>Views<select name="views" aria-label="Views">
      <option value="main">Main view</option><option value="main-principal">Main + Top and Right</option>
    </select></label>
    <label>Main camera<select name="orientation" aria-label="Main camera">
      <option value="current">Current viewport</option><option value="isometric">Isometric</option>
      <option value="front">Front</option><option value="back">Back</option><option value="left">Left</option>
      <option value="right">Right</option><option value="top">Top</option>
    </select></label>
    <div class="animation-export-progress" hidden><progress max="1" value="0" aria-label="Export progress"></progress><span></span></div>
    <p class="animation-export-message" role="status" aria-live="polite"></p>
    <div class="animation-export-actions"><button type="button" data-action="cancel">Cancel</button><button type="submit" data-action="export">Export MP4</button></div>`;
  const resolution = form.querySelector('[name="resolution"]'), views = form.querySelector('[name="views"]'), orientation = form.querySelector('[name="orientation"]');
  for (const [select, value] of [[resolution, String(initial.height)], [views, initial.views], [orientation, initial.orientation]]) {
    for (const option of select.options) option.selected = false;
    [...select.options].find(option => option.value === value).selected = true;
  }
  const exportButton = form.querySelector('[data-action="export"]'), cancelButton = form.querySelector('[data-action="cancel"]');
  const message = form.querySelector('.animation-export-message'), progressBox = form.querySelector('.animation-export-progress');
  const progress = progressBox.querySelector('progress'), progressText = progressBox.querySelector('span');
  let controller = null, destroyed = false;
  const dialog = createFloatingDialog({ id: 'animation-export', title: 'Export animation', modal: true, content: form, storage,
    onClose: () => controller?.abort() });
  dialog.element.classList.add('animation-export-dialog');

  function options() {
    const [width, height] = RESOLUTIONS.find(([, height]) => String(height) === resolution.value) || RESOLUTIONS[1];
    return { width, height, views: views.value, orientation: orientation.value };
  }
  function refresh() {
    if (controller) return;
    const context = getContext() || {};
    exportButton.disabled = context.canExport === false;
    exportButton.title = context.canExport === false ? (context.reason || 'No animation to export.') : '';
    message.textContent = context.canExport === false ? exportButton.title : '';
    message.dataset.error = 'false';
  }
  function setBusy(busy) {
    for (const field of [resolution, views, orientation]) field.disabled = busy;
    exportButton.disabled = busy;
    form.setAttribute('aria-busy', String(busy));
    cancelButton.textContent = 'Cancel'; cancelButton.disabled = false;
  }
  function cancel() {
    if (!controller) { dialog.close(); return; }
    controller.abort(); cancelButton.disabled = true; progressText.textContent = 'Canceling…';
  }
  cancelButton.addEventListener('click', cancel);
  form.addEventListener('change', () => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(options())); } catch { /* Viewer preferences are optional. */ }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (controller || destroyed) return;
    refresh(); if (exportButton.disabled) return;
    const selected = options(), job = new AbortController(); controller = job;
    setBusy(true); message.textContent = ''; message.dataset.error = 'false'; progressBox.hidden = false; progress.value = 0; progressText.textContent = 'Preparing…';
    try {
      await onExport(selected, { signal: job.signal, onProgress: update => {
        if (controller !== job || job.signal.aborted || destroyed) return;
        const fraction = typeof update === 'number' ? update : update?.progress;
        if (Number.isFinite(fraction)) { progress.value = Math.max(0, Math.min(1, fraction)); progressText.textContent = `${Math.round(progress.value * 100)}%`; }
        if (update?.message) progressText.textContent = update.message;
      } });
      if (!job.signal.aborted && !destroyed) dialog.close();
    } catch (error) {
      if (!job.signal.aborted && !destroyed) { message.textContent = error?.message || 'Animation export failed.'; message.dataset.error = 'true'; }
    } finally {
      if (controller === job) {
        controller = null; setBusy(false); progressBox.hidden = true;
        if (message.dataset.error !== 'true') refresh();
      }
    }
  });
  refresh();
  return { ...dialog,
    open() { if (!controller) refresh(); dialog.open(); },
    refresh,
    get isOpen() { return dialog.isOpen; },
    get busy() { return controller !== null; },
    get options() { return options(); },
    destroy() { destroyed = true; controller?.abort(); dialog.destroy(); },
  };
}
