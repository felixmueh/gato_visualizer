import { Box3, Group, Mesh, MeshBasicMaterial, OrthographicCamera, Scene, SphereGeometry, Vector3, WebGLRenderer, SRGBColorSpace, ACESFilmicToneMapping } from 'three';
import { aggregateSpan } from './expanded-timeline.js';
import { coverMaterial, coverMeshes, createArmCover, createTrackScene, trackDisplayPath } from './track-scene.js';
import { SHAPE_LISTS, createShapesGroup, shapeToWorld } from './collision-shapes.js';
import { createArmVisibility } from './arm-visibility.js';
import { createPathLine, setPathPoints, setPathPointCount } from './path-lines.js';
import { fitAuxiliaryCamera } from './auxiliary-views.js';
import { viewDirection } from './view-cube.js';
import { outsideSpan } from './session.js';

export const ANIMATION_FPS = 30;
// What an export draws besides the robots (the dialog's Show choices). Each hides one kind of
// geometry the viewport shows: obstacles and sphere covers of collision rows, the displayed
// prediction, the recorded tool paths, and the task target with its reference.
export const EXPORT_SHOW_DEFAULTS = Object.freeze({ collision: true, covers: false, prediction: true, paths: true, reference: true });

/** Live's segments with collision rows: generation to the obstacles of every shape
 * ({obstacles, capsules, boxes, planes}) and the body cover in the world (placed by the
 * segment's world_from_root), the arm cover by link and the root origin (plane patches). */
export function collisionSegmentsInWorld(segments = []) {
  const result = new Map();
  for (const { generation, collision, world_from_root: matrix } of segments) {
    if (!collision || !matrix) continue;
    const lists = Object.fromEntries(Object.entries(SHAPE_LISTS).map(([list, shape]) =>
      [list, (collision[list] || []).map(values => shapeToWorld(shape, values, matrix))]));
    result.set(generation, Object.freeze({ key: `${generation}`, lists, obstacles: lists.obstacles,
      body: (collision.body || []).map(values => shapeToWorld('sphere', values, matrix)),
      bodyCapsules: (collision.body_capsules || []).map(values => shapeToWorld('capsule', values, matrix)),
      bodyBoxes: (collision.body_boxes || []).map(values => shapeToWorld('box', values, matrix)), arm: collision.arm || {},
      reference: [matrix[0][3], matrix[1][3], matrix[2][3]] }));
  }
  return result;
}

// Regular 1/30 s samples, followed by the exact endpoint if it is off-grid.
// The final frame holds for one encoded frame; a zero-length span is one frame.
export function animationSchedule(begin, end, fps = ANIMATION_FPS) {
  if (![begin, end, fps].every(Number.isFinite) || end < begin || fps <= 0) throw new Error('Invalid animation time range.');
  const ticks = (end - begin) * fps;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(begin) * fps, Math.abs(end) * fps, ticks) * 8;
  const intervals = end === begin ? 0 : Math.max(1, Math.ceil(ticks - tolerance));
  const frameCount = intervals + 1;
  if (!Number.isSafeInteger(frameCount)) throw new Error('Animation time range is too large.');
  return Object.freeze({ begin, end, fps, frameCount,
    time(index) {
      if (!Number.isInteger(index) || index < 0 || index >= frameCount) throw new Error('Invalid animation frame index.');
      return index === frameCount - 1 ? end : begin + index / fps;
    } });
}

export function sampleAnimationHistory(samples, time, interpolate = true) {
  if (!samples?.length) return null;
  let low = 0, high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle].state.sim_time_s <= time) low = middle + 1; else high = middle;
  }
  const index = Math.max(0, low - 1), selected = samples[index];
  const left = selected.state, right = samples[index + 1]?.state;
  if (!interpolate || !right || time <= left.sim_time_s || left.settings_version !== right.settings_version) return { ...selected, index };
  const mix = Math.min(1, (time - left.sim_time_s) / (right.sim_time_s - left.sim_time_s));
  const state = { ...left, sim_time_s: time };
  for (const key of ['q', 'ee_xyz', 'target_xyz']) {
    if (Array.isArray(left[key]) && left[key].length === right[key]?.length) state[key] = left[key].map((value, i) => value + (right[key][i] - value) * mix);
  }
  return { ...selected, state, index };
}

