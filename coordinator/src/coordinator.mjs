import { randomInt } from 'node:crypto';
import { api, Fault, fail, id, token, digest, canonical, validate, clean, endpoint, rangeHeader, queueInsert, orderWaiting } from './common.mjs';
import { adapter } from './adapters.mjs';

const HOUR = 3600000, OK = { ok: true };
const fresh = () => ({ roomId: id(), seq: 0, gainRev: 0, gains: [], cmd: null, commandN: 0,
  config: null, origin: null, namespace: id(), links: [], playlists: {}, tracks: {}, overrides: {},
  active: null, resume: null, paused: true, timer: null, message: null, picture: { scene: null, uploadId: null },
  volume: 65, queue: null, editedAt: null, hostTracks: [], tokens: {}, pairs: {}, device: null,
  enabled: false, order: 'first_come', party: null, partyExpired: false, requests: [], guests: {}, requestN: 0, idem: {} });

export class Coordinator {
  constructor(store, options = {}) {
    this.store = store; this.s = store.load() ?? fresh();
    this.now = options.now ?? Date.now; this.allowHttp = options.allowHttp ?? false;
    this.makeAdapter = options.adapterFactory ?? ((config, ids) => adapter(config, ids, options.fetch, this.allowHttp));
    this.photo = options.photo; this.limits = new Map(); this.tail = Promise.resolve(); this.activeStreams = new Map();
    this.setupCode = this.code(); this.approvalCode = this.code();
    // Device presence is deliberately not restored after a coordinator restart.
    if (this.s.device) this.s.device.seenAt = null;
    this.expire(); this.store.save(this.s);
  }
  code() { return { value: token(), expiresAt: this.now() + 300000 }; }
  issueApproval() { this.approvalCode = this.code(); return this.approvalCode.value; }
  async serial(fn) {
    const previous = this.tail; let unlock;
    this.tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    try { return await fn(); } finally { unlock(); }
  }
  async recover() {
    return this.serial(async () => {
      this.s.tokens = {}; this.s.pairs = {}; this.s.device = null;
      this.halt(); this.clearPhotos(); this.s.seq++;
      this.store.save(this.s); this.abortInvalidStreams();
      return this.issueApproval();
    });
  }
  bearer(role, lifetime) {
    const raw = token(), key = digest(raw), expiresAt = this.now() + lifetime;
    this.s.tokens[key] = { role, expiresAt, id: id() };
    return { raw, key, expiresAt, principal: this.s.tokens[key] };
  }
  library(config = this.s.config, namespace = this.s.namespace) {
    if (!config) fail(409, 'conflict');
    return this.makeAdapter(config, this.store.ids(namespace));
  }
  connected() { return !!this.s.device && !!this.s.tokens[this.s.device.key]
    && this.s.tokens[this.s.device.key].expiresAt > this.now()
    && this.s.device.seenAt !== null && this.now() - this.s.device.seenAt < 30000; }
  expire() {
    const now = this.now();
    for (const [k, v] of Object.entries(this.s.tokens)) if (v.expiresAt <= now) delete this.s.tokens[k];
    for (const [k, v] of Object.entries(this.s.pairs)) if (v.expiresAt <= now) delete this.s.pairs[k];
    for (const [k, v] of Object.entries(this.s.idem)) if (v.expiresAt <= now) delete this.s.idem[k];
    if (this.s.party && this.s.party.expiresAt <= now) { this.endParty(); this.s.partyExpired = true; this.s.seq++; }
    if (this.s.timer && this.s.timer.endsAt + 120000 <= now) { this.s.timer = null; this.s.seq++; }
    if (this.s.device && !this.s.tokens[this.s.device.key]) {
      this.s.device = null; this.halt(); this.clearPhotos(); this.s.seq++;
    }
  }
  endParty() {
    const pending = this.s.requests.filter(r => r.state === 'queued').map(r => r.trackId);
    if (this.s.queue) this.s.queue.tracks = this.s.queue.tracks.filter(x => !pending.includes(x) || this.s.hostTracks.includes(x));
    this.s.party = null; this.s.guests = {}; this.s.requests = [];
    for (const [k, v] of Object.entries(this.s.idem)) if (v.guest) delete this.s.idem[k];
  }
  newParty() { this.endParty(); this.s.partyExpired = false; this.s.party = { token: token(), expiresAt: this.now() + 12 * HOUR }; }
  halt() { this.s.active = null; this.s.paused = true; this.s.timer = null; this.endParty(); this.s.partyExpired = false; }
  clearPhotos() { this.store.db.exec('DELETE FROM pictures'); this.s.picture = { scene: null, uploadId: null }; }
  touch() { this.s.seq++; }
  track(id) { const t = this.s.tracks[id]; if (!t) fail(404, 'not_found'); return t; }
  current() { return this.s.active ? this.s.resume?.trackId ?? this.s.queue?.tracks[0] ?? null : null; }
  snapshot() {
    const s = this.s;
    return { roomId: s.roomId, seq: s.seq, serverNow: this.now(), tvConnected: this.connected(),
      playlists: s.links.map(l => {
        const p = s.playlists[l.playlistId];
        return { id: l.playlistId, name: p?.name ?? '', scene: l.scene, trackCount: p?.tracks.length ?? 0 };
      }), activePlaylistId: s.active, resume: s.queue?.tracks.length === 0 ? null : s.resume,
      paused: s.paused, timer: s.timer, queue: s.queue ? { ...s.queue, tracks: s.queue.tracks.map(x => this.track(x)) } : null,
      message: s.message && s.message.expiresAt > this.now() ? s.message : null,
      picture: s.picture, volume: s.volume, cmd: s.cmd, gainRev: s.gainRev, gains: s.gains };
  }
  authorize(operation, headers) {
    const schemes = operation.security ?? [];
    if (!schemes.length) return { role: 'public', key: 'public' };
    if (schemes.some(s => 'partyToken' in s)) {
      const raw = headers['x-party-token'];
      if (!raw) fail(401, 'unauthorized');
      if (!this.s.party || raw !== this.s.party.token || this.s.party.expiresAt <= this.now()) fail(410, 'ended');
      if (!this.s.enabled) fail(403, 'off');
      let guest = null;
      if (headers['x-guest-key']) {
        guest = Object.values(this.s.guests).find(g => g.key === digest(headers['x-guest-key']));
        if (!guest) fail(401, 'unauthorized');
        if (guest.blocked) fail(403, 'blocked');
      }
      if (schemes.some(s => 'guestKey' in s) && !guest) fail(403, 'join_first');
      return { role: 'guest', key: guest ? guest.key : digest(raw), guest };
    }
    const raw = /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(headers.authorization ?? '')?.[1];
    const key = raw ? digest(raw) : '', t = this.s.tokens[key];
    if (!t || t.expiresAt <= this.now()) fail(401, 'unauthorized');
    if (!schemes.some(s => `${t.role}Bearer` in s)) fail(403, 'forbidden');
    if (t.role === 'device' && this.s.device?.key !== key) fail(401, 'unauthorized');
    return { ...t, key };
  }
  limit(bucket, actor, maximum) {
    const window = Math.floor(this.now() / 60000), k = `${bucket}:${actor}`;
    const old = this.limits.get(k), count = old?.window === window ? old.n + 1 : 1;
    this.limits.set(k, { window, n: count });
    if (this.limits.size > 10000) for (const [key, v] of this.limits) if (v.window !== window) this.limits.delete(key);
    if (count > maximum) { const e = new Fault(429, 'rate_limited'); e.retryAfter = Math.max(1, Math.ceil((60000 - this.now() % 60000) / 1000)); throw e; }
  }
  rate(route, method, actor, address) {
    const p = route;
    if (p === '/v1/pairings') this.limit('pair', address, 10);
    if (p.endsWith('/claim')) this.limit('claim', actor.pairId, 30);
    if (actor.role === 'device') this.limit(method === 'GET' ? 'state' : 'device-write', actor.key, method === 'GET' ? 240 : 60);
    if (actor.role === 'host' && method !== 'GET') {
      const bucket = p.startsWith('/v1/party') ? 'moderate' : p === '/v1/pictures' ? 'upload' : p === '/v1/message' ? 'message' : 'write';
      const max = { moderate: 60, upload: 6, message: 6, write: 30 }[bucket];
      this.limit(bucket, actor.key, max); this.limit(bucket + '-address', address, max);
    }
    if (actor.role === 'guest') {
      const bucket = p.endsWith('/join') ? 'join' : p.endsWith('/search') ? 'search' : method === 'GET' ? 'read' : p === '/v1/guest/requests' ? 'add' : 'control';
      const max = { join: 20, search: 30, read: 120, add: 15, control: 20 }[bucket];
      this.limit('guest-' + bucket, address, max);
      if (actor.guest) this.limit('guest-' + bucket, actor.key, max);
    }
  }
  match(method, pathname) {
    for (const [route, methods] of Object.entries(api.paths)) {
      const op = methods[method.toLowerCase()]; if (!op) continue;
      const names = [...route.matchAll(/\{(\w+)\}/g)].map(x => x[1]);
      const m = new RegExp('^' + route.replace(/\{\w+\}/g, '([^/]+)') + '$').exec(pathname);
      if (m) return { route, op, params: Object.fromEntries(names.map((n, i) => [n, m[i + 1]])) };
    }
    fail(404, 'not_found');
  }
  async request({ method = 'GET', path, headers = {}, address = 'local', readBody = async () => Buffer.alloc(0), signal }) {
    return this.serial(async () => {
      headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      this.expire(); this.store.save(this.s); this.abortInvalidStreams();
      let original, oldCodes, approvalAttempt = false;
      try {
        if (!path.startsWith('/') || path.startsWith('//')) fail(400, 'bad_request');
        const url = new URL(path, 'https://fixture.invalid');
        const { route, op, params } = this.match(method, url.pathname);
        approvalAttempt = ['/v1/setup', '/v1/auth/host', '/v1/pairings/approve'].includes(route);
        if (approvalAttempt) {
          const prior = this.limits.get(`approval-failed:${address}`);
          if (prior?.window === Math.floor(this.now() / 60000) && prior.n >= 10) this.limit('approval-failed', address, 10);
        }
        if (headers.origin && this.s.origin && headers.origin !== this.s.origin) fail(403, 'forbidden');
        if (headers['sec-fetch-site'] === 'cross-site') fail(403, 'forbidden');
        const actor = this.authorize(op, headers); actor.pairId = params.pairId;
        this.rate(route, method, actor, address);
        const query = {};
        for (const [k, v] of url.searchParams) {
          const p = (op.parameters ?? []).find(x => x.in === 'query' && x.name === k);
          if (!p || Object.hasOwn(query, k)) fail(400, 'bad_request');
          query[k] = p.schema.type === 'integer' && /^\d+$/.test(v) ? +v : v;
          if (!validate(p.schema, query[k])) fail(400, 'bad_request');
        }
        for (const p of op.parameters ?? []) {
          const v = p.in === 'path' ? params[p.name] : p.in === 'header' ? headers[p.name.toLowerCase()] : query[p.name];
          if ((p.required && v === undefined) || (v !== undefined && !validate(p.schema, v))) fail(400, 'bad_request');
        }
        // Role and room ownership checks deliberately precede body reads and retries.
        this.preflight(route, method, params, actor);
        const mutating = method !== 'GET', keyed = mutating && actor.role !== 'public';
        if (keyed && !/^[A-Za-z0-9_-]{1,128}$/.test(headers['idempotency-key'] ?? '')) fail(400, 'bad_request');
        const binary = route === '/v1/pictures';
        const mediaType = headers['content-type']?.split(';')[0];
        if (binary && !['image/jpeg', 'image/png', 'image/webp'].includes(mediaType)) fail(415, 'bad_type');
        const max = binary ? 8388608 : 65536;
        if (headers['content-length'] && (!/^\d+$/.test(headers['content-length']) || +headers['content-length'] > max)) fail(binary ? 413 : 400, binary ? 'too_big' : 'bad_request');
        const raw = await readBody(max);
        if (raw.length > max || (binary && raw.length === 0)) fail(binary ? 413 : 400, binary ? 'too_big' : 'bad_request');
        let body = null;
        if (op.requestBody && !binary) {
          if (mediaType !== 'application/json') fail(400, 'bad_request');
          try { body = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'bad_request'); }
          if (!validate(op.requestBody.content['application/json'].schema, body)) fail(400, 'bad_request');
        } else if (!op.requestBody && raw.length) fail(400, 'bad_request');
        // A slow body must not let an expired credential replay a prior success.
        this.authorize(op, headers);
        const bodyHash = digest(binary ? raw : canonical(body));
        const cacheKey = `${actor.key}:${method}:${url.pathname}:${headers['idempotency-key']}`;
        if (keyed && this.s.idem[cacheKey]) {
          const entry = this.s.idem[cacheKey];
          if (entry.hash !== bodyHash) fail(409, 'conflict');
          if (route === '/v1/guest/join' && this.s.guests[entry.body.guestId]?.blocked) fail(403, 'blocked');
          return { status: 200, body: structuredClone(entry.body) };
        }
        original = structuredClone(this.s); oldCodes = [this.setupCode, this.approvalCode];
        this.store.db.exec('BEGIN IMMEDIATE');
        const result = await this.execute(route, method, params, query, body, raw, mediaType, actor, headers, signal);
        if (route !== '/v1/auth/revoke') this.authorize(op, headers);
        const schema = op.responses['200'].content?.['application/json']?.schema;
        if (schema && !validate(schema, result)) throw new Error('Response schema violation');
        if (keyed) this.s.idem[cacheKey] = { hash: bodyHash, body: structuredClone(result), guest: actor.role === 'guest', expiresAt: this.now() + 24 * HOUR };
        this.store.save(this.s); this.store.db.exec('COMMIT');
        this.abortInvalidStreams();
        return result?.media ? result : { status: 200, body: result };
      } catch (e) {
        if (original) {
          this.store.db.exec('ROLLBACK'); this.s = original;
          [this.setupCode, this.approvalCode] = oldCodes;
        }
        if (e instanceof Fault) {
          if (approvalAttempt && e.status >= 400 && e.status < 500 && e.status !== 429) this.limit('approval-failed', address, 10);
          return { status: e.status, body: { error: e.code, message: e.code.replaceAll('_', ' ') }, retryAfter: e.retryAfter };
        }
        return { status: 503, body: { error: 'upstream_unavailable', message: 'Service unavailable' } };
      }
    });
  }
  preflight(route, method, p, a) {
    if (p.deviceId && this.s.device?.id !== p.deviceId) fail(404, 'not_found');
    if (p.uploadId && !this.store.db.prepare('SELECT id FROM pictures WHERE id=?').get(p.uploadId)) fail(404, 'not_found');
    if (p.playlistId && a.role === 'device' && !this.s.links.some(l => l.playlistId === p.playlistId)) fail(404, 'not_found');
    if (p.trackId && route.includes('/stream') && a.role === 'device' && !this.selectedTrack(p.trackId)) fail(404, 'not_found');
    if (p.trackId && route.includes('/stream') && !this.store.ids(this.s.namespace).toProvider('track', p.trackId)) fail(404, 'not_found');
    if (p.guestId && !this.s.guests[p.guestId]) fail(404, 'not_found');
    if (p.requestId) {
      const r = this.s.requests.find(r => r.id === p.requestId); if (!r) fail(404, 'not_found');
      if (a.role === 'guest' && (r.guestId !== a.guest?.id || !['queued', 'removed'].includes(r.state))) fail(403, 'not_yours');
    }
    if (route === '/v1/guest/control') {
      const r = this.playingRequest(); if (!r || r.guestId !== a.guest?.id) fail(403, 'not_yours');
    }
  }
  selectedTrack(id) { return this.current() === id || this.s.queue?.tracks.includes(id)
    || this.s.links.some(l => this.s.playlists[l.playlistId]?.tracks.some(t => t.id === id)); }
  async playlist(id, library = this.library()) {
    const p = await library.getPlaylist(id);
    if (!validate(api.components.schemas.Playlist, p) || p.tracks.length > 5000) fail(409, 'conflict');
    this.s.playlists[id] = p;
    for (const t of p.tracks) this.s.tracks[t.id] = t;
    this.updateGains(); return p;
  }
  updateGains() {
    const gains = Object.values(this.s.tracks).map(t => ({ id: t.id, gainDb: t.gainDb })).sort((a, b) => a.id.localeCompare(b.id));
    if (canonical(gains) !== canonical(this.s.gains)) { this.s.gains = gains; this.s.gainRev++; }
  }
  async allPlaylists() {
    const library = this.library(), playlists = []; let cursor = null;
    const seen = new Set();
    do {
      const p = await library.listPlaylists(cursor, 200);
      playlists.push(...p.playlists); cursor = p.cursor;
      if (playlists.length > 10000 || (cursor !== null && seen.has(cursor))) fail(409, 'conflict');
      seen.add(cursor);
    } while (cursor !== null);
    return playlists;
  }
  baseQueue(playlistId) { return this.s.overrides[playlistId] ?? this.s.playlists[playlistId].tracks.map(t => t.id); }
  setQueue(playlistId) {
    this.s.queue = { playlistId, custom: !!this.s.overrides[playlistId], tracks: [...this.baseQueue(playlistId)], anchorId: null };
    this.s.hostTracks = [...this.s.queue.tracks]; this.s.editedAt = null;
  }
  needQueue() { if (!this.s.queue || !this.s.active) fail(409, 'no_playlist'); return this.s.queue; }
  edit() { this.needQueue(); this.s.queue.custom = true; this.s.editedAt = this.now(); this.touch(); }
  playingRequest() { return this.s.requests.find(r => r.state === 'playing' && r.trackId === this.current()) ?? null; }
  publicRequest(r) { const { sequence, ...result } = r; return result; }
  reorder() {
    if (!this.s.queue) return;
    const last = {};
    for (const r of this.s.requests) if (['playing', 'played'].includes(r.state)) last[r.guestId] = Math.max(last[r.guestId] ?? 0, r.sequence);
    const waiting = orderWaiting(this.s.requests.filter(r => r.state === 'queued'), this.s.order, last);
    const ids = new Set(waiting.map(r => r.trackId)), ordered = waiting.map(r => r.trackId);
    const q = this.s.queue.tracks, current = this.current(), i = q.indexOf(current);
    const positions = [...Array(q.length).keys()];
    if (i >= 0) positions.push(...positions.splice(0, i + 1));
    for (const index of positions) if (ids.has(q[index]) && q[index] !== current) q[index] = ordered.shift();
  }
  markCurrent(trackId) {
    const completed = [];
    for (const r of this.s.requests) {
      if (r.state === 'playing' && r.trackId !== trackId) { r.state = 'played'; completed.push(r.trackId); }
      if (r.state === 'queued' && r.trackId === trackId) r.state = 'playing';
    }
    if (this.s.queue) this.s.queue.tracks = this.s.queue.tracks.filter(t => !completed.includes(t) || this.s.hostTracks.includes(t));
    this.reorder();
  }
  control(action) {
    this.s.commandN++; this.s.cmd = { n: this.s.commandN, action };
    if (action === 'pause') this.s.paused = true;
    if (action === 'play') this.s.paused = !this.s.queue?.tracks.length;
    if (action === 'next' && this.s.queue?.tracks.length) {
      const q = this.s.queue, i = q.tracks.indexOf(this.current());
      const next = q.anchorId && q.tracks.includes(q.anchorId) ? q.anchorId : q.tracks[(i + 1) % q.tracks.length];
      q.anchorId = null; this.s.resume = { playlistId: q.playlistId, trackId: next, positionSec: 0 }; this.markCurrent(next);
    }
    this.touch();
  }
  removeTrack(trackId) {
    const q = this.needQueue(), i = q.tracks.indexOf(trackId);
    if (i < 0) fail(404, 'not_found');
    if (trackId === this.current() || trackId === q.anchorId) q.anchorId = q.tracks.length > 1 ? q.tracks[(i + 1) % q.tracks.length] : null;
    q.tracks.splice(i, 1);
    if (!q.tracks.length) { this.s.paused = true; this.s.resume = null; }
  }
  dropRequest(r) {
    if (r.state !== 'queued' && r.state !== 'playing') return;
    const playing = r.state === 'playing'; r.state = 'removed';
    if (playing) this.control('next');
    if (this.s.queue?.tracks.includes(r.trackId) && !this.s.hostTracks.includes(r.trackId)) this.removeTrack(r.trackId);
    this.reorder();
  }
  partyView() {
    return { enabled: this.s.enabled, order: this.s.order, expiresAt: this.s.party?.expiresAt ?? null,
      guests: Object.values(this.s.guests).map(({ id, name, blocked }) => ({ id, name, blocked })),
      requests: this.s.requests.map(r => this.publicRequest(r)) };
  }
  qr() {
    const active = !!(this.s.enabled && this.s.party && this.s.active);
    return { enabled: this.s.enabled, active, url: active ? `${this.s.origin}/guest#t=${this.s.party.token}` : null,
      expiresAt: active ? this.s.party.expiresAt : null, serverNow: this.now() };
  }
  guestView(a) {
    const current = this.current(), req = this.playingRequest(), q = this.s.queue?.tracks ?? [], i = q.indexOf(current);
    const upcoming = i >= 0 ? [...q.slice(i + 1), ...q.slice(0, i)] : q;
    return { serverNow: this.now(), expiresAt: this.s.party.expiresAt, order: this.s.order,
      you: a.guest ? { id: a.guest.id, name: a.guest.name } : null,
      now: current && this.s.tracks[current] ? { track: this.track(current), mine: !!req && req.guestId === a.guest?.id, paused: this.s.paused } : null,
      upNext: upcoming.slice(0, 40).map(trackId => {
        const r = this.s.requests.find(r => r.trackId === trackId && r.state === 'queued');
        return { requestId: r?.id ?? null, track: this.track(trackId), by: r?.guestName ?? null, mine: !!r && r.guestId === a.guest?.id };
      }) };
  }
  abortInvalidStreams() {
    for (const [key, streams] of this.activeStreams) {
      if (!this.s.tokens[key] || this.s.tokens[key].expiresAt <= this.now()) {
        for (const c of streams) c.abort(); this.activeStreams.delete(key);
      }
    }
  }
  async execute(route, method, p, query, b, raw, mediaType, a, headers, signal) {
    const s = this.s, key = `${method} ${route}`;
    if (key === 'POST /v1/setup' || key === 'POST /v1/auth/host') {
      const setup = route === '/v1/setup', code = setup ? this.setupCode : this.approvalCode;
      if (setup && s.config) fail(409, 'setup_complete');
      if (!setup && !s.config) fail(409, 'conflict');
      if (!code || code.expiresAt <= this.now() || (setup ? b.setupCode : b.approvalCode) !== code.value) fail(401, 'unauthorized');
      if (setup) {
        const origin = endpoint(b.publicOrigin, this.allowHttp, true).origin;
        if (headers.origin && headers.origin !== origin) fail(403, 'forbidden');
        endpoint(b.library.baseUrl, this.allowHttp);
        await this.library(b.library).check();
        if (code.expiresAt <= this.now()) fail(401, 'unauthorized');
        s.config = b.library; s.origin = origin; this.setupCode = null;
      } else this.approvalCode = null;
      const t = this.bearer('host', 12 * HOUR);
      return { hostToken: t.raw, expiresAt: t.expiresAt };
    }
    if (key === 'POST /v1/auth/revoke') { delete s.tokens[a.key]; return OK; }
    if (route === '/v1/config/library') {
      if (method === 'PUT') {
        endpoint(b.baseUrl, this.allowHttp);
        const namespace = id(); await this.library(b, namespace).check();
        // The protocol has no provider-library UUID proof. Conservatively reset
        // IDs even when an endpoint string is unchanged; never guess identity.
        this.halt(); this.clearPhotos(); s.links = []; s.playlists = {}; s.tracks = {}; s.overrides = {};
        s.queue = null; s.resume = null; s.hostTracks = []; s.message = null; s.gains = []; s.gainRev++;
        s.config = b; s.namespace = namespace; this.touch();
      }
      let reachable = false; try { await this.library().check(); reachable = true; } catch { /* public redacted status */ }
      return { configured: !!s.config, kind: s.config?.kind ?? null, reachable };
    }
    if (route === '/v1/config/links') {
      if (method === 'PUT') {
        if (new Set(b.links.map(l => l.playlistId)).size !== b.links.length) fail(400, 'bad_request');
        for (const l of b.links) await this.playlist(l.playlistId);
        if (s.active && !b.links.some(l => l.playlistId === s.active)) { this.halt(); s.queue = null; s.resume = null; }
        s.links = b.links; this.touch();
      }
      return { links: s.links };
    }
    if (key === 'POST /v1/pairings') {
      if (!s.config) fail(409, 'conflict');
      let userCode;
      do { userCode = Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join(''); }
      while (Object.values(s.pairs).some(p => p.userCode === userCode));
      const pairId = id(), claimSecret = token();
      s.pairs[pairId] = { userCode, secret: digest(claimSecret), expiresAt: this.now() + 300000, result: null };
      return { pairId, userCode, claimSecret, expiresAt: s.pairs[pairId].expiresAt, pollAfterSec: 2 };
    }
    if (key === 'POST /v1/pairings/approve') {
      const pair = Object.values(s.pairs).find(p => p.userCode === b.userCode);
      if (!pair || pair.expiresAt <= this.now()) fail(404, 'not_found');
      if (!pair.result) {
        if (s.device) delete s.tokens[s.device.key];
        this.halt(); this.clearPhotos();
        const t = this.bearer('device', 30 * 24 * HOUR), sessionId = id();
        s.device = { id: t.principal.id, key: t.key, sessionId, sampleN: 0, seenAt: null };
        pair.result = { status: 'paired', deviceId: s.device.id, deviceToken: t.raw, expiresAt: t.expiresAt, sessionId };
        this.touch();
      }
      return OK;
    }
    if (key === 'POST /v1/pairings/{pairId}/claim') {
      const pair = s.pairs[p.pairId];
      if (!pair || pair.expiresAt <= this.now()) fail(410, 'expired');
      if (digest(b.claimSecret) !== pair.secret) fail(401, 'unauthorized');
      if (pair.result && pair.result.deviceId !== s.device?.id) fail(410, 'revoked');
      return pair.result ? { ...pair.result, snapshot: this.snapshot() } : { status: 'pending', expiresAt: pair.expiresAt };
    }
    if (key === 'DELETE /v1/devices/{deviceId}') {
      delete s.tokens[s.device.key]; s.device = null; s.pairs = {}; this.halt(); this.clearPhotos(); this.touch(); return OK;
    }
    if (key === 'GET /v1/state') {
      if (a.role === 'device') s.device.seenAt = this.now();
      // Immediate response is the v1 fallback; web polls at five seconds.
      return this.snapshot();
    }
    if (key === 'GET /v1/playlists') {
      return { playlists: a.role === 'host' ? await this.allPlaylists() : this.snapshot().playlists };
    }
    if (key === 'GET /v1/playlists/{playlistId}') {
      const pl = await this.playlist(p.playlistId), link = s.links.find(l => l.playlistId === p.playlistId);
      const tracks = s.queue?.playlistId === p.playlistId ? s.queue.tracks : this.baseQueue(p.playlistId);
      return { ...pl, scene: link?.scene ?? pl.scene, tracks: tracks.map(t => this.track(t)) };
    }
    if (key === 'GET /v1/tracks/{trackId}/stream') {
      const range = rangeHeader(headers.range), abort = new AbortController();
      const joinedSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
      const media = await this.library().openStream(p.trackId, range, joinedSignal);
      if (!this.activeStreams.has(a.key)) this.activeStreams.set(a.key, new Set());
      this.activeStreams.get(a.key).add(abort);
      const source = media.body, self = this;
      media.body = (async function* () {
        try {
          for await (const chunk of source) {
            if (!self.s.tokens[a.key] || self.s.tokens[a.key].expiresAt <= self.now() || abort.signal.aborted) return;
            if (a.role === 'device' && !self.selectedTrack(p.trackId)) return;
            yield chunk;
          }
        } finally { abort.abort(); self.activeStreams.get(a.key)?.delete(abort); }
      })();
      return { status: media.status, media };
    }
    if (key === 'POST /v1/playback/start') {
      if (!this.connected()) fail(409, 'no_tv');
      const playlistId = b.playlistId ?? (s.links.some(l => l.playlistId === s.resume?.playlistId) ? s.resume.playlistId : s.links[0]?.playlistId);
      if (!playlistId || !s.links.some(l => l.playlistId === playlistId)) fail(404, 'no_playlist');
      await this.playlist(playlistId);
      if (s.queue?.playlistId !== playlistId || (s.editedAt !== null && this.now() - s.editedAt > 12 * HOUR)) {
        this.endParty(); this.setQueue(playlistId);
      }
      if (!s.queue.tracks.length) fail(409, 'empty_playlist');
      if (!s.queue.tracks.includes(s.resume?.trackId) || s.resume?.playlistId !== playlistId)
        s.resume = { playlistId, trackId: s.queue.tracks[0], positionSec: 0 };
      s.active = playlistId; s.paused = false;
      if (s.enabled && !s.party && !s.partyExpired) this.newParty();
      this.touch(); return this.snapshot();
    }
    if (key === 'POST /v1/playback/stop') { this.halt(); this.touch(); return this.snapshot(); }
    if (key === 'POST /v1/playback/control') {
      if (!s.active) fail(409, 'not_playing');
      this.control(b.action); return this.snapshot();
    }
    if (key === 'PUT /v1/playback/resume') {
      const d = s.device;
      const stored = b.sessionId === d.sessionId && b.sampleN > d.sampleN && s.active === b.playlistId && s.queue?.tracks.includes(b.trackId);
      if (stored) {
        const t = await this.library().getTrack(b.trackId); s.tracks[t.id] = t; this.updateGains();
        d.sampleN = b.sampleN; d.seenAt = this.now();
        s.resume = { playlistId: b.playlistId, trackId: b.trackId, positionSec: Math.min(b.positionSec, t.durationSec) }; s.paused = b.paused;
        s.queue.anchorId = null;
        this.markCurrent(b.trackId);
      }
      return { ok: true, stored };
    }
    if (route === '/v1/timer') {
      if (method === 'POST') {
        if (!this.connected()) fail(409, 'no_tv');
        if (!s.active) fail(409, 'not_playing');
        s.timer = { id: id(), endsAt: this.now() + b.minutes * 60000, durationSec: b.minutes * 60 };
      } else s.timer = null;
      this.touch(); return this.snapshot();
    }
    if (key === 'POST /v1/timer/complete') {
      const ignored = s.timer?.id !== b.timerId;
      if (!ignored) { s.timer = null; this.touch(); }
      return { ok: true, ignored, snapshot: this.snapshot() };
    }
    if (route === '/v1/queue' || route.startsWith('/v1/queue/')) {
      const q = this.needQueue();
      if (key === 'POST /v1/queue') {
        const track = await this.library().getTrack(b.trackId); s.tracks[track.id] = track; this.updateGains();
        const next = queueInsert(q.tracks, b.trackId, this.current(), b.where);
        if (next.length > 5000) fail(409, 'conflict'); q.tracks = next;
        if (!s.hostTracks.includes(b.trackId)) s.hostTracks.push(b.trackId);
      } else if (key === 'POST /v1/queue/move') {
        if (!q.tracks.includes(b.trackId) || (b.beforeId !== null && !q.tracks.includes(b.beforeId))) fail(404, 'not_found');
        if (b.beforeId !== b.trackId) {
          const next = q.tracks.filter(x => x !== b.trackId), at = b.beforeId === null ? next.indexOf(this.current()) : next.indexOf(b.beforeId);
          next.splice(at < 0 ? next.length : at, 0, b.trackId); q.tracks = next;
        }
      } else if (key === 'DELETE /v1/queue/{trackId}') {
        this.removeTrack(p.trackId); s.hostTracks = s.hostTracks.filter(x => x !== p.trackId);
        for (const r of s.requests) if (r.trackId === p.trackId && r.state === 'queued') r.state = 'removed';
      } else if (key === 'DELETE /v1/queue') {
        await this.playlist(q.playlistId); this.setQueue(q.playlistId);
        for (const r of s.requests) if (r.state === 'queued') r.state = 'removed';
        this.touch(); return this.snapshot();
      } else if (key === 'POST /v1/queue/save') {
        if (!q.tracks.length) fail(409, 'empty_playlist'); s.overrides[q.playlistId] = [...q.tracks];
      }
      this.edit(); return this.snapshot();
    }
    if (route === '/v1/message') {
      if (method === 'PUT') {
        const text = clean(b.text); if (!text) fail(400, 'bad_request');
        s.message = { text, style: b.style, expiresAt: this.now() + b.minutes * 60000 };
      } else s.message = null;
      this.touch(); return this.snapshot();
    }
    if (route === '/v1/volume') { s.volume = b.level; this.touch(); return this.snapshot(); }
    if (route === '/v1/picture') {
      if (b.uploadId && !this.store.db.prepare('SELECT id FROM pictures WHERE id=?').get(b.uploadId)) fail(404, 'not_found');
      s.picture = { scene: b.scene ?? null, uploadId: b.uploadId ?? null }; this.touch(); return this.snapshot();
    }
    if (key === 'POST /v1/pictures') {
      if (!this.photo) fail(503, 'upstream_unavailable');
      const result = await this.photo(raw, mediaType), uploadId = id();
      this.store.db.prepare('INSERT INTO pictures VALUES(?,?,?,?,?)').run(uploadId, this.now(), result.width, result.height, result.jpeg);
      this.store.db.prepare('DELETE FROM pictures WHERE id NOT IN (SELECT id FROM pictures ORDER BY created DESC,rowid DESC LIMIT 3)').run();
      s.picture = { scene: null, uploadId }; this.touch();
      return { uploadId, width: result.width, height: result.height, snapshot: this.snapshot() };
    }
    if (key === 'GET /v1/pictures/{uploadId}') {
      const jpeg = this.store.db.prepare('SELECT jpeg FROM pictures WHERE id=?').get(p.uploadId).jpeg;
      const self = this;
      return { status: 200, media: { contentType: 'image/jpeg', contentLength: jpeg.length, body: (async function* () {
        if (self.s.tokens[a.key]?.expiresAt > self.now()) yield jpeg;
      })() } };
    }
    if (route === '/v1/library/search' || route === '/v1/guest/search') {
      if (!query.q || !query.q.trim()) fail(400, 'bad_request');
      const tracks = await this.library().search(query.q, 30);
      for (const t of tracks) s.tracks[t.id] = t; this.updateGains(); return { tracks };
    }
    if (route === '/v1/party/qr') return this.qr();
    if (route === '/v1/party') return this.partyView();
    if (route === '/v1/party/settings') {
      const was = s.enabled; s.enabled = b.enabled; s.order = b.order;
      if (!was && s.enabled && s.active && !s.party && !s.partyExpired) this.newParty();
      this.reorder(); this.touch(); return this.partyView();
    }
    if (route === '/v1/party/renew') {
      if (!s.active) fail(409, 'not_playing'); this.newParty(); this.touch(); return this.qr();
    }
    if (route === '/v1/party/guests/{guestId}/block') {
      s.guests[p.guestId].blocked = b.blocked;
      if (b.blocked) for (const r of s.requests.filter(r => r.guestId === p.guestId)) this.dropRequest(r);
      this.touch(); return this.partyView();
    }
    if (route === '/v1/party/requests/{requestId}' || route === '/v1/guest/requests/{requestId}') {
      this.dropRequest(s.requests.find(r => r.id === p.requestId)); this.touch();
      return a.role === 'host' ? this.partyView() : this.guestView(a);
    }
    if (route === '/v1/guest/state') return this.guestView(a);
    if (route === '/v1/guest/join') {
      if (a.guest) return { guestId: a.guest.id, guestKey: headers['x-guest-key'], expiresAt: s.party.expiresAt };
      const name = clean(b.name, 24); if (!name) fail(400, 'bad_request');
      if (Object.keys(s.guests).length >= 100) fail(409, 'conflict');
      const guestId = id(), guestKey = token(); s.guests[guestId] = { id: guestId, key: digest(guestKey), name, blocked: false };
      return { guestId, guestKey, expiresAt: s.party.expiresAt };
    }
    if (key === 'POST /v1/guest/requests') {
      const q = this.needQueue();
      if (this.current() === b.trackId || s.requests.some(r => r.trackId === b.trackId && ['queued', 'playing'].includes(r.state))) fail(409, 'already');
      const track = await this.library().getTrack(b.trackId); s.tracks[track.id] = track; this.updateGains();
      const next = q.tracks.filter(x => x !== track.id);
      if (next.length >= 5000) fail(409, 'conflict');
      const waiting = new Set(s.requests.filter(r => r.state === 'queued').map(r => r.trackId));
      let at = next.indexOf(this.current());
      // Insert into the waiting guest block following current, across wrap.
      let offset = 1;
      while (next.length && offset < next.length && waiting.has(next[(Math.max(at, -1) + offset) % next.length])) offset++;
      const index = at < 0 ? 0 : (at + offset > next.length ? (at + offset) % next.length : at + offset);
      next.splice(index, 0, track.id); q.tracks = next;
      const request = { id: id(), trackId: track.id, guestId: a.guest.id, guestName: a.guest.name, state: 'queued', sequence: ++s.requestN };
      s.requests.push(request); this.reorder(); this.edit(); return this.publicRequest(request);
    }
    if (route === '/v1/guest/control') { this.control(b.action); return this.guestView(a); }
    fail(404, 'not_found');
  }
}
