import { Color, EdgesGeometry, LineBasicMaterial, LineSegments, Raycaster, Vector2 } from "three";
import { DEFAULT_LIMIT_USE, LIMIT_QUANTITIES, describeLimitUse, jointLimitUse, limitColor, stateRank } from "./limit-use.js";

// A link takes its joint's worst state over position, velocity and torque:
// near = amber, at = solid red, beyond = red with a light edge outline.
export const TINT_STATES = Object.freeze(["near", "at", "beyond"]);

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

// Quantities of one joint that are not inside, worst first.
export function tintedQuantities(use) {
  return LIMIT_QUANTITIES.map((quantity) => use?.[quantity]).filter((item) => item && item.state !== "inside")
    .sort((a, b) => stateRank(b.state) - stateRank(a.state) || b.utilisation - a.utilisation);
}

// Tints each moving joint's child link by that joint's worst limit state.
// Materials are per mesh (cloned by the caller); the original colour is kept.
export function createLimitTint({ robot, jointNames, camera, element, tooltip, colors = {} }) {
  const palette = Object.fromEntries(["near", "at", "beyond"].map((name) => [name, new Color(colors[name] ?? limitColor(name))]));
  const edgeMaterial = new LineBasicMaterial({ color: colors.edge ?? 0xffe1e1, transparent: true, opacity: 0.9 });
  const planningMaterial = new LineBasicMaterial({ color: 0xf2b544, transparent: true, opacity: .9 });
  const links = jointNames.map((name) => {
    const joint = robot.joints[name];
    const meshes = (joint?.children ?? []).filter((child) => child.isURDFLink).flatMap(linkMeshes);
    return { name, meshes, colors: meshes.map((mesh) => mesh.material.color.clone()), use: null, state: null, edges: null };
  });
  let enabled = true, hoverEnabled = true, settings = { ...DEFAULT_LIMIT_USE };
  let last;

  // Edge outlines are built once per link, on its first beyond state.
  function outline(link, visible) {
    if (visible && !link.edges) {
      link.edges = link.meshes.map((mesh) => {
        const lines = new LineSegments(new EdgesGeometry(mesh.geometry, 30), edgeMaterial);
        lines.name = "limit-beyond-outline"; lines.raycast = () => {}; mesh.add(lines); return lines;
      });
    }
    link.edges?.forEach((lines) => { lines.visible = visible; });
  }

  function apply() {
    links.forEach((link, index) => {
      const use = enabled && last ? jointLimitUse(last, index, settings) : null;
      const state = use?.worst && use.worst.state !== "inside" ? use.worst.state : null;
      link.use = state ? use : null; link.state = state;
      link.meshes.forEach((mesh, i) => mesh.material.color.copy(state ? palette[state] : link.colors[i]));
      outline(link, state === "beyond");
      link.planningOutside = Boolean(last?.planning && (last.q?.[index] < last.planning.lower[index] - 1e-12 || last.q?.[index] > last.planning.upper[index] + 1e-12));
      if (link.planningOutside && !link.planningEdges) {
        link.planningEdges = link.meshes.map(mesh => {
          const lines = new LineSegments(new EdgesGeometry(mesh.geometry, 30), planningMaterial);
          lines.name = 'planning-box-outline'; lines.raycast = () => {}; mesh.add(lines); return lines;
        });
      }
      link.planningEdges?.forEach(lines => { lines.visible = link.planningOutside && state !== 'beyond'; });
    });
  }

  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let pending;
  function hover(event) {
    if (!hoverEnabled || !tooltip || pending) return;
    pending = requestAnimationFrame(() => {
      pending = undefined;
      if (!hoverEnabled) { tooltip.hidden = true; return; }
      const bounds = element.getBoundingClientRect();
      pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      // The nearest robot surface decides, so a tinted link hidden behind another is not named.
      const hit = raycaster.intersectObject(robot, true)[0];
      const link = hit && links.find((item) => (item.use || item.planningOutside) && item.meshes.includes(hit.object));
      if (!link) { tooltip.hidden = true; return; }
      const lines = tintedQuantities(link.use).map((use) => describeLimitUse(link.name, use));
      if (link.planningOutside) {
        const i = links.indexOf(link);
        lines.push(`${link.name} · ${last.q[i].toFixed(3)} rad · outside MPC planning box [${last.planning.lower[i].toFixed(3)}, ${last.planning.upper[i].toFixed(3)}] rad`);
      }
      tooltip.textContent = lines.join("\n");
      tooltip.dataset.state = link.state || 'near';
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
    setHoverEnabled(value) { hoverEnabled = Boolean(value); if (!hoverEnabled && tooltip) tooltip.hidden = true; },
    setSettings(value) { settings = { ...DEFAULT_LIMIT_USE, ...value }; apply(); },
    get links() { return links; },
  };
}
