import {
  Box3, EqualDepth, FrontSide, Group, Matrix4, MeshBasicMaterial,
  MeshStandardMaterial, Sphere, Vector3,
} from 'three';

export const GHOST_METHODS = Object.freeze(['plain', 'prepass', 'flat']);
export const GHOST_COLOR = 0x9ca9b8;

// Recorded poses only. Geometry belongs to the solid robot; every material and
// transform below belongs to this pool. Keyframe selection belongs to its caller.
export function createGhostArms({ robot, scene, armRoot = 'arm_right_1_joint', max = 24, method = 'plain' }) {
  const source = robot.joints?.[armRoot];
  if (!source) throw new Error(`Ghost arm root ${armRoot} is missing.`);
  if (!Number.isInteger(max) || max < 1 || max > 24) throw new Error('Ghost arm pool must contain 1–24 arms.');
  checkMethod(method);
  const container = new Group();
  container.name = 'ghost-arms';
  scene.add(container);
  const base = new Matrix4(), inverseScene = new Matrix4(), box = new Box3();
  const cameraPosition = new Vector3();
  const pool = [];
  let disposed = false;

  function checkMethod(value) {
    if (!GHOST_METHODS.includes(value)) throw new Error(`Unknown ghost arm method: ${value}`);
  }

  function cloneArm(material) {
    const root = source.clone(true), joints = new Map(), meshes = [], groups = [], removed = [];
    root.traverse((object) => {
      if (object.name === 'limit-beyond-outline') removed.push(object);
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
    container.add(group);
    const ghost = { group, color, material, depth, depthGroup, depthMaterial,
      sphere: new Sphere(), pose: null, q: null, names: null };
    pool.push(ghost);
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
      const names = pose.jointNames ?? [], q = pose.q ?? [];
      const changed = !ghost.q || q.length !== ghost.q.length || names.length !== ghost.names.length
        || q.some((value, i) => value !== ghost.q[i]) || names.some((name, i) => name !== ghost.names[i]);
      if (changed) {
        names.forEach((name, i) => {
          if (!Number.isFinite(q[i])) return;
          ghost.color.joints.get(name)?.setJointValue(q[i]);
          ghost.depth?.joints.get(name)?.setJointValue(q[i]);
        });
        ghost.q = Array.from(q);
        ghost.names = Array.from(names);
        updateBounds(ghost);
      }
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
    pool.forEach((ghost) => { ghost.group.matrix.copy(base); updateBounds(ghost); });
  }

  function update(camera) {
    if (disposed || !camera) return;
    camera.getWorldPosition(cameraPosition);
    const ordered = pool.filter((ghost) => ghost.group.visible)
      .sort((a, b) => b.sphere.center.distanceToSquared(cameraPosition) - a.sphere.center.distanceToSquared(cameraPosition));
    ordered.forEach((ghost, rank) => {
      // Keep all ghosts below path orders 3–4 and markers 5–6.
      const order = 1 + rank / (max + 1);
      ghost.group.renderOrder = order;
      ghost.color.groups.forEach((group) => { group.renderOrder = order; });
      if (ghost.depthGroup) {
        const depthOrder = order - 0.5 / (max + 1);
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
    return result ? { ...result } : null;
  }

  function clearPool() {
    pool.forEach((ghost) => {
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
      q: ghost.q, jointNames: ghost.names, opacity: ghost.material.opacity, color: ghost.material.color.getHex() }));
    clearPool();
    method = next;
    set(poses);
  }

  setBase();
  return {
    set, setBase, update, pick, setMethod,
    dispose() { if (disposed) return; clearPool(); container.removeFromParent(); disposed = true; },
    get snapshot() {
      const active = pool.filter((ghost) => ghost.group.visible);
      const meshCount = active.reduce((sum, ghost) => sum + ghost.color.meshes.length, 0);
      const triangles = active.reduce((sum, ghost) => sum + ghost.color.meshes.reduce((total, mesh) =>
        total + (mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0) / 3, 0), 0);
      return { method, max, allocated: pool.length, count: active.length,
        // Nominal geometry counts for spike setup, not renderer measurements.
        meshCount, nominalCalls: meshCount * (method === 'prepass' ? 2 : 1),
        nominalTriangles: triangles * (method === 'prepass' ? 2 : 1),
        poses: pool.filter((ghost) => ghost.pose).map((ghost) => ({ ...ghost.pose, opacity: ghost.material.opacity })) };
    },
  };
}
