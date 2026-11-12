import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimelineIntervalIndex, indexTimelineIntervals, visibleTimelineIntervals } from './timeline-intervals.js';

const interval = (start, end, extra = {}) => ({ start_time_s: start, end_time_s: end, ...extra });

test('appending long histories indexes only the new records and exact hover never scans old records', () => {
  let reads = 0;
  const records = Array.from({ length: 20000 }, (_, i) => ({
    get start_time_s() { reads++; return i * .002; }, end_time_s: (i + 1) * .002,
    mpc_overrun: i % 3 === 0, physics_overrun: i % 3 === 1,
  }));
  const indexed = createTimelineIntervalIndex().update(records), first = indexed.entries[0], before = reads;
  for (let frame = 0; frame < 60; frame++) {
    indexed.update(records);
    assert.equal(indexed.at(39.999), records.at(-1));
    assert.ok(indexed.bands([0, 40], 600).length <= 600);
  }
  assert.equal(reads, before, 'Rendering revisited native interval fields');
  records.push(interval(40, 40.002, { physics_overrun: true })); indexed.update(records);
  assert.equal(indexed.entries.length, records.length);
  assert.equal(indexed.entries[0], first, 'Append replaced the already indexed prefix');
  assert.equal(reads, before, 'Appending reindexed the complete history');
  assert.equal(indexed.at(40.001), records.at(-1));
  assert.equal(indexed.at(40.002), null);
});

test('display bands retain brief overruns and red priority, while exact records remain intact', () => {
  const records = [interval(0, 10), interval(1.2, 1.21, { physics_overrun: true }),
    interval(1.8, 1.80000001, { mpc_overrun: true }), interval(4.2, 4.3, { physics_overrun: true })];
  const indexed = createTimelineIntervalIndex().update(records);
  assert.deepEqual(indexed.bands([0, 10], 10), [
    { start: 1, end: 2, severity: 'red' }, { start: 4, end: 5, severity: 'yellow' },
  ]);
  assert.ok(indexed.bands([1.19, 1.22], 100).some(band => band.severity === 'yellow'));
  assert.deepEqual(indexed.entries.map(entry => entry.item), records);
  assert.equal(indexed.at(.8), records[0]);
  assert.equal(visibleTimelineIntervals(indexed.entries, [1.8, 1.800001]).at(-1).item, records[2]);
  assert.ok(indexed.bands([0, 10], 100000).length <= 4096);
});

test('out-of-order, overlapping, replaced, truncated and reset records keep the exact interval index', () => {
  const records = [interval(3, 5), interval(0, 8, { physics_overrun: true }), interval(4, 4.00001, { mpc_overrun: true }), interval(1, NaN)];
  const indexed = createTimelineIntervalIndex().update(records);
  assert.deepEqual(indexed.entries, indexTimelineIntervals(records));
  records.push(interval(2, 3)); indexed.update(records);
  assert.deepEqual(indexed.entries, indexTimelineIntervals(records));
  records[records.length - 1] = interval(1, 2); indexed.update(records);
  assert.deepEqual(indexed.entries, indexTimelineIntervals(records));
  records.length = 1; indexed.update(records);
  assert.deepEqual(indexed.entries, indexTimelineIntervals(records));
  assert.equal(indexed.at(2), null);
  indexed.update([]); assert.deepEqual(indexed.entries, []); assert.deepEqual(indexed.bands([0, 8], 100), []);
});
