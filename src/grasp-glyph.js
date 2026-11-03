import { Group, Mesh, MeshBasicMaterial, Quaternion, SphereGeometry } from 'three';
import { createPathLine } from './path-lines.js';
import { sampleAtOrBefore } from './onion-skin.js';
import { quaternionToRotvec, rotvecToQuaternion } from './rotations.js';

/** A reference orientation at time: each sample holds until the next one, the first
 * before it (zero-order hold); null where the held sample has no target. */
export function heldRotvec(times, rotvecs, time) {
  if (!Array.isArray(times) || !Array.isArray(rotvecs) || !times.length || times.length !== rotvecs.length) return null;
  return rotvecs[sampleAtOrBefore(times, time)] ?? null;
}

/** A recorded orientation at time, interpolated along the shortest rotation between
 * neighbouring samples (as positions are interpolated linearly), held outside them. */
export function interpolatedRotvec(times, rotvecs, time) {
  if (!Array.isArray(times) || !Array.isArray(rotvecs) || !times.length || times.length !== rotvecs.length) return null;
  const low = sampleAtOrBefore(times, time), high = Math.min(low + 1, times.length - 1);
  if (high === low || time <= times[low]) return rotvecs[low] ?? null;
  if (!rotvecs[low] || !rotvecs[high]) return rotvecs[low] ?? null;
  const fraction = Math.min(1, (time - times[low]) / (times[high] - times[low]));
  const result = new Quaternion(...rotvecToQuaternion(rotvecs[low]))
    .slerp(new Quaternion(...rotvecToQuaternion(rotvecs[high])), fraction);
  return quaternionToRotvec(result.toArray());
}

// The grasp frame (tiago_mpc's GRASP_FRAME: origin 139 mm along arm_right_tool_link's
// z, no rotation) as the full URDF's gripper defines it: the gripper approaches along
// +z, and its fingertip pads open and close along ±y (51 mm open, 16 mm closed).
export const GLYPH_STEM_M = .07;
export const GLYPH_HALF_WIDTH_M = .045;

// A dark outline under every stroke keeps a glyph legible where it crosses the light
// robot meshes (glyphs draw through the arm); it is the scene's background colour.
const HALO_COLOR = 0x0b1220;

/** A gripper glyph in the grasp frame: a stem along the approach axis ending at the grasp
 * point, a crossbar along the fingers' opening direction, and a knob at its +y end, which
 * shows a half turn about the approach axis that the symmetric bar alone would hide. */
export function createGraspGlyph({ color, opacity = .95, dashed = false, width = 2.5, name = 'grasp-glyph' }) {
  const group = new Group();
  group.name = name;
  const segments = { stem: [[0, 0, -GLYPH_STEM_M], [0, 0, 0]], bar: [[0, -GLYPH_HALF_WIDTH_M, 0], [0, GLYPH_HALF_WIDTH_M, 0]] };
  const sphere = (radius, tint, renderOrder, part) => {
    const mesh = new Mesh(new SphereGeometry(radius, 12, 8), new MeshBasicMaterial({ color: tint, transparent: true,
      opacity: part === 'halo' ? .6 : opacity, depthTest: false, depthWrite: false, toneMapped: false }));
    mesh.position.set(0, GLYPH_HALF_WIDTH_M, 0);
    mesh.renderOrder = renderOrder;
    mesh.name = part === 'halo' ? `${name}-halo-knob` : `${name}-knob`;
    mesh.userData.halo = part === 'halo';
    return mesh;
  };
  for (const [part, points] of Object.entries(segments)) {
    const halo = createPathLine(points, { color: HALO_COLOR, opacity: .6, width: width + 3, renderOrder: 6, name: `${name}-halo-${part}` });
    halo.userData.halo = true;
    group.add(halo);
  }
  group.add(sphere(.0095, HALO_COLOR, 6, 'halo'));
  for (const [part, points] of Object.entries(segments)) {
    group.add(createPathLine(points, { color, opacity, dashed, width, renderOrder: 7, name: `${name}-${part}` }));
  }
  group.add(sphere(.007, color, 7, 'glyph'));
  group.visible = false;
  return group;
}

/** Place a glyph at a world position and rotation vector; hide it without either. */
export function setGlyphPose(glyph, position, rotvec) {
  const quaternion = rotvecToQuaternion(rotvec);
  const valid = quaternion && Array.isArray(position) && position.length === 3 && position.every(Number.isFinite);
  glyph.visible = Boolean(valid);
  if (!valid) return false;
  glyph.position.fromArray(position);
  glyph.quaternion.fromArray(quaternion);
  return true;
}

export function setGlyphColor(glyph, color, opacity) {
  glyph.traverse(object => {
    if (!object.material || object.userData.halo) return;
    object.material.color.set(color);
    if (opacity != null) object.material.opacity = opacity;
  });
}

export function disposeGlyph(glyph) {
  glyph?.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
  glyph?.removeFromParent();
}
