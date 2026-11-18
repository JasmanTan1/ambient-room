import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { harness, config } from './helpers.mjs';
import { id } from '../src/common.mjs';

test('fresh store is unconfigured and private; setup uses one-use code',async t=>{
 const h=harness(t);assert.equal(h.core.s.config,null);assert.equal(statSync(h.store.db.location()).mode&0o777,0o600);
 assert.equal((await h.call('POST','/v1/setup',{setupCode:'wrong-code-000000',publicOrigin:'https://room.example.test',library:config})).status,401);
 await h.setup();assert.equal((await h.call('POST','/v1/setup',{setupCode:'used-code-0000000',publicOrigin:'https://room.example.test',library:config})).body.error,'setup_complete');
 const status=await h.call('GET','/v1/config/library',undefined,h.host);assert.deepEqual(status.body,{configured:true,kind:'opensubsonic',reachable:true});assert(!JSON.stringify(status).includes(config.credential));
});
test('expired setup code and failed connectivity never commit',async t=>{
 const h=harness(t);h.failing=true;const b={setupCode:h.core.setupCode.value,publicOrigin:'https://room.example.test',library:config};
 assert.equal((await h.call('POST','/v1/setup',b)).status,503);assert.equal(h.core.s.config,null);h.failing=false;
 h.advance(300000);assert.equal((await h.call('POST','/v1/setup',b)).status,401);assert.equal(h.core.s.config,null);
});
test('origins reject cleartext, credentials, queries, fragments and paths',async t=>{
 const h=harness(t);
 for(const publicOrigin of ['http://room.example.test','https://fixture@invalid.','https://room.example.test?q=x','https://room.example.test/#x','https://room.example.test/path'])
  assert.equal((await h.call('POST','/v1/setup',{setupCode:h.core.setupCode.value,publicOrigin,library:config})).status,400);
 await h.setup();assert.equal((await h.call('GET','/v1/state',undefined,h.host,{headers:{origin:'https://other.example.test'}})).status,403);
});
test('host login is one-use, expires and revocation precedes retry lookup',async t=>{
 const h=harness(t);await h.setup();const approvalCode=h.core.issueApproval();
 const login=await h.call('POST','/v1/auth/host',{approvalCode});assert.equal(login.status,200);
 assert.equal((await h.call('POST','/v1/auth/host',{approvalCode})).status,401);
 const k=id();assert.equal((await h.call('POST','/v1/auth/revoke',undefined,login.body,{key:k})).status,200);
 assert.equal((await h.call('POST','/v1/auth/revoke',undefined,login.body,{key:k})).status,401);
 h.advance(12*3600000);assert.equal((await h.call('GET','/v1/state',undefined,h.host)).status,401);
});
test('pair claim requires separate secret; pending, approved, bounded retry',async t=>{
 const h=harness(t);await h.setup();const start=(await h.call('POST','/v1/pairings',{deviceName:'Screen'})).body;
 const path=`/v1/pairings/${start.pairId}/claim`;
 assert.equal((await h.call('POST',path,{claimSecret:start.userCode.padEnd(16,'X')})).status,401);
 assert.equal((await h.call('POST',path,{claimSecret:start.claimSecret})).body.status,'pending');
 assert.equal((await h.call('POST','/v1/pairings/approve',{userCode:start.userCode},h.host)).status,200);
 const first=await h.call('POST',path,{claimSecret:start.claimSecret}), retry=await h.call('POST',path,{claimSecret:start.claimSecret});
 assert.equal(first.body.deviceToken,retry.body.deviceToken);assert.equal(first.body.sessionId,retry.body.sessionId);
 h.advance(300000);assert.equal((await h.call('POST',path,{claimSecret:start.claimSecret})).status,410);
});
test('TV replacement and unpair revoke immediately and clear room media',async t=>{
 const h=harness(t);await h.ready();const old=h.device;await h.pair();
 assert.equal((await h.call('GET','/v1/state',undefined,old)).status,401);
 assert.equal((await h.call('DELETE',`/v1/devices/${h.device.deviceId}`,undefined,h.host)).status,200);
 assert.equal((await h.call('GET','/v1/state',undefined,h.device)).status,401);assert.equal(h.core.s.active,null);assert.equal(h.core.s.party,null);
});
test('pair approval failures and pairing starts have address limits',async t=>{
 const h=harness(t);await h.setup();
 for(let n=0;n<10;n++)assert.equal((await h.call('POST','/v1/pairings',{deviceName:'Screen'})).status,200);
 const r=await h.call('POST','/v1/pairings',{deviceName:'Screen'});assert.equal(r.status,429);assert(r.retryAfter>=1);
 for(let n=0;n<10;n++)await h.call('POST','/v1/pairings/approve',{userCode:'AAAAAAAA'},h.host,{address:'failed-client'});
 assert.equal((await h.call('POST','/v1/pairings/approve',{userCode:'AAAAAAAA'},h.host,{address:'failed-client'})).status,429);
});
test('roles and ownership reject before reading a request body',async t=>{
 const h=harness(t);await h.ready();let reads=0;const readBody=async()=>{reads++;throw new Error('must not buffer');};
 assert.equal((await h.call('POST','/v1/pictures',undefined,null,{readBody})).status,401);
 assert.equal((await h.call('POST','/v1/pictures',undefined,h.device,{readBody})).status,403);
 assert.equal((await h.call('GET','/v1/pictures/foreign',undefined,h.host,{readBody})).status,404);
 assert.equal((await h.call('DELETE','/v1/devices/foreign',undefined,h.host,{readBody})).status,404);assert.equal(reads,0);
});
test('closed request shapes and unknown query parameters fail',async t=>{
 const h=harness(t);await h.ready();
 for(const body of [{minutes:0},{minutes:241},{minutes:1.5},{minutes:1,online:true}])assert.equal((await h.call('POST','/v1/timer',body,h.host)).status,400);
 assert.equal((await h.call('GET','/v1/state?unexpected=1',undefined,h.host)).status,400);
 assert.equal((await h.call('GET','/v1/state?since=1&since=2',undefined,h.host)).status,400);
 assert.equal((await h.call('GET','/api/bgm',undefined,h.host)).status,404);
});
test('idempotency binds canonical body, principal, path and survives restart',async t=>{
 const h=harness(t);await h.ready();const key=id();
 const a=await h.call('POST','/v1/playback/control',{action:'next'},h.host,{key});
 const b=await h.call('POST','/v1/playback/control',{action:'next'},h.host,{key});assert.deepEqual(a.body,b.body);
 assert.equal((await h.call('POST','/v1/playback/control',{action:'pause'},h.host,{key})).status,409);
 await h.restart();const c=await h.call('POST','/v1/playback/control',{action:'next'},h.host,{key});assert.deepEqual(c.body,a.body);
 const d=await h.call('POST','/v1/playback/control',{action:'next'},h.device,{key});assert.equal(d.body.cmd.n,a.body.cmd.n+1);
});
test('bad requests do not reserve idempotency keys',async t=>{
 const h=harness(t);await h.ready();const key=id();assert.equal((await h.call('POST','/v1/timer',{minutes:0},h.host,{key})).status,400);
 assert.equal((await h.call('POST','/v1/timer',{minutes:1},h.host,{key})).status,200);
});
test('start and timer require live renderer; state never starts music',async t=>{
 const h=harness(t);await h.setup();await h.pair();
 await h.call('PUT','/v1/config/links',{links:[{playlistId:h.ids.playlist,scene:'rain'}]},h.host);
 assert.equal((await h.call('POST','/v1/playback/start',{},h.host)).body.error,'no_tv');
 await h.call('GET','/v1/state',undefined,h.device);assert.equal(h.core.s.active,null);
 assert.equal((await h.call('POST','/v1/timer',{minutes:1},h.host)).body.error,'not_playing');
 assert.equal((await h.call('POST','/v1/playback/start',{},h.host)).status,200);
 h.advance(30000);assert.equal((await h.call('POST','/v1/timer',{minutes:1},h.host)).body.error,'no_tv');
});
test('timer completion matches ID, preserves playback, pause and zero volume',async t=>{
 const h=harness(t);await h.ready();await h.call('PUT','/v1/volume',{level:0},h.host);await h.call('POST','/v1/playback/control',{action:'pause'},h.host);
 const old=await h.call('POST','/v1/timer',{minutes:1},h.host), next=await h.call('POST','/v1/timer',{minutes:240},h.host);
 const stale=await h.call('POST','/v1/timer/complete',{timerId:old.body.timer.id},h.device);assert.equal(stale.body.ignored,true);assert.equal(stale.body.snapshot.timer.id,next.body.timer.id);
 const complete=await h.call('POST','/v1/timer/complete',{timerId:next.body.timer.id},h.device);assert.equal(complete.body.ignored,false);assert.equal(complete.body.snapshot.timer,null);
 assert.equal(complete.body.snapshot.activePlaylistId,h.ids.playlist);assert.equal(complete.body.snapshot.paused,true);assert.equal(complete.body.snapshot.volume,0);
});
test('resume accepts monotonic session sample, clamps position, never rewinds',async t=>{
 const h=harness(t);await h.ready();const seq=h.core.s.seq;
 const b={playlistId:h.ids.playlist,trackId:h.ids.a,positionSec:999,paused:false,sessionId:h.device.sessionId,sampleN:9};
 assert.equal((await h.call('PUT','/v1/playback/resume',b,h.device)).body.stored,true);assert.equal(h.core.s.resume.positionSec,60);assert.equal(h.core.s.seq,seq);
 for(const body of [{...b,sampleN:8},{...b,sampleN:10,sessionId:'wrong'},{...b,sampleN:10,trackId:h.ids.d}])assert.equal((await h.call('PUT','/v1/playback/resume',body,h.device)).body.stored,false);
 await h.restart();assert.equal((await h.call('PUT','/v1/playback/resume',{...b,sampleN:8},h.device)).body.stored,false);
 await h.call('POST','/v1/playback/stop',undefined,h.host);assert.equal((await h.call('PUT','/v1/playback/resume',{...b,sampleN:10},h.device)).body.stored,false);
});
test('queue next/end, local save/reset and missing move target',async t=>{
 const h=harness(t);await h.ready();
 let r=await h.call('POST','/v1/queue',{trackId:h.ids.c,where:'next'},h.host);assert.deepEqual(r.body.queue.tracks.map(x=>x.id),[h.ids.a,h.ids.c,h.ids.b]);
 r=await h.call('POST','/v1/queue',{trackId:h.ids.d,where:'end'},h.host);assert.deepEqual(r.body.queue.tracks.map(x=>x.id),[h.ids.d,h.ids.a,h.ids.c,h.ids.b]);
 assert.equal((await h.call('POST','/v1/queue/move',{trackId:h.ids.a,beforeId:'missing'},h.host)).status,404);
 await h.call('POST','/v1/queue/save',undefined,h.host);await h.call('DELETE',`/v1/queue/${h.ids.d}`,undefined,h.host);
 r=await h.call('DELETE','/v1/queue',undefined,h.host);assert.deepEqual(r.body.queue.tracks.map(x=>x.id),[h.ids.d,h.ids.a,h.ids.c,h.ids.b]);
 assert(!h.calls.some(x=>x.includes('write')));
});
test('remove current keeps buffered resume and records successor; empty pauses',async t=>{
 const h=harness(t);await h.ready();const removed=await h.call('DELETE',`/v1/queue/${h.ids.a}`,undefined,h.host);
 assert.equal(removed.body.resume.trackId,h.ids.a);assert.equal(removed.body.queue.anchorId,h.ids.b);
 await h.call('DELETE',`/v1/queue/${h.ids.b}`,undefined,h.host);const empty=await h.call('DELETE',`/v1/queue/${h.ids.c}`,undefined,h.host);
 assert.equal(empty.body.paused,true);assert.equal(empty.body.resume,null);assert.equal(empty.body.activePlaylistId,h.ids.playlist);
});
test('queue session edits expire on start after twelve hours',async t=>{
 const h=harness(t);await h.ready();await h.call('POST','/v1/queue',{trackId:h.ids.d,where:'next'},h.host);
 h.advance(12*3600000+1);const approvalCode=h.core.issueApproval();h.host=(await h.call('POST','/v1/auth/host',{approvalCode})).body;
 await h.call('GET','/v1/state',undefined,h.device);const r=await h.call('POST','/v1/playback/start',{},h.host);assert.equal(r.status,200);assert.deepEqual(r.body.queue.tracks.map(x=>x.id),[h.ids.a,h.ids.b,h.ids.c]);
});
test('message cleans Unicode, validates code points and expires without seq change',async t=>{
 const h=harness(t);await h.ready();const r=await h.call('PUT','/v1/message',{text:'  Cafe\u0301\u202e  👩‍🍳 ',style:'banner',minutes:1},h.host);
 assert.equal(r.body.message.text,'Café 👩‍🍳');const seq=r.body.seq;h.advance(60000);
 assert.equal((await h.call('GET','/v1/state',undefined,h.host)).body.message,null);assert.equal(h.core.s.seq,seq);
 assert.equal((await h.call('PUT','/v1/message',{text:'x'.repeat(61),style:'card',minutes:1},h.host)).status,400);
});
test('configuration failure is atomic; replacement resets IDs and local media state',async t=>{
 const h=harness(t);await h.ready();const previous=h.core.s.namespace, active=h.core.s.active;h.failing=true;
 assert.equal((await h.call('PUT','/v1/config/library',config,h.host)).status,503);assert.equal(h.core.s.namespace,previous);assert.equal(h.core.s.active,active);
 h.failing=false;assert.equal((await h.call('PUT','/v1/config/library',config,h.host)).status,200);
 assert.notEqual(h.core.s.namespace,previous);assert.equal(h.core.s.active,null);assert.deepEqual(h.core.s.links,[]);assert.equal(h.core.s.resume,null);
});
test('local recovery revokes all credentials while retaining saved local orders',async t=>{
 const h=harness(t);await h.ready();await h.call('POST','/v1/queue/save',undefined,h.host);const orders=structuredClone(h.core.s.overrides);
 const code=await h.core.recover();assert(code.length>=32);assert.deepEqual(h.core.s.overrides,orders);
 assert.equal((await h.call('GET','/v1/state',undefined,h.host)).status,401);assert.equal((await h.call('GET','/v1/state',undefined,h.device)).status,401);
});
test('successor anchor advances when removed and clears after renderer transition',async t=>{
 const h=harness(t);await h.ready();await h.call('DELETE',`/v1/queue/${h.ids.a}`,undefined,h.host);
 assert.equal(h.core.s.queue.anchorId,h.ids.b);await h.call('DELETE',`/v1/queue/${h.ids.b}`,undefined,h.host);assert.equal(h.core.s.queue.anchorId,h.ids.c);
 const sample={playlistId:h.ids.playlist,trackId:h.ids.c,positionSec:1,paused:false,sessionId:h.device.sessionId,sampleN:1};
 assert.equal((await h.call('PUT','/v1/playback/resume',sample,h.device)).body.stored,true);assert.equal(h.core.s.queue.anchorId,null);
});
test('idle controls require explicit start and cannot create a playing idle state',async t=>{
 const h=harness(t);await h.ready();await h.call('POST','/v1/playback/stop',undefined,h.host);
 assert.equal((await h.call('POST','/v1/playback/control',{action:'play'},h.host)).body.error,'not_playing');assert.equal(h.core.s.paused,true);
});
