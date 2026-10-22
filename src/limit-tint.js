import { Color, Raycaster, Vector2 } from "three";

// Links tint from this fraction of their joint's worst limit use and reach full
// red at 100 %.
export const LIMIT_TINT_THRESHOLD = 0.8;
const LIMIT_COLOR = new Color(0xff2a2a);

// Worst normalised limit use of one joint for the quantities the sample really
// has. Position use is the distance from the range centre over the half range.
export function jointLimitUse({ q, qd, torque, limits }, index) {
  if (!limits) return null;
  let worst = null;
  const consider = (kind, value, limit, fraction, unit) => {
    if (!Number.isFinite(value) || !Number.isFinite(limit) || limit <= 0 || !Number.isFinite(fraction)) return;
    if (!worst || fraction > worst.fraction) worst = { kind, fraction, value, limit, unit };
  };
  const lower = limits.lower_position_rad?.[index], upper = limits.upper_position_rad?.[index];
  if (Number.isFinite(q?.[index]) && Number.isFinite(lower) && Number.isFinite(upper) && upper > lower) {
    const half = (upper - lower) / 2;
    consider("position", q[index], half, Math.abs(q[index] - (upper + lower) / 2) / half, "rad");
    worst && worst.kind === "position" && Object.assign(worst, { limit: half, range: [lower, upper] });
  }
  const velocity = limits.velocity_rad_s?.[index];
  if (Number.isFinite(qd?.[index])) consider("velocity", qd[index], velocity, Math.abs(qd[index]) / velocity, "rad/s");
  const effort = limits.effort_nm?.[index];
  if (Number.isFinite(torque?.[index])) consider("torque", torque[index], effort, Math.abs(torque[index]) / effort, "N m");
  return worst;
}

export function tintStrength(fraction, threshold = LIMIT_TINT_THRESHOLD) {
  if (!Number.isFinite(fraction) || fraction < threshold) return 0;
  return Math.min(1, (fraction - threshold) / (1 - threshold));
}

export function describeLimitUse(name, use) {
  const percent = Math.round(use.fraction * 100);
  if (use.kind === "position") return `${name} position ${percent} % of range ${use.range[0].toFixed(2)} … ${use.range[1].toFixed(2)} rad`;
  return `${name} ${use.kind} ${percent} % of ${Number(use.limit.toPrecision(3))} ${use.unit}`;
}

function linkMeshes(link) {
  const meshes = [];
  const visit = (object) => {
    if (object !== link && object.isURDFJoint) return;
    if (object.isMesh) meshes.push(object);
    object.children.forEach(visit);
  };
  visit(link);
  return meshes;
}

// Tints each moving joint's child link by that joint's worst limit use.
// Materials are per mesh (cloned by the caller); the original colour is kept.
export function createLimitTint({ robot, jointNames, camera, element, tooltip }) {
  const links = jointNames.map((name) => {
    const joint = robot.joints[name];
    const meshes = (joint?.children ?? []).filter((child) => child.isURDFLink).flatMap(linkMeshes);
    return { name, meshes, colors: meshes.map((mesh) => mesh.material.color.clone()), use: null };
  });
  let enabled = true;
  let last;

  function apply() {
    links.forEach((link, index) => {
      const use = enabled && last ? jointLimitUse(last, index) : null;
      const strength = use ? tintStrength(use.fraction) : 0;
      link.use = strength > 0 ? use : null;
      link.meshes.forEach((mesh, i) => mesh.material.color.copy(link.colors[i]).lerp(LIMIT_COLOR, strength));
    });
  }

  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let pending;
  function hover(event) {
    if (!enabled || !tooltip || pending) return;
    pending = requestAnimationFrame(() => {
      pending = undefined;
      const bounds = element.getBoundingClientRect();
      pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      // The nearest robot surface decides, so a tinted link hidden behind another is not named.
      const hit = raycaster.intersectObject(robot, true)[0];
      const link = hit && links.find((item) => item.use && item.meshes.includes(hit.object));
      if (!link) { tooltip.hidden = true; return; }
      tooltip.textContent = describeLimitUse(link.name, link.use);
      tooltip.style.left = `${event.clientX - bounds.left + 14}px`;
      tooltip.style.top = `${event.clientY - bounds.top + 14}px`;
      tooltip.hidden = false;
    });
  }
  element?.addEventListener("pointermove", hover);
  element?.addEventListener("pointerleave", () => { if (tooltip) tooltip.hidden = true; });

  return {
    update(sample) { last = sample; apply(); },
    setEnabled(value) { enabled = Boolean(value); if (!enabled && tooltip) tooltip.hidden = true; apply(); },
    get links() { return links; },
  };
}
