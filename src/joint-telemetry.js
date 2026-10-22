import { DEFAULT_LIMIT_USE, LIMIT_QUANTITIES, formatLimitDistance, limitBounds, quantityLimitUse } from './limit-use.js';

// Positions/velocities interpolate; actuator commands hold until the next command.
export function sampleTelemetry(trajectory, time) {
  const times = trajectory.time_s;
  let low = 0, high = times.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (times[mid] <= time) low = mid; else high = mid - 1;
  }
  let qd = null;
  if (trajectory.qd_rad_s?.length === times.length) {
    const next = Math.min(low + 1, times.length - 1);
    const fraction = next === low ? 0 : Math.max(0, Math.min(1, (time - times[low]) / (times[next] - times[low])));
    qd = trajectory.qd_rad_s[low].map((v, j) => v + (trajectory.qd_rad_s[next][j] - v) * fraction);
  }
  let torque = null;
  const torqueTimes = trajectory.torque_time_s || times;
  if (trajectory.torque_nm?.length && time >= torqueTimes[0] &&
      !(trajectory.torque_kind === 'predicted' && time >= (trajectory.torque_end_time_s ?? times.at(-1)))) {
    let a = 0, b = trajectory.torque_nm.length - 1;
    while (a < b) {
      const mid = Math.ceil((a + b) / 2);
      if (torqueTimes[mid] <= time) a = mid; else b = mid - 1;
    }
    torque = trajectory.torque_nm[a];
  }
  return {qd, torque};
}

// Per joint: a position range bar (marker, URDF end ticks, shaded near bands)
// and velocity/torque utilisation bars to a 100 % tick that overflow past it.
// The reference is the URDF limit; colours follow the 3D tint's states.
// Exact values, bounds and distances are in each gauge's tooltip, which appears
// at once on hover (see createGaugeTooltip). The Numbers view shows the same
// values as text in the same cells, coloured by the same states.
const SCALE = 0.86; // Share of a utilisation bar up to its 100 % tick; the rest shows overflow.
const POSITION_INSET = 0.07; // Space beyond each position bound for a marker beyond it.
const MEANING = { position: 'Native joint position', velocity: 'Recorded joint velocity' };
export const DIGITS = { position: 3, velocity: 3, torque: 2 };
export const signed = (value, digits) => `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(digits)}`;
const percent = value => `${Math.round(value * 100)} %`;

export function headingTitle(settings = DEFAULT_LIMIT_USE) {
  return `Limit use against the URDF limits. Position: range with the current value; velocity and torque: |value| up to the 100 % tick. Shaded/amber: near (≥ ${settings.limit_near_percent} %); red: at the limit; red outlined: beyond. —: unavailable`;
}

function el(doc, tag, className) { const item = doc.createElement(tag); if (className) item.className = className; return item; }

export const JOINT_VIEWS = Object.freeze(['gauges', 'numbers']);
export const JOINT_VIEW_KEY = 'joint-view-v1';
export function loadJointView(storage) {
  try { const view = storage?.getItem(JOINT_VIEW_KEY); return JOINT_VIEWS.includes(view) ? view : 'gauges'; } catch { return 'gauges'; }
}
export function saveJointView(storage, view) {
  try { storage?.setItem(JOINT_VIEW_KEY, view); } catch { /* per-viewer convenience only */ }
}

// Segmented Gauges/Numbers control. The choice lives on the container as
// data-view (CSS shows one presentation) and is remembered per viewer.
export function setupJointViewToggle({ container, buttons, storage = globalThis.localStorage }) {
  const apply = view => {
    container.dataset.view = view;
    for (const [name, button] of Object.entries(buttons)) { button.setAttribute('aria-pressed', String(name === view)); button.classList?.toggle('active', name === view); }
  };
  for (const [name, button] of Object.entries(buttons)) button.addEventListener('click', () => { apply(name); saveJointView(storage, name); });
  apply(loadJointView(storage));
  return apply;
}

