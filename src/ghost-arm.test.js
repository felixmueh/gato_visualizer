import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial, Matrix4, PerspectiveCamera, Raycaster, Scene, Vector3 } from 'three';
import { URDFJoint, URDFMimicJoint } from 'urdf-loader/src/URDFClasses.js';
import { createGhostArms } from './ghost-arm.js';
import { WebGLRenderList } from 'three/src/renderers/webgl/WebGLRenderLists.js';

function fixture(method = 'plain', layer = 0) {
  const scene = new Scene(), robot = new Group(), torso = new Group();
  scene.add(robot); robot.add(torso); torso.position.z = 1;
  const joint = new URDFJoint();
  joint.urdfName = 'arm_right_1_joint'; joint.jointType = 'revolute';
  joint.axis.set(0, 0, 1); joint.limit.lower = -1; joint.limit.upper = 1;
  joint.setJointValue(0);
  const finger = new URDFMimicJoint();
  finger.urdfName = 'finger'; finger.jointType = 'prismatic';
  finger.limit.upper = 1; finger.setJointValue(0); joint.mimicJoints = [finger]; joint.add(finger);
  const mesh = new Mesh(new BoxGeometry(.2, .2, .2), new MeshStandardMaterial());
  mesh.position.x = .5; joint.add(mesh); torso.add(joint);
  const outline = new LineSegments(mesh.geometry, new LineBasicMaterial());
  outline.name = 'limit-beyond-outline'; mesh.add(outline);
  robot.joints = { arm_right_1_joint: joint };
  const ghosts = createGhostArms({ robot, scene, method, layer });
  return { scene, robot, torso, joint, finger, mesh, ghosts };
}

function pose(overrides = {}) {
  return { id: 'one', time: 1, q: [1.5], jointNames: ['arm_right_1_joint'], opacity: .2, ...overrides };
}

test('ghost poses share geometry, own materials, preserve native joints and isolate mimics', () => {
  const { scene, mesh, joint, finger, ghosts } = fixture();
  ghosts.set([pose()]);
  const group = scene.getObjectByName('ghost-arm');
  const clonedJoint = group.children[0], clonedMesh = clonedJoint.children.find((item) => item.isMesh);
  assert.equal(clonedMesh.geometry, mesh.geometry);
  assert.notEqual(clonedMesh.material, mesh.material);
  assert.equal(group.getObjectByName('limit-beyond-outline'), undefined);
  assert.equal(clonedJoint.jointValue[0], 1.5); // No clamping to raw URDF limits.
  assert.equal(joint.jointValue[0], 0);
  assert.equal(finger.jointValue[0], 0);
  assert.notEqual(clonedJoint.mimicJoints[0], finger);
  let calls = 0;
  const originalSet = clonedJoint.setJointValue.bind(clonedJoint);
  clonedJoint.setJointValue = (...values) => { calls++; return originalSet(...values); };
  ghosts.set([pose({ opacity: .4 })]);
  assert.equal(calls, 0);
  assert.equal(clonedMesh.material.opacity, .4);
  let geometryDisposals = 0, originalDisposals = 0, ghostDisposals = 0;
  mesh.geometry.addEventListener('dispose', () => geometryDisposals++);
  mesh.material.addEventListener('dispose', () => originalDisposals++);
  clonedMesh.material.addEventListener('dispose', () => ghostDisposals++);
  ghosts.dispose(); ghosts.dispose();
  assert.equal(geometryDisposals, 0); assert.equal(originalDisposals, 0); assert.equal(ghostDisposals, 1);
  assert.equal(scene.getObjectByName('ghost-arms'), undefined);
});

test('base transforms, bounding sphere picking and hidden ghosts follow recorded poses', () => {
  const { torso, ghosts } = fixture();
  ghosts.set([pose({ q: [0] })]);
  const ray = new Raycaster(new Vector3(.5, 0, 2), new Vector3(0, 0, -1));
  assert.deepEqual(ghosts.pick(ray), { id: 'one', time: 1 });
  torso.position.x = 2; ghosts.setBase();
  assert.equal(ghosts.pick(ray), null);
  ray.ray.origin.x = 2.5;
  assert.deepEqual(ghosts.pick(ray), { id: 'one', time: 1 });
  ghosts.set([pose({ opacity: 0 })]);
  assert.equal(ghosts.pick(ray), null);
  ghosts.set([]); assert.equal(ghosts.snapshot.count, 0);
  ghosts.dispose();
});

