import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import URDFLoader from "urdf-loader";
import { setupLive } from "./live.js";
import { createJointTable, updateJointTable, sampleTelemetry } from "./joint-telemetry.js";
import { setupReplayLibrary, validateReference, referencePosition, playbackClock, isStartingScene } from "./replay-library.js";
import { setupTargetGizmo } from "./target-gizmo.js";
import { setupViewCube } from "./view-cube.js";
import { fitPerspectivePoints, objectWorldPoints, trajectoryFitPoints } from "./camera-fit.js";
import { createPathLine, setPathPoints, setPathPointCount, pathLineInfo } from "./path-lines.js";
import {
  sampleTrajectory,
  trajectoryDistance,
  validateTrajectory,
} from "./playback.js";
import "@fontsource/dm-sans/latin-400.css";
import "@fontsource/dm-sans/latin-500.css";
import "@fontsource/dm-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./style.css";

const icons = {
  play: '<path d="m8 5 11 7-11 7V5Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="4"/>',
  restart: '<path d="M4 10a8 8 0 1 1 1 7M4 4v6h6"/>',
  home: '<path d="m3 10 9-7 9 7M6 9v11h12V9M10 20v-7h4v7"/>',
  focus:
    '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><circle cx="12" cy="12" r="3"/>',
  robot: '<path d="M8 5h8l3 5v10H5V10l3-5ZM12 2v3M8 12h1m6 0h1M9 16h6"/>',
  chevron: '<path d="m8 5 7 7-7 7"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

document.querySelector("#app").innerHTML = `
  <header class="header">
    <a class="brand" href="/" aria-label="TIAGo Motion studio"><span class="brand-icon">${icon("robot")}</span><span>TIAGo <span class="brand-light">/ Motion studio</span></span></a>
    <div class="header-right"><span id="mode-label" class="read-only">TRAJECTORY REPLAY</span><span class="connection"><i></i><span id="connection-label">Connecting</span></span></div>
  </header>
  <div class="workspace">
    <aside class="sidebar">
      <div class="section-heading"><span class="eyebrow">WORKSPACE</span><span class="version">MVP / 02</span></div>
      <h1>See the motion.</h1><p class="intro">Explore the path. Follow the robot.</p>
      <div class="mode-tabs" role="group" aria-label="Workspace mode"><button id="replay-mode" class="active" aria-pressed="true">Replay</button><button id="live-mode" disabled aria-pressed="false">Live MPC</button></div>
      <p id="live-availability" class="availability" role="status"></p>
      <section id="live-panel" hidden>
        <div class="section-heading"><h2>Live task</h2><span class="unit-label">WORLD · M</span></div>
        <label class="field-label" for="live-task">TASK</label><div class="select-wrap"><select id="live-task" aria-label="Live task"><option value="reach">Reaching</option></select></div>
        <p id="live-task-note" class="settings-note">Offset from the default reaching target. Each change updates the prediction.</p>
        <div class="target-offsets">${['X', 'Y', 'Z'].map((axis, i) => `<label>${axis}<input id="target-offset-${i}" aria-label="Target ${axis} offset in metres" type="number" step="0.01" value="0" /></label>`).join('')}</div>
        <div id="live-task-parameters"></div>
        <p class="settings-note">Only prebuilt knot counts are available. Calculation settings are independent of replay recordings. Prediction knot spacing is independent of execution rates.</p>
        <button id="target-move" class="secondary-action" disabled>Move target in 3D</button>
        <p id="target-move-note" class="settings-note">Target handles become available after the live preview is ready.</p>
        <details class="settings-group" open><summary>Execution timing</summary><div class="settings-fields">
        <label class="parameter-row"><span>Simulation Hz</span><input id="live-simulation-hz" type="number" min=".01" step="any" value="1000" required></label>
        <label class="parameter-row"><span>Control Hz</span><input id="live-control-hz" type="number" min=".01" step="any" value="100" required></label>
        <label class="parameter-row"><span>TO / replanning Hz</span><input id="live-to-hz" type="number" min=".01" step="any" value="100" required></label>
        </div><p class="settings-note">Simulation ≥ control ≥ TO. Rates follow simulation time.</p></details><div id="live-settings"></div>
        <p id="live-source" class="settings-note source-live"></p>
      </section>
      <section id="replay-section" class="sidebar-section">
        <label class="field-label" for="recording-select">RECORDING LIBRARY</label>
        <div class="select-wrap"><select id="recording-select" aria-label="Recording library"><option value="default">Default recording</option></select></div>
        <p id="recording-path" class="recording-path"></p>
        <p id="recording-update" class="recording-update" role="status"></p>
        <button id="recording-reload" class="secondary-action recording-reload" hidden>Reload recording</button>
        <div class="upload-actions"><button id="upload-files" class="secondary-action">Upload .npz</button><button id="upload-folder" class="secondary-action">Upload folder</button></div>
        <input id="recording-files" class="sr-only" type="file" accept=".npz" multiple tabindex="-1" aria-label="Choose recordings to upload" />
        <input id="recording-folder" class="sr-only" type="file" webkitdirectory directory multiple tabindex="-1" aria-label="Choose folder to upload" />
        <p id="library-message" class="library-message" role="status" aria-live="polite">The library updates as recordings are added.</p>
        <details id="library-errors" class="library-errors" hidden><summary id="library-errors-summary"></summary><ul id="library-errors-list"></ul></details>
        <label class="field-label trajectory-label" for="trajectory-select">TRAJECTORY</label>
        <div class="select-wrap"><select id="trajectory-select" disabled><option>Loading trajectories…</option></select></div>
        <div class="trajectory-kind" id="trajectory-kind">Recorded MPC & solver predictions</div>
        <p class="trajectory-description" id="trajectory-description">Native robot states, replayed in simulation time.</p>
        <div class="stats-grid">
          <div><span class="stat-label">DURATION</span><strong id="duration-stat">—<small>s</small></strong></div>
          <div><span class="stat-label">SAMPLES</span><strong id="samples-stat">—</strong></div>
          <div><span class="stat-label">TOOL PATH</span><strong id="distance-stat">—<small>m</small></strong></div>
          <div><span class="stat-label">END / TARGET</span><strong id="error-stat">—<small>mm</small></strong></div>
        </div>
      </section>
      <section class="sidebar-section pose-section">
        <div class="section-heading"><h2>Right arm</h2><span class="unit-label">NATIVE JOINTS</span></div>
        <div class="joint-list" id="joint-list"></div><p class="joint-limit-note"><span class="limit-yellow">Near limit</span> · <span class="limit-red">At limit</span> · — unavailable</p>
      </section>
      <section class="source-section">
        <span class="field-label">CONNECTED SOURCE</span>
        <div class="source-name">tiago_mpc <span id="source-commit"></span></div>
        <p id="source-run">Loading local recording…</p>
        <span class="source-footnote">Full URDF · native joint axes</span>
      </section>
    </aside>
    <main class="main">
      <section class="viewport" id="viewport" aria-label="Interactive 3D robot workspace">
        <div class="viewport-top"><div class="scene-title"><span class="live-dot"></span><span>3D WORKSPACE</span><span class="scene-slash">/</span><span id="scene-title">TIAGo Pro</span></div><div class="camera-controls"><button id="camera-home" title="Fit the full robot in its current pose" aria-label="Fit robot">${icon("robot")}<span>Fit robot</span></button><button id="camera-arm" title="Fit the selected trajectory or full task reference" aria-label="Fit trajectory">${icon("focus")}<span>Fit trajectory</span></button></div></div>
        <div class="viewport-legend" id="path-legend"><span><i class="legend-line"></i>Tool path</span><span><i class="legend-start"></i>Start</span><span><i class="legend-target"></i>Target</span></div>
        <div class="viewport-help">Drag to orbit <span>·</span> Right-drag to pan <span>·</span> Scroll to zoom</div>
        <div class="axis-label"><span class="axis-x">X</span><span class="axis-y">Y</span><span class="axis-z">Z ↑</span><span>WORLD · METERS</span></div>
        <div class="load-overlay" id="load-overlay" role="status"><div class="spinner"></div><strong id="load-title">Opening your workspace</strong><p id="load-detail">Loading trajectory and robot description…</p></div>
      </section>
      <section id="live-controls" class="playback live-controls" aria-label="Live MPC controls" hidden>
        <div class="playback-heading"><div><span class="eyebrow">SIMULATED CLOSED-LOOP MPC</span><h2 id="live-plan-label">Waiting for a prediction</h2></div><div class="playback-state" id="live-status">IDLE</div></div>
        <div class="live-actions"><button id="live-play" class="primary-action" disabled>Play</button><button id="live-preview" class="secondary-action" disabled>Preview</button><button id="live-reset" class="secondary-action" disabled>Reset state</button>
        <label class="calculation-setting">Calculation <select id="live-calculation" aria-label="Calculation mode"><option value="on_play">On Play</option><option value="manual">Manual</option><option value="automatic">Automatic</option></select></label>
        <label class="calculation-setting">Calculation duration (s) <input id="live-duration" type="number" min=".01" step="any" value="10" aria-label="Precalculation duration seconds"></label>
        <button id="live-precalculate" class="secondary-action" disabled>Precalculate</button><button id="live-cancel" class="secondary-action" disabled>Cancel calculation</button>
        </div>
        <div class="live-history-row"><label for="live-history">STATE HISTORY</label><div class="live-history-track"><div id="live-history-intervals" aria-hidden="true"></div><input id="live-history" type="range" min="0" max="0" step="any" value="0" disabled aria-label="Scrub live state history"/></div><span id="live-history-position">No state history yet</span><button id="live-history-latest" class="secondary-action" disabled>Go latest</button></div>
        <div class="live-history-options"><label><input id="live-continue" type="checkbox"> Continue simulation at end</label><span><i class="interval-key red"></i>MPC over budget</span><span><i class="interval-key yellow"></i>Simulation / combined over budget</span></div>
        <div class="live-clock"><strong id="live-sim-time">0.00</strong><span>s simulated</span><strong id="live-playback-rate">Paused</strong><span>playback</span><strong id="live-rtf">—</strong><span>calculation RTF</span></div>
        <p id="live-history-note" class="settings-note">History plays at 1× simulation time. Go latest only moves the view.</p>
        <p id="live-history-window" class="settings-note"></p><p id="live-rates" class="settings-note"></p>
        <p id="live-message" class="live-message" role="status" aria-live="polite">Loading live settings…</p>
        <div class="solver-stats"><div><span>Native solve wall</span><strong><b id="live-solve">—</b> ms</strong></div><div><span>SQP / PCG</span><strong><b id="live-sqp">—</b> / <b id="live-pcg">—</b></strong></div><div><span>ADMM / linear solve</span><strong><b id="live-admm">—</b> / <b id="live-linsys">—</b></strong></div><div><span>Max row violation</span><strong id="live-violation">—</strong></div><div><span>Current target distance</span><strong id="live-distance">—</strong></div></div>
        <div class="live-detail"><span id="live-horizon">—</span><span id="live-arrival">Waiting for state</span><span id="live-restarted" hidden>Controller restarted for this plan</span></div>
        <div class="playback-foot"><span>Preview solves one horizon. Precalculation runs full closed-loop MPC. Recorded history always plays at 1×; computation may limit progress at its end.</span><span>Diagnostic view · finite plans do not certify convergence.</span></div>
      </section>
      <section class="playback" id="replay-controls" aria-label="Trajectory playback">
        <div class="playback-heading"><div><span id="playback-kind" class="eyebrow">RECORDED MOTION</span><h2 id="playback-title">Motion timeline</h2></div><div class="playback-state" id="playback-state">READY TO LOAD</div></div>
        <div class="timeline-row" id="replay-timeline"><button class="play-button" id="play" disabled aria-label="Play trajectory">${icon("play")}</button><button class="icon-button restart" id="restart" disabled title="Restart" aria-label="Restart trajectory">${icon("restart")}</button><div class="timeline-wrap"><label for="timeline" class="sr-only">Trajectory time</label><input type="range" id="timeline" min="0" max="1" step="any" value="0" disabled/><div class="timeline-ticks"><span>0.00 s</span><span id="timeline-middle">—</span><span id="timeline-end">—</span></div></div><div class="time-readout"><strong id="time-current">0.00</strong><span> / <span id="time-total">—</span> s</span></div><label class="speed-wrap"><span class="sr-only">Playback speed</span><select id="speed" aria-label="Playback speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label></div>
        <div class="playback-foot"><span id="timing-note">Playback follows recorded simulation timestamps.</span><span class="keyboard-hint"><kbd>space</kbd> play / pause</span></div>
      </section>
    </main>
  </div>`;

const $ = (id) => document.getElementById(id);
let data;
let defaultData;
let replayLibrary;
let referenceMarker;
let trajectory;
let robot;
let playing = false;
let elapsed = 0;
let lastFrame;
let pathGroup;
let currentMarker;
let progressLine;
let renderer;
let camera;
let controls;
let viewCube;
let targetGizmo;
let scene;
let robotBounds;
let ready = false;
let live;
let liveGroup;
let liveTrace;
let liveMarker;
let tracePoints = [];
let lastLiveTime;
let livePrediction;
let liveReference;
let displayedLivePlan;
let liveTaskStart;
let lastCameraFit;
let jointCells = [];

function updateJointTelemetry(q, qd = null, torque = null, limits = data?.joint_limits, torqueKind = "applied") {
  updateJointTable(jointCells, {q, qd, torque, limits, torqueKind});
}
const pathColor = 0x34d8d4;
const targetColor = 0xffb547;

function setupScene() {
  THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x182332);
  scene.fog = new THREE.Fog(0x182332, 8, 22);
  camera = new THREE.PerspectiveCamera(37, 1, 0.01, 100);
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.domElement.setAttribute(
    "aria-label",
    "TIAGo robot and end-effector trajectory",
  );
  $("viewport").prepend(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  camera.position.set(2.5, -3, 2.3);
  controls.target.set(0, 0, .8);
  controls.update();
  controls.enableDamping = true;
  controls.minDistance = 0.3;
  controls.maxDistance = 12;
  controls.maxPolarAngle = Math.PI - 0.000001;
  viewCube = setupViewCube({ camera, controls, viewport: $("viewport") });
  scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x5f6473, 1.7));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
  keyLight.position.set(3, -4, 6);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x8cbcff, 1.2);
  rimLight.position.set(-3, 3, 4);
  scene.add(rimLight);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x111b29, roughness: 1 }),
  );
  floor.position.z = -0.012;
  scene.add(floor);
  const grid = new THREE.GridHelper(12, 60, 0x3d5268, 0x293b4e);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -0.008;
  grid.material.transparent = true;
  grid.material.opacity = 0.65;
  scene.add(grid);
  const axes = new THREE.AxesHelper(0.25);
  axes.position.set(0, 0, 0.005);
  scene.add(axes);
  const resize = () => {
    const { clientWidth: width, clientHeight: height } = $("viewport");
    if (!width || !height) return;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe($("viewport"));
  resize();
  renderer.setAnimationLoop(animate);
}

