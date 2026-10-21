// The episode cursor already selects the exact locally retained plan. Async
// Solve metadata may trail that cursor; it only owns the scene after an explicit
// pin or SQP selection. Missing iteration trajectories remain unavailable.
export function livePredictionForView(episodePlan, inspection) {
  if (!episodePlan && !inspection?.pinned) return null;
  const explicitInspection = inspection?.active && (inspection.pinned || inspection.iteration != null);
  return explicitInspection ? inspection.prediction : episodePlan;
}
