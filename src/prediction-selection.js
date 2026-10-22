// The episode cursor already selects the exact locally retained plan. Async
// Solve metadata may trail that cursor; it only owns the scene after an explicit
// pin or SQP selection. Missing iteration trajectories remain unavailable.
export function livePredictionForView(episodePlan, inspection) {
  if (!episodePlan && !inspection?.pinned) return null;
  const explicitInspection = inspection?.active && (inspection.pinned || inspection.iteration != null);
  return explicitInspection ? inspection.prediction : episodePlan;
}

/** Bounded cache of one Solve's recorded SQP-iteration 3D paths.
 * Chunks arrive from the backend's binary trace; single selected snapshots
 * fill in as plot responses arrive. A new solve key discards everything. */
export function createIterationPathCache({ maxChunks = 4, maxSingles = 64 } = {}) {
  let key = null, chunks = [], singles = new Map();
  return {
    get key() { return key; },
    reset(next) { if (next !== key) { key = next; chunks = []; singles = new Map(); } },
    addChunk(solveKey, chunk) {
      if (solveKey !== key || !Number.isInteger(chunk?.start) || !Array.isArray(chunk.ee_xyz)) return;
      chunks = [{ start: chunk.start, stop: chunk.start + chunk.ee_xyz.length, ee_xyz: chunk.ee_xyz }, ...chunks.filter(item => item.start !== chunk.start)].slice(0, maxChunks);
    },
    addSnapshot(solveKey, index, prediction) {
      if (solveKey !== key || index == null || !prediction?.ee_xyz?.length) return;
      singles.delete(index); singles.set(index, prediction);
      while (singles.size > maxSingles) singles.delete(singles.keys().next().value);
    },
    hasChunk(index) { return chunks.some(item => index >= item.start && index < item.stop); },
    get(index) {
      if (index == null) return null;
      const chunk = chunks.find(item => index >= item.start && index < item.stop);
      return singles.get(index) || (chunk ? { ee_xyz: chunk.ee_xyz[index - chunk.start] } : null);
    },
  };
}

/** Which prediction the scene shows for the Solve inspector's SQP cursor.
 * A recorded trajectory that has not arrived yet keeps the previously shown
 * trajectory (`held`) instead of flashing to the final one; a metrics-only
 * iteration shows the final plan only as labelled context. */
export function iterationPredictionForView({ iteration, record, snapshot, cached, finalPrediction, finalContext, held }) {
  if (iteration == null) {
    const prediction = snapshot || finalPrediction;
    return prediction ? { prediction, source: 'final', status: 'final' } : { prediction: held || null, source: held ? 'held' : null, status: held ? 'loading' : 'final' };
  }
  const recorded = record?.prediction || snapshot || cached;
  if (recorded) return { prediction: recorded, source: 'iteration', status: 'recorded' };
  if (record?.has_prediction === true) return { prediction: held || null, source: held ? 'held' : null, status: 'loading' };
  return finalContext?.ee_xyz?.length ? { prediction: finalContext, source: 'final-context', status: 'missing' } : { prediction: null, source: null, status: 'missing' };
}
