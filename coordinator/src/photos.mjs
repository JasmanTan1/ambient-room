import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fail } from './common.mjs';

// Header inspection bounds allocation before a decoder sees the input. The full
// decode below is still mandatory; headers alone never establish a valid image.
export function imageHeader(b) {
  if (b.length >= 33 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    let offset = 8, ended = false;
    if (b.toString('ascii', 12, 16) !== 'IHDR' || b.readUInt32BE(8) !== 13) fail(422, 'bad_image');
    while (offset + 12 <= b.length) {
      const size = b.readUInt32BE(offset), type = b.toString('ascii', offset + 4, offset + 8);
      if (size > b.length - offset - 12) fail(422, 'bad_image');
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') fail(422, 'bad_image');
      offset += size + 12;
      if (type === 'IEND') { ended = true; break; }
    }
    if (!ended || offset !== b.length) fail(422, 'bad_image');
    return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    if (b.readUInt32LE(4) + 8 !== b.length) fail(422, 'bad_image');
    let offset = 12, size = null;
    while (offset + 8 <= b.length) {
      const kind = b.toString('ascii', offset, offset + 4), n = b.readUInt32LE(offset + 4), at = offset + 8;
      if (n > b.length - at) fail(422, 'bad_image');
      if (kind === 'ANIM' || kind === 'ANMF' || (kind === 'VP8X' && (b[at] & 2))) fail(422, 'bad_image');
      if (kind === 'VP8X' && n >= 10) size = { width: b.readUIntLE(at + 4, 3) + 1, height: b.readUIntLE(at + 7, 3) + 1 };
      if (!size && kind === 'VP8L' && n >= 5 && b[at] === 0x2f) {
        const v = b.readUInt32LE(at + 1); size = { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
      }
      if (!size && kind === 'VP8 ' && n >= 10 && b.toString('hex', at + 3, at + 6) === '9d012a')
        size = { width: b.readUInt16LE(at + 6) & 0x3fff, height: b.readUInt16LE(at + 8) & 0x3fff };
      offset = at + n + (n % 2);
    }
    if (!size || offset !== b.length) fail(422, 'bad_image');
    return { type: 'webp', ...size };
  }
  if (b.length > 4 && b[0] === 255 && b[1] === 216) {
    let offset = 2;
    while (offset + 4 <= b.length) {
      if (b[offset] !== 255) fail(422, 'bad_image');
      const marker = b[offset + 1];
      if (marker === 255) { offset++; continue; }
      const size = b.readUInt16BE(offset + 2);
      if (size < 2 || offset + size + 2 > b.length) fail(422, 'bad_image');
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4,0xc8,0xcc].includes(marker)) {
        if (size < 8) fail(422, 'bad_image');
        if (b.at(-2) !== 255 || b.at(-1) !== 217) fail(422, 'bad_image');
        return { type: 'jpeg', width: b.readUInt16BE(offset + 7), height: b.readUInt16BE(offset + 5) };
      }
      offset += size + 2;
    }
    fail(422, 'bad_image');
  }
  fail(415, 'bad_type');
}

function stripMetadata(jpeg) {
  const parts = [jpeg.subarray(0, 2)]; let offset = 2;
  while (offset + 4 <= jpeg.length) {
    if (jpeg[offset] !== 255) fail(422, 'bad_image');
    const marker = jpeg[offset + 1];
    if (marker === 0xda) { parts.push(jpeg.subarray(offset)); return Buffer.concat(parts); }
    const n = jpeg.readUInt16BE(offset + 2);
    if (n < 2 || offset + n + 2 > jpeg.length) fail(422, 'bad_image');
    if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) parts.push(jpeg.subarray(offset, offset + n + 2));
    offset += n + 2;
  }
  fail(422, 'bad_image');
}

export function photoProcessor(ffmpeg) {
  return async (input, contentType) => {
    if (!input.length || input.length > 8388608) fail(413, 'too_big');
    const header = imageHeader(input);
    if (`image/${header.type}` !== contentType) fail(415, 'bad_type');
    if (!header.width || !header.height || header.width * header.height > 40000000) fail(422, 'bad_image');
    const args = ['--as=1073741824', '--cpu=8', '--', ffmpeg,
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-max_alloc', '268435456',
      '-threads', '1', '-filter_threads', '1', '-hwaccel', 'none', '-protocol_whitelist', 'pipe',
      '-err_detect', 'explode', '-f', 'image2pipe', '-c:v', header.type === 'jpeg' ? 'mjpeg' : header.type, '-i', 'pipe:0',
      '-map_metadata', '-1', '-map_chapters', '-1', '-an', '-sn', '-dn', '-frames:v', '2',
      '-vf', "scale='if(gt(iw*ih,40000000),nan,min(1920,iw))':'min(1920,ih)':force_original_aspect_ratio=decrease",
      '-threads', '1', '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2pipe', 'pipe:1'];
    const jpeg = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/prlimit', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = []; let size = 0, bad = false;
      // Only the child just created here is eligible for termination. Check its
      // current command line before sending a signal, including resource wrapper.
      const stop = () => {
        bad = true;
        try {
          const command = readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0');
          if (command.includes(ffmpeg) || (command[0] === '/usr/bin/prlimit' && command.includes('--cpu=8'))) child.kill('SIGKILL');
        } catch { /* already exited */ }
      };
      const timer = setTimeout(stop, 10000);
      child.stdout.on('data', b => { size += b.length; if (size > 16777216) stop(); else chunks.push(b); });
      child.stderr.resume(); // Decoder text is never logged or returned.
      child.stdin.on('error', () => {});
      child.on('error', () => { clearTimeout(timer); reject(new Error('decoder unavailable')); });
      child.on('close', code => { clearTimeout(timer); code === 0 && !bad ? resolve(Buffer.concat(chunks)) : reject(new Error('invalid image')); });
      child.stdin.end(input);
    }).catch(() => fail(422, 'bad_image'));
    // Two input frames produce two JPEGs. Exactly one frame is allowed.
    let frames = 0;
    for (let i = 0; i < jpeg.length - 1; i++) if (jpeg[i] === 255 && jpeg[i + 1] === 216) frames++;
    if (frames !== 1) fail(422, 'bad_image');
    const output = imageHeader(jpeg);
    if (output.width > 1920 || output.height > 1920) fail(422, 'bad_image');
    return { jpeg: stripMetadata(jpeg), width: output.width, height: output.height };
  };
}
