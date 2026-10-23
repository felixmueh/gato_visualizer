import { DEFAULT_LIMIT_USE, LIMIT_QUANTITIES, formatLimitDistance, limitBounds, quantityLimitUse } from './limit-use.js';
import { createResetButton, RESET_ICON } from './setting-resets.js';

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

// The lock left of Gauges/Numbers (Felix, 2026-10-23). Locked, the default, the
// Joints tab is read-only. Unlocked, in Live at t = 0, the position gauges (drag)
// and Numbers cells (type, Enter) edit the start pose. Remembered per viewer.
export const JOINT_LOCK_KEY = 'joint-lock-v1';
export function loadJointLock(storage) {
  try { return storage?.getItem(JOINT_LOCK_KEY) !== 'unlocked'; } catch { return true; }
}
export function saveJointLock(storage, locked) {
  try { storage?.setItem(JOINT_LOCK_KEY, locked ? 'locked' : 'unlocked'); } catch { /* per-viewer convenience only */ }
}
const LOCK_ICON = (open) => `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="9" width="11" height="8" rx="1.5"/><path d="${open ? 'M7 9V6.5a3 3 0 0 1 5.9-.8' : 'M7 9V6.5a3 3 0 0 1 6 0V9'}"/></svg>`;

export function setupJointLock({ button, rows, storage = globalThis.localStorage, onChange = () => {} }) {
  const apply = locked => {
    rows.locked = locked; rows.lockButton = button;
    button.dataset.locked = String(locked); button.setAttribute('aria-pressed', String(!locked));
    button.setAttribute('aria-label', locked ? 'Unlock the start pose for editing' : 'Lock the joints');
    button.innerHTML = LOCK_ICON(!locked);
    refreshLock(rows);
  };
  button.addEventListener('click', () => { apply(!rows.locked); saveJointLock(storage, rows.locked); onChange(rows.locked); });
  apply(loadJointLock(storage));
  return apply;
}

function refreshLock(rows) {
  const button = rows.lockButton;
  if (!button) return;
  button.title = rows.locked ? 'Locked: the joints are read-only. Unlock to set the start pose.'
    : 'Unlocked: in Live at t = 0, drag a position or type it to set the start pose; a new run starts there. Click to lock.';
}

// The start-pose Reset beside the lock (Felix, 2026-10-23): always shown, locked or
// not; disabled while the start pose is the default (or cannot be set now), else it
// returns the whole start pose to the default as one settings change.
const jointLabel = (pose, i) => `J${i + 1} ${signed(pose.value[i], 3)} rad (default ${signed(pose.defaults[i], 3)})`;
function refreshStartReset(rows) {
  const button = rows.startReset, pose = rows.startPose;
  if (!button) return;
  const changed = pose ? pose.value.flatMap((v, i) => Math.abs(v - pose.defaults[i]) > 1e-9 ? [jointLabel(pose, i)] : []) : [];
  const enabled = changed.length > 0 && pose.editable;
  button.disabled = !enabled;
  button.title = !pose ? 'Reset the start pose to the default (Live only)'
    : !changed.length ? 'The start pose is the default'
    : `Reset the start pose to the default; a new run starts there at t = 0.\nDiffers: ${changed.join(', ')}`
      + (pose.editable ? '' : '\nAvailable at t = 0, paused or stopped, in Live.');
}

// While the start pose is edited: the planning box is the URDF range shrunk by the
// MPC's joint margin; a start pose outside it is allowed and flagged.
export const OUTSIDE_PLANNING = 'Outside the MPC planning box (URDF limits less the joint margin): '
  + 'the run starts here anyway; its first plans report a position-row violation while they move the joint back inside. '
  + 'Stop on breach checks only the URDF limits.';
const startEditing = rows => Boolean(rows.startPose?.editable && !rows.locked);
const roundRad = value => Math.round(value * 1e4) / 1e4;
const withJoint = (q, index, value) => q.map((item, i) => i === index ? value : item);

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

