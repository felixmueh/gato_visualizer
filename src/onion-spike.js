import { Vector3 } from 'three';
import { createFloatingDialog } from './floating-dialog.js';
import { createGhostArms } from './ghost-arm.js';

const STORAGE_KEY = 'motion-studio-onion-spike-result';
const SETTLE_MS = 500, MEASURE_MS = 5000, OPACITY = .35, ORBIT_RADIANS_PER_SECOND = .22;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { mean: mean(values), min: sorted[0] ?? null, max: sorted.at(-1) ?? null,
    p50: sorted[Math.floor((sorted.length - 1) * .5)] ?? null, p95: sorted[Math.floor((sorted.length - 1) * .95)] ?? null };
}

// An opt-in measurement tool, loaded only for ?onion-spike. The caller invokes
// frame after rendering (including auxiliary views), and beforeRender per camera.
export function setupOnionSpike({ renderer, scene, camera, controls, robot, getTrajectory, getJointNames, auxiliaryViews, setNormalVisible = () => {} }) {
  const body = document.createElement('div');
  const description = document.createElement('p');
  description.textContent = 'Pause Replay on a recording, then start. Measures 12 cases (about 66 s) while orbiting automatically. Keep this tab visible. Download the report and screenshots when complete.';
  const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
  const start = document.createElement('button'); start.textContent = 'Start';
  const cancel = document.createElement('button'); cancel.textContent = 'Stop'; cancel.disabled = true;
  const download = document.createElement('button'); download.textContent = 'Download JSON'; download.disabled = true;
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Ready';
  const output = document.createElement('pre'); output.style.cssText = 'white-space:pre-wrap;font-size:10px;line-height:1.5';
  const images = document.createElement('div'); images.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
  actions.append(start, cancel, download); body.append(description, actions, status, output, images);
  const dialog = createFloatingDialog({ id: 'onion-spike', title: 'Onion skin · laptop measurement', content: body, onClose: () => stop('Dialog closed') });
  dialog.element.style.cssText = 'width:min(440px,calc(100vw - 32px));left:16px;top:70px;max-height:65vh';
  dialog.open();

  let pool = null, running = false, source = null, result = null, saved = null;
  let queue = [], current = null, previousNow = null, caseStart = 0, lastStatusSecond = -1, originalOffset;
  let screenshots = [], sequence = 0;
  const environment = () => {
    const gl = renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info');
    return { userAgent: navigator.userAgent, platform: navigator.platform, url: location.href,
      screen: { width: screen.width, height: screen.height }, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      canvas: { width: renderer.domElement.width, height: renderer.domElement.height },
      webgl: { version: gl.getParameter(gl.VERSION), renderer: gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
        vendor: gl.getParameter(extension?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR) } };
  };
  function setViews(visible) {
    if (document.getElementById('right-sidebar')?.hidden) document.getElementById('right-sidebar-toggle')?.click();
    document.getElementById(`inspection-tab-${visible ? 'views' : 'episode'}`)?.click();
    auxiliaryViews?.invalidate();
  }
  function restore() {
    pool?.dispose(); pool = null; setNormalVisible(true);
    if (!saved) return;
    camera.position.copy(saved.position); camera.quaternion.copy(saved.quaternion); camera.up.copy(saved.up); camera.zoom = saved.zoom; camera.updateProjectionMatrix();
    controls.target.copy(saved.target); controls.enabled = saved.controlsEnabled; controls.update();
    document.getElementById(saved.tab)?.click();
    if (document.getElementById('right-sidebar')?.hidden !== saved.sidebarHidden) document.getElementById('right-sidebar-toggle')?.click();
    saved = null;
  }
  function persist() {
    result.screenshots = screenshots.map(({ filename, error }) => ({ filename, ...(error ? { error } : {}) }));
    result.storageSaved = true;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(result)); }
    catch { result.storageSaved = false; }
    download.disabled = false;
  }
  function decide() {
    const find = (method, visible) => result.cases.find(item => item.method === method && item.count === 8 && item.viewsVisible === visible)?.frameIntervalMs.mean;
    const plain = find('plain', true), prepass = find('prepass', true);
    if (plain == null || prepass == null || !result.complete) return { method: null, includeAuxiliary: false, passed: false, reason: 'No decision: measurements are incomplete.' };
    const method = prepass <= 20 ? 'prepass' : 'flat';
    const visible = find(method === 'flat' ? 'plain' : method, true), hidden = find(method === 'flat' ? 'plain' : method, false);
    const auxiliaryExtraMs = hidden == null ? null : visible - hidden;
    return { method: plain > 20 ? null : method, passed: plain <= 20,
      includeAuxiliary: auxiliaryExtraMs != null && auxiliaryExtraMs <= 5, auxiliaryExtraMs,
      reason: plain > 20 ? 'Stop and report: plain transparency at 8 arms with Views exceeds 20 ms.'
        : `Use ${method === 'prepass' ? 'depth pre-pass' : 'flat fallback (fallback frame time not measured)'}. ${auxiliaryExtraMs > 5 ? 'Omit ghosts from Top/Right views.' : 'Keep ghosts in Top/Right views.'}` };
  }
  function finish(reason) {
    if (!running) return;
    running = false; start.disabled = false; cancel.disabled = true;
    result.finishedAt = new Date().toISOString(); result.complete = !reason; result.stopReason = reason ?? null;
    result.decision = decide(); restore(); persist();
    status.textContent = reason ? `Stopped: ${reason}` : 'Complete · download JSON and screenshots';
    const rows = result.cases.map(item => `${item.method.padEnd(7)} ${String(item.count).padStart(2)} · Views ${item.viewsVisible ? 'on ' : 'off'} · ${item.frameIntervalMs.mean?.toFixed(2)} ms · ${item.mainCalls.mean?.toFixed(0)} calls · ${item.mainTriangles.mean?.toFixed(0)} triangles`);
    output.textContent = `${rows.join('\n')}\n\n${result.decision.reason}`;
  }
  function stop(reason) { if (running) finish(reason); }
  function samplePoses(count) {
    const times = source.time_s, names = getJointNames(), last = times.length - 1;
    return Array.from({ length: count }, (_, index) => {
      const requested = times[0] + (times[last] - times[0]) * index / Math.max(1, count - 1);
      let low = 0, high = last;
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (times[mid] <= requested) low = mid; else high = mid - 1; }
      return { id: index, q: source.q[low], jointNames: names, time: times[low], opacity: OPACITY };
    });
  }
  function beginCase(now) {
    if (!queue.length) { finish(); return; }
    const spec = queue.shift();
    pool?.dispose(); pool = createGhostArms({ robot, scene, max: 24, method: spec.method }); pool.setBase(); pool.set(samplePoses(spec.count));
    setViews(spec.viewsVisible);
    current = { ...spec, samples: [], ghostGeometry: pool.snapshot, auxiliaryStart: auxiliaryViews?.snapshot.frames ?? 0 };
    caseStart = now; previousNow = null; lastStatusSecond = -1;
    camera.position.copy(saved.position); camera.quaternion.copy(saved.quaternion); controls.target.copy(saved.target); camera.updateMatrixWorld();
  }
  function captureScreenshots() {
    for (const [view, scale] of [['default', 1], ['closeup', .55]]) {
      const filename = `onion-spike-${result.id}-${current.method}-8-${view}.png`;
      try {
        camera.position.copy(saved.target).addScaledVector(originalOffset, scale); camera.lookAt(saved.target); camera.updateMatrixWorld();
        pool.update(camera); renderer.render(scene, camera);
        const url = renderer.domElement.toDataURL('image/png');
        screenshots.push({ filename, url });
        const link = document.createElement('a'); link.textContent = `${current.method} · ${view}`; link.href = url; link.download = filename; images.append(link);
      } catch (error) { screenshots.push({ filename, error: error.message }); }
    }
  }
  start.addEventListener('click', () => {
    source = getTrajectory();
    if (!source?.time_s?.length || !source.q?.length || !getJointNames()?.length) { status.textContent = 'Select a Replay recording first.'; return; }
    if (document.hidden) { status.textContent = 'Keep this tab visible before starting.'; return; }
    screenshots = []; images.replaceChildren(); output.textContent = ''; download.disabled = true;
    saved = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), up: camera.up.clone(), target: controls.target.clone(), zoom: camera.zoom,
      controlsEnabled: controls.enabled, sidebarHidden: Boolean(document.getElementById('right-sidebar')?.hidden),
      tab: document.querySelector('.inspection-tabs [aria-selected="true"]')?.id ?? 'inspection-tab-views' };
    originalOffset = saved.position.clone().sub(saved.target);
    controls.enabled = false; setNormalVisible(false);
    queue = ['plain', 'prepass'].flatMap(method => [8, 16, 24].flatMap(count => [false, true].map(viewsVisible => ({ method, count, viewsVisible }))));
    result = { version: 1, id: `${Date.now()}-${++sequence}`, startedAt: new Date().toISOString(), environment: environment(),
      source: { id: source.id ?? null, label: source.label ?? null, kind: source.kind ?? null, samples: source.time_s.length, bounds: [source.time_s[0], source.time_s.at(-1)] },
      protocol: { settleMs: SETTLE_MS, measureMs: MEASURE_MS, opacity: OPACITY, orbitRadiansPerSecond: ORBIT_RADIANS_PER_SECOND,
        sampleSelection: 'Even absolute time spacing, recorded sample at or before; duplicates retained.',
        frameTiming: 'performance.now() after main and auxiliary rendering; consecutive complete browser frame intervals, no filtering.',
        auxiliaryTiming: 'Auxiliary views retain their normal 30 Hz cap; calls and triangles counted only when auxiliary frames advance.',
        fallback: 'Flat fallback is selected by the handoff rule; only plain and prepass are measured here.' },
      camera: { position: saved.position.toArray(), target: saved.target.toArray(), up: saved.up.toArray() }, cases: [] };
    running = true; start.disabled = true; cancel.disabled = false; beginCase(performance.now());
  });
  cancel.addEventListener('click', () => stop('Stopped by viewer'));
  download.addEventListener('click', () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `onion-spike-${result.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop('Tab became hidden; partial measurements retained'); });
  return {
    beforeRender(viewCamera) { if (running) pool?.update(viewCamera); },
    frame(timestamp) {
      if (!running) return;
      if (getTrajectory() !== source) { stop('Selected recording changed'); return; }
      const now = performance.now(), elapsed = now - caseStart;
      const aux = auxiliaryViews?.snapshot;
      if (previousNow != null && elapsed >= SETTLE_MS) {
        const auxiliaryRendered = (aux?.frames ?? 0) !== current.lastAuxiliaryFrame;
        current.samples.push({ timestamp, atMs: now, intervalMs: now - previousNow, mainCalls: renderer.info.render.calls, mainTriangles: renderer.info.render.triangles,
          auxiliaryRendered, auxiliaryCalls: auxiliaryRendered ? (aux?.views ?? []).reduce((sum, view) => sum + view.calls, 0) : 0,
          auxiliaryTriangles: auxiliaryRendered ? (aux?.views ?? []).reduce((sum, view) => sum + view.triangles, 0) : 0 });
      }
      current.lastAuxiliaryFrame = aux?.frames ?? 0; previousNow = now;
      if (elapsed >= SETTLE_MS + MEASURE_MS) {
        const samples = current.samples;
        result.cases.push({ method: current.method, count: current.count, viewsVisible: current.viewsVisible, measuredDurationMs: elapsed - SETTLE_MS,
          frameCount: samples.length, frameIntervalMs: statistics(samples.map(item => item.intervalMs)), mainCalls: statistics(samples.map(item => item.mainCalls)),
          mainTriangles: statistics(samples.map(item => item.mainTriangles)), auxiliaryCallsPerMainFrame: statistics(samples.map(item => item.auxiliaryCalls)),
          auxiliaryTrianglesPerMainFrame: statistics(samples.map(item => item.auxiliaryTriangles)), auxiliaryFrames: (aux?.frames ?? 0) - current.auxiliaryStart,
          auxiliarySnapshot: aux ?? null, ghostGeometry: current.ghostGeometry, samples });
        if (current.count === 8 && current.viewsVisible) captureScreenshots();
        beginCase(performance.now()); return;
      }
      const second = Math.floor(elapsed / 1000);
      if (second !== lastStatusSecond) {
        lastStatusSecond = second;
        status.textContent = `${result.cases.length + 1}/12 · ${current.method} · ${current.count} arms · Views ${current.viewsVisible ? 'on' : 'off'} · ${Math.max(0, Math.ceil((SETTLE_MS + MEASURE_MS - elapsed) / 1000))} s`;
      }
      const offset = originalOffset.clone().applyAxisAngle(new Vector3(0, 0, 1), elapsed / 1000 * ORBIT_RADIANS_PER_SECOND);
      camera.position.copy(saved.target).add(offset); camera.lookAt(saved.target); camera.updateMatrixWorld(); pool.update(camera);
    },
    get snapshot() { return { running, case: current ? { method: current.method, count: current.count, viewsVisible: current.viewsVisible } : null, result }; },
  };
}
