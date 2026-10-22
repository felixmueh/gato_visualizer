// Docked plot strip heights: pure layout rules for the rows between the 3D
// viewport and the timeline ruler. The strip is exactly as tall as its plots;
// every resize changes plot heights (so y-axes rescale), never only a
// container. The viewport keeps STRIP_VIEWPORT_MIN pixels.
export const STRIP_VIEWPORT_MIN = 100, STRIP_PLOT_MIN = 40, STRIP_PLOT_DEFAULT = 85, STRIP_CARD_CHROME = 36;

/** Pixels the strip may take: its current height plus what the viewport can give up. */
export function stripRoom({ rowsHeight = 0, viewportHeight, viewportMin = STRIP_VIEWPORT_MIN } = {}) {
  if (!Number.isFinite(viewportHeight)) return Infinity;
  return Math.max(0, Math.round(rowsHeight + viewportHeight - viewportMin));
}

const plotRoom = (room, chrome) => Math.max(0, room - chrome);
const sum = values => values.reduce((total, value) => total + value, 0);

/** Displayed plot heights for stored ones (undefined: default). They are the
 * stored heights unless the strip would exceed its room; then all scale down
 * together, not below the minimum. Stored heights are never changed here. */
export function fitStripHeights(stored, { room = Infinity, chrome = 0, min = STRIP_PLOT_MIN, fallback = STRIP_PLOT_DEFAULT } = {}) {
  const heights = stored.map(value => Number.isFinite(value) && value > 0 ? Math.max(min, value) : fallback);
  const available = plotRoom(room, chrome), total = sum(heights);
  if (!(total > available)) return heights;
  return trim(heights.map(value => Math.max(min, Math.floor(value * available / total))), available, min);
}

/** A card's bottom handle moved by delta (down positive): only that card
 * changes, in the mouse's direction, until the strip fills its room. */
export function resizeStripCard(displayed, index, delta, { room = Infinity, chrome = 0, min = STRIP_PLOT_MIN } = {}) {
  const others = sum(displayed) - displayed[index], high = Math.max(min, plotRoom(room, chrome) - others);
  return Math.round(Math.max(min, Math.min(high, displayed[index] + delta)));
}

/** The panel's top edge moved by delta (up positive): all plots scale
 * together so the strip grows or shrinks by delta within its room. */
export function resizeStrip(displayed, delta, { room = Infinity, chrome = 0, min = STRIP_PLOT_MIN } = {}) {
  const total = sum(displayed);
  if (!displayed.length || !(total > 0)) return [...displayed];
  const limit = Math.max(min * displayed.length, plotRoom(room, chrome));
  const target = Math.max(min * displayed.length, Math.min(limit, total + delta));
  return trim(displayed.map(value => Math.max(min, Math.round(value * target / total))), Math.round(target), min);
}

// Rounding and minimum floors may overshoot a limit by a few pixels: take
// them from the tallest plots.
function trim(heights, limit, min) {
  let excess = sum(heights) - limit;
  while (excess > 0) {
    const index = heights.indexOf(Math.max(...heights));
    const take = Math.min(excess, heights[index] - min);
    if (take <= 0) break;
    heights[index] -= take; excess -= take;
  }
  return heights;
}
