import { BoxGeometry, CapsuleGeometry, DoubleSide, EdgesGeometry, Group, LineBasicMaterial, LineSegments, Matrix4, Mesh,
  MeshStandardMaterial, PlaneGeometry, Quaternion, SphereGeometry, Vector3 } from 'three';

// Obstacles are solid coral, in Live, replays and exports.
export const OBSTACLE_COLOR = 0xe07a5f;
export const obstacleMaterial = () => new MeshStandardMaterial({ color: OBSTACLE_COLOR, roughness: .55 });

// Obstacles of the four shapes (shape-layouts.js) in the world, as three.js objects, and
// their placement between the rows' root frame and the world. world_from_root is a 4×4
// row-major rigid transform. A plane is a half-space; it is drawn as a translucent square
// patch of PLANE_PATCH_M with an edge, centred where the root origin projects onto it.
export const PLANE_PATCH_M = 1.2;
export const SHAPE_LISTS = { obstacles: 'sphere', capsules: 'capsule', boxes: 'box', planes: 'plane' };
// The recorded (replay, freeze) field of each list.
export const RECORDED_FIELDS = { obstacles: 'obstacles', capsules: 'obstacle_capsules', boxes: 'obstacle_boxes', planes: 'obstacle_planes' };

const vector = values => new Vector3(...values);
function placement(matrix) {
  const m = new Matrix4().set(...matrix.flat());
  return { m, rotation: new Quaternion().setFromRotationMatrix(m), translation: new Vector3().setFromMatrixPosition(m) };
}

/** One obstacle's values from the root frame into the world (a plane's normal made unit). */
export function shapeToWorld(shape, values, matrix) {
  const { m, rotation, translation } = placement(matrix);
  const point = (i) => vector(values.slice(i, i + 3)).applyMatrix4(m).toArray();
  if (shape === 'sphere') return [...point(0), values[3]];
  if (shape === 'capsule') return [...point(0), ...point(3), values[6]];
  if (shape === 'box') return [...point(0), ...rotation.clone().multiply(new Quaternion(...values.slice(3, 7)).normalize()).toArray(), ...values.slice(7)];
  const length = Math.hypot(...values.slice(0, 3)), normal = vector(values.slice(0, 3)).divideScalar(length).applyQuaternion(rotation);
  return [...normal.toArray(), values[3] / length + normal.dot(translation)];
}

/** The inverse of shapeToWorld. */
export function shapeFromWorld(shape, values, matrix) {
  const inverse = new Matrix4().set(...matrix.flat()).invert();
  const rows = [0, 1, 2, 3].map(i => [0, 1, 2, 3].map(j => inverse.elements[j * 4 + i]));
  return shapeToWorld(shape, values, rows);
}

/** Where an obstacle's handles sit: a sphere's or box's centre, a capsule's midpoint, the
 * plane patch's centre (reference projected onto the plane). */
export function shapeCentre(shape, world, reference = [0, 0, 0]) {
  if (shape === 'sphere' || shape === 'box') return world.slice(0, 3);
  if (shape === 'capsule') return [0, 1, 2].map(i => (world[i] + world[i + 3]) / 2);
  const normal = world.slice(0, 3), distance = normal.reduce((sum, value, i) => sum + value * reference[i], 0) - world[3];
  return reference.map((value, i) => value - distance * normal[i]);
}

/** A rough size, for the sideways offset of a paste without a pointer. */
export function shapeExtent(shape, values) {
  if (shape === 'sphere') return values[3];
  if (shape === 'capsule') return values[6] + Math.hypot(...[0, 1, 2].map(i => values[i + 3] - values[i])) / 2;
  if (shape === 'box') return Math.max(...values.slice(7));
  return .1;
}

/** The obstacle moved by delta (both in the same frame); a plane moves along its normal. */
export function translateShape(shape, values, delta) {
  const moved = [...values], add = start => delta.forEach((value, i) => { moved[start + i] += value; });
  if (shape === 'plane') moved[3] += values.slice(0, 3).reduce((sum, value, i) => sum + value * delta[i], 0);
  else { add(0); if (shape === 'capsule') add(3); }
  return moved;
}

/** The same half-space with the other side free: n → -n, d → -d. */
export function flipPlane(values) {
  return values.map(value => value === 0 ? 0 : -value);
}

/** A capsule turned about its centre by a quaternion [x, y, z, w]; the radius stays. */
export function rotateCapsule(values, quaternion) {
  const q = new Quaternion(...quaternion), a = vector(values.slice(0, 3)), b = vector(values.slice(3, 6));
  const centre = a.clone().add(b).multiplyScalar(.5);
  const end = point => point.clone().sub(centre).applyQuaternion(q).add(centre).toArray();
  return [...end(a), ...end(b), values[6]];
}

