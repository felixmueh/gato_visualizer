import test from 'node:test';
import assert from 'node:assert/strict';
import { watchBackend } from './backend-watch.js';

function timers() {
  const queued = new Map(); let sequence = 0;
  return { queued, schedule(callback, delay) { const id = ++sequence; queued.set(id, { callback, delay }); return id; },
    unschedule(id) { queued.delete(id); } };
}

test('external source restart reloads once, including after unavailable health replies', async () => {
  const clock = timers(), health = ['old', new Error('restart'), 'new', 'new'], seen = [], calls = [];
  const watcher = watchBackend({ ...clock, request: async path => { calls.push(path); const next = health.shift(); if (next instanceof Error) throw next; return { backend_id: next }; },
    onRestart: value => seen.push(value.backend_id) });
  await watcher.ready;
  assert.equal(clock.queued.size, 1);
  await watcher.poll();
  assert.deepEqual(seen, []);
  await watcher.poll();
  await watcher.poll();
  assert.deepEqual(seen, ['new']);
  assert.equal(clock.queued.size, 0);
  assert.deepEqual(calls, ['/api/health', '/api/health', '/api/health']);
});

test('startup ID detects a restart before the first periodic request', async () => {
  const clock = timers(), seen = [];
  const watcher = watchBackend({ ...clock, initialBackendId: 'startup', request: async () => ({ backend_id: 'changed' }), onRestart: value => seen.push(value) });
  await watcher.ready;
  assert.equal(clock.queued.size, 1);
  await watcher.poll();
  assert.deepEqual(seen, [{ backend_id: 'changed' }]);
  watcher.dispose();
});

test('overlapping requests share one read and dispose cancels pending callbacks', async () => {
  const clock = timers(); let finish, calls = 0, restarted = false;
  const watcher = watchBackend({ ...clock, initialBackendId: 'old', request: () => { calls++; return new Promise(resolve => { finish = resolve; }); }, onRestart: () => { restarted = true; } });
  await watcher.ready;
  const first = watcher.poll(), second = watcher.poll();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  watcher.dispose(); finish({ backend_id: 'new' }); await first;
  assert.equal(restarted, false);
  assert.equal(clock.queued.size, 0);
});

test('missing backend identity does not trigger reload or replace the last identity', async () => {
  const clock = timers(), replies = [{}, { backend_id: 'old' }]; let restarted = false;
  const watcher = watchBackend({ ...clock, initialBackendId: 'old', request: async () => replies.shift(), onRestart: () => { restarted = true; } });
  await watcher.ready; await watcher.poll(); await watcher.poll();
  assert.equal(restarted, false);
  watcher.dispose();
  assert.equal(clock.queued.size, 0);
});
