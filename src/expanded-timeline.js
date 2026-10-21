import { intervalDescription, intervalSeverity } from './live-execution.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export function timelineTypingTarget(target) {
  return Boolean(target?.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName));
}
export function timelineBounds(bounds) {
  const start = Number.isFinite(bounds?.[0]) ? bounds[0] : 0;
  return [start, Math.max(start, Number.isFinite(bounds?.[1]) ? bounds[1] : start)];
}
export function clampTimelineWindow(window, bounds) {
  const [start, end] = timelineBounds(bounds), total = end - start;
  if (!total) return [start, end];
  const span = clamp(window[1] - window[0], Math.min(.001, total), total);
  const left = clamp(window[0], start, end - span);
  return [left, left + span];
}
export function zoomTimeline(window, bounds, factor, fraction = .5) {
  fraction = clamp(fraction, 0, 1);
  const span = window[1] - window[0];
  const next = clamp(span * factor, Math.min(.001, bounds[1] - bounds[0]), bounds[1] - bounds[0]);
  const anchor = window[0] + span * clamp(fraction, 0, 1);
  return clampTimelineWindow([anchor - next * fraction, anchor + next * (1 - fraction)], bounds);
}
export function timelineTicks(window, width) {
  const span = window[1] - window[0];
  if (!(span > 0) || !(width > 0)) return [];
  const desired = span / Math.max(1, Math.floor(width / 95));
  const power = 10 ** Math.floor(Math.log10(desired));
  const step = [1, 2, 5, 10].find(value => value * power >= desired) * power;
  const decimals = Math.min(6, Math.max(0, -Math.floor(Math.log10(step))));
  const ticks = [];
  for (let i = Math.ceil(window[0] / step); i * step <= window[1] + step * 1e-8; i++) {
    const time = i * step;
    ticks.push({ time, fraction: (time - window[0]) / span, label: `${time.toFixed(decimals)} s` });
  }
  return ticks;
}

// Parse only on interval revision. Prefix maxima allow visible-range lookup
// even when intervals overlap or arrive in a different order.
export function indexTimelineIntervals(intervals = []) {
  let maxEnd = -Infinity;
  return intervals.filter(item => Number.isFinite(item.start_time_s) && Number.isFinite(item.end_time_s) && item.end_time_s > item.start_time_s)
    .map(item => ({ start: item.start_time_s, end: item.end_time_s, severity: intervalSeverity(item), item }))
    .sort((a, b) => a.start - b.start)
    .map(entry => ({ ...entry, maxEnd: maxEnd = Math.max(maxEnd, entry.end) }));
}
export function visibleTimelineIntervals(index, [start, end]) {
  let lo = 0, hi = index.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (index[mid].maxEnd <= start) lo = mid + 1; else hi = mid; }
  const result = [];
  for (let i = lo; i < index.length && index[i].start < end; i++) if (index[i].end > start) result.push(index[i]);
  return result;
}

export function expandedTimelineShell() {
  return `<section id="expanded-timeline" class="expanded-timeline" aria-label="Timeline inspection" hidden>
    <div class="timeline-inspection-heading"><span id="timeline-clock-label">Recorded time</span><span id="timeline-timing-note">No timing data</span><div class="timeline-zoom-controls"><button id="timeline-zoom-out" aria-label="Zoom timeline out" title="Zoom out (−)">−</button><button id="timeline-zoom-in" aria-label="Zoom timeline in" title="Zoom in (+)">+</button><button id="timeline-fit" title="Fit entire recording (0)">Fit</button></div></div>
    <div id="timeline-linked-graphs"></div>
    <div id="timeline-inspector" class="timeline-inspector" role="slider" tabindex="0" aria-label="Inspect simulation time" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-describedby="timeline-gesture-hint"><canvas id="timeline-bands" aria-hidden="true"></canvas><div id="timeline-playhead" class="timeline-playhead" aria-hidden="true"><span></span></div></div>
    <div class="timeline-inspection-footer"><span id="timeline-gesture-hint">Scroll to zoom · Alt-drag to pan · drag to scrub</span><span id="timeline-selection">0.000 s</span></div>
    <div id="timeline-inspection-tooltip" class="timeline-inspection-tooltip" role="tooltip" hidden></div>
  </section>`;
}

