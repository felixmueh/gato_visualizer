export const HISTORY_PAGE_SIZE = 1024;

// The controller owns generation, cursor and reset epoch. Read a detached
// request snapshot before each await; only a still-current page reaches it.
// HTTP work is serial and overlapping notices coalesce into one extra refresh.
export function createLiveHistoryPaging({ fetch: request = globalThis.fetch, getRequest,
  onBatch, onGeneration, onError = () => {}, onIdle = () => {} }) {
  let fetching = false, queued = false;
  async function refresh() {
    if (!getRequest()) return;
    if (fetching) { queued = true; return; }
    fetching = true;
    let requested;
    try {
      let more = true;
      while (more) {
        requested = getRequest();
        if (!requested) break;
        const endpoint = requested.compact ? 'playback' : 'history';
        const response = await request(`/api/live/${endpoint}?generation=${encodeURIComponent(requested.generation)}&after=${requested.cursor}&limit=${HISTORY_PAGE_SIZE}`);
        const batch = await response.json();
        const current = getRequest();
        if (!current) break;
        if (requested.generation !== current.generation || requested.epoch !== current.epoch) continue;
        if (response.status === 409) { if (batch.generation != null) onGeneration(batch.generation); break; }
        if (!response.ok) throw new Error(batch.error || 'History unavailable');
        if (requested.cursor !== current.cursor) { queued = true; break; }
        if (batch.generation !== current.generation) throw new Error('History response belongs to a different generation.');
        if (!Number.isInteger(batch.next_cursor) || batch.next_cursor < current.cursor) throw new Error('History response has an invalid cursor.');
        more = Number.isInteger(batch.next_cursor) && batch.next_cursor > current.cursor &&
          (batch.records || []).length >= HISTORY_PAGE_SIZE;
        onBatch(batch);
      }
    } catch (error) {
      const current = getRequest();
      if (current && requested?.generation === current.generation && requested.epoch === current.epoch) onError(error);
      else if (current) queued = true;
    }
    finally {
      fetching = false;
      if (queued) { queued = false; refresh(); }
      if (getRequest()) onIdle();
    }
  }
  return { refresh, get fetching() { return fetching; }, get queued() { return queued; } };
}
