import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivePlanCache } from './live-plan-cache.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const plan = (seq, generation = 1) => ({ type: 'plan', seq, generation, q: [[seq]], ee_xyz: [[seq, 0, 0]] });
function transport() {
  const calls = [];
  return { calls, fetch(url, options) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const parsed = new URL(url, 'http://viewer');
    const call = { ids: parsed.searchParams.get('ids').split(',').map(Number), generation: Number(parsed.searchParams.get('generation')),
      signal: options.signal, resolve, reject,
      reply(data, status = 200) { resolve({ ok: status >= 200 && status < 300, status, json: async () => data }); },
      succeed() { this.reply({ generation: this.generation, plans: this.ids.map(id => plan(id, this.generation)) }); } };
    calls.push(call); return promise;
  } };
}

test('requests coalesce, prioritize selected IDs and use one request of at most 32 plans', async () => {
  const t = transport(), cache = createLivePlanCache({ fetch: t.fetch });
  cache.setGeneration(1);
  cache.prefetch(Array.from({ length: 40 }, (_, i) => ({ seq: i+1, summary: true })));
  cache.request([39, 40]);
  await flush();
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].ids.length, 32);
  assert.deepEqual(t.calls[0].ids.slice(0, 2), [39, 40]);
  cache.request([40, 41]); await flush();
  assert.equal(t.calls.length, 1);
  t.calls[0].succeed(); await flush();
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[1].ids[0], 41);
  assert.equal(t.calls[1].ids.length, 9);
  t.calls[1].succeed(); await flush();
  assert.equal(cache.size, 41);
  assert.equal(cache.get(40).seq, 40);
  cache.dispose();
});

test('LRU retention stays bounded while explicit load owns results across eviction', async () => {
  const t = transport(), cache = createLivePlanCache({ fetch: t.fetch, capacity: 2 });
  cache.setGeneration(1);
  const ids = Array.from({ length: 40 }, (_, i) => i+1);
  const loaded = cache.ensure([...ids, 1]);
  await flush(); t.calls[0].succeed(); await flush();
  assert.equal(cache.size, 2);
  t.calls[1].succeed();
  const result = await loaded;
  assert.deepEqual(result.map(p => p.seq), [...ids, 1]);
  assert.equal(result[0], result.at(-1));
  assert.equal(cache.peek(1), undefined);
  assert.equal(cache.get(39).seq, 39); // LRU touch retains 39 over 40.
  cache.request([41]); await flush(); t.calls[2].succeed(); await flush();
  assert.equal(cache.peek(40), undefined);
  assert.equal(cache.peek(39).seq, 39);
  assert.equal(cache.size, 2);
  cache.dispose();
});

test('moving lookahead drops obsolete queued prefetch without losing explicit selection', async () => {
  const t = transport(), cache = createLivePlanCache({ fetch: t.fetch });
  cache.setGeneration(1); cache.request([1]); await flush();
  cache.prefetch([2, 3]); cache.request([4]); cache.prefetch([5, 6]);
  t.calls[0].succeed(); await flush();
  assert.deepEqual(t.calls[1].ids, [4, 5, 6]);
  t.calls[1].succeed(); await flush();
  assert.equal(cache.peek(2), undefined); cache.dispose();
});

test('changing playback window replaces queued selections while preserving explicit loads', async () => {
  const t = transport(), cache = createLivePlanCache({ fetch: t.fetch });
  cache.setGeneration(1); cache.setWindow([1], [2, 3]); await flush();
  cache.setWindow([4], [5, 6]);
  const explicit = cache.ensure([7, 8]);
  cache.setWindow([9], [10, 11]);
  assert.equal(t.calls.length, 1);
  t.calls[0].succeed(); await flush();
  assert.deepEqual(t.calls[1].ids, [9, 7, 8, 10, 11]);
  t.calls[1].succeed();
  assert.deepEqual((await explicit).map(p => p.seq), [7, 8]);
  assert.equal(cache.peek(4), undefined);
  assert.equal(cache.peek(5), undefined);
  cache.dispose();
});

test('generation reset aborts work and ignores late old responses', async () => {
  const t = transport(); let changed = 0;
  const cache = createLivePlanCache({ fetch: t.fetch, onChange: () => changed++ });
  cache.setGeneration(1);
  const old = cache.ensure([1]);
  const rejected = assert.rejects(old, { name: 'AbortError' });
  await flush(); cache.setGeneration(2); await rejected;
  assert.equal(t.calls[0].signal.aborted, true);
  cache.request([1]); await flush();
  t.calls[0].succeed(); await flush();
  assert.equal(cache.size, 0); assert.equal(changed, 0);
  t.calls[1].succeed(); await flush();
  assert.equal(cache.get(1).generation, 2); assert.equal(changed, 1);
  cache.dispose();
});

test('failed IDs do not retry every frame; explicit ensure can retry', async () => {
  const t = transport(); let errors = 0;
  const cache = createLivePlanCache({ fetch: t.fetch, retryDelayMs: 0, onError: () => errors++ });
  cache.setGeneration(1); cache.request([1]); await flush();
  t.calls[0].reply({ error: 'Missing solve' }, 400); await flush();
  for (let i = 0; i < 50; i++) { cache.request([1]); cache.setWindow([1]); }
  await flush(); assert.equal(t.calls.length, 1); assert.equal(errors, 1);
  const retried = cache.ensure([1]); await flush();
  assert.equal(t.calls.length, 2); t.calls[1].succeed();
  assert.equal((await retried)[0].seq, 1);
  cache.dispose();
});

test('malformed responses cannot partially populate the cache', async () => {
  for (const data of [
    { generation: 2, plans: [plan(1), plan(2)] },
    { generation: 1, plans: [plan(1)] },
    { generation: 1, plans: [plan(1), plan(1)] },
    { generation: 1, plans: [plan(1), plan(3)] },
    { generation: 1, plans: [plan(1), { ...plan(2), summary: true }] },
  ]) {
    const t = transport(), cache = createLivePlanCache({ fetch: t.fetch, retryDelayMs: 0 });
    cache.setGeneration(1);
    const promise = cache.ensure([1, 2]), rejected = assert.rejects(promise);
    await flush(); t.calls[0].reply(data); await rejected;
    assert.equal(cache.size, 0); cache.dispose();
  }
});

test('cancelled ensure rejects only its caller and disposal aborts active requests', async () => {
  const t = transport(), cache = createLivePlanCache({ fetch: t.fetch });
  cache.setGeneration(1);
  const controller = new AbortController(), cancelled = cache.ensure([1], { signal: controller.signal });
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  const other = cache.ensure([1]); await flush();
  controller.abort(); await rejected;
  assert.equal(t.calls[0].signal.aborted, false);
  t.calls[0].succeed(); assert.equal((await other)[0].seq, 1);
  cache.request([2]); await flush(); cache.dispose();
  assert.equal(t.calls[1].signal.aborted, true);
  t.calls[1].succeed(); await flush();
  assert.equal(cache.size, 0);
  await assert.rejects(cache.ensure([1]), { name: 'AbortError' });
});
