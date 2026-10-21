import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Group, Mesh, PerspectiveCamera, Vector3 } from 'three';
import { fitPerspectivePoints, objectWorldPoints, trajectoryFitPoints } from './camera-fit.js';

function camera(aspect) {
  const value = new PerspectiveCamera(37, aspect, .01, 100);
  value.up.set(0, 0, 1);value.position.set(2, -3, 2);value.lookAt(.2, -.1, .8);
  return value;
}

test('perspective fitting covers depth and both axes with margin in landscape and portrait', () => {
  const points = [[-3,-1,-2],[4,1,2],[-2,3,1],[3,-4,-1]];
  for (const aspect of [2.5, 1, .45]) {
    const view = camera(aspect), orientation = view.quaternion.clone();
    const fit = fitPerspectivePoints(view, points);
    view.position.copy(fit.position);view.near=fit.near;view.far=fit.far;view.updateProjectionMatrix();view.updateMatrixWorld(true);
    assert(view.quaternion.angleTo(orientation) < 1e-7);
    for (const point of points) {
      const ndc = new Vector3(...point).project(view);
      assert(Math.abs(ndc.x) <= 1 / 1.15 + 1e-10);
      assert(Math.abs(ndc.y) <= 1 / 1.15 + 1e-10);
      assert(ndc.z > -1 && ndc.z < 1);
    }
  }
});

test('robot fit uses current world transforms, including transformed parent and changed pose', () => {
  const parent = new Group(), robot = new Group(), arm = new Mesh(new BoxGeometry(1, .3, .4));
  parent.position.set(4, -2, 1);parent.rotation.z=.7;parent.add(robot);robot.add(arm);
  arm.position.set(.8, .2, .5);arm.rotation.y=.6;
  const first = objectWorldPoints(robot);
  arm.position.x=1.6;
  const moved = objectWorldPoints(robot);
  assert(first.some((point,index) => point.distanceTo(moved[index]) > .3));
  const fit = fitPerspectivePoints(camera(.5), moved);
  assert(fit.center.x > 3 && fit.center.y > -3);
  assert.equal(moved.length, 8);
  arm.geometry.dispose();arm.material.dispose();
});

test('empty and coincident inputs stay finite and adjust clipping for large paths', () => {
  const view = camera(1);
  assert.equal(fitPerspectivePoints(view, []), null);
  const point = fitPerspectivePoints(view, [[1,2,3],[1,2,3]]);
  assert.equal(point.distance, .3);assert(point.position.toArray().every(Number.isFinite));
  const large = fitPerspectivePoints(view, [[-100,-50,-50],[100,50,50]]);
  assert(large.far > 100);assert(large.near > 0);
});

test('fit trajectory distinguishes replay, full tracking reference, reach endpoints and explicit rollout', () => {
  const plan = { ee_xyz:[[1,0,0],[9,0,0]], reference_xyz:[[2,0,0]], task_path_xyz:[[0,0,0],[0,1,0]], target_xyz:[2,0,0] };
  const reach = trajectoryFitPoints({live:true,taskKind:'reach',plan,state:{ee_xyz:[.5,0,0]},taskStart:[0,0,0]});
  assert.deepEqual(reach.points.map(p=>p.toArray()), [[0,0,0],[2,0,0]]);
  const tracking = trajectoryFitPoints({live:true,taskKind:'figure8',plan});
  assert.deepEqual(tracking.points.map(p=>p.toArray()), plan.task_path_xyz);
  const saved = trajectoryFitPoints({replay:{kind:'recorded',ee_xyz:[[0,0,0],[1,0,0]],reference_xyz:[[2,0,0]],target_xyz:[3,0,0]}});
  assert.equal(saved.points.length, 4);
  const rollout = trajectoryFitPoints({live:true,plan,precomputedPath:[[5,6,7]]});
  assert.deepEqual(rollout.points[0].toArray(), [5,6,7]);
  assert.match(rollout.source,/precomputed/);
});
