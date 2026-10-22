import { createFloatingDialog } from './floating-dialog.js';
import { createPlotState, timelineEligible, awaitPlotJob, displayLimits, episodeFrame } from './plot-state.js';
import { aggregateBounded, aggregateLabel } from './expanded-timeline.js';
import { renderPlot } from './plot-renderer.js';
import { sourceRequest } from './source-settings.js';
import { setupSolveRun } from './solve-run.js';
import { createIterationPathCache, iterationPredictionForView } from './prediction-selection.js';

/** One host for both inspectors. Only the episode timeline owns a playback clock. */
export function setupPlotInspection({ episodeContainer, solveContainer, bottomContainer, getSource, getView, getSolverProfile = () => null, onSeek, onPrediction = () => {}, onInspectionStart = () => {}, onClearAggregate = () => {}, request = sourceRequest, storage = globalThis.localStorage } = {}) {
  const doc = episodeContainer.ownerDocument;
  const el = (tag, text, cls) => { const item = doc.createElement(tag); if (text != null) item.textContent = text; if (cls) item.className = cls; return item; };
  const button = (text, action, title = text) => { const item = el('button', text); item.type = 'button'; item.title = title; item.setAttribute('aria-label', title); item.addEventListener('click', action); return item; };
  let saved; try { saved = JSON.parse(storage?.getItem('plot-inspection-v1') || '{}'); } catch { saved = {}; }
  const state = createPlotState(saved, value => { try { storage?.setItem('plot-inspection-v1', JSON.stringify(value)); } catch {} });
  const client = `plots-${Date.now().toString(36)}`;
  let lastSourceKey, evaluatedKeys = {}, inspectedKey, lastInspectActive, activeConfig;
  let catalogs = { episode: [], solve: [] }, metadata = {}, specs = new Map(), handles = [], revision = 0, busy = false, pending = false, lastRequest = '', lastPoll = -Infinity, lastRender = '', lastPrediction = '', pinnedSource, drag, destroyed = false;
  const presentations = new Map(), cardHandles = new Map();
  let catalogHandles = [], previewKey, previewToken = 0, previewSpecs = new Map(), resizing = null;
  let solveOverride = null, lastSolveSourceKey;
  let finalContextKey, finalContextPrediction;
  // Recorded iteration paths of the selected Solve, prefetched in bounded
  // chunks so scrubbing the SQP cursor needs no request per iteration.
  const iterationPaths = createIterationPathCache();
  let held = null, heldKey, pathsInFlight = false, pathsFailedKey;
  let cardsPending = false, lastCardsAt = -Infinity, immediateView = false, placementKey = '', receivedData = false;
  const visible = container => { for (let node = container; node; node = node.parentElement) if (node.hidden) return false; return true; };
  const solveVisible = () => getView().inspectSolve !== false && visible(solveContainer);
  const solveNeeded = () => solveVisible() || state.pinned || Boolean(solveOverride) || catalogDialog.isOpen && catalogScope === 'solve';
  const episodeNeeded = () => visible(episodeContainer) || visible(bottomContainer) && state.instances.some(item => item.context === 'episode' && item.timeline) || catalogDialog.isOpen && catalogScope === 'episode';
  // Finish an explicit scrub/keyboard/zoom gesture at its exact final range.
  // Ordinary playback only moves markers at RAF; expensive SVG rebuilds run at 5 Hz.
  const finishViewGesture = () => { immediateView = true; };
  const viewGestureEvents = ['pointerup', 'change', 'keyup', 'wheel'];
  for (const event of viewGestureEvents) doc.addEventListener(event, finishViewGesture);
  const sourceKey = source => source ? JSON.stringify([source.kind, source.generation, source.id, source.trajectory_index, source.revision]) : '';
  const solveSource = () => solveOverride || (state.pinned && pinnedSource ? { source: pinnedSource, solveSeq: state.selected?.seq ?? state.selected?.id } : getSource());
  // The aggregate window is chosen on the expanded timeline; this chip only mirrors it.
  const heading = el('div', null, 'plot-inspector-heading'), windowChip = el('span', null, 'aggregate-window'), windowText = el('span');
  const windowClear = button('×', () => onClearAggregate(), 'Clear aggregate window'); windowChip.append(windowText, windowClear);
  heading.append(windowChip, button('+', () => openCatalog('episode'), 'Add episode plot or aggregate'));
  let windowKey;
  function renderWindowChip() {
    const view = getView(), aggregate = view.aggregate, episode = view.episodeClock !== false && metadata.episode?.context?.episode_available !== false;
    const key = JSON.stringify([aggregate, episode]); if (key === windowKey) return; windowKey = key;
    const bounded = episode && aggregateBounded(aggregate);
    windowText.textContent = episode ? aggregateLabel(aggregate) : 'All available history';
    windowChip.classList.toggle('bounded', bounded); windowClear.hidden = !bounded;
    windowChip.title = episode ? `Episode aggregates and plots use ${bounded ? 'this' : 'the entire'} window. Set it on the expanded timeline: Shift-drag, or drag its edge handles; an end at the data edge is unbounded and follows new data.` : 'The active timeline is a prediction horizon; episode plots use all available history.';
  }
  const episodeNote = el('p', '', 'plot-message'), episodeCards = el('div', null, 'plot-cards'); episodeContainer.replaceChildren(heading, episodeNote, episodeCards);
  const solveHeading = el('div', null, 'plot-inspector-heading'), pin = button('Pin solve', () => { if (solveOverride) clearInspection(); else { if (state.pinned) runAgain.invalidateAdoption(); state.pin(!state.pinned); pinnedSource = state.pinned ? structuredClone(getSource()?.source) : null; invalidate(); } });
  pin.setAttribute('aria-pressed', 'false'); solveHeading.append(pin, button('+', () => openCatalog('solve'), 'Add solve plot'));
  const identity = el('p', '', 'solve-identity'), strip = el('div', null, 'sqp-strip'), iterationLabel = el('span'), previous = button('‹', () => stepIteration(-1), 'Previous recorded SQP iteration'), next = button('›', () => stepIteration(1), 'Next recorded SQP iteration'), slider = el('input');
  slider.type = 'range'; slider.step = '1'; slider.min = '0'; slider.setAttribute('aria-label', 'Recorded SQP iteration'); slider.addEventListener('input', () => selectIteration(Number(slider.value)));
  strip.append(previous, iterationLabel, next, slider);
  const final = button('Final result', () => { state.selectIteration(null); reselect(); });
  strip.append(final);
  const capability = el('p', '', 'plot-message'), runContainer = el('div');
  const solveCards = el('div', null, 'plot-cards'); solveContainer.replaceChildren(solveHeading, identity, strip, capability, runContainer, solveCards);
  const runAgain = setupSolveRun({ container: runContainer, request,
    onStart: () => { onInspectionStart(); pinnedSource = structuredClone(solveSource()?.source); state.pin(true); invalidate(); },
    onComplete: result => setInspection(result),
  });
  // The strip header carries no text. With rows it is a thin handle: drag it
  // to change how much height the rows may take. While an eligible plot is
  // dragged, the whole strip outlines itself as the drop zone.
  const bottomTitle = el('div', null, 'timeline-plot-hint'), bottomCards = el('div', null, 'timeline-plot-rows'); bottomContainer.replaceChildren(bottomTitle, bottomCards);
  const showDropZone = active => { bottomContainer.classList.toggle('timeline-drop-ready', active); if (!active) bottomContainer.classList.toggle('timeline-drop-over', false); };
  // Capture: the strip's own drop handler stops propagation and rebuilds the dragged card.
  const hideDropZone = () => showDropZone(false);
  for (const event of ['dragend', 'drop']) doc.addEventListener(event, hideDropZone, true);
  bottomContainer.addEventListener('dragleave', event => { if (!bottomContainer.contains?.(event.relatedTarget)) bottomContainer.classList.toggle('timeline-drop-over', false); });
  for (const [label, amount] of [['↑', -100], ['↓', 100]]) bottomTitle.append(button(label, () => bottomCards.scrollBy({ top: amount, behavior: 'smooth' }), `Scroll timeline plot rows ${amount < 0 ? 'up' : 'down'}`));
  const applyStripHeight = () => { bottomCards.style.maxHeight = state.timelineHeight ? `${state.timelineHeight}px` : ''; };
  applyStripHeight();
  bottomTitle.addEventListener('pointerdown', event => {
    if (!bottomCards.children.length || event.target.closest?.('button') || event.button != null && event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const start = event.clientY, initial = bottomCards.getBoundingClientRect().height || state.timelineHeight || 290;
    dragResize(event, next => { state.timelineHeight = initial + start - next.clientY; applyStripHeight(); });
  });
  /** Document-owned vertical drag that survives card rebuilds. */
  function dragResize(event, onMove, onEnd = () => {}) {
    const pointerId = event.pointerId;
    const move = next => { if (next.pointerId !== pointerId) return; next.preventDefault?.(); onMove(next); };
    const finish = next => { if (next.pointerId !== pointerId) return; doc.removeEventListener('pointermove', move); doc.removeEventListener('pointerup', finish); doc.removeEventListener('pointercancel', finish); resizing = null; onEnd(); };
    resizing = { cancel: () => finish({ pointerId }) };
    doc.addEventListener('pointermove', move); doc.addEventListener('pointerup', finish); doc.addEventListener('pointercancel', finish);
  }
  bottomContainer.addEventListener('dragover', event => { if (drag && eligible(drag.id)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; bottomContainer.classList.toggle('timeline-drop-over', true); } });
  bottomContainer.addEventListener('drop', event => { if (!drag || !eligible(drag.id)) return; event.preventDefault(); event.stopPropagation(); state.place(drag.id, true); const target = event.target.closest?.('[data-instance]'); if (target) state.reorder(drag.id, target.dataset.instance); drag.accepted = true; renderCards(); });
  function setupDropList(list, context) {
    list.addEventListener('dragover', event => { if (drag && state.instances.find(item => item.id === drag.id)?.context === context) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } });
    list.addEventListener('drop', event => { if (!drag) return; event.preventDefault(); const target = event.target.closest?.('[data-instance]'); state.reorder(drag.id, target?.dataset.instance); if (drag.from === 'timeline') state.place(drag.id, false); drag.accepted = true; renderCards(); });
  }
  setupDropList(episodeCards, 'episode'); setupDropList(solveCards, 'solve');
  const catalogBody = el('div'), search = el('input'), catalogList = el('div', null, 'plot-catalog-list'), catalogNote = el('p', '', 'plot-message');
  search.type = 'search'; search.placeholder = 'Search plots'; search.setAttribute('aria-label', 'Search plot catalog'); catalogBody.append(search, catalogNote, catalogList);
  const catalogDialog = createFloatingDialog({ id: 'plot-catalog', title: 'Add plot', content: catalogBody }); let catalogScope = 'episode';
  search.addEventListener('input', renderCatalog);
  function openCatalog(scope) { catalogScope = scope; search.value = ''; renderCatalog(); catalogDialog.open(); search.focus(); refresh(true); }
  function renderCatalog() {
    catalogHandles.forEach(handle => handle.destroy()); catalogHandles = [];
    catalogList.replaceChildren(); catalogNote.textContent = metadata[catalogScope]?.errors?.map(error => typeof error === 'string' ? error : error.error || error.message).join('\n') || '';
    for (const definition of catalogs[catalogScope]) {
      if (!`${definition.title} ${definition.description || ''}`.toLowerCase().includes(search.value.toLowerCase())) continue;
      const row = el('section', null, 'plot-catalog-item'), head = el('header');
      head.append(el('strong', definition.title), button('Add', () => { state.add(definition, catalogScope); invalidate(); }, `Add ${definition.title}`)); row.append(head);
      // A preview with default inputs on the active source shows what the plot is.
      const preview = el('div', null, 'plot-catalog-preview'), spec = previewSpecs.get(definition.id);
      if (definition.available === false) preview.append(el('p', `Unavailable: ${(definition.missing || []).join(', ')}`, 'plot-message'));
      else if (spec) catalogHandles.push(renderPlot(preview, spec, { hideTitle: true, notes: false, height: 90 }));
      row.append(preview);
      if (definition.description) row.append(el('p', definition.description));
      catalogList.append(row);
    }
    if (!catalogList.children.length) catalogList.append(el('p', 'No matching plots. Reload plotters in Settings › Backend.', 'plot-message'));
    loadPreviews();
  }
  /** Evaluate each catalog plot once per opened source on its own job channel. */
  async function loadPreviews() {
    const scope = catalogScope, definitions = catalogs[scope].filter(definition => definition.available !== false), body = payload(scope);
    if (!catalogDialog.isOpen || !definitions.length || !body.source) return;
    // Previews use the aggregate window, so they show what an added plot will show.
    const key = JSON.stringify([scope, sourceKey(body.source), scope === 'episode' ? [body.range?.start_s, body.range?.end_s] : null, definitions.map(definition => definition.id)]);
    if (key === previewKey) return;
    previewKey = key; const token = ++previewToken;
    const alive = () => !destroyed && token === previewToken && catalogDialog.isOpen && catalogScope === scope;
    try {
      const response = await awaitPlotJob(request, '/api/plots/evaluate', { ...body, client_id: `${client}-catalog`, pixels: 320, plots: definitions.map(definition => ({ instance_id: `preview:${definition.id}`, plot_id: definition.id, inputs: defaultInputs(definition) })) }, { alive });
      if (!response || !alive()) { if (token === previewToken) previewKey = undefined; return; }
      previewSpecs = new Map((response.results || []).map(result => [result.instance_id.replace(/^preview:/, ''), result.spec || { version: 1, kind: 'unavailable', title: 'Plot error', message: result.error || 'Plot failed.' }]));
      renderCatalog();
    } catch { if (token === previewToken) previewKey = undefined; }
  }
  const defaultInputs = definition => Object.fromEntries(Object.entries(definition.inputs || definition.controls || {}).map(([key, value]) => [key, value.default]));
  const definitionFor = item => catalogs[item.context].find(definition => definition.id === item.plot_id);
  function eligible(id) { const item = state.instances.find(item => item.id === id), spec = specs.get(id); return getView().episodeClock !== false && item?.context === 'episode' && timelineEligible({ ...definitionFor(item), scope: 'episode' }, spec) && Boolean(spec?.x?.clock) && spec.x.clock === metadata.episode?.context?.clock; }
  function configure(item) {
    activeConfig?.destroy();
    const definition = definitionFor(item), spec = specs.get(item.id); const body = el('form', null, 'plot-config-form'), fields = [];
    // Settings may explain more than the compact card does.
    const details = [definition?.description, ...(spec?.notes || []), ...reductionNotes(spec)].filter(Boolean);
    if (details.length) body.append(el('p', details.join('\n'), 'plot-message plot-config-details'));
    for (const [name, schema] of Object.entries(definition?.inputs || definition?.controls || {})) {
      const label = el('label', `${schema.label || name}${schema.unit ? ` (${schema.unit})` : ''}`), input = el(['joint', 'choice'].includes(schema.type) ? 'select' : 'input');
      if (schema.type === 'joint' || schema.type === 'choice') {
        const choices = schema.type === 'joint' ? (metadata[item.context]?.context?.joint_names || []) : schema.choices;
        for (const choice of choices || []) { const value = typeof choice === 'object' ? choice.value : choice, option = el('option', typeof choice === 'object' ? choice.label : String(choice)); option.value = String(value); input.append(option); }
        input.value = String(item.parameters[name] ?? schema.default);
      } else if (schema.type === 'boolean') { input.type = 'checkbox'; input.checked = item.parameters[name] ?? schema.default; }
      else { input.type = 'number'; input.step = 'any'; if (schema.min != null) input.min = schema.min; if (schema.max != null) input.max = schema.max; input.value = item.parameters[name] ?? schema.default; input.required = true; }
      label.append(input); if (schema.description) label.append(el('small', schema.description)); body.append(label); fields.push({ name, schema, input });
    }
    // Every plotted graph shares viewer-side y limits. Empty sides stay automatic.
    let display;
    if (!['table', 'spans', 'unavailable'].includes(spec?.kind)) {
      const limits = displayLimits(item.display), group = el('section', null, 'plot-display-limits'), legendText = el('h3', 'Y axis');
      const side = (text, value) => { const label = el('label', text), input = el('input'); input.type = 'number'; input.step = 'any'; input.placeholder = 'auto'; input.value = value ?? ''; label.append(input); return { label, input }; };
      const bottom = side('Bottom', limits.min), top = side('Top', limits.max), clip = el('label', null, 'plot-display-clip'), clipInput = el('input');
      clipInput.type = 'checkbox'; clipInput.checked = limits.clipOutliers; clip.title = 'Fit automatic sides to the 1st–99th percentile of visible samples';
      clip.append(clipInput, el('span', 'Clip outliers'));
      const check = () => top.input.setCustomValidity?.(bottom.input.value !== '' && top.input.value !== '' && Number(bottom.input.value) >= Number(top.input.value) ? 'Top must be above bottom.' : '');
      bottom.input.addEventListener('input', check); top.input.addEventListener('input', check);
      group.append(legendText, bottom.label, top.label, clip); body.append(group);
      display = () => displayLimits({ min: bottom.input.value, max: top.input.value, clipOutliers: clipInput.checked });
    }
    if (!fields.length && !display) body.append(el('p', 'This plot has no configurable inputs.'));
    const apply = el('button', 'Apply'); apply.type = 'submit'; body.append(apply);
    const dialog = createFloatingDialog({ id: `config-${item.id}`, title: definition?.title || item.plot_id, content: body, onClose: () => { dialog.destroy(); if (activeConfig === dialog) activeConfig = null; } }); activeConfig = dialog;
    body.addEventListener('submit', event => { event.preventDefault(); const parameters = {}; for (const { name, schema, input } of fields) parameters[name] = schema.type === 'boolean' ? input.checked : schema.type === 'number' ? Number(input.value) : input.value; state.configure(item.id, parameters, display?.()); dialog.close(); invalidate(); }); dialog.open();
  }
  function renderCards(immediate = true) {
    if (!immediate && Date.now() - lastCardsAt < 200) { cardsPending = true; return; }
    cardsPending = false; lastCardsAt = Date.now();
    handles.forEach(handle => handle.destroy({ preserveInteraction: true })); handles = []; cardHandles.clear(); episodeCards.replaceChildren(); solveCards.replaceChildren(); bottomCards.replaceChildren();
    const usedPresentations = new Set();
    for (const item of state.instances) {
      const definition = definitionFor(item), spec = specs.get(item.id);
      for (const placement of ['sidebar', ...(item.timeline && eligible(item.id) ? ['timeline'] : [])]) {
        const sidebarVisible = item.context === 'solve' ? solveVisible() : visible(episodeContainer);
        if (placement === 'sidebar' && !sidebarVisible || placement === 'timeline' && !visible(bottomContainer)) continue;
        const card = el('section', null, 'plot-card'); card.dataset.instance = item.id;
        // Notes and descriptions are secondary: they appear on hover only.
        const title = el('header', null, 'plot-card-heading'), grip = el('span', spec?.title || definition?.title || item.plot_id, 'plot-card-grip'); grip.draggable = true;
        grip.title = [spec?.title || definition?.title || item.plot_id, definition?.description, ...(spec?.notes || []), ...reductionNotes(spec), placement === 'timeline' ? 'Drag out to remove from the timeline' : 'Drag to reorder or onto the timeline'].filter(Boolean).join('\n');
        grip.addEventListener('dragstart', event => { drag = { id: item.id, from: placement, accepted: false }; event.dataTransfer.setData('text/plain', item.id); event.dataTransfer.effectAllowed = 'move'; showDropZone(placement === 'sidebar' && eligible(item.id) && visible(bottomContainer)); });
        grip.addEventListener('dragend', () => { if (drag?.from === 'timeline' && !drag.accepted) { state.place(item.id, false); renderCards(); } drag = null; }); title.append(grip);
        // Timeline rows carry unit and legend in their title row.
        const legendTarget = placement === 'timeline' ? el('div', null, 'plot-card-legend') : null;
        if (legendTarget) title.append(legendTarget);
        if (placement === 'sidebar') {
          if (eligible(item.id)) { const show = button('↧', () => { state.place(item.id, !item.timeline); renderCards(); }, item.timeline ? 'Hide from timeline' : 'Show on timeline'); show.className = 'plot-timeline-toggle'; show.setAttribute('aria-pressed', String(item.timeline)); title.append(show); }
          title.append(button('⚙', () => configure(item), 'Configure plot'), button('⧉', () => { state.duplicate(item.id); invalidate(); }, 'Duplicate plot'), button('×', () => { state.remove(item.id); specs.delete(item.id); invalidate(); }, 'Remove plot'));
        } else title.append(button('×', () => { state.place(item.id, false); renderCards(); }, 'Remove timeline placement'));
        card.append(title);
        const graph = el('div', null, 'plot-card-body'); card.append(graph);
        if (spec) {
          const view = getView(), linked = placement === 'timeline', episodeTime = spec.x?.identity === 'episode_time';
          const bounds = metadata.episode?.context?.bounds;
          const { window, reveal } = episodeTime ? episodeFrame({ linked, view, bounds }) : {};
          const cursor = spec.x?.identity === 'sqp_iteration' ? state.iteration : episodeTime && view.episodeClock !== false ? view.cursor : undefined;
          const key = `${item.id}:${placement}`; usedPresentations.add(key);
          if (!presentations.has(key)) presentations.set(key, {});
          // A following window can move while Live grows. Only a duration
          // change (zoom), source, scope or plot configuration resets the fit.
          const fitKey = [item.context === 'solve' ? lastSolveSourceKey : lastSourceKey, item.parameters, episodeTime ? [linked ? 'timeline' : view.aggregate ?? null, linked ? view.window?.[1] - view.window?.[0] : null] : state.selected?.id];
          const handle = renderPlot(graph, spec, { compact: linked, linked, hideTitle: true, notes: false, legendTarget, height: state.height(item.id, placement), yLimits: item.display ? displayLimits(item.display) : undefined, presentation: presentations.get(key), fitKey, window, reveal, cursor, onSeek: episodeTime && view.episodeClock !== false ? onSeek : spec.x?.identity === 'sqp_iteration' ? x => selectIterationByIndex(x) : undefined });
          if (episodeTime) handle.episodeLinked = linked;
          handles.push(handle); cardHandles.set(key, handle);
          if (['lines', 'bars', 'spans'].includes(spec.kind)) card.append(resizeHandle(item, placement, key, linked ? 85 : 170));
        }
        else graph.append(el('p', 'Waiting for plot data…', 'plot-message'));
        (placement === 'timeline' ? bottomCards : item.context === 'episode' ? episodeCards : solveCards).append(card);
      }
    }
    for (const [key, presentation] of presentations) if (!usedPresentations.has(key)) { presentation.cancelScrub?.(); presentations.delete(key); }
    bottomTitle.classList.toggle('resizable', bottomCards.children.length > 0);
    bottomTitle.title = bottomCards.children.length ? 'Drag to resize the timeline plots' : '';
    renderSolve(); lastRender = JSON.stringify([getView().window, getView().aggregate ?? null]);
  }
  function resizeHandle(item, placement, key, fallback) {
    const grip = el('div', null, 'plot-resize-handle'); grip.title = 'Drag to resize';
    grip.addEventListener('pointerdown', event => {
      if (event.button != null && event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const start = event.clientY, initial = state.height(item.id, placement) ?? fallback;
      dragResize(event, next => { state.resize(item.id, placement, initial + next.clientY - start, false); cardHandles.get(key)?.setView({ height: state.height(item.id, placement) }); },
        () => { state.resize(item.id, placement, state.height(item.id, placement)); renderCards(); });
    });
    return grip;
  }
  function reductionNotes(spec) { return (spec?.display_reduction || []).map(item => `Display shows ${item.displayed} of ${item.original} points${item.series ? ` of ${item.series}` : ''}; peaks and gaps kept.`); }
  function renderSolve() {
    const selected = state.selected, records = selected?.iterations || [], index = records.findIndex(item => item.index === state.iteration);
    const finalKey = selected ? JSON.stringify([lastSolveSourceKey, selected.id]) : null;
    if (finalKey !== finalContextKey) { finalContextKey = finalKey; finalContextPrediction = null; }
    // Concrete-iteration responses intentionally omit the final trajectory.
    // Retain only this solve's real final snapshot as labelled display context.
    if (selected?.final_prediction?.ee_xyz?.length) finalContextPrediction = structuredClone(selected.final_prediction);
    solveContainer.classList.toggle('solve-pinned', state.pinned); pin.textContent = solveOverride ? 'Follow episode' : state.pinned ? 'Follow cursor' : 'Pin solve'; pin.setAttribute('aria-label', pin.textContent); pin.title = pin.textContent; pin.setAttribute('aria-pressed', String(state.pinned)); pin.disabled = !selected && !solveOverride;
    identity.textContent = selected ? `${state.pinned ? 'Pinned · ' : ''}${selected.origin === 'preview' ? 'Preview' : 'Solve'} ${selected.seq ?? selected.id}${Number.isFinite(selected.sim_time_s ?? selected.time_s) ? ` · ${(selected.sim_time_s ?? selected.time_s).toFixed(3)} s` : ''}${metadata.solve?.context?.association ? ` · ${metadata.solve.context.association}` : ''}` : 'No recorded solve associated with the episode cursor.';
    if (selected) { const source = solveSource()?.source; identity.textContent += ` · ${source?.kind}:${source?.id ?? source?.generation ?? 'current'}${source?.trajectory_index != null ? `/${source.trajectory_index}` : ''}`; }
    if (solveOverride) {
      const result = solveOverride.result, provenance = selected?.provenance || {}, actualProfile = provenance.solver_profile?.profile?.id || provenance.solver_profile?.id || result.actual_solver_profile?.profile?.id || result.profile_id;
      const originalProfile = provenance.original_solver_profile?.profile?.id || provenance.original_solver_profile?.id;
      const original = provenance.original?.source || result.original?.source;
      identity.textContent = `Pinned · Fresh / cold · inspection ${solveOverride.source.id} · solver profile ${actualProfile || 'recorded in result'} · original ${original?.kind || 'recorded'}:${original?.id ?? original?.generation ?? 'captured'} Solve ${provenance.original?.solve_id ?? result.original_solve_id ?? 'captured'}${originalProfile ? ` · original solver profile ${originalProfile}` : ''}`;
    }
    strip.hidden = !records.length; slider.max = String(Math.max(0, records.length - 1)); slider.value = String(Math.max(0, index)); slider.disabled = !records.length; previous.disabled = index <= 0; next.disabled = index >= records.length - 1; final.disabled = state.iteration == null;
    const current = records[index]; iterationLabel.textContent = current ? `${current.index === 0 ? 'Seed' : `SQP ${current.index}`} · ${index + 1} of ${records.length} recorded${current.status ? ` · ${current.status}` : ''}` : 'Final result';
    // A recorded snapshot comes from the prefetched paths or the plot response.
    // While one is still on its way the previous trajectory stays on screen.
    // A metrics-only iteration has no snapshot: the selected solve's final plan
    // is shown only as labelled context, never attached to the iteration.
    iterationPaths.reset(finalKey);
    const snapshot = selected?.selected_iteration === state.iteration ? selected?.selected_prediction : null;
    if (selected?.selected_iteration != null) iterationPaths.addSnapshot(finalKey, selected.selected_iteration, selected.selected_prediction);
    const finalPrediction = selected?.final_prediction?.ee_xyz?.length ? selected.final_prediction : finalContextPrediction;
    const shown = iterationPredictionForView({ iteration: state.iteration, record: current, snapshot, cached: iterationPaths.get(state.iteration), finalPrediction, finalContext: finalContextPrediction, held: heldKey === finalKey ? held : null });
    const { prediction, source: predictionSource } = shown;
    if (prediction) { held = prediction; heldKey = finalKey; }
    strip.classList.toggle('loading', shown.status === 'loading'); iterationLabel.title = shown.status === 'loading' ? 'Loading the recorded trajectory of this iteration' : '';
    capability.textContent = predictionSource === 'final-context' ? 'Final prediction shown; iteration trajectory not recorded.' : !records.length ? 'Only the final result is retained; no intermediate SQP records are available.' : shown.status === 'missing' ? 'Metrics are recorded for this iteration; its prediction trajectory is unavailable.' : 'Recorded SQP inspection leaves the episode clock unchanged.';
    const active = Boolean(selected) && (getView().inspectSolve !== false || state.pinned);
    const key = JSON.stringify([solveSource()?.source, selected?.id, state.iteration, prediction, predictionSource, active, state.pinned]);
    if (key !== lastPrediction) { lastPrediction = key; onPrediction({ active, prediction: prediction || null, predictionSource, pinned: state.pinned, solve: selected, iteration: state.iteration }); }
    runAgain.update(runContext());
    requestPaths();
  }
  function requestPaths() {
    const selected = state.selected, key = finalContextKey;
    if (destroyed || pathsInFlight || !selected?.capabilities?.iteration_paths || !solveNeeded() || pathsFailedKey === key) return;
    const wanted = state.iteration ?? selected.iterations?.at(-1)?.index ?? 0;
    if (iterationPaths.hasChunk(wanted)) return;
    pathsInFlight = true;
    const body = payload('solve'); body.client_id = `${client}-paths`; body.selection = { ...body.selection, iteration: null, iteration_paths: wanted };
    awaitPlotJob(request, '/api/plots/catalog', body, { alive: () => !destroyed && iterationPaths.key === key })
      .then(response => { if (!response) return; if (response.iteration_paths) iterationPaths.addChunk(key, response.iteration_paths); else pathsFailedKey = key; })
      .catch(() => { pathsFailedKey = key; })
      .finally(() => { pathsInFlight = false; if (!destroyed) renderSolve(); });
  }
  function runContext() {
    const selected = state.selected, source = solveSource()?.source, profile = getSolverProfile();
    // Hiding this inspector cancels only capability checks. setupSolveRun's
    // independent active-job polling and Stop remain available on return.
    if (!solveVisible() || !selected || !source) return null;
    return { source, selection: { solve_id: selected.id ?? selected.seq }, profile_id: typeof profile === 'string' ? profile : profile?.id, switching: Boolean(profile?.switching) };
  }
  function syncSolveSource() {
    const key = sourceKey(solveSource()?.source);
    if (key === lastSolveSourceKey) return;
    lastSolveSourceKey = key; state.setSource(key); metadata.solve = {}; evaluatedKeys.solve = undefined; inspectedKey = undefined;
    for (const item of state.instances) if (item.context === 'solve') specs.delete(item.id);
    revision++; pending = true;
  }
  function setInspection(result) {
    solveOverride = { source: structuredClone(result.source), result: structuredClone(result), label: 'Fresh solve inspection' };
    state.pin(false); pinnedSource = null; syncSolveSource(); invalidate();
  }
  function clearInspection() {
    runAgain.invalidateAdoption(); solveOverride = null; state.pin(false); pinnedSource = null; syncSolveSource(); invalidate();
  }
  function adoptSolve(response, source) {
    if (sourceKey(source) !== lastSolveSourceKey) return;
    const solve = response.context?.selected_solve || response.inspection?.selected_solve;
    state.follow(solve, sourceKey(source));
    if (solveOverride && solve) state.pin(true);
  }
  function selectIteration(position) { const selected = state.selected?.iterations?.[position]; if (!selected) return; state.selectIteration(selected.index); reselect(); }
  function selectIterationByIndex(value) { const records = state.selected?.iterations || []; const nearest = records.reduce((best, item, i) => !best || Math.abs(item.index - value) < best.delta ? { i, delta: Math.abs(item.index - value) } : best, null); if (nearest) selectIteration(nearest.i); }
  function stepIteration(direction) { const records = state.selected?.iterations || []; selectIteration(Math.max(0, Math.min(records.length - 1, records.findIndex(item => item.index === state.iteration) + direction))); }
  function invalidate() { revision++; pending = true; renderCards(); }
  // The SQP cursor moves within one solve: an in-flight response for an earlier
  // iteration still lands (its snapshot is cached), and plot cards keep their
  // SVG so a drag continues. Plot markers follow at RAF in update().
  function reselect() { pending = true; renderSolve(); }
  function payload(scope, includePlots = false) {
    const source = scope === 'solve' ? solveSource()?.source : getSource()?.source;
    return { client_id: client, source, context: scope, selection: { solve_seq: scope === 'solve' && state.pinned ? state.selected?.seq ?? state.selected?.id : scope === 'solve' ? solveSource()?.solveSeq ?? null : null, iteration: scope === 'solve' ? state.iteration : null }, range: scope === 'episode' && getView().episodeClock === false ? { mode: 'entire' } : state.range(getView()), pixels: Math.max(200, Math.round(bottomContainer.clientWidth || 800)), ...(includePlots ? { plots: state.instances.filter(item => item.context === scope).map(item => ({ instance_id: item.id, plot_id: item.plot_id, inputs: item.parameters })) } : {}) };
  }
  async function refresh(force = false) {
    if (busy || destroyed || !getSource()?.source || getSource().source.kind === 'live' && getSource().source.generation == null) { pending ||= force; return; }
    busy = true; pending = false; const token = revision, alive = () => !destroyed && token === revision;
    try {
      const source = getSource();
      // Follow the source's recorded association with a metadata-only job.
      // Cursor motion never recomputes unchanged final/iteration plot data.
      const inspectPayload = payload('solve'), inspectKey = structuredClone(inspectPayload);
      if (state.pinned) delete inspectKey.range;
      const inspectSignature = JSON.stringify([inspectKey, solveSource()?.revision]);
      if (solveNeeded() && inspectedKey !== inspectSignature) {
        const response = await awaitPlotJob(request, '/api/plots/catalog', inspectPayload, { alive });
        if (!response || !alive()) return;
        metadata.solve = response; catalogs.solve = response.catalog || response.plots || [];
        adoptSolve(response, inspectPayload.source);
        inspectedKey = inspectSignature;
      }
      for (const scope of ['episode', 'solve']) {
        if (scope === 'solve' && !solveNeeded()) continue;
        if (scope === 'episode' && !episodeNeeded()) continue;
        const body = payload(scope, true);
        const keyBody = structuredClone(body);
        if (scope === 'episode') delete keyBody.range.cursor_s;
        if (scope === 'solve') {
          keyBody.selection.solve_seq = state.selected?.seq ?? state.selected?.id ?? null;
          delete keyBody.range;
        }
        const signature = JSON.stringify([keyBody, scope === 'episode' ? source.revision : null]);
        if (evaluatedKeys[scope] === signature) continue;
        const response = await awaitPlotJob(request, '/api/plots/evaluate', body, { alive });
        if (!response || !alive()) return;
        catalogs[scope] = response.catalog || response.plots || []; metadata[scope] = response;
        if (scope === 'solve') adoptSolve(response, body.source);
        for (const result of response.results || []) specs.set(result.instance_id, result.spec || { version: 1, kind: 'unavailable', title: 'Plot error', message: result.error || 'Plot failed.' });
        evaluatedKeys[scope] = signature;
      }
      windowKey = undefined; renderWindowChip();
      // The trajectory selector names the source and the window chip its range.
      episodeNote.textContent = metadata.episode?.context?.episode_available === false ? 'No MPC episode' : '';
      // Initial data should appear immediately; subsequent streaming data and
      // changing ranges share the same bounded redraw cadence.
      renderSolve();
      renderCards(force || !receivedData); receivedData = true; if (catalogDialog.isOpen) renderCatalog();
    } catch (error) { if (alive()) { episodeNote.textContent = error.message; capability.textContent = error.message; } }
    finally { busy = false; if (pending && !destroyed) lastPoll = -Infinity; }
  }
  function update() {
    if (destroyed) return;
    const current = getSource(), view = getView();
    const episodeSourceKey = sourceKey(current?.source);
    if (lastSourceKey !== episodeSourceKey) {
      for (const presentation of presentations.values()) presentation.cancelScrub?.();
      presentations.clear();
      lastSourceKey = episodeSourceKey;
      if (!solveOverride) { runAgain.invalidateAdoption(); state.pin(false); pinnedSource = null; }
      for (const item of state.instances) if (item.context === 'episode') specs.delete(item.id);
      metadata.episode = {}; evaluatedKeys.episode = undefined; receivedData = false; revision++;
      syncSolveSource();
      episodeNote.textContent = current ? 'Loading active source…' : 'No episode selected.';
      renderCards();
    }
    syncSolveSource();
    const nextPlacement = JSON.stringify([visible(episodeContainer), solveVisible(), visible(bottomContainer), solveNeeded()]);
    if (nextPlacement !== placementKey) { placementKey = nextPlacement; immediateView = true; pending = true; lastPoll = -Infinity; }
    renderWindowChip();
    const key = JSON.stringify([current?.source, current?.revision, lastSolveSourceKey, placementKey, view.aggregate ?? null, state.pinned ? state.selected?.id : view.cursor, state.iteration, state.instances]);
    if (key !== lastRequest) { lastRequest = key; pending = true; }
    if (lastInspectActive !== view.inspectSolve) { lastInspectActive = view.inspectSolve; renderSolve(); }
    // Presentation markers update cheaply at RAF; Python is capped at 5 Hz.
    handles.forEach(handle => handle.updateCursor?.(handle.axisIdentity === 'sqp_iteration' ? state.iteration : handle.axisIdentity === 'episode_time' && view.episodeClock !== false ? view.cursor : undefined));
    // Episode-time plots move their x-window and reveal every frame with one
    // transform and clip, so growth follows the 3D view between rebuilds.
    const frameBounds = metadata.episode?.context?.bounds;
    handles.forEach(handle => { if (handle.episodeLinked != null) handle.setFrame?.(episodeFrame({ linked: handle.episodeLinked, view, bounds: frameBounds })); });
    if (immediateView || cardsPending || lastRender !== JSON.stringify([view.window, view.aggregate ?? null])) { renderCards(immediateView); immediateView = false; }
    runAgain.update(runContext());
    const now = Date.now(); if ((pending || now - lastPoll > 1500 && current?.source?.kind === 'live') && now - lastPoll >= 200) { lastPoll = now; refresh(); }
  }
  return { update, refresh: () => { evaluatedKeys = {}; inspectedKey = undefined; runAgain.refresh(); invalidate(); return refresh(true); }, state, catalogDialog, runAgain, clearInspection, get snapshot() { return { instances: structuredClone(state.instances), pinned: state.pinned, selectedSolve: state.selected, iteration: state.iteration, aggregate: getView().aggregate ?? null, solveSource: structuredClone(solveSource()?.source), inspection: solveOverride?.result || null }; }, destroy() { destroyed = true; resizing?.cancel(); for (const event of viewGestureEvents) doc.removeEventListener(event, finishViewGesture); for (const event of ['dragend', 'drop']) doc.removeEventListener(event, hideDropZone, true); runAgain.destroy(); handles.forEach(handle => handle.destroy()); catalogHandles.forEach(handle => handle.destroy()); activeConfig?.destroy(); catalogDialog.destroy(); } };
}
