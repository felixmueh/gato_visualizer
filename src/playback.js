// Timestamp-based playback preserves nonuniform recorded controller intervals.
export function sampleTrajectory(trajectory, time) {
  const times = trajectory.time_s;
  const last = times.length - 1;
  if (last < 0) throw new Error("Trajectory has no samples.");
  if (last === 0 || time <= times[0]) {
    return {
      q: [...trajectory.q[0]],
      xyz: [...trajectory.ee_xyz[0]],
      index: 0,
    };
  }
  if (time >= times[last]) {
    return {
      q: [...trajectory.q[last]],
      xyz: [...trajectory.ee_xyz[last]],
      index: last,
    };
  }
  let low = 0;
  let high = last;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (times[mid] <= time) low = mid;
    else high = mid;
  }
  const fraction = (time - times[low]) / (times[high] - times[low]);
  const interpolate = (values) =>
    values[low].map((v, j) => v + (values[high][j] - v) * fraction);
  return {
    q: interpolate(trajectory.q),
    xyz: interpolate(trajectory.ee_xyz),
    index: low,
  };
}

export function validateTrajectory(trajectory, jointCount) {
  const { time_s: times, q, ee_xyz: positions } = trajectory;
  if (
    !Array.isArray(times) ||
    !times.length ||
    q?.length !== times.length ||
    positions?.length !== times.length
  ) {
    throw new Error(`Invalid samples in ${trajectory.label || trajectory.id}.`);
  }
  times.forEach((time, i) => {
    if (!Number.isFinite(time) || (i > 0 && time <= times[i - 1])) {
      throw new Error(
        "Trajectory timestamps must be finite and strictly increasing.",
      );
    }
    if (
      q[i].length !== jointCount ||
      !q[i].every(Number.isFinite) ||
      positions[i].length !== 3 ||
      !positions[i].every(Number.isFinite)
    ) {
      throw new Error("Trajectory contains invalid joint or position samples.");
    }
  });
}

export function trajectoryDistance(positions) {
  return positions
    .slice(1)
    .reduce(
      (sum, point, i) =>
        sum + Math.hypot(...point.map((v, j) => v - positions[i][j])),
      0,
    );
}