// Own geometry/materials, including repaired URDF mimic references. Textures
// remain read-only and are never disposed by capture.
export function cloneCaptureObject(source) {
  const clone = source.clone(true), geometries = new Map(), materials = new Map(), joints = {};
  const removed = [];
  clone.traverse(object => {
    if (['limit-beyond-outline', 'planning-box-outline'].includes(object.name) || object.isTransformControlsRoot) removed.push(object);
  });
  removed.forEach(object => object.removeFromParent());
  clone.traverse(object => {
    if (object.geometry) {
      if (!geometries.has(object.geometry)) geometries.set(object.geometry, object.geometry.clone());
      object.geometry = geometries.get(object.geometry);
    }
    const copyMaterial = material => {
      if (!materials.has(material)) materials.set(material, material.clone());
      return materials.get(material);
    };
    if (object.material) object.material = Array.isArray(object.material) ? object.material.map(copyMaterial) : copyMaterial(object.material);
    if (object.isURDFJoint) joints[object.urdfName] = object;
  });
  for (const joint of Object.values(joints)) joint.mimicJoints = (joint.mimicJoints || []).map(other => joints[other?.urdfName]).filter(Boolean);
  if (source.joints) clone.joints = joints;
  return clone;
}

export function disposeCaptureScene(scene) {
  const geometries = new Set(), materials = new Set();
  scene.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material) materials.add(material);
  });
  geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
  scene.clear();
}

/** Call once, synchronously, when Export is pressed. No playback/Live methods. */
export function freezeAnimationSnapshot({ session, robot, scene, camera, cameraTarget, jointNames = [], liveHistory = [], liveState = null,
  mainReference = null, prediction = null, predictionVisible = true, predictionColor = 0x34d8d4, predictionOpacity = .95,
  ghostOpacity = .35, interpolate = true, mainMaterialStyles, liveSegments = [] } = {}) {
  if (!session || !robot || !scene || !camera) throw new Error('The scene is not ready to export.');
  const tracks = Object.freeze(session.activeTracks.filter(track => track.visible !== false).map(track => Object.freeze({
    id: track.id, kind: track.kind, motion: track.motion, span: Object.freeze([...track.span]),
    offset_s: track.kind === 'live' ? 0 : track.offset_s || 0, color: track.color,
    visible: true, display: track.display, empty: track.empty, jointNames: track.jointNames ? [...track.jointNames] : undefined,
  })));
  const span = Object.freeze(aggregateSpan(session.aggregate, session.span));
  const main = tracks.find(track => track.kind === 'live');
  if (main && !main.empty) {
    const begin = Math.max(span[0], main.span[0]), end = Math.min(span[1], main.span[1]);
    if (begin <= end && (!liveHistory.length || liveHistory[0].state.sim_time_s > begin + 1e-9 || liveHistory.at(-1).state.sim_time_s < end - 1e-9)) {
      throw new Error('The Live recording has not loaded this aggregate window yet. Wait for the history download and export again.');
    }
  }
  const captureScene = new Scene();
  captureScene.background = scene.background?.clone?.() ?? scene.background;
  captureScene.fog = scene.fog?.clone() ?? null;
  // The static scene's direct children are lights, floor, grid and axes.
  // Presentation groups and editor handles are deliberately reconstructed below.
  for (const object of scene.children) {
    if (object === robot) continue;
    if (object.isLight || ['GridHelper', 'AxesHelper'].includes(object.type) || (object.isMesh && object.geometry?.type === 'PlaneGeometry')) captureScene.add(cloneCaptureObject(object));
  }
  const captureRobot = cloneCaptureObject(robot); captureScene.add(captureRobot);
  // Restore the undimmed styles when the current cursor is outside Live.
  if (mainMaterialStyles) {
    const sourceMeshes = [], cloneMeshes = [];
    robot.joints?.arm_right_1_joint?.traverse(object => { if (object.isMesh) sourceMeshes.push(object); });
    captureRobot.joints?.arm_right_1_joint?.traverse(object => { if (object.isMesh) cloneMeshes.push(object); });
    sourceMeshes.forEach((mesh, index) => {
      const originals = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const copies = Array.isArray(cloneMeshes[index]?.material) ? cloneMeshes[index].material : [cloneMeshes[index]?.material];
      originals.forEach((material, i) => { if (copies[i] && mainMaterialStyles.has(material)) Object.assign(copies[i], mainMaterialStyles.get(material)); });
    });
  }
  return Object.freeze({ tracks, span, replayOnly: session.replayOnly,
    scene: captureScene, robot: captureRobot, camera: camera.clone(), cameraTarget: cameraTarget?.clone?.() ?? new Vector3(0, 0, .8),
    jointNames: Object.freeze([...jointNames]), liveHistory: Object.freeze(liveHistory.map(({ state, plan }) => Object.freeze({ state, plan }))),
    liveState, livePlan: session.track?.('live')?.plan ?? null, mainReference, prediction,
    liveCollision: collisionSegmentsInWorld(liveSegments),
    predictionVisible: Boolean(predictionVisible), predictionColor, predictionOpacity, ghostOpacity, interpolate });
}

