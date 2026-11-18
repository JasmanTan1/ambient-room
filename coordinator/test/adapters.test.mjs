import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OpenSubsonic, Jellyfin } from '../src/adapters.mjs';
import { rangeHeader } from '../src/common.mjs';

function context(kind, handler) {
 const forward=new Map(),back=new Map(),calls=[];
 const ids={fromProvider(type,p){const k=`${type}:${p}`;if(!forward.has(k)){const id=`opaque_${forward.size}`;forward.set(k,id);back.set(`${type}:${id}`,p);}return forward.get(k);},toProvider(type,id){return back.get(`${type}:${id}`)??null;}};
 const credentials={username:'synthetic-user',credential:'synthetic-password'};
 const c={baseUrl:new URL('https://library.example.test/installation'),credentials,ids,fetch:async(url,opts)=>{assert.equal(url.origin,'https://library.example.test');assert.equal(opts.redirect,'manual');assert.equal(opts.method,'GET');calls.push({url:new URL(url),opts});return handler(new URL(url),opts);}};
 return{a:kind==='opensubsonic'?new OpenSubsonic(c):new Jellyfin(c),ids,calls,credentials};
}
const json=x=>new Response(JSON.stringify(x),{headers:{'content-type':'application/json'}});
const sub=x=>json({'subsonic-response':{status:'ok',...x}});
const song=(id='song-a')=>({id,title:'Synthetic tone',artist:'Fixture artist',duration:8,type:'music'});
const audio=(Id='audio-a')=>({Id,Type:'Audio',Name:'Synthetic tone',Artists:['Fixture artist'],RunTimeTicks:80000000});

