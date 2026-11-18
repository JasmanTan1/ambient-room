import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { harness } from './helpers.mjs';

test('revocation aborts an active upstream stream immediately',async t=>{
 const h=harness(t);await h.ready();const base=h.core.library();let aborted=false;
 h.core.makeAdapter=()=>({...base,async openStream(_id,_range,signal){return{status:200,contentType:'audio/wav',contentLength:null,body:(async function*(){
  yield Buffer.from('first');if(!signal.aborted)await once(signal,'abort');aborted=true;
 })()};}});
 const r=await h.call('GET',`/v1/tracks/${h.ids.a}/stream`,undefined,h.host),iterator=r.media.body[Symbol.asyncIterator]();
 assert.equal((await iterator.next()).value.toString(),'first');const waiting=iterator.next();
 assert.equal((await h.call('POST','/v1/auth/revoke',undefined,h.host)).status,200);
 assert.equal((await waiting).done,true);assert.equal(aborted,true);
});
test('device streams are confined to selected playlists and membership is checked',async t=>{
 const h=harness(t);await h.ready();
 assert.equal((await h.call('GET',`/v1/tracks/${h.ids.d}/stream`,undefined,h.device)).status,404);
 await h.call('POST','/v1/queue',{trackId:h.ids.d,where:'next'},h.host);
 assert.equal((await h.call('GET',`/v1/tracks/${h.ids.d}/stream`,undefined,h.device)).status,200);
 await h.call('DELETE',`/v1/queue/${h.ids.d}`,undefined,h.host);
 assert.equal((await h.call('GET',`/v1/tracks/${h.ids.d}/stream`,undefined,h.device)).status,404);
});
test('device tokens expire after thirty days across restart',async t=>{
 const h=harness(t);await h.ready();h.advance(30*24*3600000);await h.restart();
 assert.equal((await h.call('GET','/v1/state',undefined,h.device)).status,401);assert.equal(h.core.s.active,null);
});
test('guest deletion retries succeed for own removed request',async t=>{
 const h=harness(t);await h.ready();const g=await h.join(await h.party());const r=await h.call('POST','/v1/guest/requests',{trackId:h.ids.d},g);
 const path=`/v1/guest/requests/${r.body.id}`,options={key:'delete_request'};
 const first=await h.call('DELETE',path,undefined,g,options),retry=await h.call('DELETE',path,undefined,g,options);
 assert.equal(first.status,200);assert.deepEqual(retry.body,first.body);
});
test('renderer read and write rates, host ordinary write and message rates',async t=>{
 const h=harness(t);await h.ready();h.core.limits.clear();
 for(let n=0;n<240;n++)assert.equal((await h.call('GET','/v1/state',undefined,h.device)).status,200);
 assert.equal((await h.call('GET','/v1/state',undefined,h.device)).status,429);h.core.limits.clear();
 for(let n=0;n<60;n++)assert.equal((await h.call('PUT','/v1/volume',{level:n},h.device)).status,200);
 assert.equal((await h.call('PUT','/v1/volume',{level:0},h.device)).status,429);h.core.limits.clear();
 for(let n=0;n<30;n++)assert.equal((await h.call('PUT','/v1/volume',{level:n},h.host)).status,200);
 assert.equal((await h.call('PUT','/v1/volume',{level:0},h.host)).status,429);h.core.limits.clear();
 for(let n=0;n<6;n++)assert.equal((await h.call('PUT','/v1/message',{text:'Welcome',style:'card',minutes:1},h.host)).status,200);
 assert.equal((await h.call('PUT','/v1/message',{text:'Welcome',style:'card',minutes:1},h.host)).status,429);
});
test('pair claim and host moderation rate limits',async t=>{
 const h=harness(t);await h.ready();const pair=(await h.call('POST','/v1/pairings',{deviceName:'Screen'})).body;
 for(let n=0;n<30;n++)assert.equal((await h.call('POST',`/v1/pairings/${pair.pairId}/claim`,{claimSecret:pair.claimSecret})).status,200);
 assert.equal((await h.call('POST',`/v1/pairings/${pair.pairId}/claim`,{claimSecret:pair.claimSecret})).status,429);h.core.limits.clear();
 for(let n=0;n<60;n++)assert.equal((await h.call('PUT','/v1/party/settings',{enabled:false,order:'first_come'},h.host)).status,200);
 assert.equal((await h.call('PUT','/v1/party/settings',{enabled:false,order:'first_come'},h.host)).status,429);
});
test('guest read, join, add and control rates apply before processing',async t=>{
 const h=harness(t);await h.ready();const party=await h.party(),g=await h.join(party);h.core.limits.clear();
 for(let n=0;n<120;n++)assert.equal((await h.call('GET','/v1/guest/state',undefined,g)).status,200);
 assert.equal((await h.call('GET','/v1/guest/state',undefined,g)).status,429);h.core.limits.clear();
 for(let n=0;n<20;n++)assert.equal((await h.call('POST','/v1/guest/join',{name:'Guest'},g)).status,200);
 assert.equal((await h.call('POST','/v1/guest/join',{name:'Guest'},g)).status,429);h.core.limits.clear();
 for(let n=0;n<15;n++)await h.call('POST','/v1/guest/requests',{trackId:h.ids.d},g);
 assert.equal((await h.call('POST','/v1/guest/requests',{trackId:h.ids.d},g)).status,429);h.core.limits.clear();
 for(let n=0;n<20;n++)assert.equal((await h.call('POST','/v1/guest/control',{action:'pause'},g)).status,403);
 assert.equal((await h.call('POST','/v1/guest/control',{action:'pause'},g)).status,429);
});
test('setup and login brute force are limited per immediate client address',async t=>{
 const h=harness(t);await h.setup();h.core.limits.clear();
 for(let n=0;n<10;n++)assert.equal((await h.call('POST','/v1/auth/host',{approvalCode:'incorrect-code-0000'})).status,401);
 const limited=await h.call('POST','/v1/auth/host',{approvalCode:'incorrect-code-0000'});assert.equal(limited.status,429);assert(limited.retryAfter>0);
});
test('unknown and missing write keys are refused before mutation',async t=>{
 const h=harness(t);await h.ready();const seq=h.core.s.seq;
 assert.equal((await h.call('PUT','/v1/volume',{level:10},h.host,{headers:{'idempotency-key':''}})).status,400);
 assert.equal((await h.call('PUT','/v1/volume',{level:10},h.host,{headers:{'idempotency-key':'bad key'}})).status,400);assert.equal(h.core.s.seq,seq);
});
test('slow-body replay cannot bypass expiry after authentication',async t=>{
 const h=harness(t);await h.ready();const key='cached_volume';await h.call('PUT','/v1/volume',{level:10},h.host,{key});
 const r=await h.call('PUT','/v1/volume',{level:10},h.host,{key,readBody:async()=>{h.advance(12*3600000);return Buffer.from('{"level":10}');}});
 assert.equal(r.status,401);
});
