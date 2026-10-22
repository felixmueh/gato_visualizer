import { Matrix4, Quaternion, Vector3 } from "three";

// Directions point from the current orbit target toward the camera. Robot
// coordinates are X forward, Y left, Z up. Keep poles just off the singularity
// so OrbitControls retains a stable azimuth and keeps world Z as camera up.
export const VIEW_FACES = [
  { name: "front", label: "Front", axis: "+X", direction: [1, 0, 0], transform: "rotateY(90deg)" },
  { name: "back", label: "Back", axis: "−X", direction: [-1, 0, 0], transform: "rotateY(-90deg)" },
  { name: "left", label: "Left", axis: "+Y", direction: [0, 1, 0], transform: "rotateX(90deg)" },
  { name: "right", label: "Right", axis: "−Y", direction: [0, -1, 0], transform: "rotateX(-90deg)" },
  { name: "top", label: "Top", axis: "+Z", direction: [0, -0.00001, 1], transform: "" },
  { name: "bottom", label: "Bottom", axis: "−Z", direction: [0.00001, 0, -1], transform: "rotateY(180deg)" },
];

export const VIEW_CORNERS = [1, -1].flatMap((x) => [1, -1].flatMap((y) => [1, -1].map((z) => {
  const parts = [x > 0 ? "front" : "back", y > 0 ? "left" : "right", z > 0 ? "top" : "bottom"];
  return { name: parts.join("-"), label: parts.join(" "), direction: [x, y, z] };
})));

export function viewDirection(name) {
  const view = [...VIEW_FACES, ...VIEW_CORNERS].find((item) => item.name === name);
  if (!view) throw new Error(`Unknown camera view: ${name}`);
  return new Vector3(...view.direction).normalize();
}

// The four screen edges of the cube. Clicking one in a principal view turns
// the view 90 degrees toward that side, as in CAD view cubes: the face that
// lies beyond the edge on screen becomes the new view.
export const VIEW_EDGES = [
  { name: "up", screen: [0, 1, 0] },
  { name: "down", screen: [0, -1, 0] },
  { name: "left", screen: [-1, 0, 0] },
  { name: "right", screen: [1, 0, 0] },
];

// Face reached from the current camera orientation across a screen edge: the
// world direction of the edge, snapped to the nearest principal axis.
export function edgeNeighbor(cameraQuaternion, edge) {
  const spec = VIEW_EDGES.find((item) => item.name === edge);
  if (!spec) throw new Error(`Unknown view-cube edge: ${edge}`);
  const world = new Vector3(...spec.screen).applyQuaternion(cameraQuaternion);
  let best = VIEW_FACES[0];
  let bestDot = -Infinity;
  for (const face of VIEW_FACES) {
    const dot = Math.round(face.direction[0]) * world.x + Math.round(face.direction[1]) * world.y + Math.round(face.direction[2]) * world.z;
    if (dot > bestDot) { bestDot = dot; best = face; }
  }
  return best.name;
}

// Match the CSS cube's 60px side and 500px perspective. Corners are ordinary
// screen-space buttons so their hit areas stay useful when faces are edge-on.
export function projectCorner(direction, inverseCameraQuaternion) {
  const point = new Vector3(...direction).multiplyScalar(30).applyQuaternion(inverseCameraQuaternion);
  const scale = 500 / (500 - point.z);
  return [60 + point.x * scale, 52 - point.y * scale];
}

export function cornerVisible(direction, cameraDirection) {
  // A vertex is visible if at least one of its three incident faces faces us.
  return direction.some((sign, index) => sign * cameraDirection.getComponent(index) > 0.01);
}

// Interpolate azimuth explicitly while approaching a pole. A great-circle
// interpolation of the offset leaves azimuth underdetermined at the endpoint,
// allowing a sudden camera rotation when OrbitControls restores world-Z up.
// Spherical interpolation keeps the radius constant and never crosses the target.
export function orbitTransition(startOffset, direction) {
  const radius = startOffset.length();
  const startAzimuth = Math.atan2(startOffset.y, startOffset.x);
  const targetAzimuth = Math.atan2(direction.y, direction.x);
  const azimuthChange = Math.atan2(Math.sin(targetAzimuth - startAzimuth), Math.cos(targetAzimuth - startAzimuth));
  const startPolar = Math.atan2(Math.hypot(startOffset.x, startOffset.y), startOffset.z);
  const targetPolar = Math.atan2(Math.hypot(direction.x, direction.y), direction.z);
  return (progress) => {
    if (progress <= 0) return startOffset.clone();
    if (progress >= 1) return direction.clone().normalize().multiplyScalar(radius);
    const azimuth = startAzimuth + azimuthChange * progress;
    const polar = startPolar + (targetPolar - startPolar) * progress;
    return new Vector3(
      radius * Math.sin(polar) * Math.cos(azimuth),
      radius * Math.sin(polar) * Math.sin(azimuth),
      radius * Math.cos(polar),
    );
  };
}

