import test from "node:test";
import assert from "node:assert/strict";
import { sampleTrajectory, validateTrajectory } from "./playback.js";

const trajectory = {
  id: "recorded",
  time_s: [0, 0.1, 0.7],
  q: [
    [0, 2],
    [1, 4],
    [7, 10],
  ],
  ee_xyz: [
    [0, 0, 0],
    [1, 0, 0],
    [7, 6, 0],
  ],
};

test("interpolation uses nonuniform simulation timestamps, with end clamping", () => {
  assert.deepEqual(
    sampleTrajectory(trajectory, 0.4).q.map((v) => Math.round(v * 1e8) / 1e8),
    [4, 7],
  );
  assert.deepEqual(sampleTrajectory(trajectory, -1).q, [0, 2]);
  assert.deepEqual(sampleTrajectory(trajectory, 2).q, [7, 10]);
  assert.deepEqual(sampleTrajectory(trajectory, 0.1).xyz, [1, 0, 0]);
});

test("single-frame prediction holds its only configuration", () => {
  assert.deepEqual(
    sampleTrajectory({ time_s: [0], q: [[2]], ee_xyz: [[1, 2, 3]] }, 100).q,
    [2],
  );
});

test("rejects ambiguous timestamps and invalid coordinates", () => {
  assert.doesNotThrow(() => validateTrajectory(trajectory, 2));
  assert.throws(
    () => validateTrajectory({ ...trajectory, time_s: [0, 0.1, 0.1] }, 2),
    /strictly increasing/,
  );
  assert.throws(
    () =>
      validateTrajectory(
        {
          ...trajectory,
          q: [
            [NaN, 2],
            [1, 4],
            [7, 10],
          ],
        },
        2,
      ),
    /invalid joint/,
  );
});
