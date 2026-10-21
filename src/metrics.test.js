import test from 'node:test';
import assert from 'node:assert/strict';
import { metricSeries, metricAggregates, intervalShares, decimateSeries, plotPath, replayMetricSnapshot } from './metrics.js';
import { createLiveHistory } from './live-history.js';

test('history metrics snapshots are revision-cached, deduplicate repeated plans, and flag trimmed recording scope', () => {
  const history = createLiveHistory({ maxSamples: 2 });
  const plan = { sim_time_s: 0, seq: 1, settings_version: 1 };
  history.addPlan(plan); history.addState({ sim_time_s: 0, q: [1] });
  const first = history.metricSnapshot;
  assert.equal(history.metricSnapshot, first);
  history.addPlan({ ...plan }); history.addState({ sim_time_s: 1 }); history.addState({ sim_time_s: 2 });
  const next = history.metricSnapshot;
  assert.notEqual(next, first); assert.equal(next.plans.length, 1);
  assert.equal(next.truncated, true); assert.deepEqual(next.states.map(s => s.sim_time_s), [1, 2]);
  assert.equal(first.states.length, 1);
  history.addRecord({ type: 'interval', start_time_s: 1, end_time_s: 2 });
  assert.equal(history.metricSnapshot.intervals.length, 1);
  history.clear(); assert.equal(history.metricSnapshot.truncated, false); assert.equal(history.metricSnapshot.states.length, 0);
});

test('replay adapter retains optional telemetry absence, real timestamp origin and reference, caches by identity', () => {
  const trajectory = { kind: 'recorded', time_s: [10, 11], q: [[1], [2]], ee_xyz: [[0, 0, 0], [1, 0, 0]], target_xyz: [1, 0, 0] };
  const data = replayMetricSnapshot(trajectory);
  assert.equal(replayMetricSnapshot(trajectory), data);
  assert.deepEqual(data.states.map(s => s.sim_time_s), [0, 1]);
  const series = metricSeries(data);
  assert.deepEqual(series.distance[0].points.map(p => p.y), [1000, 0]);
  assert.deepEqual(series.qd[0].points.map(p => p.y), [null, null]);
  assert.equal(series.torque[0].points.length, 0);
  assert.equal(metricAggregates(data).recording.find(r => r.label === 'MPC wall median').value, null);
});

test('predicted torque ends at the terminal knot and predictions are not labeled recorded motion', () => {
  const data = replayMetricSnapshot({ kind: 'prediction', time_s: [5, 6, 7], q: [[0], [1], [2]], torque_nm: [[4], [7]], torque_time_s: [5, 6], torque_kind: 'predicted', metadata: { stats: { sqp_iters: 3 } } });
  assert.deepEqual(metricSeries(data).torque[0].points, [{t: 0,y: 4},{t: 1,y: 7},{t: 2,y: null}]);
  assert.deepEqual(metricAggregates(data).recording, []);
  assert.equal(metricAggregates(data).prediction.find(r => r.label === 'SQP iterations').value, 3);
});

test('time metrics use controller wall intervals, not solver-reported kernel timing; missing never becomes zero', () => {
  const data = { states: [{ sim_time_s: 0, distance_m: null }, { sim_time_s: 1, distance_m: .1 }], plans: [{ sim_time_s: 0, stats: { solve_time_ms: 99, sqp_iters: 0 } }], intervals: [{ start_time_s: 0, end_time_s: 1, solve_wall_s: .002, to_budget_s: .01 }] };
  const series = metricSeries(data);
  assert.equal(series.solve[0].points[0].y, 2); assert.equal(series.solve[1].points[0].y, 10);
  assert.equal(series.physics[0].points[0].y, null);
  assert.deepEqual(series.distance[0].points.map(p => p.y), [null, 100]);
  assert.equal(series.iterations[0].points[0].y, 0);
});

test('duration-weighted shares use covered union with red precedence, not interval counts', () => {
  const intervals = [{ start_time_s: 0, end_time_s: 4, severity: 'yellow' }, { start_time_s: 1, end_time_s: 2, severity: 'red', physics_overrun: true }, { start_time_s: 6, end_time_s: 8, severity: 'normal' }];
  assert.deepEqual(intervalShares(intervals), { red: 1, yellow: 3, normal: 2, covered: 6, redShare: 1/6, yellowShare: .5 });
  assert.equal(intervalShares(intervals, [1, 2]).redShare, 1);
  assert.equal(intervalShares([]).redShare, null);
});

