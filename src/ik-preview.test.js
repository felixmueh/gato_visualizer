import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser, Document, Element } from 'linkedom';
import URDFLoader from 'urdf-loader';
import { Matrix4, Quaternion, Scene, Vector3 } from 'three';
import { armChain, forwardKinematics } from './arm-kinematics.js';
import { IK_PREVIEW_DEFAULT, IK_PREVIEW_STORAGE_KEY, ikPreviewShown, loadIkPreviewMode, nextIkPreviewMode, reachGoal, reachSeeds,
  REACH_FRAMES_PER_SEED, POLISH_FRAMES, RECHECK_INTERVAL_MS, SETTLE_MS, setupIkPreview } from './ik-preview.js';
import { quaternionToRotvec } from './rotations.js';

Object.assign(globalThis, { DOMParser, Document, Element });
const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/grasp_fk.json', import.meta.url)));
const mpcRoot = process.env.TIAGO_MPC_ROOT || fileURLToPath(new URL('../../tiago_mpc-visualizer-base', import.meta.url));
const loader = new URDFLoader(); loader.parseVisual = loader.parseCollision = false;
const robot = loader.parse(readFileSync(resolve(mpcRoot, 'models/tiago_pro/tiago_pro.urdf'), 'utf8'));
const chain = armChain(robot, { jointNames: fixture.joint_names, grasp: fixture.grasp });
const identity = new Matrix4(), start = fixture.poses[0].q;
// The MPC planning box: raw limits less the 0.1 rad joint margin.
const lower = fixture.lower.map(v => v + .1), upper = fixture.upper.map(v => v - .1);
const pose = label => forwardKinematics(chain, identity, fixture.poses.find(item => item.label === label).q);
const check = (target, orientation = null, seeds = reachSeeds({ start, current: start, lower, upper })) =>
  reachGoal(chain, identity, { target, orientation, posture: start, lower, upper, seeds });

test('the preview control cycles setup only, off and on, and setup only shows during setup', () => {
  assert.equal(IK_PREVIEW_DEFAULT, 'setup');
  assert.deepEqual([nextIkPreviewMode('setup'), nextIkPreviewMode('off'), nextIkPreviewMode('on')], ['off', 'on', 'setup']);
  assert.equal(ikPreviewShown('setup', true), true); assert.equal(ikPreviewShown('setup', false), false);
  assert.equal(ikPreviewShown('on', false), true); assert.equal(ikPreviewShown('off', true), false);
  assert.equal(loadIkPreviewMode({ getItem: () => 'on' }), 'on');
  assert.equal(loadIkPreviewMode({ getItem: () => 'sometimes' }), 'setup');
  assert.equal(loadIkPreviewMode({ getItem() { throw new Error('blocked'); } }), 'setup');
  assert.equal(loadIkPreviewMode(undefined), 'setup');
});