/** An obstacle scaled along its own axes by factors [fx, fy, fz] of its scale gizmo (the
 * frame of capsuleRotation or the box's quaternion), about its centre. A box scales each
 * half-extent; a capsule its length with fy (along a→b) and its radius with fx or fz,
 * whichever changes more; a sphere its radius uniformly with the factor that changes most. */
export function scaleShape(shape, values, factors) {
  const most = list => list.reduce((best, value) => Math.abs(value - 1) > Math.abs(best - 1) ? value : best, 1);
  if (shape === 'box') return [...values.slice(0, 7), ...values.slice(7).map((size, i) => size * factors[i])];
  if (shape === 'sphere') return [...values.slice(0, 3), values[3] * most(factors)];
  if (shape !== 'capsule') return [...values];
  const a = vector(values.slice(0, 3)), b = vector(values.slice(3, 6));
  const centre = a.clone().add(b).multiplyScalar(.5), half = b.clone().sub(a).multiplyScalar(.5 * factors[1]);
  return [...centre.clone().sub(half).toArray(), ...centre.clone().add(half).toArray(), values[6] * most([factors[0], factors[2]])];
}

/** A capsule's world quaternion that turns +y (three.js's capsule axis) onto a→b. */
export function capsuleRotation(world) {
  const axis = new Vector3(world[3] - world[0], world[4] - world[1], world[5] - world[2]);
  return axis.lengthSq() > 1e-18 ? new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), axis.normalize()) : new Quaternion();
}

/** A plane patch's world quaternion: its local +z is the normal. */
export function planeRotation(world) {
  return new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), vector(world.slice(0, 3)).normalize());
}

const planeMaterial = () => new MeshStandardMaterial({ color: OBSTACLE_COLOR, transparent: true, opacity: .28, side: DoubleSide,
  depthWrite: false, roughness: .7 });
/** A drawn obstacle of shape; setShapeObject places it. Meshes carry userData.obstacle for picking. */
export function createShapeObject(shape, { material = obstacleMaterial() } = {}) {
  if (shape === 'plane') {
    const group = new Group(), patch = new Mesh(new PlaneGeometry(1, 1), planeMaterial());
    const edge = new LineSegments(new EdgesGeometry(patch.geometry), new LineBasicMaterial({ color: OBSTACLE_COLOR }));
    group.add(patch, edge); group.scale.setScalar(PLANE_PATCH_M); group.userData = { shape, mesh: patch, material: patch.material };
    material.dispose?.();
    return group;
  }
  const geometry = shape === 'sphere' ? new SphereGeometry(1, 32, 20) : shape === 'box' ? new BoxGeometry(1, 1, 1) : new CapsuleGeometry(1, 1, 8, 20);
  const mesh = new Mesh(geometry, material); mesh.userData = { shape, mesh, material };
  return mesh;
}

export function setShapeObject(object, shape, world, reference = [0, 0, 0]) {
  if (shape === 'sphere') { object.position.fromArray(world); object.scale.setScalar(world[3]); }
  else if (shape === 'box') {
    object.position.fromArray(world); object.quaternion.fromArray(world.slice(3, 7));
    object.scale.set(...world.slice(7).map(value => 2 * value));
  } else if (shape === 'capsule') {
    const length = Math.hypot(...[0, 1, 2].map(i => world[i + 3] - world[i])), key = `${world[6]}:${length}`;
    if (object.userData.key !== key) {
      object.geometry.dispose(); object.geometry = new CapsuleGeometry(world[6], length, 8, 20); object.userData.key = key;
    }
    object.position.fromArray(shapeCentre(shape, world)); object.quaternion.copy(capsuleRotation(world));
  } else {
    object.position.fromArray(shapeCentre(shape, world, reference)); object.quaternion.copy(planeRotation(world));
  }
  object.updateMatrixWorld(true);
}

/** Recorded obstacles in the world ({obstacles, capsules, boxes, planes} lists) as one group. */
export function createShapesGroup(lists, { name = 'track-obstacles', reference = [0, 0, 0] } = {}) {
  const group = new Group(); group.name = name;
  for (const [list, shape] of Object.entries(SHAPE_LISTS)) for (const world of lists[list] || []) {
    const object = createShapeObject(shape); setShapeObject(object, shape, world, reference); object.name = `${name}-${shape}`;
    group.add(object);
  }
  return group;
}