export function animationLayout(width, height, views = 'main') {
  if (views === 'main') return [{ name: 'main', x: 0, y: 0, width, height }];
  const mainWidth = Math.floor(width * 2 / 3), rightWidth = width - mainWidth, half = Math.floor(height / 2);
  return [{ name: 'main', x: 0, y: 0, width: mainWidth, height },
    { name: 'top', x: mainWidth, y: height - half, width: rightWidth, height: half },
    { name: 'right', x: mainWidth, y: 0, width: rightWidth, height: height - half }];
}

export function letterboxViewport(viewport, aspect) {
  let width = viewport.width, height = viewport.height;
  if (width / height > aspect) width = Math.round(height * aspect); else height = Math.round(width / aspect);
  return { ...viewport, x: viewport.x + Math.floor((viewport.width - width) / 2), y: viewport.y + Math.floor((viewport.height - height) / 2), width, height };
}

export function createAnimationCapture(snapshot, options, { rendererFactory = settings => new WebGLRenderer(settings) } = {}) {
  const { width, height, views = 'main', orientation = 'current' } = options;
  const show = { ...EXPORT_SHOW_DEFAULTS, ...options.show };
  const { scene, robot } = snapshot;
  const tracks = createTrackScene({ robot, scene, jointNames: snapshot.jointNames });
  const arm = createArmVisibility(robot);
  const main = snapshot.tracks.find(track => track.kind === 'live');
  // Normalize layers even if the source arm was hidden in Replay.
  robot.joints?.arm_right_1_joint?.traverse(object => object.layers.set(0));
  arm.setVisible(Boolean(!snapshot.replayOnly && main && main.display !== 'hidden'));
  const traceSamples = snapshot.liveHistory.map((sample, index) => ({ point: sample.state.ee_xyz, index })).filter(sample => sample.point);
  const traceIndices = trackDisplayPath(traceSamples).map(sample => sample.index);
  const tracePoints = traceIndices.map(index => snapshot.liveHistory[index].state.ee_xyz);
  const trace = createPathLine(tracePoints, { color: 0xffffff, name: 'export-live-trace' }); scene.add(trace);
  const prediction = createPathLine([], { color: snapshot.predictionColor, opacity: snapshot.predictionOpacity, name: 'export-prediction' }); scene.add(prediction);
  const reference = createPathLine(snapshot.mainReference?.points || [], { color: 0xffb547, dashed: true, name: 'export-reference' }); scene.add(reference);
  const marker = new Mesh(new SphereGeometry(.011, 16, 12), new MeshBasicMaterial({ color: 0xffffff, depthTest: false })); scene.add(marker);
  const target = new Mesh(new SphereGeometry(.022, 16, 12), new MeshBasicMaterial({ color: 0xffb547, wireframe: true, depthTest: false })); scene.add(target);
  // Live's collision objects at each frame: the obstacles (and covers) of that frame's segment.
  const collision = new Group(); collision.name = 'export-live-collision'; scene.add(collision);
  const liveCollision = snapshot.liveCollision || new Map(), lastSegment = [...liveCollision.keys()].at(-1);
  let collisionKey, armCover = null;
  function showCollision(segment, shown) {
    const key = shown && segment && (show.collision || show.covers) ? segment.key : null;
    if (key !== collisionKey) {
      collisionKey = key; armCover = null;
      collision.children.slice().forEach(object => { object.traverse(item => { item.geometry?.dispose(); item.material?.dispose?.(); }); object.removeFromParent(); });
      if (key) {
        if (show.collision && Object.values(segment.lists).some(list => list.length)) {
          collision.add(createShapesGroup(segment.lists, { name: 'export-obstacles', reference: segment.reference }));
        }
        if (show.covers && (segment.body.length || segment.bodyCapsules.length || segment.bodyBoxes.length)) {
          collision.add(coverMeshes({ spheres: segment.body, capsules: segment.bodyCapsules, boxes: segment.bodyBoxes },
            coverMaterial(), 'export-body-cover'));
        }
        if (show.covers && robot.joints?.arm_right_1_joint) { armCover = createArmCover(robot, segment.arm); collision.add(armCover.holder); }
      }
    }
    if (armCover) {
      // The arm cover follows the exported Live arm.
      robot.joints.arm_right_1_joint.parent.updateWorldMatrix(true, false);
      armCover.holder.matrix.copy(robot.joints.arm_right_1_joint.parent.matrixWorld);
      for (const name of snapshot.jointNames) armCover.joints.get(name)?.setJointValue(robot.joints[name]?.angle ?? 0);
    }
  }
  const armStyles = new Map();
  robot.joints?.arm_right_1_joint?.traverse(object => {
    if (!object.isMesh) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) armStyles.set(material, { opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite });
  });
  let previousPrediction, disposed = false;
  function update(time) {
    tracks.update({ tracks: snapshot.tracks, time, mainReference: snapshot.replayOnly ? null : snapshot.mainReference, opacity: snapshot.ghostOpacity,
      covers: show.covers, layers: { obstacles: show.collision, paths: show.paths, references: show.reference } });
    const selected = sampleAnimationHistory(snapshot.liveHistory, time, snapshot.interpolate);
    const state = selected?.state || snapshot.liveState;
    const shown = Boolean(main && !snapshot.replayOnly);
    if (shown && state?.q) snapshot.jointNames.forEach((name, i) => robot.joints[name]?.setJointValue(state.q[i]));
    const dimmed = main && !main.empty && outsideSpan(main, time);
    armStyles.forEach((original, material) => Object.assign(material, dimmed ? { opacity: .35, transparent: true, depthWrite: false } : original));
    let low = 0, high = traceIndices.length;
    while (low < high) { const middle = (low + high) >>> 1; if (traceIndices[middle] <= (selected?.index ?? -1)) low = middle + 1; else high = middle; }
    setPathPointCount(trace, low);
    trace.visible = show.paths && shown && !state?.start_pose_draft && trace.geometry.instanceCount > 0;
    marker.visible = shown && Boolean(state?.ee_xyz) && !state?.start_pose_draft;
    if (marker.visible) marker.position.fromArray(state.ee_xyz);
    reference.visible = show.reference && shown && reference.userData.path.segmentCount > 0;
    const targetPoint = state?.target_xyz || snapshot.mainReference?.target_xyz;
    target.visible = show.reference && shown && Boolean(targetPoint);
    if (target.visible) target.position.fromArray(targetPoint);
    const plan = snapshot.prediction || (shown ? (selected ? selected.plan : snapshot.livePlan) : null);
    if (plan !== previousPrediction) { setPathPoints(prediction, plan?.ee_xyz || []); previousPrediction = plan; }
    prediction.visible = show.prediction && snapshot.predictionVisible && Boolean(plan?.ee_xyz?.length > 1);
    scene.updateMatrixWorld(true);
    showCollision(liveCollision.get(selected?.state?.generation ?? lastSegment), shown);
    scene.updateMatrixWorld(true);
  }
  update(snapshot.span[0]);
  const bounds = new Box3().setFromObject(robot).union(tracks.bounds);
  if (!snapshot.replayOnly && main) {
    for (const point of tracePoints) bounds.expandByPoint(new Vector3(...point));
    for (const point of snapshot.mainReference?.points || []) bounds.expandByPoint(new Vector3(...point));
    if (snapshot.predictionVisible) for (const plan of new Set(snapshot.liveHistory.map(sample => sample.plan))) {
      for (const point of plan?.ee_xyz || []) bounds.expandByPoint(new Vector3(...point));
    }
  }
  if (snapshot.predictionVisible) for (const point of snapshot.prediction?.ee_xyz || []) bounds.expandByPoint(new Vector3(...point));
  update(snapshot.span[1]); bounds.union(new Box3().setFromObject(robot)).union(tracks.bounds);
  if (show.collision && !snapshot.replayOnly && main) for (const segment of liveCollision.values()) {
    const shapes = createShapesGroup({ ...segment.lists, planes: [] });  // a plane is unbounded: no fitting extent
    bounds.union(new Box3().setFromObject(shapes)); disposeCaptureScene(shapes);
  }
  const cameras = animationLayout(width, height, views).map(viewport => {
    if (viewport.name === 'main') {
      const camera = snapshot.camera;
      if (orientation === 'current') return { camera, viewport: letterboxViewport(viewport, camera.aspect || (camera.right - camera.left) / (camera.top - camera.bottom)) };
      const direction = viewDirection(orientation === 'isometric' ? 'front-right-top' : orientation);
      const target = snapshot.cameraTarget;
      const distance = Math.max(.3, camera.position.distanceTo(target));
      camera.position.copy(target).addScaledVector(direction, distance);
      camera.up.set(0, 0, 1); camera.lookAt(target);
      if (camera.isPerspectiveCamera) camera.aspect = viewport.width / viewport.height;
      camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      return { camera, viewport };
    }
    const camera = new OrthographicCamera(); camera.userData.view = viewport.name;
    fitAuxiliaryCamera(camera, bounds, viewport.width / viewport.height);
    return { camera, viewport };
  });
  let renderer;
  try {
    renderer = rendererFactory({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(1); renderer.setSize(width, height, false);
    renderer.outputColorSpace = SRGBColorSpace; renderer.toneMapping = ACESFilmicToneMapping;
    renderer.autoClear = false;
  } catch (error) { tracks.dispose(); disposeCaptureScene(scene); renderer?.dispose(); throw error; }
  return {
    scene, cameras,
    async frame(time, signal) {
      checkAbort(signal); update(time);
      renderer.setScissorTest(false); renderer.setViewport(0, 0, width, height); renderer.setClearColor(0x080d15, 1); renderer.clear();
      renderer.setScissorTest(true);
      for (const { camera, viewport: v } of cameras) {
        renderer.setViewport(v.x, v.y, v.width, v.height); renderer.setScissor(v.x, v.y, v.width, v.height);
        tracks.sort(camera); renderer.render(scene, camera);
      }
      const blob = await new Promise((resolve, reject) => renderer.domElement.toBlob(value => value ? resolve(value) : reject(new Error('Could not capture an animation frame.')), 'image/png'));
      checkAbort(signal); return blob;
    },
    dispose() { if (disposed) return; disposed = true; tracks.dispose(); disposeCaptureScene(scene); renderer.dispose(); renderer.forceContextLoss?.(); },
  };
}

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Animation export canceled.', 'AbortError');
}