test('the button shows and persists its state, and survives blocked storage', () => {
  const saved = new Map(), listeners = [];
  const button = { dataset: {}, attributes: {}, title: '', addEventListener: (name, fn) => listeners.push(fn), removeEventListener() {},
    setAttribute(name, value) { this.attributes[name] = value; } };
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const preview = setupIkPreview({ robot, scene: new Scene(), jointNames: fixture.joint_names, button, getContext: () => null, storage });
  assert.equal(button.dataset.ikPreview, 'setup'); assert.equal(button.attributes['aria-pressed'], 'true');
  assert.match(button.title, /IK preview of the final pose · setup only/); assert.match(button.title, /not the MPC's predicted final pose/);
  listeners[0](); assert.equal(preview.mode, 'off'); assert.equal(button.attributes['aria-pressed'], 'false');
  assert.equal(saved.get(IK_PREVIEW_STORAGE_KEY), 'off');
  listeners[0](); assert.equal(preview.mode, 'on'); assert.equal(saved.get(IK_PREVIEW_STORAGE_KEY), 'on');
  preview.dispose();
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const fallback = setupIkPreview({ robot, scene: new Scene(), jointNames: fixture.joint_names, button: null, getContext: () => null, storage: blocked });
  fallback.setMode('on'); assert.equal(fallback.mode, 'on');
  assert.throws(() => fallback.setMode('sometimes'), /setup, off or on/);
  fallback.dispose();
});

test('reachable goals: position only and with orientation, inside the planning box', t => {
  const goal = pose('random_06');
  const position = check(goal.grasp), full = check(goal.grasp, goal.rotation);
  assert.equal(position.reachable, true); assert.ok(position.gap_m <= .002); assert.equal(position.orientation_gap_rad, null);
  assert.equal(full.reachable, true); assert.ok(full.orientation_gap_rad <= Math.PI / 180);
  position.q.forEach((v, i) => assert.ok(v >= lower[i] && v <= upper[i]));
  const near = check(pose('Q_REACH').grasp);
  assert.equal(near.reachable, true); assert.equal(near.seed, 'start');  // the first seed suffices
  t.diagnostic(JSON.stringify({ position_ms: position.ms, pose_ms: full.ms, near_ms: near.ms, near_solves: near.solves }));
});

test('several seeds avoid false reds where the start pose alone ends in a local minimum', () => {
  const goal = pose('random_08');  // a full pose the start seed misses by about 24 mm and 49°
  const only = check(goal.grasp, goal.rotation, reachSeeds({ start, current: start, lower, upper }).slice(0, 1));
  const all = check(goal.grasp, goal.rotation);
  assert.equal(only.reachable, false); assert.equal(all.reachable, true); assert.notEqual(all.seed, 'start');
  const seeds = reachSeeds({ last: start, start, current: [...start], lower, upper });
  assert.deepEqual(seeds.map(([name]) => name), ['last', 'middle', 'spread-a', 'spread-b']);  // duplicates once
});

test('unreachable goals stay red with their gaps, within a bounded number of solves', t => {
  const far = check([1.5, -.6, .3]);
  assert.equal(far.reachable, false); assert.ok(far.gap_m > .4);
  const startPose = forwardKinematics(chain, identity, start);
  const tilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 2.5).multiply(new Quaternion(...startPose.rotation)).toArray();
  const twisted = check(startPose.grasp, tilt);
  assert.equal(twisted.reachable, false); assert.ok(twisted.orientation_gap_rad > Math.PI / 180);
  assert.ok(far.solves <= far.seeds * (REACH_FRAMES_PER_SEED + POLISH_FRAMES));
  t.diagnostic(JSON.stringify({ far_ms: far.ms, far_solves: far.solves, twisted_ms: twisted.ms, twisted_gap: [twisted.gap_m, twisted.orientation_gap_rad] }));
});

test('the preview checks quickly while the goal moves, fully once settled, and shows its ghost by mode', () => {
  let time = 0, context;
  const results = [];
  const base = new Matrix4();
  const target = pose('Q_REACH').grasp;
  context = { target, orientation_rotvec: null, start, current: start, lower, upper, setup: true, endEffector: fixture.grasp, base };
  const storage = { getItem: () => 'setup', setItem() {} };
  const preview = setupIkPreview({ robot, scene: new Scene(), jointNames: fixture.joint_names, button: null, storage,
    getContext: () => context, onReachability: result => results.push(result), now: () => time });
  preview.update();
  assert.equal(results.length, 1); assert.equal(results[0].reachable, true); assert.equal(results[0].full, false);  // quick: still moving
  assert.equal(preview.snapshot.shown, true); assert.equal(preview.snapshot.ghosts, 1);
  context = { ...context, target: target.map((v, i) => v + [.01, 0, 0][i]) }; time = 50; preview.update();
  assert.equal(results.length, 1); assert.equal(preview.snapshot.pending, true);  // throttled
  time = RECHECK_INTERVAL_MS + 1; preview.update();
  assert.equal(results.length, 2); assert.equal(results[1].full, false);
  time += SETTLE_MS; preview.update();
  assert.equal(results.length, 3); assert.equal(results[2].full, true);  // settled: every seed
  time += SETTLE_MS; preview.update(); assert.equal(results.length, 3);  // nothing new
  context = { ...context, setup: false }; preview.update(); assert.equal(preview.snapshot.shown, false);  // setup only: run started
  preview.setMode('on'); assert.equal(preview.snapshot.shown, true);
  preview.setMode('off'); assert.equal(preview.snapshot.shown, false); assert.equal(preview.snapshot.ghosts, 0);
  context = { ...context, target: [1.5, -.6, .3] }; time += SETTLE_MS; preview.update(); time += SETTLE_MS; preview.update();
  assert.equal(results.at(-1).reachable, false);  // the reachability check is independent of the preview mode
  const goal = pose('random_06');
  context = { ...context, target: goal.grasp, orientation_rotvec: quaternionToRotvec(goal.rotation) }; time += SETTLE_MS; preview.update();
  time += SETTLE_MS; preview.update();
  assert.equal(results.at(-1).reachable, true); assert.ok(results.at(-1).orientation_gap_rad <= Math.PI / 180);
  context = null; preview.update();
  assert.equal(results.at(-1), null); assert.equal(preview.snapshot.result, null);  // outside a Live reach: no goal colour
  preview.dispose();
});