export function setupViewCube({ camera, controls, viewport }) {
  const element = document.createElement("div");
  element.className = "view-cube";
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "Camera orientation. Choose a face, or a corner for an isometric view; edges turn a principal view by 90 degrees. Arrow keys on faces select other faces.");
  const stage = document.createElement("div");
  stage.className = "view-cube-stage";
  const rotor = document.createElement("div");
  rotor.className = "view-cube-rotor";
  stage.append(rotor);
  element.append(stage);
  const caption = document.createElement("span");
  caption.className = "view-cube-caption";
  caption.textContent = "FACE OR CORNER";
  element.append(caption);
  viewport.append(element);
  let transition;
  let damping;
  let chosenFace;
  const buttons = [];
  const edgeButtons = new Map();
  const cornerButtons = [];
  const inverse = new Quaternion();
  const matrix = new Matrix4();
  const normal = new Vector3();
  const cameraDirection = new Vector3();

  function cancel(resetChoice = true) {
    if (transition) controls.enableDamping = damping;
    transition = undefined;
    if (resetChoice) chosenFace = undefined;
  }

  function select(name) {
    cancel();
    damping = controls.enableDamping;
    const target = controls.target.clone();
    const position = camera.position.clone();
    // Flush pending orbit/pan damping, then restore the exact displayed pose.
    // Otherwise a click during damping would also move the pan target.
    controls.enableDamping = false;
    controls.update();
    controls.target.copy(target);
    camera.position.copy(position);
    controls.update();
    const offset = camera.position.clone().sub(target);
    transition = {
      target,
      offsetAt: orbitTransition(offset, viewDirection(name)),
      start: performance.now(),
      duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 350,
    };
    chosenFace = name;
    caption.textContent = `${name.toUpperCase()} VIEW`;
  }

  for (const face of VIEW_FACES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `view-cube-face view-cube-${face.name}`;
    button.dataset.view = face.name;
    button.style.transform = `${face.transform} translateZ(30px)`;
    button.textContent = face.label;
    button.title = `${face.label} view (${face.axis}); arrow keys select other faces`;
    button.setAttribute("aria-label", `${face.label} view (${face.axis})`);
    button.addEventListener("click", () => select(face.name));
    // Hidden back faces cannot be focused usefully. Arrow keys provide direct
    // access to all six views from whichever face is currently visible.
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const step = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
      let index = VIEW_FACES.findIndex((item) => item.name === chosenFace);
      if (index < 0) index = VIEW_FACES.indexOf(face);
      const next = VIEW_FACES[(index + step + VIEW_FACES.length) % VIEW_FACES.length];
      select(next.name);
      buttons[VIEW_FACES.indexOf(next)].focus({ preventScroll: true });
    });
    rotor.append(button);
    buttons.push(button);
  }

  for (const corner of VIEW_CORNERS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "view-cube-corner";
    button.dataset.view = corner.name;
    button.title = `${corner.label} isometric view`;
    button.setAttribute("aria-label", `${corner.label} isometric view`);
    button.addEventListener("click", () => select(corner.name));
    stage.append(button);
    cornerButtons.push(button);
  }

  // Edge strips only exist while a principal face is exactly in view.
  for (const edge of VIEW_EDGES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `view-cube-edge view-cube-edge-${edge.name}`;
    button.dataset.edge = edge.name;
    button.hidden = true;
    button.addEventListener("click", () => { if (button.dataset.target) select(button.dataset.target); });
    stage.append(button);
    edgeButtons.set(edge.name, button);
  }

  controls.addEventListener("start", cancel);

  function update(timestamp) {
    if (transition) {
      const { start, duration, target, offsetAt } = transition;
      const progress = duration ? Math.min(1, Math.max(0, (timestamp - start) / duration)) : 1;
      const eased = progress * progress * (3 - 2 * progress);
      controls.target.copy(target);
      camera.position.copy(target).add(offsetAt(eased));
      controls.update();
      if (progress === 1) cancel(false);
    }
    inverse.copy(camera.quaternion).invert();
    matrix.makeRotationFromQuaternion(inverse);
    // CSS uses downward Y; both cube-local Y and camera-space Y are reflected.
    // This changes basis without mirroring the cube or its face winding.
    for (const index of [1, 4, 6, 9]) matrix.elements[index] *= -1;
    rotor.style.transform = `matrix3d(${matrix.elements.join(",")})`;
    cameraDirection.copy(camera.position).sub(controls.target).normalize();
    let activeFace;
    VIEW_FACES.forEach((face, index) => {
      const visible = normal.fromArray(face.direction).dot(cameraDirection) > 0.01;
      buttons[index].tabIndex = visible ? 0 : -1;
      const active = normal.normalize().dot(cameraDirection) > 0.999;
      if (active) activeFace = face.name;
      buttons[index].classList.toggle("active", active);
      buttons[index].setAttribute("aria-pressed", String(active));
    });
    VIEW_CORNERS.forEach((corner, index) => {
      const button = cornerButtons[index];
      const [x, y] = projectCorner(corner.direction, inverse);
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
      const visible = cornerVisible(corner.direction, cameraDirection);
      button.hidden = !visible;
      const active = normal.fromArray(corner.direction).normalize().dot(cameraDirection) > 0.999;
      if (active) activeFace = corner.name;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const principal = VIEW_FACES.some((face) => face.name === activeFace) && !transition;
    for (const edge of VIEW_EDGES) {
      const button = edgeButtons.get(edge.name);
      button.hidden = !principal;
      if (!principal) { delete button.dataset.target; continue; }
      const target = edgeNeighbor(camera.quaternion, edge.name);
      if (button.dataset.target !== target) {
        const label = VIEW_FACES.find((face) => face.name === target).label;
        button.dataset.target = target;
        button.title = `Rotate to ${label} view`;
        button.setAttribute("aria-label", `Rotate to ${label} view`);
      }
    }
    const captionFace = transition ? chosenFace : activeFace;
    caption.textContent = captionFace
      ? (VIEW_CORNERS.some((corner) => corner.name === captionFace) ? "ISOMETRIC VIEW" : `${captionFace.toUpperCase()} VIEW`)
      : "FACE OR CORNER";
  }

  return { update, cancel };
}
