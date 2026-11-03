import { Box3, Group, Matrix4, Mesh, MeshBasicMaterial, SphereGeometry } from 'three';
import { createGhostArms } from './ghost-arm.js';
import { createPathLine } from './path-lines.js';
import { sampleTrajectory } from './playback.js';
import { TRACK_OPACITY as PREVIOUS_TRACK_OPACITY, TRACK_OUTSIDE_OPACITY as PREVIOUS_OUTSIDE_OPACITY } from './session.js';
import { DEFAULT_GHOST_SETTINGS, sampleAtOrBefore } from './onion-skin.js';
import { referencePosition } from './replay-library.js';
import { createGraspGlyph, heldRotvec, interpolatedRotvec, setGlyphColor, setGlyphPose } from './grasp-glyph.js';
export const TRACK_OPACITY = DEFAULT_GHOST_SETTINGS.opacityStart;
export const TRACK_OUTSIDE_OPACITY = TRACK_OPACITY * (PREVIOUS_OUTSIDE_OPACITY / PREVIOUS_TRACK_OPACITY);

export const TRACK_PATH_OPACITY = .65;
export const TRACK_PATH_WIDTH = 1.75;
export const TRACK_PATH_MAX_POINTS = 5000;

export function trackDisplayPath(points = [], max = TRACK_PATH_MAX_POINTS) {
  if (points.length <= max) return points;
  return Array.from({ length: max }, (_, i) => points[Math.round(i * (points.length - 1) / (max - 1))]);
}

function referencePoints(reference) {
  const points = Array.isArray(reference) ? reference : reference?.reference_xyz ?? reference?.points ?? [];
  return points.filter((point, i) => !i || point.some((value, j) => value !== points[i - 1][j]));
}

// Compare geometry at equal arc-length fractions, not sampling density: freezes
// record a stationary reference at every state and need no duplicate target.
export function trackReferencesDiffer(main, other, tolerance = 1e-5) {
  const a = referencePoints(main), b = referencePoints(other);
  if (!b.length) return false;
  if (!a.length) return true;
  function sampler(points) {
    const distances = [0];
    for (let i = 1; i < points.length; i++) distances.push(distances.at(-1) + Math.hypot(...points[i].map((v, j) => v - points[i - 1][j])));
    let index = 0;
    return fraction => {
      const distance = distances.at(-1) * fraction;
      while (index + 1 < distances.length - 1 && distances[index + 1] < distance) index++;
      if (index === points.length - 1) return points[index];
      const span = distances[index + 1] - distances[index], mix = span ? (distance - distances[index]) / span : 0;
      return points[index].map((v, j) => v + (points[index + 1][j] - v) * mix);
    };
  }
  const sampleA = sampler(a), sampleB = sampler(b);
  for (let i = 0; i <= 32; i++) {
    const x = sampleA(i / 32), y = sampleB(i / 32);
    if (x.some((value, j) => Math.abs(value - y[j]) > tolerance)) return true;
  }
  return false;
}

