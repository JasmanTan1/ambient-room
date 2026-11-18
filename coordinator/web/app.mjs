export function joinContext(location, history, storage) {
  const prefix = 'ambient-room.v1.guest.';
  const fragment = new URLSearchParams(location.hash.slice(1));
  const incoming = fragment.get('t');
  history.replaceState(null, '', location.pathname);
  const previous = storage.getItem(prefix + 'party');
  if (incoming && incoming !== previous) storage.removeItem(prefix + 'key');
  const party = incoming ?? previous ?? '';
  if (party) storage.setItem(prefix + 'party', party);
  return { party, key: storage.getItem(prefix + 'key') ?? '',
    setKey(key) { this.key = key; storage.setItem(prefix + 'key', key); },
    clear() { this.party = ''; this.key = ''; storage.removeItem(prefix + 'party'); storage.removeItem(prefix + 'key'); } };
}
export function acceptSnapshot(old, next) {
  if (!old) return next;
  if (next.seq < old.seq) return next.gainRev > old.gainRev ? { ...old, gainRev: next.gainRev, gains: next.gains } : old;
  return next.gainRev < old.gainRev ? { ...next, gainRev: old.gainRev, gains: old.gains } : next;
}

if (typeof document !== 'undefined') {
  const $ = x => document.getElementById(x), guestMode = location.pathname === '/guest';
  let hostToken = '', snapshot = null, links = [], guest = null, photoUrl = null;
  let expires = Infinity, messageExpiry = Infinity, timerExpiry = Infinity, polling = false;
  if (guestMode) { guest = joinContext(location, history, sessionStorage); $('welcome').hidden = true; $('guest').hidden = false; }
  const say = text => { $('notice').textContent = text; };
  const run = fn => async event => { event?.preventDefault(); try { await fn(event); } catch (e) { say(e.message); } };
  async function request(path, method = 'GET', body, asGuest = false, key = crypto.randomUUID()) {
    const headers = {}, mutation = method !== 'GET';
    if (asGuest) { headers['x-party-token'] = guest.party; if (guest.key) headers['x-guest-key'] = guest.key; }
    else if (hostToken) headers.Authorization = `Bearer ${hostToken}`;
    if (mutation && (asGuest || hostToken)) headers['Idempotency-Key'] = key;
    if (body !== undefined) headers['Content-Type'] = body instanceof File ? body.type : 'application/json';
    const options = { method, headers, cache: 'no-store', referrerPolicy: 'no-referrer',
      body: body === undefined ? undefined : body instanceof File ? body : JSON.stringify(body) };
    let response;
    // One bounded retry uses the identical idempotency key. Validation failures
    // are shown to the user; uncertain network delivery cannot duplicate writes.
    for (let attempt = 0; attempt < 2; attempt++) {
      try { response = await fetch(path, options); break; }
      catch { if (attempt) throw new Error('Connection unavailable. Try again shortly.'); }
    }
    const result = await response.json();
    if (!response.ok) {
      if (asGuest && ['ended','expired','blocked','off','unauthorized'].includes(result.error)) { guest.clear(); expires = 0; }
      if (!asGuest && response.status === 401 && hostToken) {
        hostToken = ''; $('host').hidden = true; $('welcome').hidden = false;
      }
      throw new Error(result.error === 'rate_limited' ? `Please wait ${response.headers.get('Retry-After')} seconds.` : result.message);
    }
    return result;
  }
  const values = form => Object.fromEntries(new FormData(form));
  function library(v) { return v.kind === 'jellyfin' ? { kind: v.kind, baseUrl: v.baseUrl, credential: v.credential }
    : { kind: v.kind, baseUrl: v.baseUrl, username: v.username, credential: v.credential }; }
  async function opened(auth) {
    hostToken = auth.hostToken; $('welcome').hidden = true; $('host').hidden = false;
    $('setup').reset(); $('login').reset();
    links = (await request('/v1/config/links')).links;
    await refresh(); say('Host remote ready. Closing this page requires a new console approval.');
  }
  $('login').onsubmit = run(async () => opened(await request('/v1/auth/host','POST', values($('login')))));
  $('setup').onsubmit = run(async () => {
    const v = values($('setup'));
    await opened(await request('/v1/setup','POST',{ setupCode: v.setupCode, publicOrigin: v.publicOrigin, library: library(v) }));
  });
  function button(text, fn) { const b = document.createElement('button'); b.textContent = text; b.onclick = run(fn); return b; }
  function row(parent, text, actions = []) { const item = document.createElement(parent.tagName === 'OL' ? 'li' : 'p'); item.textContent = text; item.append(...actions); parent.append(item); }
  async function write(path, method, body) { const result = await request(path, method, body); await refresh(); return result; }
  async function refresh() {
    if (guestMode) {
      if (!guest.party) return say('This guest link has ended. Ask the host for the current link.');
      const sent = performance.now(), state = await request('/v1/guest/state','GET',undefined,true);
      expires = sent + Math.max(0, state.expiresAt - state.serverNow);
      $('join').hidden = !!state.you;
      $('guest-now').textContent = state.now ? `${state.now.track.title} · ${state.now.track.artist}${state.now.paused ? ' · Paused' : ''}` : 'Waiting for music';
      document.querySelectorAll('[data-guest-control]').forEach(b => { b.disabled = !state.now?.mine; });
      $('up-next').replaceChildren();
      state.upNext.forEach(x => row($('up-next'), `${x.track.title}${x.by ? ` · ${x.by}` : ''}${x.mine ? ' · Yours' : ''}`,
        x.mine && x.requestId ? [button('Remove', async () => { await request(`/v1/guest/requests/${x.requestId}`,'DELETE',undefined,true); await refresh(); })] : []));
      return;
    }
    if (!hostToken) return;
    const sent = performance.now(); snapshot = acceptSnapshot(snapshot, await request('/v1/state'));
    messageExpiry = snapshot.message ? sent + Math.max(0, snapshot.message.expiresAt - snapshot.serverNow) : 0;
    timerExpiry = snapshot.timer ? sent + Math.max(0, snapshot.timer.endsAt - snapshot.serverNow) : 0;
    $('playing').textContent = `${snapshot.tvConnected ? 'TV connected' : 'TV disconnected'} · ${snapshot.activePlaylistId ? snapshot.paused ? 'Paused' : 'Playing' : 'Idle'}`;
    const selected = $('playlist').value; $('playlist').replaceChildren();
    snapshot.playlists.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; $('playlist').append(o); });
    if (snapshot.playlists.some(p => p.id === selected)) $('playlist').value = selected;
    $('queue').replaceChildren();
    const tracks = snapshot.queue?.tracks ?? [];
    tracks.forEach((t, i) => row($('queue'), `${t.title} · ${t.artist}`, [
      button('Play next', () => write('/v1/queue','POST',{ trackId:t.id, where:'next' })),
      button('Move earlier', () => write('/v1/queue/move','POST',{ trackId:t.id, beforeId: tracks[Math.max(0,i-1)].id })),
      button('End of loop', () => write('/v1/queue/move','POST',{ trackId:t.id, beforeId:null })),
      button('Remove', () => write(`/v1/queue/${t.id}`,'DELETE'))]));
    $('links').replaceChildren();
    links.forEach(l => row($('links'), `${snapshot.playlists.find(p => p.id === l.playlistId)?.name ?? l.playlistId} · ${l.scene}`, [button('Unlink', async () => {
      links = links.filter(x => x.playlistId !== l.playlistId); await write('/v1/config/links','PUT',{ links });
    })]));
    const party = await request('/v1/party'), qr = await request('/v1/party/qr');
    $('settings').elements.enabled.checked = party.enabled; $('settings').elements.order.value = party.order;
    $('party-link').replaceChildren();
    if (qr.url) { const a = document.createElement('a'); a.href = qr.url; a.textContent = 'Open guest join link'; a.rel = 'noreferrer'; $('party-link').append(a); }
    $('guests').replaceChildren(); $('requests').replaceChildren();
    party.guests.forEach(g => row($('guests'), `${g.name}${g.blocked ? ' · Blocked' : ''}`,[button(g.blocked ? 'Unblock' : 'Block', () => write(`/v1/party/guests/${g.id}/block`,'POST',{blocked:!g.blocked}))]));
    party.requests.filter(r => ['queued','playing'].includes(r.state)).forEach(r => row($('requests'), `${snapshot.queue?.tracks.find(t=>t.id===r.trackId)?.title ?? 'Track'} · ${r.guestName} · ${r.state}`,[button('Remove request',()=>write(`/v1/party/requests/${r.id}`,'DELETE'))]));
    if (photoUrl) { URL.revokeObjectURL(photoUrl); photoUrl = null; }
    $('picture').hidden = !snapshot.picture.uploadId;
    if (snapshot.picture.uploadId) {
      const r = await fetch(`/v1/pictures/${snapshot.picture.uploadId}`, { headers: {Authorization:`Bearer ${hostToken}`}, cache:'no-store' });
      if (r.ok) { photoUrl = URL.createObjectURL(await r.blob()); $('picture').src = photoUrl; }
    }
    $('photo-state').textContent = snapshot.message ? snapshot.message.text : '';
  }
  $('start').onclick = run(() => write('/v1/playback/start','POST', $('playlist').value ? {playlistId:$('playlist').value} : {}));
  $('stop').onclick = run(() => write('/v1/playback/stop','POST'));
  document.querySelectorAll('[data-control]').forEach(b => { b.onclick = run(() => write('/v1/playback/control','POST',{action:b.dataset.control})); });
  $('volume').onsubmit = run(() => write('/v1/volume','PUT',{level:+values($('volume')).level}));
  $('timer').onsubmit = run(() => write('/v1/timer','POST',{minutes:+values($('timer')).minutes}));
  $('timer-off').onclick = run(() => write('/v1/timer','DELETE'));
  $('pair').onsubmit = run(async () => { if (confirm('Approve this TV and replace any currently paired TV?')) { await write('/v1/pairings/approve','POST',values($('pair'))); say('TV approved. Finish pairing on the TV.'); } });
  $('unpair').onclick = run(async () => { const id=$('device-id').value; if(id && confirm('Unpair the TV and clear room photos?')) await write(`/v1/devices/${encodeURIComponent(id)}`,'DELETE'); });
  $('logout').onclick = run(async () => { await request('/v1/auth/revoke','POST'); hostToken=''; $('host').hidden=true; $('welcome').hidden=false; });
  $('libraries').onclick = run(async () => {
    const p = await request('/v1/playlists'); $('available').replaceChildren();
    p.playlists.forEach(p => {
      const select = document.createElement('select'); select.setAttribute('aria-label',`Scene for ${p.name}`);
      ['calm','nightcity','rain','cafe','festival','kpop'].forEach(s=>{const o=document.createElement('option');o.textContent=s;select.append(o);});
      row($('available'),p.name,[select,button('Link playlist',async()=>{
        const next=[...links.filter(l=>l.playlistId!==p.id),{playlistId:p.id,scene:select.value}];
        await request('/v1/config/links','PUT',{links:next}); links=next; await refresh();
      })]);
    });
  });
  async function search(form, target, asGuest) {
    const results=await request(`/v1/${asGuest?'guest':'library'}/search?q=${encodeURIComponent(values(form).q)}`,'GET',undefined,asGuest);
    target.replaceChildren();
    results.tracks.forEach(t=>row(target,`${t.title} · ${t.artist}`,[button(asGuest?'Request':'Add next',async()=>{
      await request(asGuest?'/v1/guest/requests':'/v1/queue','POST',asGuest?{trackId:t.id}:{trackId:t.id,where:'next'},asGuest);await refresh();
    }),...(!asGuest?[button('Add to end',()=>write('/v1/queue','POST',{trackId:t.id,where:'end'}))]:[])]));
  }
  $('search').onsubmit=run(()=>search($('search'),$('results'),false));
  $('guest-search').onsubmit=run(()=>search($('guest-search'),$('guest-results'),true));
  $('save').onclick=run(()=>write('/v1/queue/save','POST'));
  $('reset').onclick=run(()=>write('/v1/queue','DELETE'));
  $('scene').onsubmit=run(()=>write('/v1/picture','PUT',values($('scene'))));
  $('playlist-scene').onclick=run(()=>write('/v1/picture','PUT',{}));
  $('message').onsubmit=run(()=>{const v=values($('message'));return write('/v1/message','PUT',{...v,minutes:+v.minutes});});
  $('message-clear').onclick=run(()=>write('/v1/message','DELETE'));
  $('photo').onsubmit=run(async()=>{
    const file=$('photo').elements.photo.files[0];
    if(!file||file.size>8388608)throw new Error('Choose a picture up to 8 MiB.');
    await write('/v1/pictures','POST',file);$('photo').reset();
  });
  $('settings').onsubmit=run(()=>write('/v1/party/settings','PUT',{enabled:$('settings').elements.enabled.checked,order:values($('settings')).order}));
  $('renew').onclick=run(async()=>{if(confirm('End the current guest link and remove pending requests?'))await write('/v1/party/renew','POST');});
  $('config').onsubmit=run(async()=>{
    if(confirm('Replace library and clear local room media state?')){await request('/v1/config/library','PUT',library(values($('config'))));links=[];$('config').reset();await refresh();}
  });
  $('join').onsubmit=run(async()=>{const r=await request('/v1/guest/join','POST',values($('join')),true);guest.setKey(r.guestKey);say('Joined the room.');await refresh();});
  document.querySelectorAll('[data-guest-control]').forEach(b=>{b.onclick=run(async()=>{await request('/v1/guest/control','POST',{action:b.dataset.guestControl},true);await refresh();});});
  setInterval(()=>{
    if(guestMode&&performance.now()>=expires){guest.clear();$('up-next').replaceChildren();$('guest-now').textContent='Guest link expired.';document.querySelectorAll('[data-guest-control]').forEach(b=>{b.disabled=true;});}
    if(!guestMode){if(performance.now()>=messageExpiry)$('photo-state').textContent='';$('timer-state').textContent=timerExpiry>performance.now()?`${Math.ceil((timerExpiry-performance.now())/60000)} min remaining`:'';}
  },1000);
  setInterval(run(async()=>{if(polling)return;polling=true;try{await refresh();}finally{polling=false;}}),5000);
  if(guestMode)run(refresh)();
}
