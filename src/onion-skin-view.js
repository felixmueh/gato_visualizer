import { Raycaster, Vector2 } from 'three';
import { createGhostArms } from './ghost-arm.js';
import { onionKeyframes, onionOpacity } from './onion-skin.js';

export const ONION_STORAGE_KEY = 'motion-studio-onion-skin';
export const ONION_COLOR = 0xaeb7c2;
export const ONION_PREDICTION_COLOR = 0x34d8d4;
const cssColor = color => `#${color.toString(16).padStart(6, '0')}`;
const timeLabel = time => `${time.toFixed(3)} s`;

// Owns presentation only. The caller supplies immutable recorded sample holds
// and cursor/track clocks; neither seeking nor toggling requests computation.
export function setupOnionSkin({ robot, scene, camera, element, onSeek }) {
  const $ = id => document.getElementById(id);
  const buttons = ['live', 'replay'].map(mode => $(`${mode}-onion-skin`));
  const tooltip = $('onion-skin-tooltip');
  let enabled = false, normalVisible = true;
  try { enabled = localStorage.getItem(ONION_STORAGE_KEY) === 'true'; } catch {}
  // The opt-in laptop spike records a per-browser rendering decision.
  let decision;
  try { const result = JSON.parse(localStorage.getItem('motion-studio-onion-spike-result')); if (result?.complete && result.decision?.passed) decision = result.decision; } catch {}
  const layer = decision?.includeAuxiliary === false ? 1 : 0;
  camera.layers.enable(1);
  const ghosts = createGhostArms({ robot, scene, max: 24, method: decision?.method === 'prepass' ? 'prepass' : 'flat', layer });
  let source, identity, revision, selection = { step: null, times: [] }, poses = [];
  let timelineKeyframes = [], keyframeRevision = 0, paintKey;
  let lastPointer, pendingHover, down;
  const raycaster = new Raycaster(), pointer = new Vector2();
  raycaster.layers.enable(1);

  function seek(time) { if (source) onSeek(time - (source.offset || 0)); }
  function hideTooltip() { tooltip.hidden = true; }
  function showTooltip(time, x, y) {
    const bounds = $('viewport').getBoundingClientRect();
    tooltip.textContent = timeLabel(time);
    tooltip.style.setProperty('--ghost-color', cssColor(source?.color ?? ONION_COLOR));
    tooltip.style.left = `${Math.min(bounds.width - 85, Math.max(0, x - bounds.left + 14))}px`;
    tooltip.style.top = `${Math.min(bounds.height - 35, Math.max(0, y - bounds.top + 14))}px`;
    tooltip.hidden = false;
  }
  function hit(event) {
    if (!enabled || !normalVisible || !source) return null;
    const bounds = element.getBoundingClientRect();
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return ghosts.pick(raycaster);
  }
  function hover(event) {
    lastPointer = event;
    if (pendingHover) return;
    pendingHover = requestAnimationFrame(() => {
      pendingHover = undefined;
      if (!lastPointer || down || lastPointer.buttons) { hideTooltip(); return; }
      const picked = hit(lastPointer);
      if (picked) {
        // Registered after the solid link handler, whose tooltip takes priority.
        if (!$('limit-tint-tooltip').hidden) { hideTooltip(); return; }
        showTooltip(picked.time, lastPointer.clientX, lastPointer.clientY);
      } else hideTooltip();
    });
  }
  element.addEventListener('pointermove', event => {
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) >= 4) down.dragged = true;
    hover(event);
  });
  element.addEventListener('pointerleave', () => { lastPointer = null; hideTooltip(); });
  element.addEventListener('pointerdown', event => {
    hideTooltip();
    if (event.button === 0) down = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false, picked: hit(event) };
  });
  element.addEventListener('pointerup', event => {
    const press = down; down = null;
    if (press?.id === event.pointerId && !press.dragged && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 4 && press.picked) {
      const picked = hit(event);
      if (picked?.id === press.picked.id) seek(picked.time);
    }
  });
  element.addEventListener('pointercancel', () => { down = null; hideTooltip(); });

  function toggle() {
    enabled = !enabled;
    try { localStorage.setItem(ONION_STORAGE_KEY, String(enabled)); } catch {}
    paintKey = undefined; hideTooltip();
    if (source) update(source);
  }
  buttons.forEach(button => button.addEventListener('click', toggle));
  document.addEventListener('keydown', event => {
    if (event.code !== 'KeyO' || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, select, button, textarea, a, [contenteditable="true"]')) return;
    event.preventDefault(); toggle();
  });

  function repaintTicks(visible) {
    const key = JSON.stringify([enabled, source.mode, source.trackBounds, visible.map(pose => [pose.id, pose.time]), source.color]);
    if (key === paintKey) return;
    paintKey = key; keyframeRevision++;
    for (const mode of ['live', 'replay']) $(`${mode}-onion-ticks`).replaceChildren();
    timelineKeyframes = enabled ? visible.map(pose => ({ time: pose.time - (source.offset || 0), color: source.color, sampleTime: pose.time })) : [];
    if (!enabled) return;
    const [start, end] = source.trackBounds, span = end - start;
    for (const pose of visible) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'onion-tick';
      button.title = timeLabel(pose.time); button.setAttribute('aria-label', `Keyframe ${timeLabel(pose.time)}`);
      button.style.left = `${span ? 100 * (pose.time - (source.offset || 0) - start) / span : 0}%`;
      button.style.setProperty('--ghost-color', cssColor(source.color));
      button.addEventListener('click', event => { event.stopPropagation(); seek(pose.time); });
      button.addEventListener('pointerenter', event => showTooltip(pose.time, event.clientX, event.clientY));
      button.addEventListener('pointerleave', hideTooltip);
      $(`${source.mode}-onion-ticks`).append(button);
    }
  }
  function update(next) {
    source = next;
    const reset = identity !== next.identity;
    if (reset || revision !== next.revision) {
      selection = onionKeyframes(next.times, { previousStep: next.mode === 'live' && !reset ? selection.step : undefined });
      const samples = next.states(selection.times);
      const seen = new Set();
      poses = samples.flatMap((sample, i) => {
        if (!sample || seen.has(sample.time)) return [];
        seen.add(sample.time);
        return [{ id: `${i}:${sample.time}`, q: sample.q, jointNames: next.jointNames, time: sample.time, keyframeTime: selection.times[i], color: next.color }];
      });
      identity = next.identity; revision = next.revision; hideTooltip();
    }
    const visible = poses.filter(pose => next.reveal == null || pose.time <= next.reveal);
    const displayed = enabled && normalVisible ? visible.map(pose => ({ ...pose, opacity: onionOpacity(pose.time, next.cursor, next.bounds) })) : [];
    ghosts.set(displayed); ghosts.update(camera); repaintTicks(visible);
    const count = displayed.filter(pose => pose.opacity > 0).length;
    const title = `Onion skin · ${count} ghost arms${selection.step ? ` · every ${Number(selection.step.toPrecision(6))} s` : ''}${enabled ? '' : ' · off'} (O)`;
    buttons.forEach(button => { button.setAttribute('aria-pressed', String(enabled)); button.title = title; });
  }
  buttons.forEach(button => { button.setAttribute('aria-pressed', String(enabled)); });
  return {
    update, setVisible(value) { normalVisible = value; if (source) update(source); }, sort: viewCamera => ghosts.update(viewCamera), setBase: () => ghosts.setBase(),
    get timeline() { return { keyframes: timelineKeyframes, keyframeRevision }; },
    get snapshot() { return { enabled, step: selection.step, keyframeTimes: selection.times.slice(), snappedTimes: poses.map(pose => pose.time), opacities: enabled && source ? poses.map(pose => source.reveal != null && pose.time > source.reveal ? 0 : onionOpacity(pose.time, source.cursor, source.bounds)) : [], ghostCount: ghosts.snapshot.count, renderer: ghosts.snapshot }; },
  };
}
