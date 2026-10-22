import test from "node:test";
import assert from "node:assert/strict";
import { Group, Mesh, MeshBasicMaterial, BoxGeometry } from "three";
import { createLimitTint, describeLimitUse, jointLimitUse, tintStrength } from "./limit-tint.js";

const limits = { lower_position_rad: [-1, -2], upper_position_rad: [1, 2], velocity_rad_s: [2, 2], effort_nm: [40, 43] };

test("worst limit use picks the largest available utilisation and ignores missing data", () => {
  const use = jointLimitUse({ q: [0, 0], qd: [1, 0], torque: [10, 39.56], limits }, 1);
  assert.equal(use.kind, "torque");
  assert(Math.abs(use.fraction - 0.92) < 1e-9);
  assert.equal(describeLimitUse("arm_right_4", use), "arm_right_4 torque 92 % of 43 N m");
  assert.equal(jointLimitUse({ q: [0.9], limits }, 0).kind, "position");
  assert.equal(jointLimitUse({ q: [0.9], qd: null, torque: null, limits: null }, 0), null);
  assert.equal(jointLimitUse({ q: [0], limits }, 0).fraction, 0);
  // No qd/torque: only position can be reported.
  assert.equal(jointLimitUse({ q: [0.5], torque: undefined, limits }, 0).kind, "position");
});

test("tint starts at the threshold and saturates at full limit use", () => {
  assert.equal(tintStrength(0.79), 0);
  assert.equal(tintStrength(0.8), 0);
  assert(Math.abs(tintStrength(0.9) - 0.5) < 1e-12);
  assert.equal(tintStrength(1.3), 1);
  assert.equal(tintStrength(NaN), 0);
});

test("links tint, restore their original colour, and respect the on/off setting", () => {
  const robot = new Group();
  const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ color: 0x336699 }));
  const link = new Group(); link.isURDFLink = true; link.add(mesh);
  const joint = new Group(); joint.isURDFJoint = true; joint.add(link);
  robot.joints = { j1: joint }; robot.add(joint);
  const original = mesh.material.color.getHex();
  const tint = createLimitTint({ robot, jointNames: ["j1"] });
  const one = { lower_position_rad: [-1], upper_position_rad: [1], velocity_rad_s: [2], effort_nm: [40] };
  tint.update({ q: [0], torque: [40], limits: one });
  assert(mesh.material.color.getHex() !== original);
  assert(tint.links[0].use);
  tint.setEnabled(false);
  assert.equal(mesh.material.color.getHex(), original);
  tint.setEnabled(true);
  assert(mesh.material.color.getHex() !== original);
  tint.update({ q: [0], torque: [10], limits: one });
  assert.equal(mesh.material.color.getHex(), original);
  assert.equal(tint.links[0].use, null);
});
