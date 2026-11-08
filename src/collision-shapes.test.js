import test from 'node:test';
import assert from 'node:assert/strict';
import { createShapesGroup, shapeCentre, shapeFromWorld, shapeToWorld, translateShape } from './collision-shapes.js';
import { clampShape } from './shape-layouts.js';

const close = (actual, expected, tolerance = 1e-9) => assert.ok(actual.length === expected.length && actual.every((value, i) => Math.abs(value - expected[i]) < tolerance), `${actual} ≉ ${expected}`);
const c = Math.cos(.4), s = Math.sin(.4);
// Root frame turned about z by 0.4 rad and moved: obstacles keep their shape in the world.
const matrix = [[c, -s, 0, .1], [s, c, 0, -.2], [0, 0, 1, .9452], [0, 0, 0, 1]];

test('every shape goes from the root frame to the world and back', () => {
  const items = { sphere: [.3, -.4, -.2, .05], capsule: [.3, -.5, -.2, .3, -.3, -.2, .04],
    box: [.3, -.4, -.2, 0, 0, Math.sin(.25), Math.cos(.25), .05, .1, .15], plane: [0, 0, 2, -1.2] };
  for (const [shape, values] of Object.entries(items)) {
    const back = shapeFromWorld(shape, shapeToWorld(shape, values, matrix), matrix);
    close(back, shape === 'plane' ? [0, 0, 1, -.6] : values);
  }
  // The box turns with the frame: its world quaternion is about z by 0.5 + 0.4 rad.
  close(shapeToWorld('box', items.box, matrix).slice(3, 7), [0, 0, Math.sin(.45), Math.cos(.45)]);
  // The plane's world offset includes the frame's height: z ≥ -0.6 + 0.9452.
  close(shapeToWorld('plane', items.plane, matrix), [0, 0, 1, .3452]);
});

test('centres, moves along a plane normal and recorded groups', () => {
  close(shapeCentre('capsule', [0, 0, 0, 0, .2, 0, .05]), [0, .1, 0]);
  close(shapeCentre('plane', [0, 0, 1, .3], [.1, .2, 1]), [.1, .2, .3]);
  close(translateShape('plane', [0, 0, 1, .3], [.5, .5, .1]), [0, 0, 1, .4]);
  close(translateShape('capsule', [0, 0, 0, 0, .2, 0, .05], [1, 0, 0]), [1, 0, 0, 1, .2, 0, .05]);
  const group = createShapesGroup({ obstacles: [[0, 0, 1, .1]], capsules: [[0, 0, 0, 0, .2, 0, .05]], boxes: [[0, 0, 0, 0, 0, 0, 1, .1, .1, .1]], planes: [[0, 0, 1, 0]] });
  assert.deepEqual(group.children.map(object => object.name), ['track-obstacles-sphere', 'track-obstacles-capsule', 'track-obstacles-box', 'track-obstacles-plane']);
  assert.deepEqual(group.children[2].scale.toArray(), [.2, .2, .2]);
});

test('clamping keeps positions, sizes, unit quaternions and planes within the descriptor', () => {
  const box = { shape: 'box', bound: 2, min_size: .005, max_size: .5 }, plane = { shape: 'plane', bound: 2 };
  assert.deepEqual(clampShape(box, [3, 0, 0, 0, 0, 0, 2, 1, .0001, .2]), [2, 0, 0, 0, 0, 0, 1, .5, .006, .2]);
  assert.deepEqual(clampShape(plane, [0, 0, 2, -1.2]), [0, 0, 1, -.6]);
  assert.deepEqual(clampShape({ shape: 'sphere', bound: 2, min_size: .005, max_size: .5 }, [.12345, 0, 0, .05]), [.1235, 0, 0, .05]);
});

test('a plane flips to its other side; a capsule turns about its centre; shapes scale on their own axes', async () => {
  const { flipPlane, rotateCapsule, scaleShape, capsuleRotation } = await import('./collision-shapes.js');
  // Flip: the same plane n·p = d, the other side free.
  close(flipPlane([0, 0, 1, -.6]), [0, 0, -1, .6]);
  close(flipPlane(flipPlane([.6, 0, .8, .2])), [.6, 0, .8, .2]);
  // A quarter turn about z through the centre (0, 0, 1): ends along x become ends along y; radius kept.
  const quarter = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  close(rotateCapsule([-.1, 0, 1, .1, 0, 1, .03], quarter), [0, -.1, 1, 0, .1, 1, .03]);
  // Capsule: fy scales the length about the centre, fx or fz the radius, independently.
  const capsule = [0, 0, 0, 0, 0, .2, .05];
  close(scaleShape('capsule', capsule, [1, 2, 1]), [0, 0, -.1, 0, 0, .3, .05]);
  close(scaleShape('capsule', capsule, [1.5, 1, 1]), [0, 0, 0, 0, 0, .2, .075]);
  close(scaleShape('capsule', capsule, [1, 1, .5]), [0, 0, 0, 0, 0, .2, .025]);
  // Its scale gizmo's local y runs along a→b.
  close(new (await import('three')).Vector3(0, 1, 0).applyQuaternion(capsuleRotation([0, 0, 0, 0, 0, .2, .05])).toArray(), [0, 0, 1]);
  // Box: each half-extent by its own factor, along the box's axes (orientation and centre kept).
  const box = [.3, -.4, -.2, 0, 0, Math.sin(.25), Math.cos(.25), .05, .1, .15];
  close(scaleShape('box', box, [2, 1, .5]), [.3, -.4, -.2, 0, 0, Math.sin(.25), Math.cos(.25), .1, .1, .075]);
  // Sphere: uniform.
  close(scaleShape('sphere', [1, 2, 3, .05], [1, 1.4, 1]), [1, 2, 3, .07]);
});
