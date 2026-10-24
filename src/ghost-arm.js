import {
  Box3, EqualDepth, FrontSide, Group, Matrix4, MeshBasicMaterial,
  MeshStandardMaterial, Sphere, Vector3,
} from 'three';

export const GHOST_METHODS = Object.freeze(['plain', 'prepass', 'flat']);
export const GHOST_COLOR = 0x9ca9b8;

// Independent current-track and temporal pools render into the same depth
// buffer. Their depth/color passes must share one order, including when a
// caller attaches its pool beneath a presentation Group.
const sceneGhosts = new WeakMap();
function owningScene(object) {
  while (!object.isScene && object.parent) object = object.parent;
  return object;
}
function shown(object) {
  for (let ancestor = object; ancestor; ancestor = ancestor.parent) if (!ancestor.visible) return false;
  return true;
}

// Recorded poses only. Geometry belongs to the solid robot; every material and
// transform below belongs to this pool. Keyframe selection belongs to its caller.
export function createGhostArms({ robot, scene, armRoot = 'arm_right_1_joint', max = 24, method = 'plain', layer = 0 }) {
  const source = robot.joints?.[armRoot];
  if (!source) throw new Error(`Ghost arm root ${armRoot} is missing.`);
  const sourceJoints = new Map();
  source.traverse(object => { if (object.isURDFJoint) sourceJoints.set(object.urdfName, object); });
  if (max !== Infinity && (!Number.isInteger(max) || max < 1 || max > 24)) throw new Error('Ghost arm pool must contain 1–24 arms, or be uncapped (Infinity).');
  checkMethod(method);
  checkLayer(layer);
  const container = new Group();
  container.name = 'ghost-arms';
  container.layers.set(layer);
  scene.add(container);
  const base = new Matrix4(), inverseScene = new Matrix4(), box = new Box3();
  const cameraPosition = new Vector3(), sceneRoot = owningScene(scene);
  let registered = sceneGhosts.get(sceneRoot);
  if (!registered) { registered = new Set(); sceneGhosts.set(sceneRoot, registered); }
  const pool = [];
  let disposed = false;

  function checkMethod(value) {
    if (!GHOST_METHODS.includes(value)) throw new Error(`Unknown ghost arm method: ${value}`);
  }

  function checkLayer(value) {
    if (!Number.isInteger(value) || value < 0 || value > 31) throw new Error('Ghost arm layer must be an integer from 0 to 31.');
  }

  function cloneArm(material) {
    const root = source.clone(true), joints = new Map(), meshes = [], groups = [], removed = [];
    root.traverse((object) => {
      if (['limit-beyond-outline', 'planning-box-outline'].includes(object.name)) removed.push(object);
      if (object.isGroup) groups.push(object);
      if (object.isURDFJoint) {
        joints.set(object.urdfName, object);
        // URDFJoint.copy copies source mimic references. Repair them below so
        // setting a ghost can never drive a joint on the solid robot.
        object.ignoreLimits = true;
      }
      if (object.isMesh) {
        object.material = material;
        object.castShadow = false;
        object.receiveShadow = false;
        meshes.push(object);
      }
    });
    removed.forEach((object) => object.removeFromParent());
    joints.forEach((joint) => {
      joint.mimicJoints = joint.mimicJoints.map((other) => joints.get(other.urdfName)).filter(Boolean);
    });
    return { root, joints, meshes, groups };
  }

  function allocate() {
    const Material = method === 'flat' ? MeshBasicMaterial : MeshStandardMaterial;
    const material = new Material({ color: GHOST_COLOR, side: FrontSide, transparent: true,
      depthWrite: method === 'flat', ...(method === 'prepass' ? { depthFunc: EqualDepth } : {}) });
    const color = cloneArm(material), group = new Group();
    group.name = 'ghost-arm';
    group.matrixAutoUpdate = false;
    group.matrix.copy(base);
    group.add(color.root);
    let depth = null, depthMaterial = null, depthGroup = null;
    if (method === 'prepass') {
      // Both passes stay in the transparent queue, interleaved per ghost.
      // The group order places the complete depth copy before its color copy.
      depthMaterial = new MeshBasicMaterial({ side: FrontSide, transparent: true,
        colorWrite: false, depthWrite: true });
      depth = cloneArm(depthMaterial);
      depthGroup = new Group();
      depthGroup.add(depth.root);
      group.add(depthGroup);
    }
    group.traverse((object) => object.layers.set(layer));
    container.add(group);
    const ghost = { group, color, material, depth, depthGroup, depthMaterial,
      sphere: new Sphere(), pose: null, q: null, names: null, base: null };
    pool.push(ghost); registered.add(ghost);
    return ghost;
  }

  function updateBounds(ghost) {
    ghost.group.updateWorldMatrix(true, true);
    box.setFromObject(ghost.color.root).getBoundingSphere(ghost.sphere);
  }

  function set(poses) {
    if (disposed) return;
    const selected = poses.slice(0, max), used = new Set();
    for (let index = 0; index < selected.length; index++) {
      const pose = selected[index], id = pose.id ?? index;
      let ghost = pool.find((item) => !used.has(item) && item.pose?.id === id);
      ghost ??= pool.find((item) => !used.has(item) && !selected.some((next, i) => (next.id ?? i) === item.pose?.id));
      ghost ??= allocate();
      used.add(ghost);
      // An explicit base is a world transform, independent of the solid robot's
      // fixed joints. Store our own copy so callers may reuse their Matrix4.
      const poseBase = pose.base ?? null;
      const baseChanged = Boolean(poseBase) !== Boolean(ghost.base)
        || (poseBase && !poseBase.equals(ghost.base));
      if (baseChanged) {
        ghost.base = poseBase?.clone() ?? null;
        ghost.group.matrix.copy(ghost.base ? ghost.base.clone().premultiply(inverseScene) : base);
      }
      const names = pose.jointNames ?? [], q = pose.q ?? [];
      const changed = !ghost.q || q.length !== ghost.q.length || names.length !== ghost.names.length
        || q.some((value, i) => value !== ghost.q[i]) || names.some((name, i) => name !== ghost.names[i]);
      if (changed) {
        // A primary pose may reuse a comparison slot whose descriptor also
        // supplied fixed gripper joints. Restore omitted coordinates from the
        // current solid source before applying the new explicit pose. Cloned
        // mimic references ensure both passes reset without moving the source.
        for (const name of ghost.names || []) {
          if (names.includes(name)) continue;
          const values = sourceJoints.get(name)?.jointValue;
          if (!values?.length || !values.every(Number.isFinite)) continue;
          ghost.color.joints.get(name)?.setJointValue(...values);
          ghost.depth?.joints.get(name)?.setJointValue(...values);
        }
        names.forEach((name, i) => {
          if (!Number.isFinite(q[i])) return;
          ghost.color.joints.get(name)?.setJointValue(q[i]);
          ghost.depth?.joints.get(name)?.setJointValue(q[i]);
        });
        ghost.q = Array.from(q);
        ghost.names = Array.from(names);
      }
      if (changed || baseChanged) updateBounds(ghost);
      const opacity = Math.max(0, Math.min(1, pose.opacity ?? 0.35));
      ghost.material.opacity = opacity;
      ghost.material.color.set(pose.color ?? GHOST_COLOR);
      ghost.group.visible = opacity > 0;
      ghost.pose = { id, time: pose.time };
    }
    pool.forEach((ghost) => { if (!used.has(ghost)) { ghost.group.visible = false; ghost.pose = null; } });
  }

  function setBase() {
    if (disposed) return;
    source.parent?.updateWorldMatrix(true, false);
    scene.updateWorldMatrix(true, false);
    base.copy(source.parent?.matrixWorld ?? new Matrix4());
    base.premultiply(inverseScene.copy(scene.matrixWorld).invert());
    pool.forEach((ghost) => { ghost.group.matrix.copy(ghost.base ? ghost.base.clone().premultiply(inverseScene) : base); updateBounds(ghost); });
  }

  function update(camera) {
    if (disposed || !camera) return;
    camera.getWorldPosition(cameraPosition);
    const ordered = [...registered].filter(ghost => shown(ghost.group))
      .sort((a, b) => b.sphere.center.distanceToSquared(cameraPosition) - a.sphere.center.distanceToSquared(cameraPosition) || a.group.id - b.group.id);
    ordered.forEach((ghost, rank) => {
      // Group order sorts before a mesh's renderOrder. Paths/markers inherit
      // group order 0, so negative ghost orders keep those overlays on top.
      // Unique adjacent pass slots across every pool prevent another ghost's
      // prepass from overwriting depth between this ghost's two passes.
      const denominator = ordered.length + 1;
      const order = -2 + rank / denominator;
      ghost.group.renderOrder = order;
      ghost.color.groups.forEach((group) => { group.renderOrder = order; });
      if (ghost.depthGroup) {
        const depthOrder = order - 0.5 / denominator;
        ghost.depthGroup.renderOrder = depthOrder;
        ghost.depth.groups.forEach((group) => { group.renderOrder = depthOrder; });
      }
    });
  }

  function pick(raycaster) {
    if (disposed) return null;
    let nearest = null, result = null;
    for (const ghost of pool) {
      if (!ghost.group.visible || !raycaster.ray.intersectsSphere(ghost.sphere)) continue;
      const hit = raycaster.intersectObjects(ghost.color.meshes, false)[0];
      if (hit && (!nearest || hit.distance < nearest.distance)) { nearest = hit; result = ghost.pose; }
    }
    return result ? { ...result, distance: nearest.distance } : null;
  }

  function clearPool() {
    pool.forEach((ghost) => {
      registered.delete(ghost);
      ghost.material.dispose();
      ghost.depthMaterial?.dispose();
      ghost.group.removeFromParent();
    });
    pool.length = 0;
  }

  function setMethod(next) {
    checkMethod(next);
    if (next === method || disposed) return;
    const poses = pool.filter((ghost) => ghost.pose).map((ghost) => ({ ...ghost.pose,
      q: ghost.q, jointNames: ghost.names, base: ghost.base, opacity: ghost.material.opacity, color: ghost.material.color.getHex() }));
    clearPool();
    method = next;
    set(poses);
  }

  function setLayer(next) {
    checkLayer(next);
    if (disposed) return;
    layer = next;
    container.traverse((object) => object.layers.set(layer));
  }

  setBase();
  return {
    set, setBase, update, pick, setMethod, setLayer,
    dispose() { if (disposed) return; clearPool(); container.removeFromParent(); disposed = true; },
    get snapshot() {
      const active = pool.filter((ghost) => ghost.group.visible);
      const meshCount = active.reduce((sum, ghost) => sum + ghost.color.meshes.length, 0);
      const triangles = active.reduce((sum, ghost) => sum + ghost.color.meshes.reduce((total, mesh) =>
        total + (mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0) / 3, 0), 0);
      return { method, layer, max, allocated: pool.length, count: active.length,
        // Nominal geometry counts for spike setup, not renderer measurements.
        meshCount, nominalCalls: meshCount * (method === 'prepass' ? 2 : 1),
        nominalTriangles: triangles * (method === 'prepass' ? 2 : 1),
        poses: pool.filter((ghost) => ghost.pose).map((ghost) => ({ ...ghost.pose, opacity: ghost.material.opacity })) };
    },
  };
}
