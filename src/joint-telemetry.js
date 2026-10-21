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

export function limitStatus(value, lower, upper) {
  if (![value, lower, upper].every(Number.isFinite) || upper <= lower) return '';
  const tolerance = Math.max(1e-9, (upper - lower) * 1e-7);
  if (value <= lower + tolerance || value >= upper - tolerance) return 'at-limit';
  const margin = (upper - lower) * .1;
  return value <= lower + margin || value >= upper - margin ? 'near-limit' : '';
}

export function magnitudeStatus(value, limit) {
  if (!Number.isFinite(value) || !Number.isFinite(limit) || limit <= 0) return '';
  if (Math.abs(value) >= limit - Math.max(1e-9, limit * 1e-7)) return 'at-limit';
  return Math.abs(value) >= .9 * limit ? 'near-limit' : '';
}

export function createJointTable(container, names) {
  const heading = document.createElement('div');
  heading.className = 'joint-row joint-columns';
  for (const text of ['JOINT', 'POS rad', 'VEL rad/s', 'TORQUE Nm']) {
    const label = document.createElement('span'); label.textContent = text; heading.append(label);
  }
  container.replaceChildren(heading);
  return names.map((name, i) => {
    const row = document.createElement('div'); row.className = 'joint-row';
    const label = document.createElement('span'); label.className = 'joint-name';
    label.textContent = `J${i + 1}`; label.title = name; row.append(label);
    const cells = ['position', 'velocity', 'torque'].map((quantity) => {
      const cell = document.createElement('span'); cell.className = 'joint-value';
      cell.dataset.quantity = quantity; cell.textContent = '—'; row.append(cell); return cell;
    });
    container.append(row); return cells;
  });
}

export function updateJointTable(cells, {q, qd, torque, limits, torqueKind = 'applied'}) {
  const source = limits?.source || 'Limits unavailable';
  cells.forEach((row, i) => {
    const values = [q?.[i], qd?.[i], torque?.[i]];
    const lower = limits?.lower_position_rad?.[i], upper = limits?.upper_position_rad?.[i];
    const velocity = limits?.velocity_rad_s?.[i], effort = limits?.effort_nm?.[i];
    const states = [limitStatus(values[0], lower, upper), magnitudeStatus(values[1], velocity), magnitudeStatus(values[2], effort)];
    const bounds = [`${lower} … ${upper} rad`, `±${velocity} rad/s`, `±${effort} Nm`];
    row.forEach((cell, j) => {
      const value = values[j];
      cell.textContent = Number.isFinite(value) ? `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(j === 2 ? 2 : 3)}` : '—';
      cell.classList.toggle('near-limit', states[j] === 'near-limit');
      cell.classList.toggle('at-limit', states[j] === 'at-limit');
      const meaning = j === 2 ? (torqueKind === 'predicted' ? 'Predicted actuator torque' : 'Last applied actuator torque') : j === 1 ? 'Recorded joint velocity' : 'Native joint position';
      cell.title = `${meaning}${Number.isFinite(value) ? '' : ' unavailable'} · ${source}${limits ? ` · ${bounds[j]}` : ''}${states[j] ? ` · ${states[j] === 'at-limit' ? 'AT / BEYOND LIMIT' : 'NEAR LIMIT'}` : ''}`;
      cell.setAttribute('aria-label', `${meaning}: ${cell.textContent}${states[j] ? `, ${states[j].replace('-', ' ')}` : ''}`);
    });
  });
}