test('aggregates use full samples, retain unavailable terminal error and report valid denominators', () => {
  const data = { sourceKind: 'live', states: [{sim_time_s:0,ee_xyz:[0,0,0],distance_m:1},{sim_time_s:1,ee_xyz:[3,0,0],distance_m:.2},{sim_time_s:2,ee_xyz:[0,0,0]}], plans:[{origin:'preview'},{origin:'play'}], intervals:[{start_time_s:0,end_time_s:1,solve_wall_s:.001},{start_time_s:1,end_time_s:2,solve_wall_s:.003}], selectedPlan: { N:3,dt_s:.1,qd_rad_s:[[-4],[1]], torque_nm:[[5]],stats:{row_violation:[null,.3,-.5]} } };
  const result = metricAggregates(data), recording = Object.fromEntries(result.recording.map(r => [r.label,r.value]));
  assert.equal(recording['Recorded EE path length'], 6); assert.equal(recording['MPC wall median'], 2); assert.equal(recording['Final target error'], null); assert.equal(recording['Minimum target error'], 200); assert.equal(recording['Retained unique TO plans'], 1);
  assert.equal(result.prediction.find(r => r.label === 'Peak predicted joint speed').value, 4);
  assert.equal(result.prediction.find(r => r.label === 'Maximum reported row violation').value, .3);
});

test('pixel reduction keeps narrow positive/negative spikes, boundary samples and gaps without mutating source', () => {
  const points = Array.from({length:10000},(_,i)=>({t:i/1000,y:i===4001?100:i===4002?-50:0}));
  points[7000] = {t:7,y:null};
  const original = JSON.stringify(points), reduced = decimateSeries(points, [2,8], 30);
  assert.ok(reduced.some(p => p.y===100)); assert.ok(reduced.some(p => p.y===-50)); assert.ok(reduced.some(p => p.y===null));
  assert.ok(reduced.length<150); assert.equal(JSON.stringify(points),original);
  assert.ok(reduced[0].t<=2); assert.ok(reduced.at(-1).t>=8);
});

test('held traces keep horizontal command and exact gap endpoint, with no invented diagonal torque', () => {
  const points = [{t:0,y:1},{t:1,y:2},{t:2,y:null},{t:3,y:3}];
  const path = plotPath(points,[0,4],[0,4],400,100,true);
  assert.equal(path,'M0.00,75.00H100.00V50.00H200.00M300.00,25.00');
  assert.ok(!path.includes('L'));
});

test('graph UI selects independently, scrubs shared window, and avoids per-frame history copies', async () => {
  const { setupMetrics } = await import('./metrics.js');
  const created = [];
  class Element {
    constructor(tag) { this.tagName=tag; this.children=[]; this.dataset={}; this.style={}; this.attrs={}; this.handlers={}; this.clientWidth=300; this.classList={add(){}}; this.ownerDocument=doc; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children=children; }
    setAttribute(k,v) { this.attrs[k]=String(v); }
    addEventListener(k,handler) { this.handlers[k]=handler; }
    closest() { return this.invisible ? {} : null; }
    getBoundingClientRect() { return {left:0,width:300}; }
    emit(name,event={}) { this.handlers[name]?.({button:0,...event}); }
  }
  const doc = { createElement(tag) { const value=new Element(tag); created.push(value); return value; }, createElementNS(ns,tag) { return this.createElement(tag); } };
  const right = doc.createElement('div'), bottom = doc.createElement('div');
  let reads=0, cursor=1;
  const data={revision:1,states:[{sim_time_s:0,distance_m:1},{sim_time_s:2,distance_m:0}],plans:[],intervals:[]};
  const controller=setupMetrics({rightContainer:right,bottomContainer:bottom,getData:()=>{reads++;return data;},getView:()=>({window:[0,2],cursor}),onSeek:t=>{cursor=t;}});
  for(let i=0;i<30;i++) controller.update();
  assert.equal(reads,1);
  const checkbox=created.find(e=>e.attrs['aria-label']==='EE target distance: timeline'); checkbox.checked=true; checkbox.emit('change');
  assert.equal(created.find(e=>e.attrs['aria-label']==='EE target distance: right panel').checked,true);
  const toggle=created.find(e=>e.className==='metrics-expand'); toggle.emit('click');
  assert.equal(toggle.attrs['aria-expanded'],'true');
  const bottomSvg=created.filter(e=>e.tagName==='svg').at(-1); assert.equal(bottomSvg.handlers.pointerdown,undefined);
  const svg=created.filter(e=>e.tagName==='svg' && e.handlers.pointerdown).at(-1); svg.emit('pointerdown',{clientX:225}); assert.equal(cursor,1.5); svg.emit('pointerup');
  svg.emit('keydown',{key:'Home',preventDefault(){}}); assert.equal(cursor,0);
  svg.emit('keydown',{key:'End',preventDefault(){}}); assert.equal(cursor,2);
  controller.destroy(); assert.equal(right.children.length,0); assert.equal(bottom.children.length,0);
});
