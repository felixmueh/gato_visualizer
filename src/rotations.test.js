import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { quaternionToRotvec, relativeRotvec, rotationAngle, rotvecToQuaternion } from './rotations.js';

const close = (actual, expected, tolerance = 1e-12) =>
  actual.forEach((value, i) => assert(Math.abs(value - expected[i]) < tolerance, `${actual} ≠ ${expected}`));

test('rotation vectors and quaternions convert both ways with angles up to pi', () => {
  close(rotvecToQuaternion([0, 0, Math.PI / 2]), [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  assert.deepEqual(rotvecToQuaternion([0, 0, 0]), [0, 0, 0, 1]);
  for (const rotvec of [[.3, -.2, .1], [0, 0, Math.PI - 1e-9], [1e-14, 0, 0], [-2, 1, .5]]) {
    close(quaternionToRotvec(rotvecToQuaternion(rotvec)), Math.hypot(...rotvec) < 1e-12 ? [0, 0, 0] : rotvec, 1e-9);
  }
  // The double cover: q and −q are one rotation, returned with an angle of at most pi.
  close(quaternionToRotvec([0, 0, -Math.SQRT1_2, -Math.SQRT1_2]), [0, 0, Math.PI / 2]);
  close(quaternionToRotvec([0, 0, 2, 0]), [0, 0, Math.PI]);  // normalized first
  for (const bad of [null, [1, 2], [NaN, 0, 0], 'x']) assert.equal(rotvecToQuaternion(bad), null);
  for (const bad of [null, [0, 0, 0, 0], [0, 0, NaN, 1]]) assert.equal(quaternionToRotvec(bad), null);
});

test('the angle between two orientations is the norm of their relative rotation vector', () => {
  assert(Math.abs(rotationAngle([0, 0, .2], [0, 0, .7]) - .5) < 1e-12);
  assert(Math.abs(rotationAngle([0, 0, 3], [0, 0, -3]) - (2 * Math.PI - 6)) < 1e-9);  // the short way round
  assert(Math.abs(rotationAngle([.4, 0, 0], [0, .4, 0]) - 2 * Math.acos(Math.cos(.2) ** 2)) < 1e-12);
  assert.equal(rotationAngle([0, 0, 1], null), null);
});

test('the relative rotation vector turns the actual orientation into the target in the world frame', () => {
  const actual = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), .4);
  const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), .3);
  const target = turn.clone().multiply(actual);  // a world-frame turn applied after actual
  close(relativeRotvec(target.toArray(), actual.toArray()), [0, 0, .3]);
  close(relativeRotvec(actual.toArray(), actual.toArray()), [0, 0, 0]);
  close(relativeRotvec(target.toArray(), actual.clone().set(-actual.x, -actual.y, -actual.z, -actual.w).toArray()), [0, 0, .3]);  // q and −q
});
