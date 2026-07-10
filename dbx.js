/* dbx.js — hosted-mode data layer: the dashboard talks to Dropbox directly from
 * the browser (GitHub Pages). Mirrors the server's STORAGE handlers against the
 * same JSON files, so index.html works identically on your phone in Seoul.
 *
 * Scope: the triage essentials — tasks, deadlines, travel, brief, health. Claude-
 * dependent + bulk-dangerous endpoints are home-only (return 501; the UI hides
 * those buttons when !LOCAL). App-folder app → Dropbox paths are "/<file>".
 *
 * Token: OAuth PKCE (public client, no secret). One "Connect Dropbox" per device.
 */
(function () {
  const APP_KEY = localStorage.getItem('dbx-app-key') || '';   // set once via Connect
  const ROOT = '';            // App-folder app: the app folder IS the root
  const LS = { rt: 'dbx-refresh', at: 'dbx-access', exp: 'dbx-exp', ver: 'dbx-verifier' };
  const revs = {};            // rel -> latest rev (for compare-and-swap)

  // ── PKCE connect ────────────────────────────────────────────────
  function b64url(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
  async function sha256(s) { return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
  async function connect() {
    const key = prompt('Dropbox App key (from your app console):', APP_KEY);
    if (!key) return;
    localStorage.setItem('dbx-app-key', key);
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
    localStorage.setItem(LS.ver, verifier);
    const challenge = await sha256(verifier);
    const u = new URL('https://www.dropbox.com/oauth2/authorize');
    u.search = new URLSearchParams({ client_id: key, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256',
      token_access_type: 'offline', redirect_uri: location.origin + location.pathname }).toString();
    location.href = u.toString();
  }
  async function handleRedirect() {
    const code = new URLSearchParams(location.search).get('code');
    if (!code) return;
    const key = localStorage.getItem('dbx-app-key');
    const body = new URLSearchParams({ code, grant_type: 'authorization_code',
      client_id: key, code_verifier: localStorage.getItem(LS.ver),
      redirect_uri: location.origin + location.pathname });
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body });
    const j = await r.json();
    if (j.refresh_token) {
      localStorage.setItem(LS.rt, j.refresh_token);
      localStorage.setItem(LS.at, j.access_token);
      localStorage.setItem(LS.exp, Date.now() + (j.expires_in - 60) * 1000);
      history.replaceState({}, '', location.pathname);   // strip ?code=
    }
  }
  async function token() {
    if (localStorage.getItem(LS.at) && Date.now() < +localStorage.getItem(LS.exp)) return localStorage.getItem(LS.at);
    const rt = localStorage.getItem(LS.rt);
    if (!rt) { connect(); throw new Error('not connected'); }
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt,
      client_id: localStorage.getItem('dbx-app-key') });
    const j = await (await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body })).json();
    localStorage.setItem(LS.at, j.access_token);
    localStorage.setItem(LS.exp, Date.now() + (j.expires_in - 60) * 1000);
    return j.access_token;
  }

  // ── low-level Dropbox ───────────────────────────────────────────
  async function download(rel) {
    const r = await fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Dropbox-API-Arg': JSON.stringify({ path: `${ROOT}/${rel}` }) } });
    if (r.status === 409) return null;                    // not found
    if (!r.ok) throw new Error('download ' + r.status);
    const meta = JSON.parse(r.headers.get('Dropbox-API-Result') || '{}');
    if (meta.rev) revs[rel] = meta.rev;
    return await r.text();
  }
  async function readJson(rel, def) { const t = await download(rel); if (t == null) return def; try { return JSON.parse(t); } catch { return def; } }
  async function upload(rel, text, mode) {
    const r = await fetch('https://content.dropboxapi.com/2/files/upload', { method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: `${ROOT}/${rel}`, mode, mute: true }) }, body: text });
    if (!r.ok) { const e = new Error('upload ' + r.status); e.status = r.status; throw e; }
    const meta = await r.json(); if (meta.rev) revs[rel] = meta.rev; return meta;
  }
  async function updateJson(rel, mutate, def) {
    for (let i = 0; i < 3; i++) {
      const obj = mutate(await readJson(rel, def));
      const mode = revs[rel] ? { '.tag': 'update', update: revs[rel] } : 'overwrite';
      try { await upload(rel, JSON.stringify(obj, null, 2), mode); return obj; }
      catch (e) { if (e.status === 409) { delete revs[rel]; continue; } throw e; }
    }
  }
  async function listDir(rel) {
    try {
      const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', { method: 'POST',
        headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: `${ROOT}/${rel}`, recursive: false }) });
      if (!r.ok) return []; const j = await r.json(); return (j.entries || []).map(e => e.name);
    } catch { return []; }
  }

  // ── helpers: JS record builders (mirror records.py) ─────────────
  function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, '.000Z'); }
  function genId() { return Date.now().toString(16) + Math.floor(Math.random() * 65536).toString(16).padStart(4, '0'); }
  const resp = (obj, status = 200) => ({ ok: status < 300, status, json: async () => obj });

  function heuristicDomain(text) {
    const t = (text || '').toLowerCase();
    const work = /referee|review|r&r|revise|paper|grant|nsf|student|syllabus|dept|letter|journal|conference|editor|\.edu|논문|학회|강의|학생/;
    const life = /daycare|pediatric|grocery|house|car|insurance|birthday|diaper|baby|kid|family|dinner|recipe|어린이집|병원|아기|가족/;
    return work.test(t) && !life.test(t) ? 'work' : (life.test(t) ? 'life' : 'life');
  }

  // ── route table ─────────────────────────────────────────────────
  const DISABLED = ['/api/presort', '/api/backfill-domains', '/api/recipes/promote-full',
    '/api/recipes/purge-excluded', '/api/recipes/plan', '/api/import'];

  async function handle(path, opts) {
    const method = (opts && opts.method) || 'GET';
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (DISABLED.includes(path)) return resp({ error: 'home-only' }, 501);

    // — reads —
    if (path === '/api/items') return resp(await readJson('data.json', []));
    if (path === '/api/deadlines') {
      const ds = await readJson('deadlines.json', []);
      const day = 86400000, today = new Date(new Date().toDateString());
      return resp(ds.map(d => {
        const dl = d.due_date ? Math.round((new Date(d.due_date) - today) / day) : null;
        return { ...d, days_left: dl, runway_open: dl != null && dl <= (d.lead_time_days || 14) };
      }));
    }
    if (path === '/api/sparks') return resp(await readJson('sparks.json', []));
    if (path === '/api/recipes') return resp(await readJson('recipes/recipes.json', []));
    if (path === '/api/logs') return resp(await readJson('journal.json', []));
    if (path === '/api/vault') return resp(await readJson('vault.json', []));
    if (path === '/api/travel') { const t = await readJson('travel.flag', null); return resp(t ? { on: true, since: t.since, note: t.note } : { on: false }); }
    if (path === '/api/brief') { const md = await download('brief.md'); const fresh = md != null; return resp({ markdown: md, generated: null, fresh }); }
    if (path.startsWith('/api/health')) return resp(await computeHealth(new URLSearchParams(path.split('?')[1] || '').get('domain')));
    if (path === '/api/weekly-summary') return resp(await computeWeekly());

    // — task writes (data.json) —
    if (path === '/api/capture') return resp(await updateJson('data.json', a => {
      if (body.capture_src && a.some(i => i.capture_src === body.capture_src)) return a;
      a.push({ id: genId(), text: (body.text || '').trim(), url: (body.url || '').trim() || null,
        nextStep: (body.nextStep || '').trim() || null, memo: (body.memo || '').trim() || null,
        list: body.list || 'inbox', created: nowIso(),
        domain: ['work', 'life'].includes(body.domain) ? body.domain : heuristicDomain(body.text),
        ...(body.unsorted ? { unsorted: true } : {}) }); return a; }, []), 201);
    const setField = (fn) => updateJson('data.json', a => { const it = a.find(i => i.id === body.id); if (it) fn(it); return a; }, []);
    if (path === '/api/move') { await setField(i => i.list = body.list); return resp({ ok: true }); }
    if (path === '/api/done') { await setField(i => { i.list = 'done'; i.completed = nowIso(); }); return resp({ ok: true }); }
    if (path === '/api/delete') { await updateJson('data.json', a => a.filter(i => i.id !== body.id), []); return resp({ ok: true }); }
    if (path === '/api/schedule') { await setField(i => { i.list = 'thisweek'; i.scheduled = body.day; }); return resp({ ok: true }); }
    if (path === '/api/update-nextstep') { await setField(i => i.nextStep = (body.nextStep || '').trim() || null); return resp({ ok: true }); }
    if (path === '/api/update-memo') { await setField(i => i.memo = (body.memo || '').trim() || null); return resp({ ok: true }); }
    if (path === '/api/promote') { await setField(i => { i.list = 'inbox'; if (!i.nextStep && i.memo) i.nextStep = i.memo; }); return resp({ ok: true }); }
    if (path === '/api/set-domain') { await setField(i => i.domain = body.domain); return resp({ ok: true }); }
    if (path === '/api/log') return resp(await updateJson('journal.json', a => { a.push({ id: genId(), text: body.text, timestamp: nowIso() }); return a; }, []), 201);

    // — deadlines —
    if (path === '/api/deadlines/add') return resp(await updateJson('deadlines.json', a => {
      a.push({ id: genId(), title: body.title, type: body.type || 'other', due_date: body.due_date,
        lead_time_days: body.lead_time_days || 14, domain: body.domain || 'work', status: 'upcoming',
        notes: body.notes || null, linked_task_id: null, runway_opened: null,
        proposed: !!body.proposed, source: body.source || 'dashboard', source_id: body.source_id || null, created: nowIso() }); return a; }, []), 201);
    if (path === '/api/deadlines/update') { await updateJson('deadlines.json', a => { const d = a.find(x => x.id === body.id); if (d) Object.assign(d, body.fields || {}); return a; }, []); return resp({ ok: true }); }
    if (path === '/api/deadlines/confirm') { await updateJson('deadlines.json', a => { const d = a.find(x => x.id === body.id); if (d) d.proposed = false; return a; }, []); return resp({ ok: true }); }
    if (path === '/api/deadlines/delete') { await updateJson('deadlines.json', a => a.filter(x => x.id !== body.id), []); return resp({ ok: true }); }
    if (path === '/api/deadlines/check') return resp({ opened: [] });   // cloud brain runs the real engine

    // — travel —
    if (path === '/api/travel') { if (body.on) await upload('travel.flag', JSON.stringify({ since: nowIso(), note: body.note || '' }), 'overwrite'); else await del('travel.flag'); const t = await readJson('travel.flag', null); return resp(t ? { on: true, since: t.since } : { on: false }); }

    // — recipes (read-mostly on phone) —
    if (path === '/api/recipes/cooked') { await updateJson('recipes/recipes.json', a => { const r = a.find(x => x.id === body.id); if (r) { r.times_cooked = (r.times_cooked || 0) + 1; r.last_cooked = nowIso(); } return a; }, []); return resp({ ok: true }); }
    if (path === '/api/recipes/enrich' || path === '/api/recipes/bulk-update') return resp({ ok: true });

    return resp({ error: 'not found' }, 404);
  }

  async function del(rel) {
    try { await fetch('https://api.dropboxapi.com/2/files/delete_v2', { method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: `${ROOT}/${rel}` }) }); } catch {}
  }

  async function computeHealth(domain) {
    const items = await readJson('data.json', []);
    const inDom = i => !domain || i.domain === domain || !i.domain;
    const now = Date.now(), day = 86400000, STALE = 14;
    const travel = (await readJson('travel.flag', null)) != null;
    const inbox = items.filter(i => i.list === 'inbox' && inDom(i));
    const stale = travel ? 0 : inbox.filter(i => i.created && (now - new Date(i.created)) / day >= STALE).length;
    return {
      inbox: inbox.length, stale,
      unsorted: items.filter(i => i.unsorted && i.list !== 'done' && inDom(i)).length,
      unclassified: items.filter(i => ['inbox','thisweek','someday','waiting'].includes(i.list) && !['work','life'].includes(i.domain)).length,
      waiting_overdue: items.filter(i => i.list === 'waiting' && inDom(i) && (now - new Date(i.waitingSince || i.created)) / day >= 7).length,
      recipe_queue: 0, sparks_week: 0, catchup_threshold: 25, travel,
    };
  }
  async function computeWeekly() {
    const items = await readJson('data.json', []); const cut = Date.now() - 7 * 86400000;
    return { done: items.filter(i => i.list === 'done' && i.completed && new Date(i.completed) >= cut).length, recipes_cooked: 0, sparks: 0 };
  }

  handleRedirect();
  window.DBX = { handle, connect, connected: () => !!localStorage.getItem(LS.rt) };
})();
