import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import URDFLoader from "urdf-loader";
import { setupOnionSkin, ONION_COLOR, ONION_PREDICTION_COLOR } from './onion-skin-view.js';
import { sampleAtOrBefore } from './onion-skin.js';
import { setupLive } from "./live.js";
import { createSession, outsideSpan, trackTime } from "./session.js";
import { createTrackScene } from "./track-scene.js";
import { livePredictionForView, inspectedPathStyle } from "./prediction-selection.js";
import { setupSourceSettings } from "./source-settings.js";
import { createLimitTint } from "./limit-tint.js";
import { DEFAULT_LIMIT_USE, pickLimitUse } from "./limit-use.js";
import { setupPresentationSettings } from "./presentation-settings.js";
import { setupSolverProfiles } from "./solver-profiles.js";
import "./solver-profiles.css";
import "./floating-dialog.css";
import { workbenchShell } from "./workbench-shell.js";
import { setupExpandedTimeline, aggregateSpan } from "./expanded-timeline.js";
import { setupPlotInspection } from "./plot-inspection.js";
import { setupWorkbench } from "./workbench-ui.js";
import { setupGhostControls } from './transport-popover.js';
import { setupSidebarResize } from "./sidebar-width.js";
import { setupAuxiliaryViews, visibleSceneBounds } from "./auxiliary-views.js";
import { createJointTable, updateJointTable, sampleTelemetry, setupJointViewToggle } from "./joint-telemetry.js";
import { setupReplayLibrary, validateReference, referencePosition, playbackClock, isStartingScene } from "./replay-library.js";
import { setupTargetGizmo } from "./target-gizmo.js";
import { setupViewCube } from "./view-cube.js";
import { fitPerspectivePoints, objectWorldPoints, trajectoryFitPoints, TRAJECTORY_FIT_PADDING } from "./camera-fit.js";
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
import "./timeline.css";
import "./plots.css";
import "./solve-run.css";