export function createTrackScene({ robot, scene, jointNames = [] }) {
  const group = new Group(); group.name = 'session-tracks'; scene.add(group);
  const ghosts = createGhostArms({ robot, scene: group, max: Infinity, method: 'prepass' });
  const records = new Map();
  let disposed = false, sampled = [], normalVisible = true, onionSources = [];

  function remove(record) {
    record.group.traverse(object => {
      object.geometry?.dispose();
      if (Array.isArray(object.material)) object.material.forEach(material => material.dispose());
      else object.material?.dispose();
    });
    record.group.removeFromParent();
  }
  function makeRecord(track) {
    const container = new Group(); container.name = `track-${track.id}`; group.add(container);
    const path = createPathLine(trackDisplayPath(track.motion.ee_xyz), { color: track.color, width: TRACK_PATH_WIDTH,
      opacity: TRACK_PATH_OPACITY, name: 'track-path' });
    const dot = new Mesh(new SphereGeometry(.013, 16, 12), new MeshBasicMaterial({ color: track.color,
      transparent: true, opacity: TRACK_OPACITY, depthTest: false, depthWrite: false, toneMapped: false }));
    dot.name = 'track-dot'; dot.renderOrder = 5; container.add(path, dot);
    const base = track.motion.arm_base ? new Matrix4().set(...track.motion.arm_base.flat()) : undefined;
    const movingNames = track.jointNames ?? track.motion.joint_names ?? jointNames;
    const moving = new Set(movingNames), armJoints = new Set();
    robot.joints?.arm_right_1_joint?.traverse(object => {
      if (object.isURDFJoint) armJoints.add(object.urdfName);
    });
    // The base carries ancestor coordinates (for example torso height). The
    // cloned subtree also needs the recording's gripper coordinates. Cache
    // those constant values once; native trajectory samples always win.
    const fixed = Object.entries(track.motion.fixed_joints || {})
      .filter(([name, value]) => armJoints.has(name) && !moving.has(name) && Number.isFinite(value));
    const poseNames = [...fixed.map(([name]) => name), ...movingNames], fixedQ = fixed.map(([, value]) => value), motion = track.motion;
    const onionSource = { id: track.id, identity: motion, revision: motion.revision, times: motion.time_s,
      bounds: [motion.time_s[0], motion.time_s.at(-1)], jointNames: poseNames, base,
      states: times => times.map(time => {
        const index = sampleAtOrBefore(motion.time_s, time);
        return index < 0 ? null : { time: motion.time_s[index], q: [...fixedQ, ...motion.q[index]] };
      }) };
    // A recording with an orientation reference: its goal (dashed) and recorded grasp
    // frame (solid) as gripper glyphs, both in the track colour.
    const glyphs = motion.reference_rotvec && motion.ee_rotvec ? {
      goal: createGraspGlyph({ color: track.color, dashed: true, opacity: TRACK_PATH_OPACITY, name: 'track-goal-glyph' }),
      grasp: createGraspGlyph({ color: track.color, name: 'track-grasp-glyph' }) } : null;
    if (glyphs) container.add(glyphs.goal, glyphs.grasp);
    return { group: container, path, dot, base, motion, glyphs,
      poseNames, fixedQ, onionSource,
      reference: null, mainReference: undefined, referenceInitialized: false };
  }
  function update({ tracks = [], time = 0, mainReference, visible = true, opacity: ghostOpacity = TRACK_OPACITY }) {
    if (disposed) return;
    normalVisible = visible; group.visible = visible;
    const loaded = tracks.filter(track => track.kind !== 'live' && track.motion?.time_s?.length);
    const ids = new Set(loaded.map(track => track.id));
    for (const [id, record] of records) if (!ids.has(id)) { remove(record); records.delete(id); }
    const poses = []; sampled = []; onionSources = [];
    ghostOpacity = Number.isFinite(ghostOpacity) ? Math.max(0, Math.min(1, ghostOpacity)) : TRACK_OPACITY;
    for (const track of loaded) {
      let record = records.get(track.id);
      if (record && record.motion !== track.motion) { remove(record); records.delete(track.id); record = null; }
      if (!record) { record = makeRecord(track); records.set(track.id, record); }
      const trackTime = time - (track.offset_s || 0), motion = track.motion;
      const outside = trackTime < motion.time_s[0] || trackTime > motion.time_s.at(-1);
      const sample = sampleTrajectory(motion, trackTime), opacity = ghostOpacity * (outside ? PREVIOUS_OUTSIDE_OPACITY / PREVIOUS_TRACK_OPACITY : 1);
      const shown = track.visible !== false;
      Object.assign(record.onionSource, { cursor: trackTime, seekOffset: track.offset_s || 0, color: track.color,
        label: track.displayName || track.defaultName || track.label || track.id, visible: shown && visible });
      onionSources.push(record.onionSource);
      record.group.visible = shown;
      record.path.material.color.set(track.color);
      record.dot.material.color.set(track.color); record.dot.material.opacity = opacity;
      record.dot.position.fromArray(sample.xyz); record.dot.visible = track.display === 'dot';
      // Geometry is immutable between payloads: avoid traversing recorded
      // references on every animation frame.
      if (!record.referenceInitialized || mainReference !== record.mainReference) {
        if (record.reference) {
          record.reference.geometry.dispose(); record.reference.material.dispose(); record.reference.removeFromParent(); record.reference = null;
        }
        if (trackReferencesDiffer(mainReference, motion.reference_xyz)) {
          const points = trackDisplayPath(motion.reference_xyz);
          // A stationary target still needs a visible marker, rather than a
          // zero-length wide line which would have no valid direction.
          if (referencePoints(points).length === 1) {
            record.reference = new Mesh(new SphereGeometry(.021, 16, 12), new MeshBasicMaterial({ color: track.color,
              wireframe: true, transparent: true, opacity: TRACK_PATH_OPACITY, depthTest: false, depthWrite: false, toneMapped: false }));
            record.reference.position.fromArray(points[0]); record.reference.name = 'track-reference';
          } else record.reference = createPathLine(points, { color: track.color, dashed: true, width: TRACK_PATH_WIDTH, opacity: TRACK_PATH_OPACITY, name: 'track-reference' });
          record.group.add(record.reference);
        }
        record.mainReference = mainReference; record.referenceInitialized = true;
      }
      record.reference?.material.color.set(track.color);
      if (record.glyphs) {
        const { goal, grasp } = record.glyphs;
        setGlyphPose(goal, referencePosition(motion, trackTime), heldRotvec(motion.reference_time_s, motion.reference_rotvec, trackTime));
        setGlyphPose(grasp, sample.xyz, interpolatedRotvec(motion.time_s, motion.ee_rotvec, trackTime));
        setGlyphColor(goal, track.color); setGlyphColor(grasp, track.color, Math.max(opacity, .6));
      }
      if (shown && visible && track.display !== 'dot') poses.push({ id: track.id, time: trackTime, q: [...record.fixedQ, ...sample.q],
        jointNames: record.poseNames, color: track.color, opacity, base: record.base });
      sampled.push({ id: track.id, time: trackTime, sampledTime: Math.max(motion.time_s[0], Math.min(motion.time_s.at(-1), trackTime)),
        outside, visible: shown, display: track.display ?? 'arm', opacity, xyz: sample.xyz, q: sample.q });
    }
    ghosts.set(poses);
  }
  return {
    group, update, sort: camera => ghosts.update(camera), setBase: () => ghosts.setBase(),
    get onionSources() { return onionSources; },
    get bounds() {
      const bounds = new Box3(), local = new Box3();
      group.updateWorldMatrix(true, true);
      group.traverseVisible(object => {
        const geometry = object.geometry;
        if (!geometry) return;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        if (geometry.boundingBox) bounds.union(local.copy(geometry.boundingBox).applyMatrix4(object.matrixWorld));
      });
      return bounds;
    },
    setVisible(value) { normalVisible = value; group.visible = value; },
    dispose() { if (disposed) return; records.forEach(remove); records.clear(); ghosts.dispose(); group.removeFromParent(); disposed = true; },
    get snapshot() { return { visible: normalVisible, ghostCount: ghosts.snapshot.count,
      dotCount: normalVisible ? sampled.filter(track => track.visible && track.display === 'dot').length : 0,
      pathCount: normalVisible ? [...records.values()].filter(record => record.group.visible && record.path.visible).length : 0,
      referenceCount: normalVisible ? [...records.values()].filter(record => record.group.visible && record.reference).length : 0,
      glyphs: normalVisible ? [...records.entries()].filter(([, record]) => record.group.visible && record.glyphs).map(([id, { glyphs }]) =>
        ({ id, goal: glyphs.goal.visible ? { position: glyphs.goal.position.toArray(), quaternion: glyphs.goal.quaternion.toArray() } : null,
          grasp: glyphs.grasp.visible ? { position: glyphs.grasp.position.toArray(), quaternion: glyphs.grasp.quaternion.toArray() } : null })) : [],
      sampled: sampled.map(track => ({ ...track })), renderer: ghosts.snapshot }; },
  };
}
