import { resolve, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { Store } from './store.mjs';
import { Coordinator } from './coordinator.mjs';
import { httpServer } from './http.mjs';
import { photoProcessor } from './photos.mjs';

const args = process.argv.slice(2), opts = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--allow-insecure-http') opts.allowHttp = true;
  else if (['--listen','--port','--data','--ffmpeg'].includes(args[i])) opts[args[i].slice(2)] = args[++i];
  else throw new Error('Unknown argument');
}
if (!opts.listen || !/^\d+$/.test(opts.port ?? '') || +opts.port < 1 || +opts.port > 65535 || !opts.data)
  throw new Error('Provide --listen, --port and --data. Optional: --ffmpeg (absolute path), --allow-insecure-http.');
if (opts.ffmpeg && !isAbsolute(opts.ffmpeg)) throw new Error('Provide an absolute decoder path');
process.umask(0o077);
const store = new Store(resolve(opts.data));
const coordinator = new Coordinator(store, { allowHttp: opts.allowHttp, photo: opts.ffmpeg ? photoProcessor(opts.ffmpeg) : undefined });
const server = httpServer(coordinator);
server.listen(+opts.port, opts.listen, () => {
  console.log('Ambient Room is listening. Request addresses are never logged.');
  if (!coordinator.s.config) console.log(`Setup code (five minutes): ${coordinator.setupCode.value}`);
  else console.log(`Host approval code (five minutes): ${coordinator.approvalCode.value}`);
  console.log('Local console: setup-code, approve, recover (revokes all tokens), quit.');
});
const timer = setInterval(() => coordinator.serial(async () => {
  coordinator.expire(); store.save(coordinator.s); coordinator.abortInvalidStreams();
}).catch(() => console.error('Storage unavailable')), 1000);
const consoleInput = createInterface({ input: process.stdin });
consoleInput.on('line', async line => {
  if (line.trim() === 'approve') console.log(`Host approval code (five minutes): ${coordinator.issueApproval()}`);
  if (line.trim() === 'setup-code' && !coordinator.s.config) { coordinator.setupCode = coordinator.code(); console.log(`Setup code (five minutes): ${coordinator.setupCode.value}`); }
  if (line.trim() === 'recover') console.log(`Host approval code (five minutes): ${await coordinator.recover()}`);
  if (line.trim() === 'quit') { clearInterval(timer); consoleInput.close(); server.closeAllConnections(); server.close(() => store.close()); }
});
