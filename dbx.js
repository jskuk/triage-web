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
    const key = prompt('Dropbox App key (from your app console):', localStorage.getItem('dbx-app-key') || APP_KEY);
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
    if (!rt) { throw new Error('not connected'); }   // banner is the entry point; no auto-popup (mobile blocks it)
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

  // normalize_url mirror (records.normalize_url): lowercase host, strip www.,
  // drop utm_*/tracking params + fragment + trailing slash. Dedupe key.
  const _TRACK = ['fbclid', 'gclid', 'gclsrc', 'dclid', 'ref', 'ref_src', 'msclkid'];
  function normalizeUrl(u) {
    u = (u || '').trim(); if (!u) return '';
    try {
      const url = new URL(u);
      let host = url.hostname.toLowerCase(); if (host.startsWith('www.')) host = host.slice(4);
      const port = url.port ? ':' + url.port : '';
      const p = new URLSearchParams(url.search);
      [...p.keys()].forEach(k => { const lk = k.toLowerCase(); if (lk.startsWith('utm_') || _TRACK.includes(lk)) p.delete(k); });
      let path = url.pathname; if (path.endsWith('/') && path !== '/') path = path.replace(/\/+$/, ''); if (path === '/') path = '';
      const qs = p.toString();
      return `${url.protocol}//${host}${port}${path}${qs ? '?' + qs : ''}`;
    } catch { return u.toLowerCase(); }
  }
  function sourceDomain(u) {
    if (!u) return null;
    try { let h = new URL(u).hostname.toLowerCase(); if (h.startsWith('www.')) h = h.slice(4); return h || null; } catch { return null; }
  }
  // make_readlater mirror (records.make_readlater).
  function makeReadlater(body) {
    const url = (body.url || '').trim() || null;
    let src = (body.source || '').trim().toLowerCase();
    if (!['sweep', 'capture', 'extension', 'dashboard'].includes(src)) src = 'dashboard';
    const topics = Array.isArray(body.topics) ? body.topics.slice(0, 4).map(t => String(t).trim()).filter(Boolean) : [];
    const est = Number.isInteger(body.est_minutes) && body.est_minutes > 0 ? body.est_minutes : null;
    return {
      id: genId(), url, url_norm: normalizeUrl(url), title: (body.title || '').trim() || null,
      source_domain: sourceDomain(url), added: nowIso(), est_minutes: est,
      summary: (body.summary || '').trim() || null, key_point: (body.key_point || '').trim() || null,
      topics, project_link: (body.project_link || '').trim() || null, status: 'unread', read_date: null,
      my_take: (body.note || body.my_take || '').trim() || null, fetch_failed: false, enrich_attempts: 0,
      source: src, capture_src: (body.capture_src || '').trim() || null,
    };
  }

  function heuristicDomain(text) {
    const t = (text || '').toLowerCase();
    const work = /referee|review|r&r|revise|paper|grant|nsf|student|syllabus|dept|letter|journal|conference|editor|\.edu|논문|학회|강의|학생/;
    const life = /daycare|pediatric|grocery|house|car|insurance|birthday|diaper|baby|kid|family|dinner|recipe|어린이집|병원|아기|가족/;
    return work.test(t) && !life.test(t) ? 'work' : (life.test(t) ? 'life' : 'life');
  }

  // ── deadline heuristics: minimal JS mirror of aihelper (browser can't run the
  //    Python heuristic parser). config.DEADLINE_LEAD_DEFAULTS + _deadline_type.
  const DEADLINE_LEAD_DEFAULTS = { referee: 14, recletter: 7, rnr: 42, grant: 30, conference: 21, teaching: 7, other: 14 };
  const _DL_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const _DL_TYPES = [
    [['referee', 'review report', 'report for', 'reviewer report'], 'referee'],
    [['recommendation', 'rec letter', 'reference letter', 'letter for', '추천서'], 'recletter'],
    [['r&r', 'revise and resubmit', 'revise & resubmit', 'resubmit', 'revision'], 'rnr'],
    [['grant', 'nsf', 'nih', 'proposal'], 'grant'],
    [['conference', 'cfp', 'call for papers', 'abstract', 'submission'], 'conference'],
    [['syllabus', 'teaching', 'class', 'lecture', 'grade', 'exam'], 'teaching'],
  ];
  function deadlineType(text) {
    const t = (text || '').toLowerCase();
    for (const [keys, name] of _DL_TYPES) if (keys.some(k => t.includes(k))) return name;
    return 'other';
  }
  // Minimal date sniff (mirror aihelper.heuristic_parse_date, simplified): ISO
  // yyyy-mm-dd, month-name + day (English), day + month, M/D[/Y], and "tomorrow".
  // No-year dates roll forward past today (mirror _roll). Returns {due, match} or null.
  function sniffDeadlineDate(text) {
    const t = (text || '').toLowerCase();
    const pad = n => String(n).padStart(2, '0');
    const fmt = (y, mo, d) => `${y}-${pad(mo)}-${pad(d)}`;
    const valid = (y, mo, d) => { const dt = new Date(y, mo - 1, d); return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d; };
    const now = new Date();
    const today = fmt(now.getFullYear(), now.getMonth() + 1, now.getDate());   // local ISO for lexical compare
    const roll = (mo, d) => {
      const y = now.getFullYear();
      if (!valid(y, mo, d)) return null;
      let s = fmt(y, mo, d);
      if (s < today) { if (!valid(y + 1, mo, d)) return null; s = fmt(y + 1, mo, d); }
      return s;
    };
    let m;
    m = t.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
    if (m) { return valid(+m[1], +m[2], +m[3]) ? { due: fmt(+m[1], +m[2], +m[3]), match: m[0] } : null; }
    m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (m) { const s = roll(_DL_MONTHS[m[1]], +m[2]); return s ? { due: s, match: m[0] } : null; }
    m = t.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
    if (m) { const s = roll(_DL_MONTHS[m[2]], +m[1]); return s ? { due: s, match: m[0] } : null; }
    m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (m) {
      const mo = +m[1], d = +m[2];
      if (m[3]) { let y = +m[3]; if (y < 100) y += 2000; return valid(y, mo, d) ? { due: fmt(y, mo, d), match: m[0] } : null; }
      const s = roll(mo, d); return s ? { due: s, match: m[0] } : null;
    }
    if (/\btomorrow\b/.test(t) || text.includes('내일')) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      return { due: fmt(d.getFullYear(), d.getMonth() + 1, d.getDate()), match: /\btomorrow\b/.test(t) ? 'tomorrow' : '내일' };
    }
    return null;
  }
  // Title from a freeform note: drop the matched date + a dangling connector.
  function deadlineTitleFromNote(note, match) {
    let s = note || '';
    if (match) s = s.replace(new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
    s = s.replace(/\s+/g, ' ').trim().replace(/[\s,]*\b(due|by|on|before)\b\s*$/i, '').trim();
    return (s || note || '').slice(0, 80).trim();
  }

  // JS port of records.project_movement — keep the math identical to Python.
  const STALL_DEFAULT = 21;
  function projectMovement(p) {
    const ref = p.last_movement || p.created;
    let daysSince = null;
    if (ref) { const dt = new Date(ref); if (!isNaN(dt)) daysSince = Math.floor((Date.now() - dt) / 86400000); }
    if (p.status !== 'active') return { daysSince, stalled: false };
    const limit = Number.isInteger(p.stall_days) ? p.stall_days : STALL_DEFAULT;
    return { daysSince, stalled: daysSince != null && daysSince > limit };
  }

  // ── route table ─────────────────────────────────────────────────
  const DISABLED = ['/api/presort', '/api/backfill-domains', '/api/recipes/promote-full',
    '/api/recipes/purge-excluded', '/api/recipes/plan', '/api/import',
    '/api/session-log', '/api/email/outbox-mark',
    '/api/sweep/analyze', '/api/insights/replace'];   // AI-in-request; only the Mac runs analyze (sessions + outbox marks are Mac-agent-only too)

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
    if (path === '/api/projects') {
      const ps = await readJson('projects.json', []);
      return resp({ projects: ps.map(p => { const m = projectMovement(p); return { ...p, days_since_movement: m.daysSince, stalled: m.stalled }; }) });
    }
    if (path === '/api/sparks') return resp(await readJson('sparks.json', []));
    if (path === '/api/recipes') return resp(await readJson('recipes/recipes.json', []));
    if (path === '/api/logs') return resp(await readJson('journal.json', []));
    if (path === '/api/garden' || path === '/api/vault') return resp(await readJson('vault.json', []));
    if (path === '/api/travel') { const t = await readJson('travel.flag', null); return resp(t ? { on: true, since: t.since, note: t.note } : { on: false }); }
    if (path === '/api/brief') { const md = await download('brief.md'); const fresh = md != null; return resp({ markdown: md, generated: null, fresh }); }
    // Sweep Insights (v6): read-only join here — the browser prunes <2-live-tab
    // proposals for display but does NOT write the pruned state back (the Mac /
    // cloud sweep run owns insights-state.json; a phone read must not race it).
    if (path === '/api/insights') {
      const state = await readJson('insights-state.json', {});
      const items = await readJson('data.json', []);
      const live = {}; items.forEach(i => { if (i.list === 'tabs' && i.id) live[i.id] = i; });
      const out = [];
      for (const p of (state.pending || [])) {
        const liveIds = (p.tab_ids || []).filter(t => live[t]);
        if (liveIds.length < 2) continue;
        out.push({ ...p, tab_ids_live: liveIds, tabs: liveIds.map(t => live[t]) });
      }
      return resp({ pending: out, last_run: state.last_run || null });
    }
    // Read Later (v6): default unread+read; ?status=all includes archived.
    if (path === '/api/readlater' || path.startsWith('/api/readlater?')) {
      const status = new URLSearchParams(path.split('?')[1] || '').get('status');
      const recs = await readJson('readlater.json', []);
      let out;
      if (status === 'all') out = recs.slice();
      else if (['unread', 'read', 'archived'].includes(status)) out = recs.filter(r => r.status === status);
      else out = recs.filter(r => r.status === 'unread' || r.status === 'read');
      out.sort((a, b) => new Date(b.added) - new Date(a.added));
      return resp(out);
    }
    if (path.startsWith('/api/health')) return resp(await computeHealth(new URLSearchParams(path.split('?')[1] || '').get('domain')));
    if (path === '/api/weekly-summary') return resp(await computeWeekly());
    if (path.startsWith('/api/email/outbox') && !path.startsWith('/api/email/outbox-mark')) {
      const status = new URLSearchParams(path.split('?')[1] || '').get('status');
      let items = await readJson('draft-outbox.json', []);
      if (status) items = items.filter(e => e.status === status);
      return resp({ items });
    }

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
    if (path === '/api/done') {
      let pid = null;
      await updateJson('data.json', a => { const it = a.find(i => i.id === body.id); if (it) { it.list = 'done'; it.completed = nowIso(); pid = it.project_id || null; } return a; }, []);
      // Finishing a task IS project movement. Second CAS write; failures ignored
      // (A4: non-atomic across two files → benign staleness only). Capture the
      // project title so the toast can confirm the chained effect.
      let projectMoved = null;
      if (pid) { try { await updateJson('projects.json', a => { const p = a.find(x => x.id === pid); if (p) { p.last_movement = nowIso(); projectMoved = p.title || null; } return a; }, []); } catch {} }
      // Complete any linked deadline via CAS so the toast fires hosted too.
      // NOTE: the browser cannot delete the Google event, so gcal_event_id is
      // left intact. The Mac/cloud check will not re-complete an already-done
      // deadline, but the ⏰ event cleanup only happens when Done is hit on the
      // local server. Acceptable per plan.
      let deadlineDone = null;
      try { await updateJson('deadlines.json', a => { const d = a.find(x => x.linked_task_id === body.id && (x.status === 'open' || x.status === 'upcoming')); if (d) { d.status = 'done'; deadlineDone = d.title || null; } return a; }, []); } catch {}
      return resp({ ok: true, deadline_done: deadlineDone, project_moved: projectMoved });
    }
    if (path === '/api/delete') { await updateJson('data.json', a => a.filter(i => i.id !== body.id), []); return resp({ ok: true }); }
    if (path === '/api/schedule') { await setField(i => { i.list = 'thisweek'; i.scheduled = body.day; }); return resp({ ok: true }); }
    if (path === '/api/update-nextstep') { await setField(i => i.nextStep = (body.nextStep || '').trim() || null); return resp({ ok: true }); }
    if (path === '/api/update-memo') { await setField(i => i.memo = (body.memo || '').trim() || null); return resp({ ok: true }); }
    if (path === '/api/promote') { await setField(i => { i.list = 'inbox'; if (!i.nextStep && i.memo) i.nextStep = i.memo; }); return resp({ ok: true }); }
    if (path === '/api/set-domain') { await setField(i => i.domain = body.domain); return resp({ ok: true }); }
    if (path === '/api/log') return resp(await updateJson('journal.json', a => { a.push({ id: genId(), text: body.text, timestamp: nowIso() }); return a; }, []), 201);

    // — deadlines —
    // Mirror server._handle_deadline_add: structured (title+due) → record;
    // freeform ({note}) → minimal JS date sniff → proposed record, else NEVER
    // lose it (inbox task fallback, the router's shape); empty → create nothing.
    if (path === '/api/deadlines/add') {
      const bTitle = (body.title || '').trim();
      const bDue = (body.due_date || '').trim();
      const note = (body.note || body.text || '').trim();
      if (!bTitle && !bDue && !note) return resp({ ok: false, error: 'empty' }, 400);

      // Resolve final title/due/type/proposed for either input shape.
      let title = bTitle, due = bDue, dtype = DEADLINE_LEAD_DEFAULTS[body.type] ? body.type : null, proposed = !!body.proposed, srcNote = null;
      if (!(bTitle && bDue)) {
        // Freeform (or partial) → try the JS heuristic on the note.
        const hit = note ? sniffDeadlineDate(note) : null;
        if (!hit) {
          // No date recoverable → never-lost inbox TASK (mirror the router).
          let task = null;
          await updateJson('data.json', a => {
            task = { id: genId(), text: '[deadline] ' + note, url: (body.url || '').trim() || null,
              nextStep: null, memo: null, list: 'inbox', created: nowIso(), domain: 'work', unsorted: true };
            a.push(task); return a;
          }, []);
          return resp({ ok: true, saved_to_inbox: true, task_id: task.id, message: 'no date found — saved to Inbox' }, 201);
        }
        due = hit.due;
        title = deadlineTitleFromNote(note, hit.match) || 'Untitled deadline';
        if (!dtype) dtype = deadlineType(note);
        proposed = true;              // ❓ confirm-on-dashboard: heuristic, not confirmed
        srcNote = note;
      }
      if (!dtype) dtype = 'other';
      if (!title) title = 'Untitled deadline';
      const lead = Number.isInteger(body.lead_time_days) ? body.lead_time_days : DEADLINE_LEAD_DEFAULTS[dtype];
      let domain = (body.domain || '').trim().toLowerCase();
      if (!['work', 'life'].includes(domain)) domain = dtype !== 'other' ? 'work' : heuristicDomain(srcNote || title);
      const srcId = (body.source_id || '').trim() || null;
      const notes = (body.notes || '').trim() || srcNote || null;
      let outRec = null;
      await updateJson('deadlines.json', a => {
        // Idempotent: dedupe by source_id or (title,due) — mirror the server.
        const ex = a.find(d => (srcId && d.source_id === srcId) ||
          ((d.title || '').toLowerCase() === title.toLowerCase() && d.due_date === due));
        if (ex) { outRec = ex; return a; }
        outRec = { id: genId(), title, type: dtype, due_date: due, lead_time_days: lead,
          domain, status: 'upcoming', notes, linked_task_id: null, runway_opened: null,
          proposed, source: body.source || 'dashboard', source_id: srcId, created: nowIso() };
        a.push(outRec); return a;
      }, []);
      return resp(outRec, 201);
    }
    if (path === '/api/deadlines/update') { await updateJson('deadlines.json', a => { const d = a.find(x => x.id === body.id); if (d) Object.assign(d, body.fields || {}); return a; }, []); return resp({ ok: true }); }
    if (path === '/api/deadlines/confirm') { await updateJson('deadlines.json', a => { const d = a.find(x => x.id === body.id); if (d) d.proposed = false; return a; }, []); return resp({ ok: true }); }
    if (path === '/api/deadlines/delete') { await updateJson('deadlines.json', a => a.filter(x => x.id !== body.id), []); return resp({ ok: true }); }
    if (path === '/api/deadlines/check') return resp({ opened: [] });   // cloud brain runs the real engine

    // — projects (v5) —
    if (path === '/api/projects/add') {
      let out = null;
      await updateJson('projects.json', a => {
        const t = (body.title || '').trim();
        const src = (body.source_id || '').trim() || null;
        out = (src && a.find(p => p.source_id === src)) || a.find(p => (p.title || '').trim().toLowerCase() === t.toLowerCase());
        if (out) return a;
        out = { id: genId(), title: t, domain: ['work', 'life'].includes(body.domain) ? body.domain : null,
          status: ['active', 'paused', 'done'].includes(body.status) ? body.status : 'active',
          goal: body.goal || null, state_note: null, state_updated: null, last_movement: nowIso(),
          stall_days: Number.isInteger(body.stall_days) ? body.stall_days : null, target: body.target || null,
          notes: body.notes || null, keywords: Array.isArray(body.keywords) ? body.keywords : [],
          created: nowIso(), source_id: src };
        a.push(out); return a;
      }, []);
      return resp(out, 201);
    }
    if (path === '/api/projects/update') {
      const allowed = ['title', 'domain', 'status', 'goal', 'target', 'notes', 'stall_days', 'keywords', 'state_note'];
      await updateJson('projects.json', a => { const p = a.find(x => x.id === body.id); if (p && body.fields) {
        for (const k of Object.keys(body.fields)) { if (!allowed.includes(k)) continue; p[k] = body.fields[k];
          if (k === 'state_note' && (body.fields[k] || '').toString().trim()) { p.state_updated = nowIso(); p.last_movement = nowIso(); } } }
        return a; }, []);
      return resp({ ok: true });
    }
    if (path === '/api/projects/delete') { await updateJson('projects.json', a => a.filter(x => x.id !== body.id), []); return resp({ ok: true }); }
    if (path === '/api/projects/state') {
      let found = null;
      await updateJson('projects.json', a => {
        const low = (body.name || '').trim().toLowerCase();
        found = (body.id && a.find(p => p.id === body.id))
          || (low && (a.find(p => (p.title || '').trim().toLowerCase() === low)
            || a.find(p => (p.title || '').toLowerCase().includes(low))
            || a.find(p => (p.keywords || []).some(k => (k || '').toLowerCase().includes(low)))));
        if (found) { found.state_note = (body.note || '').trim() || null; found.state_updated = nowIso(); found.last_movement = nowIso(); }
        return a;
      }, []);
      if (!found) return resp({ error: 'project not resolved' }, 404);
      return resp({ ok: true, project_id: found.id, title: found.title });
    }
    if (path === '/api/set-project') {
      await updateJson('data.json', a => { const it = a.find(i => i.id === body.id); if (it) it.project_id = body.project_id || null; return a; }, []);
      if (body.project_id) await updateJson('projects.json', a => { const p = a.find(x => x.id === body.project_id); if (p) p.last_movement = nowIso(); return a; }, []);
      return resp({ ok: true });
    }
    if (path === '/api/skip') {
      // A6: increment deferrals only if last skip is absent or > 20h old; always re-stamp.
      let deferrals = 0, found = false;
      await updateJson('data.json', a => {
        const it = a.find(i => i.id === body.id);
        if (it) {
          found = true;
          const last = it.last_skipped ? new Date(it.last_skipped).getTime() : null;
          if (last == null || isNaN(last) || (Date.now() - last) > 20 * 3600000) it.deferrals = (it.deferrals || 0) + 1;
          it.last_skipped = nowIso();
          deferrals = it.deferrals || 0;
        }
        return a;
      }, []);
      if (!found) return resp({ error: 'not found' }, 404);
      return resp({ ok: true, deferrals });
    }

    // — Sweep Insights accept / dismiss (H4: fixed CAS order data → state → project) —
    if (path === '/api/insights/accept') {
      const fp = (body.fingerprint || '').trim();
      if (!fp) return resp({ error: 'fingerprint required' }, 400);
      const state = await readJson('insights-state.json', {});
      const prop = (state.pending || []).find(p => p.fingerprint === fp);
      if (!prop) return resp({ ok: false, reason: 'proposal not found' }, 404);
      // Determine live survivors from the current data.json first.
      const dataNow = await readJson('data.json', []);
      const liveIds = new Set(dataNow.filter(i => i.list === 'tabs' && i.id).map(i => i.id));
      const survivors = (prop.tab_ids || []).filter(t => liveIds.has(t));
      if (!survivors.length) {
        // Honest failure + drop the empty proposal from state.
        await updateJson('insights-state.json', s => { s.pending = (s.pending || []).filter(p => p.fingerprint !== fp); return s; }, {});
        return resp({ ok: false, reason: 'tabs already triaged' });
      }
      const kind = prop.kind;
      const targetList = kind === 'park' ? 'someday' : (kind === 'waiting' ? 'waiting' : 'inbox');
      const taskText = (body.task_text || '').trim() || (prop.task_text || '').trim() || prop.theme || 'Tab cluster';
      const pid = prop.project_id || null;
      let taskId = null;
      // (1) data.json — build the task with research_trail, delete the attached tabs.
      await updateJson('data.json', a => {
        const trail = a.filter(i => i.list === 'tabs' && survivors.includes(i.id))
          .map(t => ({ text: t.text, url: t.url, memo: t.memo, created: t.created }));
        const dv = ['work', 'life'].includes(body.domain) ? body.domain : heuristicDomain(taskText);
        const task = { id: genId(), text: taskText, url: null, nextStep: null, memo: null,
          list: targetList, created: nowIso(), domain: dv, research_trail: trail };
        if (targetList === 'waiting') task.waitingSince = nowIso();
        if (pid) task.project_id = pid;
        taskId = task.id;
        const keep = a.filter(i => !(i.list === 'tabs' && survivors.includes(i.id)));
        keep.push(task);
        return keep;
      }, []);
      // (2) insights-state — record accepted fp + drop the proposal.
      await updateJson('insights-state.json', s => {
        s.accepted = s.accepted || {};
        s.accepted[fp] = { task_id: taskId, ts: nowIso() };
        s.pending = (s.pending || []).filter(p => p.fingerprint !== fp);
        return s;
      }, {});
      // (3) project bump (benign staleness if it fails — A4).
      let projectTitle = null;
      if (pid) { try { await updateJson('projects.json', a => { const p = a.find(x => x.id === pid); if (p) { p.last_movement = nowIso(); projectTitle = p.title || null; } return a; }, []); } catch {} }
      return resp({ ok: true, task_id: taskId, tabs_attached: survivors.length, list: targetList, project: projectTitle });
    }
    if (path === '/api/insights/dismiss') {
      const fp = (body.fingerprint || '').trim();
      if (!fp) return resp({ error: 'fingerprint required' }, 400);
      await updateJson('insights-state.json', s => {
        const prop = (s.pending || []).find(p => p.fingerprint === fp);
        const tabIds = (prop && prop.tab_ids) || (s.dismissed && s.dismissed[fp] && s.dismissed[fp].tab_ids) || [];
        s.dismissed = s.dismissed || {};
        s.dismissed[fp] = { tab_ids: tabIds, ts: nowIso() };
        s.pending = (s.pending || []).filter(p => p.fingerprint !== fp);
        return s;
      }, {});
      return resp({ ok: true });
    }

    // — Read Later (v6): add (two-file CAS for from_tab_id), mark-read, archive,
    //   promote-spark (writes sparks.json directly — no /api/sparks route here).
    if (path === '/api/readlater/enrich') return resp({ ok: true });   // lazy enrichment is Mac-only
    if (path === '/api/readlater/add') {
      const b = { ...body };
      const fromTab = (body.from_tab_id || '').trim() || null;
      let tab = null;
      if (fromTab) {
        const data = await readJson('data.json', []);
        tab = data.find(i => i.id === fromTab && i.list === 'tabs') || null;
        if (tab) {
          if (!(b.url || '').trim()) b.url = tab.url;
          if (!(b.title || '').trim()) b.title = tab.text;
          if (!(b.note || '').trim() && !(b.my_take || '').trim()) b.note = tab.memo;
          if (!(b.source || '').trim()) b.source = 'sweep';
        }
      }
      if (!(b.url || '').trim()) return resp({ error: 'url required' }, 400);
      let result = null;
      // (1) readlater.json — dedupe/resurrect/create.
      await updateJson('readlater.json', recs => {
        const unorm = normalizeUrl(b.url);
        const csrc = (b.capture_src || '').trim() || null;
        const ex = recs.find(r => (csrc && r.capture_src === csrc) || (unorm && r.url_norm === unorm));
        if (ex) {
          if (ex.status === 'archived') { ex.status = 'unread'; ex.added = nowIso(); ex.read_date = null; result = { renewed: true, id: ex.id, record: ex }; }
          else result = { existing: true, id: ex.id, record: ex };
        } else { const rec = makeReadlater(b); recs.push(rec); result = { _new: rec }; }
        return recs;
      }, []);
      // (2) data.json — delete the routed tab.
      if (tab) await updateJson('data.json', a => a.filter(i => i.id !== fromTab), []);
      if (result && result._new) return resp(result._new, 201);
      return resp(result || {});
    }
    if (path === '/api/readlater/mark-read') {
      let canSpark = false;
      await updateJson('readlater.json', recs => {
        const r = recs.find(x => x.id === body.id);
        if (r) { r.status = 'read'; r.read_date = nowIso(); const mt = (body.my_take || '').trim(); if (mt) r.my_take = mt; canSpark = !!r.my_take; }
        return recs;
      }, []);
      return resp({ ok: true, can_spark: canSpark });
    }
    if (path === '/api/readlater/archive') {
      await updateJson('readlater.json', recs => { const r = recs.find(x => x.id === body.id); if (r) r.status = 'archived'; return recs; }, []);
      return resp({ ok: true });
    }
    if (path === '/api/readlater/promote-spark') {
      const recs = await readJson('readlater.json', []);
      const rec = recs.find(r => r.id === body.id);
      if (!rec) return resp({ error: 'not found' }, 404);
      const mt = (rec.my_take || '').trim();
      if (!mt) return resp({ ok: false, reason: 'my_take required' }, 400);
      const spark = { id: genId(), url: rec.url || null, reaction: mt, created: nowIso() };
      await updateJson('sparks.json', a => { a.push(spark); return a; }, []);
      await updateJson('readlater.json', a => { const r = a.find(x => x.id === body.id); if (r) r.status = 'archived'; return a; }, []);
      return resp({ ok: true, spark });
    }

    // — draft outbox (A2: CAS append; only the Mac agent marks entries) —
    if (path === '/api/email/stage-draft') {
      const draftText = (body.draft_text || '').trim();
      const threadKey = (body.thread_key || '').trim() || null;
      const messageId = (body.message_id || '').trim() || null;
      if (!draftText) return resp({ error: 'draft_text is required' }, 400);
      if (!threadKey && !messageId) return resp({ error: 'thread_key or message_id is required' }, 400);
      const id = 'do_' + genId();
      await updateJson('draft-outbox.json', a => {
        a.push({ id, thread_key: threadKey, message_id: messageId, draft_text: draftText,
          note: (body.note || '').trim() || null, created: nowIso(), created_by: 'ea',
          status: 'pending', attempts: 0, pushed_at: null, pushed_host: null });
        return a;
      }, []);
      return resp({ ok: true, id });
    }

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
    const projects = await readJson('projects.json', []);
    const stalled = projects.filter(p => projectMovement(p).stalled).length;
    // ea_topics — JS port of the Python formula (server._compute_health /
    // brief._ea_topics_count): drafts pending review + stalled active projects +
    // repeat-deferral tasks. email-state read is read-only; missing → 0.
    let draftsPending = 0;
    try {
      const es = await readJson('email-state.json', {});
      const threads = (es && typeof es === 'object' && es.threads) ? es.threads : {};
      draftsPending = items.filter(i => i.list === 'inbox' && i.source === 'email'
        && threads[i.emailThread] && threads[i.emailThread].draft_written === true).length;
    } catch (e) { draftsPending = 0; }
    const repeatDeferral = items.filter(i => i.list !== 'done' && (i.deferrals || 0) >= 3).length;
    const ea_topics = draftsPending + stalled + repeatDeferral;
    // v7 Stage 2: self-monitoring, mirroring server._compute_health.
    // agents/overdue — freshest per-host heartbeat age (minutes) per agent with a
    // locks/hb-<agent>-*.json; an agent with no heartbeat is absent (never-enabled
    // ≠ broken). Travel exempts email from overdue.
    const AGENT_MAX = { router: 30, email: 30, brief: 26 * 60, insights: 26 * 60, recipes: 30 };
    const agents = {}, overdue = [];
    try {
      const freshest = {};
      const hb = (await listDir('locks')).filter(n => n.startsWith('hb-') && n.endsWith('.json'));
      for (const name of hb) {
        const agent = name.slice(3, -5).split('-')[0];              // hb-<agent>-<host>.json
        const info = await readJson('locks/' + name, null);
        if (!info || !info.ts) continue;
        const age = (now - new Date(info.ts)) / 60000;
        if (isNaN(age)) continue;
        if (!(agent in freshest) || age < freshest[agent]) freshest[agent] = age;
      }
      for (const [agent, age] of Object.entries(freshest)) {
        agents[agent] = Math.round(age);
        const thr = AGENT_MAX[agent];
        if (thr == null || (agent === 'email' && travel)) continue;
        if (age > thr) overdue.push(agent);
      }
      overdue.sort();
    } catch (e) { /* self-monitor is best-effort; never breaks health */ }
    // conflicts — hosted checks the TOP LEVEL ONLY (a recursive Dropbox listing is
    // too chatty for a phone); the Mac-side server does the deep recursive scan.
    let conflicts = [];
    try {
      conflicts = (await listDir('')).filter(n => n.toLowerCase().includes('conflicted copy')).sort();
    } catch (e) { conflicts = []; }
    return {
      inbox: inbox.length, stale,
      unsorted: items.filter(i => i.unsorted && i.list !== 'done' && inDom(i)).length,
      unclassified: items.filter(i => ['inbox','thisweek','someday','waiting'].includes(i.list) && !['work','life'].includes(i.domain)).length,
      waiting_overdue: items.filter(i => i.list === 'waiting' && inDom(i) && (now - new Date(i.waitingSince || i.created)) / day >= 7).length,
      recipe_queue: 0, sparks_week: 0, stalled, ea_topics, catchup_threshold: 25, travel,
      agents, overdue, conflicts,
    };
  }
  async function computeWeekly() {
    const items = await readJson('data.json', []); const cut = Date.now() - 7 * 86400000;
    return { done: items.filter(i => i.list === 'done' && i.completed && new Date(i.completed) >= cut).length, recipes_cooked: 0, sparks: 0 };
  }

  // ready resolves once the OAuth redirect (?code=) has been exchanged for a token,
  // so the connect-gate banner can re-check connected() after that async completes.
  const ready = handleRedirect().catch(() => {});
  window.DBX = { handle, connect, connected: () => !!localStorage.getItem(LS.rt), ready };
})();