/** One PNG in flight: rendering cannot overtake the encoder's HTTP backpressure. */
export async function exportAnimation({ snapshot, options, signal, onProgress = () => {}, fetchImpl = globalThis.fetch, createCapture = createAnimationCapture }) {
  let capture, id, handedOff = false;
  let schedule;
  async function request(path, init) {
    const response = await fetchImpl(`/api/animation-export/${path}`, { ...init, signal });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `Animation export failed (${response.status}).`);
    }
    return response;
  }
  try {
    checkAbort(signal);
    schedule = animationSchedule(...snapshot.span);
    const started = await (await request('start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width: options.width, height: options.height, fps: schedule.fps, frame_count: schedule.frameCount }) })).json();
    id = started.id; checkAbort(signal);
    capture = createCapture(snapshot, options);
    for (let index = 0; index < schedule.frameCount; index++) {
      checkAbort(signal);
      const png = await capture.frame(schedule.time(index), signal); checkAbort(signal);
      await request(`frame?id=${encodeURIComponent(id)}&index=${index}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
      onProgress({ progress: (index + 1) / schedule.frameCount, message: `Rendering ${index + 1} / ${schedule.frameCount}` });
    }
    checkAbort(signal); onProgress({ progress: 1, message: 'Finishing MP4…' });
    const result = await (await request(`finish?id=${encodeURIComponent(id)}`, { method: 'POST' })).json();
    checkAbort(signal); handedOff = true;
    return { ...result, frame_count: schedule.frameCount };
  } finally {
    capture?.dispose();
    if (!capture) disposeCaptureScene(snapshot.scene);
    if (id && !handedOff) await fetchImpl(`/api/animation-export/cancel?id=${encodeURIComponent(id)}`, { method: 'POST' }).catch(() => {});
  }
}