test('method changes preserve poses, pool stays bounded and prepass order is per ghost', () => {
  const { scene, ghosts } = fixture('prepass');
  ghosts.set(Array.from({ length: 30 }, (_, i) => pose({ id: i, q: [i / 30], time: i })));
  assert.equal(ghosts.snapshot.count, 24); assert.equal(ghosts.snapshot.allocated, 24);
  assert.equal(ghosts.snapshot.nominalCalls, 48);
  assert.equal(ghosts.snapshot.nominalTriangles, 24 * 12 * 2);
  const camera = new Group(); camera.position.set(3, 3, 3);
  ghosts.update(camera);
  for (const group of scene.getObjectByName('ghost-arms').children) {
    assert(group.children[1].renderOrder < group.renderOrder);
    assert(group.renderOrder < 0); // Paths inherit transparent group order 0.
  }
  ghosts.setMethod('flat');
  assert.equal(ghosts.snapshot.count, 24); assert.equal(ghosts.snapshot.nominalCalls, 24);
  assert.equal(ghosts.snapshot.poses[0].time, 0);
  const mesh = scene.getObjectByName('ghost-arm').children[0].children.find((item) => item.isMesh);
  assert.equal(mesh.material.isMeshBasicMaterial, true); assert.equal(mesh.material.depthWrite, true);
  assert.throws(() => ghosts.setMethod('unknown'));
  ghosts.dispose();
});

test('layer selection reaches every ghost descendant across allocation and method changes', () => {
  const { scene, robot, ghosts } = fixture('prepass', 1);
  function assertLayers(layer) {
    scene.getObjectByName('ghost-arms').traverse((object) => assert.equal(object.layers.mask, 1 << layer));
    robot.traverse((object) => assert.equal(object.layers.mask, 1));
    assert.equal(ghosts.snapshot.layer, layer);
  }
  ghosts.set([pose()]); assertLayers(1);
  ghosts.setLayer(2); assertLayers(2);
  ghosts.set([pose(), pose({ id: 'two' })]); assertLayers(2);
  ghosts.setMethod('plain'); assertLayers(2);
  ghosts.setLayer(0); assertLayers(0);
  assert.throws(() => ghosts.setLayer(32));
  assert.throws(() => ghosts.setLayer(-1));
  ghosts.dispose();
});


test('uncapped track pool preserves per-pose world bases through fixed-joint changes and method changes', () => {
  const { scene, robot, torso, ghosts: onion } = fixture();
  const ghosts = createGhostArms({ robot, scene, max: Infinity, method: 'prepass' });
  const explicitBase = new Matrix4().makeTranslation(2, 0, 3);
  const poses = Array.from({ length: 30 }, (_, i) => pose({ id: i, q: [0], base: i === 0 ? explicitBase : undefined }));
  ghosts.set(poses);
  assert.equal(ghosts.snapshot.count, 30);
  const groups = scene.getObjectsByProperty('name', 'ghost-arms')[1].children;
  assert.deepEqual(groups[0].matrix.elements, explicitBase.elements);
  explicitBase.makeTranslation(9, 0, 3); // Input matrices are not retained by reference.
  torso.position.x = 4; ghosts.setBase();
  assert.equal(groups[0].matrix.elements[12], 2);
  assert.equal(groups[1].matrix.elements[12], 4);
  ghosts.set([pose({ id: 0, q: [0], base: new Matrix4().makeTranslation(3, 0, 3) })]);
  const ray = new Raycaster(new Vector3(3.5, 0, 4), new Vector3(0, 0, -1));
  assert.deepEqual(ghosts.pick(ray), { id: 0, time: 1 });
  ghosts.setMethod('flat');
  assert.deepEqual(ghosts.pick(ray), { id: 0, time: 1 });
  ghosts.setMethod('prepass');
  ghosts.set(poses);
  const camera = new Group(); camera.position.set(3, 3, 3); ghosts.update(camera);
  const orders = scene.getObjectsByProperty('name', 'ghost-arms')[1].children.map(group => group.renderOrder);
  assert.equal(new Set(orders).size, 30);
  assert(orders.every(Number.isFinite));
  ghosts.dispose(); onion.dispose();
});

