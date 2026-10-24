import { Raycaster, Vector2 } from 'three';
import { createGhostArms } from './ghost-arm.js';
import { onionKeyframes, onionOpacity, onionBudgets, temporalGhostColor, DEFAULT_GHOST_SETTINGS, validateGhostSettings } from './onion-skin.js';

export const ONION_STORAGE_KEY = 'motion-studio-onion-skin';
export const ONION_COLOR = 0xaeb7c2;
export const ONION_PREDICTION_COLOR = 0x34d8d4;
const cssColor = color => `#${color.toString(16).padStart(6, '0')}`;
const timeLabel = time => `${time.toFixed(3)} s`;

// The temporal pool owns all sources' keyframes and picking. Current comparison
// arms/dots stay in TrackScene, independent of the onion mode and strict budget.
export function setupOnionSkin({ robot, scene, camera, element, onSeek }) {
  const $ = id => document.getElementById(id);
  const buttons = ['live', 'replay'].map(mode => $(`${mode}-onion-skin`));
  const tooltip = $('onion-skin-tooltip');
  let ghostMode = 'off', normalVisible = true, settings = { ...DEFAULT_GHOST_SETTINGS };
  try {
    const saved = localStorage.getItem(ONION_STORAGE_KEY);
    if (['primary', 'all'].includes(saved)) ghostMode = saved;
    else if (saved === 'true') ghostMode = 'primary';
  } catch {}
  const ghosts = createGhostArms({ robot, scene, max: Infinity, method: 'prepass' });
  const cache = new Map();
  let source, poses = [], primarySelection = { step: null, times: [] };
  let timelineKeyframes = [], keyframeRevision = 0, paintKey;
  let lastPointer, pendingHover, down;
  const raycaster = new Raycaster(), pointer = new Vector2();
  const enabled = () => ghostMode !== 'off';
  const effectiveMode = () => ghostMode === 'all' && source?.mode === 'live' && source.comparisons?.length ? 'all' : enabled() ? 'primary' : 'off';

  function seek(pose) { onSeek(pose.seekTime); }
  function hideTooltip() { tooltip.hidden = true; }
  function showTooltip(pose, x, y) {
    const bounds = $('viewport').getBoundingClientRect();
    tooltip.textContent = pose.label ? `${pose.label} · ${timeLabel(pose.time)} (${timeLabel(pose.seekTime)} session)` : timeLabel(pose.time);
    tooltip.style.setProperty('--ghost-color', cssColor(pose.color ?? ONION_COLOR));
    tooltip.style.left = `${Math.min(bounds.width - 85, Math.max(0, x - bounds.left + 14))}px`;
    tooltip.style.top = `${Math.min(bounds.height - 35, Math.max(0, y - bounds.top + 14))}px`;
    tooltip.hidden = false;
  }
  function hit(event) {
    if (!enabled() || !normalVisible || !source) return null;
    const bounds = element.getBoundingClientRect();
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const picked = ghosts.pick(raycaster);
    return picked ? poses.find(pose => pose.id === picked.id) : null;
  }
  function hover(event) {
    lastPointer = event;
    if (pendingHover) return;
    pendingHover = requestAnimationFrame(() => {
      pendingHover = undefined;
      if (!lastPointer || down || lastPointer.buttons) { hideTooltip(); return; }
      const picked = hit(lastPointer);
      if (picked) {
        if (!$('limit-tint-tooltip').hidden) { hideTooltip(); return; }
        showTooltip(picked, lastPointer.clientX, lastPointer.clientY);
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
    if (event.jointEditHandled) return;
    if (press?.id === event.pointerId && !press.dragged && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 4 && press.picked) {
      const picked = hit(event);
      if (picked?.id === press.picked.id) seek(picked);
    }
  });
  element.addEventListener('pointercancel', () => { down = null; hideTooltip(); });

  function setMode(value) {
    if (!['off', 'primary', 'all'].includes(value)) throw new Error('Choose off, primary or all ghost arms.');
    ghostMode = value;
    try { localStorage.setItem(ONION_STORAGE_KEY, value); } catch {}
    paintKey = undefined; hideTooltip();
    if (source) update(source);
  }
  function toggle() {
    const modes = source?.mode === 'live' && source.comparisons?.length ? ['off', 'primary', 'all'] : ['off', 'primary'];
    setMode(modes[(modes.indexOf(effectiveMode()) + 1) % modes.length]);
  }
  buttons.forEach(button => button.addEventListener('click', toggle));
  document.addEventListener('keydown', event => {
    if (event.code !== 'KeyO' || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, select, button, textarea, a, [contenteditable="true"]')) return;
    event.preventDefault(); toggle();
  });

  function repaintTicks(visible) {
    const key = JSON.stringify([effectiveMode(), source.mode, source.trackBounds, visible.map(pose => [pose.id, pose.time, pose.seekTime, pose.color, pose.label])]);
    if (key === paintKey) return;
    paintKey = key; keyframeRevision++;
    for (const mode of ['live', 'replay']) $(`${mode}-onion-ticks`).replaceChildren();
    timelineKeyframes = enabled() ? visible.map(pose => ({ time: pose.seekTime, color: pose.color, sampleTime: pose.time, trackId: pose.sourceId })) : [];
    if (!enabled()) return;
    const [start, end] = source.trackBounds, span = end - start;
    for (const pose of visible) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'onion-tick';
      button.title = pose.label ? `${pose.label} · ${timeLabel(pose.time)}` : timeLabel(pose.time);
      button.setAttribute('aria-label', `Keyframe ${button.title}`);
      button.style.left = `${span ? 100 * (pose.seekTime - start) / span : 0}%`;
      button.style.setProperty('--ghost-color', cssColor(pose.color));
      button.addEventListener('click', event => { event.stopPropagation(); seek(pose); });
      button.addEventListener('pointerenter', event => showTooltip(pose, event.clientX, event.clientY));
      button.addEventListener('pointerleave', hideTooltip);
      $(`${source.mode}-onion-ticks`).append(button);
    }
  }
  function update(next) {
    source = next;
    const inputs = [{ ...next, id: 'primary', seekOffset: -(next.offset || 0) }];
    if (effectiveMode() === 'all') inputs.push(...(next.comparisons || []).filter(item => item.visible !== false));
    const range = next.range || next.trackBounds;
    const sources = inputs.map(item => ({ ...item,
      range: range?.map(time => Number.isFinite(time) ? time - (item.seekOffset || 0) : time) }));
    const budgets = onionBudgets(sources, settings.maxCount, settings), activeIds = new Set();
    poses = [];
    sources.forEach((item, sourceIndex) => {
      const key = item.id || `comparison-${sourceIndex}`, budget = budgets[sourceIndex];
      activeIds.add(key);
      const settingsKey = JSON.stringify([settings.spacingEnabled, settings.spacingEnabled ? settings.interval_s : null, budget, item.range, item.seekOffset || 0]);
      let cached = cache.get(key);
      if (!cached || cached.identity !== item.identity || cached.revision !== item.revision || cached.settingsKey !== settingsKey) {
        const selection = budget ? onionKeyframes(item.times, { range: item.range, spacingEnabled: settings.spacingEnabled, interval_s: settings.interval_s, maxCount: budget }) : { step: null, times: [] };
        const samples = selection.times.length ? item.states(selection.times) : [];
        const seen = new Set();
        const recorded = samples.flatMap((sample, index) => {
          if (!sample || seen.has(sample.time)) return [];
          seen.add(sample.time);
          return [{ id: `${key}:${sample.time}`, q: sample.q, time: sample.time, keyframeTime: selection.times[index] }];
        });
        cached = { identity: item.identity, revision: item.revision, settingsKey, selection, recorded }; cache.set(key, cached); hideTooltip();
      }
      if (sourceIndex === 0) primarySelection = cached.selection;
      for (const pose of cached.recorded) poses.push({ ...pose, sourceId: key, jointNames: item.jointNames, base: item.base,
        color: item.color ?? ONION_COLOR, displayColor: temporalGhostColor(pose.time, item.range, item.color ?? ONION_COLOR), cursor: item.cursor, bounds: item.bounds, range: item.range, hideCursor: item.hideCursor, reveal: item.reveal,
        seekTime: pose.time + (item.seekOffset || 0), label: sourceIndex ? item.label : undefined });
    });
    for (const key of cache.keys()) if (!activeIds.has(key)) cache.delete(key);
    const visible = poses.filter(pose => pose.reveal == null || pose.time <= pose.reveal);
    const displayed = enabled() && normalVisible ? visible.map(pose => ({ ...pose, color: pose.displayColor, opacity: onionOpacity(pose.time, pose.cursor, pose.range, { ...settings, hideCursor: pose.hideCursor }) })) : [];
    ghosts.set(displayed); ghosts.update(camera); repaintTicks(visible);
    const count = displayed.filter(pose => pose.opacity > 0).length, mode = effectiveMode();
    const title = `Ghost arms · ${mode === 'off' ? 'off' : mode === 'all' ? 'all tracks' : next.mode === 'live' ? 'Live only' : 'on'} · ${count}/${settings.maxCount}${settings.spacingEnabled && primarySelection.step ? ` · every ${Number(primarySelection.step.toPrecision(6))} s` : settings.spacingEnabled ? '' : ' · evenly distributed'} (O)`;
    buttons.forEach(button => {
      button.setAttribute('aria-pressed', String(enabled())); button.setAttribute('data-ghost-mode', mode); button.title = title;
    });
  }
  buttons.forEach(button => button.setAttribute('aria-pressed', String(enabled())));
  return {
    pick: raycaster => enabled() && normalVisible && source ? ghosts.pick(raycaster) : null,
    update, setMode, cycle: toggle, get mode() { return effectiveMode(); }, get settings() { return { ...settings }; },
    setSettings(value) { settings = validateGhostSettings({ ...settings, ...value }); if (source) update(source); },
    setVisible(value) { normalVisible = value; if (source) update(source); }, sort: viewCamera => ghosts.update(viewCamera), setBase: () => ghosts.setBase(),
    get timeline() { return { keyframes: timelineKeyframes, keyframeRevision }; },
    get snapshot() { return { enabled: enabled(), mode: effectiveMode(), settings: { ...settings }, step: primarySelection.step,
      keyframeTimes: primarySelection.times.slice(), snappedTimes: poses.map(pose => pose.time),
      opacities: enabled() && source ? poses.map(pose => pose.reveal != null && pose.time > pose.reveal ? 0 : onionOpacity(pose.time, pose.cursor, pose.range, { ...settings, hideCursor: pose.hideCursor })) : [],
      poses: poses.map(pose => ({ id: pose.id, sourceId: pose.sourceId, time: pose.time, sessionTime: pose.seekTime, color: pose.color, displayColor: pose.displayColor })),
      ghostCount: ghosts.snapshot.count, renderer: ghosts.snapshot }; },
  };
}
