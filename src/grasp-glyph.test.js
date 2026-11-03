import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { createGraspGlyph, disposeGlyph, GLYPH_HALF_WIDTH_M, GLYPH_STEM_M, heldRotvec, interpolatedRotvec,
  setGlyphColor, setGlyphPose } from './grasp-glyph.js';

const close = (actual, expected, tolerance = 1e-12) =>
  actual.forEach((value, i) => assert(Math.abs(value - expected[i]) < tolerance, `${actual} ≠ ${expected}`));

test('references hold each orientation sample; recordings interpolate along the shortest rotation', () => {
  const times = [1, 2, 4], references = [[0, 0, .2], null, [0, 0, .6]];
  assert.deepEqual(heldRotvec(times, references, 0), [0, 0, .2]);  // the first before the start
  assert.deepEqual(heldRotvec(times, references, 1.9), [0, 0, .2]);
  assert.equal(heldRotvec(times, references, 2), null);
  assert.deepEqual(heldRotvec(times, references, 9), [0, 0, .6]);
  assert.equal(heldRotvec(times, [[0, 0, 1]], 1), null);  // mismatched lengths
  close(interpolatedRotvec([0, 1], [[0, 0, .2], [0, 0, .6]], .25), [0, 0, .3]);
  close(interpolatedRotvec([0, 1], [[0, 0, 3], [0, 0, -3]], .5), [0, 0, Math.PI], 1e-9);  // across pi, not through 0
  assert.deepEqual(interpolatedRotvec([0, 1], [[0, 0, .2], [0, 0, .6]], 5), [0, 0, .6]);
});

test('the glyph puts the stem behind the grasp point along the approach axis and the crossbar along the fingers', () => {
  const glyph = createGraspGlyph({ color: 0xffb547 });
  assert.equal(glyph.visible, false);
  assert(setGlyphPose(glyph, [1, 2, 3], [0, 0, Math.PI / 2]));
  glyph.updateMatrixWorld(true);
  const world = local => new Vector3(...local).applyMatrix4(glyph.matrixWorld).toArray();
  close(world([0, 0, -GLYPH_STEM_M]), [1, 2, 3 - GLYPH_STEM_M]);  // the approach axis (grasp z) is unchanged by a turn about z
  close(world([0, GLYPH_HALF_WIDTH_M, 0]), [1 - GLYPH_HALF_WIDTH_M, 2, 3]);  // grasp +y turns to world −x
  const knob = glyph.getObjectByName('grasp-glyph-knob').getWorldPosition(new Vector3()).toArray();
  close(knob, [1 - GLYPH_HALF_WIDTH_M, 2, 3]);  // the knob marks +y, so a half turn about z is visible
  close(glyph.quaternion.toArray(), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2).toArray());
  setGlyphColor(glyph, 0x6fdc8c, .5);  // a track's colour; the dark outline that keeps it legible stays
  assert.equal(glyph.getObjectByName('grasp-glyph-stem').material.color.getHex(), 0x6fdc8c);
  assert.equal(glyph.getObjectByName('grasp-glyph-knob').material.opacity, .5);
  assert.equal(glyph.getObjectByName('grasp-glyph-halo-stem').material.color.getHex(), 0x0b1220);
  assert.equal(setGlyphPose(glyph, [1, 2, 3], null), false); assert.equal(glyph.visible, false);
  assert.equal(setGlyphPose(glyph, null, [0, 0, 1]), false);
  disposeGlyph(glyph);
});
