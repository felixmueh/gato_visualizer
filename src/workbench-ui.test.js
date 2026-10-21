import test from 'node:test';
import assert from 'node:assert/strict';
import { bindStopPreference } from './workbench-ui.js';
import { fitAuxiliaryCamera } from './auxiliary-views.js';
import { Box3, OrthographicCamera, Vector3 } from 'three';

class Checkbox extends EventTarget { checked = false; }

test('Stop inversely follows Continue and emits only its local preference change', () => {
  const stop = new Checkbox(), continuation = new Checkbox(); let changes = 0;
  continuation.addEventListener('change', () => changes++);
  const update = bindStopPreference(stop, continuation);
  assert.equal(stop.checked, true);
  stop.checked = false; stop.dispatchEvent(new Event('change')); assert.equal(continuation.checked, true); assert.equal(changes, 1);
  continuation.checked = false; update(); assert.equal(stop.checked, true); assert.equal(changes, 1);
});

test('auxiliary Top keeps robot forward X right and both views frame the same world bounds', () => {
  const bounds = new Box3(new Vector3(-.5, -.4, 0), new Vector3(1.5, .6, 1.8));
  for (const name of ['top', 'right']) for (const aspect of [.6, 1.5]) {
    const camera = new OrthographicCamera(); camera.userData.view = name;
    assert.equal(fitAuxiliaryCamera(camera, bounds, aspect), true);
    const origin = new Vector3().project(camera), forward = new Vector3(.1, 0, 0).project(camera);
    assert(forward.x > origin.x);
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const projected = new Vector3(x, y, z).project(camera);
      assert(Math.abs(projected.x) <= 1 / 1.18 + 1e-9); assert(Math.abs(projected.y) <= 1 / 1.18 + 1e-9);
    }
  }
});
