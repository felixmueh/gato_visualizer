import { createGhostArms } from './ghost-arm.js';
import { armChain, solveGraspIk } from './arm-kinematics.js';
import { rotvecToQuaternion } from './rotations.js';

// The IK preview: one ghost arm in an inverse-kinematics pose that reaches the Live
// reach goal (with its orientation goal when that is on, else position only plus the
// posture term toward the start pose). A kinematic pose, not the MPC's predicted final
// pose. The same check decides whether the goal is reachable at all (red goal).
export const IK_PREVIEW_STORAGE_KEY = 'motion-studio-ik-preview';
export const IK_PREVIEW_MODES = Object.freeze(['setup', 'off', 'on']);
export const IK_PREVIEW_DEFAULT = 'setup';
export const IK_PREVIEW_COLOR = 0xffb547; // the goal's gold
export const IK_PREVIEW_OPACITY = .3;
// Reached: within the grasp handle's display thresholds (tether 2 mm, orientation 1°).
export const REACH_POSITION_TOLERANCE = .002; // m
export const REACH_ORIENTATION_TOLERANCE = Math.PI / 180; // rad
export const REACH_FRAMES_PER_SEED = 40; // solveGraspIk calls (up to 16 iterations each)
// A seed stops once a call improves the weighted error by less than this: out of reach
// the error only creeps toward its local minimum, which would never count as stalled.
export const REACH_PROGRESS = 1e-4; // m of weighted error per call
// A seed that stops within 2 cm of weighted error is polished without the posture term
// and with little damping, which near joint bounds otherwise crawl the last millimetres
// (on 92 reachable goals from random poses this cut false reds from 12 to 1).
export const POLISH_WITHIN = .02; // m of weighted error
export const POLISH_DAMPING = .005; // m
export const POLISH_FRAMES = 20;
// While the goal moves (gizmo drags) a quick check every 120 ms tries the last solution and
// the start pose; once it has been still for 250 ms, the full check tries every seed.
export const RECHECK_INTERVAL_MS = 120;
export const SETTLE_MS = 250;
export const QUICK_SEEDS = Object.freeze(['last', 'start']);

const LABELS = { setup: 'setup only', off: 'off', on: 'on' };

export function nextIkPreviewMode(mode) {
  return IK_PREVIEW_MODES[(IK_PREVIEW_MODES.indexOf(mode) + 1) % IK_PREVIEW_MODES.length];
}

/** "Setup only" shows the preview only while the run is being set up (Live, paused at t = 0). */
export function ikPreviewShown(mode, setup) {
  return mode === 'on' || (mode === 'setup' && Boolean(setup));
}

export function loadIkPreviewMode(storage) {
  try {
    const saved = storage?.getItem(IK_PREVIEW_STORAGE_KEY);
    return IK_PREVIEW_MODES.includes(saved) ? saved : IK_PREVIEW_DEFAULT;
  } catch { return IK_PREVIEW_DEFAULT; }
}

/** Seeds in the order tried: the last solution (continuity while a goal moves), the start
 * pose, the displayed pose, then fixed spreads across the bounds against local minima. */