function createGauge(doc, quantity) {
  const gauge = el(doc, 'span', 'limit-gauge'); gauge.dataset.quantity = quantity;
  const track = el(doc, 'span', 'limit-gauge-track');
  const parts = { gauge, track, text: el(doc, 'span', 'limit-gauge-text') };
  if (quantity === 'position') {
    parts.nearLow = el(doc, 'span', 'limit-gauge-near'); parts.nearHigh = el(doc, 'span', 'limit-gauge-near');
    parts.tickLow = el(doc, 'span', 'limit-gauge-tick'); parts.tickHigh = el(doc, 'span', 'limit-gauge-tick');
    parts.marker = el(doc, 'span', 'limit-gauge-marker');
    parts.tickLow.style.left = `${POSITION_INSET * 100}%`; parts.tickHigh.style.left = `${(1 - POSITION_INSET) * 100}%`;
    track.append(parts.nearLow, parts.nearHigh, parts.tickLow, parts.tickHigh, parts.marker);
  } else {
    parts.near = el(doc, 'span', 'limit-gauge-near'); parts.fill = el(doc, 'span', 'limit-gauge-fill');
    parts.over = el(doc, 'span', 'limit-gauge-over'); parts.tick = el(doc, 'span', 'limit-gauge-tick');
    parts.tick.style.left = `${SCALE * 100}%`; parts.over.style.left = `${SCALE * 100}%`;
    track.append(parts.near, parts.fill, parts.over, parts.tick);
  }
  gauge.append(track, parts.text);
  return parts;
}

export function createJointTable(container, names) {
  const doc = container.ownerDocument;
  const heading = el(doc, 'div', 'joint-row joint-columns');
  // Colour is the cue; its meaning is a hover away.
  heading.title = headingTitle();
  for (const [text, unit] of [['JOINT'], ['POS', 'rad'], ['VEL', 'rad/s'], ['TORQUE', 'N m']]) {
    const cell = Object.assign(el(doc, 'span'), { textContent: text });
    if (unit) cell.append(Object.assign(el(doc, 'small', 'joint-unit'), { textContent: ` ${unit}` }));
    heading.append(cell);
  }
  container.replaceChildren(heading);
  const rows = names.map((name, i) => {
    const row = el(doc, 'div', 'joint-row');
    const label = el(doc, 'span', 'joint-name'); label.textContent = `J${i + 1}`; label.title = name; row.append(label);
    const gauges = LIMIT_QUANTITIES.map(quantity => { const parts = createGauge(doc, quantity); row.append(parts.gauge); return parts; });
    container.append(row); return gauges;
  });
  rows.heading = heading;
  rows.tooltip = createGaugeTooltip(container);
  return rows;
}

const range = (bounds, unit) => `${signed(bounds[0], 3)} … ${signed(bounds[1], 3)} ${unit}`;

export function gaugeTip(quantity, value, use, { limits, mpcBounds, index, torqueKind }) {
  const meaning = quantity === 'torque' ? (torqueKind === 'predicted' ? 'Predicted actuator torque' : 'Last applied actuator torque') : MEANING[quantity];
  const unit = { position: 'rad', velocity: 'rad/s', torque: 'Nm' }[quantity];
  const parts = [Number.isFinite(value) ? `${meaning} ${signed(value, DIGITS[quantity])} ${unit}` : `${meaning} unavailable`];
  const urdf = limitBounds(limits, quantity, index);
  parts.push(urdf ? `URDF ${quantity === 'position' ? range(urdf, unit) : `±${urdf[1]} ${unit}`}` : 'URDF limit unavailable');
  if (use) parts.push(`${percent(use.utilisation)} · ${use.state} · ${formatLimitDistance(use)}`);
  const mpc = limitBounds(mpcBounds, quantity, index);
  if (mpc) parts.push(`MPC bound ${quantity === 'position' ? range(mpc, unit) : `±${Number(mpc[1].toPrecision(4))} ${unit}`}`);
  return parts.join('\n');
}