// onStartPoseDraft(q | null) shows a dragged start pose in the scene (null: back to
// the shown state); onStartPoseCommit(q) sets it: one settings change per release,
// Enter or reset arrow, never one per pointer move.
export function createJointTable(container, names, { onStartPoseDraft = () => {}, onStartPoseCommit = () => {}, resetButton = null } = {}) {
  const doc = container.ownerDocument;
  const heading = el(doc, 'div', 'joint-row joint-columns');
  // Colour is the cue; its meaning is a hover away.
  heading.title = headingTitle();
  const labels = [];
  for (const [text, unit] of [['JOINT'], ['POS', 'rad'], ['VEL', 'rad/s'], ['TORQUE', 'N m']]) {
    const cell = el(doc, 'span'), label = Object.assign(el(doc, 'span', 'joint-heading-label'), { textContent: text });
    cell.append(label); labels.push(label);
    if (unit) cell.append(Object.assign(el(doc, 'small', 'joint-unit'), { textContent: ` ${unit}` }));
    heading.append(cell);
  }
  container.replaceChildren(heading);
  const rows = names.map((name, i) => {
    const row = el(doc, 'div', 'joint-row');
    const label = el(doc, 'span', 'joint-name'); label.textContent = `J${i + 1}`; label.title = name; row.append(label);
    const gauges = LIMIT_QUANTITIES.map(quantity => { const parts = createGauge(doc, quantity); row.append(parts.gauge); return parts; });
    const reset = createResetButton(doc, `config.plant.start_pose_rad.${i}`, `J${i + 1} start pose`);
    reset.hidden = true; label.append(reset);
    const input = el(doc, 'input', 'limit-gauge-input'); input.type = 'number'; input.step = '0.001'; input.disabled = true;
    input.setAttribute('aria-label', `J${i + 1} start pose (rad)`); gauges[0].gauge.append(input);
    Object.assign(gauges, { row, name, label, reset, input });
    container.append(row); return gauges;
  });
  if (resetButton) { resetButton.innerHTML = RESET_ICON; resetButton.setAttribute('aria-label', 'Reset the start pose to the default'); }
  Object.assign(rows, { heading, container, positionLabel: labels[1], startReset: resetButton, locked: true, startPose: null });
  rows.tooltip = createGaugeTooltip(container);

  const pose = () => rows.startPose;
  const commit = q => { if (q.some((v, i) => Math.abs(v - pose().value[i]) > 1e-12)) onStartPoseCommit(q); };
  resetButton?.addEventListener('click', event => {
    event.preventDefault();
    if (pose()?.editable && !resetButton.disabled) commit([...pose().defaults]);
  });
  rows.forEach((gauges, index) => {
    const { reset, input } = gauges, position = gauges[0];
    reset.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (startEditing(rows)) commit(withJoint(pose().value, index, pose().defaults[index]));
    });
    const clamp = value => Math.max(pose().lower[index], Math.min(pose().upper[index], value));
    // Numbers: commit on Enter or leaving the field; Escape restores the start pose.
    const revert = () => { if (pose()) input.value = pose().value[index].toFixed(DIGITS.position); };
    input.addEventListener('change', () => {
      if (!startEditing(rows)) return;
      const value = Number(input.value);
      if (!input.value.trim() || !Number.isFinite(value)) { revert(); return; }
      const next = clamp(value); input.value = next.toFixed(DIGITS.position);
      commit(withJoint(pose().value, index, next));
    });
    input.addEventListener('keydown', event => { if (event.key === 'Escape') { revert(); input.blur?.(); } });
    // Gauges: drag the position marker anywhere on its track, clamped to the URDF range.
    let drag = null;
    position.gauge.addEventListener('pointerdown', event => {
      if (!startEditing(rows) || event.button !== 0 || position.track.hidden) return;
      const rect = position.track.getBoundingClientRect(), { lower, upper } = pose();
      const at = x => roundRad(clamp(lower[index] + ((x - rect.left) / rect.width - POSITION_INSET) / (1 - 2 * POSITION_INSET) * (upper[index] - lower[index])));
      drag = { start: [...pose().value], at, q: null };
      position.gauge.setPointerCapture?.(event.pointerId); event.preventDefault();
      drag.q = withJoint(drag.start, index, at(event.clientX)); onStartPoseDraft(drag.q);
    });
    position.gauge.addEventListener('pointermove', event => {
      if (!drag) return;
      const q = withJoint(drag.start, index, drag.at(event.clientX));
      if (q[index] !== drag.q[index]) { drag.q = q; onStartPoseDraft(q); }
    });
    const end = cancelled => () => {
      if (!drag) return;
      const { start, q } = drag; drag = null;
      onStartPoseDraft(null);
      if (!cancelled && q[index] !== start[index]) onStartPoseCommit(q);
    };
    position.gauge.addEventListener('pointerup', end(false));
    position.gauge.addEventListener('pointercancel', end(true));
  });
  return rows;
}

