import test from 'node:test';
import assert from 'node:assert/strict';
import { orientationGoal, taskReference, taskReferencePoint } from './task-reference.js';

const task = { kind: 'figure8', target_offset_m: [.1, -.2, .3], width_m: .24, height_m: .16, period_s: 8 };
const close = (actual, expected) => actual.forEach((value, i) => assert(Math.abs(value - expected[i]) < 1e-12));

test('local figure-eight matches the backend phase geometry and rotates around the translated fixed start', () => {
  const base = [.4, -.3, 1.2], plain = taskReference(task, base);
  close(plain.points[0], [.5, -.5, 1.5]);
  close(plain.points[32], [.5 + .12 * (1 - Math.SQRT1_2), -.42, 1.5]);
  close(plain.points[128], [.74, -.5, 1.5]);
  close(plain.points[256], plain.points[0]);
  const rotated = taskReference({ ...task, orientation_xyzw: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }, base);
  close(rotated.points[0], plain.points[0]);
  close(rotated.points[128], [.5, -.26, 1.5]);
  const transformed = { ...task, width_m: .48, height_m: .32, orientation_xyzw: [0, 0, Math.SQRT1_2, Math.SQRT1_2] };
  close(taskReferencePoint(transformed, base, 4), [.5, -.02, 1.5]);
  close(taskReferencePoint(transformed, base, 1), taskReference(transformed, base).points[32]);
  const scaled = taskReference({ ...task, width_m: .48 }, base);
  close(scaled.points[128], [.98, -.5, 1.5]);
  taskReference({ ...task, period_s: 99 }, base).points.forEach((point, i) => close(point, plain.points[i]));
});

test('reach uses its own base and malformed drafts do not render invented geometry', () => {
  const reach = taskReference({ kind: 'reach', target_offset_m: [.15, .2, .2] }, [.7, -.2, .9]);
  assert.deepEqual(reach.target_xyz, [.85, 0, 1.1]);
  assert.equal(taskReference(task, null), null);
  assert.equal(taskReference({ ...task, width_m: NaN }, [0,0,0]), null);
  assert.equal(taskReference({ ...task, orientation_xyzw: [0,0,0,0] }, [0,0,0]), null);
});

test('a reach draft carries its orientation goal; position-only reaches and figure eights carry none', () => {
  const goal = [0, 0, .5];
  const reach = taskReference({ kind: 'reach', target_offset_m: [0, 0, 0], orientation_rad: goal }, [.7, -.2, .9]);
  assert.deepEqual(reach.orientation_rotvec, goal);
  assert.notEqual(reach.orientation_rotvec, goal);  // a copy: editing the draft cannot move the drawn goal
  assert.equal(taskReference({ kind: 'reach', target_offset_m: [0, 0, 0], orientation_rad: null }, [0, 0, 0]).orientation_rotvec, null);
  assert.equal(taskReference({ ...task, orientation_rad: goal }, [0, 0, 0]).orientation_rotvec, null);
  assert.equal(orientationGoal({ kind: 'reach', orientation_rad: [0, NaN, 0] }), null);
});
