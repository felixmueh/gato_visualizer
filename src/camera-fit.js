import { Box3, Vector3 } from 'three';

const validPoint = (point) => (Array.isArray(point) && point.length === 3 && point.every(Number.isFinite)) || (point?.isVector3 && [point.x, point.y, point.z].every(Number.isFinite));
const vectors = (points) => (points || []).filter(validPoint).map((point) => point.isVector3 ? point.clone() : new Vector3(...point));

export function boundsCorners(bounds) {
  if (bounds.isEmpty()) return [];
  return [bounds.min.x, bounds.max.x].flatMap((x) => [bounds.min.y, bounds.max.y].flatMap((y) => [bounds.min.z, bounds.max.z].map((z) => new Vector3(x, y, z))));
}

export function objectWorldPoints(object) {
  object.updateWorldMatrix(true, true);
  return boundsCorners(new Box3().setFromObject(object));
}

// Keep the existing view orientation. Solve both horizontal and vertical
// perspective constraints for every point, including its camera-space depth.
export function fitPerspectivePoints(camera, points, { padding = 1.15, minDistance = .3 } = {}) {
  const worldPoints = vectors(points);
  if (!worldPoints.length) return null;
  const center = new Box3().setFromPoints(worldPoints).getCenter(new Vector3());
  const inverse = camera.quaternion.clone().invert();
  const local = worldPoints.map((point) => point.clone().sub(center).applyQuaternion(inverse));
  const tanVertical = Math.tan(camera.fov * Math.PI / 360) / camera.zoom;
  const tanHorizontal = tanVertical * camera.aspect;
  let distance = minDistance;
  for (const point of local) {
    distance = Math.max(distance,
      point.z + padding * Math.max(Math.abs(point.x) / tanHorizontal, Math.abs(point.y) / tanVertical),
      point.z + minDistance * .1);
  }
  let nearestDepth = Infinity, farthestDepth = 0;
  for (const point of local) {
    nearestDepth = Math.min(nearestDepth, distance - point.z);
    farthestDepth = Math.max(farthestDepth, distance - point.z);
  }
  const position = center.clone().add(new Vector3(0, 0, distance).applyQuaternion(camera.quaternion));
  return {
    center, position, distance,
    near: Math.max(.0001, Math.min(camera.near, nearestDepth * .5)),
    far: Math.max(camera.far, farthestDepth * 1.5),
    points: worldPoints,
  };
}

// The optional full closed-loop path is an explicit future input. Executed live
// history and a single solver horizon are never treated as a full task rollout.
export function trajectoryFitPoints({ replay, live = false, taskKind = 'reach', plan, state, taskStart, precomputedPath } = {}) {
  const rollout = vectors(precomputedPath);
  if (rollout.length) return { points: rollout, source: 'Full precomputed closed-loop path' };
  if (!live) {
    const points = [...(replay?.ee_xyz || []), ...(replay?.reference_xyz || [])];
    if (validPoint(replay?.target_xyz)) points.push(replay.target_xyz);
    return { points: vectors(points), source: replay?.kind === 'recorded' ? 'Selected recorded motion and task reference' : 'Selected saved prediction and task reference' };
  }
  const fullReference = vectors(plan?.task_path_xyz);
  if (taskKind !== 'reach' && fullReference.length) return { points: fullReference, source: 'Full input task reference' };
  const start = [taskStart, state?.ee_xyz, plan?.ee_xyz?.[0]].find(validPoint);
  const target = [state?.target_xyz, plan?.target_xyz, plan?.reference_xyz?.[0]].find(validPoint);
  const points = [start, target].filter(validPoint);
  return { points: vectors(points), source: taskKind === 'reach' ? 'Available task start and reaching target' : 'Available task endpoints' };
}
