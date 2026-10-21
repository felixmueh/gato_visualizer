import { createFloatingDialog } from './floating-dialog.js';
import { createPlotState, timelineEligible, awaitPlotJob } from './plot-state.js';
import { renderPlot } from './plot-renderer.js';
import { sourceRequest } from './source-settings.js';

/** One host for both inspectors. Only the episode timeline owns a playback clock. */
export function setupPlotInspection({ episodeContainer, solveContainer, bottomContainer, getSource, getView, onSeek, onPrediction = () => {}, request = sourceRequest, storage = globalThis.localStorage } = {}) {
  const doc = episodeContainer.ownerDocument;
  const el = (tag, text, cls) => { const item = doc.createElement(tag); if (text != null) item.textContent = text; if (cls) item.className = cls; return item; };
  const button = (text, action, title = text) => { const item = el('button', text); item.type = 'button'; item.title = title; item.setAttribute('aria-label', title); item.addEventListener('click', action); return item; };
  let saved; try { saved = JSON.parse(storage?.getItem('plot-inspection-v1') || '{}'); } catch { saved = {}; }
  const state = createPlotState(saved, value => { try { storage?.setItem('plot-inspection-v1', JSON.stringify(value)); } catch {} });
  const client = `plots-${Date.now().toString(36)}`;
  let lastSourceKey, evaluatedKeys = {}, inspectedKey, lastInspectActive, activeConfig;
  let catalogs = { episode: [], solve: [] }, metadata = {}, specs = new Map(), handles = [], revision = 0, busy = false, pending = false, lastRequest = '', lastPoll = -Infinity, lastRender = '', lastPrediction = '', pinnedSource, drag, destroyed = false;
  const presentations = new Map();
  const heading = el('div', null, 'plot-inspector-heading'), rangeLabel = el('label', 'Analyze '), range = el('select');
  for (const [value, text] of [['entire', 'Entire episode'], ['through_cursor', 'Through cursor'], ['visible', 'Visible window']]) { const option = el('option', text); option.value = value; range.append(option); }
  range.value = state.rangeMode; range.setAttribute('aria-label', 'Episode analysis range'); range.addEventListener('change', () => { state.rangeMode = range.value; invalidate(); }); rangeLabel.append(range); heading.append(rangeLabel, button('+', () => openCatalog('episode'), 'Add episode plot'));
  const episodeNote = el('p', '', 'plot-message'), episodeCards = el('div', null, 'plot-cards'); episodeContainer.replaceChildren(heading, episodeNote, episodeCards);
  const solveHeading = el('div', null, 'plot-inspector-heading'), pin = button('Pin solve', () => { state.pin(!state.pinned); pinnedSource = state.pinned ? structuredClone(getSource()?.source) : null; invalidate(); });
  pin.setAttribute('aria-pressed', 'false'); solveHeading.append(pin, button('+', () => openCatalog('solve'), 'Add solve plot'));
  const identity = el('p', '', 'solve-identity'), strip = el('div', null, 'sqp-strip'), iterationLabel = el('span'), previous = button('‹', () => stepIteration(-1), 'Previous recorded SQP iteration'), next = button('›', () => stepIteration(1), 'Next recorded SQP iteration'), slider = el('input');
  slider.type = 'range'; slider.step = '1'; slider.min = '0'; slider.setAttribute('aria-label', 'Recorded SQP iteration'); slider.addEventListener('input', () => selectIteration(Number(slider.value)));
  strip.append(previous, iterationLabel, next, slider);
  const final = button('Final result', () => { state.selectIteration(null); invalidate(); });
  strip.append(final);
  const capability = el('p', '', 'plot-message'), continuation = button('Continue SQP', () => {}); continuation.disabled = true;
  const continuationReason = el('p', '', 'plot-message');
  const solveCards = el('div', null, 'plot-cards'); solveContainer.replaceChildren(solveHeading, identity, strip, capability, continuation, continuationReason, solveCards);
  const bottomTitle = el('div', 'Timeline plots · drop an episode-time plot here', 'timeline-plot-hint'), bottomCards = el('div', null, 'timeline-plot-rows'); bottomContainer.replaceChildren(bottomTitle, bottomCards);
  for (const [label, amount] of [['↑', -100], ['↓', 100]]) bottomTitle.append(button(label, () => bottomCards.scrollBy({ top: amount, behavior: 'smooth' }), `Scroll timeline plot rows ${amount < 0 ? 'up' : 'down'}`));
  bottomContainer.addEventListener('dragover', event => { if (drag && eligible(drag.id)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } });
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
    catalogList.replaceChildren(); catalogNote.textContent = metadata[catalogScope]?.errors?.map(error => typeof error === 'string' ? error : error.error || error.message).join('\n') || '';
    for (const definition of catalogs[catalogScope]) {
      if (!`${definition.title} ${definition.description || ''}`.toLowerCase().includes(search.value.toLowerCase())) continue;
      const row = el('section', null, 'plot-catalog-item'); row.append(el('strong', definition.title), el('p', definition.description || ''));
      if (definition.available === false) row.append(el('p', `Unavailable: ${(definition.missing || []).join(', ')}`, 'plot-message'));
      row.append(button('Add', () => { state.add(definition, catalogScope); invalidate(); }, `Add ${definition.title}`)); catalogList.append(row);
    }
    if (!catalogList.children.length) catalogList.append(el('p', 'No matching plots. Reload plotters in Source / Build settings.', 'plot-message'));
  }
  const definitionFor = item => catalogs[item.context].find(definition => definition.id === item.plot_id);
  function eligible(id) { const item = state.instances.find(item => item.id === id), spec = specs.get(id); return getView().episodeClock !== false && item?.context === 'episode' && timelineEligible({ ...definitionFor(item), scope: 'episode' }, spec) && Boolean(spec?.x?.clock) && spec.x.clock === metadata.episode?.context?.clock; }
  function configure(item) {
    activeConfig?.destroy();
    const definition = definitionFor(item); const body = el('form', null, 'plot-config-form'), fields = [];
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
    if (!fields.length) body.append(el('p', 'This plot has no configurable inputs.'));
    const apply = el('button', 'Apply'); apply.type = 'submit'; body.append(apply);
    const dialog = createFloatingDialog({ id: `config-${item.id}`, title: definition?.title || item.plot_id, content: body, onClose: () => { dialog.destroy(); if (activeConfig === dialog) activeConfig = null; } }); activeConfig = dialog;
    body.addEventListener('submit', event => { event.preventDefault(); const parameters = {}; for (const { name, schema, input } of fields) parameters[name] = schema.type === 'boolean' ? input.checked : schema.type === 'number' ? Number(input.value) : input.value; state.configure(item.id, parameters); dialog.close(); invalidate(); }); dialog.open();
  }
  function renderCards() {
    handles.forEach(handle => handle.destroy({ preserveInteraction: true })); handles = []; episodeCards.replaceChildren(); solveCards.replaceChildren(); bottomCards.replaceChildren();
    const usedPresentations = new Set();
    for (const item of state.instances) {
      const definition = definitionFor(item), spec = specs.get(item.id);
      for (const placement of ['sidebar', ...(item.timeline && eligible(item.id) ? ['timeline'] : [])]) {
        const card = el('section', null, 'plot-card'); card.dataset.instance = item.id;
        const title = el('header', null, 'plot-card-heading'), grip = el('span', spec?.title || definition?.title || item.plot_id, 'plot-card-grip'); grip.draggable = true; grip.title = 'Drag to reorder or show on timeline';
        grip.addEventListener('dragstart', event => { drag = { id: item.id, from: placement, accepted: false }; event.dataTransfer.setData('text/plain', item.id); event.dataTransfer.effectAllowed = 'move'; });
        grip.addEventListener('dragend', () => { if (drag?.from === 'timeline' && !drag.accepted) { state.place(item.id, false); renderCards(); } drag = null; }); title.append(grip);
        if (placement === 'sidebar') {
          if (eligible(item.id)) { const show = button('↧', () => { state.place(item.id, !item.timeline); renderCards(); }, item.timeline ? 'Hide from timeline' : 'Show on timeline'); show.className = 'plot-timeline-toggle'; show.setAttribute('aria-pressed', String(item.timeline)); title.append(show); }
          title.append(button('⚙', () => configure(item), 'Configure plot'), button('⧉', () => { state.duplicate(item.id); invalidate(); }, 'Duplicate plot'), button('×', () => { state.remove(item.id); specs.delete(item.id); invalidate(); }, 'Remove plot'));
        } else title.append(button('×', () => { state.place(item.id, false); renderCards(); }, 'Remove timeline placement'));
        card.append(title);
        const graph = el('div', null, 'plot-card-body'); card.append(graph);
        if (spec) {
          const view = getView(), linked = placement === 'timeline', episodeTime = spec.x?.identity === 'episode_time';
          const bounds = metadata.episode?.context?.bounds;
          let window;
          if (episodeTime) {
            if (linked || view.episodeClock !== false && state.rangeMode === 'visible') window = view.window;
            else if (view.episodeClock === false || state.rangeMode === 'entire') window = bounds;
            else if (bounds) window = [bounds[0], Math.max(bounds[0], Math.min(bounds[1], view.cursor))];
          }
          const cursor = spec.x?.identity === 'sqp_iteration' ? state.iteration : episodeTime && view.episodeClock !== false && (linked || state.rangeMode !== 'through_cursor') ? view.cursor : undefined;
          const key = `${item.id}:${placement}`; usedPresentations.add(key);
          if (!presentations.has(key)) presentations.set(key, {});
          // A following window can move while Live grows. Only a duration
          // change (zoom), source, scope or plot configuration resets the fit.
          const fitKey = [lastSourceKey, item.parameters, episodeTime ? [linked ? 'timeline' : state.rangeMode, linked || state.rangeMode === 'visible' ? view.window?.[1] - view.window?.[0] : null] : state.selected?.id];
          handles.push(renderPlot(graph, spec, { compact: linked, linked, hideTitle: true, presentation: presentations.get(key), fitKey, window, cursor, onSeek: episodeTime && view.episodeClock !== false ? onSeek : spec.x?.identity === 'sqp_iteration' ? x => selectIterationByIndex(x) : undefined }));
        }
        else graph.append(el('p', 'Waiting for plot data…', 'plot-message'));
        (placement === 'timeline' ? bottomCards : item.context === 'episode' ? episodeCards : solveCards).append(card);
      }
    }
    for (const [key, presentation] of presentations) if (!usedPresentations.has(key)) { presentation.cancelScrub?.(); presentations.delete(key); }
    if (!state.instances.some(item => item.context === 'episode')) episodeCards.append(el('p', 'Add episode plots and aggregates with +.', 'plot-message'));
    if (!state.instances.some(item => item.context === 'solve')) solveCards.append(el('p', 'Add solve plots with +.', 'plot-message'));
    renderSolve(); lastRender = JSON.stringify([getView().window, state.rangeMode === 'through_cursor' ? getView().cursor : null]);
  }
  function renderSolve() {
    const selected = state.selected, records = selected?.iterations || [], index = records.findIndex(item => item.index === state.iteration);
    solveContainer.classList.toggle('solve-pinned', state.pinned); pin.textContent = state.pinned ? 'Follow cursor' : 'Pin solve'; pin.setAttribute('aria-pressed', String(state.pinned)); pin.disabled = !selected;
    identity.textContent = selected ? `${state.pinned ? 'Pinned · ' : ''}${selected.origin === 'preview' ? 'Preview' : 'Solve'} ${selected.seq ?? selected.id}${Number.isFinite(selected.sim_time_s ?? selected.time_s) ? ` · ${(selected.sim_time_s ?? selected.time_s).toFixed(3)} s` : ''}${metadata.solve?.context?.association ? ` · ${metadata.solve.context.association}` : ''}` : 'No recorded solve associated with the episode cursor.';
    strip.hidden = !records.length; slider.max = String(Math.max(0, records.length - 1)); slider.value = String(Math.max(0, index)); slider.disabled = !records.length; previous.disabled = index <= 0; next.disabled = index >= records.length - 1; final.disabled = state.iteration == null;
    const current = records[index]; iterationLabel.textContent = current ? `${current.index === 0 ? 'Seed' : `SQP ${current.index}`} · ${index + 1} of ${records.length} recorded${current.status ? ` · ${current.status}` : ''}` : 'Final result';
    // A metrics-only iteration has no trajectory snapshot. Keep the selected
    // solve's final plan visible as explicitly labelled display context, without
    // attaching it to the iteration record or changing the Python plot inputs.
    const iterationMissing = state.iteration != null && !current?.prediction;
    const finalContext = iterationMissing && Boolean(selected?.final_prediction);
    const prediction = state.iteration == null || finalContext ? selected?.final_prediction : current?.prediction;
    const predictionSource = finalContext ? 'final-context' : prediction ? state.iteration == null ? 'final' : 'iteration' : null;
    capability.textContent = finalContext ? 'Final prediction shown; iteration trajectory not recorded.' : !records.length ? 'Only the final result is retained; no intermediate SQP records are available.' : iterationMissing ? 'Metrics are recorded for this iteration; its prediction trajectory is unavailable.' : 'Recorded SQP inspection leaves the episode clock unchanged.';
    continuation.title = selected?.reason || selected?.capabilities?.continue_reason || 'Exact continuation needs a retained optimizer checkpoint, which this source does not provide.';
    continuationReason.textContent = `Continue SQP unavailable: ${continuation.title}`;
    continuation.setAttribute('aria-label', `Continue SQP unavailable: ${continuation.title}`);
    const active = Boolean(selected) && (getView().inspectSolve !== false || state.pinned);
    const key = JSON.stringify([getSource()?.source, selected?.id, state.iteration, prediction, predictionSource, active, state.pinned]);
    if (key !== lastPrediction) { lastPrediction = key; onPrediction({ active, prediction: prediction || null, predictionSource, pinned: state.pinned, solve: selected, iteration: state.iteration }); }
  }
  function selectIteration(position) { const selected = state.selected?.iterations?.[position]; if (!selected) return; state.selectIteration(selected.index); invalidate(); }
  function selectIterationByIndex(value) { const records = state.selected?.iterations || []; const nearest = records.reduce((best, item, i) => !best || Math.abs(item.index - value) < best.delta ? { i, delta: Math.abs(item.index - value) } : best, null); if (nearest) selectIteration(nearest.i); }
  function stepIteration(direction) { const records = state.selected?.iterations || []; selectIteration(Math.max(0, Math.min(records.length - 1, records.findIndex(item => item.index === state.iteration) + direction))); }
  function invalidate() { revision++; pending = true; renderCards(); }
  function payload(scope, includePlots = false) {
    const source = scope === 'solve' && state.pinned ? pinnedSource : getSource()?.source;
    return { client_id: client, source, context: scope, selection: { solve_seq: scope === 'solve' && state.pinned ? state.selected?.seq ?? state.selected?.id : scope === 'solve' ? getSource()?.solveSeq ?? null : null, iteration: scope === 'solve' ? state.iteration : null }, range: scope === 'episode' && getView().episodeClock === false ? { mode: 'entire' } : state.range(getView()), pixels: Math.max(200, Math.round(bottomContainer.clientWidth || 800)), ...(includePlots ? { plots: state.instances.filter(item => item.context === scope).map(item => ({ instance_id: item.id, plot_id: item.plot_id, inputs: item.parameters })) } : {}) };
  }
  async function refresh(force = false) {
    if (busy || destroyed || !getSource()?.source || getSource().source.kind === 'live' && getSource().source.generation == null) { pending ||= force; return; }
    busy = true; pending = false; const token = revision, alive = () => !destroyed && token === revision;
    try {
      const source = getSource();
      // Follow the source's recorded association with a metadata-only job.
      // Cursor motion never recomputes unchanged final/iteration plot data.
      const inspectPayload = payload('solve'), inspectSignature = JSON.stringify([inspectPayload, source.revision]);
      if (inspectedKey !== inspectSignature) {
        const response = await awaitPlotJob(request, '/api/plots/catalog', inspectPayload, { alive });
        if (!response || !alive()) return;
        metadata.solve = response; catalogs.solve = response.catalog || response.plots || [];
        state.follow(response.context?.selected_solve || response.inspection?.selected_solve);
        inspectedKey = inspectSignature;
      }
      for (const scope of ['episode', 'solve']) {
        const body = payload(scope, true);
        const keyBody = structuredClone(body);
        if (scope === 'episode' && state.rangeMode !== 'through_cursor') delete keyBody.range.cursor_s;
        if (scope === 'solve') {
          keyBody.selection.solve_seq = state.selected?.seq ?? state.selected?.id ?? null;
          delete keyBody.range;
        }
        const signature = JSON.stringify([keyBody, scope === 'episode' ? source.revision : null]);
        if (evaluatedKeys[scope] === signature) continue;
        const response = await awaitPlotJob(request, '/api/plots/evaluate', body, { alive });
        if (!response || !alive()) return;
        catalogs[scope] = response.catalog || response.plots || []; metadata[scope] = response;
        if (scope === 'solve') state.follow(response.context?.selected_solve || response.inspection?.selected_solve);
        for (const result of response.results || []) specs.set(result.instance_id, result.spec || { version: 1, kind: 'unavailable', title: 'Plot error', message: result.error || 'Plot failed.' });
        evaluatedKeys[scope] = signature;
      }
      range.disabled = getView().episodeClock === false || metadata.episode?.context?.episode_available === false;
      episodeNote.textContent = metadata.episode?.context?.episode_available === false ? 'No MPC episode accompanies this standalone solve.' : getView().episodeClock === false ? 'Companion episode · all available history. The active timeline is a prediction horizon; episode plots stay in this inspector.' : `${getSource()?.label || 'Active episode'} · ${state.rangeMode === 'entire' ? 'All available history' : state.rangeMode === 'through_cursor' ? 'Segment start through cursor' : 'Visible timeline window'}`;
      renderCards(); if (catalogDialog.isOpen) renderCatalog();
    } catch (error) { if (alive()) { episodeNote.textContent = error.message; capability.textContent = error.message; } }
    finally { busy = false; if (pending && !destroyed) lastPoll = -Infinity; }
  }
  function update() {
    if (destroyed) return;
    const current = getSource(), view = getView();
    const sourceKey = current?.source ? JSON.stringify([current.source.kind, current.source.generation, current.source.id, current.source.trajectory_index, current.source.revision]) : '';
    if (lastSourceKey !== sourceKey) {
      for (const presentation of presentations.values()) presentation.cancelScrub?.();
      presentations.clear();
      lastSourceKey = sourceKey; state.setSource(sourceKey); pinnedSource = null; specs.clear(); metadata = {}; evaluatedKeys = {}; inspectedKey = undefined; revision++;
      episodeNote.textContent = current ? 'Loading active source…' : 'No episode selected.';
      renderCards();
    }
    const key = JSON.stringify([current?.source, current?.revision, state.rangeMode, state.rangeMode === 'visible' ? view.window : null, state.rangeMode === 'through_cursor' ? view.cursor : null, state.pinned ? state.selected?.id : view.cursor, state.iteration, state.instances]);
    if (key !== lastRequest) { lastRequest = key; pending = true; }
    if (lastInspectActive !== view.inspectSolve) { lastInspectActive = view.inspectSolve; renderSolve(); }
    // Presentation markers update cheaply at RAF; Python is capped at 5 Hz.
    handles.forEach(handle => handle.updateCursor?.(handle.axisIdentity === 'sqp_iteration' ? state.iteration : handle.axisIdentity === 'episode_time' && view.episodeClock !== false && (handle.linked || state.rangeMode !== 'through_cursor') ? view.cursor : undefined));
    if (lastRender !== JSON.stringify([view.window, state.rangeMode === 'through_cursor' ? view.cursor : null])) renderCards();
    const now = Date.now(); if ((pending || now - lastPoll > 1500 && current?.source?.kind === 'live') && now - lastPoll >= 200) { lastPoll = now; refresh(); }
  }
  return { update, refresh: () => { evaluatedKeys = {}; inspectedKey = undefined; invalidate(); return refresh(true); }, state, catalogDialog, get snapshot() { return { instances: structuredClone(state.instances), pinned: state.pinned, selectedSolve: state.selected, iteration: state.iteration, rangeMode: state.rangeMode }; }, destroy() { destroyed = true; handles.forEach(handle => handle.destroy()); activeConfig?.destroy(); catalogDialog.destroy(); } };
}
