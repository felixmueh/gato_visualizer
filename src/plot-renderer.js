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
  // Standalone previews show notes inline. Embedding hosts pass notes: false
  // and expose them on hover instead (see plotDetails).
  for (const message of [...(options.notes === false ? [] : spec.notes || []), ...(spec.message && spec.kind !== 'unavailable' ? [spec.message] : [])]) root.append(el('p', typeof message === 'string' ? message : message.message, 'plot-message'));
  if (spec.kind === 'table') {
    const table = el('table'), head = el('tr');
    const labels = (spec.columns || ['Quantity', 'Value', 'Unit', 'Note']).map(column => typeof column === 'string' ? column : column.label);
    // A Note column is not a column: the note is the hover text of its row.
    // A row note qualifies how its value reads (e.g. partial data), so the
    // row also carries a small marker; the note itself stays on hover.
    const noteAt = labels.indexOf('Note');
    labels.forEach((label, index) => { if (index !== noteAt) head.append(el('th', label)); });
    table.append(head);
    for (const row of spec.rows || []) {
      const tr = el('tr'), cells = Array.isArray(row) ? row : [row.label, row.value, row.unit || '', row.note || ''];
      const note = noteAt >= 0 && cells[noteAt] ? String(cells[noteAt]) : '';
      cells.forEach((value, index) => {
        if (index === noteAt) { if (value) tr.setAttribute('title', String(value)); return; }
        const text = value == null ? 'unavailable' : typeof value === 'number' ? fmt(value) : value, td = el('td', text);
        td.className = ['plot-table-label', 'plot-table-value'][index] || 'plot-table-unit';
        if (index === 0) { td.setAttribute('title', note ? `${text}\n${note}` : String(text)); if (note) td.className += ' plot-table-noted'; }
        tr.append(td);
      });
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
  // Without data there is no axis to draw: show the message alone, so no
  // gridline, cursor or range is computed from nothing.
  if (spec.kind === 'spans' ? !(spec.spans || []).length : !valid.length) {
    root.append(el('p', spec.empty_message || 'No recorded values available.', 'plot-message'));
    options.legendTarget?.replaceChildren();
    container.replaceChildren(root); return makeHandle();
  }
  const extent = values => { const min = values.reduce((a, b) => Math.min(a, b), Infinity), max = values.reduce((a, b) => Math.max(a, b), -Infinity); return min === max ? [min - Math.max(Math.abs(min) * .05, .01), max + Math.max(Math.abs(max) * .05, .01)] : [min, max]; };
  const finiteX = [...series.flatMap(line => [...(line.x || []), ...(line.bin_edges || [])]), ...(spec.spans || []).flatMap(span => [span.start, span.end])].filter(Number.isFinite);
  const requestedX = options.window || (categories?.length ? [-.5, categories.length - .5] : null) || spec.x_axis?.range || (finiteX.length ? extent(finiteX) : [0, 1]);
  const xRange = requestedX[0] === requestedX[1] ? [requestedX[0], requestedX[0] + .001] : requestedX;
  // Data are drawn once in this base range. A host may then move the x-window
  // and the reveal time every frame (setFrame) without rebuilding the SVG.
  let viewRange = [...xRange], reveal = Number.isFinite(options.reveal) ? options.reveal : null;
  const visible = valid.filter(([x]) => x >= xRange[0] && x <= xRange[1]);
  const guideValues = (spec.guides || []).filter(guide => guide.axis === 'y' && Number.isFinite(guide.value)).map(guide => guide.value);
  const lanes = [...new Set((spec.spans || []).map(span => span.lane))];
  // Viewer display limits are presentation only: each side is a value or
  // automatic, and clipping ignores the outer 1 % of visible samples per side.
  const limits = options.yLimits || {};
  let autoValues = (visible.length ? visible : valid).map(p => p[1]);
  if (limits.clipOutliers && autoValues.length >= 8) {
    const sorted = [...autoValues].sort((a, b) => a - b), at = q => sorted[Math.round(q * (sorted.length - 1))];
    autoValues = [at(.01), at(.99)];
  }
  const yValues = [...autoValues, ...guideValues, ...(spec.kind === 'bars' ? [0] : [])];
  const explicitY = spec.kind === 'spans' ? [0, Math.max(1, lanes.length)] : spec.y_axis?.range;
  const measuredY = yValues.length ? extent(yValues) : [0, 1];
  const rangeKey = JSON.stringify([options.fitKey, spec.y, spec.kind, spec.kind === 'spans' ? null : limits]);
  const resetFit = presentation.rangeKey !== rangeKey;
  presentation.rangeKey = rangeKey;
  // A spec's y.span is the default automatic range: data beyond it extends
  // that side with a small margin, data inside it never shrinks it.
  const span = Array.isArray(spec.y_axis?.span) && spec.y_axis.span.every(Number.isFinite) ? spec.y_axis.span : null;
  const padded = ([low, high]) => {
    const pad = (high - low) * (span ? .04 : .12);
    return span ? [low < span[0] ? low - pad : span[0], high > span[1] ? high + pad : span[1]] : [low - pad, high + pad];
  };
  const previousRange = resetFit ? null : presentation.targetRange;
  // Keep an envelope while history grows. Small fluctuations inside its
  // headroom do not move the axis; a deliberate range/source change refits it.
  let targetRange = explicitY || previousRange || padded(measuredY);
  if (!explicitY && previousRange && (measuredY[0] < previousRange[0] || measuredY[1] > previousRange[1])) {
    targetRange = padded([Math.min(previousRange[0], measuredY[0]), Math.max(previousRange[1], measuredY[1])]);
  }
  presentation.targetRange = targetRange;
  if (spec.kind !== 'spans') {
    const fixed = [Number.isFinite(limits.min) ? limits.min : targetRange[0], Number.isFinite(limits.max) ? limits.max : targetRange[1]];
    if (fixed[0] < fixed[1]) targetRange = fixed;
  }
  let yRange = explicitY || resetFit || !presentation.currentRange ? [...targetRange] : [...presentation.currentRange];
  presentation.currentRange = yRange;
  // Use display pixels so text stays legible in a narrow inspector. Observe
  // visibility/layout changes too: plots may first render inside a hidden tab.
  // The SVG uses its real pixel height, so text is never stretched; hosts
  // may resize a plot by passing another height.
  const width = Math.max(220, Math.round(container.clientWidth || 600)), height = Math.max(40, Math.round(options.height ?? (options.compact ? 85 : 170)));
  // Round tick values, about one per 28 px. Reserve only the width the
  // longest label needs at both the current and the target range.
  const tickCount = Math.max(2, Math.floor((height - (options.linked ? 30 : 46)) / 28));
  const labelChars = Math.max(1, ...[yRange, targetRange].flatMap(range => niceTicks(range, tickCount).map(tick => tick.label.length)));
  // Linked timeline plots use the full width. Their ruler is the timeline's,
  // so their y labels sit inside the plot area instead of in a margin.
  const margin = options.linked ? { left: 0, right: 0, top: 10, bottom: 20 } : { left: Math.ceil(labelChars * 6 + 9), right: 12, top: 12, bottom: 34 };
  const innerWidth = width - margin.left - margin.right, innerHeight = height - margin.top - margin.bottom;
  const sx = x => margin.left + (x - xRange[0]) / (xRange[1] - xRange[0] || 1) * innerWidth;
  const cx = x => margin.left + (x - viewRange[0]) / (viewRange[1] - viewRange[0] || 1) * innerWidth;
  const sy = y => height - margin.bottom - (y - yRange[0]) / (yRange[1] - yRange[0] || 1) * innerHeight;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', spec.title || 'Recorded plot'); svg.style.height = `${height}px`;
  const scaled = [];
  const node = (tag, attributes, text, parent = svg) => {
    const item = doc.createElementNS(ns, tag);
    const draw = () => { for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, typeof value === 'function' ? value() : value); if (text != null) item.textContent = String(typeof text === 'function' ? text() : text); };
    draw(); if (Object.values(attributes).some(value => typeof value === 'function') || typeof text === 'function') scaled.push(draw);
    parent.append(item); return item;
  };
  const clipId = `plot-clip-${Math.random().toString(36).slice(2)}`;
  const defs = doc.createElementNS(ns, 'defs'), clip = doc.createElementNS(ns, 'clipPath'), rect = doc.createElementNS(ns, 'rect');
  clip.setAttribute('id', clipId); for (const [key, value] of Object.entries({ x: margin.left, y: margin.top, width: innerWidth, height: innerHeight })) rect.setAttribute(key, value); clip.append(rect); defs.append(clip); svg.append(defs);
  // Data marks live in a screen-space clipped group holding an x-transformed
  // group. The clip also ends at the reveal time; it never extends the data.
  const clipped = doc.createElementNS(ns, 'g'), data = doc.createElementNS(ns, 'g'); clipped.setAttribute('clip-path', `url(#${clipId})`); clipped.append(data);
  data.setAttribute('class', 'plot-data');
  // The tick set changes while the range animates, so it is redrawn whole.
  // Linked rows keep their labels inside the left edge, outlined with the
  // background colour so curves stay readable beneath them.
  // Gridlines go below the data; labels are appended later, above guides and
  // curves, so their outline cuts through anything that crosses them.
  const tickGroup = doc.createElementNS(ns, 'g'), labelGroup = doc.createElementNS(ns, 'g'); svg.append(tickGroup);
  const drawTicks = () => {
    const items = [], labels = [];
    for (const tick of niceTicks(yRange, tickCount)) {
      const y = sy(tick.value), line = doc.createElementNS(ns, 'line'), text = doc.createElementNS(ns, 'text');
      for (const [key, value] of Object.entries({ x1: margin.left, x2: width - margin.right, y1: y, y2: y, stroke: '#334457', 'stroke-width': .7 })) line.setAttribute(key, value);
      const top = y < margin.top + 8, bottom = y > height - margin.bottom - 4;
      for (const [key, value] of Object.entries(options.linked ? { x: 3, y: top ? y + 9 : bottom ? y - 2 : y + 3, fill: '#9fb2c5', 'font-size': 9, stroke: '#142130', 'stroke-width': 3, 'paint-order': 'stroke' } : { x: margin.left - 5, y: y + 3, 'text-anchor': 'end', fill: '#9fb2c5', 'font-size': 10 })) text.setAttribute(key, value);
      text.setAttribute('class', 'plot-y-tick'); text.textContent = tick.label; items.push(line); labels.push(text);
    }
    tickGroup.replaceChildren(...items); labelGroup.replaceChildren(...labels);
  };
  drawTicks(); scaled.push(drawTicks);
  for (const span of spec.spans || []) {
    const lane = lanes.indexOf(span.lane), laneHeight = innerHeight / Math.max(1, lanes.length);
    const shape = node('rect', { x: sx(span.start), y: margin.top + lane * laneHeight + 2, width: Math.max(0, sx(span.end) - sx(span.start)), height: Math.max(1, laneHeight - 4), fill: span.color || '#57c7dc', opacity: .7 }, null, data);
    const title = doc.createElementNS(ns, 'title'); title.textContent = `${span.lane}: ${span.label} (${fmt(span.start)}–${fmt(span.end)} ${spec.x?.unit || ''})`; shape.append(title);
    if (spec.kind === 'spans') node('text', { x: margin.left + 4, y: margin.top + lane * laneHeight + 13, fill: '#d7e4ef', 'font-size': 10 }, span.lane);
  }
  // Bands shade a y interval across the plot (end null: to the top). Tones
  // use the limit-state colour tokens; beyond is hatched, so a violation reads
  // differently from merely near. They sit beneath the data and the reveal.
  const tone = { near: 'var(--limit-near, #f2b544)', beyond: 'var(--limit-beyond, #ff4b4b)' };
  const bandY = value => Math.max(margin.top, Math.min(height - margin.bottom, sy(value)));
  for (const band of spec.bands || []) if (band.axis === 'y' && tone[band.tone]) {
    const top = () => Number.isFinite(band.end) ? bandY(band.end) : margin.top, bottom = () => Number.isFinite(band.start) ? bandY(band.start) : height - margin.bottom;
    if (band.tone === 'beyond' && !defs.querySelector('pattern')) {
      const pattern = doc.createElementNS(ns, 'pattern'), stroke = doc.createElementNS(ns, 'path');
      for (const [key, value] of Object.entries({ id: `${clipId}-hatch`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' })) pattern.setAttribute(key, value);
      stroke.setAttribute('d', 'M0,0V6'); stroke.setAttribute('stroke-width', 2); stroke.style.stroke = tone.beyond; stroke.setAttribute('opacity', .35); pattern.append(stroke); defs.append(pattern);
    }
    const shape = node('rect', { x: margin.left, width: innerWidth, y: top, height: () => Math.max(0, bottom() - top()), class: `plot-band plot-band-${band.tone}` });
    shape.style.fill = band.tone === 'beyond' ? `url(#${clipId}-hatch)` : tone.near; if (band.tone === 'near') shape.setAttribute('opacity', .22);
    if (band.label) { const title = doc.createElementNS(ns, 'title'); title.textContent = band.label; shape.append(title); }
  }
  for (const guide of spec.guides || []) if (guide.axis === 'y' && Number.isFinite(guide.value)) {
    const hard = guide.style === 'hard', color = hard ? tone.beyond : '#e69a94';
    const line = node('line', { x1: margin.left, x2: width - margin.right, y1: () => sy(guide.value), y2: () => sy(guide.value), stroke: '#e69a94', 'stroke-width': hard ? 1.2 : 1, ...(hard ? {} : { 'stroke-dasharray': '4 3' }) });
    const text = node('text', { x: width - margin.right - 3, y: () => sy(guide.value) - 3, 'text-anchor': 'end', fill: '#e69a94', 'font-size': 9 }, guide.label || fmt(guide.value));
    if (hard) { line.style.stroke = color; text.style.fill = color; }
  }
  const colors = ['#57c7dc', '#e6b961', '#b398f3', '#eb8d95', '#85c99c', '#ddab78', '#b5cae3'];
  const legend = el('div', null, 'plot-legend'), barRects = [];
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
      barRects.push({ left, right, rect: null, line, i });
      barRects.at(-1).rect = node('rect', { x: sx(left), y: () => Math.min(sy(y), sy(0)), width: Math.max(1, sx(right) - sx(left) - 1), height: () => Math.abs(sy(y) - sy(0)), fill: color }, null, data);
      barRects.at(-1).rect.style.fill = color;
    });
    // Also as style: a colour may be a CSS token, var(--name, fallback),
    // which presentation attributes do not resolve.
    else node('path', { d: path, stroke: color, fill: 'none', 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke' }, null, data).style.stroke = color;
  });
  svg.append(clipped, labelGroup);
  const xLabels = [];
  const axisTitle = axis => [axis?.label || axis?.identity?.replaceAll('_', ' '), axis?.unit ? `(${axis.unit})` : ''].filter(Boolean).join(' ');
  if (!options.linked) {
    if (categories) {
      const stride = Math.max(1, Math.ceil(categories.length / 8));
      categories.forEach((category, index) => { if (index % stride === 0) node('text', { x: sx(index), y: height - 22, 'text-anchor': 'middle', fill: '#9fb2c5', 'font-size': 10 }, category); });
    } else xLabels.push(node('text', { x: margin.left, y: height - 20, fill: '#9fb2c5', 'font-size': 10, class: 'plot-x-range' }, fmt(xRange[0])));
    if (!categories) xLabels.push(node('text', { x: width - margin.right, y: height - 20, 'text-anchor': 'end', fill: '#9fb2c5', 'font-size': 10, class: 'plot-x-range' }, fmt(xRange[1])));
    node('text', { x: width / 2, y: height - 4, 'text-anchor': 'middle', fill: '#bdcbd7', 'font-size': 11 }, axisTitle(spec.x_axis));
  }
  // Unit and legend share one row; a host may place it in its own header.
  const meta = el('div', null, 'plot-meta'); meta.append(el('div', axisTitle(spec.y_axis), 'plot-unit'), legend);
  if (options.legendTarget) options.legendTarget.replaceChildren(meta); else root.append(meta);
  const cursor = node('line', { y1: margin.top, y2: height - margin.bottom, stroke: '#fff', 'stroke-width': 1, 'stroke-dasharray': '3 3' });
  const readout = el('div', '', 'plot-hover');
  const xAt = (event, box = svg.getBoundingClientRect()) => viewRange[0] + Math.max(0, Math.min(1, ((event.clientX - box.left) / box.width * width - margin.left) / innerWidth)) * (viewRange[1] - viewRange[0]);
  let hoveredBar;
  const highlight = bar => { hoveredBar?.rect.setAttribute('stroke', 'none'); hoveredBar = bar; bar?.rect.setAttribute('stroke', '#eefbff'); };
  svg.addEventListener('pointermove', event => {
    const x = xAt(event), unit = spec.x_axis?.unit ? ` ${spec.x_axis.unit}` : '';
    // A bar reports its own bin edges, so histograms need no edge list.
    const bar = !categories && barRects.find(item => x >= item.left && x < item.right);
    highlight(bar || null);
    if (bar) { readout.textContent = `${fmt(bar.left)}–${fmt(bar.right)}${unit} · ${bar.line.label || 'Value'}: ${fmt(bar.line.y[bar.i])}`; }
    else {
      readout.textContent = `${categories ? categories[Math.max(0, Math.min(categories.length - 1, Math.round(x)))] : fmt(x)}${unit}`;
      series.forEach(line => { let closest = -1, delta = Infinity; (line.x || []).forEach((value, i) => { if (Math.abs(value - x) < delta && Number.isFinite(line.y?.[i])) { closest = i; delta = Math.abs(value - x); } }); if (closest >= 0) readout.textContent += ` · ${line.hover?.[closest] || `${line.label || 'Value'}: ${fmt(line.y[closest])}`}`; });
    }
    // The visible readout stays on one line. Retain every series value for
    // inspection when a narrow card truncates it.
    readout.setAttribute('title', readout.textContent);
    root.setAttribute('title', readout.textContent);
  });
  svg.addEventListener('pointerleave', () => { highlight(null); readout.textContent = ''; readout.setAttribute('title', ''); root.setAttribute('title', ''); });
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
  let cursorValue = options.cursor;
  const updateCursor = value => { cursorValue = value; const visible = Number.isFinite(value) && value >= viewRange[0] && value <= viewRange[1]; cursor.setAttribute('visibility', visible ? 'visible' : 'hidden'); if (!visible) return; cursor.setAttribute('x1', cx(value)); cursor.setAttribute('x2', cx(value)); };
  // Map the base drawing onto the current window with one affine transform,
  // and end the clip at the reveal time (or the plot edge without one).
  const applyFrame = () => {
    const scale = (xRange[1] - xRange[0]) / (viewRange[1] - viewRange[0] || 1);
    data.setAttribute('transform', scale === 1 && viewRange[0] === xRange[0] ? '' : `matrix(${scale} 0 0 1 ${cx(xRange[0]) - scale * margin.left} 0)`);
    rect.setAttribute('width', revealWidth(reveal, viewRange, innerWidth));
    if (xLabels.length === 2) { xLabels[0].textContent = fmt(viewRange[0]); xLabels[1].textContent = fmt(viewRange[1]); }
    updateCursor(cursorValue);
  };
  const setFrame = ({ window: next, reveal: until } = {}) => {
    if (!categories && Array.isArray(next) && next.every(Number.isFinite)) viewRange = next[0] === next[1] ? [next[0], next[0] + .001] : [...next];
    reveal = Number.isFinite(until) ? until : null;
    applyFrame();
  };
  applyFrame();
  const handle = makeHandle(updateCursor, width, setFrame);
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
  function makeHandle(setCursor = () => {}, renderedWidth, setFrame = () => {}) {
    let observer;
    const cleanup = preserveInteraction => { observer?.disconnect(); if (typeof animationFrame !== 'undefined') globalThis.cancelAnimationFrame?.(animationFrame); if (!preserveInteraction) presentation.cancelScrub?.(); };
    const handle = { axisIdentity: spec.x?.identity, linked: Boolean(options.linked), updateCursor: setCursor, setFrame,
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

/** Clip width in plot pixels that reveals data up to `reveal` within `window`.
 * Without a finite reveal time the whole plot width is shown. */
export function revealWidth(reveal, [low, high], innerWidth) {
  if (!Number.isFinite(reveal)) return innerWidth;
  return Math.max(0, Math.min(innerWidth, (reveal - low) / (high - low || 1) * innerWidth));
}

/** Round tick values inside range, roughly count of them, with exact labels. */
export function niceTicks([low, high], count = 4) {
  const span = high - low;
  if (!(span > 0) || !Number.isFinite(span)) return Number.isFinite(low) ? [{ value: low, label: Number(low.toPrecision(5)).toString() }] : [];
  const raw = span / Math.max(1, count), power = 10 ** Math.floor(Math.log10(raw));
  const mantissa = [1, 2, 2.5, 5, 10].find(value => value * power >= raw * .999) || 10, step = mantissa * power;
  const decimals = Math.max(0, Math.min(12, -Math.floor(Math.log10(step) + 1e-9) + (mantissa === 2.5 ? 1 : 0)));
  const ticks = [];
  for (let i = Math.ceil(low / step - 1e-9); i * step <= high + step * 1e-9 && ticks.length < 50; i++) {
    const value = i * step;
    ticks.push({ value, label: (Object.is(Number(value.toFixed(decimals)), -0) ? 0 : Number(value.toFixed(decimals))).toString() });
  }
  return ticks;
}
