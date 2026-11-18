import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Fault } from './common.mjs';

const files = new Map([['/', ['index.html','text/html']], ['/guest', ['index.html','text/html']],
  ['/app.mjs', ['app.mjs','text/javascript']], ['/style.css', ['style.css','text/css']]]);
export function httpServer(coordinator) {
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (req.method === 'GET' && files.has(req.url)) {
        const [file, type] = files.get(req.url);
        res.setHeader('Content-Type', `${type}; charset=utf-8`);
        res.end(await readFile(new URL(`../web/${file}`, import.meta.url))); return;
      }
      const result = await coordinator.request({ method: req.method, path: req.url, headers: req.headers,
        address: req.socket.remoteAddress, signal: abort.signal,
        readBody: async max => {
          const parts = []; let n = 0;
          for await (const p of req) {
            n += p.length;
            if (n > max) throw new Fault(413, 'too_big');
            parts.push(p);
          }
          return Buffer.concat(parts);
        } });
      res.statusCode = result.status;
      if (result.retryAfter) res.setHeader('Retry-After', String(result.retryAfter));
      if (result.media) {
        const m = result.media;
        res.setHeader('Content-Type', m.contentType);
        if (m.contentLength !== null && m.contentLength !== undefined) res.setHeader('Content-Length', String(m.contentLength));
        if (m.contentRange) res.setHeader('Content-Range', m.contentRange);
        if (m.acceptRanges) res.setHeader('Accept-Ranges', m.acceptRanges);
        for await (const part of m.body) {
          if (abort.signal.aborted) break;
          if (!res.write(part)) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); });
        }
        res.end(); return;
      }
      res.setHeader('Content-Type', 'application/json');
      if (result.status >= 400) res.setHeader('Connection', 'close');
      res.end(JSON.stringify(result.body));
    } catch {
      if (res.headersSent) res.destroy();
      else { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"upstream_unavailable","message":"Service unavailable"}'); }
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 40;
  return server;
}
