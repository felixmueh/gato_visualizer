/** Shared dependency-free renderer for the application and standalone previews.
 * Plot data and aggregates are supplied by Python. Scaling, gaps, hover and
 * cursor markers here are presentation only.
 */
export function renderPlot(container, spec, options = {}) {
  spec = { ...spec, x_axis: spec.x, y_axis: spec.y };
  const doc = container.ownerDocument || document;
  const el = (tag, text, cls) => { const node = doc.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const fmt = value => Number.isFinite(value) ? Number(value.toPrecision(5)).toString() : 'unavailable';
  const root = el('div', null, 'plot-renderer');
  if (spec.title && !options.compact) root.append(el('h3', spec.title));
  for (const message of [...(spec.notes || []), ...(spec.message ? [spec.message] : [])]) root.append(el('p', typeof message === 'string' ? message : message.message, 'plot-message'));
  if (spec.kind === 'table') {
    const table = el('table'); const head = el('tr');
    for (const column of spec.columns || ['Quantity', 'Value', 'Unit', 'Note']) head.append(el('th', typeof column === 'string' ? column : column.label));
    table.append(head);
    for (const row of spec.rows || []) {
      const tr = el('tr');
      for (const value of Array.isArray(row) ? row : [row.label, row.value, row.unit || '', row.note || '']) tr.append(el('td', value == null ? 'unavailable' : typeof value === 'number' ? fmt(value) : value));
      table.append(tr);
    }
    root.append(table); container.replaceChildren(root); return { updateCursor() {}, destroy() { root.remove(); } };
  }
  if (!['lines', 'bars', 'spans'].includes(spec.kind)) {
    root.append(el('p', spec.kind === 'unavailable' ? (spec.message || 'No recorded values available.') : `Unsupported plot kind: ${spec.kind}`, 'plot-message')); container.replaceChildren(root); return { updateCursor() {}, destroy() { root.remove(); } };
  }
  const series = spec.series || [], points = series.flatMap(line => (line.x || []).map((x, i) => [x, line.y?.[i]]));
  const valid = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (!valid.length) root.append(el('p', spec.empty_message || 'No recorded values available.', 'plot-message'));
  const extent = values => { const min = Math.min(...values), max = Math.max(...values); return min === max ? [min - Math.max(Math.abs(min) * .05, .01), max + Math.max(Math.abs(max) * .05, .01)] : [min, max]; };
  const xRange = options.window || spec.x_axis?.range || (valid.length ? extent(valid.map(p => p[0])) : [0, 1]);
  const visible = valid.filter(([x]) => x >= xRange[0] && x <= xRange[1]);
  const yRange = spec.y_axis?.range || (visible.length ? extent([...visible.map(p => p[1]), ...(spec.kind === 'bars' ? [0] : [])]) : valid.length ? extent(valid.map(p => p[1])) : [0, 1]);
  const width = 600, height = options.compact ? 115 : 200;
  // Linked timeline plots use the full width. Their ruler is the timeline's.
  const margin = options.linked ? { left: 0, right: 0, top: 10, bottom: 20 } : { left: 62, right: 12, top: 12, bottom: 38 };
  const innerWidth = width - margin.left - margin.right, innerHeight = height - margin.top - margin.bottom;
  const sx = x => margin.left + (x - xRange[0]) / (xRange[1] - xRange[0] || 1) * innerWidth;
  const sy = y => height - margin.bottom - (y - yRange[0]) / (yRange[1] - yRange[0] || 1) * innerHeight;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', spec.title || 'Recorded plot');
  const node = (tag, attributes, text) => { const item = doc.createElementNS(ns, tag); for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, value); if (text != null) item.textContent = String(text); svg.append(item); return item; };
  const clipId = `plot-clip-${Math.random().toString(36).slice(2)}`;
  const defs = doc.createElementNS(ns, 'defs'), clip = doc.createElementNS(ns, 'clipPath'), rect = doc.createElementNS(ns, 'rect');
  clip.setAttribute('id', clipId); for (const [key, value] of Object.entries({ x: margin.left, y: margin.top, width: innerWidth, height: innerHeight })) rect.setAttribute(key, value); clip.append(rect); defs.append(clip); svg.append(defs);
  for (let i = 0; i <= 4; i++) {
    const y = yRange[0] + (yRange[1] - yRange[0]) * i / 4;
    node('line', { x1: margin.left, x2: width - margin.right, y1: sy(y), y2: sy(y), stroke: '#334457', 'stroke-width': .7 });
    if (!options.linked) node('text', { x: margin.left - 5, y: sy(y) + 3, 'text-anchor': 'end', fill: '#9fb2c5', 'font-size': 10 }, fmt(y));
  }
  for (const span of spec.spans || []) node('rect', { x: sx(span.start), y: margin.top, width: Math.max(0, sx(span.end) - sx(span.start)), height: innerHeight, fill: span.color || '#9fb2c5', opacity: .14, 'clip-path': `url(#${clipId})` });
  const colors = ['#57c7dc', '#e6b961', '#b398f3', '#eb8d95', '#85c99c', '#ddab78', '#b5cae3'];
  const legend = el('div', null, 'plot-legend');
  series.forEach((line, index) => {
    const color = line.color || colors[index % colors.length], label = el('span', line.label || `Series ${index + 1}`); label.style.color = color; legend.append(label);
    let path = '', previous = null;
    for (let i = 0; i < (line.x || []).length; i++) {
      const x = line.x[i], y = line.y?.[i], step = line.style === 'step';
      if (!Number.isFinite(x) || !Number.isFinite(y)) { if (step && previous && Number.isFinite(x)) path += `H${sx(x)}`; previous = null; continue; }
      if (spec.kind === 'bars') {
        const edges = line.bin_edges || [], left = edges[i] ?? x - (line.width ?? .8) / 2, right = edges[i + 1] ?? x + (line.width ?? .8) / 2;
        node('rect', { x: sx(left), y: Math.min(sy(y), sy(0)), width: Math.max(1, sx(right) - sx(left) - 1), height: Math.abs(sy(y) - sy(0)), fill: color, 'clip-path': `url(#${clipId})` });
      } else path += `${previous ? step ? `H${sx(x)}V` : 'L' : 'M'}${previous && step ? sy(y) : `${sx(x)},${sy(y)}`}`;
      previous = [x, y];
    }
    if (spec.kind !== 'bars') node('path', { d: path, stroke: color, fill: 'none', 'stroke-width': 1.6, 'clip-path': `url(#${clipId})` });
  });
  const axisTitle = axis => [axis?.label || axis?.identity?.replaceAll('_', ' '), axis?.unit ? `(${axis.unit})` : ''].filter(Boolean).join(' ');
  if (!options.linked) {
    node('text', { x: margin.left, y: height - 22, fill: '#9fb2c5', 'font-size': 10 }, fmt(xRange[0]));
    node('text', { x: width - margin.right, y: height - 22, 'text-anchor': 'end', fill: '#9fb2c5', 'font-size': 10 }, fmt(xRange[1]));
    node('text', { x: width / 2, y: height - 5, 'text-anchor': 'middle', fill: '#bdcbd7', 'font-size': 11 }, axisTitle(spec.x_axis));
  }
  root.append(el('div', axisTitle(spec.y_axis), 'plot-unit'), legend);
  const cursor = node('line', { y1: margin.top, y2: height - margin.bottom, stroke: '#fff', 'stroke-width': 1, 'stroke-dasharray': '3 3' });
  const readout = el('div', '', 'plot-hover');
  const xAt = event => { const box = svg.getBoundingClientRect(); return xRange[0] + Math.max(0, Math.min(1, ((event.clientX - box.left) / box.width * width - margin.left) / innerWidth)) * (xRange[1] - xRange[0]); };
  svg.addEventListener('pointermove', event => {
    const x = xAt(event); readout.textContent = `${fmt(x)}${spec.x_axis?.unit ? ` ${spec.x_axis.unit}` : ''}`;
    series.forEach(line => { let closest = -1, delta = Infinity; (line.x || []).forEach((value, i) => { if (Math.abs(value - x) < delta && Number.isFinite(line.y?.[i])) { closest = i; delta = Math.abs(value - x); } }); if (closest >= 0) readout.textContent += ` · ${line.label || 'Value'}: ${fmt(line.y[closest])}`; });
  });
  if (!options.linked && options.onSeek) svg.addEventListener('click', event => options.onSeek(xAt(event)));
  root.append(svg, readout); container.replaceChildren(root);
  const updateCursor = value => { const visible = Number.isFinite(value) && value >= xRange[0] && value <= xRange[1]; cursor.setAttribute('visibility', visible ? 'visible' : 'hidden'); cursor.setAttribute('x1', sx(value)); cursor.setAttribute('x2', sx(value)); };
  updateCursor(options.cursor);
  return { updateCursor, destroy() { root.remove(); } };
}
