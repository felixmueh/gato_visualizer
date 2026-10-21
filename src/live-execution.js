export const DEFAULT_EXECUTION = { simulation_hz: 1000, control_hz: 100, to_hz: 100, calculation: 'on_play', duration_s: 10, continue_at_end: false };

export function validateExecution(value) {
  const next = { ...DEFAULT_EXECUTION, ...value };
  for (const key of ['simulation_hz', 'control_hz', 'to_hz', 'duration_s']) {
    if (!Number.isFinite(next[key]) || next[key] <= 0) throw new Error(`${key.replaceAll('_', ' ')} must be positive.`);
  }
  if (next.simulation_hz < next.control_hz || next.control_hz < next.to_hz) throw new Error('Use Simulation Hz ≥ Control Hz ≥ TO Hz.');
  if (!['on_play', 'manual', 'automatic'].includes(next.calculation)) throw new Error('Choose a calculation mode.');
  next.continue_at_end = Boolean(next.continue_at_end);
  return next;
}

export function intervalSeverity(interval) {
  // Explicit causes take priority over total time: red always trumps yellow.
  if (interval.mpc_overrun || interval.severity === 'red' || interval.severity === 'mpc') return 'red';
  if (interval.physics_overrun || interval.simulation_overrun || interval.combined_overrun || ['yellow', 'simulation', 'combined'].includes(interval.severity)) return 'yellow';
  return 'normal';
}

export function intervalDescription(interval) {
  const ms = value => Number.isFinite(value) ? `${(value * 1000).toFixed(2)} ms` : '—';
  const severity = intervalSeverity(interval);
  const span = interval.end_time_s - interval.start_time_s;
  const physicsOver = interval.physics_overrun || interval.simulation_overrun || interval.physics_ratio > 1 || (Number.isFinite(span) && interval.physics_wall_s > span);
  const reason = severity === 'red' ? 'MPC exceeded budget' : severity === 'yellow' ? physicsOver ? 'Simulation exceeded budget' : 'Combined computation exceeded budget' : 'Within budget';
  return `${reason} · MPC ${ms(interval.mpc_wall_s ?? interval.solve_wall_s)} · physics ${ms(interval.physics_wall_s ?? interval.simulation_wall_s)} · total ${ms(interval.total_wall_s)} · nominal TO budget ${ms(interval.to_budget_s ?? interval.budget_s)} · physics / total interval ${ms(span)}`;
}

// One simulated-time clock for recorded and growing histories. Catching up to
// new data never speeds up playback; a stalled tip holds until data arrives.
export function createHistoryClock({ bufferMs = 0 } = {}) {
  let time = null, playing = false, following = false, buffering = false, previousMs = null;
  let bufferSeconds = bufferMs / 1000;
  return {
    play(nowMs, { follow = false, growing = false } = {}) { playing = true; following = follow; buffering = growing && bufferSeconds > 0; previousMs = nowMs; },
    pause() { playing = false; following = false; buffering = false; previousMs = null; },
    seek(value) { time = value; following = false; buffering = false; previousMs = null; },
    setBuffer(ms) {
      if (ms / 1000 === bufferSeconds) return;
      bufferSeconds = ms / 1000; buffering = playing && bufferSeconds > 0; previousMs = null;
    },
    follow() { following = playing; },
    // Following changes the visible timeline end, never the playback speed or
    // recorded data. Arriving batches are still played at 1×.
    presentationBounds([start, end]) { return [start, following && time != null ? Math.max(start, Math.min(end, time)) : end]; },
    tick(nowMs, [start, end], { followAtEnd = false, growing = false } = {}) {
      if (time == null) time = start;
      time = Math.max(start, Math.min(end, time));
      let delta = playing && previousMs != null ? Math.max(0, (nowMs - previousMs) / 1000) : 0;
      if (playing) previousMs = nowMs;
      if (playing && buffering) {
        // A paused/completed producer drains its available tail even when it is
        // shorter than the requested lead. Never repay time spent buffering.
        if (!growing || end - time >= bufferSeconds - 1e-9 || bufferSeconds === 0) buffering = false;
        delta = 0;
      }
      time = Math.min(end, time + delta);
      if (playing && growing && bufferSeconds > 0 && time >= end - 1e-8) buffering = true;
      if (playing && followAtEnd && time >= end - 1e-8) following = true;
      return { time, atEnd: time >= end - 1e-8, limited: playing && delta > 0 && time >= end - 1e-8, buffering };
    },
    get time() { return time; },
    get playing() { return playing; },
    get following() { return following; },
    get buffering() { return buffering; },
  };
}