test('OpenSubsonic token auth uses salt + MD5 and preserves installation path',async()=>{
 const h=context('opensubsonic',async()=>sub({}));await h.a.check();
 const {url}=h.calls[0];assert.equal(url.pathname,'/installation/rest/ping.view');const s=url.searchParams.get('s');assert(s.length>=16);
 assert.equal(url.searchParams.get('t'),createHash('md5').update(h.credentials.credential+s).digest('hex'));assert(!url.href.includes(h.credentials.credential));
});
test('OpenSubsonic list pagination, stable opaque IDs, full playlist and gains',async()=>{
 const h=context('opensubsonic',async u=>u.pathname.includes('getPlaylists')?sub({playlists:{playlist:[{id:'mix-a',name:'Mix',songCount:1},{id:'mix-b',name:'Second',songCount:0}]}}):sub({playlist:{id:'mix-a',name:'Mix',songCount:1,entry:[{...song(),replayGain:{trackGain:-4}}]}}));
 const first=await h.a.listPlaylists(null,1);assert.equal(first.cursor,'1');const second=await h.a.listPlaylists(first.cursor,1);assert.equal(second.cursor,null);
 const again=await h.a.listPlaylists(null,1);assert.equal(first.playlists[0].id,again.playlists[0].id);
 const p=await h.a.getPlaylist(first.playlists[0].id);assert.equal(p.tracks[0].gainDb,-4);assert(!JSON.stringify(p).includes('song-a'));assert(!JSON.stringify(p).includes('mix-a'));
});
test('OpenSubsonic search requests only library songs and sanitizes projection',async()=>{
 const h=context('opensubsonic',async()=>sub({searchResult3:{song:[{...song(),url:'https://outside.example.test',path:'/synthetic/input'}, {...song('video'),isVideo:true}]}}));
 const tracks=await h.a.search('tone',30);assert.equal(tracks.length,1);assert.deepEqual(Object.keys(tracks[0]).sort(),['artist','durationSec','gainDb','id','title']);
 assert.equal(h.calls[0].url.searchParams.get('songCount'),'30');assert.equal(h.calls[0].url.searchParams.get('artistCount'),'0');
});
test('OpenSubsonic oversized playlist and provider mismatch fail explicitly',async()=>{
 const h=context('opensubsonic',async()=>sub({playlist:{id:'mix',songCount:5001,entry:[]}}));const id=h.ids.fromProvider('playlist','mix');
 await assert.rejects(h.a.getPlaylist(id),e=>e.status===409);
 const x=context('opensubsonic',async()=>sub({song:song('wrong')}));await assert.rejects(x.a.getTrack(x.ids.fromProvider('track','wanted')),e=>e.status===503);
});
test('OpenSubsonic missing and non-audio tracks never stream',async()=>{
 let streamCalls=0;const h=context('opensubsonic',async u=>{if(u.pathname.includes('/stream'))streamCalls++;return sub({song:{...song(),isVideo:true}});});
 await assert.rejects(h.a.openStream(h.ids.fromProvider('track','song-a'),null),e=>e.status===404);assert.equal(streamCalls,0);
 await assert.rejects(h.a.getTrack('unmapped'),e=>e.status===404);
});
test('OpenSubsonic ranges propagate, direct raw stream returns media bytes',async()=>{
 const h=context('opensubsonic',async u=>u.pathname.includes('getSong')?sub({song:song()}):new Response('data',{status:206,headers:{'content-type':'audio/wav','content-range':'bytes 0-3/4','content-length':'4'}}));
 const media=await h.a.openStream(h.ids.fromProvider('track','song-a'),{header:'bytes=0-3'});
 assert.equal(media.status,206);assert.equal(h.calls[1].opts.headers.Range,'bytes=0-3');assert.equal(h.calls[1].url.searchParams.get('format'),'raw');
 let size=0;for await(const p of media.body)size+=p.length;assert.equal(size,4);
});
test('Jellyfin authentication stays in header and IDs are opaque',async()=>{
 const h=context('jellyfin',async()=>json({Items:[{Id:'mix',Name:'Mix',Type:'Playlist',MediaType:'Audio',ChildCount:1}],TotalRecordCount:1}));
 const page=await h.a.listPlaylists(null,50);assert.equal(page.cursor,null);assert(page.playlists[0].id.startsWith('opaque_'));
 assert(h.calls[0].opts.headers.Authorization.includes('Token="synthetic-password"'));assert(!h.calls[0].url.href.includes(h.credentials.credential));assert.equal(h.calls[0].url.pathname,'/installation/Items');
});
test('Jellyfin playlist drains all pages in order before returning',async()=>{
 const items=Array.from({length:501},(_,i)=>audio(`audio-${i}`));
 const h=context('jellyfin',async u=>{
  if(u.pathname.endsWith('/Items')&&u.searchParams.has('Ids'))return json({Items:[{Id:'mix',Name:'Mix',Type:'Playlist',MediaType:'Audio'}],TotalRecordCount:1});
  const start=+u.searchParams.get('StartIndex'),limit=+u.searchParams.get('Limit');return json({Items:items.slice(start,start+limit),TotalRecordCount:501});
 });
 const p=await h.a.getPlaylist(h.ids.fromProvider('playlist','mix'));assert.equal(p.tracks.length,501);assert.equal(p.tracks[500].durationSec,8);
 assert.equal(h.calls.length,3);assert.equal(h.calls[2].url.searchParams.get('StartIndex'),'500');
});
test('Jellyfin oversize and empty nonterminal pages fail without truncation',async()=>{
 const h=context('jellyfin',async u=>u.searchParams.has('Ids')?json({Items:[{Id:'mix',Name:'Mix',Type:'Playlist'}]}):json({Items:[audio()],TotalRecordCount:5001}));
 await assert.rejects(h.a.getPlaylist(h.ids.fromProvider('playlist','mix')),e=>e.status===409);
 const x=context('jellyfin',async()=>json({Items:[],TotalRecordCount:2}));await assert.rejects(x.a.listPlaylists(null,20),e=>e.status===503);
});
test('Jellyfin search and stream use audio-only read endpoints',async()=>{
 const h=context('jellyfin',async u=>u.pathname.includes('/Audio/')?new Response('wave',{headers:{'content-type':'audio/wav'}}):json({Items:[audio()],TotalRecordCount:1}));
 const result=await h.a.search('tone',30);assert.equal(h.calls[0].url.searchParams.get('IncludeItemTypes'),'Audio');
 await h.a.openStream(result[0].id,null);assert.equal(h.calls.at(-1).url.pathname,'/installation/Audio/audio-a/stream');assert.equal(h.calls.at(-1).url.searchParams.get('Static'),'true');
});
for(const kind of ['opensubsonic','jellyfin']) {
 test(`${kind} rejects redirects without following or leaking credentials`,async()=>{
  const h=context(kind,async()=>new Response(null,{status:302,headers:{location:'https://outside.example.test'}}));await assert.rejects(h.a.check(),e=>e.status===503);assert.equal(h.calls.length,1);
 });
 test(`${kind} malformed JSON and transport errors stay generic`,async()=>{
  const h=context(kind,async()=>new Response('private provider details',{headers:{'content-type':'application/json'}}));await assert.rejects(h.a.check(),e=>e.message==='upstream_unavailable');
  const x=context(kind,async()=>{throw new Error('private provider details');});await assert.rejects(x.a.check(),e=>e.message==='upstream_unavailable');
 });
 test(`${kind} cancellation signal is propagated to transport`,async()=>{
  const controller=new AbortController();controller.abort();const h=context(kind,async(_,o)=>{assert(o.signal.aborted);throw new Error('cancelled');});await assert.rejects(h.a.check(controller.signal),e=>e.status===503);
 });
 test(`${kind} range 416 and HTTP missing errors map safely`,async()=>{
  const h=context(kind,async()=>new Response(null,{status:404}));await assert.rejects(h.a.check(),e=>e.status===404);
  const x=context(kind,async()=>new Response(null,{status:416}));await assert.rejects(x.a.check(),e=>e.status===416);
 });
}
test('range grammar accepts suffix/open ranges and refuses multiple or invalid ranges',()=>{
 for(const s of ['bytes=0-3','bytes=2-','bytes=-5'])assert.equal(rangeHeader(s).header,s);
 for(const s of ['bytes=3-1','bytes=-0','bytes=-','bytes=0-1,2-3','bytes=9007199254740992-'])assert.throws(()=>rangeHeader(s),e=>e.status===416);
});
