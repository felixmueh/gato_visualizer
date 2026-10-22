// Draggable sidebar widths: pure limits and storage, plus the handle wiring.
export const SIDEBAR_STORAGE_KEY = 'sidebar-widths-v1';
export const SIDEBAR_MIN = 220, SIDEBAR_MAX = 560, VIEWPORT_MIN = 360;

// Clamp to the sidebar limits while the 3D viewport keeps VIEWPORT_MIN pixels
// next to the other (visible) sidebar. The viewport floor wins over SIDEBAR_MIN
// only on very narrow windows, where the layout falls back to overlays anyway.
export function clampSidebarWidth(width, { windowWidth, otherWidth = 0 } = {}) {
  if (!Number.isFinite(width)) return SIDEBAR_MIN;
  const room = Number.isFinite(windowWidth) ? windowWidth - otherWidth - VIEWPORT_MIN : Infinity;
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, room, width)));
}

export function loadSidebarWidths(storage) {
  try {
    const saved = JSON.parse(storage?.getItem(SIDEBAR_STORAGE_KEY) || '{}'), widths = {};
    for (const side of ['left', 'right']) if (Number.isFinite(saved?.[side])) widths[side] = clampSidebarWidth(saved[side]);
    return widths;
  } catch { return {}; }
}

export function saveSidebarWidths(storage, widths) {
  try { storage?.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(widths)); } catch { /* per-viewer convenience only */ }
}

// Handles sit on the inner edge of each sidebar. Widths live in the CSS
// variables --left-w and --right-w; without a stored width the stylesheet's
// responsive defaults apply. Double-click resets a side to that default.
export function setupSidebarResize({ shell, storage = globalThis.localStorage, onLayout = () => {}, window: win = globalThis.window } = {}) {
  const doc = shell.ownerDocument, widths = loadSidebarWidths(storage), handles = {};
  const hidden = side => shell.classList.contains(`${side}-hidden`);
  const sidebar = side => doc.getElementById(`${side}-sidebar`);
  const other = side => side === 'left' ? 'right' : 'left';
  const otherWidth = side => hidden(other(side)) ? 0 : sidebar(other(side)).getBoundingClientRect().width;
  const apply = () => {
    for (const side of ['left', 'right']) {
      if (widths[side] == null) { shell.style.removeProperty(`--${side}-w`); continue; }
      const width = clampSidebarWidth(widths[side], { windowWidth: win.innerWidth, otherWidth: otherWidth(side) });
      shell.style.setProperty(`--${side}-w`, `${width}px`);
    }
    onLayout();
  };
  for (const side of ['left', 'right']) {
    const handle = doc.createElement('div');
    handle.className = `sidebar-resize-handle ${side}`; handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', `Resize ${side} sidebar`); handle.title = 'Drag to resize · double-click to reset';
    handle.addEventListener('pointerdown', event => {
      if (event.button != null && event.button !== 0) return;
      event.preventDefault(); handle.setPointerCapture?.(event.pointerId); handle.classList.add('dragging');
      const startX = event.clientX, initial = sidebar(side).getBoundingClientRect().width, sign = side === 'left' ? 1 : -1;
      const move = next => { widths[side] = clampSidebarWidth(initial + sign * (next.clientX - startX), { windowWidth: win.innerWidth, otherWidth: otherWidth(side) }); apply(); };
      const end = () => {
        handle.classList.remove('dragging'); handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
        saveSidebarWidths(storage, widths);
      };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
    });
    handle.addEventListener('dblclick', () => { delete widths[side]; saveSidebarWidths(storage, widths); apply(); });
    shell.append(handle); handles[side] = handle;
  }
  win.addEventListener?.('resize', apply);
  apply();
  return { widths, apply, handles };
}
