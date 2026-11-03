// Full predictions are fetched separately from compact playback records. Cache
// ownership is generation-scoped; history keeps summaries, never these objects.
export function createLivePlanCache({ fetch: request = globalThis.fetch, onChange = () => {},
  onError = () => {}, capacity = 128, retryDelayMs = 1000 } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Plan cache capacity must be a positive integer.');
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) throw new Error('Plan retry delay must be nonnegative.');
  let generation = null, epoch = 0, disposed = false, active = null, scheduled = false, timer = null, retryAt = 0;
  const cache = new Map(), pending = new Map(), failures = new Map(), waiters = new Set();
  const abortError = message => Object.assign(new Error(message), { name: 'AbortError' });
  const identity = value => {
    const id = value && typeof value === 'object' ? value.seq : value;
    if (!(typeof id === 'string' && id.length && !id.includes(',') || Number.isSafeInteger(id) && id >= 0)) throw new Error('A prediction needs a valid solve ID.');
    return String(id);
  };
  const idsOf = values => (Array.isArray(values) ? values : [values]).map(identity);
  const get = value => {
    const id = identity(value), plan = cache.get(id);
    if (plan) { cache.delete(id); cache.set(id, plan); }
    return plan;
  };
  function finishWaiter(waiter, error) {
    if (!waiters.delete(waiter)) return;
    waiter.signal?.removeEventListener('abort', waiter.abort);
    if (error) waiter.reject(error);
    else waiter.resolve(waiter.ids.map(id => waiter.records.get(id)));
  }
  function deliver(plans) {
    for (const [id, plan] of plans) {
      cache.delete(id); cache.set(id, plan);
      while (cache.size > capacity) cache.delete(cache.keys().next().value);
      failures.delete(id);
      // Explicit exports keep their own references even if the small display
      // cache evicts an earlier chunk while the rest of the export is loading.
      for (const waiter of waiters) if (waiter.wanted.has(id)) waiter.records.set(id, plan);
    }
    for (const waiter of [...waiters]) if (waiter.wanted.size === waiter.records.size) finishWaiter(waiter);
  }
  function schedule() {
    if (disposed || generation == null || active || scheduled || timer || !pending.size) return;
    const delay = retryAt-Date.now();
    if (delay > 0) {
      timer = setTimeout(() => { timer = null; schedule(); }, delay);
      return;
    }
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  }
  async function pump() {
    if (disposed || generation == null || active || !pending.size) return;
    const ids = [...pending.keys()].sort((a, b) => Number(pending.get(b))-Number(pending.get(a))).slice(0, 32);
    for (const id of ids) pending.delete(id);
    const ticket = { epoch, generation, ids: new Set(ids), controller: new AbortController() };
    active = ticket;
    const current = () => !disposed && epoch === ticket.epoch && active === ticket;
    try {
      const response = await request(`/api/live/plans?generation=${encodeURIComponent(ticket.generation)}&ids=${ids.map(encodeURIComponent).join(',')}`, { signal: ticket.controller.signal });
      const data = await response.json();
      if (!current()) return;
      if (!response.ok) throw new Error(data.error || `Prediction request failed (${response.status}).`);
      if (data.generation !== ticket.generation || !Array.isArray(data.plans)) throw new Error('Prediction response belongs to a different generation.');
      const plans = new Map();
      for (const plan of data.plans) {
        const id = identity(plan);
        if (!ticket.ids.has(id) || plans.has(id) || plan.summary === true ||
            plan.generation != null && plan.generation !== ticket.generation) throw new Error('Prediction response contains an unexpected solve.');
        plans.set(id, plan);
      }
      if (plans.size !== ids.length) throw new Error('Prediction response is missing a requested solve.');
      deliver(plans);
      onChange();
    } catch (error) {
      if (!current()) return;
      for (const id of ids) failures.set(id, error);
      for (const waiter of [...waiters]) if (ids.some(id => waiter.wanted.has(id))) finishWaiter(waiter, error);
      retryAt = Date.now()+retryDelayMs;
      onError(error);
    } finally {
      if (active === ticket) { active = null; schedule(); }
    }
  }
  function enqueue(values, priority, retry = false) {
    if (disposed || generation == null) return;
    for (const id of idsOf(values)) {
      if (cache.has(id) || active?.ids.has(id)) continue;
      if (retry) failures.delete(id);
      if (!failures.has(id)) pending.set(id, priority || pending.get(id) || false);
    }
    schedule();
  }
  function reset(next, permanent = false) {
    epoch++; generation = next; disposed = permanent;
    const previous = active; active = null; previous?.controller.abort();
    if (timer) clearTimeout(timer);
    timer = null; retryAt = 0;
    cache.clear(); pending.clear(); failures.clear();
    for (const waiter of [...waiters]) finishWaiter(waiter, abortError(permanent ? 'Prediction cache disposed.' : 'Prediction generation changed.'));
  }
  return {
    setGeneration(next) {
      if (disposed) return;
      if (next != null && (!Number.isSafeInteger(next) || next < 0)) throw new Error('Prediction generation must be a nonnegative integer.');
      if (generation !== next) reset(next);
    },
    get,
    peek(value) { return cache.get(identity(value)); },
    request(values, { priority = true, retry = false } = {}) { enqueue(values, priority, retry); },
    setWindow(selected, lookahead = []) {
      const selectedIds = idsOf(selected), lookaheadIds = idsOf(lookahead);
      const wanted = new Set([...selectedIds, ...lookaheadIds]);
      for (const waiter of waiters) for (const id of waiter.wanted) wanted.add(id);
      for (const id of failures.keys()) if (!wanted.has(id)) failures.delete(id);
      pending.clear();
      enqueue(selectedIds, true);
      for (const waiter of waiters) enqueue([...waiter.wanted].filter(id => !waiter.records.has(id)), true);
      enqueue(lookaheadIds, false);
    },
    prefetch(values) {
      // The latest lookahead window replaces speculative work that has not
      // started. Explicit selections/exports retain their queued priority.
      const ids = idsOf(values), wanted = new Set(ids);
      for (const [id, priority] of pending) if (!priority && !wanted.has(id)) pending.delete(id);
      enqueue(ids, false);
    },
    ensure(values, { signal } = {}) {
      if (disposed || generation == null) return Promise.reject(abortError('No active prediction generation.'));
      if (signal?.aborted) return Promise.reject(abortError('Prediction loading cancelled.'));
      let ids;
      try { ids = idsOf(values); } catch (error) { return Promise.reject(error); }
      if (!ids.length) return Promise.resolve([]);
      return new Promise((resolve, reject) => {
        const waiter = { ids, wanted: new Set(ids), records: new Map(), resolve, reject, signal };
        for (const id of waiter.wanted) { const plan = get(id); if (plan) waiter.records.set(id, plan); }
        waiter.abort = () => finishWaiter(waiter, abortError('Prediction loading cancelled.'));
        waiters.add(waiter); signal?.addEventListener('abort', waiter.abort, { once: true });
        if (waiter.wanted.size === waiter.records.size) finishWaiter(waiter);
        else enqueue(ids, true, true);
      });
    },
    dispose() { if (!disposed) reset(null, true); },
    get size() { return cache.size; },
    get generation() { return generation; },
  };
}
