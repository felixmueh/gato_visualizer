import { sourceRequest } from './source-settings.js';

// Source Apply can come from an agent or another browser. Source-bound models
// must be reconstructed after the server restarts, even in Replay mode.
export function watchBackend({ request = sourceRequest, onRestart = () => {}, initialBackendId = null,
  intervalMs = 1000, schedule = setTimeout, unschedule = clearTimeout } = {}) {
  let backendId = initialBackendId, disposed = false, restarting = false, timer = null, pending = null;
  function queue() {
    if (!disposed && !restarting) timer = schedule(poll, intervalMs);
  }
  function poll() {
    if (disposed || restarting) return Promise.resolve();
    if (pending) return pending;
    unschedule(timer); timer = null;
    pending = Promise.resolve().then(() => request('/api/health')).then(health => {
      if (disposed || typeof health?.backend_id !== 'string' || !health.backend_id) return;
      if (backendId == null) backendId = health.backend_id;
      else if (health.backend_id !== backendId) {
        restarting = true;
        return onRestart(health);
      }
    }).catch(() => {
      // The listening socket disappears while Apply replaces the interpreter.
      // Keep the previous identity and retry until the new server answers.
    }).finally(() => { pending = null; queue(); });
    return pending;
  }
  const ready = initialBackendId == null ? poll() : Promise.resolve().then(queue);
  return { ready, poll, dispose() { disposed = true; unschedule(timer); timer = null; } };
}
