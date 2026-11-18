import { createHash, randomBytes } from 'node:crypto';
import { Fault, fail, endpoint } from './common.mjs';

const unavailable = () => new Fault(503, 'upstream_unavailable');
const text = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
const num = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
function array(v) { if (!Array.isArray(v)) throw unavailable(); return v; }
function object(v) { if (!v || typeof v !== 'object' || Array.isArray(v)) throw unavailable(); return v; }

class Rest {
  constructor(context) {
    this.c = context;
    this.base = endpoint(context.baseUrl.toString(), context.allowHttp);
  }
  async request(path, params, signal, range, json = true) {
    const u = new URL(this.base.toString());
    u.pathname = `${this.base.pathname.replace(/\/$/, '')}/${path}`;
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    const headers = this.auth(u);
    if (range) headers.Range = range.header;
    try {
      const r = await this.c.fetch(u, { method: 'GET', headers, redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(json ? 10000 : 300000)]) : AbortSignal.timeout(10000) });
      // No redirects, even same-origin: configuration changes must be explicit.
      if (r.status === 404) fail(404, 'not_found');
      if (r.status === 416) fail(416, 'bad_request');
      if (![200, 206].includes(r.status) || (json && r.status !== 200)) throw unavailable();
      if (!json) {
        const ct = r.headers.get('content-type')?.split(';')[0];
        if (!ct || (!ct.startsWith('audio/') && ct !== 'application/octet-stream')) throw unavailable();
        const cr = r.headers.get('content-range');
        if (r.status === 206 && (!range || !/^bytes \d+-\d+\/\d+$/.test(cr ?? ''))) throw unavailable();
        const length = r.headers.get('content-length');
        return { status: r.status, contentType: ct, contentLength: length && /^\d+$/.test(length) ? +length : null,
          contentRange: cr, acceptRanges: 'bytes', body: r.body };
      }
      // Bound JSON independently of Content-Length, including chunked responses.
      const parts = []; let size = 0;
      for await (const part of r.body) {
        size += part.length;
        if (size > 8 * 1024 * 1024) throw unavailable();
        parts.push(part);
      }
      return object(JSON.parse(Buffer.concat(parts).toString('utf8')));
    } catch (e) { if (e instanceof Fault) throw e; throw unavailable(); }
  }
  provider(kind, opaque) { const p = this.c.ids.toProvider(kind, opaque); if (!p) fail(404, 'not_found'); return p; }
  info(p, kind) {
    const providerId = kind === 'jellyfin' ? p.Id : p.id;
    const count = num(kind === 'jellyfin' ? p.ChildCount : p.songCount);
    return { id: this.c.ids.fromProvider('playlist', providerId), name: text(kind === 'jellyfin' ? p.Name : p.name, 200), scene: 'calm', trackCount: Math.floor(count) };
  }
  track(p, jelly = false) {
    object(p);
    if ((jelly && p.Type !== 'Audio') || (!jelly && (p.isVideo || p.type === 'video' || p.isDir))) fail(404, 'not_found');
    const id = jelly ? p.Id : p.id;
    const gain = jelly ? null : p.replayGain?.trackGain;
    return { id: this.c.ids.fromProvider('track', id), title: text(jelly ? p.Name : p.title, 300),
      artist: text(jelly ? (Array.isArray(p.Artists) ? p.Artists.join(', ') : '') : p.artist, 300),
      durationSec: num(jelly ? p.RunTimeTicks / 10000000 : p.duration),
      gainDb: typeof gain === 'number' && Number.isFinite(gain) && gain >= -60 && gain <= 20 ? gain : null };
  }
}

export class OpenSubsonic extends Rest {
  kind = 'opensubsonic';
  auth(u) {
    const s = randomBytes(12).toString('hex');
    const t = createHash('md5').update(this.c.credentials.credential + s).digest('hex');
    for (const [k, v] of Object.entries({ u: this.c.credentials.username, t, s, v: '1.16.1', c: 'AmbientRoom', f: 'json' })) u.searchParams.set(k, v);
    return {};
  }
  async call(method, params = {}, signal) {
    const result = object((await this.request(`rest/${method}.view`, params, signal))['subsonic-response']);
    if (result.status !== 'ok') {
      if (+result.error?.code === 70) fail(404, 'not_found');
      throw unavailable();
    }
    return result;
  }
  async check(signal) { await this.call('ping', {}, signal); }
  async listPlaylists(cursor, limit, signal) {
    const items = array(object((await this.call('getPlaylists', {}, signal)).playlists).playlist ?? []);
    const start = cursor === null ? 0 : +cursor;
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw unavailable();
    return { playlists: items.slice(start, start + limit).map(p => this.info(p)), cursor: start + limit < items.length ? String(start + limit) : null };
  }
  async getPlaylist(id, signal) {
    const provider = this.provider('playlist', id);
    const p = object((await this.call('getPlaylist', { id: provider }, signal)).playlist);
    if (p.id !== provider) throw unavailable();
    const items = array(p.entry ?? []);
    if (items.length > 5000 || num(p.songCount) > 5000) fail(409, 'conflict');
    if (p.songCount !== undefined && p.songCount !== items.length) throw unavailable();
    const tracks = items.map(t => this.track(t));
    return { id, name: text(p.name, 200), scene: 'calm', tracks: [...new Map(tracks.map(t => [t.id, t])).values()] };
  }
  async getTrack(id, signal) {
    const provider = this.provider('track', id);
    const song = object((await this.call('getSong', { id: provider }, signal)).song);
    if (song.id !== provider) throw unavailable();
    return this.track(song);
  }
  async search(query, limit = 30, signal) {
    const result = await this.call('search3', { query, songCount: Math.min(30, limit), songOffset: 0, albumCount: 0, artistCount: 0 }, signal);
    return array(object(result.searchResult3).song ?? []).slice(0, Math.min(30, limit)).filter(s => !s.isVideo && s.type !== 'video' && !s.isDir).map(s => this.track(s));
  }
  async openStream(id, range, signal) {
    await this.getTrack(id, signal);
    return this.request('rest/stream.view', { id: this.provider('track', id), format: 'raw' }, signal, range, false);
  }
}

