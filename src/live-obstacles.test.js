import test from 'node:test';
import assert from 'node:assert/strict';
import { SCALE_MIN_LEVER_PX, boundedSize, obstacleShortcut, pastedCentre, rootToWorld, scaleStep, worldToRoot } from './live-obstacles.js';

const close = (actual, expected, tolerance = 1e-12) => actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < tolerance, `${actual} ≉ ${expected}`));

test('obstacles move between the rows root frame and the world with a rigid transform', () => {
  const c = Math.cos(.3), s = Math.sin(.3);
  const matrix = [[c, -s, 0, -.0245], [s, c, 0, .1], [0, 0, 1, .9452], [0, 0, 0, 1]];
  const world = rootToWorld(matrix, [.342, -.42, -.484, .05]);
  assert.equal(world.length, 4); assert.equal(world[3], .05);
  close(worldToRoot(matrix, world), [.342, -.42, -.484]);
  close(rootToWorld([[1, 0, 0, -.0245], [0, 1, 0, 0], [0, 0, 1, .9452], [0, 0, 0, 1]], [.342, -.42, -.484]), [.3175, -.42, .4612]);
});

test('modal scaling follows the distance ratio, without a jump at its start or when Shift toggles', () => {
  let state = scaleStep({}, 100);
  assert.equal(state.factor, 1);
  state = scaleStep(state, 120); assert.ok(Math.abs(state.factor - 1.2) < 1e-12);
  // Shift: a tenth of each further change of the ratio, continuing from where it was.
  state = scaleStep(state, 140, { fine: true }); assert.ok(Math.abs(state.factor - 1.22) < 1e-12);
  state = scaleStep(state, 120); assert.ok(Math.abs(state.factor - 1.02) < 1e-12);
  // A start near the centre uses the minimum lever: still ratio 1 there, then gentle.
  let near = scaleStep({}, 2); assert.equal(near.factor, 1);
  near = scaleStep(near, 2 + SCALE_MIN_LEVER_PX); assert.ok(Math.abs(near.factor - 2) < 1e-12);
});

test('radii stay on a 1 mm grid within the descriptor bounds', () => {
  const bounds = { min_size: .005, max_size: .5 };
  assert.equal(boundedSize(.05234, bounds), .052);
  assert.equal(boundedSize(.0601, bounds), .06);
  assert.equal(boundedSize(2, bounds), .5);
  assert.ok(boundedSize(0, bounds) > .005);
  assert.equal(boundedSize(.0049, bounds), .006);
});

test('a pasted copy lands where the pointer ray meets the view plane through the copied centre', () => {
  const centre = [1, 0, .5], view = [1, 0, 0], right = [0, -1, 0];
  // Camera at the origin looking along +x; the pointer ray points up and to the left.
  close(pastedCentre(centre, .05, { origin: [0, 0, .5], direction: [Math.SQRT1_2, 0, Math.SQRT1_2], view, right }), [1, 0, 1.5], 1e-12);
  // No pointer over the viewport, or a ray behind the camera: a visible sideways offset.
  close(pastedCentre(centre, .05, { view, right }), [1, -.1, .5]);
  close(pastedCentre(centre, .05, { origin: [0, 0, 0], direction: [-1, 0, 0], view, right }), [1, -.1, .5]);
});

test('obstacle keys stay out of text fields; Ctrl or Cmd copy and paste', () => {
  const key = (key, extra = {}) => obstacleShortcut({ key, target: { tagName: 'CANVAS' }, ...extra });
  assert.equal(key('Escape'), 'deselect'); assert.equal(key('Delete'), 'remove'); assert.equal(key('Backspace'), 'remove');
  assert.equal(key('s'), 'scale'); assert.equal(key('T'), 'translate'); assert.equal(key('g'), 'translate'); assert.equal(key('Enter'), 'confirm');
  assert.equal(key('r'), 'rotate'); assert.equal(key('q'), null);
  assert.equal(key('c', { ctrlKey: true }), 'copy'); assert.equal(key('v', { metaKey: true }), 'paste');
  // Undo and redo belong to the settings history (settings-history.js).
  assert.equal(key('z', { ctrlKey: true }), null); assert.equal(key('y', { ctrlKey: true }), null); assert.equal(key('s', { ctrlKey: true }), null);
  assert.equal(obstacleShortcut({ key: 'Delete', target: { tagName: 'INPUT' } }), null);
  assert.equal(obstacleShortcut({ key: 'v', ctrlKey: true, target: { tagName: 'TEXTAREA' } }), null);
});
