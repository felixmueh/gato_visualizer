// Mirrors execution_session.DEFAULT_EXECUTION: commands at 500 Hz.
export const DEFAULT_EXECUTION = { simulation_hz: 1000, control_hz: 500, to_hz: 100, solve_latency_s: 'measured', latency_compensation: false, max_plan_age_s: null, calculation: 'on_play', duration_s: 10, continue_at_end: false };

export function parseSolveLatency(value) {
  const text = String(value).trim();
  if (text === 'measured') return text;
  const seconds = text ? Number(text) : NaN;
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Solve latency needs “measured” or nonnegative seconds.');
  return seconds;
}

export function validateExecution(value) {
  const next = { ...DEFAULT_EXECUTION, ...value };
  for (const key of ['simulation_hz', 'control_hz', 'duration_s']) {
    if (!Number.isFinite(next[key]) || next[key] <= 0) throw new Error(`${key.replaceAll('_', ' ')} must be positive.`);
  }
  if (!Number.isFinite(next.to_hz) || next.to_hz < 0) throw new Error('TO Hz must be nonnegative; 0 requests back-to-back.');
  if (next.solve_latency_s !== 'measured' && (typeof next.solve_latency_s !== 'number' || !Number.isFinite(next.solve_latency_s) || next.solve_latency_s < 0)) throw new Error('Solve latency needs “measured” or nonnegative seconds.');
  if (next.max_plan_age_s !== null && (typeof next.max_plan_age_s !== 'number' || !Number.isFinite(next.max_plan_age_s) || next.max_plan_age_s <= 0)) throw new Error('Maximum plan age needs positive seconds or a disabled limit.');
  if (next.simulation_hz < next.control_hz || next.control_hz < next.to_hz) throw new Error('Use Simulation Hz ≥ Control Hz ≥ TO Hz.');
  if (typeof next.latency_compensation !== 'boolean') throw new Error('Latency compensation must be a checkbox value.');
  if (!['on_play', 'manual', 'automatic'].includes(next.calculation)) throw new Error('Choose a calculation mode.');
  next.continue_at_end = Boolean(next.continue_at_end);
  return next;
}

export function intervalSeverity(interval) {
  // Explicit causes take priority over total time: red always trumps yellow.
  if (!interval.to_back_to_back && (interval.mpc_overrun || interval.severity === 'red' || interval.severity === 'mpc')) return 'red';
  if (interval.physics_overrun || interval.simulation_overrun || interval.combined_overrun || ['yellow', 'simulation', 'combined'].includes(interval.severity)) return 'yellow';
  // Earlier ASAP records carry a spurious red flag. Preserve the raw record,
  // but display only real-time throughput overload for that mode.
  if (interval.to_back_to_back) {
    const span = interval.end_time_s - interval.start_time_s;
    if (interval.physics_ratio > 1 || interval.total_ratio > 1 ||
        Number.isFinite(span) && span > 0 && (interval.physics_wall_s > span || interval.total_wall_s > span)) return 'yellow';
  }
  return 'normal';
}

export function intervalDescription(interval) {
  const ms = value => Number.isFinite(value) ? `${(value * 1000).toFixed(2)} ms` : '—';
  const severity = intervalSeverity(interval);
  const span = interval.end_time_s - interval.start_time_s;
  const physicsOver = interval.physics_overrun || interval.simulation_overrun || interval.physics_ratio > 1 || (Number.isFinite(span) && interval.physics_wall_s > span);
  const reason = severity === 'red' ? 'MPC exceeded budget' : severity === 'yellow' ? interval.to_back_to_back
    ? physicsOver ? 'Simulation slower than real time' : 'Combined computation slower than real time'
    : physicsOver ? 'Simulation exceeded budget' : 'Combined computation exceeded budget' : interval.to_back_to_back ? 'Within real-time compute budget' : 'Within budget';
  // Effort clipping counts every command of the interval, also unrecorded ones.
  const clipped = interval.clipped_commands > 0 ? ` · ${interval.clipped_commands} ${interval.clipped_commands === 1 ? 'command' : 'commands'} clipped to the effort limit` : '';
  const deadline = interval.to_back_to_back ? 'TO as fast as possible · no TO deadline' : `nominal TO budget ${ms(interval.to_budget_s ?? interval.budget_s)}`;
  return `${reason}${clipped} · MPC ${ms(interval.mpc_wall_s ?? interval.solve_wall_s)} · physics ${ms(interval.physics_wall_s ?? interval.simulation_wall_s)} · total ${ms(interval.total_wall_s)} · ${deadline} · physics / total interval ${ms(span)}`;
}

// One simulated-time clock for recorded and growing histories. Catching up to
// new data never speeds up playback; a stalled tip holds until data arrives.
export function createHistoryClock({ bufferMs = 0, rate = 1 } = {}) {
  let time = null, playing = false, following = false, buffering = false, previousMs = null;
  let bufferSeconds = bufferMs / 1000, growingNow = false;
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Playback rate must be positive.');
  return {
    play(nowMs, { follow = false, growing = false } = {}) { playing = true; following = follow; growingNow = growing; buffering = growing && bufferSeconds > 0; previousMs = nowMs; },
    pause() { playing = false; following = false; buffering = false; previousMs = null; },
    seek(value) { time = value; following = false; buffering = false; previousMs = null; },
    setBuffer(ms) {
      if (ms / 1000 === bufferSeconds) return;
      bufferSeconds = ms / 1000; buffering = playing && bufferSeconds > 0; previousMs = null;
    },
    setRate(value) { if (!Number.isFinite(value) || value <= 0) throw new Error('Playback rate must be positive.'); rate = value; },
    follow() { following = playing; },
    // Following changes the visible timeline end, never the playback speed or
    // recorded data. Arriving batches are still played at 1×.
    presentationBounds([start, end]) { return [start, following && time != null ? Math.max(start, Math.min(end, time)) : end]; },
    tick(nowMs, [start, sessionEnd], { followAtEnd = false, growing = false, followBounds } = {}) {
      // Continue stops the whole session at the main track's growing tip.
      // Stop uses the full session span, allowing other recordings to finish.
      const end = followAtEnd && followBounds ? Math.min(sessionEnd, Math.max(start, followBounds[1])) : sessionEnd;
      growingNow = growing;
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
      const effectiveRate = following && growing ? 1 : rate;
      time = Math.min(end, time + delta * effectiveRate);
      if (playing && growing && bufferSeconds > 0 && time >= end - 1e-8) buffering = true;
      if (playing && followAtEnd && time >= end - 1e-8) following = true;
      return { time, atEnd: time >= end - 1e-8, atSessionEnd: time >= sessionEnd - 1e-8, limited: playing && delta > 0 && time >= end - 1e-8, buffering, rate: following && growing ? 1 : rate };
    },
    get time() { return time; },
    get playing() { return playing; },
    get following() { return following; },
    get buffering() { return buffering; },
    get rate() { return rate; },
    get effectiveRate() { return following && growingNow ? 1 : rate; },
    get rateForced() { return following && growingNow; },
  };
}
