import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ema} from '../src/ema.js';

test('ema seeds with the fixed period SMA, then recurses with the standard 2/(period+1) smoothing constant',()=>{
 const closes=[1,2,3,4,5,6,7,8];
 const out=ema(closes,4);
 assert.deepEqual(out.slice(0,3),[null,null,null]);
 assert.equal(out[3],(1+2+3+4)/4);
 const k=2/(4+1);
 assert.ok(Math.abs(out[4]!-(5*k+out[3]!*(1-k)))<1e-9);
 assert.ok(Math.abs(out[7]!-(8*k+out[6]!*(1-k)))<1e-9);
});

test('insufficient length or non-finite input returns an all-null series rather than a fabricated average',()=>{
 assert.deepEqual(ema([1,2],5),[null,null]);
 assert.deepEqual(ema([1,NaN,3,4,5],5),[null,null,null,null,null]);
 assert.deepEqual(ema([],3),[]);
});
