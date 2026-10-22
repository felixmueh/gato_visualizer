import test from "node:test";
import assert from "node:assert/strict";
import { Group, Mesh, MeshBasicMaterial, BoxGeometry } from "three";
import { createLimitTint, tintedQuantities } from "./limit-tint.js";
import { jointLimitUse } from "./limit-use.js";

const one = { lower_position_rad: [-1], upper_position_rad: [1], velocity_rad_s: [2], effort_nm: [40] };
const colors = { near: 0xf2b544, at: 0xff4b4b, beyond: 0xff4b4b };

function robotWithLink() {
  const robot = new Group();
  const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ color: 0x336699 }));
  const link = new Group(); link.isURDFLink = true; link.add(mesh);
  const joint = new Group(); joint.isURDFJoint = true; joint.add(link);
  robot.joints = { j1: joint }; robot.add(joint);
  return { robot, mesh };
}

test("links take their joint's worst distinct state; within restores the original colour", () => {
  const { robot, mesh } = robotWithLink();
  const original = mesh.material.color.getHex();
  const tint = createLimitTint({ robot, jointNames: ["j1"], colors });
  tint.update({ q: [0], torque: [37], limits: one });
  assert.equal(tint.links[0].state, "near"); assert.equal(mesh.material.color.getHex(), colors.near);
  tint.update({ q: [.999], torque: [37], limits: one });
  assert.equal(tint.links[0].state, "at"); assert.equal(mesh.material.color.getHex(), colors.at);
  const outline = () => mesh.children.find((child) => child.name === "limit-beyond-outline");
  assert.equal(outline(), undefined);
  tint.update({ q: [0], torque: [41], limits: one });
  assert.equal(tint.links[0].state, "beyond"); assert.equal(outline().visible, true);
  tint.update({ q: [0], torque: [10], limits: one });
  assert.equal(mesh.material.color.getHex(), original); assert.equal(tint.links[0].use, null); assert.equal(outline().visible, false);
  tint.update({ q: [0], torque: [41], limits: one }); tint.setEnabled(false);
  assert.equal(mesh.material.color.getHex(), original); assert.equal(outline().visible, false);
});

test("settings move the near threshold immediately", () => {
  const { robot } = robotWithLink();
  const tint = createLimitTint({ robot, jointNames: ["j1"], colors });
  tint.update({ q: [.85], limits: one });
  assert.equal(tint.links[0].state, null);
  tint.setSettings({ limit_near_percent: 80 });
  assert.equal(tint.links[0].state, "near");
});

test("tooltip lines list non-within quantities worst first", () => {
  const use = jointLimitUse({ q: [.95], qd: [0], torque: [40.5], limits: one }, 0);
  assert.deepEqual(tintedQuantities(use).map((item) => `${item.quantity}:${item.state}`), ["torque:beyond", "position:near"]);
});
