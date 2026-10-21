import test from 'node:test';
import assert from 'node:assert/strict';
import { createPathLine, setPathPoints, setPathPointCount } from './path-lines.js';

test('wide replay progress counts segments and preserves repeated sample indices', () => {
  const line=createPathLine([[1,2,3],[1+1e-12,2,3],[2,2,3],[3,2,3]],{color:0x34d8d4});
  assert.equal(line.isLine2,true);
  assert.equal(line.material.linewidth,3);
  setPathPointCount(line,1);assert.equal(line.geometry.instanceCount,0);assert.equal(line.visible,false);
  setPathPointCount(line,2);assert.equal(line.geometry.instanceCount,0);
  setPathPointCount(line,3);assert.equal(line.geometry.instanceCount,1);
  setPathPointCount(line,4);assert.equal(line.geometry.instanceCount,2);
  setPathPointCount(line,100);assert.equal(line.geometry.instanceCount,2);
  line.geometry.dispose();line.material.dispose();
});

test('empty/single/stationary traces remain hidden with finite bounds and update cleanly', () => {
  const line=createPathLine([],{color:0xffffff});
  for(const points of [[],[[4,5,6]],[[4,5,6],[4,5,6]]]) {
    setPathPoints(line,points);
    assert.equal(line.visible,false);assert.equal(line.geometry.instanceCount,0);
    assert(Number.isFinite(line.geometry.boundingSphere.radius));
    assert([...line.geometry.attributes.instanceStart.data.array].every(Number.isFinite));
  }
  let disposed=false;line.geometry.addEventListener('dispose',()=>{disposed=true;});
  setPathPoints(line,[[4,5,6],[4.1,5,6]]);
  assert.equal(disposed,true);assert.equal(line.visible,true);assert.equal(line.geometry.instanceCount,1);
  setPathPoints(line,[]);assert.equal(line.visible,false);
  assert.throws(()=>setPathPoints(line,[[NaN,0,0]]),/finite/);
  line.geometry.dispose();line.material.dispose();
});

test('dashed reference resolution follows CSS viewport updates in the installed renderer hook', () => {
  const line=createPathLine([[0,0,0],[1,0,0]],{color:0xffb547,dashed:true});
  assert.equal(line.material.linewidth,2.5);assert.equal(line.material.dashed,true);
  assert(line.geometry.attributes.instanceDistanceEnd);
  for(const [width,height] of [[960,640],[720,480]]) {
    line.onBeforeRender({getViewport:target=>target.set(0,0,width,height)});
    assert.deepEqual(line.material.resolution.toArray(),[width,height]);
  }
  line.geometry.dispose();line.material.dispose();
});
