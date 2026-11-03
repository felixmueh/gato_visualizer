import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveHistoryPaging, HISTORY_PAGE_SIZE } from './live-history-paging.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  let current = { generation: 1, cursor: 0, epoch: 0, compact: true }, idle = 0;
  const calls = [], batches = [], errors = [], generations = [];
  const paging = createLiveHistoryPaging({
    getRequest: () => current && { ...current },
    fetch(url) {
      return new Promise((resolve, reject) => {
        calls.push({ url: new URL(url, 'http://viewer'), reject,
          reply(batch, status = 200) { resolve({ ok: status >= 200 && status < 300, status, json: async () => batch }); } });
      });
    },
    onBatch(batch) { batches.push(batch); if (Number.isInteger(batch.next_cursor)) current.cursor = batch.next_cursor; },
    onGeneration(generation) {
      generations.push(generation); current = { ...current, generation, cursor: 0, epoch: current.epoch + 1 };
      paging.refresh();
    },
    onError: error => errors.push(error), onIdle: () => idle++,
  });
  return { paging, calls, batches, errors, generations,
    get current() { return current; }, set current(value) { current = value; }, get idle() { return idle; } };
}
const batch = (next_cursor, records = [], generation = 1) => ({ generation, next_cursor, records, complete: true });

test('compact pages retain their exact cursors and download serially until a short page', async () => {
  const h = harness(), done = h.paging.refresh();
  assert.equal(h.paging.fetching, true);
  assert.equal(h.calls[0].url.pathname, '/api/live/playback');
  assert.equal(h.calls[0].url.searchParams.get('limit'), '1024');
  assert.equal(h.calls[0].url.searchParams.get('after'), '0');
  const records = Array.from({ length: HISTORY_PAGE_SIZE }, (_, seq) => ({ seq }));
  h.calls[0].reply(batch(1536, records)); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].url.searchParams.get('after'), '1536');
  assert.equal(h.batches[0].records, records);
  h.calls[1].reply(batch(1540, [{ seq: 1024 }])); await done;
  assert.equal(h.current.cursor, 1540);
  assert.equal(h.batches.length, 2);
  assert.equal(h.paging.fetching, false);
  assert.equal(h.idle, 1);
});

test('overlapping history notices coalesce into one refresh without overlapping HTTP', async () => {
  const h = harness(), done = h.paging.refresh();
  for (let i = 0; i < 10; i++) h.paging.refresh();
  assert.equal(h.calls.length, 1); assert.equal(h.paging.queued, true);
  h.calls[0].reply(batch(2)); await done;
  assert.equal(h.calls.length, 2); assert.equal(h.paging.queued, false);
  assert.equal(h.paging.fetching, true);
  assert.equal(h.calls[1].url.searchParams.get('after'), '2');
  h.calls[1].reply(batch(2)); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.paging.fetching, false);
});

test('generation changes and forced same-generation resets discard outstanding pages', async () => {
  for (const generation of [1, 2]) {
    const h = harness(), done = h.paging.refresh();
    h.current = { ...h.current, generation, epoch: 1, compact: false };
    h.calls[0].reply(batch(100, [{ obsolete: true }])); await flush();
    assert.equal(h.batches.length, 0);
    assert.equal(h.calls[1].url.searchParams.get('generation'), String(generation));
    assert.equal(h.calls[1].url.searchParams.get('after'), '0');
    assert.equal(h.calls[1].url.pathname, '/api/live/history');
    h.calls[1].reply(batch(1, [{ current: true }], generation)); await done;
    assert.equal(h.batches.length, 1); assert.equal(h.current.cursor, 1);
  }
});

test('a moved controller cursor discards the page and refreshes from the current cursor', async () => {
  const h = harness(), done = h.paging.refresh(); h.current.cursor = 9;
  h.calls[0].reply(batch(100, [{ obsolete: true }])); await done;
  assert.equal(h.batches.length, 0);
  assert.equal(h.calls[1].url.searchParams.get('after'), '9');
  h.calls[1].reply(batch(10)); await flush();
  assert.equal(h.current.cursor, 10);
});

test('malformed generation and cursor responses fail once without retry spinning', async () => {
  for (const response of [batch(1, [], 2), batch(undefined), batch(-1), batch(1.5)]) {
    const h = harness(), done = h.paging.refresh();
    h.calls[0].reply(response); await done;
    assert.equal(h.batches.length, 0); assert.equal(h.current.cursor, 0);
    assert.equal(h.calls.length, 1); assert.equal(h.errors.length, 1);
    assert.match(h.errors[0].message, /generation|cursor/);
    assert.equal(h.paging.fetching, false);
  }
});

test('409 delegates generation ownership to the controller and follows its queued refresh', async () => {
  const h = harness(), done = h.paging.refresh();
  h.calls[0].reply({ generation: 4, error: 'History changed' }, 409); await done;
  assert.deepEqual(h.generations, [4]); assert.deepEqual(h.errors, []);
  assert.equal(h.batches.length, 0);
  assert.equal(h.calls[1].url.searchParams.get('generation'), '4');
  h.calls[1].reply(batch(1, [], 4)); await flush();
  assert.equal(h.current.cursor, 1); assert.equal(h.paging.fetching, false);
});

test('failed HTTP reports once, releases the request and retains queued retry intent', async () => {
  const h = harness(), done = h.paging.refresh();
  h.paging.refresh(); h.calls[0].reply({ error: 'History unavailable now' }, 503); await done;
  assert.equal(h.errors[0].message, 'History unavailable now');
  assert.equal(h.calls.length, 2); assert.equal(h.current.cursor, 0);
  h.calls[1].reply(batch(1)); await flush();
  assert.equal(h.paging.fetching, false); assert.equal(h.current.cursor, 1);
  const retry = h.paging.refresh(); h.calls[2].reject(new Error('Connection lost')); await retry;
  assert.equal(h.errors[1].message, 'Connection lost'); assert.equal(h.paging.fetching, false);
});

test('disabled or disposed playback ignores late history and does not launch queued HTTP', async () => {
  const h = harness(), initial = h.current;
  h.current = null; await h.paging.refresh(); assert.equal(h.calls.length, 0);
  h.current = initial;
  const done = h.paging.refresh(); h.paging.refresh(); h.current = null;
  h.calls[0].reply(batch(100, [{ obsolete: true }])); await done;
  assert.equal(h.batches.length, 0); assert.equal(h.calls.length, 1);
  assert.equal(h.paging.fetching, false); assert.equal(h.paging.queued, false);
  assert.equal(h.idle, 0);
});

test('obsolete or disposed request failures cannot overwrite current UI errors', async () => {
  const h = harness(), done = h.paging.refresh();
  h.current = { ...h.current, generation: 2, epoch: 1 };
  h.calls[0].reject(new Error('Obsolete connection lost')); await done;
  assert.equal(h.errors.length, 0); assert.equal(h.calls.length, 2);
  h.current = null;
  h.calls[1].reject(new Error('Disposed connection lost')); await flush();
  assert.equal(h.errors.length, 0); assert.equal(h.paging.fetching, false);
  assert.equal(h.idle, 1);
});
