import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Coordinator } from '../src/coordinator.mjs';
import { Fault, id } from '../src/common.mjs';

export const config = { kind: 'opensubsonic', baseUrl: 'https://library.example.test/music', username: 'listener', credential: 'synthetic-password' };
export function harness(t, extra = {}) {
  const directory = mkdtempSync(join(process.cwd(), '.test-room-'));
  let clock = 1800000000000;
  const store = new Store(directory), ids = {}, calls = [], missing = new Set();
  let failing = false;
  const factory = (cfg, mapping) => {
    const tracks = ['a','b','c','d','e','f'].map((x,i) => ({ id: mapping.fromProvider('track',x),title:`Track ${x}`,artist:'Synthetic Artist',durationSec:60+i,gainDb:null }));
    const playlistId = mapping.fromProvider('playlist','mix');
    Object.assign(ids, { playlist: playlistId, ...Object.fromEntries(tracks.map((x,i)=>[['a','b','c','d','e','f'][i],x.id])) });
    return {
      kind:cfg.kind,
      async check() { calls.push('check'); if(failing)throw new Error('secret provider details'); },
      async listPlaylists() { calls.push('list'); return {playlists:[{id:playlistId,name:'Library Mix',scene:'calm',trackCount:3}],cursor:null}; },
      async getPlaylist(pid) { calls.push('playlist'); if(pid!==playlistId)throw new Fault(404,'not_found');return{id:pid,name:'Library Mix',scene:'calm',tracks:tracks.slice(0,3)}; },
      async getTrack(tid) { calls.push('track');const track=tracks.find(x=>x.id===tid);if(!track||missing.has(tid))throw new Fault(404,'not_found');return track; },
      async search() { calls.push('search');return tracks; },
      async openStream(tid,range,signal) { calls.push('stream');return {status:range?206:200,contentType:'audio/wav',contentLength:null,contentRange:range?'bytes 0-3/4':null,acceptRanges:'bytes',body:(async function*(){yield Buffer.from('test');if(!signal.aborted)yield Buffer.from('more');})()}; },
    };
  };
  let core = new Coordinator(store,{now:()=>clock,adapterFactory:factory,...extra});
  const h = {
    get core(){return core;},store,ids,calls,missing,
    set failing(v){failing=v;},advance(ms){clock+=ms;}, get now(){return clock;},
    async call(method,path,body,auth,options={}) {
      const headers={...(auth?.hostToken?{authorization:`Bearer ${auth.hostToken}`} : auth?.deviceToken?{authorization:`Bearer ${auth.deviceToken}`} : auth?.party?{'x-party-token':auth.party,...(auth.guestKey?{'x-guest-key':auth.guestKey}:{})}:{})};
      if(method!=='GET')headers['idempotency-key']=options.key??id();
      let raw=Buffer.alloc(0);
      if(body!==undefined){headers['content-type']='application/json';raw=Buffer.from(JSON.stringify(body));}
      Object.assign(headers,options.headers);
      return core.request({method,path,headers,address:options.address??'test-client',readBody:options.readBody??(async()=>raw)});
    },
    async setup(){const r=await h.call('POST','/v1/setup',{setupCode:core.setupCode.value,publicOrigin:'https://room.example.test',library:config});assert.equal(r.status,200,JSON.stringify(r));h.host=r.body;return r.body;},
    async pair(){const start=await h.call('POST','/v1/pairings',{deviceName:'Room TV'});assert.equal(start.status,200);
      const approve=await h.call('POST','/v1/pairings/approve',{userCode:start.body.userCode},h.host);assert.equal(approve.status,200);
      const claim=await h.call('POST',`/v1/pairings/${start.body.pairId}/claim`,{claimSecret:start.body.claimSecret});assert.equal(claim.status,200);h.device=claim.body;return{start:start.body,...claim.body};},
    async ready(){await h.setup();await h.pair();await h.call('PUT','/v1/config/links',{links:[{playlistId:ids.playlist,scene:'calm'}]},h.host);await h.call('GET','/v1/state',undefined,h.device);const start=await h.call('POST','/v1/playback/start',{},h.host);assert.equal(start.status,200);return h;},
    async party(){await h.call('PUT','/v1/party/settings',{enabled:true,order:'first_come'},h.host);const qr=await h.call('GET','/v1/party/qr',undefined,h.host);return qr.body.url.split('#t=')[1];},
    async join(party,name='Guest One'){const r=await h.call('POST','/v1/guest/join',{name},{party});assert.equal(r.status,200);return{party,...r.body};},
    async restart(){await core.serial(async()=>{store.save(core.s);});core=new Coordinator(store,{now:()=>clock,adapterFactory:factory,...extra});},
  };
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return h;
}
