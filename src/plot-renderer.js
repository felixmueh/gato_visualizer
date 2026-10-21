/** Shared dependency-free renderer for the application and standalone previews.
 * Plot data and aggregates are supplied by Python. Scaling, gaps, hover and
 * cursor markers here are presentation only.
 */
export function renderPlot(container, spec, options = {}) {
  options = { ...options, presentation: options.presentation || {} };
  const presentation = options.presentation;
  let animationFrame;
  spec = { ...spec, x_axis: spec.x, y_axis: spec.y };
  const doc = container.ownerDocument || document;
  const el = (tag, text, cls) => { const node = doc.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const fmt = value => Number.isFinite(value) ? Number(value.toPrecision(5)).toString() : 'unavailable';
  const root = el('div', null, 'plot-renderer');
  if (spec.title && !options.compact && !options.hideTitle) root.append(el('h3', spec.title));
  for (const message of [...(spec.notes || []), ...(spec.message && spec.kind !== 'unavailable' ? [spec.message] : [])]) root.append(el('p', typeof message === 'string' ? message : message.message, 'plot-message'));
  if (spec.kind === 'table') {
    const table = el('table'); const head = el('tr');
    for (const column of spec.columns || ['Quantity', 'Value', 'Unit', 'Note']) head.append(el('th', typeof column === 'string' ? column : column.label));
    table.append(head);
    for (const row of spec.rows || []) {
      const tr = el('tr');
      for (const value of Array.isArray(row) ? row : [row.label, row.value, row.unit || '', row.note || '']) tr.append(el('td', value == null ? 'unavailable' : typeof value === 'number' ? fmt(value) : value));
      table.append(tr);
    }
    root.append(table); container.replaceChildren(root); return makeHandle();
  }
  if (!['lines', 'bars', 'spans'].includes(spec.kind)) {
    root.append(el('p', spec.kind === 'unavailable' ? (spec.message || 'No recorded values available.') : `Unsupported plot kind: ${spec.kind}`, 'plot-message')); container.replaceChildren(root); return makeHandle();
  }
  const categories = spec.x?.identity === 'category' ? [...new Set((spec.series || []).flatMap(line => line.x || []))] : null;
  const series = categories ? (spec.series || []).map(line => ({ ...line, x: (line.x || []).map(value => categories.indexOf(value)) })) : spec.series || [], points = series.flatMap(line => (line.x || []).map((x, i) => [x, line.y?.[i]]));
  const valid = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (!valid.length && spec.kind !== 'spans') root.append(el('p', spec.empty_message || 'No recorded values available.', 'plot-message'));
  const extent = values => { const min = values.reduce((a, b) => Math.min(a, b), Infinity), max = values.reduce((a, b) => Math.max(a, b), -Infinity); return min === max ? [min - Math.max(Math.abs(min) * .05, .01), max + Math.max(Math.abs(max) * .05, .01)] : [min, max]; };
  const finiteX = [...series.flatMap(line => [...(line.x || []), ...(line.bin_edges || [])]), ...(spec.spans || []).flatMap(span => [span.start, span.end])].filter(Number.isFinite);
  const requestedX = options.window || (categories?.length ? [-.5, categories.length - .5] : null) || spec.x_axis?.range || (finiteX.length ? extent(finiteX) : [0, 1]);
  const xRange = requestedX[0] === requestedX[1] ? [requestedX[0], requestedX[0] + .001] : requestedX;
  const visible = valid.filter(([x]) => x >= xRange[0] && x <= xRange[1]);
  const guideValues = (spec.guides || []).filter(guide => guide.axis === 'y' && Number.isFinite(guide.value)).map(guide => guide.value);
  const lanes = [...new Set((spec.spans || []).map(span => span.lane))];
  const yValues = [...(visible.length ? visible : valid).map(p => p[1]), ...guideValues, ...(spec.kind === 'bars' ? [0] : [])];
  const explicitY = spec.kind === 'spans' ? [0, Math.max(1, lanes.length)] : spec.y_axis?.range;
  const measuredY = yValues.length ? extent(yValues) : [0, 1];
  const rangeKey = JSON.stringify([options.fitKey, spec.y, spec.kind]);
  const resetFit = presentation.rangeKey !== rangeKey;
  presentation.rangeKey = rangeKey;
  const padded = ([low, high]) => { const pad = (high - low) * .12; return [low - pad, high + pad]; };
  const previousRange = resetFit ? null : presentation.targetRange;
  // Keep an envelope while history grows. Small fluctuations inside its
  // headroom do not move the axis; a deliberate range/source change refits it.
  let targetRange = explicitY || previousRange || padded(measuredY);
  if (!explicitY && previousRange && (measuredY[0] < previousRange[0] || measuredY[1] > previousRange[1])) {
    targetRange = padded([Math.min(previousRange[0], measuredY[0]), Math.max(previousRange[1], measuredY[1])]);
  }
  presentation.targetRange = targetRange;
  let yRange = explicitY || resetFit || !presentation.currentRange ? [...targetRange] : [...presentation.currentRange];
  presentation.currentRange = yRange;
  // Use display pixels so text stays legible in a narrow inspector. Observe
  // visibility/layout changes too: plots may first render inside a hidden tab.
  const width = Math.max(220, Math.round(container.clientWidth || 600)), height = options.compact ? 115 : 200;
  // Linked timeline plots use the full width. Their ruler is the timeline's.
  const margin = options.linked ? { left: 0, right: 0, top: 10, bottom: 20 } : { left: 62, right: 12, top: 12, bottom: 38 };
  const innerWidth = width - margin.left - margin.right, innerHeight = height - margin.top - margin.bottom;
  const sx = x => margin.left + (x - xRange[0]) / (xRange[1] - xRange[0] || 1) * innerWidth;
  const sy = y => height - margin.bottom - (y - yRange[0]) / (yRange[1] - yRange[0] || 1) * innerHeight;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', spec.title || 'Recorded plot');
  const scaled = [];
  const node = (tag, attributes, text) => {
    const item = doc.createElementNS(ns, tag);
    const draw = () => { for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, typeof value === 'function' ? value() : value); if (text != null) item.textContent = String(typeof text === 'function' ? text() : text); };
    draw(); if (Object.values(attributes).some(value => typeof value === 'function') || typeof text === 'function') scaled.push(draw);
    svg.append(item); return item;
  };
  const clipId = `plot-clip-${Math.random().toString(36).slice(2)}`;
  const defs = doc.createElementNS(ns, 'defs'), clip = doc.createElementNS(ns, 'clipPath'), rect = doc.createElementNS(ns, 'rect');
  clip.setAttribute('id', clipId); for (const [key, value] of Object.entries({ x: margin.left, y: margin.top, width: innerWidth, height: innerHeight })) rect.setAttribute(key, value); clip.append(rect); defs.append(clip); svg.append(defs);
  for (let i = 0; i <= 4; i++) {
    const y = () => yRange[0] + (yRange[1] - yRange[0]) * i / 4;
    node('line', { x1: margin.left, x2: width - margin.right, y1: () => sy(y()), y2: () => sy(y()), stroke: '#334457', 'stroke-width': .7 });
    if (!options.linked) node('text', { x: margin.left - 5, y: () => sy(y()) + 3, 'text-anchor': 'end', fill: '#9fb2c5', 'font-size': 10 }, () => fmt(y()));
  }
  for (const span of spec.spans || []) {
    const lane = lanes.indexOf(span.lane), laneHeight = innerHeight / Math.max(1, lanes.length);
    const shape = node('rect', { x: sx(span.start), y: margin.top + lane * laneHeight + 2, width: Math.max(0, sx(span.end) - sx(span.start)), height: Math.max(1, laneHeight - 4), fill: span.color || '#57c7dc', opacity: .7, 'clip-path': `url(#${clipId})` });
    const title = doc.createElementNS(ns, 'title'); title.textContent = `${span.lane}: ${span.label} (${fmt(span.start)}–${fmt(span.end)} ${spec.x?.unit || ''})`; shape.append(title);
    if (spec.kind === 'spans') node('text', { x: margin.left + 4, y: margin.top + lane * laneHeight + 13, fill: '#d7e4ef', 'font-size': 10 }, span.lane);
  }
  for (const guide of spec.guides || []) if (guide.axis === 'y' && Number.isFinite(guide.value)) {
    node('line', { x1: margin.left, x2: width - margin.right, y1: () => sy(guide.value), y2: () => sy(guide.value), stroke: '#e69a94', 'stroke-width': 1, 'stroke-dasharray': '4 3' });
    node('text', { x: width - margin.right - 3, y: () => sy(guide.value) - 3, 'text-anchor': 'end', fill: '#e69a94', 'font-size': 9 }, guide.label || fmt(guide.value));
  }
  const colors = ['#57c7dc', '#e6b961', '#b398f3', '#eb8d95', '#85c99c', '#ddab78', '#b5cae3'];
  const legend = el('div', null, 'plot-legend');
  series.forEach((line, index) => {
    const color = line.color || colors[index % colors.length], label = el('span', line.label || `Series ${index + 1}`); label.style.color = color; legend.append(label);
    const path = () => {
      let path = '', previous = null;
      for (let i = 0; i < (line.x || []).length; i++) {
        const x = line.x[i], y = line.y?.[i], step = line.style === 'step';
        if (!Number.isFinite(x) || !Number.isFinite(y)) { if (step && previous && Number.isFinite(x)) path += `H${sx(x)}`; previous = null; continue; }
        path += `${previous ? step ? `H${sx(x)}V` : 'L' : 'M'}${previous && step ? sy(y) : `${sx(x)},${sy(y)}`}`;
        previous = [x, y];
      }
      return path;
    };
    if (spec.kind === 'bars' || line.style === 'bar') (line.x || []).forEach((x, i) => {
      const y = line.y?.[i]; if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const edges = line.bin_edges || [], left = edges[i] ?? x - (line.width ?? .8) / 2, right = edges[i + 1] ?? x + (line.width ?? .8) / 2;
      node('rect', { x: sx(left), y: () => Math.min(sy(y), sy(0)), width: Math.max(1, sx(right) - sx(left) - 1), height: () => Math.abs(sy(y) - sy(0)), fill: color, 'clip-path': `url(#${clipId})` });
    });
    else node('path', { d: path, stroke: color, fill: 'none', 'stroke-width': 1.6, 'clip-path': `url(#${clipId})` });
  });
  const axisTitle = axis => [axis?.label || axis?.identity?.replaceAll('_', ' '), axis?.unit ? `(${axis.unit})` : ''].filter(Boolean).join(' ');
  if (!options.linked) {
    if (categories) {
      const stride = Math.max(1, Math.ceil(categories.length / 8));
      categories.forEach((category, index) => { if (index % stride === 0) node('text', { x: sx(index), y: height - 22, 'text-anchor': 'middle', fill: '#9fb2c5', 'font-size': 10 }, category); });
    } else node('text', { x: margin.left, y: height - 22, fill: '#9fb2c5', 'font-size': 10 }, fmt(xRange[0]));
    if (!categories) node('text', { x: width - margin.right, y: height - 22, 'text-anchor': 'end', fill: '#9fb2c5', 'font-size': 10 }, fmt(xRange[1]));
    node('text', { x: width / 2, y: height - 5, 'text-anchor': 'middle', fill: '#bdcbd7', 'font-size': 11 }, axisTitle(spec.x_axis));
  }
  root.append(el('div', axisTitle(spec.y_axis), 'plot-unit'), legend);
  const cursor = node('line', { y1: margin.top, y2: height - margin.bottom, stroke: '#fff', 'stroke-width': 1, 'stroke-dasharray': '3 3' });
  const readout = el('div', '', 'plot-hover');
  const xAt = (event, box = svg.getBoundingClientRect()) => xRange[0] + Math.max(0, Math.min(1, ((event.clientX - box.left) / box.width * width - margin.left) / innerWidth)) * (xRange[1] - xRange[0]);
  svg.addEventListener('pointermove', event => {
    const x = xAt(event); readout.textContent = `${categories ? categories[Math.max(0, Math.min(categories.length - 1, Math.round(x)))] : fmt(x)}${spec.x_axis?.unit ? ` ${spec.x_axis.unit}` : ''}`;
    series.forEach(line => { let closest = -1, delta = Infinity; (line.x || []).forEach((value, i) => { if (Math.abs(value - x) < delta && Number.isFinite(line.y?.[i])) { closest = i; delta = Math.abs(value - x); } }); if (closest >= 0) readout.textContent += ` · ${line.label || 'Value'}: ${fmt(line.y[closest])}`; });
    // The visible readout stays on one line. Retain every series value for
    // inspection when a narrow card truncates it.
    readout.setAttribute('title', readout.textContent);
    root.setAttribute('title', readout.textContent);
  });
  svg.addEventListener('pointerleave', () => { readout.textContent = ''; readout.setAttribute('title', ''); root.setAttribute('title', ''); });
  if (!options.linked && options.onSeek) {
    svg.style.cursor = 'ew-resize';
    svg.addEventListener('pointerdown', event => {
      if (event.button != null && event.button !== 0 || event.isPrimary === false) return;
      presentation.cancelScrub?.();
      const box = svg.getBoundingClientRect(), pointerId = event.pointerId, captureRoot = doc.documentElement;
      const move = next => { if (next.pointerId !== pointerId) return; next.preventDefault(); options.onSeek(xAt(next, box)); };
      const finish = next => { if (next.pointerId === pointerId) cancel(); };
      const cancel = () => { doc.removeEventListener('pointermove', move); doc.removeEventListener('pointerup', finish); doc.removeEventListener('pointercancel', finish); if (captureRoot?.hasPointerCapture?.(pointerId)) captureRoot.releasePointerCapture(pointerId); presentation.cancelScrub = null; };
      // Document ownership survives the SVG/card being replaced by an async
      // plot response. Geometry stays frozen for the duration of the gesture.
      doc.addEventListener('pointermove', move); doc.addEventListener('pointerup', finish); doc.addEventListener('pointercancel', finish);
      presentation.cancelScrub = cancel; presentation.pointerSeek = true;
      captureRoot?.setPointerCapture?.(pointerId);
      move(event);
    });
    svg.addEventListener('click', event => { if (!presentation.pointerSeek || event.detail === 0) options.onSeek(xAt(event)); presentation.pointerSeek = false; });
  }
  root.append(svg, readout); container.replaceChildren(root);
  const updateCursor = value => { const visible = Number.isFinite(value) && value >= xRange[0] && value <= xRange[1]; cursor.setAttribute('visibility', visible ? 'visible' : 'hidden'); cursor.setAttribute('x1', sx(value)); cursor.setAttribute('x2', sx(value)); };
  updateCursor(options.cursor);
  const handle = makeHandle(updateCursor, width);
  if (yRange.some((value, index) => value !== targetRange[index])) {
    const from = [...yRange]; let start;
    const animate = time => {
      start ??= time;
      const progress = Math.min(1, (time - start) / 180), eased = 1 - (1 - progress) ** 3;
      yRange = from.map((value, index) => value + (targetRange[index] - value) * eased);
      presentation.currentRange = yRange; scaled.forEach(draw => draw());
      if (progress < 1) animationFrame = globalThis.requestAnimationFrame(animate);
    };
    if (typeof globalThis.requestAnimationFrame === 'function') animationFrame = globalThis.requestAnimationFrame(animate);
    else { yRange = [...targetRange]; presentation.currentRange = yRange; scaled.forEach(draw => draw()); }
  }
  return handle;
  function makeHandle(setCursor = () => {}, renderedWidth) {
    let observer;
    const cleanup = preserveInteraction => { observer?.disconnect(); if (typeof animationFrame !== 'undefined') globalThis.cancelAnimationFrame?.(animationFrame); if (!preserveInteraction) presentation.cancelScrub?.(); };
    const handle = { axisIdentity: spec.x?.identity, linked: Boolean(options.linked), updateCursor: setCursor,
      update(nextSpec, nextOptions = options) { cleanup(true); const replacement = renderPlot(container, nextSpec, { ...nextOptions, presentation }); Object.assign(handle, replacement); return handle; },
      setView(view) { return handle.update(spec, { ...options, ...view }); },
      destroy({ preserveInteraction = false } = {}) { cleanup(preserveInteraction); root.remove(); } };
    if (renderedWidth != null && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (container.clientWidth > 0 && Math.max(220, Math.round(container.clientWidth)) !== renderedWidth) handle.update(spec, options);
      });
      observer.observe(container);
    }
    return handle;
  }
}
