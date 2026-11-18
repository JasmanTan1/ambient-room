import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { photoProcessor, imageHeader } from '../src/photos.mjs';
import { harness } from './helpers.mjs';

const fixture = readFileSync(new URL('../contract/fixtures/geometric.png',import.meta.url));
const decoder=process.env.AMBIENT_FFMPEG;
const options={skip:decoder?false:'Set AMBIENT_FFMPEG to an existing absolute FFmpeg path; do not install it.'};
function crc(data){let c=0xffffffff;for(const byte of data){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),n=Buffer.alloc(4),sum=Buffer.alloc(4);n.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([n,t,data,sum]);}
function png(w,h){const head=Buffer.alloc(13);head.writeUInt32BE(w);head.writeUInt32BE(h,4);head[8]=8;head[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('tEXt',Buffer.from('Comment\0synthetic-metadata')),chunk('IDAT',deflateSync(Buffer.alloc((w*3+1)*h,0))),chunk('IEND',Buffer.alloc(0))]);}

test('photo header validates PNG dimensions without decoding',()=>{const h=imageHeader(fixture);assert.equal(h.type,'png');assert(h.width>0&&h.height>0);});
test('JPEG/PNG/WebP signatures reject unrelated inputs',()=>{for(const b of [Buffer.from('not an image'),Buffer.from('GIF89a'),Buffer.alloc(30)])assert.throws(()=>imageHeader(b),e=>e.status===415);});
test('PNG chunk bounds and animation are refused',()=>{
 const truncated=fixture.subarray(0,25);assert.throws(()=>imageHeader(truncated));
 const animated=Buffer.concat([fixture.subarray(0,33),chunk('acTL',Buffer.alloc(8)),fixture.subarray(33)]);assert.throws(()=>imageHeader(animated),e=>e.status===422);
});
test('pixel bomb refused before decoder starts',async()=>{
 const b=Buffer.from(fixture);b.writeUInt32BE(40000001,16);
 await assert.rejects(photoProcessor('/unavailable-synthetic-decoder')(b,'image/png'),e=>e.status===422);
});
test('MIME mismatch and upload byte bounds refused before decode',async()=>{
 const p=photoProcessor('/unavailable-synthetic-decoder');
 await assert.rejects(p(fixture,'image/jpeg'),e=>e.status===415);await assert.rejects(p(Buffer.alloc(8388609),'image/png'),e=>e.status===413);await assert.rejects(p(Buffer.alloc(0),'image/png'),e=>e.status===413);
});
test('CPU decode makes fresh JPEG, removes metadata and does not upscale',options,async()=>{
 const source=png(32,16),result=await photoProcessor(decoder)(source,'image/png');assert.equal(result.width,32);assert.equal(result.height,16);assert.equal(imageHeader(result.jpeg).type,'jpeg');assert(!result.jpeg.includes(Buffer.from('synthetic-metadata')));
});
test('CPU decode resizes longest side to 1920',options,async()=>{
 const result=await photoProcessor(decoder)(png(2000,10),'image/png');assert.equal(result.width,1920);assert(result.height<=10);
});
test('WebP decodes to a metadata-free JPEG',options,async()=>{
 const webp=readFileSync(new URL('../contract/fixtures/solid.webp',import.meta.url));
 const result=await photoProcessor(decoder)(webp,'image/webp');assert.equal(result.width,16);assert.equal(result.height,8);assert.equal(imageHeader(result.jpeg).type,'jpeg');
});
test('WebP animation flag is refused before decode',()=>{
 const webp=readFileSync(new URL('../contract/fixtures/solid.webp',import.meta.url));
 const data=Buffer.alloc(10);data[0]=2;data.writeUIntLE(15,4,3);data.writeUIntLE(7,7,3);
 const head=Buffer.alloc(8);head.write('VP8X');head.writeUInt32LE(data.length,4);
 const b=Buffer.concat([webp.subarray(0,12),head,data,webp.subarray(12)]);b.writeUInt32LE(b.length-8,4);
 assert.throws(()=>imageHeader(b),e=>e.status===422);
});
test('malformed compressed pixels never become a successful photo',options,async()=>{
 const head=fixture.subarray(8,33),invalid=Buffer.concat([fixture.subarray(0,8),head,chunk('IDAT',Buffer.from('broken')),chunk('IEND',Buffer.alloc(0))]);
 await assert.rejects(photoProcessor(decoder)(invalid,'image/png'),e=>e.status===422);
});
test('JPEG orientation is applied and EXIF removed',options,async()=>{
 const p=photoProcessor(decoder),base=await p(png(32,16),'image/png');
 const tiff=Buffer.alloc(26);tiff.write('II');tiff.writeUInt16LE(42,2);tiff.writeUInt32LE(8,4);tiff.writeUInt16LE(1,8);tiff.writeUInt16LE(0x112,10);tiff.writeUInt16LE(3,12);tiff.writeUInt32LE(1,14);tiff.writeUInt16LE(6,18);
 const data=Buffer.concat([Buffer.from('Exif\0\0'),tiff]),length=Buffer.alloc(2);length.writeUInt16BE(data.length+2);
 const jpeg=Buffer.concat([base.jpeg.subarray(0,2),Buffer.from([255,225]),length,data,base.jpeg.subarray(2)]);
 const result=await p(jpeg,'image/jpeg');assert.equal(result.width,16);assert.equal(result.height,32);assert(!result.jpeg.includes(Buffer.from('Exif')));
});
test('photo retention is three, auth is enforced, failed processing leaves selection intact',options,async t=>{
 const h=harness(t,{photo:photoProcessor(decoder)});await h.ready();const uploads=[];
 for(let i=0;i<4;i++){
  const r=await h.call('POST','/v1/pictures',undefined,h.host,{headers:{'content-type':'image/png'},readBody:async()=>fixture});assert.equal(r.status,200,JSON.stringify(r));uploads.push(r.body.uploadId);
 }
 assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM pictures').get().n,3);
 assert.equal((await h.call('GET',`/v1/pictures/${uploads[0]}`,undefined,h.host)).status,404);
 assert.equal((await h.call('GET',`/v1/pictures/${uploads[3]}`,undefined,h.device)).status,200);
 const before=structuredClone(h.core.s.picture);
 assert.equal((await h.call('POST','/v1/pictures',undefined,h.host,{headers:{'content-type':'image/png'},readBody:async()=>Buffer.from('bad')})).status,415);
 assert.deepEqual(h.core.s.picture,before);
 await h.call('DELETE',`/v1/devices/${h.device.deviceId}`,undefined,h.host);assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM pictures').get().n,0);
});
test('oversized Content-Length and upload rate limit reject before buffering',async t=>{
 const h=harness(t);await h.ready();let reads=0;
 const options={headers:{'content-type':'image/png','content-length':'8388609'},readBody:async()=>{reads++;return fixture;}};
 for(let n=0;n<6;n++)assert.equal((await h.call('POST','/v1/pictures',undefined,h.host,options)).status,413);
 assert.equal((await h.call('POST','/v1/pictures',undefined,h.host,options)).status,429);assert.equal(reads,0);
});