function updateGauge(parts, quantity, value, context) {
  const { limits, index, settings } = context;
  const use = quantityLimitUse(quantity, value, limits, index, settings);
  const { gauge } = parts;
  gauge.dataset.state = use ? use.state : Number.isFinite(value) ? 'unbounded' : 'missing';
  parts.track.hidden = !use;
  // The text is the Numbers view's cell; the Gauges view shows it only where no bar can be drawn.
  parts.text.textContent = Number.isFinite(value) ? signed(value, DIGITS[quantity]) : '—';
  gauge.dataset.tip = gaugeTip(quantity, value, use, context);
  gauge.setAttribute('aria-label', use ? `${quantity} ${parts.text.textContent}, ${percent(use.utilisation)} of URDF limit, ${use.state}` : `${quantity} ${parts.text.textContent === '—' ? 'unavailable' : parts.text.textContent}`);
  if (!use) return;
  const near = settings.limit_near_percent / 100;
  if (quantity === 'position') {
    const span = 1 - 2 * POSITION_INSET, band = (1 - near) / 2 * span;
    parts.nearLow.style.left = `${POSITION_INSET * 100}%`; parts.nearLow.style.width = `${band * 100}%`;
    parts.nearHigh.style.left = `${(1 - POSITION_INSET - band) * 100}%`; parts.nearHigh.style.width = `${band * 100}%`;
    const fraction = (value - use.lower) / (use.upper - use.lower);
    parts.marker.style.left = `${Math.max(0, Math.min(1, POSITION_INSET + fraction * span)) * 100}%`;
  } else {
    parts.near.style.left = `${near * SCALE * 100}%`; parts.near.style.width = `${(1 - near) * SCALE * 100}%`;
    parts.fill.style.width = `${Math.min(1, use.utilisation) * SCALE * 100}%`;
    parts.over.style.width = `${Math.max(0, Math.min(1 - SCALE, (use.utilisation - 1) * SCALE)) * 100}%`;
  }
}

export function updateJointTable(rows, { q, qd, torque, limits, mpcBounds = null, torqueKind = 'applied', settings = DEFAULT_LIMIT_USE }) {
  settings = { ...DEFAULT_LIMIT_USE, ...settings };
  if (rows.heading) rows.heading.title = headingTitle(settings);
  rows.forEach((gauges, index) => {
    const values = [q?.[index], qd?.[index], torque?.[index]];
    gauges.forEach((parts, j) => updateGauge(parts, LIMIT_QUANTITIES[j], values[j], { limits, mpcBounds, index, torqueKind, settings }));
  });
  rows.tooltip?.refresh();
}

// One shared tooltip, shown at the pointer without the native title delay.
// It reads each gauge's data-tip, so it follows the playback cursor while
// hovered; its border takes the gauge's state like the 3D tint's tooltip.
export function createGaugeTooltip(container) {
  const doc = container.ownerDocument, tip = el(doc, 'div', 'limit-tint-tooltip gauge-tooltip');
  tip.setAttribute('role', 'tooltip'); tip.hidden = true;
  doc.body?.append(tip);
  let current = null, x = 0, y = 0;
  const place = () => {
    const width = tip.getBoundingClientRect?.().width ?? 0, height = tip.getBoundingClientRect?.().height ?? 0;
    const view = doc.defaultView, room = view?.innerWidth ?? Infinity, roomY = view?.innerHeight ?? Infinity;
    tip.style.left = `${Math.max(4, x + 14 + width > room ? x - 14 - width : x + 14)}px`;
    tip.style.top = `${Math.max(4, y + 14 + height > roomY ? y - 14 - height : y + 14)}px`;
  };
  const show = () => {
    if (!current?.dataset.tip) { tip.hidden = true; return; }
    tip.textContent = current.dataset.tip; tip.dataset.state = current.dataset.state; tip.hidden = false; place();
  };
  const target = event => event.target?.closest?.('.limit-gauge') ?? null;
  container.addEventListener?.('pointermove', event => { current = target(event); x = event.clientX; y = event.clientY; show(); });
  container.addEventListener?.('pointerleave', () => { current = null; tip.hidden = true; });
  return { element: tip, refresh() { if (current) show(); }, show: (gauge, at = {}) => { current = gauge; x = at.x ?? 0; y = at.y ?? 0; show(); } };
}
