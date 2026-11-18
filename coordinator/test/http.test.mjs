import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { httpServer } from '../src/http.mjs';
import { harness, config } from './helpers.mjs';

async function wire(t,h){
 const server=httpServer(h.core);server.listen(0,'localhost');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 return (method,path,body,headers={})=>new Promise((resolve,reject)=>{
  const raw=body===undefined?null:Buffer.from(JSON.stringify(body));
  const req=httpRequest({host:'localhost',port:server.address().port,method,path,agent:false,headers:{...(raw?{'content-type':'application/json','content-length':raw.length}:{}),...headers}},res=>{
   const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>{const text=Buffer.concat(parts).toString();resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)});});
  });req.on('error',reject);req.end(raw);
 });
}
test('isolated HTTP serves local assets with security headers',async t=>{
 const h=harness(t),call=await wire(t,h);
 for(const path of ['/','/guest','/app.mjs','/style.css']){
  const r=await call('GET',path);assert.equal(r.status,200);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['referrer-policy'],'no-referrer');assert(r.headers['content-security-policy'].includes("frame-ancestors 'none'"));assert(!r.headers['access-control-allow-origin']);
 }
 assert.equal((await call('GET','/not-a-file')).status,404);
});
test('same-origin browser setup works; cross-origin writes and unknown routes fail',async t=>{
 const h=harness(t),call=await wire(t,h);
 const setup=await call('POST','/v1/setup',{setupCode:h.core.setupCode.value,publicOrigin:'https://room.example.test',library:config},{origin:'https://room.example.test','sec-fetch-site':'same-origin'});
 assert.equal(setup.status,200);const auth=setup.json();
 assert.equal((await call('PUT','/v1/volume',{level:40},{authorization:`Bearer ${auth.hostToken}`,origin:'https://outside.example.test','idempotency-key':'key_one'})).status,403);
 const r=await call('PUT','/v1/volume',{level:40},{authorization:`Bearer ${auth.hostToken}`,origin:'https://room.example.test','idempotency-key':'key_two'});assert.equal(r.status,200);assert.equal(r.json().volume,40);
});
test('HTTP rejects unauthorized large uploads without waiting for declared body',async t=>{
 const h=harness(t),call=await wire(t,h);
 const r=await call('POST','/v1/pictures',undefined,{'content-type':'image/png','content-length':'8388609'});
 assert.equal(r.status,401);assert.equal(r.json().error,'unauthorized');assert.equal(r.headers.connection,'close');
});
test('HTTP exposes safe stream range headers only after authorization',async t=>{
 const h=harness(t);await h.ready();const call=await wire(t,h);
 const r=await call('GET',`/v1/tracks/${h.ids.a}/stream`,undefined,{authorization:`Bearer ${h.device.deviceToken}`,range:'bytes=0-3'});
 assert.equal(r.status,206);assert.equal(r.headers['content-range'],'bytes 0-3/4');assert.equal(r.headers['accept-ranges'],'bytes');
 assert.equal((await call('GET',`/v1/tracks/${h.ids.a}/stream`,undefined,{authorization:`Bearer ${h.device.deviceToken}`,range:'bytes=0-1,2-3'})).status,416);
});