const range = (bounds, unit) => `${signed(bounds[0], 3)} … ${signed(bounds[1], 3)} ${unit}`;

export function gaugeTip(quantity, value, use, { limits, mpcBounds, index, torqueKind, startPose = null }) {
  const meaning = quantity === 'torque' ? (torqueKind === 'predicted' ? 'Predicted actuator torque' : 'Last applied actuator torque')
    : quantity === 'position' && startPose ? 'Start pose' : MEANING[quantity];
  const unit = { position: 'rad', velocity: 'rad/s', torque: 'Nm' }[quantity];
  const parts = [Number.isFinite(value) ? `${meaning} ${signed(value, DIGITS[quantity])} ${unit}` : `${meaning} unavailable`];
  const urdf = limitBounds(limits, quantity, index);
  parts.push(urdf ? `URDF ${quantity === 'position' ? range(urdf, unit) : `±${urdf[1]} ${unit}`}` : 'URDF limit unavailable');
  if (use) parts.push(`${percent(use.utilisation)} · ${use.state} · ${formatLimitDistance(use)}`);
  const mpc = limitBounds(mpcBounds, quantity, index);
  if (mpc) parts.push(`MPC bound ${quantity === 'position' ? range(mpc, unit) : `±${Number(mpc[1].toPrecision(4))} ${unit}`}`);
  if (quantity === 'position' && startPose) {
    parts.push(`Planning box ${range([startPose.planning.lower[index], startPose.planning.upper[index]], unit)} · default ${signed(startPose.defaults[index], 3)} ${unit}`);
    if (startPose.outside?.[index]) parts.push(OUTSIDE_PLANNING);
    parts.push('Drag or type to set the start pose; a new run starts there at t = 0');
  }
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

// startPose (Live only, else null): {editable, value, defaults, lower, upper,
// planning: {lower, upper}}. Editable means the cursor is at the run start, where
// the position column shows the start pose; the lock decides whether it is edited.
export function updateJointTable(rows, { q, qd, torque, limits, mpcBounds = null, torqueKind = 'applied', settings = DEFAULT_LIMIT_USE, startPose = null }) {
  settings = { ...DEFAULT_LIMIT_USE, ...settings };
  if (rows.heading) rows.heading.title = headingTitle(settings);
  rows.startPose = startPose;
  const editing = startEditing(rows);
  const outside = editing ? startPose.value.map((v, i) => v < startPose.planning.lower[i] - 1e-12 || v > startPose.planning.upper[i] + 1e-12) : [];
  const modified = editing ? startPose.value.map((v, i) => Math.abs(v - startPose.defaults[i]) > 1e-9) : [];
  const editContext = editing ? { ...startPose, outside } : null;
  if (rows.container) rows.container.dataset.startPose = editing ? 'edit' : '';
  if (rows.positionLabel) rows.positionLabel.textContent = editing ? 'START' : 'POS';
  rows.forEach((gauges, index) => {
    const values = [q?.[index], qd?.[index], torque?.[index]];
    gauges.forEach((parts, j) => updateGauge(parts, LIMIT_QUANTITIES[j], values[j], { limits, mpcBounds, index, torqueKind, settings, startPose: j === 0 ? editContext : null }));
    if (!gauges.row) return;
    gauges.reset.hidden = !modified[index];
    gauges.row.dataset.planning = outside[index] ? 'outside' : '';
    gauges.label.title = outside[index] ? `${gauges.name}\n${OUTSIDE_PLANNING}` : gauges.name;
    gauges.input.disabled = !editing;
    if (editing && gauges.input.ownerDocument?.activeElement !== gauges.input) {
      Object.assign(gauges.input, { value: startPose.value[index].toFixed(DIGITS.position), min: String(startPose.lower[index]), max: String(startPose.upper[index]) });
    }
  });
  refreshLock(rows);
  refreshStartReset(rows);
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
