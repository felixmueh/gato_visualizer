import test from 'node:test';
import assert from 'node:assert/strict';
import { itemRevision, modelWarningText, uploadPath, validateReference, referencePosition, playbackClock, setupReplayLibrary } from './replay-library.js';
import { plotDOM } from './plot-dom-test-helper.js';

function libraryHarness(t, items = []) {
  const { document } = plotDOM(), elements = new Map(), requests = [], replacements = [];
  document.getElementById = id => {
    if (!elements.has(id)) elements.set(id, document.createElement('div'));
    return elements.get(id);
  };
  const location = { href: 'http://localhost:8090/?replay=study/run' };
  let library;
  const globals = { document, location, history: { state: null, replaceState(_state, _title, href) { replacements.push(href); location.href = href; } },
    setTimeout: () => 1, clearTimeout() {},
    fetch: async url => {
      requests.push(url);
      if (url === '/api/replays') return { ok: true, json: async () => ({ items }) };
      if (url.startsWith('/api/replays/scene?')) return { ok: true, json: async () => ({ source: {}, trajectories: [] }) };
      throw new Error(`Unexpected request: ${url}`);
    } };
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    library?.dispose();
    for (const [key, descriptor] of descriptors) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  return { elements, requests, replacements, location, create(options) { return library = setupReplayLibrary(options); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('folder uploads preserve relative names and reject unrelated files', () => {
  assert.equal(uploadPath({name:'case.npz',webkitRelativePath:'random100/day1/case.npz'}),'random100/day1/case.npz');
  assert.equal(uploadPath({name:'record.NPZ'}),'record.NPZ');
  assert.throws(()=>uploadPath({name:'notes.txt'}),/\.npz/);
});

test('selected snapshot identity notices changes without depending on property order', () => {
  assert.equal(itemRevision({id:'a',revision:'1'}),itemRevision({revision:'1',id:'a'}));
  assert.notEqual(itemRevision({id:'a',revision:'1'}),itemRevision({id:'a',revision:'2'}));
});

test('moving references use their own nonuniform recorded timestamps and clamp endpoints', () => {
  const trajectory={reference_time_s:[10,10.2,11],reference_xyz:[[0,0,1],[2,0,1],[10,0,1]]};
  assert.doesNotThrow(()=>validateReference(trajectory));
  assert.deepEqual(referencePosition(trajectory,10.6).map(x=>Math.round(x*1e8)/1e8),[6,0,1]);
  assert.deepEqual(referencePosition(trajectory,0),[0,0,1]);
  assert.deepEqual(referencePosition(trajectory,20),[10,0,1]);
  assert.deepEqual(referencePosition({target_xyz:[1,2,3]},5),[1,2,3]);
  assert.equal(referencePosition({},0),null);
  assert.throws(()=>validateReference({...trajectory,reference_time_s:[1,1,2]}),/invalid/);
  assert.throws(()=>validateReference({...trajectory,reference_xyz:[[1,NaN,3]]}),/invalid/);
});

test('wall recordings keep a wall clock label and unknown basis stays neutral', () => {
  assert.equal(playbackClock({metadata:{time_basis:'wall'}}),'wall');
  assert.equal(playbackClock({metadata:{time_basis:'simulation'}}),'simulation');
  assert.equal(playbackClock({}),'recorded');
});

test('only an explicitly marked empty bootstrap scene is a start pose', async () => {
  const {isStartPoseScene, recordingLabel}=await import('./replay-library.js');
  assert.equal(isStartPoseScene({source:{bootstrap:true},trajectories:[]}),true);
  assert.equal(isStartPoseScene({source:{},trajectories:[]}),false);
  assert.equal(isStartPoseScene({source:{bootstrap:true},trajectories:[{}]}),false);
  const items=[{id:'one',name:'folder/run',source:'ingest'},{id:'two',name:'folder/run',source:'upload'}];
  assert.equal(recordingLabel(items[0],items),'ingest/folder/run');
  assert.equal(recordingLabel(items[1],items),'uploads/folder/run');
  assert.equal(recordingLabel(items[0],[items[0]]),'folder/run');
});

test('direct replay links use the library path and stay inside the catalog', async () => {
  const {replayLinkKey, findLinkedItem, linkedKey, replayLinkUrl}=await import('./replay-library.js');
  const ingest={id:'a',name:'reaching/study/run_017',source:'ingest'};
  const upload={id:'b',name:'reaching/study/run_017',source:'upload'};
  const items=[upload,ingest,{id:'default',name:'Default recording',source:'default'}];
  assert.equal(replayLinkKey(ingest),'reaching/study/run_017');
  assert.equal(replayLinkKey(upload),'uploads/reaching/study/run_017');
  assert.equal(replayLinkKey(items[2]),null);
  // Server-owned freezes have no persistent library path to share.
  assert.equal(replayLinkKey({id:'freeze-a',name:'Freeze · 12:34:56',source:'freeze'}),null);
  assert.equal(findLinkedItem(items,'reaching/study/run_017'),ingest);
  assert.equal(findLinkedItem(items,'uploads/reaching/study/run_017'),upload);
  for(const bad of ['../secret','/etc/passwd','reaching/../study/run_017','',null]) assert.equal(findLinkedItem(items,bad),undefined);
  assert.equal(replayLinkUrl('http://h:8090/?x=1&replay=old#t','a b/run'),'http://h:8090/?x=1&replay=a%20b/run#t');
  assert.equal(replayLinkUrl('http://h:8090/?replay=old',null),'http://h:8090/');
  assert.equal(linkedKey('http://h:8090/?replay=reaching/study/run_017'),'reaching/study/run_017');
  assert.equal(linkedKey('http://h:8090/'),null);
});

test('model warning tooltip names both full-URDF hashes', () => {
  assert.equal(modelWarningText(null), '');
  const text = modelWarningText({recorded_model_sha256: 'f451', current_model_sha256: 'd3be'});
  assert.match(text, /different robot-model file/);
  assert.match(text, /Recorded: f451/);
  assert.match(text, /Displayed: d3be/);
});

test('session deep links add catalog tracks without loading a scene, selecting a legacy replay or rewriting the URL', async t => {
  const item = { id: 'run', name: 'study/run', source: 'ingest', status: 'ready', revision: '1' };
  const h = libraryHarness(t, [item]), added = [], scenes = [];
  const library = h.create({ onScene: (...args) => scenes.push(args), onLinkedItem: async item => added.push(item) });
  await flush(); await flush();
  assert.deepEqual(added, [item]); assert.deepEqual(scenes, []); assert.deepEqual(h.requests, ['/api/replays']);
  assert.equal(library.selectedId, 'default'); assert.equal(h.location.href, 'http://localhost:8090/?replay=study/run');
  assert.equal(h.elements.get('recording-link').hidden, true); assert.equal(h.elements.get('library-message').hidden, true);
  library.setLive(true); library.setLive(false); await library.refresh();
  assert.equal(added.length, 1); assert.deepEqual(h.replacements, []);
});

test('a pending session deep link is added once its catalog recording becomes available', async t => {
  const items = [], h = libraryHarness(t, items), added = [];
  const library = h.create({ onLinkedItem: async item => added.push(item) });
  await flush(); assert.equal(added.length, 0); assert.equal(h.elements.get('library-message').hidden, false);
  items.push({ id: 'run', name: 'study/run', source: 'ingest', status: 'ready', revision: '1' });
  await library.refresh(); assert.equal(added.length, 1); assert.equal(h.elements.get('library-message').hidden, true);
  assert(h.requests.every(url => url === '/api/replays')); assert.deepEqual(h.replacements, []);
});

test('legacy ReplayLibrary entrypoints still open a linked scene when no session callback is supplied', async t => {
  const item = { id: 'run', name: 'study/run', source: 'ingest', status: 'ready', revision: '1' }, h = libraryHarness(t, [item]), scenes = [];
  const library = h.create({ onScene: async (scene, item) => scenes.push([scene, item]) });
  await flush(); await flush();
  assert.equal(scenes.length, 1); assert.equal(library.selectedId, 'run');
  assert.deepEqual(h.requests, ['/api/replays', '/api/replays/scene?id=run']);
  library.setLive(true); assert.equal(h.location.href, 'http://localhost:8090/');
});
