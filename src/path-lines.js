import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// Line2's installed onBeforeRender reads renderer.getViewport(), in CSS pixels.
// Keep that callback intact: its automatic resolution update follows viewport
// resizing and renderer pixel-ratio changes without scaling these widths twice.
export function createPathLine(points, { color, dashed = false, width = dashed ? 2.5 : 3,
  opacity = .95, renderOrder = dashed ? 3 : 4, name = 'path' } = {}) {
  const material = new LineMaterial({ color, linewidth: width, worldUnits: false,
    dashed, dashSize: .016, gapSize: .01, depthTest: false, depthWrite: false,
    transparent: true, opacity, toneMapped: false, alphaToCoverage: true });
  const line = new Line2(new LineGeometry(), material);
  line.name = name;
  line.renderOrder = renderOrder;
  setPathPoints(line, points);
  return line;
}

export function setPathPoints(line, points) {
  const positions = [];
  const segmentsAtPoint = [];
  let previous;
  let segments = 0;
  for (const point of points) {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) {
      throw new Error('A path needs finite three-dimensional points.');
    }
    const vertex = point.map(Math.fround);
    if (!vertex.every(Number.isFinite)) throw new Error('Path points exceed display coordinate range.');
    // Zero-length segments have no useful direction for the wide-line shader.
    // Preserve a source-point map so replay progress still uses recorded indices.
    if (!previous || vertex.some((value, i) => value !== previous[i])) {
      positions.push(...vertex);
      if (previous) segments++;
      previous = vertex;
    }
    segmentsAtPoint.push(segments);
  }
  // LineGeometry requires at least two vertices. Hidden finite placeholders
  // avoid invalid bounds for empty/single-point traces, and never draw at origin.
  if (positions.length < 6) {
    const point = positions.length ? positions : [0, 0, 0];
    positions.splice(0, positions.length, ...point, ...point);
  }
  const geometry = new LineGeometry();
  geometry.setPositions(positions);
  const previousGeometry = line.geometry;
  line.geometry = geometry;
  previousGeometry?.dispose();
  line.userData.path = { pointCount: points.length, segmentsAtPoint, segmentCount: segments };
  if (line.material.dashed) line.computeLineDistances();
  setPathPointCount(line, points.length);
}

export function setPathPointCount(line, pointCount) {
  const info = line.userData.path;
  const count = Math.max(0, Math.min(info.pointCount, Math.floor(pointCount)));
  const segments = count ? info.segmentsAtPoint[count - 1] : 0;
  line.geometry.instanceCount = segments;
  line.visible = segments > 0;
}

export function pathLineInfo(line) {
  return { name: line.name, width: line.material.linewidth, dashed: line.material.dashed,
    segments: line.geometry.instanceCount, visible: line.visible,
    points: line.userData.path.pointCount, resolution: line.material.resolution.toArray() };
}
