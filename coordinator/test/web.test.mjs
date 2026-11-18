import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { joinContext, acceptSnapshot } from '../web/app.mjs';

function storage(){const m=new Map();return{getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k),m};}
test('guest fragment is removed from history; keys use neutral session storage',()=>{
 const s=storage(),calls=[];const g=joinContext({hash:'#t=synthetic-party-token',pathname:'/guest'},{replaceState:(...x)=>calls.push(x)},s);
 assert.equal(calls[0][2],'/guest');assert.equal(g.party,'synthetic-party-token');g.setKey('synthetic-guest-key');assert.equal(s.getItem('ambient-room.v1.guest.key'),'synthetic-guest-key');
 g.clear();assert.equal(s.m.size,0);
});
test('new party clears prior guest key; reload reuses same session only',()=>{
 const s=storage(),history={replaceState(){}};const g=joinContext({hash:'#t=first-party',pathname:'/guest'},history,s);g.setKey('old-key');
 const same=joinContext({hash:'',pathname:'/guest'},history,s);assert.equal(same.key,'old-key');
 const next=joinContext({hash:'#t=next-party',pathname:'/guest'},history,s);assert.equal(next.key,'');assert.equal(next.party,'next-party');
});
test('out-of-order snapshots cannot rewind state, independent gain revisions apply',()=>{
 const old={seq:4,gainRev:1,gains:[],paused:true};
 assert.equal(acceptSnapshot(old,{seq:3,gainRev:0,gains:[],paused:false}),old);
 assert.deepEqual(acceptSnapshot(old,{seq:3,gainRev:2,gains:[{id:'t',gainDb:-2}],paused:false}),{...old,gainRev:2,gains:[{id:'t',gainDb:-2}]});
});
test('web contains local assets, semantic forms and no token persistence for hosts',()=>{
 const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),script=readFileSync(new URL('../web/app.mjs',import.meta.url),'utf8');
 assert(html.includes('name="referrer" content="no-referrer"'));assert(!/https?:\/\//.test(html));assert(!script.includes('localStorage'));assert(!script.includes('innerHTML'));assert(html.includes('Save local order'));
});
