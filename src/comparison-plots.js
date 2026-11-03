import { createFloatingDialog } from './floating-dialog.js';
import { createPlotState, aggregateRange, aggregateAxis, awaitPlotJob, displayLimits } from './plot-state.js';
import { aggregateBounded, aggregateLabel } from './expanded-timeline.js';
import { renderPlot } from './plot-renderer.js';
import { sourceRequest } from './source-settings.js';
import { canonicalTimeUnit, configureTimeInput, readTimeInput } from './time-input.js';

/** Recorded sources only. Hidden robot geometry does not unload a recording.
 * Presentation offsets are sent separately; recorded timestamps stay native. */
export function comparisonSources(session) {
  const tracks = session?.activeTracks || session?.tracks || [];
  return tracks.filter(track => {
    if (!track.source || track.empty || !Array.isArray(track.span) || track.span.length !== 2
      || !track.span.every(Number.isFinite) || track.span[1] <= track.span[0]) return false;
    if (track.kind === 'live') return !session.replayOnly && Number.isInteger(track.source.generation);
    const motion = track.motion;
    // /api/replays/motion is recorded-only and intentionally omits kind.
    // Keep supporting explicit recorded scenes, but never accept a declared
    // prediction merely because it also contains timestamped joint samples.
    const recorded = motion?.kind === 'recorded' || motion?.kind == null
      && Array.isArray(motion?.time_s) && Array.isArray(motion?.q)
      && motion.time_s.length >= 2 && motion.q.length === motion.time_s.length;
    return track.kind === 'replay' && recorded;
  }).map(track => ({ key: track.id, label: track.displayName || track.label || track.id,
    color: typeof track.color === 'number' ? `#${track.color.toString(16).padStart(6, '0')}` : track.color || '#b48cff',
    offset_s: track.kind === 'live' ? 0 : track.offset_s || 0, source: structuredClone(track.source) }));
}

/** Python owns data/metrics; this host owns persistent comparison cards only.
 * No playback, focus, settings or numerical command is issued here. */
