import test from 'node:test';
import assert from 'node:assert/strict';
import { itemRevision, modelWarningText, uploadPath, validateReference, referencePosition, playbackClock } from './replay-library.js';

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
