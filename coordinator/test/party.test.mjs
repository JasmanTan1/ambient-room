import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.mjs';
import { id } from '../src/common.mjs';

test('party defaults off; token remains stable across disable/re-enable',async t=>{
 const h=harness(t);await h.ready();assert.equal(h.core.s.enabled,false);assert.equal(h.core.s.party,null);
 const party=await h.party(), g=await h.join(party);
 await h.call('PUT','/v1/party/settings',{enabled:false,order:'first_come'},h.host);
 assert.equal((await h.call('GET','/v1/guest/state',undefined,g)).body.error,'off');
 await h.call('PUT','/v1/party/settings',{enabled:true,order:'take_turns'},h.host);
 assert.equal(await h.party(),party);assert.equal((await h.call('GET','/v1/guest/state',undefined,g)).status,200);
});
test('renew invalidates membership and retries, purges pending, preserves host entries/current',async t=>{
 const h=harness(t);await h.ready();const party=await h.party(),g=await h.join(party),key=id();
 await h.call('POST','/v1/guest/requests',{trackId:h.ids.d},g,{key});
 await h.call('POST','/v1/party/renew',undefined,h.host);
 assert.equal((await h.call('POST','/v1/guest/requests',{trackId:h.ids.d},g,{key})).status,410);
 assert.deepEqual(h.core.s.queue.tracks,[h.ids.a,h.ids.b,h.ids.c]);assert.equal(h.core.s.resume.trackId,h.ids.a);
 assert.deepEqual(h.core.s.guests,{});assert.deepEqual(h.core.s.requests,[]);
 assert(!Object.values(h.core.s.idem).some(x=>x.guest));
});
test('party expires at twelve hours, survives restart only while live, never auto-renews',async t=>{
 const h=harness(t);await h.ready();const party=await h.party(),g=await h.join(party);
 await h.restart();assert.equal(h.core.s.party.token,party);h.advance(12*3600000);
 assert.equal((await h.call('GET','/v1/guest/state',undefined,g)).status,410);assert.equal(h.core.s.party,null);
 await h.restart();assert.equal(h.core.s.party,null);await h.call('GET','/v1/state',undefined,h.device);assert.equal(h.core.s.party,null);
 const approvalCode=h.core.issueApproval();h.host=(await h.call('POST','/v1/auth/host',{approvalCode})).body;
 await h.call('PUT','/v1/party/settings',{enabled:false,order:'first_come'},h.host);
 await h.call('PUT','/v1/party/settings',{enabled:true,order:'first_come'},h.host);assert.equal(h.core.s.party,null);
 await h.call('POST','/v1/playback/start',{},h.host);assert.equal(h.core.s.party,null);
 assert.equal((await h.call('POST','/v1/party/renew',undefined,h.host)).body.active,true);
});
test('stop ends party immediately; pause keeps it live',async t=>{
 const h=harness(t);await h.ready();const g=await h.join(await h.party());
 await h.call('POST','/v1/playback/control',{action:'pause'},h.host);assert.equal((await h.call('GET','/v1/guest/state',undefined,g)).status,200);
 await h.call('POST','/v1/playback/stop',undefined,h.host);assert.equal((await h.call('GET','/v1/guest/state',undefined,g)).status,410);
});
test('guest search and adds are library-only, schema-closed and membership checked',async t=>{
 const h=harness(t);await h.ready();const party=await h.party(),g=await h.join(party);
 assert.equal((await h.call('GET','/v1/guest/search?q=track',undefined,{party})).body.error,'join_first');
 assert.equal((await h.call('GET','/v1/guest/search?q=track&online=true',undefined,g)).status,400);
 assert.equal((await h.call('GET','/v1/guest/search?q=track',undefined,g)).status,200);
 for(const extra of [{url:'https://media.example.test/song'},{externalId:'outside'},{online:true}])assert.equal((await h.call('POST','/v1/guest/requests',{trackId:h.ids.d,...extra},g)).status,400);
 h.missing.add(h.ids.d);assert.equal((await h.call('POST','/v1/guest/requests',{trackId:h.ids.d},g)).status,404);
 h.missing.clear();assert.equal((await h.call('POST','/v1/guest/requests',{trackId:h.ids.d},g)).status,200);
 assert.equal((await h.call('POST','/v1/guest/requests',{trackId:h.ids.d},g)).body.error,'already');
});
test('guest projections reveal no tokens, host snapshot, config or provider data',async t=>{
 const h=harness(t);await h.ready();const party=await h.party(),g=await h.join(party);
 const anonymous=await h.call('GET','/v1/guest/state',undefined,{party});assert.equal(anonymous.body.you,null);
 for(const key of ['tokens','hostToken','guestKey','seq','config','baseUrl','credential','roomId','namespace'])assert(!JSON.stringify(anonymous.body).includes(`"${key}"`));
 assert.equal((await h.call('GET','/v1/state',undefined,g)).status,401);
 assert.equal((await h.call('GET','/v1/config/library',undefined,g)).status,401);
 assert.equal((await h.call('GET','/v1/guest/state',undefined,{...g,guestKey:'invalid-key-000000'})).status,401);
});
test('guest can remove own waiting request and control only own playing request',async t=>{
 const h=harness(t);await h.ready();const party=await h.party(),one=await h.join(party,'One'),two=await h.join(party,'Two');
 const req=(await h.call('POST','/v1/guest/requests',{trackId:h.ids.d},one)).body;
 assert.equal((await h.call('DELETE',`/v1/guest/requests/${req.id}`,undefined,two)).body.error,'not_yours');
 assert.equal((await h.call('POST','/v1/guest/control',{action:'pause'},one)).body.error,'not_yours');
 await h.call('POST','/v1/playback/control',{action:'next'},h.host);
 assert.equal((await h.call('POST','/v1/guest/control',{action:'pause'},two)).body.error,'not_yours');
 assert.equal((await h.call('POST','/v1/guest/control',{action:'pause'},one)).status,200);
 assert.equal((await h.call('DELETE',`/v1/guest/requests/${req.id}`,undefined,one)).body.error,'not_yours');
});
test('host removal of playing request skips immediately',async t=>{
 const h=harness(t);await h.ready();const g=await h.join(await h.party());
 const req=(await h.call('POST','/v1/guest/requests',{trackId:h.ids.d},g)).body;
 await h.call('POST','/v1/playback/control',{action:'next'},h.host);assert.equal(h.core.current(),h.ids.d);
 await h.call('DELETE',`/v1/party/requests/${req.id}`,undefined,h.host);
 assert.equal(h.core.current(),h.ids.b);assert.equal(h.core.s.cmd.action,'next');assert.equal(h.core.s.requests[0].state,'removed');
});
test('block clears waiting, skips current, denies state/rejoin/replay; unblock restores eligibility',async t=>{
 const h=harness(t);await h.ready();const party=await h.party(),joinKey=id();
 const joined=await h.call('POST','/v1/guest/join',{name:'One'},{party},{key:joinKey});const g={party,...joined.body};
 await h.call('POST','/v1/guest/requests',{trackId:h.ids.d},g);await h.call('POST','/v1/guest/requests',{trackId:h.ids.e},g);
 await h.call('POST','/v1/playback/control',{action:'next'},h.host);
 await h.call('POST',`/v1/party/guests/${g.guestId}/block`,{blocked:true},h.host);
 assert.notEqual(h.core.current(),h.ids.d);assert(!h.core.s.queue.tracks.includes(h.ids.e));
 for(const [method,path,body,auth,key] of [['GET','/v1/guest/state',undefined,g],['POST','/v1/guest/join',{name:'Again'},g],['POST','/v1/guest/join',{name:'One'},{party},joinKey]])
  assert.equal((await h.call(method,path,body,auth,{key})).body.error,'blocked');
 await h.call('POST',`/v1/party/guests/${g.guestId}/block`,{blocked:false},h.host);
 assert.equal((await h.call('GET','/v1/guest/state',undefined,g)).status,200);assert(h.core.s.requests.every(r=>r.state==='removed'));
});
test('take turns maps requests into stable host slots; setting changes reorder waiting',async t=>{
 const h=harness(t);await h.ready();const party=await h.party(),one=await h.join(party,'One'),two=await h.join(party,'Two');
 await h.call('POST','/v1/guest/requests',{trackId:h.ids.d},one);await h.call('POST','/v1/guest/requests',{trackId:h.ids.e},one);await h.call('POST','/v1/guest/requests',{trackId:h.ids.f},two);
 assert.deepEqual(h.core.s.queue.tracks,[h.ids.a,h.ids.d,h.ids.e,h.ids.f,h.ids.b,h.ids.c]);
 await h.call('PUT','/v1/party/settings',{enabled:true,order:'take_turns'},h.host);
 assert.deepEqual(h.core.s.queue.tracks,[h.ids.a,h.ids.d,h.ids.f,h.ids.e,h.ids.b,h.ids.c]);
 assert.equal(h.core.current(),h.ids.a);
});
test('guest may request a track again after it played',async t=>{
 const h=harness(t);await h.ready();const g=await h.join(await h.party());
 await h.call('POST','/v1/guest/requests',{trackId:h.ids.d},g);await h.call('POST','/v1/playback/control',{action:'next'},h.host);await h.call('POST','/v1/playback/control',{action:'next'},h.host);
 assert.equal(h.core.s.requests[0].state,'played');assert.equal((await h.call('POST','/v1/guest/requests',{trackId:h.ids.d},g)).status,200);
});
test('guest join cap and per-address search limits return bounded errors',async t=>{
 const h=harness(t);await h.ready();const party=await h.party(),g=await h.join(party);
 for(let i=0;i<30;i++)assert.equal((await h.call('GET','/v1/guest/search?q=track',undefined,g)).status,200);
 assert.equal((await h.call('GET','/v1/guest/search?q=track',undefined,g)).status,429);
 for(let i=1;i<100;i++)await h.call('POST','/v1/guest/join',{name:`Guest ${i}`},{party},{address:`synthetic-client-${i}`});
 assert.equal(Object.keys(h.core.s.guests).length,100);
 assert.equal((await h.call('POST','/v1/guest/join',{name:'Extra'},{party},{address:'extra-client'})).status,409);
});
