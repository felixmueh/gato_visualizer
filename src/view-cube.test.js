import test from "node:test";
import assert from "node:assert/strict";
import { PerspectiveCamera, Vector3 } from "three";
import { VIEW_CORNERS, VIEW_FACES, cornerVisible, orbitTransition, projectCorner, viewDirection } from "./view-cube.js";

test("all six views follow robot world axes with finite pole orientations", () => {
  const expected = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  VIEW_FACES.forEach((face, i) => {
    const direction = viewDirection(face.name);
    assert(direction.distanceTo(new Vector3(...expected[i])) < 0.00002);
    assert(direction.clone().cross(new Vector3(0,0,1)).length() > 0);
  });
  assert.throws(() => viewDirection("diagonal"), /Unknown camera view/);
});

test("Top places the robot's forward X axis toward screen right", () => {
  const camera = new PerspectiveCamera();
  camera.up.set(0, 0, 1);
  camera.position.copy(viewDirection("top").multiplyScalar(4));
  camera.lookAt(0, 0, 0);
  const screenRight = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  assert(screenRight.dot(new Vector3(1, 0, 0)) > .99999);
  const inverse = camera.quaternion.clone().invert();
  const [x, y] = projectCorner([1, 0, 0], inverse);
  assert(x > 60);
  assert(Math.abs(y - 52) < 1e-10);
});

test("pole approaches keep camera orientation continuous through the last frame", () => {
  for (const from of [...VIEW_FACES, ...VIEW_CORNERS]) {
    for (const to of ["top", "bottom"]) {
      const offsetAt = orbitTransition(viewDirection(from.name).multiplyScalar(4), viewDirection(to));
      const camera = new PerspectiveCamera();
      camera.up.set(0, 0, 1);
      camera.position.copy(offsetAt(.99999));
      camera.lookAt(0, 0, 0);
      const before = camera.quaternion.clone();
      camera.position.copy(offsetAt(1));
      camera.lookAt(0, 0, 0);
      assert(before.angleTo(camera.quaternion) < .0001, `${from.name} to ${to}`);
    }
  }
});

test("all eight corners use equal-angle diagonals and hide vertices behind all three faces", () => {
  assert.equal(new Set(VIEW_CORNERS.map((corner) => corner.name)).size, 8);
  for (const corner of VIEW_CORNERS) {
    const direction = viewDirection(corner.name);
    direction.toArray().forEach((component) => assert(Math.abs(Math.abs(component) - 1 / Math.sqrt(3)) < 1e-12));
    assert(cornerVisible(corner.direction, direction));
    assert(!cornerVisible(corner.direction, direction.clone().negate()));
    assert(cornerVisible(corner.direction, new Vector3(corner.direction[0], 0, 0)));
  }
});

test("face and corner transitions preserve pan target and orbit radius, even between opposite views", () => {
  const target = new Vector3(0.4, -1.8, 0.7);
  for (const from of [...VIEW_FACES, ...VIEW_CORNERS]) {
    for (const to of [...VIEW_FACES, ...VIEW_CORNERS]) {
      const start = viewDirection(from.name).multiplyScalar(3.7);
      const offsetAt = orbitTransition(start, viewDirection(to.name));
      for (const t of [0, .1, .5, .9, 1]) {
        const cameraPosition = target.clone().add(offsetAt(t));
        assert(Math.abs(cameraPosition.distanceTo(target) - 3.7) < 1e-12);
        assert(cameraPosition.toArray().every(Number.isFinite));
      }
      assert(offsetAt(0).distanceTo(start) < 1e-12);
      assert(offsetAt(1).normalize().distanceTo(viewDirection(to.name)) < 1e-12);
    }
  }
});