test('reusing a comparison slot restores omitted gripper joints and cloned mimics to the primary source', () => {
  const { scene, robot, joint, ghosts: oldPool } = fixture('prepass'); oldPool.dispose();
  const gripper = new URDFJoint(); gripper.urdfName = 'gripper'; gripper.jointType = 'prismatic'; gripper.limit.upper = .1;
  const mimic = new URDFMimicJoint(); mimic.urdfName = 'gripper_mimic'; mimic.jointType = 'prismatic'; mimic.limit.upper = .1;
  gripper.mimicJoints = [mimic]; gripper.add(mimic); gripper.setJointValue(.02); joint.add(gripper);
  const ghosts = createGhostArms({ robot, scene, max: Infinity, method: 'prepass' });
  ghosts.set([pose({ id: 'comparison', jointNames: ['gripper', 'arm_right_1_joint'], q: [.07, .4] })]);
  const group = scene.getObjectByName('ghost-arm'), color = group.children[0], depth = group.children[1].children[0];
  const find = (root, name) => root.getObjectsByProperty('urdfName', name)[0];
  assert.equal(find(color, 'gripper').jointValue[0], .07); assert.equal(find(depth, 'gripper_mimic').jointValue[0], .07);
  ghosts.set([]); // A removed track leaves its slot available for primary ghosts.
  ghosts.set([pose({ id: 'primary', q: [.4] })]);
  for (const root of [color, depth]) {
    assert.equal(find(root, 'gripper').jointValue[0], .02); assert.equal(find(root, 'gripper_mimic').jointValue[0], .02);
    assert.equal(root.jointValue[0], .4);
  }
  let sets = 0;
  for (const root of [color, depth]) root.traverse(object => {
    if (!object.isURDFJoint) return;
    const original = object.setJointValue.bind(object); object.setJointValue = (...values) => { sets++; return original(...values); };
  });
  ghosts.set([pose({ id: 'primary', q: [.4], opacity: .5 })]); assert.equal(sets, 0);
  assert.equal(gripper.jointValue[0], .02); assert.equal(mimic.jointValue[0], .02); assert.equal(joint.jointValue[0], 0);
  ghosts.dispose();
});

test('actual Three transparent sorting keeps globally ordered ghost depth/color pairs across pools and lifecycle changes', () => {
  const { scene, robot, joint, ghosts: original } = fixture(); original.dispose();
  const nested = new Group(); nested.add(new Mesh(new BoxGeometry(.1, .1, .1), new MeshStandardMaterial())); joint.add(nested);
  const trackParent = new Group(); scene.add(trackParent);
  const current = createGhostArms({ robot, scene: trackParent, max: Infinity, method: 'prepass' });
  const temporal = createGhostArms({ robot, scene, max: Infinity, method: 'prepass' });
  const at = (id, z) => pose({ id, q: [0], base: new Matrix4().makeTranslation(0, 0, z) });
  current.set([at('current', 1)]); temporal.set([at('far', 0), at('near', 2)]);
  const camera = new PerspectiveCamera(50, 1, .01, 100);
  function tag() {
    for (const [container, labels] of [[trackParent.getObjectByName('ghost-arms'), ['current']], [scene.children.find(object => object.name === 'ghost-arms'), ['far', 'near']]]) {
      container?.children.forEach((group, i) => group.traverse(object => { if (object.isMesh) object.userData.drawLabel = `${labels[i]}:${object.material.colorWrite ? 'color' : 'depth'}`; }));
    }
  }
  function drawOrder() {
    tag(); scene.updateMatrixWorld(true); const list = WebGLRenderList();
    // This is projectObject's Group-order inheritance and real render-list sort,
    // not an independent comparator that could agree with a broken renderer.
    function project(object, groupOrder = 0) {
      if (!object.visible) return;
      if (object.isGroup) groupOrder = object.renderOrder;
      if (object.isMesh && object.userData.drawLabel) list.push(object, object.geometry, object.material, groupOrder,
        new Vector3().setFromMatrixPosition(object.matrixWorld).project(camera).z, null);
      object.children.forEach(child => project(child, groupOrder));
    }
    project(scene); list.sort();
    return list.transparent.map(item => item.object.userData.drawLabel).filter((label, i, all) => !i || all[i - 1] !== label);
  }
  try {
    camera.position.set(.5, 0, 4); camera.lookAt(.5, 0, 0); camera.updateMatrixWorld(true);
    current.update(camera); temporal.update(camera); // Existing main/aux render hooks update both pools.
    assert.deepEqual(drawOrder(), ['far:depth', 'far:color', 'current:depth', 'current:color', 'near:depth', 'near:color']);
    camera.position.z = -4; camera.lookAt(.5, 0, 0); camera.updateMatrixWorld(true); current.update(camera);
    assert.deepEqual(drawOrder(), ['near:depth', 'near:color', 'current:depth', 'current:color', 'far:depth', 'far:color']);
    temporal.setMethod('flat'); current.update(camera);
    assert.deepEqual(drawOrder(), ['near:color', 'current:depth', 'current:color', 'far:color']);
    temporal.setMethod('prepass'); current.update(camera);
    assert.deepEqual(drawOrder(), ['near:depth', 'near:color', 'current:depth', 'current:color', 'far:depth', 'far:color']);
    current.dispose(); temporal.update(camera);
    const groups = scene.children.find(object => object.name === 'ghost-arms').children;
    assert.equal(groups[1].renderOrder, -2); assert.equal(groups[0].renderOrder, -2 + 1 / 3); // Disposed pools leave no rank slots.
    assert.deepEqual(drawOrder(), ['near:depth', 'near:color', 'far:depth', 'far:color']);
  } finally { current.dispose(); temporal.dispose(); }
});