async function loadRobot(url) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Robot description returned HTTP ${response.status}.`);
  const text = await response.text();
  if (
    new DOMParser()
      .parseFromString(text, "application/xml")
      .querySelector("parsererror")
  ) {
    throw new Error("The robot description is not valid XML.");
  }
  return new Promise((resolve, reject) => {
    const manager = new THREE.LoadingManager();
    const failed = [];
    let model;
    manager.onProgress = (_url, loaded, total) => {
      $("load-detail").textContent =
        `Loading robot geometry · ${loaded} / ${total} assets`;
    };
    manager.onError = (asset) => failed.push(asset);
    manager.onLoad = () =>
      failed.length
        ? reject(new Error(`Could not load robot geometry: ${failed[0]}`))
        : resolve(model);
    const loader = new URDFLoader(manager);
    loader.parseCollision = false;
    loader.parseVisual = true;
    manager.itemStart("robot-model");
    try {
      model = loader.parse(text, "");
      manager.itemEnd("robot-model");
    } catch (error) {
      reject(error);
    }
  });
}

function fitTaskPoints(options = {}) {
  return trajectoryFitPoints({
    replay: trajectory,
    live: live?.mode === 'live',
    taskKind: displayedLivePlan?.task_kind || live?.settings?.task?.kind || 'reach',
    plan: displayedLivePlan,
    state: live?.displayedState || live?.state,
    taskStart: liveTaskStart,
    precomputedPath: live?.mode === 'live' ? live.precomputedPath : undefined,
    ...options,
  });
}

function refreshFitAvailability() {
  $('camera-arm').disabled = live?.mode === 'live' ? !live.fitAvailable : !fitTaskPoints().points.length;
}

function setCamera(mode = "robot", options = {}) {
  if (!robot) return;
  viewCube?.cancel();
  const isTask = mode === 'trajectory' || mode === 'arm';
  const selection = isTask ? fitTaskPoints(options) : { points: objectWorldPoints(robot), source: 'Full robot in current pose' };
  const fit = fitPerspectivePoints(camera, selection.points, { minDistance: controls.minDistance });
  if (!fit) return;
  // Clear residual orbit/pan damping, then restore the existing orientation.
  const orientation = camera.quaternion.clone();
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  camera.quaternion.copy(orientation);
  camera.position.copy(fit.position);
  controls.target.copy(fit.center);
  camera.near = fit.near;
  camera.far = fit.far;
  camera.updateProjectionMatrix();
  controls.maxDistance = Math.max(controls.maxDistance, fit.distance * 2);
  controls.update();
  controls.enableDamping = damping;
  lastCameraFit = { source: selection.source, points: fit.points.map(point => point.toArray()), padding: 1.15 };
  $(isTask ? 'camera-arm' : 'camera-home').title = `${isTask ? 'Fit trajectory' : 'Fit robot'}: ${selection.source}`;
}

function makeMarker(position, color, radius, wireframe = false) {
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 20, 14),
    new THREE.MeshBasicMaterial({
      color,
      wireframe,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    }),
  );
  marker.position.fromArray(position);
  marker.renderOrder = 5;
  return marker;
}

function clearPath() {
  if (!pathGroup) return;
  scene.remove(pathGroup);
  pathGroup.traverse((object) => {
    object.geometry?.dispose();
    if (object.material) object.material.dispose();
  });
}

function selectTrajectory(id) {
  $("replay-timeline").hidden = false;
  document.querySelector("#replay-controls .keyboard-hint").hidden = false;
  trajectory = data.trajectories.find((item) => item.id === id);
  playing = false;
  elapsed = 0;
  clearPath();
  pathGroup = new THREE.Group();
  const line = createPathLine(trajectory.ee_xyz, { color: pathColor, opacity: .95, renderOrder: 3, name: 'replay-tool' });
  pathGroup.add(line);
  progressLine = createPathLine(trajectory.ee_xyz, { color: 0xddffff, width: 3.5, opacity: 1, name: 'replay-progress' });
  pathGroup.add(progressLine);
  pathGroup.add(makeMarker(trajectory.ee_xyz[0], pathColor, 0.014));
  currentMarker = makeMarker(trajectory.ee_xyz[0], 0xffffff, 0.011);
  pathGroup.add(currentMarker);
  referenceMarker = undefined;
  const initialTarget = referencePosition(trajectory, trajectory.time_s[0]);
  if (trajectory.reference_xyz?.length > 1) pathGroup.add(makeLiveLine(trajectory.reference_xyz, targetColor, true));
  if (initialTarget) {
    referenceMarker = makeMarker(initialTarget, targetColor, 0.022, true);
    pathGroup.add(referenceMarker);
  }
  pathGroup.visible = live?.mode !== 'live';
  scene.add(pathGroup);
  const duration = trajectory.time_s.at(-1) - trajectory.time_s[0];
  const recorded = trajectory.kind === "recorded";
  const clock = playbackClock(trajectory);
  $("trajectory-kind").textContent = recorded
    ? "RECORDED MPC MOTION"
    : "SINGLE SOLVER PREDICTION";
  $("trajectory-kind").classList.toggle("prediction", !recorded);
  $("trajectory-description").textContent = recorded
    ? `The robot follows saved states using ${clock === "wall" ? "recorded wall timestamps" : clock === "simulation" ? "the recorded simulation clock" : "recorded timestamps"}.`
    : "The robot follows one saved predicted horizon. This is an open-loop preview of the plan.";
  $("duration-stat").innerHTML = `${duration.toFixed(2)}<small>s</small>`;
  $("samples-stat").textContent = trajectory.time_s.length;
  $("distance-stat").innerHTML =
    `${trajectoryDistance(trajectory.ee_xyz).toFixed(2)}<small>m</small>`;
  const target = referencePosition(trajectory, trajectory.time_s.at(-1));
  const error =
    target?.length === 3
      ? Math.hypot(...trajectory.ee_xyz.at(-1).map((v, i) => v - target[i])) *
        1000
      : null;
  $("error-stat").innerHTML =
    error === null ? "—" : `${error.toFixed(1)}<small>mm</small>`;
  $("timeline").max = duration || 1;
  $("timeline").disabled = duration === 0;
  $("play").disabled = duration === 0;
  $("restart").disabled = false;
  $("time-total").textContent = duration.toFixed(2);
  $("timeline-end").textContent = `${duration.toFixed(2)} s`;
  $("timeline-middle").textContent = `${(duration / 2).toFixed(2)} s`;
  $("playback-kind").textContent = recorded
    ? "RECORDED MOTION"
    : "PREDICTED HORIZON";
  $("playback-title").textContent = trajectory.label;
  const origin = trajectory.metadata?.origin_time_s ?? trajectory.metadata?.recorded_start_s;
  $("timing-note").textContent = recorded
    ? `${clock === 'wall' ? 'Wall-time' : clock === 'simulation' ? 'Simulation-time' : 'Recorded-time'} playback · original sample timestamps`
    : `Prediction-time playback · knot offsets${Number.isFinite(origin) ? ` · ${clock} origin ${origin.toFixed(3)} s` : ''}`;
  updateReplayLegend();
  $("scene-title").textContent = recorded
    ? "Recorded motion"
    : trajectory.label;
  updatePose();
  updatePlaybackState();
  refreshFitAvailability();
}

function updatePose() {
  if (live?.mode === "live" || !trajectory || !robot) return;
  const sample = sampleTrajectory(trajectory, elapsed + trajectory.time_s[0]);
  data.joint_names.forEach((name, i) => {
    robot.setJointValue(name, sample.q[i]);
  });
  const telemetry = sampleTelemetry(trajectory, elapsed + trajectory.time_s[0]);
  updateJointTelemetry(sample.q, telemetry.qd, telemetry.torque, trajectory.joint_limits || data.joint_limits, trajectory.torque_kind);
  currentMarker.position.fromArray(sample.xyz);
  if (referenceMarker) referenceMarker.position.fromArray(referencePosition(trajectory, elapsed + trajectory.time_s[0]));
  setPathPointCount(progressLine, sample.index + 1);
  $("timeline").value = elapsed;
  $("timeline").style.setProperty(
    "--progress",
    `${Math.min(100, (elapsed / ($("timeline").max || 1)) * 100)}%`,
  );
  $("time-current").textContent = elapsed.toFixed(2);
}

function updatePlaybackState() {
  if (!trajectory) {
    $("play").innerHTML = icon("play");
    $("playback-state").textContent = "NO RECORDING";
    $("playback-state").classList.remove("is-playing");
    return;
  }
  $("play").innerHTML = icon(playing ? "pause" : "play");
  $("play").setAttribute(
    "aria-label",
    playing ? "Pause trajectory" : "Play trajectory",
  );
  const end =
    trajectory && elapsed >= trajectory.time_s.at(-1) - trajectory.time_s[0];
  $("playback-state").textContent = playing
    ? "PLAYING"
    : end
      ? "COMPLETE"
      : elapsed > 0
        ? "PAUSED"
        : "READY TO PLAY";
  $("playback-state").classList.toggle("is-playing", playing);
}

function togglePlay() {
  if (!ready || $("play").disabled) return;
  if (elapsed >= trajectory.time_s.at(-1) - trajectory.time_s[0]) elapsed = 0;
  playing = !playing;
  updatePose();
  updatePlaybackState();
}

function animate(timestamp) {
  const delta = lastFrame === undefined ? 0 : (timestamp - lastFrame) / 1000;
  lastFrame = timestamp;
  if (playing && trajectory) {
    const duration = trajectory.time_s.at(-1) - trajectory.time_s[0];
    elapsed = Math.min(duration, elapsed + delta * Number($("speed").value));
    updatePose();
    if (elapsed >= duration) {
      playing = false;
      updatePlaybackState();
    }
  }
  controls.update();
  live?.frame(timestamp);
  viewCube.update(timestamp);
  targetGizmo?.update();
  if (liveGroup?.userData.target) liveGroup.userData.target.visible = !targetGizmo?.active;
  renderer.render(scene, camera);
}

$("play").addEventListener("click", togglePlay);
$("restart").addEventListener("click", () => {
  elapsed = 0;
  playing = false;
  updatePose();
  updatePlaybackState();
});
$("timeline").addEventListener("input", (event) => {
  elapsed = Number(event.target.value);
  playing = false;
  updatePose();
  updatePlaybackState();
});
$("trajectory-select").addEventListener("change", (event) =>
  selectTrajectory(event.target.value),
);
$("camera-home").addEventListener("click", () => setCamera("robot"));
$("camera-arm").addEventListener("click", () => setCamera("trajectory"));
document.addEventListener("keydown", (event) => {
  if (
    event.code !== "Space" ||
    event.target.closest("input, select, button, textarea, a")
  )
    return;
  event.preventDefault();
  if (live?.mode === "live") live.togglePlay();
  else togglePlay();
});

async function start() {
  try {
    setupScene();
    const response = await fetch("/api/scene");
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(
        detail?.error ||
          detail?.detail ||
          `Scene request returned HTTP ${response.status}.`,
      );
    }
    data = await response.json();
    defaultData = data;
    if (!data.trajectories?.length && !isStartingScene(data))
      throw new Error("No trajectories were found in this recording.");
    if (!data.joint_names?.length)
      throw new Error("The scene does not specify robot joints.");
    data.trajectories.forEach((item) =>
      { validateTrajectory(item, data.joint_names.length); validateReference(item); },
    );
    $("load-title").textContent = "Building TIAGo";
    robot = await loadRobot(data.robot_url);
    // Replay the supplied states literally; do not silently clamp retained failures.
    Object.values(robot.joints).forEach((joint) => {
      joint.ignoreLimits = true;
    });
    for (const [name, value] of Object.entries(data.fixed_joints || {}))
      robot.setJointValue(name, value);
    for (const name of data.joint_names) {
      if (!robot.joints[name])
        throw new Error(`Robot description is missing joint ${name}.`);
    }
    scene.add(robot);
    robot.traverse((object) => {
      if (object.isMesh) {
        object.material = object.material.clone();
        object.material.side = THREE.DoubleSide;
      }
    });
    jointCells = createJointTable($("joint-list"), data.joint_names);
    populateReplay(data, {name: isStartingScene(data) ? 'Starting pose' : 'Default recording'});
    robot.updateMatrixWorld(true);
    robotBounds = new THREE.Box3().setFromObject(robot);
    setCamera("home");
    ready = true;
    live = setupLive({ onMode: changeMode, onPlan: showLivePlan, onState: showLiveState, onReset: resetLiveTrace });
    targetGizmo = setupTargetGizmo({ scene, camera, renderer, orbit: controls, getTarget: () => live.targetInteraction,
      moveTarget: position => live.setTargetWorld(position), button: $('target-move'), note: $('target-move-note') });
    replayLibrary = setupReplayLibrary({ onScene: loadReplayScene, initialName: isStartingScene(data) ? 'Starting pose' : 'Default recording' });
    $("connection-label").textContent = "Local source";
    document.querySelector(".connection").classList.add("connected");
    $("load-overlay").hidden = true;
    // Expose a small read-only handle for browser smoke checks and local inspection.
    window.__motionStudio = {
      get targetGizmo() { return targetGizmo?.snapshot; },
      get library() { return replayLibrary; },
      get replayScene() { return data; },
      get pathInfo() { return { replay: (pathGroup?.children || []).filter(line => line.isLine2).map(pathLineInfo), live: (liveGroup?.children || []).filter(line => line.isLine2).map(pathLineInfo) }; },
      get replayTarget() { return referenceMarker?.position.toArray() ?? null; },
      get live() {
        return live;
      },
      get robot() {
        return robot;
      },
      get cameraPose() {
        return {
          position: camera.position.toArray(),
          target: controls.target.toArray(),
          up: camera.up.toArray(),
          quaternion: camera.quaternion.toArray(),
          fov: camera.fov, aspect: camera.aspect, near: camera.near, far: camera.far,
        };
      },
      get cameraFit() { return lastCameraFit; },
      get trajectory() {
        return trajectory;
      },
      get elapsed() {
        return elapsed;
      },
      get playing() {
        return playing;
      },
      get ready() {
        return ready;
      },
    };
  } catch (error) {
    console.error(error);
    $("load-overlay").classList.add("has-error");
    $("load-title").textContent = "Workspace could not load";
    $("load-detail").textContent = error.message;
    $("connection-label").textContent = "Unavailable";
    $("playback-state").textContent = "LOAD ERROR";
    document.querySelector(".connection").classList.add("connection-error");
  }
}

start();

function changeMode(mode) {
  playing = false;
  updatePlaybackState();
  if (pathGroup) pathGroup.visible = mode === 'replay';
  if (liveGroup) liveGroup.visible = mode === 'live';
  $('path-legend').innerHTML = mode === 'live'
    ? '<span><i class="legend-line"></i>Prediction</span><span><i class="legend-reference"></i>Reference / target</span><span><i class="legend-executed"></i>Simulated motion</span>'
    : replayLegend();
  if (mode === 'replay') {
    applyFixedJoints(data);
    updatePose();
    $('scene-title').textContent = trajectory?.label || 'Starting pose';
    if (!trajectory) showJointLabels();
  } else {
    applyFixedJoints(defaultData);
    $('scene-title').textContent = 'Live MPC · simulated plant';
    if (!liveGroup) {
      liveGroup = new THREE.Group();
      scene.add(liveGroup);
      liveTrace = createPathLine([], { color: 0xffffff, name: 'live-trace' });
      liveGroup.add(liveTrace);
    }
  }
  refreshFitAvailability();
}

function makeLiveLine(points, color, dashed) {
  return createPathLine(points, { color, dashed, opacity: .95, name: dashed ? 'reference' : 'live-path' });
}

function disposeLiveObject(object) {
  if (!object) return;
  liveGroup.remove(object);
  object.geometry.dispose();
  object.material.dispose();
}

function showLivePlan(plan) {
  if (!liveGroup) return;
  displayedLivePlan = plan;
  disposeLiveObject(livePrediction);
  disposeLiveObject(liveReference);
  if (liveGroup.userData.target) disposeLiveObject(liveGroup.userData.target);
  livePrediction = liveReference = liveGroup.userData.target = undefined;
  if (!plan) { refreshFitAvailability(); return; }
  livePrediction = makeLiveLine(plan.ee_xyz, pathColor, false);
  liveReference = makeLiveLine(plan.task_path_xyz || plan.reference_xyz, targetColor, true);
  // A reaching reference is a repeated point; keep a visible target marker.
  const target = makeMarker(plan.target_xyz || plan.reference_xyz[0], targetColor, 0.022, true);
  liveGroup.userData.target = target;
  liveGroup.add(livePrediction, liveReference, target);
  refreshFitAvailability();
}

function resetLiveTrace() {
  liveTaskStart = undefined;
  tracePoints = [];
  lastLiveTime = undefined;
  if (liveTrace) setPathPoints(liveTrace, []);
}

function showLiveState(state, context = {}) {
  if (!robot || !liveGroup) return;
  if (!context.historical && !context.interpolated) {
    if (lastLiveTime !== undefined && state.sim_time_s < lastLiveTime) liveTaskStart = undefined;
    if (!liveTaskStart) liveTaskStart = [...state.ee_xyz];
  }
  defaultData.joint_names.forEach((name, i) => {
    robot.setJointValue(name, state.q[i]);
  });
  updateJointTelemetry(state.q, state.qd, state.torque_nm, state.joint_limits || defaultData.joint_limits);
  if (Array.isArray(state.target_xyz) && state.target_xyz.length === 3 && state.target_xyz.every(Number.isFinite) && liveGroup.userData.target) liveGroup.userData.target.position.fromArray(state.target_xyz);
  if (context.tracePoints) {
    if (tracePoints !== context.tracePoints) {
      tracePoints = context.tracePoints;
      setPathPoints(liveTrace, tracePoints);
    }
    setPathPointCount(liveTrace, context.traceCount ?? tracePoints.length);
  } else if (lastLiveTime === undefined || state.sim_time_s !== lastLiveTime) {
    if (lastLiveTime !== undefined && state.sim_time_s < lastLiveTime) resetLiveTrace();
    tracePoints.push(state.ee_xyz);
    if (tracePoints.length > 1500) tracePoints.shift();
    setPathPoints(liveTrace, tracePoints);
  }
  lastLiveTime = state.sim_time_s;
  if (!liveMarker) {
    liveMarker = makeMarker(state.ee_xyz, 0xffffff, 0.011);
    liveGroup.add(liveMarker);
  }
  liveMarker.position.fromArray(state.ee_xyz);
  refreshFitAvailability();
}

function replayLegend() {
  if (!trajectory) return '';
  const reference = trajectory?.reference_xyz?.length;
  const target = reference || trajectory?.target_xyz?.length === 3;
  return '<span><i class="legend-line"></i>Tool path</span><span><i class="legend-start"></i>Start</span>' + (target ? `<span><i class="${reference ? 'legend-reference' : 'legend-target'}"></i>${reference ? 'Reference / target' : 'Target'}</span>` : '');
}

function updateReplayLegend() {
  if (live?.mode !== 'live') $('path-legend').innerHTML = replayLegend();
}

function applyFixedJoints(recording) {
  const moving = new Set(defaultData.joint_names);
  // Reset every non-arm coordinate so optional values from an earlier file
  // cannot carry into another recording or the independent live scene.
  for (const [name, joint] of Object.entries(robot.joints)) {
    if (!moving.has(name) && joint.jointType !== 'fixed' && !joint.mimicJoint) robot.setJointValue(name, 0);
  }
  for (const [name, value] of Object.entries(recording.fixed_joints || {})) robot.setJointValue(name, value);
}

function populateReplay(recording, item) {
  const select = $('trajectory-select');
  select.replaceChildren(...recording.trajectories.map((entry) => {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    return option;
  }));
  select.disabled = !recording.trajectories.length;
  const commit = recording.source?.repository_commit || recording.source?.commit;
  $('source-commit').textContent = commit ? String(commit).slice(0, 7) : 'recording';
  $('source-commit').title = commit || 'Uploaded or watched recording';
  const path = item.path || recording.source?.run_dir || recording.source?.recording || '';
  $('source-run').textContent = item.name || path || 'Local saved trajectory';
  $('source-run').title = path;
  if (recording.trajectories.length) selectTrajectory(recording.trajectories[0].id);
  else showStartingPose();
}

async function loadReplayScene(next, item) {
  if (next.robot_url !== defaultData.robot_url) throw new Error('This recording uses a different robot description.');
  if (JSON.stringify(next.joint_names) !== JSON.stringify(defaultData.joint_names)) throw new Error('This recording uses different robot joints.');
  const starting = item.id === 'default' && isStartingScene(next);
  if (!next.trajectories?.length && !starting) throw new Error('This recording has no trajectories.');
  for (const entry of next.trajectories) {
    validateTrajectory(entry, next.joint_names.length);
    validateReference(entry);
  }
  for (const [name, value] of Object.entries(next.fixed_joints || {})) {
    if (!robot.joints[name] || !Number.isFinite(value) || (!starting && defaultData.joint_names.includes(name))) throw new Error(`Invalid fixed robot joint ${name}.`);
  }
  data = next;
  if (live?.mode !== 'live') applyFixedJoints(data);
  populateReplay(next, item);
  robot.updateMatrixWorld(true);
  robotBounds = new THREE.Box3().setFromObject(robot);
}

function showJointLabels() {
  updateJointTelemetry(data.joint_names.map((name) => robot.joints[name].angle));
}

function showStartingPose() {
  $('replay-timeline').hidden = true;
  document.querySelector('#replay-controls .keyboard-hint').hidden = true;
  trajectory = undefined;
  playing = false;
  elapsed = 0;
  clearPath();
  pathGroup = currentMarker = progressLine = referenceMarker = undefined;
  const option = document.createElement('option');
  option.textContent = 'No recording loaded';
  $('trajectory-select').replaceChildren(option);
  $('trajectory-select').disabled = true;
  $('play').disabled = $('restart').disabled = $('timeline').disabled = true;
  $('timeline').value = 0;
  $('timeline').style.setProperty('--progress', '0%');
  $('trajectory-kind').textContent = 'STARTING POSE';
  $('trajectory-kind').classList.remove('prediction');
  $('trajectory-description').textContent = 'Upload .npz recordings or choose a recording from the library to view motion.';
  for (const id of ['duration-stat', 'samples-stat', 'distance-stat', 'error-stat', 'time-current', 'time-total', 'timeline-middle', 'timeline-end']) $(id).textContent = '—';
  $('playback-kind').textContent = 'NO RECORDING';
  $('playback-title').textContent = 'Starting pose';
  $('timing-note').textContent = 'Upload a recording or choose one from the library.';
  if (live?.mode !== 'live') {
    applyFixedJoints(data);
    showJointLabels();
    $('scene-title').textContent = 'Starting pose';
  }
  updateReplayLegend();
  updatePlaybackState();
  refreshFitAvailability();
}
