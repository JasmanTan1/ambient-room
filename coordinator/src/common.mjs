import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const api = JSON.parse(readFileSync(new URL('../contract/openapi.json', import.meta.url)));
export const id = () => randomBytes(18).toString('base64url');
export const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const canonical = x => x === null || typeof x !== 'object' ? JSON.stringify(x)
  : Array.isArray(x) ? `[${x.map(canonical).join(',')}]`
    : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
export class Fault extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export function fail(status, code) { throw new Fault(status, code); }
export function validate(schema, value) {
  if (schema.$ref) return validate(api.components.schemas[schema.$ref.split('/').at(-1)], value);
  if (schema.oneOf) return schema.oneOf.filter(s => validate(s, value)).length === 1;
  if (schema.anyOf) return schema.anyOf.some(s => validate(s, value));
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  const t = schema.type;
  if (t === 'null') return value === null;
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if ((schema.required ?? []).some(k => !Object.hasOwn(value, k))) return false;
    return Object.keys(value).every(k => schema.properties?.[k]
      ? validate(schema.properties[k], value[k]) : schema.additionalProperties !== false);
  }
  if (t === 'array') return Array.isArray(value) && value.length <= (schema.maxItems ?? Infinity)
    && value.every(v => validate(schema.items, v));
  if (t === 'string') return typeof value === 'string'
    && [...value].length >= (schema.minLength ?? 0) && [...value].length <= (schema.maxLength ?? Infinity)
    && (!schema.pattern || new RegExp(schema.pattern).test(value));
  if (t === 'number' || t === 'integer') return typeof value === 'number' && Number.isFinite(value)
    && (t !== 'integer' || Number.isSafeInteger(value))
    && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (t === 'boolean') return typeof value === 'boolean';
  return true;
}
export function clean(raw, max = 60) {
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().normalize('NFC');
  return [...s].length >= 1 && [...s].length <= max ? s : null;
}
export function endpoint(raw, allowHttp = false, originOnly = false) {
  let u;
  if (!/^https?:\/\//.test(raw) || /[?#]/.test(raw) || /^https?:\/\/[^/]*@/.test(raw)) fail(400, 'bad_request');
  try { u = new URL(raw); } catch { fail(400, 'bad_request'); }
  if (!['https:', ...(allowHttp ? ['http:'] : [])].includes(u.protocol)
    || u.username || u.password || u.hash || u.search || (originOnly && u.pathname !== '/')) fail(400, 'bad_request');
  return u;
}
export function rangeHeader(raw) {
  if (!raw) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!m || (!m[1] && !m[2]) || (m[1] && !Number.isSafeInteger(+m[1]))
    || (m[2] && !Number.isSafeInteger(+m[2])) || (!m[1] && +m[2] === 0)
    || (m[1] && m[2] && +m[1] > +m[2])) fail(416, 'bad_request');
  return { header: raw };
}
export function queueInsert(queue, track, current, where) {
  const q = queue.filter(x => x !== track), i = q.indexOf(current);
  q.splice(where === 'next' ? (i < 0 ? 0 : i + 1) : (i < 0 ? q.length : i), 0, track);
  return q;
}
export function orderWaiting(waiting, order, lastTurn = {}) {
  const sorted = [...waiting].sort((a, b) => a.sequence - b.sequence);
  if (order === 'first_come') return sorted;
  const groups = new Map();
  for (const r of sorted) { if (!groups.has(r.guestId)) groups.set(r.guestId, []); groups.get(r.guestId).push(r); }
  const guests = [...groups.keys()].sort((a, b) => (lastTurn[a] ?? 0) - (lastTurn[b] ?? 0)
    || groups.get(a)[0].sequence - groups.get(b)[0].sequence);
  const result = [];
  for (let round = 0; result.length < sorted.length; round++) {
    for (const g of guests) if (groups.get(g)[round]) result.push(groups.get(g)[round]);
  }
  return result;
}
