import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Raycaster, Scene, Vector3 } from 'three';
import { URDFJoint } from 'urdf-loader/src/URDFClasses.js';
import { createArmVisibility } from './arm-visibility.js';
import { createGhostArms } from './ghost-arm.js';

test('hidden solid arms are unpickable while newly allocated ghosts remain visible and pickable', () => {
  const scene = new Scene(), robot = new Group(), joint = new URDFJoint();
  joint.urdfName = 'arm_right_1_joint'; joint.jointType = 'revolute'; joint.axis.set(0, 0, 1);
  joint.setJointValue(0); joint.mimicJoints = [];
  const mesh = new Mesh(new BoxGeometry(.2, .2, .2), new MeshBasicMaterial()); joint.add(mesh);
  robot.joints = { arm_right_1_joint: joint }; robot.add(joint); scene.add(robot); scene.updateMatrixWorld(true);
  const ray = new Raycaster(new Vector3(0, 0, 2), new Vector3(0, 0, -1));
  assert(ray.intersectObject(robot, true).length > 0);
  const visibility = createArmVisibility(robot); visibility.setVisible(false);
  assert.equal(visibility.visible, false); assert.equal(ray.intersectObject(robot, true).length, 0);
  assert.equal(joint.visible, true); assert.equal(mesh.visible, true);
  const ghosts = createGhostArms({ robot, scene, method: 'prepass' });
  ghosts.set([{ id: 'recorded', jointNames: ['arm_right_1_joint'], q: [0], time: 1, opacity: .55 }]);
  assert.equal(ghosts.snapshot.count, 1);
  assert.equal(ghosts.pick(ray).id, 'recorded'); assert.equal(ghosts.pick(ray).time, 1);
  assert(Math.abs(ghosts.pick(ray).distance - 1.9) < 1e-7);
  const annotation = new Group(); annotation.layers.set(2); joint.add(annotation);
  visibility.setVisible(false); assert.equal(annotation.layers.mask, 0);
  visibility.setVisible(true); assert.equal(mesh.layers.mask, 1); assert.equal(annotation.layers.mask, 4);
  assert(ray.intersectObject(robot, true).length > 0); assert.equal(ghosts.snapshot.count, 1);
  ghosts.dispose();
});