export function setupExpandedTimeline({ document: doc = document, onSeek, onLayout = () => {} }) {
  const $ = id => doc.getElementById(id), panel = $('expanded-timeline'), surface = $('timeline-inspector');
  const canvas = $('timeline-bands'), playhead = $('timeline-playhead'), tooltip = $('timeline-inspection-tooltip');
  const toggles = ['live-timeline-expand', 'replay-timeline-expand'].map($);
  let expanded = false, identity, bounds = [0, 0], window = [0, 0], selected = 0, fitted = true;
  let source, sourceCount = -1, revision, index = [], paintKey = '', width = 0, paints = 0, drag = null, mode = 'replay';
  const gestureHint = 'Scroll to zoom; Alt-drag, middle-drag or horizontal scroll to pan; drag to scrub. Arrow keys seek, Shift+arrows seek 1 ms, +/− zoom, 0 fits.';
  surface.title = gestureHint;
  function paint() {
    if (!expanded) return;
    width = Math.max(1, surface.clientWidth);
    const ratio = doc.defaultView?.devicePixelRatio || 1;
    const key = [window[0], window[1], width, ratio, sourceCount, revision, mode].join('|');
    if (paintKey === key) return;
    paintKey = key; paints++;
    const height = 74;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio); context.clearRect(0, 0, width, height);
    const span = window[1] - window[0], x = time => (time - window[0]) / (span || 1) * width;
    context.fillStyle = '#263548'; context.fillRect(0, 39, width, 25);
    // Render normal, then yellow, then red so MPC retains priority at every zoom.
    const visible = visibleTimelineIntervals(index, window);
    for (const severity of ['normal', 'yellow', 'red']) {
      context.fillStyle = { normal: '#476371', yellow: '#e8c65a', red: '#ed716c' }[severity];
      for (const item of visible) if (item.severity === severity) {
        const left = clamp(x(item.start), 0, width), right = clamp(x(item.end), 0, width);
        context.fillRect(left, 39, Math.max(1, right - left), 25);
      }
    }
    context.font = '10px "IBM Plex Mono", monospace';
    for (const tick of timelineTicks(window, width)) {
      const left = tick.fraction * width;
      context.strokeStyle = '#526174'; context.beginPath(); context.moveTo(left, 24); context.lineTo(left, 74); context.stroke();
      context.fillStyle = '#b3c7d7';
      context.fillText(tick.label, clamp(left + 4, 2, Math.max(2, width - context.measureText(tick.label).width - 2)), 16);
    }
    $('timeline-timing-note').innerHTML = index.length ? '<span class="timeline-mpc-key">MPC over budget</span> · <span class="timeline-simulation-key">Simulation / combined</span>' : 'No timing data';
    $('timeline-timing-note').classList.toggle('has-timing', Boolean(index.length));
  }
  function position() {
    if (!expanded) return;
    const span = window[1] - window[0], fraction = span ? (selected - window[0]) / span : 0;
    playhead.hidden = fraction < 0 || fraction > 1;
    playhead.style.left = `${clamp(fraction, 0, 1) * 100}%`;
    surface.setAttribute('aria-valuemin', String(bounds[0])); surface.setAttribute('aria-valuemax', String(bounds[1]));
    surface.setAttribute('aria-valuenow', String(selected)); surface.setAttribute('aria-valuetext', `${selected.toFixed(6)} seconds`);
    $('timeline-selection').textContent = `${selected.toFixed(6)} s`;
  }
  function redraw() { paint(); position(); }
  function setExpanded(value) {
    expanded = value; panel.hidden = !value;
    for (const button of toggles) {
      button.setAttribute('aria-expanded', String(value)); button.setAttribute('aria-label', `${value ? 'Collapse' : 'Expand'} timeline`);
      button.title = `${value ? 'Collapse' : 'Expand'} timeline`;
    }
    paintKey = ''; redraw(); onLayout();
  }
  const fractionAt = event => clamp((event.clientX - surface.getBoundingClientRect().left) / Math.max(1, surface.clientWidth), 0, 1);
  const timeAt = event => window[0] + fractionAt(event) * (window[1] - window[0]);
  function seek(time) { selected = clamp(time, ...bounds); onSeek(selected); position(); }
  function zoom(factor, fraction = .5) { window = zoomTimeline(window, bounds, factor, fraction); fitted = false; redraw(); }
  function pan(seconds) { window = clampTimelineWindow(window.map(time => time + seconds), bounds); fitted = false; redraw(); }
  function fit() { window = [...bounds]; fitted = true; redraw(); }
  function hideTooltip() { tooltip.hidden = true; }
  for (const button of toggles) button.addEventListener('click', () => setExpanded(!expanded));
  $('timeline-fit').addEventListener('click', fit);
  $('timeline-zoom-in').addEventListener('click', () => zoom(.5));
  $('timeline-zoom-out').addEventListener('click', () => zoom(2));
  function bindSurface(element) {
  element.addEventListener('wheel', event => {
    event.preventDefault(); hideTooltip();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientWidth : 1;
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) pan((event.deltaX || event.deltaY) * unit / Math.max(1, width) * (window[1] - window[0]));
    else zoom(Math.exp(clamp(event.deltaY * unit, -500, 500) * .002), fractionAt(event));
  }, { passive: false });
  element.addEventListener('pointerdown', event => {
    if (event.target.closest?.('button, input, select, label')) return;
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault(); hideTooltip(); surface.focus();
    drag = { pointer: event.pointerId, pan: event.button === 1 || event.altKey, x: event.clientX, window: [...window], element };
    element.setPointerCapture(event.pointerId); element.classList.toggle('panning', drag.pan);
    if (!drag.pan) seek(timeAt(event));
  });
  element.addEventListener('pointermove', event => {
    if (drag) {
      if (event.pointerId !== drag.pointer) return;
      if (drag.pan) {
        const delta = (event.clientX - drag.x) / Math.max(1, surface.clientWidth) * (drag.window[1] - drag.window[0]);
        window = clampTimelineWindow(drag.window.map(time => time - delta), bounds); fitted = false; redraw();
      } else seek(timeAt(event));
      return;
    }
    const time = timeAt(event), epsilon = Math.max(Number.EPSILON, (window[1] - window[0]) / Math.max(width, 1) / 2);
    const entries = visibleTimelineIntervals(index, [time - epsilon, time + epsilon]);
    const entry = entries.find(value => value.severity === 'red') || entries.find(value => value.severity === 'yellow') || entries[0];
    tooltip.textContent = `${time.toFixed(6)} s · ${entry ? `${entry.start.toFixed(6)}–${entry.end.toFixed(6)} s · ${intervalDescription(entry.item)}` : 'No timing data at this time'}`;
    tooltip.hidden = false;
  });
  function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointer) return;
    const target = drag.element; drag = null; target.classList.remove('panning');
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(type, endDrag);
  element.addEventListener('pointerleave', hideTooltip);
  element.addEventListener('keydown', event => {
    if (timelineTypingTarget(event.target)) return;
    const span = window[1] - window[0], step = event.shiftKey ? .001 : span / 100;
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', '+', '=', '-', '_', '0'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); hideTooltip();
      if (event.key === 'Home') seek(bounds[0]);
      else if (event.key === 'End') seek(bounds[1]);
      else if (['+', '='].includes(event.key)) zoom(.5);
      else if (['-', '_'].includes(event.key)) zoom(2);
      else if (event.key === '0') fit();
      else if (event.altKey) pan((event.key === 'ArrowRight' ? 1 : -1) * span / 10);
      else seek(selected + (event.key === 'ArrowRight' ? 1 : -1) * step);
    }
  });
  }
  bindSurface(surface);
  const observer = new ResizeObserver(() => redraw()); observer.observe(surface);
  return {
    seek, zoom, pan, bindSurface,
    refreshLayout: redraw,
    update(next) {
      const reset = identity !== next.identity || mode !== next.mode;
      identity = next.identity; mode = next.mode; bounds = timelineBounds(next.bounds);
      selected = clamp(Number.isFinite(next.time) ? next.time : bounds[0], ...bounds);
      if (reset) {
        fitted = true; paintKey = ''; hideTooltip();
        if (drag) {
          const previous = drag; drag = null; previous.element.classList.remove('panning');
          if (previous.element.hasPointerCapture(previous.pointer)) previous.element.releasePointerCapture(previous.pointer);
        }
        $('timeline-clock-label').textContent = next.clockLabel || (mode === 'live' ? 'Simulation time' : 'Recorded time');
      }
      window = fitted ? [...bounds] : clampTimelineWindow(window, bounds);
      const items = next.intervals || [];
      if (reset || source !== items || sourceCount !== items.length || revision !== next.revision) {
        source = items; sourceCount = items.length; revision = next.revision;
        index = indexTimelineIntervals(items); paintKey = '';
      }
      redraw();
    },
    get snapshot() { return { expanded, mode, bounds: [...bounds], visible: [...window], selectedTime: selected, intervalCount: index.length, paints }; },
  };
}