export function reachSeeds({ last, start, current, lower, upper }) {
  const spread = pattern => lower.map((low, i) => low + (upper[i] - low) * pattern[i % pattern.length]);
  const seeds = [['last', last], ['start', start], ['current', current], ['middle', spread([.5])],
    ['spread-a', spread([.25, .75])], ['spread-b', spread([.75, .25])]];
  const seen = new Set();
  return seeds.filter(([, q]) => {
    if (!Array.isArray(q) || q.length !== lower.length || !q.every(Number.isFinite)) return false;
    const key = q.map(v => v.toFixed(9)).join(',');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

const reached = (result, orientation) => result.gap_m <= REACH_POSITION_TOLERANCE &&
  (orientation == null || result.orientation_gap_rad <= REACH_ORIENTATION_TOLERANCE);

/** Whether the grasp goal (target, optional orientation quaternion) is reachable within
 * the bounds: solveGraspIk from each seed until it reaches the goal, converges, stalls or
 * stops progressing, then a polish when close, stopping at the first seed that reaches
 * it. Unreachable means no seed did: the nearest pose found, not a proof. */
export function reachGoal(chain, base, { target, orientation = null, posture, seeds, lower, upper,
  framesPerSeed = REACH_FRAMES_PER_SEED, clock = () => performance.now() }) {
  const started = clock();
  let best = null, solves = 0, iterations = 0;
  for (const [seed, q0] of seeds) {
    let q = q0, result;
    const run = (frames, options, progress) => {
      let previous = Infinity;
      for (let frame = 0; frame < frames; frame++) {
        result = solveGraspIk(chain, base, { q, q0: posture, target, orientation, lower, upper, ...options });
        solves++; iterations += result.iterations; q = result.q;
        if (result.converged || result.stalled || reached(result, orientation) || previous - result.error_m < progress) return;
        previous = result.error_m;
      }
    };
    run(framesPerSeed, {}, REACH_PROGRESS);
    if (!reached(result, orientation) && result.error_m < POLISH_WITHIN) {
      run(POLISH_FRAMES, { postureGain: 0, damping: POLISH_DAMPING }, REACH_PROGRESS / 10);
    }
    const candidate = { ...result, seed, reached: reached(result, orientation) };
    if (!best || (candidate.reached && !best.reached) || (candidate.reached === best.reached && candidate.error_m < best.error_m)) best = candidate;
    if (candidate.reached) break;
  }
  return { q: best.q, reachable: best.reached, gap_m: best.gap_m, orientation_gap_rad: best.orientation_gap_rad,
    seed: best.seed, seeds: seeds.length, solves, iterations, ms: clock() - started };
}

/** The button beside the onion skin, the ghost and the throttled check. getContext returns
 * null outside a Live reach, else { target, orientation_rotvec, start, current, lower, upper,
 * setup, endEffector, base }; onReachability receives each check's result (null when none). */
export function setupIkPreview({ robot, scene, jointNames, button, getContext, onReachability = () => {},
  storage = (() => { try { return globalThis.localStorage; } catch { return undefined; } })(), now = () => performance.now() }) {
  let mode = loadIkPreviewMode(storage), chain = null, chainKey, result = null, shown = false;
  let checkedKey, pendingKey, lastCheck = -Infinity, lastChange = -Infinity, full = false;
  const ghosts = createGhostArms({ robot, scene, max: 1, method: 'prepass' });
  function paint() {
    if (!button) return;
    button.dataset.ikPreview = mode;
    button.setAttribute('aria-pressed', String(mode !== 'off'));
    button.title = `IK preview of the final pose · ${LABELS[mode]}: a ghost arm in an inverse-kinematics pose reaching the goal ` +
      '(kinematics only, not the MPC\'s predicted final pose). Setup only: Live, paused at the run start.';
  }
  function setMode(next) {
    if (!IK_PREVIEW_MODES.includes(next)) throw new Error('Choose setup, off or on for the IK preview.');
    mode = next; paint();
    try { storage?.setItem(IK_PREVIEW_STORAGE_KEY, mode); } catch {}
    update();
  }
  const cycle = () => setMode(nextIkPreviewMode(mode));
  button?.addEventListener('click', cycle);
  function ensureChain(endEffector) {
    const key = JSON.stringify(endEffector);
    if (key === chainKey) return chain;
    chainKey = key; chain = null;
    try { chain = armChain(robot, { jointNames, grasp: endEffector }); } catch { chain = null; }
    return chain;
  }
  function update() {
    const context = getContext();
    if (!context || !ensureChain(context.endEffector)) {
      if (result || pendingKey) onReachability(null);
      result = null; checkedKey = pendingKey = undefined; ghosts.set([]); shown = false; return;
    }
    const key = JSON.stringify([context.target, context.orientation_rotvec ?? null, context.start, context.lower, context.upper,
      context.base.elements, chainKey]);
    const time = now();
    if (key !== checkedKey && key !== pendingKey) { pendingKey = key; lastChange = time; }
    const settled = time - lastChange >= SETTLE_MS;
    if ((pendingKey && time - lastCheck >= RECHECK_INTERVAL_MS) || (!pendingKey && !full && settled)) {
      const orientation = context.orientation_rotvec ? rotvecToQuaternion(context.orientation_rotvec) : null;
      let seeds = reachSeeds({ last: result?.q, start: context.start, current: context.current, lower: context.lower, upper: context.upper });
      full = settled;
      if (!full) seeds = seeds.filter(([name]) => QUICK_SEEDS.includes(name));
      result = { ...reachGoal(chain, context.base, { target: context.target, orientation, posture: context.start,
        lower: context.lower, upper: context.upper, seeds }), full };
      checkedKey = key; pendingKey = undefined; lastCheck = time;
      onReachability(result);
    }
    shown = Boolean(result) && ikPreviewShown(mode, context.setup);
    ghosts.set(shown ? [{ id: 'ik-preview', q: result.q, jointNames, base: context.base, color: IK_PREVIEW_COLOR, opacity: IK_PREVIEW_OPACITY }] : []);
  }
  paint();
  return {
    update, setMode, cycle,
    sort: camera => ghosts.update(camera),
    get mode() { return mode; },
    get result() { return result; },
    get snapshot() { return { mode, shown, pending: Boolean(pendingKey), result: result && { ...result, q: result.q.slice() }, ghosts: ghosts.snapshot.count }; },
    dispose() { button?.removeEventListener('click', cycle); ghosts.dispose(); },
  };
}
