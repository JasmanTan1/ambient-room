import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.mjs';

test('oversized upstream playlist fails atomically without truncation',async t=>{
 const h=harness(t);await h.ready();const before=structuredClone(h.core.s.queue),base=h.core.library();
 h.core.makeAdapter=()=>({...base,async getPlaylist(id){return{id,name:'Oversized',scene:'calm',tracks:Array.from({length:5001},(_,i)=>({id:`track_${i}`,title:'Tone',artist:'Fixture',durationSec:1,gainDb:null}))};}});
 assert.equal((await h.call('POST','/v1/playback/start',{},h.host)).status,409);assert.deepEqual(h.core.s.queue,before);
});
test('5000-track queue is accepted, further add refused; empty playlist cannot start',async t=>{
 const h=harness(t);await h.ready();const base=h.core.library();
 h.core.makeAdapter=()=>({...base,async getPlaylist(id){return{id,name:'Full',scene:'calm',tracks:Array.from({length:5000},(_,i)=>({id:`track_${i}`,title:'Tone',artist:'Fixture',durationSec:1,gainDb:null}))};}});
 h.core.s.queue=null;assert.equal((await h.call('POST','/v1/playback/start',{},h.host)).body.queue.tracks.length,5000);
 assert.equal((await h.call('POST','/v1/queue',{trackId:h.ids.d,where:'next'},h.host)).status,409);
 h.core.makeAdapter=()=>({...base,async getPlaylist(id){return{id,name:'Empty',scene:'calm',tracks:[]};}});h.core.s.queue=null;
 assert.equal((await h.call('POST','/v1/playback/start',{},h.host)).body.error,'empty_playlist');
});
test('links accept twenty, reject duplicate and over-cap entries',async t=>{
 const h=harness(t);await h.ready();const base=h.core.library();h.core.makeAdapter=()=>({...base,async getPlaylist(id){return{id,name:'Mix',scene:'calm',tracks:[]};}});
 const links=Array.from({length:20},(_,i)=>({playlistId:`mix_${i}`,scene:'calm'}));
 assert.equal((await h.call('PUT','/v1/config/links',{links},h.host)).status,200);
 assert.equal((await h.call('PUT','/v1/config/links',{links:[...links,{playlistId:'extra',scene:'calm'}]},h.host)).status,400);
 assert.equal((await h.call('PUT','/v1/config/links',{links:[links[0],links[0]]},h.host)).status,400);
});
test('removing selected playlist link stops playback and invalidates late resume',async t=>{
 const h=harness(t);await h.ready();const playlistId=h.ids.playlist,trackId=h.ids.a;
 assert.equal((await h.call('PUT','/v1/config/links',{links:[]},h.host)).status,200);assert.equal(h.core.s.active,null);
 assert.equal((await h.call('PUT','/v1/playback/resume',{playlistId,trackId,positionSec:1,paused:false,sessionId:h.device.sessionId,sampleN:1},h.device)).body.stored,false);
});
test('guest projection is capped at forty upcoming entries',async t=>{
 const h=harness(t);await h.ready();const base=h.core.library();h.core.makeAdapter=()=>({...base,async getPlaylist(id){return{id,name:'Long mix',scene:'calm',tracks:Array.from({length:60},(_,i)=>({id:`track_${i}`,title:'Tone',artist:'Fixture',durationSec:1,gainDb:null}))};}});
 h.core.s.queue=null;await h.call('POST','/v1/playback/start',{},h.host);const g=await h.join(await h.party());
 assert.equal((await h.call('GET','/v1/guest/state',undefined,g)).body.upNext.length,40);
});