const icons = {
  play: '<path d="m8 5 11 7-11 7V5Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="4"/>',
  restart: '<path d="M4 10a8 8 0 1 1 1 7M4 4v6h6"/>',
  home: '<path d="m3 10 9-7 9 7M6 9v11h12V9M10 20v-7h4v7"/>',
  focus:
    '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><circle cx="12" cy="12" r="3"/>',
  robot: '<path d="M8 5h8l3 5v10H5V10l3-5ZM12 2v3M8 12h1m6 0h1M9 16h6"/>',
  panelLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  panelRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  calculate: '<path d="M13 2 5 13h6l-1 9 9-13h-6l1-7Z"/>',
  settings: '<path d="m10 3-.6 2.2-2 .9-2-.7-2 3.4 1.5 1.6v2.3L3.4 14l2 3.4 2-.7 2 .9.6 2.2h4l.6-2.2 2-.9 2 .7 2-3.4-1.5-1.6v-2.3L20.6 8l-2-3.4-2 .7-2-.9L14 3Z"/><circle cx="12" cy="11.4" r="3"/>',
  freeze: '<rect x="4" y="4" width="12" height="12" rx="2"/><path d="M8 20h10a2 2 0 0 0 2-2V8M10 7v6M7 10h6"/>',
  onion: '<path d="M3 20a17 17 0 0 1 17-17M8 20A12 12 0 0 1 20 8M13 20a7 7 0 0 1 7-7"/>',
  chevron: '<path d="m8 5 7 7-7 7"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

document.body.classList.add('studio-workbench');
document.querySelector("#app").innerHTML = workbenchShell(icon);

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
let session, trackScene;
// Focus stays on the main track in this deliverable; all presentation reads use it.
const focusedTrack = () => live?.mode === "live" ? session?.focused : null;
let solverProfiles;
const sourceSettings = setupSourceSettings({ button: $('source-settings-open'), onOpen: () => solverProfiles?.refresh().catch(() => {}), onPlottersReload: () => plotInspection.refresh(), beforeApply: () => {
  try { sessionStorage.setItem('source-restart-live-settings', JSON.stringify(live?.settings)); } catch {}
} });
// Notices link straight to the settings tab that fixes them.
document.addEventListener('open-settings', event => { sourceSettings.dialog.selectTab(event.detail?.tab || 'backend'); $('source-settings-open').click(); });
let limitTint, limitTintEnabled = true, limitUse = { ...DEFAULT_LIMIT_USE }, lastJointTelemetry;
const presentationSettings = setupPresentationSettings({ container: sourceSettings.panels.ui, onChange: settings => {
  live?.setPresentationSettings(settings); limitTintEnabled = settings.limit_tint; limitTint?.setEnabled(limitTintEnabled);
  onionSkin?.setSettings({ opacity: settings.ghost_opacity_percent / 100 });
  auxiliaryViews?.invalidate();
  const next = pickLimitUse(settings);
  if (JSON.stringify(next) === JSON.stringify(limitUse)) return;
  limitUse = next; limitTint?.setSettings(limitUse);
  if (lastJointTelemetry) updateJointTelemetry(...lastJointTelemetry);
  // Plots that draw limit states receive the same thresholds with each request.
  plotInspection.invalidate();
} });
solverProfiles = setupSolverProfiles({ liveContainer: $('live-panel'), editorContainer: sourceSettings.panels.solverProfiles,
  beforeActivate: () => live?.beginSolverProfileSwitch(),
  onSettled: async item => { await live?.finishSolverProfileSwitch(item); plotInspection.refresh(); },
});
solverProfiles.refresh().catch(error => console.warn('Solver profiles unavailable:', error.message));
let liveGroup;
let liveTrace;
let liveMarker;
let tracePoints = [];
let lastLiveTime;
let livePrediction;
let replayInspectionPrediction;
let liveReference;
let displayedLiveReference;
let displayedLivePlan;
let liveTaskStart;
let lastCameraFit;
let jointCells = [];
let auxiliaryViews;
let onionSkin, onionSpike;
const ghostControls = setupGhostControls({ onChange: settings => {
  onionSkin?.setSettings(settings); auxiliaryViews?.invalidate();
} });
const workbench = setupWorkbench({ onLayout: () => auxiliaryViews?.invalidate() });
setupSidebarResize({ shell: document.getElementById("workbench"), onLayout: () => auxiliaryViews?.invalidate() });
const emptyTimingIntervals = [];
const expandedTimeline = setupExpandedTimeline({
  onLayout: () => auxiliaryViews?.invalidate(),
  onAggregate: aggregate => { if (live?.mode === 'live') session?.setAggregate(aggregate); },
  onAddTrack: id => addSessionTrack(id).catch(showTrackError),
  onFreeze: () => $('live-freeze').click(),
  onTrackChange: (id, patch) => {
    if ('displayName' in patch) session.setName(id, patch.displayName);
    if ('offset_s' in patch) session.setOffset(id, patch.offset_s);
    if ('visible' in patch) session.setVisible(id, patch.visible);
    if ('display' in patch) session.setDisplay(id, patch.display);
    auxiliaryViews?.invalidate();
  },
  onTrackReset: id => { session.resetOffset(id); auxiliaryViews?.invalidate(); },
  onTrackRemove: id => { session.removeTrack(id); auxiliaryViews?.invalidate(); },
  onSeek: time => {
    if (focusedTrack()) { live.seek(time); return; }
    const input = $('timeline');
    if (input.disabled) return;
    input.value = time;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  },
});
const linkedGraphContainer = $('timeline-linked-graphs');
expandedTimeline.bindSurface(linkedGraphContainer);
let inspectedPrediction;
const plotInspection = setupPlotInspection({
  episodeContainer: $('episode-plots'), solveContainer: $('solve-plots'), bottomContainer: linkedGraphContainer, viewport: $('viewport'), stripHandle: $('timeline-strip-resize'),
  getSource: () => {
    const track = focusedTrack();
    if (track) {
      if (track.source?.kind === 'live' && !Number.isInteger(track.source.generation)) return null;
      return { source: track.source, revision: [track.history?.cursor, track.plan?.seq, track.plan?.settings_version, track.plan?.origin],
        solveSeq: track.plan?.origin === 'preview' ? `preview:${track.plan.seq}` : null, label: track.label };
    }
    return trajectory ? { source: { kind: 'replay', id: replayLibrary?.selectedId || 'default', trajectory_index: data?.trajectories?.indexOf(trajectory) ?? 0,
      ...(data?.source?.plot_revision ? { revision: data.source.plot_revision } : {}) }, revision: data?.source?.plot_revision || trajectory.id, label: trajectory.label || 'Imported recording' } : null;
  },
  getView: () => {
    const view = expandedTimeline.snapshot, track = focusedTrack(), offset = track?.offset_s || 0;
    const aggregate = track ? session.aggregate : view.aggregate;
    return { window: view.visible.map(time => time - offset), cursor: track ? trackTime(track, session.cursor) : view.selectedTime,
      aggregate: { start: aggregate.start == null ? null : aggregate.start - offset, end: aggregate.end == null ? null : aggregate.end - offset },
      reveal: liveReveal(track ? trackTime(track, session.cursor) : view.selectedTime), episodeClock: Boolean(track) || trajectory?.kind === 'recorded', inspectSolve: workbench.activeTab === 'solve' };
  },
  getSolverProfile: () => ({ id: solverProfiles.snapshot.catalog.active_profile_id, switching: solverProfiles.snapshot.switching }),
  getLimitUse: () => limitUse,
  onInspectionStart: () => live?.holdForInspection(),
  onClearAggregate: () => expandedTimeline.clearAggregate(),
  onSeek: time => expandedTimeline.seek(time),
  onPrediction: inspection => { inspectedPrediction = inspection; renderInspectedPrediction(); },
});
// While Live playback runs at the growing edge, episode plots reveal data only
// up to the playback cursor, in step with the 3D view. Paused, scrubbed or
// Replay views show all available data.
function liveReveal(time) {
  const history = focusedTrack()?.history || null;
  return history?.playing && (history.following || history.buffering || history.growing) && Number.isFinite(time) ? time : undefined;
}
function updateExpandedTimeline() {
  if (live?.mode === 'live') {
    const track = session?.focused, history = track?.history || live.history;
    expandedTimeline.update({ mode: 'live', identity: session?.id, session, bounds: session?.span || history.presentationBounds,
      time: session?.cursor ?? history.selectedTime, clockLabel: 'Session time',
      intervals: history.intervals, breaches: history.breaches || [], revision: track?.historyRevision, tracks: session ? sessionLanes() : [], catalog: replayLibrary?.items || [],
      aggregate: session?.aggregate, freezeAvailable: !$('live-freeze').disabled, ...onionSkin?.timeline });
  } else {
    const duration = trajectory ? trajectory.time_s.at(-1) - trajectory.time_s[0] : 0;
    expandedTimeline.update({ mode: 'replay', identity: trajectory, bounds: [0, duration], time: elapsed, clockLabel: `${trajectory ? playbackClock(trajectory) : 'recorded'} time`.replace(/^./, letter => letter.toUpperCase()), intervals: emptyTimingIntervals, ...onionSkin?.timeline });
  }
}

// Limit use is measured against the URDF limits (`joint_limits`); the
// tighter MPC bounds (`mpc_bounds`), when known, appear only in tooltips.
function updateJointTelemetry(q, qd = null, torque = null, limits = data?.joint_limits, torqueKind = "applied", mpcBounds = data?.mpc_bounds) {
  lastJointTelemetry = [q, qd, torque, limits, torqueKind, mpcBounds];
  updateJointTable(jointCells, {q, qd, torque, limits, mpcBounds, torqueKind, settings: limitUse});
  limitTint?.update({q, qd, torque, limits});
}
const pathColor = ONION_PREDICTION_COLOR;
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
    live: Boolean(focusedTrack()),
    taskKind: focusedTrack()?.reference?.kind || focusedTrack()?.context?.task?.kind || 'reach',
    plan: focusedTrack()?.reference ? { ...focusedTrack().plan, task_path_xyz: focusedTrack().reference.points,
      target_xyz: focusedTrack().reference.target_xyz } : focusedTrack()?.plan && { ...focusedTrack().plan, task_path_xyz: focusedTrack().context?.task_path_xyz },
    state: focusedTrack()?.reference?.draft ? { ...(focusedTrack()?.displayedState || focusedTrack()?.state), target_xyz: focusedTrack().reference.target_xyz } : focusedTrack()?.displayedState || focusedTrack()?.state,
    taskStart: liveTaskStart,
    precomputedPath: focusedTrack()?.precomputedPath,
    ...options,
  });
}

