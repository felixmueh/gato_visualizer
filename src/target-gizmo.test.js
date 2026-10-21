import test from 'node:test';
import assert from 'node:assert/strict';
import { targetWorldOffset, targetWorldPosition } from './target-gizmo.js';

test('world-axis dragging converts using the authoritative full-root target, without torso guesses', () => {
  const base=[.35,-.22,.95];
  const offset=[.04,-.01,.02];
  assert.deepEqual(targetWorldPosition(base,offset),[.38999999999999996,-.23,.97]);
  const requested=[.45,-.17,1.05];
  const actual=targetWorldPosition(base,targetWorldOffset(base,requested));
  actual.forEach((value,i)=>assert(Math.abs(value-requested[i])<1e-12));
});

test('drag targets respect the API offset range and reject invalid coordinates', () => {
  assert.deepEqual(targetWorldOffset([.3,-.2,1],[3,-3,1.4]),[1,-1,.3999999999999999]);
  assert.equal(targetWorldOffset([0,0,0],[NaN,1,2]),null);
  assert.equal(targetWorldOffset([0,0,0],[1,2]),null);
});