export function setupComparisonPlots({ container, getSession, getView = () => ({}), onAvailability = () => {},
  onClearAggregate = () => {}, request = sourceRequest, storage = globalThis.localStorage } = {}) {
  const doc = container.ownerDocument;
  const el = (tag, text, cls) => { const node = doc.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
  const button = (text, action, title = text) => { const node = el('button', text); node.type = 'button'; node.title = title; node.setAttribute('aria-label', title); node.addEventListener('click', action); return node; };
  let saved, hasSavedConfiguration = false;
  try { const raw = storage?.getItem('comparison-plots-v1'); saved = JSON.parse(raw || '{}'); hasSavedConfiguration = raw != null && Array.isArray(saved.instances); } catch { saved = {}; }
  const state = createPlotState(saved, value => { hasSavedConfiguration = true; try { storage?.setItem('comparison-plots-v1', JSON.stringify(value)); } catch {} });
  const client = `comparison-${Date.now().toString(36)}`;
  let catalog = [], metadata = {}, specs = new Map(), handles = [], previews = new Map(), previewHandles = [];
  let revision = 0, destroyed = false, busy = false, pending = true, lastPoll = -Infinity, signature;
  let selectedOnce = false, availabilityKey, headingKey, activeConfig, dragId, error = '', previewKey, previewToken = 0, metadataSources, deferred = false;
  const presentations = new Map();
  const visible = () => { if (getView().visible === false) return false; for (let node = container; node; node = node.parentElement) if (node.hidden) return false; return true; };
  const sources = () => comparisonSources(getSession());
  const liveComputing = () => Boolean(getView().liveComputing);
  const usableCount = () => metadataSources === JSON.stringify(sources()) && Number.isInteger(metadata.context?.usable_runs)
    ? metadata.context.usable_runs : sources().length;
  const range = () => { const value = aggregateRange(getView().aggregate ?? getSession()?.aggregate); delete value.cursor_s; return value; };
  const dataKey = () => {
    const session = getSession(), selected = sources();
    return JSON.stringify([session?.id, selected, selected.map(item => {
      const track = session?.tracks?.find(track => track.id === item.key);
      return [track?.span, track?.kind === 'live' ? track.historyRevision : null];
    }), range(), state.instances]);
  };
  const heading = el('div', null, 'plot-inspector-heading'), chip = el('span', null, 'aggregate-window'), chipText = el('span');
  const clear = button('×', onClearAggregate, 'Clear aggregate window'); chip.append(chipText, clear);
  const add = button('+', openCatalog, 'Add comparison plot'); heading.append(chip, add);
  const note = el('p', '', 'plot-message'), runs = el('div', null, 'plot-legend comparison-runs'), cards = el('div', null, 'plot-cards');
  container.replaceChildren(heading, note, runs, cards);
  const catalogBody = el('div'), search = el('input'), catalogNote = el('p', '', 'plot-message'), catalogList = el('div', null, 'plot-catalog-list');
  search.type = 'search'; search.placeholder = 'Search comparison plots'; search.setAttribute('aria-label', 'Search comparison plots');
  catalogBody.append(search, catalogNote, catalogList);
  const catalogDialog = createFloatingDialog({ id: 'comparison-plot-catalog', title: 'Add comparison plot', content: catalogBody,
    onClose: () => { previewToken++; previewKey = undefined; } });
  search.addEventListener('input', renderCatalog);

  function announce() {
    const count = usableCount(), retained = state.instances.length > 0 || selectedOnce;
    const availability = { visible: count >= 2 || retained, usableCount: count, retained };
    const next = JSON.stringify(availability);
    if (next !== availabilityKey) { availabilityKey = next; onAvailability(availability); }
  }
  function renderHeading() {
    const selected = sources(), aggregate = getView().aggregate ?? getSession()?.aggregate;
    const next = JSON.stringify([selected, aggregate, error, usableCount(), metadata.context?.runs, liveComputing()]);
    if (next === headingKey) return; headingKey = next;
    add.disabled = usableCount() < 2;
    chipText.textContent = aggregateLabel(aggregate); clear.hidden = !aggregateBounded(aggregate);
    chip.classList.toggle('bounded', aggregateBounded(aggregate));
    chip.title = 'Comparison plots use the session aggregate window, including each run’s timeline offset.';
    note.textContent = liveComputing() ? 'Comparison updates after Live calculation stops.'
      : usableCount() < 2 ? 'Load at least two recorded runs to compare. Your plot cards and configuration are kept.' : error;
    note.title = (metadataSources === JSON.stringify(selected) ? metadata.context?.runs || [] : []).filter(run => run.error).map(run => `${run.label || run.key}: ${run.error}`).join('\n');
    runs.replaceChildren();
    for (const source of selected) {
      const label = el('span', source.label); label.style.color = source.color;
      label.title = `${source.source.kind}:${source.source.id ?? source.source.generation} · offset ${source.offset_s} s`;
      runs.append(label);
    }
  }
  const defaultInputs = definition => Object.fromEntries(Object.entries(definition.inputs || definition.controls || {}).map(([key, schema]) => [key, schema.default]));
  const definitionFor = item => catalog.find(definition => definition.id === item.plot_id);
  const details = (definition, spec) => [definition?.description, ...(spec?.notes || []),
    ...(spec?.display_reduction || []).map(item => `Display shows ${item.displayed} of ${item.original} points${item.series ? ` of ${item.series}` : ''}; peaks and gaps kept.`)].filter(Boolean);
  function openCatalog() { if (usableCount() < 2) return; search.value = ''; catalogDialog.open(); renderCatalog(); search.focus(); refresh(true); }
  function renderCatalog() {
    previewHandles.forEach(handle => handle.destroy()); previewHandles = []; catalogList.replaceChildren();
    catalogNote.textContent = liveComputing() ? 'Comparison updates after Live calculation stops.'
      : (metadata.errors || []).map(item => typeof item === 'string' ? item : item.error || item.message).join('\n');
    for (const definition of catalog) {
      if (!`${definition.title} ${definition.description || ''}`.toLowerCase().includes(search.value.toLowerCase())) continue;
      const row = el('section', null, 'plot-catalog-item'), header = el('header');
      const choose = button('Add', () => { state.add(definition, 'comparison'); invalidate(); }, `Add ${definition.title}`);
      choose.disabled = usableCount() < 2; header.append(el('strong', definition.title), choose); row.append(header);
      const preview = el('div', null, 'plot-catalog-preview'), spec = previews.get(definition.id);
      if (definition.available === false) preview.append(el('p', `Unavailable: ${(definition.missing || []).join(', ')}`, 'plot-message'));
      else if (spec) previewHandles.push(renderPlot(preview, spec, { hideTitle: true, notes: false, height: 90 }));
      row.append(preview); if (definition.description) row.append(el('p', definition.description)); catalogList.append(row);
    }
    if (!catalogList.children.length) catalogList.append(el('p', sources().length < 2 ? 'Load two recorded runs to browse comparison plots.' : 'No matching comparison plots.', 'plot-message'));
    loadPreviews();
  }
  function configure(item) {
    activeConfig?.destroy();
    const definition = definitionFor(item), spec = specs.get(item.id), body = el('form', null, 'plot-config-form'), fields = [];
    const explanation = details(definition, spec); if (explanation.length) body.append(el('p', explanation.join('\n'), 'plot-message plot-config-details'));
    for (const [name, schema] of Object.entries(definition?.inputs || definition?.controls || {})) {
      const label = el('label', `${schema.label || name}${schema.unit ? ` (${schema.unit})` : ''}`), input = el(['choice', 'joint'].includes(schema.type) ? 'select' : 'input');
      if (['choice', 'joint'].includes(schema.type)) {
        const choices = schema.type === 'joint' ? metadata.context?.joint_names || [] : schema.choices || [];
        const current = item.parameters[name] ?? schema.default;
        for (const choice of choices) { const option = el('option', typeof choice === 'object' ? choice.label : String(choice)); option.value = String(typeof choice === 'object' ? choice.value : choice); input.append(option); }
        if (!choices.some(choice => String(typeof choice === 'object' ? choice.value : choice) === String(current))) {
          const option = el('option', `${current} (unavailable)`); option.value = String(current); input.append(option);
        }
        input.value = String(current);
      } else if (schema.type === 'boolean') { input.type = 'checkbox'; input.checked = item.parameters[name] ?? schema.default; }
      else {
        const unit = canonicalTimeUnit({ ...schema, path: name });
        if (unit) configureTimeInput(input, { unit }); else { input.type = 'number'; input.step = 'any'; if (schema.min != null) input.min = schema.min; if (schema.max != null) input.max = schema.max; }
        input.value = item.parameters[name] ?? schema.default; input.required = true;
      }
      label.append(input); if (schema.description) label.append(el('small', schema.description)); body.append(label); fields.push({ name, schema, input });
    }
    const constrain = () => {
      const values = Object.fromEntries(fields.map(({ name, input }) => [name, input.value]));
      for (const { schema, input } of fields) for (const option of input.options || []) {
        const conflict = Object.entries(schema.disabled_when?.[option.value] || {}).find(([key, value]) => values[key] === String(value));
        option.disabled = Boolean(conflict); option.title = conflict ? `Unavailable while ${conflict[0]} is ${conflict[1]}` : '';
      }
    };
    fields.forEach(({ input }) => input.addEventListener('change', constrain)); constrain();
    let display;
    if (!['table', 'spans', 'unavailable'].includes(spec?.kind)) {
      const limits = displayLimits(item.display), group = el('section', null, 'plot-display-limits'); group.append(el('h3', 'Y axis'));
      const side = (text, value) => { const label = el('label', text), input = el('input'); input.type = 'number'; input.step = 'any'; input.placeholder = 'auto'; input.value = value ?? ''; label.append(input); return { label, input }; };
      const low = side('Bottom', limits.min), high = side('Top', limits.max), clip = el('label', null, 'plot-display-clip'), check = el('input');
      check.type = 'checkbox'; check.checked = limits.clipOutliers; clip.append(check, el('span', 'Clip outliers'));
      const validate = () => high.input.setCustomValidity?.(low.input.value !== '' && high.input.value !== '' && Number(low.input.value) >= Number(high.input.value) ? 'Top must be above bottom.' : '');
      low.input.addEventListener('input', validate); high.input.addEventListener('input', validate);
      group.append(low.label, high.label, clip); body.append(group);
      display = () => displayLimits({ min: low.input.value, max: high.input.value, clipOutliers: check.checked });
    }
    const warning = el('p', '', 'plot-message'); body.append(warning);
    const apply = el('button', 'Apply'); apply.type = 'submit'; body.append(apply);
    const dialog = createFloatingDialog({ id: `comparison-config-${item.id}`, title: definition?.title || item.plot_id, content: body,
      onClose: () => { dialog.destroy(); if (activeConfig === dialog) activeConfig = null; } }); activeConfig = dialog;
    body.addEventListener('submit', event => {
      event.preventDefault();
      try {
        const parameters = Object.fromEntries(fields.map(({ name, schema, input }) => {
          const unit = canonicalTimeUnit({ ...schema, path: name });
          const value = schema.type === 'boolean' ? input.checked : schema.type === 'number' ? unit
            ? readTimeInput(input, { unit, min: schema.min, max: schema.max, label: schema.label || name }) : Number(input.value) : input.value;
          return [name, value];
        }));
        state.configure(item.id, parameters, display?.()); dialog.close(); invalidate();
      } catch (error) { warning.textContent = error.message; }
    }); dialog.open();
  }
  function renderCards() {
    handles.forEach(handle => handle.destroy({ preserveInteraction: true })); handles = []; cards.replaceChildren();
    const used = new Set(), enough = usableCount() >= 2;
    for (const item of state.instances) {
      const definition = definitionFor(item), spec = specs.get(item.id), card = el('section', null, 'plot-card'); card.dataset.instance = item.id;
      const header = el('header', null, 'plot-card-heading'), title = el('span', spec?.title || definition?.title || item.plot_id, 'plot-card-grip');
      title.draggable = true; title.title = details(definition, spec).join('\n');
      title.addEventListener('dragstart', event => { dragId = item.id; event.dataTransfer?.setData('text/plain', item.id); });
      title.addEventListener('dragend', () => { dragId = null; });
      card.addEventListener('dragover', event => { if (dragId) event.preventDefault(); });
      card.addEventListener('drop', event => { if (!dragId) return; event.preventDefault(); state.reorder(dragId, item.id); dragId = null; renderCards(); });
      header.append(title, button('⚙', () => configure(item), 'Configure plot'),
        button('⧉', () => { state.duplicate(item.id); invalidate(); }, 'Duplicate plot'),
        button('×', () => { state.remove(item.id); specs.delete(item.id); invalidate(); }, 'Remove plot'));
      const graph = el('div', null, 'plot-card-body'); card.append(header, graph); cards.append(card);
      if (spec && enough && visible()) {
        used.add(item.id); if (!presentations.has(item.id)) presentations.set(item.id, {});
        const time = spec.x?.identity === 'session_time';
        const handle = renderPlot(graph, spec, { hideTitle: true, notes: false, height: state.height(item.id, 'sidebar'),
          presentation: presentations.get(item.id), fitKey: [signature, item.parameters],
          yLimits: item.display ? displayLimits(item.display) : undefined,
          window: time ? aggregateAxis(getView().aggregate ?? getSession()?.aggregate, metadata.context?.bounds) : undefined,
          cursor: time ? getView().cursor ?? getSession()?.cursor : undefined }); handles.push(handle);
      } else graph.append(el('p', enough ? error || 'Waiting for comparison data…' : 'Two recorded runs are required for this comparison.', 'plot-message'));
    }
    for (const [key, presentation] of presentations) if (!used.has(key)) { presentation.cancelScrub?.(); presentations.delete(key); }
  }
  function invalidate() { revision++; signature = dataKey(); pending = true; specs.clear(); renderHeading(); renderCards(); announce(); }
  function payload(plots = true) { return { context: 'comparison', client_id: client, sources: sources(), range: range(),
    pixels: Math.max(200, Math.round(container.clientWidth || 800)),
    ...(plots ? { plots: state.instances.map(item => ({ instance_id: item.id, plot_id: item.plot_id, inputs: item.parameters })) } : {}) }; }
  async function loadPreviews() {
    const definitions = catalog.filter(item => item.available !== false);
    if (liveComputing()) { pending = true; return; }
    if (!catalogDialog.isOpen || sources().length < 2 || !definitions.length) return;
    const key = JSON.stringify([signature, definitions]); if (previewKey === key) return;
    previewKey = key; const token = ++previewToken, guard = revision;
    const alive = () => !destroyed && !liveComputing() && token === previewToken && revision === guard && catalogDialog.isOpen;
    try {
      const response = await awaitPlotJob(request, '/api/plots/evaluate', { ...payload(false), client_id: `${client}-catalog`, pixels: 320,
        plots: definitions.map(definition => ({ instance_id: `preview:${definition.id}`, plot_id: definition.id, inputs: defaultInputs(definition) })) }, { alive });
      if (!response || !alive()) { if (token === previewToken) previewKey = undefined; return; }
      previews = new Map((response.results || []).map(result => [result.instance_id.replace(/^preview:/, ''), result.spec || { kind: 'unavailable', message: result.error || 'Plot failed.' }])); renderCatalog();
    } catch { if (token === previewToken) previewKey = undefined; }
  }
  async function refresh(force = false) {
    if (liveComputing()) { pending = true; return; }
    if (destroyed || busy || sources().length < 2 || !visible() && !catalogDialog.isOpen) { pending ||= force; return; }
    busy = true; pending = false; const token = revision, key = dataKey(), alive = () => !destroyed && !liveComputing() && revision === token && dataKey() === key;
    try {
      const body = payload(), response = await awaitPlotJob(request, state.instances.length ? '/api/plots/evaluate' : '/api/plots/catalog', body, { alive });
      if (!response || !alive()) return;
      metadata = response; metadataSources = JSON.stringify(body.sources); catalog = response.catalog || response.plots || []; error = ''; specs.clear();
      for (const result of response.results || []) specs.set(result.instance_id, result.spec || { version: 1, kind: 'unavailable', title: 'Comparison error', message: result.error || 'Plot failed.' });
      // Seed once when the first recorded comparison is opened. A deliberately
      // empty saved list is a user configuration and must stay empty on reload.
      if (visible() && usableCount() >= 2 && !hasSavedConfiguration && !state.instances.length) {
        const defaults = ['comparison.tracking_error', 'comparison.tracking_summary', 'comparison.smoothness'].map(id => catalog.find(item => item.id === id));
        if (defaults.every(Boolean)) { for (const definition of defaults) state.add(definition, 'comparison'); revision++; signature = dataKey(); pending = true; }
      }
      announce(); renderHeading(); renderCards(); if (catalogDialog.isOpen) renderCatalog();
    } catch (failure) { if (alive()) { error = failure.message; renderHeading(); renderCards(); } }
    finally { busy = false; if (liveComputing()) pending = true; if (pending) lastPoll = -Infinity; }
  }
  function update() {
    if (destroyed) return;
    if (deferred !== liveComputing()) {
      deferred = liveComputing(); revision++; previewToken++; previewKey = undefined; pending = true; lastPoll = -Infinity;
      if (catalogDialog.isOpen) renderCatalog();
    }
    selectedOnce = Boolean(getView().visible); announce(); renderHeading();
    const key = dataKey();
    if (key !== signature) { signature = key; revision++; pending = true; specs.clear(); previews.clear(); previewKey = undefined; error = ''; renderCards(); }
    const shown = visible();
    if (shown && handles.length === 0 && specs.size) renderCards();
    handles.forEach(handle => handle.updateCursor?.(handle.axisIdentity === 'session_time' ? getView().cursor ?? getSession()?.cursor : undefined));
    if (!shown && handles.length) renderCards();
    const now = Date.now();
    if (!liveComputing() && pending && sources().length >= 2 && (shown || catalogDialog.isOpen) && now - lastPoll >= 200) { lastPoll = now; refresh(); }
  }
  return { state, update, invalidate, refresh: () => { invalidate(); return refresh(true); }, catalogDialog,
    get snapshot() { return { instances: structuredClone(state.instances), sources: sources(), context: structuredClone(metadata.context || {}),
      usableCount: usableCount(), retained: selectedOnce || state.instances.length > 0, busy, deferred: liveComputing(), pending, error }; },
    destroy() { destroyed = true; revision++; previewToken++; handles.forEach(handle => handle.destroy()); previewHandles.forEach(handle => handle.destroy());
      for (const presentation of presentations.values()) presentation.cancelScrub?.(); activeConfig?.destroy(); catalogDialog.destroy(); } };
}