function refreshFitAvailability() {
  $('camera-arm').disabled = focusedTrack() ? !focusedTrack().fitAvailable : !fitTaskPoints().points.length;
}

function setCamera(mode = "robot", options = {}) {
  if (!robot) return;
  viewCube?.cancel();
  const isTask = mode === 'trajectory' || mode === 'arm';
  const selection = isTask ? fitTaskPoints(options) : { points: objectWorldPoints(robot), source: 'Full robot in current pose' };
  const padding = isTask ? TRAJECTORY_FIT_PADDING : 1.15;
  const fit = fitPerspectivePoints(camera, selection.points, { minDistance: controls.minDistance, padding });
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
  lastCameraFit = { source: selection.source, points: fit.points.map(point => point.toArray()), padding };
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
  auxiliaryViews?.invalidate();
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

function updateOnionSkin() {
  if (!onionSkin) return;
  const history = focusedTrack()?.history || null;
  if (history) {
    onionSkin.update({ mode: 'live', identity: `live:${history.generation}`, revision: live.historyRevision,
      times: history.length ? history.bounds : [], bounds: history.bounds, trackBounds: history.presentationBounds,
      range: aggregateSpan(session?.aggregate, session?.span || history.bounds),
      cursor: history.selectedTime ?? history.bounds[1], reveal: liveReveal(history.selectedTime),
      states: times => live.historyStates(times), jointNames: defaultData.joint_names, color: ONION_COLOR,
      comparisons: trackScene?.onionSources || [] });
  } else {
    const times = trajectory?.time_s || [], offset = times[0] || 0;
    const bounds = [0, times.length ? times.at(-1) - offset : 0];
    onionSkin.update({ mode: 'replay', identity: trajectory, revision: trajectory,
      times, bounds: times.length ? [offset, times.at(-1)] : [0, 0],
      trackBounds: bounds, range: aggregateSpan(expandedTimeline.snapshot.aggregate, bounds), offset, cursor: elapsed + offset,
      states: keyframes => keyframes.map(time => { const index = sampleAtOrBefore(times, time); return index < 0 ? null : { time: times[index], q: trajectory.q[index] }; }),
      jointNames: data.joint_names, color: trajectory?.kind === 'prediction' ? pathColor : ONION_COLOR });
  }
}

function animate(timestamp) {
  const delta = lastFrame === undefined ? 0 : (timestamp - lastFrame) / 1000;
  lastFrame = timestamp;
  if (playing && trajectory) {
    const duration = trajectory.time_s.at(-1) - trajectory.time_s[0];
    const nextTime = elapsed + delta * Number($("speed").value);
    elapsed = Math.min(duration, nextTime);
    updatePose();
    if (elapsed >= duration) {
      if ($('replay-stop-at-end').checked || duration <= 0) playing = false;
      else elapsed = nextTime % duration;
      updatePose(); updatePlaybackState();
    }
  }
  controls.update();
  live?.frame(timestamp);
  viewCube.update(timestamp);
  targetGizmo?.update();
  if (liveGroup?.userData.target) liveGroup.userData.target.visible = displayedLiveReference?.kind === 'figure8' || !targetGizmo?.active;
  updateSessionScene();
  updateOnionSkin();
  onionSkin?.sort(camera);
  trackScene?.sort(camera);
  onionSpike?.beforeRender(camera);
  renderer.render(scene, camera);
  workbench.update(); updateExpandedTimeline(); plotInspection.update(); auxiliaryViews?.render(timestamp);
  onionSpike?.frame(timestamp);
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
    event.target.closest("input, select, button, textarea, a, [contenteditable=\"true\"]")
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
    auxiliaryViews = setupAuxiliaryViews({ scene, top: $('auxiliary-top'), right: $('auxiliary-right'),
      getBounds: () => { const bounds = visibleSceneBounds(robot, focusedTrack() ? liveGroup : pathGroup);
        if (focusedTrack() && trackScene?.group.visible) bounds.union(trackScene.bounds); return bounds; },
      visible: () => workbench.auxiliaryVisible, beforeRender: viewCamera => { onionSkin?.sort(viewCamera); trackScene?.sort(viewCamera); onionSpike?.beforeRender(viewCamera); } });
    robot.traverse((object) => {
      if (object.isMesh) {
        object.material = object.material.clone();
        object.material.side = THREE.DoubleSide;
      }
    });
    limitTint = createLimitTint({ robot, jointNames: data.joint_names, camera, element: renderer.domElement, tooltip: $("limit-tint-tooltip") });
    limitTint.setEnabled(limitTintEnabled); limitTint.setSettings(limitUse);
    onionSkin = setupOnionSkin({ robot, scene, camera, element: renderer.domElement, onSeek: time => {
      const input = $(live?.mode === 'live' ? 'live-history' : 'timeline');
      input.value = time; input.dispatchEvent(new Event('input', { bubbles: true }));
    } });
    onionSkin.setSettings({ ...ghostControls.settings, opacity: presentationSettings.settings.ghost_opacity_percent / 100 });
    trackScene = createTrackScene({ robot, scene, jointNames: defaultData.joint_names });
    jointCells = createJointTable($("joint-list"), data.joint_names);
    setupJointViewToggle({ container: $("joint-list"), buttons: { gauges: $("joint-view-gauges"), numbers: $("joint-view-numbers") } });
    populateReplay(data, {name: 'Starting pose'});
    robot.updateMatrixWorld(true);
    robotBounds = new THREE.Box3().setFromObject(robot);
    setCamera("home");
    ready = true;
    await presentationSettings.ready;
    live = setupLive({ presentationSettings: presentationSettings.settings, onMode: changeMode, onPlan: showLivePlan, onReference: showLiveReference, onState: showLiveState, onReset: resetLiveTrace, onSolverProfile: item => solverProfiles.handleEvent(item), onFreeze: async item => {
      await addSessionTrack(item.id, item); await replayLibrary?.refresh();
    } });
    session = createSession();
    session.updateMain({ endEffectorFrame: defaultData.end_effector_frame });
    live.setSession(session);
    targetGizmo = setupTargetGizmo({ scene, camera, renderer, orbit: controls, getTarget: () => live.targetInteraction,
      moveTarget: position => live.setTargetWorld(position), transformTarget: pose => live.setTaskTransform(pose), button: $('target-move'), note: $('target-move-note') });
    replayLibrary = setupReplayLibrary({ onScene: loadReplayScene, initialName: 'Starting pose' });
    $("connection-label").textContent = "Local source";
    document.querySelector(".connection").classList.add("connected");
    $("load-overlay").hidden = true;
    // Expose a small read-only handle for browser smoke checks and local inspection.
    if (new URLSearchParams(location.search).has('onion-spike')) {
      const { setupOnionSpike } = await import('./onion-spike.js');
      onionSpike = setupOnionSpike({ renderer, scene, camera, controls, robot, getTrajectory: () => playing || live?.mode === 'live' ? null : trajectory, getJointNames: () => data.joint_names, auxiliaryViews, setNormalVisible: value => onionSkin.setVisible(value) });
    }
    window.__motionStudio = {
      get session() { return session ? { id: session.id, focusedId: session.focused?.id, span: session.span, cursor: session.cursor, rate: session.rate, aggregate: session.aggregate,
        tracks: session.tracks.map(track => ({ id: track.id, kind: track.kind, source: track.source, label: track.label, displayName: track.displayName, color: track.color, offset_s: track.offset_s,
          display: track.display, visible: track.visible, span: track.span, time: trackTime(track, session.cursor), outside: outsideSpan(track, session.cursor) })), ...trackScene?.snapshot } : null; },
      get onionSpike() { return onionSpike?.snapshot; },
      get onionSkin() { return onionSkin?.snapshot; },
      get auxiliaryViews() { return auxiliaryViews?.snapshot; },
      get timeline() { return expandedTimeline.snapshot; },
      get plots() { return plotInspection.snapshot; },
      get workbench() { return { activeTab: workbench.activeTab, auxiliaryVisible: workbench.auxiliaryVisible }; },
      get targetGizmo() { return targetGizmo?.snapshot; },
      get library() { return replayLibrary; },
      get replayScene() { return data; },
      get pathInfo() { return { replay: (pathGroup?.children || []).filter(line => line.isLine2).map(pathLineInfo), live: (liveGroup?.children || []).filter(line => line.isLine2).map(pathLineInfo) }; },
      get liveReference() { return displayedLiveReference; },
      get liveReferenceTarget() { return liveGroup?.userData.target?.position.toArray() ?? null; },
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
  replayLibrary?.setLive(mode === 'live');
  auxiliaryViews?.invalidate();
  playing = false;
  updatePlaybackState();
  if (pathGroup) pathGroup.visible = mode === 'replay';
  if (liveGroup) liveGroup.visible = mode === 'live';
  if (trackScene) trackScene.group.visible = mode === 'live';
  if (mode !== 'live') setMainDimmed(false);
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

// A pinned Solve's prediction uses the pin's red from the inspector styles.
function makePredictionLine(points, inspection) {
  const style = inspectedPathStyle(inspection, inspection?.prediction);
  const color = style.pinned ? new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--pin-red').trim()) : pathColor;
  return createPathLine(points, { color, opacity: style.context ? .4 : .95, name: 'live-path' });
}

function showLivePlan(plan) {
  displayedLivePlan = plan;
  renderInspectedPrediction();
}

function renderInspectedPrediction() {
  auxiliaryViews?.invalidate();
  if (live?.mode !== 'live') {
    if (replayInspectionPrediction) { scene?.remove(replayInspectionPrediction); replayInspectionPrediction.geometry.dispose(); replayInspectionPrediction.material.dispose(); replayInspectionPrediction = undefined; }
    if (inspectedPrediction?.active && inspectedPrediction.prediction?.ee_xyz?.length && scene) { replayInspectionPrediction = makePredictionLine(inspectedPrediction.prediction.ee_xyz, inspectedPrediction); replayInspectionPrediction.name = 'inspected-solve-prediction'; scene.add(replayInspectionPrediction); }
    return;
  }
  if (replayInspectionPrediction) replayInspectionPrediction.visible = false;
  if (!liveGroup) return;
  disposeLiveObject(livePrediction); livePrediction = undefined;
  const plan = livePredictionForView(focusedTrack()?.plan, inspectedPrediction);
  if (plan?.ee_xyz?.length) { livePrediction = plan === inspectedPrediction?.prediction ? makePredictionLine(plan.ee_xyz, inspectedPrediction) : makeLiveLine(plan.ee_xyz, pathColor, false); liveGroup.add(livePrediction); }
  refreshFitAvailability();
}

function showLiveReference(reference) {
  if (!liveGroup) return;
  auxiliaryViews?.invalidate();
  reference = focusedTrack()?.reference ?? reference;
  displayedLiveReference = reference;
  disposeLiveObject(liveReference);
  if (liveGroup.userData.target) disposeLiveObject(liveGroup.userData.target);
  liveReference = liveGroup.userData.target = undefined;
  if (reference) {
    liveReference = makeLiveLine(reference.points, targetColor, true);
    liveGroup.userData.target = makeMarker(reference.target_xyz, targetColor, 0.022, true);
    liveGroup.add(liveReference, liveGroup.userData.target);
  }
  refreshFitAvailability();
}

function resetLiveTrace() {
  liveTaskStart = undefined;
  tracePoints = [];
  lastLiveTime = undefined;
  if (liveTrace) setPathPoints(liveTrace, []);
}

function showLiveState(state, context = {}) {
  if (!robot || !liveGroup || (session && session.focused?.kind !== 'live')) return;
  const focused = focusedTrack();
  state = focused?.displayedState || state;
  context = { ...context, segment: focused?.context || context.segment };
  if (!context.historical && !context.interpolated) {
    if (lastLiveTime !== undefined && state.sim_time_s < lastLiveTime) liveTaskStart = undefined;
    if (!liveTaskStart) liveTaskStart = [...state.ee_xyz];
  }
  defaultData.joint_names.forEach((name, i) => {
    robot.setJointValue(name, state.q[i]);
  });
  updateJointTelemetry(state.q, state.qd, state.torque_nm, context.segment?.joint_limits || defaultData.joint_limits, "applied", context.segment?.mpc_bounds || null);
  const referenceTarget = context.referenceTarget || (!displayedLiveReference?.draft ? state.target_xyz : null);
  if (Array.isArray(referenceTarget) && referenceTarget.length === 3 && referenceTarget.every(Number.isFinite) && liveGroup.userData.target) liveGroup.userData.target.position.fromArray(referenceTarget);
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
  onionSkin?.setBase();
  trackScene?.setBase();
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
  const path = item.path || '';
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
  $('replay-timeline').hidden = false;
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


function showTrackError(error) {
  const message = $('timeline-track-message');
  if (message) { message.textContent = error.message; message.hidden = false; }
  else console.warn('Track unavailable:', error.message);
}

async function addSessionTrack(id, item) {
  if (!session) throw new Error('The session is not ready.');
  item ||= replayLibrary?.items.find(entry => entry.id === id);
  const response = await fetch(`/api/replays/motion?id=${encodeURIComponent(id)}`);
  const motion = await response.json();
  if (!response.ok) throw new Error(motion.error || 'The track could not load.');
  validateTrajectory(motion, defaultData.joint_names.length); validateReference(motion);
  const track = session.addTrack({ kind: 'replay', source: { kind: 'replay', id: motion.id, revision: motion.revision },
    label: item?.source === 'freeze' ? freezeTimeLabel(motion) : item?.name || motion.label,
    defaultOffset: item?.source === 'freeze' ? 'zero' : 'align-start',
    span: [motion.time_s[0], motion.time_s.at(-1)], timeBasis: motion.time_basis,
    endEffectorFrame: motion.end_effector_frame,
    settings: motion.provenance?.live?.settings || null,
    motion, catalogSource: item?.source, catalogName: item?.name, provenance: motion.provenance });
  const message = $('timeline-track-message'); if (message) message.hidden = true;
  auxiliaryViews?.invalidate(); updateExpandedTimeline(); return track;
}

function freezeTimeLabel(motion) {
  const timestamp = motion.provenance?.live?.frozen_at;
  const date = timestamp && new Date(timestamp);
  return date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour12: false }) : motion.label.replace(/^Freeze\s*[·:]?\s*/, '');
}

function sessionLanes() {
  return session.tracks.map(track => ({ ...track, intervals: track.kind === 'live' ? session.focused.history?.intervals || [] : [] }));
}

let mainDimmed = false;
const mainMaterials = new Map();
function setMainDimmed(dimmed) {
  if (!robot || mainDimmed === dimmed) return;
  mainDimmed = dimmed;
  robot.joints.arm_right_1_joint?.traverse(object => {
    if (!object.isMesh) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!mainMaterials.has(material)) mainMaterials.set(material, { opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite });
      const original = mainMaterials.get(material);
      material.opacity = dimmed ? .35 : original.opacity;
      material.transparent = dimmed || original.transparent;
      material.depthWrite = dimmed ? false : original.depthWrite;
      material.needsUpdate = true;
    }
  });
}

function updateSessionScene() {
  if (!session || !trackScene) return;
  const main = focusedTrack();
  trackScene.update({ tracks: session.tracks, time: session.cursor, mainReference: main?.reference,
    visible: Boolean(main), opacity: presentationSettings.settings.ghost_opacity_percent / 100 });
  setMainDimmed(Boolean(main && !main.empty && outsideSpan(main, session.cursor)));
}
