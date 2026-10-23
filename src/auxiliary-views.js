import { Box3, OrthographicCamera, Vector3, WebGLRenderer, SRGBColorSpace, ACESFilmicToneMapping } from 'three';

export function fitAuxiliaryCamera(camera, bounds, aspect, { padding = 1.18 } = {}) {
  if (!bounds || bounds.isEmpty() || !Number.isFinite(aspect) || aspect <= 0) return false;
  const center = bounds.getCenter(new Vector3()), size = bounds.getSize(new Vector3());
  const distance = Math.max(3, size.length() * 2);
  const direction = camera.userData.view === 'top' ? new Vector3(0, 0, 1) : new Vector3(0, -1, 0);
  camera.up.set(0, camera.userData.view === 'top' ? 1 : 0, camera.userData.view === 'top' ? 0 : 1);
  camera.position.copy(center).addScaledVector(direction, distance); camera.lookAt(center);
  const inverse = camera.quaternion.clone().invert();
  let halfWidth = .1, halfHeight = .1;
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const local = new Vector3(x, y, z).sub(center).applyQuaternion(inverse);
    halfWidth = Math.max(halfWidth, Math.abs(local.x) * padding); halfHeight = Math.max(halfHeight, Math.abs(local.y) * padding);
  }
  halfHeight = Math.max(halfHeight, halfWidth / aspect); halfWidth = halfHeight * aspect;
  camera.left = -halfWidth; camera.right = halfWidth; camera.top = halfHeight; camera.bottom = -halfHeight;
  camera.near = .001; camera.far = Math.max(100, distance + size.length() * 2); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  return true;
}

// Render the exact displayed scene through two independent cameras. There is
// one robot hierarchy, one simulation/playback clock, and no duplicate solver.
export function setupAuxiliaryViews({ scene, top, right, getBounds, visible = () => true, beforeRender = () => {} }) {
  let dirty = true, previousFrame = -Infinity, frames = 0;
  const views = [top, right].map((container, i) => {
    const name = i === 0 ? 'top' : 'right';
    const camera = new OrthographicCamera(-1, 1, 1, -1, .001, 100); camera.userData.view = name;
    const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.domElement.setAttribute('aria-label', `${name === 'top' ? 'Top' : 'Right'} view of the displayed robot and trajectory`);
    container.prepend(renderer.domElement);
    const observer = new ResizeObserver(() => { dirty = true; }); observer.observe(container);
    return { name, container, camera, renderer, observer, width: 0, height: 0 };
  });
  return {
    invalidate() { dirty = true; },
    render(timestamp) {
      if (!visible() || timestamp - previousFrame < 1000 / 30) return;
      previousFrame = timestamp;
      const bounds = dirty ? getBounds() : null;
      for (const view of views) {
        const width = view.container.clientWidth, height = view.container.clientHeight;
        if (!width || !height) continue;
        if (width !== view.width || height !== view.height) { view.renderer.setSize(width, height); view.width = width; view.height = height; dirty = true; }
        if (dirty) fitAuxiliaryCamera(view.camera, bounds || getBounds(), width / height);
        beforeRender(view.camera);
        view.renderer.render(scene, view.camera);
      }
      dirty = false; frames++;
    },
    get snapshot() { return { frames, visible: visible(), views: views.map(view => ({ name: view.name, width: view.width, height: view.height, calls: view.renderer.info.render.calls, triangles: view.renderer.info.render.triangles, quaternion: view.camera.quaternion.toArray(), position: view.camera.position.toArray() })) }; },
    dispose() { for (const view of views) { view.observer.disconnect(); view.renderer.dispose(); view.renderer.domElement.remove(); } },
  };
}

export function visibleSceneBounds(robot, path) {
  const bounds = new Box3().setFromObject(robot);
  if (path?.visible) bounds.union(new Box3().setFromObject(path));
  return bounds;
}