export class Jellyfin extends Rest {
  kind = 'jellyfin';
  auth() {
    // A scoped user access token or server API token is supplied explicitly.
    const t = this.c.credentials.credential;
    if (/[\r\n"\\]/.test(t)) fail(400, 'bad_request');
    return { Authorization: `MediaBrowser Client="AmbientRoom", Device="Coordinator", DeviceId="ambient-room", Version="1", Token="${t}"` };
  }
  async check(signal) { object(await this.request('System/Info', {}, signal)); }
  async page(path, params, cursor, limit, signal) {
    const start = cursor === null ? 0 : +cursor;
    if (!Number.isSafeInteger(start) || start < 0) throw unavailable();
    const p = await this.request(path, { ...params, StartIndex: start, Limit: limit }, signal);
    const items = array(p.Items);
    if (!Number.isSafeInteger(p.TotalRecordCount) || p.TotalRecordCount < start + items.length
      || items.length > limit || (!items.length && p.TotalRecordCount > start)) throw unavailable();
    return { items, cursor: start + items.length < p.TotalRecordCount ? String(start + items.length) : null, total: p.TotalRecordCount };
  }
  async listPlaylists(cursor, limit, signal) {
    const p = await this.page('Items', { IncludeItemTypes: 'Playlist', Recursive: true, Fields: 'ChildCount', SortBy: 'SortName', SortOrder: 'Ascending' }, cursor, limit, signal);
    return { playlists: p.items.filter(x => x.Type === 'Playlist' && (!x.MediaType || x.MediaType === 'Audio')).map(x => this.info(x, 'jellyfin')), cursor: p.cursor };
  }
  async item(provider, signal) {
    const r = await this.request('Items', { Ids: provider, Fields: 'ChildCount' }, signal);
    const items = array(r.Items);
    const item = items.find(x => x.Id === provider);
    if (!item) fail(404, 'not_found');
    return item;
  }
  async getPlaylist(id, signal) {
    const provider = this.provider('playlist', id), meta = await this.item(provider, signal);
    if (meta.Type !== 'Playlist' || (meta.MediaType && meta.MediaType !== 'Audio')) fail(404, 'not_found');
    const tracks = []; let cursor = null;
    do {
      const p = await this.page(`Playlists/${encodeURIComponent(provider)}/Items`, {}, cursor, 500, signal);
      if (p.total > 5000 || tracks.length + p.items.length > 5000) fail(409, 'conflict');
      tracks.push(...p.items.map(x => this.track(x, true))); cursor = p.cursor;
    } while (cursor !== null);
    return { id, name: text(meta.Name, 200), scene: 'calm', tracks: [...new Map(tracks.map(t => [t.id, t])).values()] };
  }
  async getTrack(id, signal) { return this.track(await this.item(this.provider('track', id), signal), true); }
  async search(query, limit = 30, signal) {
    const p = await this.page('Items', { IncludeItemTypes: 'Audio', Recursive: true, SearchTerm: query }, null, Math.min(30, limit), signal);
    return p.items.filter(x => x.Type === 'Audio').map(x => this.track(x, true));
  }
  async openStream(id, range, signal) {
    await this.getTrack(id, signal);
    return this.request(`Audio/${encodeURIComponent(this.provider('track', id))}/stream`, { Static: true }, signal, range, false);
  }
}
export function adapter(config, ids, fetch = globalThis.fetch, allowHttp = false) {
  const context = { baseUrl: endpoint(config.baseUrl, allowHttp), credentials: config, ids, fetch, allowHttp };
  return config.kind === 'opensubsonic' ? new OpenSubsonic(context) : new Jellyfin(context);
}
