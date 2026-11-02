/* EyeStudio Equipment Tracker, phone app. Data lives in the Google Sheet behind the Apps Script API. */
(function () {
  'use strict';

  var CFG = window.ET_CONFIG || {};
  var API = CFG.apiUrl || '';
  var CAT_ORDER = ['Camera', 'Lens', 'Light', 'Stand / Tripod', 'Bag', 'Gimbal', 'Drone', 'Mic', 'Battery', 'Charger',
    'Memory Card', 'Lens Filter', 'Cable', 'Miscellaneous', 'New Equipment (2026)'];
  var CAT_PLURAL = { 'Camera': 'Cameras', 'Lens': 'Lenses', 'Light': 'Lights', 'Stand / Tripod': 'Stands and tripods', 'Bag': 'Bags',
    'Gimbal': 'Gimbals', 'Drone': 'Drones', 'Mic': 'Mics', 'Battery': 'Batteries', 'Charger': 'Chargers', 'Memory Card': 'Memory cards',
    'Lens Filter': 'Lens filters', 'Cable': 'Cables', 'Miscellaneous': 'Other', 'New Equipment (2026)': 'New equipment' };

  /* ------------------------------------------------------------ storage */
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('et.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('et.' + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
    del: function (k) { try { localStorage.removeItem('et.' + k); } catch (e) { } }
  };

  /* ------------------------------------------------------------ state */
  var S = {
    token: store.get('token', ''),
    me: store.get('me', null),
    server: store.get('server', null),   // last state from the API
    model: null,                          // server + pending changes
    queue: store.get('queue', []),
    online: true,
    syncing: false,
    view: 'home', tab: 'home', sid: null,
    stack: [],
    sheet: null,
    signin: (function () { var p = store.get('signinStep', null); var fresh = p && Date.now() - p.at < 10 * 60e3; return { email: fresh ? p.email : store.get('lastEmail', ''), step: fresh ? 'code' : 'email', busy: false, err: '' }; })(),
    form: null,
    filters: { items: 'all', q: '', history: 'all' },
    zoom: 1, torch: false,
    packTab: 'scanned', checkTab: 'missing',
    lastScanAt: Date.now()
  };

  /* ------------------------------------------------------------ helpers */
  function esc(x) { return String(x === undefined || x === null ? '' : x).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function norm(x) { return String(x || '').trim().toUpperCase(); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function first(name) { return String(name || '').split(' ')[0]; }
  function nameOf(email) {
    var p = (S.model && S.model.people || []).filter(function (x) { return x.email === String(email || '').toLowerCase(); })[0];
    return p ? p.name : String(email || '').split('@')[0];
  }
  function isMe(email) { return S.me && String(email).toLowerCase() === S.me.email; }
  function whoShort(email) { return isMe(email) ? 'you' : first(nameOf(email)); }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function fmtTime(iso) { if (!iso) return ''; return new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' }); }
  function ago(iso) {
    if (!iso) return '';
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return fmtDate(iso);
  }
  function daysSince(iso) { return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 864e5)); }
  function todayIso() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  var IC = {
    scan: '<path d="M3 8V6a3 3 0 0 1 3-3h2"/><path d="M16 3h2a3 3 0 0 1 3 3v2"/><path d="M21 16v2a3 3 0 0 1-3 3h-2"/><path d="M8 21H6a3 3 0 0 1-3-3v-2"/><path d="M7 12h10"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', back: '<path d="M15 5l-7 7 7 7"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
    more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
    flash: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>', check: '<path d="M5 12.5l4.5 4.5L19 7"/>', chev: '<path d="M9 6l6 6-6 6"/>',
    sessions: '<rect x="3" y="4.5" width="18" height="16" rx="4"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
    out: '<path d="M4 12h14"/><path d="M13 6l6 6-6 6"/>', ret: '<path d="M20 12H6"/><path d="M11 6l-6 6 6 6"/>',
    items: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    edit: '<path d="M4 7h10M4 12h10M4 17h6M18 14v6M15 17h6"/>', warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>',
    cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z"/><path d="M12 11v5M9.5 13.5L12 16l2.5-2.5"/>',
    camoff: '<path d="M3 3l18 18"/><path d="M9 5h6l2 2h3v11M4 7v12h13"/><circle cx="12" cy="13" r="3"/>',
    photo: '<rect x="3" y="6" width="18" height="14" rx="3"/><circle cx="12" cy="13" r="3.5"/><path d="M9 6l1.5-2h3L15 6"/>',
    trash: '<path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/>', doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>'
  };
  function ic(name, size, sw) {
    return '<svg width="' + (size || 22) + '" height="' + (size || 22) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 2) +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + IC[name] + '</svg>';
  }
  function chip(t, k) { return '<span class="chip ' + k + '">' + esc(t) + '</span>'; }

  /* ------------------------------------------------------------ feedback */
  var audio = null;
  function unlockAudio() {
    if (audio) return;
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
  }
  document.addEventListener('pointerdown', function () { unlockAudio(); if (audio && audio.state === 'suspended') { try { audio.resume(); } catch (e) { } } });
  function tone(freq, dur, when) {
    if (!audio) return;
    try {
      var o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      var t = audio.currentTime + (when || 0);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { }
  }
  // iPhone Safari has no vibrate(); tapping a hidden switch control gives a system haptic (iOS 18+). Needs a real tap.
  var hapticEl = null;
  function haptic() {
    if (navigator.vibrate) { vib(30); return; }
    try {
      if (!hapticEl) {
        hapticEl = document.createElement('label');
        hapticEl.setAttribute('aria-hidden', 'true');
        hapticEl.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
        var inp = document.createElement('input'); inp.type = 'checkbox'; inp.setAttribute('switch', ''); inp.tabIndex = -1;
        hapticEl.appendChild(inp); document.body.appendChild(hapticEl);
      }
      hapticEl.click();
    } catch (e) { }
  }
  function feedback(kind) {
    if (audio && audio.state === 'suspended') { try { audio.resume(); } catch (e) { } }
    if (kind === 'detect') { tone(1046, 0.07); tone(1568, 0.09, 0.08); vib(45); }
    else if (kind === 'good') { tone(1320, 0.06); }
    else if (kind === 'warn') { tone(660, 0.1); tone(660, 0.1, 0.16); vib([40, 60, 40]); }
    else if (kind === 'bad') { tone(260, 0.25); vib([90, 50, 90]); }
  }
  function vib(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { } }

  var toastTimer = null;
  function toast(t) {
    // t: {title, sub, kind: ok|grey|warn|red|sync, action:{label, fn, color}, ms}
    var wrap = $('#toast');
    var col = { ok: 'var(--green)', grey: 'rgba(235,235,245,.3)', warn: 'var(--pack)', red: 'var(--red)', sync: 'rgba(235,235,245,.3)' }[t.kind || 'ok'];
    var icon = { ok: 'check', grey: 'check', warn: 'warn', red: 'x', sync: 'cloud' }[t.kind || 'ok'];
    var fg = (t.kind === 'grey' || t.kind === 'sync') ? 'var(--text)' : 'var(--bg)';
    wrap.innerHTML = '<div class="toast glass" role="status"><span class="ic" style="background:' + col + ';color:' + fg + '">' + ic(icon, 16, 2.8) + '</span>' +
      '<div class="tx"><b>' + esc(t.title) + '</b>' + (t.sub ? '<span>' + esc(t.sub) + '</span>' : '') + '</div>' +
      (t.action ? '<button class="act press" data-toast-act style="color:' + (t.action.color || 'var(--text)') + '">' + esc(t.action.label) + '</button>' : '') + '</div>';
    wrap.hidden = false;
    if (t.action) $('[data-toast-act]', wrap).onclick = function () { wrap.hidden = true; t.action.fn(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { wrap.hidden = true; }, t.ms || 3500);
  }
  function positionToast() {
    var wrap = $('#toast');
    var cam = $('.cam');
    if (cam && (S.view === 'pack' || S.view === 'check')) {
      var r = cam.getBoundingClientRect();
      wrap.style.top = Math.max(0, r.bottom - 92) + 'px'; wrap.style.bottom = 'auto';
    } else {
      wrap.style.top = 'auto'; wrap.style.bottom = 'calc(var(--sab) + 96px)';
    }
  }

  /* ------------------------------------------------------------ api + sync */
  function call(action, body) {
    if (!API) return Promise.reject(new Error('The app is not connected to the sheet yet.'));
    var payload = Object.assign({ action: action, token: S.token }, body || {});
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' })
      .then(function (r) { if (!r.ok) throw new Error('net'); return r.json(); })
      .then(function (j) {
        if (!j.ok && j.error === 'signin') { signOut(true); throw new Error('signin'); }
        return j;
      });
  }

  function saveQueue() { store.set('queue', S.queue); }

  function rebuildModel() {
    if (!S.server) { S.model = null; return; }
    S.model = clone(S.server);
    S.queue.forEach(function (op) { applyOp(S.model, op); });
  }

  function refresh() {
    if (!S.token || S.syncing) return Promise.resolve();
    return call('state').then(function (j) {
      S.online = true;
      S.server = j.state; store.set('server', S.server);
      S.me = j.state.me; store.set('me', S.me);
      rebuildModel(); softRender();
    }).catch(function (e) { if (e.message !== 'signin') { S.online = false; renderSyncBits(); } });
  }

  function enqueue(op) {
    op.cid = op.cid || uid();
    op.at = new Date().toISOString();
    op.by = S.me && S.me.email;
    S.queue.push(op); saveQueue();
    applyOp(S.model, op);
    flush();
  }

  var flushTimer = null;
  function flush() {
    if (S.syncing || !S.queue.length) return;
    S.syncing = true; renderSyncBits();
    var op = S.queue[0];
    call(op.type, op.body).then(function (j) {
      S.online = true;
      S.queue.shift(); saveQueue();
      S.syncing = false;
      handleResult(op, j);
      if (S.queue.length) flush(); else refresh();
      renderSyncBits();
    }).catch(function (e) {
      S.syncing = false;
      if (e.message === 'signin') return;
      S.online = false; renderSyncBits();
      clearTimeout(flushTimer); flushTimer = setTimeout(flush, 6000);
    });
  }

  function handleResult(op, j) {
    if (!j.ok) {
      toast({ title: 'Could not save that', sub: j.error || 'Try again.', kind: 'red', ms: 6000 });
      feedback('bad');
      return;
    }
    if (op.type === 'scan') {
      var r = j.result;
      // the server knows better than this phone: tell the person when it disagrees
      if (r === 'elsewhere' && j.other) {
        S.sheet = { type: 'elsewhere', code: j.item, label: j.label, other: j.other, sid: op.body.sessionId };
        feedback('warn');
        renderSheet();
      } else if (r === 'oos') { toast({ title: j.label + ' is out of service', sub: 'Not added. Ask Chamath if you need it', kind: 'warn' }); feedback('warn'); }
      else if (r === 'unknown') { toast({ title: 'Not an EyeStudio item', sub: 'This QR is not on the equipment list', kind: 'red' }); feedback('bad'); }
      else if (r === 'found') { toast({ title: j.label + ' found', sub: 'It was missing. Chamath gets a note' }); }
    }
    if (op.type === 'close' && j.reportUrl) {
      toast({ title: 'Report sent to Chamath', sub: 'Saved in History', kind: 'ok' });
    }
  }

  window.addEventListener('online', function () { S.online = true; flush(); refresh(); });

  /* ------------------------------------------------------------ local model logic (mirrors the server) */
  function sess(m, id) { return (m.sessions || []).filter(function (s) { return s.id === id; })[0]; }
  function item(m, code) { return (m.items || []).filter(function (i) { return i.id === code; })[0]; }

  function applyOp(m, op) {
    if (!m) return;
    var b = op.body || {}, s = b.sessionId ? sess(m, b.sessionId) : null, it = b.itemId ? item(m, norm(b.itemId)) : null;
    switch (op.type) {
      case 'createSession':
        if (sess(m, b.id)) break;
        m.sessions.unshift({ id: b.id, name: b.name, shootDate: b.shootDate, basedOn: b.basedOn || '', packedBy: op.by, team: b.team || [op.by],
          phase: 'Packing', created: op.at, packedAt: '', closedAt: '', packed: {}, back: {}, extra: {}, damaged: {}, overdue: false, due: '' });
        break;
      case 'scan':
        if (!s || !it) break;
        if (b.mode === 'pack') {
          if (b.move && it.session && it.session !== s.id) { var o = sess(m, it.session); if (o) o.back[it.id] = { by: op.by, at: op.at }; }
          s.packed[it.id] = { by: op.by, at: op.at }; it.status = 'Out'; it.session = s.id;
        } else {
          if (s.phase === 'Packing' || s.phase === 'Out') s.phase = 'Checking';
          if (it.status === 'Out' && it.session === s.id) s.back[it.id] = { by: op.by, at: op.at };
          else s.extra[it.id] = { by: op.by, at: op.at };
          it.status = 'In'; it.session = '';
        }
        s.typed = s.typed || {};
        if (b.typed) { s.typed[it.id] = { by: op.by, at: op.at, reason: b.reason, step: b.mode === 'pack' ? 'packing' : 'checking back' }; if (/sticker/i.test(b.reason || '')) it.reprint = true; }
        else it.reprint = false;
        if (s.team.indexOf(op.by) === -1) s.team.push(op.by);
        break;
      case 'clearReprint': (m.items || []).forEach(function (x) { if (!b.ids || !b.ids.length || b.ids.indexOf(x.id) > -1) x.reprint = false; }); break;
      case 'remove':
        if (!s || !it) break;
        delete s.packed[it.id]; if (it.session === s.id) { it.status = 'In'; it.session = ''; }
        break;
      case 'confirmPacking': if (s) { s.phase = 'Out'; s.packedAt = s.packedAt || op.at; } break;
      case 'startCheck': if (s && (s.phase === 'Out' || s.phase === 'Packing')) s.phase = 'Checking'; break;
      case 'damaged': if (s) s.damaged[norm(b.itemId)] = b.note || 'Damaged'; break;
      case 'close':
        if (!s) break;
        s.phase = 'Closed'; s.closedAt = op.at; s.closedBy = op.by;
        (m.items || []).forEach(function (x) { if (x.status === 'Out' && x.session === s.id) x.status = 'Missing'; });
        break;
      case 'deleteSession':
        if (!s) break;
        (m.items || []).forEach(function (x) { if (x.session === s.id) { x.status = 'In'; x.session = ''; } });
        m.sessions = m.sessions.filter(function (x) { return x.id !== s.id; });
        break;
      case 'snooze': if (s) s.overdue = false; break;
    }
  }

  function localScan(mode, s, code) {
    var it = item(S.model, code);
    if (!it) return { result: 'unknown' };
    var label = it.id + ' ' + it.name;
    if (mode === 'pack') {
      if (it.cond === 'Out of service') return { result: 'oos', label: label, item: it };
      if (it.status === 'Out' && it.session === s.id) return { result: 'already', label: label, item: it };
      if (it.status === 'Out' && it.session && it.session !== s.id) {
        var o = sess(S.model, it.session);
        return { result: 'elsewhere', label: label, item: it, other: o ? { id: o.id, name: o.name, by: nameOf(o.packedBy), since: o.packedAt || o.created } : { name: 'another shoot' } };
      }
      return { result: it.status === 'Missing' ? 'found' : 'added', label: label, item: it };
    }
    if (s.back[it.id] || s.extra[it.id]) return { result: 'already', label: label, item: it };
    if (it.status === 'Out' && it.session === s.id) return { result: 'back', label: label, item: it };
    var other = it.session && it.session !== s.id ? sess(S.model, it.session) : null;
    return { result: other ? 'extra_other' : 'extra', label: label, item: it, otherName: other ? other.name : '' };
  }

  function codeFromQr(raw) {
    var t = String(raw || '').trim();
    var m = t.match(/[?&](?:id|item)=([^&#]+)/i);
    if (m) t = decodeURIComponent(m[1]);
    return norm(t);
  }

  function onScan(raw) {
    var s = currentSession();
    if (!s || !S.model) return;
    var code = codeFromQr(raw);
    var mode = S.view === 'pack' ? 'pack' : 'check';
    var r = localScan(mode, s, code);
    S.lastScanAt = Date.now(); hideHint();
    switch (r.result) {
      case 'unknown': feedback('bad'); toast({ title: 'Not an EyeStudio item', sub: 'This QR is not on the equipment list', kind: 'red' }); return;
      case 'oos': feedback('warn'); toast({ title: r.item.id + ' is out of service', sub: 'Not added. Ask Chamath if you need it', kind: 'warn' }); return;
      case 'already':
        if (Cam.recent[code] && Date.now() - Cam.recent[code] < 15000) return;
        feedback('warn'); toast({ title: 'Already scanned', sub: r.label + ' is on this list', kind: 'grey', ms: 2000 }); return;
      case 'elsewhere':
        feedback('warn');
        S.sheet = { type: 'elsewhere', code: code, label: r.label, other: r.other, sid: s.id };
        renderSheet(); return;
    }
    // found a valid item: ask before adding, so nothing goes in by accident
    feedback('detect');
    flashFrame(); flashCam();
    S.sheet = { type: 'confirm', mode: mode, code: code, result: r.result, sid: s.id, otherName: r.otherName || '' };
    renderSheet();
  }

  function saveTyped() {
    var t = S.sheet, s = currentSession(); if (!t || !s) return;
    t.code = norm(($('#tid') || {}).value || t.code);
    var fail = function (msg) { t.err = msg; renderSheet(); feedback('bad'); };
    if (!t.code) return fail('Type the ID from the item or the list.');
    if (!t.reason) return fail('Pick a reason first.');
    var mode = S.view === 'pack' ? 'pack' : 'check';
    var r = localScan(mode, s, t.code);
    if (r.result === 'unknown') return fail('No item with the ID ' + t.code + '. Check the Items tab.');
    if (r.result === 'oos') return fail(t.code + ' is out of service.');
    if (r.result === 'already') return fail(t.code + ' is already on this list.');
    if (r.result === 'elsewhere') return fail(t.code + ' is out on ' + (r.other && r.other.name || 'another shoot') + '. Check it back there first.');
    haptic(); feedback('good');
    enqueue({ type: 'scan', body: { sessionId: s.id, itemId: t.code, mode: mode, clientId: uid(), typed: true, reason: t.reason } });
    S.sheet = null; renderSheet();
    toast({ title: t.code + ' typed in', sub: (r.item.name || '') + (/sticker/i.test(t.reason) ? ' \u00b7 on the reprint list' : ''), kind: 'warn', ms: 3000 });
    renderScanPanel();
  }

  function confirmScan(action) {
    var c = S.sheet; if (!c || c.type !== 'confirm') return;
    var s = sess(S.model, c.sid); if (!s) return;
    var it = item(S.model, c.code) || {};
    haptic(); feedback('good');
    S.sheet = null; renderSheet();
    Cam.seen[c.code] = Date.now(); Cam.recent[c.code] = Date.now();
    enqueue({ type: 'scan', body: { sessionId: s.id, itemId: c.code, mode: c.mode, clientId: uid() } });
    if (c.mode === 'pack') {
      toast({ title: c.code + ' added', sub: it.name, ms: 1800 });
    } else if (action === 'damaged') {
      openDamaged(s.id, c.code);
    } else if (c.result === 'back') {
      toast({ title: c.code + ' back in', sub: it.name, ms: 1800 });
    } else {
      toast({ title: c.code + ' marked as extra', sub: c.otherName ? 'From ' + c.otherName + '. Marked back there too' : 'Not packed for this shoot', kind: 'grey', ms: 3500 });
    }
    S.lastScanAt = Date.now();
    renderScanPanel();
  }

  /* ------------------------------------------------------------ session maths */
  function counts(s) {
    var packed = Object.keys(s.packed || {}), back = packed.filter(function (k) { return s.back[k]; });
    return { packed: packed.length, back: back.length, missing: packed.length - back.length, extra: Object.keys(s.extra || {}).length, damaged: Object.keys(s.damaged || {}).length };
  }
  function currentSession() { return S.model && S.sid ? sess(S.model, S.sid) : null; }
  function activeSessions() {
    return (S.model ? S.model.sessions : []).filter(function (s) { return s.phase !== 'Closed'; }).sort(function (a, b) {
      return (b.overdue - a.overdue) || ((b.created || '') > (a.created || '') ? 1 : -1);
    });
  }
  function catOf(code) { var it = item(S.model, code); return it ? it.cat : ''; }
  function catRank(c) { var i = CAT_ORDER.indexOf(c); return i === -1 ? 99 : i; }
  function sortCodes(codes) {
    return codes.slice().sort(function (a, b) {
      var d = catRank(catOf(a)) - catRank(catOf(b)); if (d) return d;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  }
  function groupByCat(codes) {
    var g = {};
    sortCodes(codes).forEach(function (c) { var k = catOf(c) || 'Miscellaneous'; (g[k] = g[k] || []).push(c); });
    return Object.keys(g).sort(function (a, b) { return catRank(a) - catRank(b); }).map(function (k) { return { cat: k, codes: g[k] }; });
  }
  function catSummary(codes) {
    var g = groupByCat(codes), main = [], other = 0;
    g.forEach(function (x) {
      var one = { 'Camera': 'camera', 'Lens': 'lens', 'Light': 'light', 'Stand / Tripod': 'stand', 'Bag': 'bag' }[x.cat];
      var many = { 'Camera': 'cameras', 'Lens': 'lenses', 'Light': 'lights', 'Stand / Tripod': 'stands', 'Bag': 'bags' }[x.cat];
      if (one) main.push(x.codes.length + ' ' + (x.codes.length === 1 ? one : many));
      else other += x.codes.length;
    });
    if (other) main.push(other + ' other');
    return main.join(' · ');
  }
  function kitCodes(s) {
    if (!s || !s.basedOn) return [];
    var k = sess(S.model, s.basedOn);
    return k ? Object.keys(k.packed || {}) : [];
  }

  /* ------------------------------------------------------------ navigation */
  function go(view, opts, replace) {
    opts = opts || {};
    if (!replace) S.stack.push({ view: S.view, tab: S.tab, sid: S.sid });
    S.view = view;
    if (opts.tab) S.tab = opts.tab;
    if ('sid' in opts) S.sid = opts.sid;
    S.sheet = null;
    try { history.pushState({ n: S.stack.length }, ''); } catch (e) { }
    render();
    var v = $('.view'); if (v) v.scrollTop = 0;
  }
  function goBack() {
    if (S.sheet) { S.sheet = null; renderSheet(); return; }
    var prev = S.stack.pop();
    if (!prev) { S.view = 'home'; S.tab = 'home'; }
    else { S.view = prev.view; S.tab = prev.tab; S.sid = prev.sid; }
    render();
  }
  window.addEventListener('popstate', function () { goBack(); });
  function goTab(tab) { S.stack = []; S.view = 'home'; S.tab = tab; S.sheet = null; render(); var v = $('.view'); if (v) v.scrollTop = 0; }

  /* ------------------------------------------------------------ render */
  var app;
  // background refreshes must not wipe what someone is typing or an open sheet
  function softRender() {
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
    if (S.view === 'new' && S.form && $('#nm')) { S.form.name = $('#nm').value; S.form.shootDate = $('#dt').value; }
    render(true);
  }
  function render(keepSheet) {
    app = app || $('#app');
    document.body.dataset.mode = (S.view === 'check' || S.view === 'allback') ? 'check' : 'pack';
    if (!S.token || !S.me) { stopCamera(); app.innerHTML = renderSignin(); bindSignin(); renderSheet(); return; }
    if (!S.model) { app.innerHTML = '<div class="view" style="display:flex;align-items:center;justify-content:center"><div class="spinner"></div></div>'; return; }
    if (S.view === 'pack' || S.view === 'check') { renderScanner(); if (keepSheet !== true) renderSheet(); positionToast(); return; }
    stopCamera();
    var html = '';
    if (S.view === 'home') html = renderTabs();
    else if (S.view === 'new') html = renderNew();
    else if (S.view === 'session') html = renderSession();
    else if (S.view === 'allback') html = renderAllBack();
    app.innerHTML = html;
    if (keepSheet !== true || !S.sheet) renderSheet();
    positionToast();
  }

  function testBanner() {
    return S.model && S.model.testMode && S.me && S.me.isAdmin ? '<div class="banner">Test mode. Reports and reminders only go to you.</div>' : '';
  }

  function syncChip() {
    var n = S.queue.length;
    if (!n && S.online) return '';
    return '<span class="pill" style="height:32px;padding:0 10px;font-size:13px;background:rgba(255,255,255,.08);color:var(--muted)">' + ic('cloud', 16) +
      (n ? n + ' to sync' : 'Offline') + '</span>';
  }
  function renderSyncBits() { var el = $('[data-sync]'); if (el) el.innerHTML = syncChip(); }

  /* ---------- sign in */
  function renderSignin() {
    var si = S.signin;
    if (si.step === 'code') {
      return '<div class="view glow" style="display:flex;flex-direction:column">' +
        '<div class="topbar"><button class="circ glass press" data-act="si-back" aria-label="Back">' + ic('back', 20) + '</button><span></span></div>' +
        '<div style="text-align:center;margin-top:40px"><h1 class="title" style="font-size:26px">Check your email</h1>' +
        '<p class="muted" style="font-size:15px;margin:10px 0 0">We sent a 6 digit code to<br><b style="color:var(--text)">' + esc(si.email) + '</b></p>' +
        '<form data-form="code" style="margin-top:30px" class="otp"><label for="otp" class="sr">Sign in code</label>' +
        '<input id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" autocapitalize="none" autocorrect="off" enterkeyhint="go"></form>' +
        (si.err ? '<p class="err">' + esc(si.err) + '</p>' : '') +
        '<p class="muted small" style="margin:22px auto 0;max-width:290px">On iPhone the code shows above the keyboard, tap it. The code works for 10 minutes.</p>' +
        '<button class="pill press" data-act="si-resend" style="margin-top:12px">Send a new code</button></div>' +
        '<div style="margin-top:auto;padding-top:24px"><p class="muted small" style="text-align:center;margin:0 0 12px">You stay signed in for a year on this phone.</p>' +
        '<button class="cta press" data-act="si-verify" ' + (si.busy ? 'disabled' : '') + '>' + (si.busy ? '<span class="spinner" style="border-top-color:var(--bg)"></span>' : 'Sign in') + '</button></div></div>';
    }
    var local = (si.email || '').split('@')[0];
    return '<div class="view glow" style="display:flex;flex-direction:column">' +
      '<div style="text-align:center;margin-top:12vh">' +
      '<div style="width:96px;height:96px;border-radius:24px;background:var(--pack);color:var(--bg);display:flex;align-items:center;justify-content:center;margin:0 auto;box-shadow:inset 0 1px 0 rgba(255,255,255,.7),0 20px 50px rgba(var(--pack-rgb),.25)">' + ic('scan', 48, 2) + '</div>' +
      '<p class="muted" style="margin:26px 0 0;font-weight:600">EyeStudio</p><h1 class="title" style="margin-top:4px">Equipment Tracker</h1>' +
      '<p class="muted" style="font-size:15px;margin:12px auto 0;max-width:300px">Scan gear out before the shoot. Check it back before you leave.</p></div>' +
      '<form data-form="email" style="margin-top:auto;padding-top:30px;display:flex;flex-direction:column;gap:12px">' +
      '<label for="em" class="muted" style="font-weight:600;padding-left:4px">Work email</label>' +
      '<div class="field"><input id="em" type="text" inputmode="email" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="send" placeholder="yourname" value="' + esc(local) + '"><span class="muted">@eyestudio.ae</span></div>' +
      (si.err ? '<p class="err" style="margin:0">' + esc(si.err) + '</p>' : '') +
      '<button class="cta press" type="submit" ' + (si.busy ? 'disabled' : '') + '>' + (si.busy ? '<span class="spinner" style="border-top-color:var(--bg)"></span>' : 'Send me a code') + '</button>' +
      '<p class="muted small" style="text-align:center;margin:2px 0 0">Only people on the team list can sign in.</p></form></div>';
  }
  function bindSignin() {
    var f = $('[data-form="email"]');
    if (f) f.onsubmit = function (e) { e.preventDefault(); sendCode($('#em').value); };
    var c = $('[data-form="code"]');
    if (c) {
      var inp = $('#otp');
      setTimeout(function () { try { inp.focus(); } catch (e) { } }, 50);
      inp.oninput = function () { inp.value = inp.value.replace(/\D/g, '').slice(0, 6); if (inp.value.length === 6) verify(inp.value); };
      c.onsubmit = function (e) { e.preventDefault(); verify(inp.value); };
    }
  }
  function sendCode(v) {
    var si = S.signin;
    v = String(v || '').trim().toLowerCase();
    if (!v) { si.err = 'Type your work email first.'; render(); return; }
    if (v.indexOf('@') === -1) v += '@eyestudio.ae';
    si.busy = true; si.err = ''; render();
    call('requestCode', { email: v }).then(function (j) {
      si.busy = false;
      if (!j.ok) { si.err = j.error; render(); return; }
      si.email = j.email; store.set('lastEmail', j.email); si.step = 'code'; store.set('signinStep', { email: j.email, at: Date.now() }); render();
    }).catch(function () { si.busy = false; si.err = 'No connection. Check your signal and try again.'; render(); });
  }
  function verify(code) {
    var si = S.signin;
    if (!/^\d{6}$/.test(code || '')) { si.err = 'Enter all 6 digits.'; render(); return; }
    si.busy = true; si.err = ''; render();
    call('verifyCode', { email: si.email, code: code }).then(function (j) {
      si.busy = false;
      if (!j.ok) { si.err = j.error; render(); return; }
      S.token = j.token; store.set('token', j.token); store.del('signinStep');
      S.me = j.me; store.set('me', j.me);
      si.step = 'email';
      S.view = 'home'; S.tab = 'home';
      render(); refresh();
    }).catch(function () { si.busy = false; si.err = 'No connection. Check your signal and try again.'; render(); });
  }
  function signOut(expired) {
    S.token = ''; S.me = null; S.server = null; S.model = null;
    store.del('token'); store.del('me'); store.del('server');
    S.signin.step = 'email'; S.signin.err = expired ? 'Please sign in again.' : '';
    S.sheet = null; render();
  }

  /* ---------- tabs */
  function tabbar() {
    var tabs = [['home', 'sessions', 'Shoots'], ['out', 'out', 'Out now'], ['items', 'items', 'Items'], ['history', 'history', 'History']];
    return '<div class="fade-bottom"></div><nav class="tabbar glass" aria-label="Main">' + tabs.map(function (t) {
      return '<button class="press' + (S.tab === t[0] ? ' on" aria-current="page' : '') + '" data-act="tab" data-tab="' + t[0] + '">' + ic(t[1], 23) + t[2] + '</button>';
    }).join('') + '</nav><button class="fab press" data-act="new" aria-label="Start a new shoot">' + ic('plus', 30, 2.4) + '</button>';
  }
  function largeNav(title, sub, right) {
    return '<div class="topbar" style="justify-content:flex-end;gap:10px">' + (right || '') + '</div>' +
      '<h1 class="title" style="margin-top:6px">' + esc(title) + '</h1>' + (sub ? '<p class="muted" style="margin:4px 0 0">' + esc(sub) + '</p>' : '');
  }
  function renderTabs() {
    var body = S.tab === 'out' ? renderOut() : S.tab === 'items' ? renderItems() : S.tab === 'history' ? renderHistory() : renderHome();
    return '<div class="view">' + body + '</div>' + tabbar();
  }

  function renderHome() {
    var m = S.model, act = activeSessions();
    var itemsOut = m.items.filter(function (i) { return i.status === 'Out'; }).length;
    var overdue = act.filter(function (s) { return s.overdue; }).length;
    var hour = new Date().getHours();
    var hi = (hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening') + ', ' + first(S.me.name);
    var right = '<span data-sync>' + syncChip() + '</span><button class="circ glass press" data-act="account" aria-label="Account" style="font-weight:700;color:var(--pack)">' + esc(S.me.name.charAt(0)) + '</button>';
    var h = largeNav('Shoots', hi, right) + '<div style="margin-top:16px">' + testBanner() +
      '<div class="stats"><div class="stat"><b>' + act.length + '</b><span>Shoots open</span></div><div class="stat"><b>' + itemsOut + '</b><span>Items out</span></div>' +
      '<div class="stat' + (overdue ? ' red' : '') + '"><b>' + overdue + '</b><span>Overdue</span></div></div>';
    h += '<p class="sec">Active</p>';
    if (!act.length) {
      h += '<div class="empty"><b>Nothing out right now</b>Tap the + button to start packing for a shoot.</div>';
    } else {
      h += '<div class="stack">' + act.map(sessionCard).join('') + '</div>';
    }
    var missing = m.items.filter(function (i) { return i.status === 'Missing'; });
    if (missing.length) {
      h += '<p class="sec" style="color:var(--red)">Missing · ' + missing.length + '</p><div class="group">' + missing.slice(0, 6).map(function (i) {
        var s = sess(m, i.session);
        return '<div class="row"><span class="id">' + esc(i.id) + '</span><div class="grow"><p>' + esc(i.name) + '</p><p class="sub">' + (s ? 'Last on ' + esc(s.name) : 'Scan it anywhere to clear it') + '</p></div></div>';
      }).join('') + '</div>';
    }
    return h + '</div>';
  }
  function dateTile(iso) {
    var d = iso ? new Date(iso.length === 10 ? iso + 'T00:00:00' : iso) : new Date();
    var today = todayIso() === (d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
    return '<span class="dtile' + (today ? ' today' : '') + '"><small>' + (today ? 'TODAY' : d.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase()) + '</small><b>' + d.getDate() + '</b></span>';
  }
  function sessionCard(s) {
    var c = counts(s), chipx, meta, action = '', bar = '';
    var team = s.team.map(whoShort).join(', ');
    var started = fmtTime(s.created), out = fmtTime(s.packedAt || s.created);
    var actKind = s.phase === 'Packing' ? 'pack' : 'ret', actIcon = s.phase === 'Packing' ? 'scan' : 'ret';
    if (s.overdue) { chipx = chip('Overdue · ' + plural(daysSince(s.packedAt || s.created), 'day'), 'red'); meta = 'Out since ' + fmtDate(s.packedAt || s.created) + ', ' + out + ' · ' + plural(c.packed - c.back, 'item'); action = 'Check gear back'; }
    else if (s.phase === 'Packing') {
      chipx = chip('Packing', 'y'); meta = 'Started ' + started + ' · ' + c.packed + ' scanned'; action = 'Continue packing';
      var kit = kitCodes(s).length; if (kit) bar = '<div class="bar" style="margin-top:12px"><i style="width:' + Math.min(100, Math.round(c.packed / kit * 100)) + '%"></i></div>';
    }
    else if (s.phase === 'Checking') { chipx = chip('Checking back', 'v'); meta = 'Out at ' + out + ' · ' + c.back + ' of ' + c.packed + ' back' + (c.missing ? ' · ' + c.missing + ' missing' : ''); action = 'Continue checking'; }
    else { chipx = chip('Out', 'y'); meta = 'Out at ' + out + ' · ' + plural(c.packed, 'item'); action = 'Check gear back'; }
    return '<button class="card press' + (s.overdue ? ' alert' : '') + '" data-act="open" data-sid="' + esc(s.id) + '">' +
      '<div style="display:flex;gap:12px;align-items:flex-start">' + dateTile(s.shootDate || s.created) + '<div style="flex:1;min-width:0">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' + chipx + '<span class="muted small" style="display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">' + esc(team) + ic('chev', 14) + '</span></div>' +
      '<p style="margin:8px 0 0;font-size:17px;font-weight:650">' + esc(s.name) + '</p><p class="muted small" style="margin:3px 0 0">' + esc(meta) + '</p>' + bar +
      '</div></div>' + (action ? '<span class="card-act ' + actKind + '">' + ic(actIcon, 20, 2.3) + '<span>' + action + '</span>' + ic('chev', 18, 2.4) + '</span>' : '') + '</button>';
  }

  function renderOut() {
    var m = S.model, act = activeSessions().filter(function (s) { return counts(s).packed - counts(s).back > 0; });
    var total = act.reduce(function (a, s) { var c = counts(s); return a + c.packed - c.back; }, 0);
    var h = largeNav('Out now', plural(total, 'item') + ' across ' + plural(act.length, 'shoot'), '<span data-sync>' + syncChip() + '</span>') + '<div class="stack" style="margin-top:16px">';
    if (!act.length) h += '<div class="empty"><b>Everything is in</b>Nothing is out on a shoot right now.</div>';
    act.forEach(function (s) {
      var c = counts(s), out = sortCodes(Object.keys(s.packed).filter(function (k) { return !s.back[k]; }));
      var chipx = s.overdue ? chip('Overdue · ' + plural(daysSince(s.packedAt || s.created), 'day'), 'red') : s.phase === 'Packing' ? chip('Packing', 'y') : s.phase === 'Checking' ? chip('Checking back', 'v') : chip('Out since ' + fmtDate(s.packedAt || s.created), 'y');
      h += '<div class="card' + (s.overdue ? ' alert' : '') + '" style="padding-bottom:4px"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px"><div style="min-width:0">' + chipx +
        '<p style="margin:10px 0 0;font-size:17px;font-weight:650">' + esc(s.name) + '</p><p class="muted small" style="margin:3px 0 0">' + esc(s.team.map(whoShort).join(', ')) + '</p></div>' +
        '<span class="big" style="font-size:24px">' + (c.packed - c.back) + '</span></div><div style="margin:8px -18px 0">' +
        out.slice(0, 3).map(function (k) { var it = item(m, k) || {}; return '<div class="row"><span class="id">' + esc(k) + '</span><span style="flex:1;min-width:0">' + esc(it.name) + '</span><span class="muted small">' + fmtTime(s.packed[k].at) + '</span></div>'; }).join('') +
        '<button class="row press" data-act="open-detail" data-sid="' + esc(s.id) + '" style="color:var(--pack);font-weight:600"><span style="flex:1">See all ' + (c.packed - c.back) + ' items</span>' + ic('chev', 16) + '</button></div></div>';
    });
    var missing = m.items.filter(function (i) { return i.status === 'Missing'; });
    if (missing.length) h += '<p class="sec" style="color:var(--red)">Missing · ' + missing.length + '</p><div class="group">' + missing.map(function (i) {
      var s = sess(m, i.session); return '<div class="row"><span class="id">' + esc(i.id) + '</span><div class="grow"><p>' + esc(i.name) + '</p><p class="sub">' + (s ? 'Last on ' + esc(s.name) : '') + '</p></div></div>';
    }).join('') + '</div>';
    return h + '</div>';
  }

  function renderItems() {
    var m = S.model, f = S.filters, q = f.q.trim().toLowerCase();
    var all = m.items;
    var n = { all: all.length, In: 0, Out: 0, Missing: 0, oos: 0 };
    all.forEach(function (i) { if (i.cond === 'Out of service') n.oos++; else n[i.status] = (n[i.status] || 0) + 1; });
    var nReprint = all.filter(function (i) { return i.reprint; }).length;
    var list = all.filter(function (i) {
      if (f.items === 'reprint') return !!i.reprint && (!q || (i.id + ' ' + i.name).toLowerCase().indexOf(q) > -1);
      if (f.items === 'oos' && i.cond !== 'Out of service') return false;
      if (f.items !== 'all' && f.items !== 'oos' && (i.status !== f.items || i.cond === 'Out of service')) return false;
      if (q && (i.id + ' ' + i.name + ' ' + i.cat).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var filt = [['all', 'All ' + n.all], ['In', 'In ' + (n.In || 0)], ['Out', 'Out ' + (n.Out || 0)]];
    if (n.Missing) filt.push(['Missing', 'Missing ' + n.Missing]);
    if (n.oos) filt.push(['oos', 'Out of service ' + n.oos]);
    if (nReprint) filt.push(['reprint', 'Reprint ' + nReprint]);
    var h = largeNav('Items', null, '<span data-sync>' + syncChip() + '</span>') +
      '<label style="margin-top:14px;height:44px;border-radius:22px;display:flex;align-items:center;gap:8px;padding:0 14px;background:var(--fill)"><span class="muted">' + ic('search', 18) + '</span>' +
      '<span class="sr">Search items</span><input id="q" type="search" placeholder="Search name or ID" value="' + esc(f.q) + '" autocomplete="off" autocorrect="off" style="flex:1;min-width:0;border:0;outline:0;background:transparent;font-size:16px"></label>' +
      '<div class="scrollx" style="margin-top:12px">' + filt.map(function (x) { return '<button class="pill press' + (f.items === x[0] ? ' solid' : '') + '" data-act="ifilter" data-f="' + x[0] + '">' + esc(x[1]) + '</button>'; }).join('') + '</div>';
    if (f.items === 'reprint' && list.length) h += '<p class="muted small" style="margin:14px 4px 0">These items were typed in because the sticker was lost or broken. Print new labels for them.</p>' + (S.me.isAdmin ? '<button class="btn2 press" style="margin-top:10px" data-act="clear-reprint">Mark all as reprinted</button>' : '');
    if (!list.length) return h + '<div class="empty"><b>No items found</b>Try a different name or ID.</div>';
    var byCat = {};
    list.forEach(function (i) { (byCat[i.cat || 'Miscellaneous'] = byCat[i.cat || 'Miscellaneous'] || []).push(i); });
    Object.keys(byCat).sort(function (a, b) { return catRank(a) - catRank(b); }).forEach(function (c) {
      var arr = byCat[c].sort(function (a, b) { return a.id.localeCompare(b.id, undefined, { numeric: true }); });
      h += '<p class="sec">' + esc(CAT_PLURAL[c] || c) + ' · ' + arr.length + '</p><div class="group">' + arr.map(function (i) {
        var st = i.reprint && f.items === 'reprint' ? chip('Reprint', 'y') : i.cond === 'Out of service' ? chip('Out of service', 'grey') : i.status === 'Out' ? chip('Out', 'y') : i.status === 'Missing' ? chip('Missing', 'red') : i.cond === 'Damaged' ? chip('Damaged', 'red') : chip('In', 'grey');
        var s = i.session ? sess(m, i.session) : null;
        return '<div class="row"><span class="id">' + esc(i.id) + '</span><div class="grow"><p' + (i.cond === 'Out of service' ? ' style="color:#8A8D99"' : '') + '>' + esc(i.name) + '</p>' +
          (s && i.status !== 'In' ? '<p class="sub">' + esc(s.name) + '</p>' : '') + '</div>' + st + '</div>';
      }).join('') + '</div>';
    });
    return h;
  }

  function renderHistory() {
    var f = S.filters.history;
    var closed = S.model.sessions.filter(function (s) { return s.phase === 'Closed'; }).sort(function (a, b) { return (b.closedAt || '') > (a.closedAt || '') ? 1 : -1; });
    var list = closed.filter(function (s) { var c = counts(s); return f === 'all' || (f === 'missing' && c.missing) || (f === 'damaged' && c.damaged); });
    var h = largeNav('History', null, '<span data-sync>' + syncChip() + '</span>') +
      '<div class="seg" style="margin-top:14px">' + [['all', 'All'], ['missing', 'Missing'], ['damaged', 'Damaged']].map(function (x) {
        return '<button class="' + (f === x[0] ? 'on' : '') + '" data-act="hfilter" data-f="' + x[0] + '">' + x[1] + '</button>';
      }).join('') + '</div>';
    if (!list.length) return h + '<div class="empty"><b>' + (closed.length ? 'Nothing here' : 'No finished shoots yet') + '</b>' + (closed.length ? 'No shoots match this filter.' : 'Closed sessions and their reports show up here.') + '</div>';
    var lastMonth = '';
    h += '<div class="stack" style="margin-top:6px">';
    list.forEach(function (s) {
      var mo = new Date(s.closedAt || s.created).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
      if (mo !== lastMonth) { h += '<p class="sec" style="margin-bottom:0">' + mo + '</p>'; lastMonth = mo; }
      var c = counts(s);
      var chips = c.missing || c.damaged ? chip(c.back + ' back', 'grey') + (c.missing ? chip(c.missing + ' missing', 'red') : '') + (c.damaged ? chip(c.damaged + ' damaged', 'red') : '') : chip('All ' + c.back + ' back', 'ok');
      h += '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><p style="margin:0;font-size:16px;font-weight:650;min-width:0">' + esc(s.name) + '</p><span class="muted small">' + fmtDate(s.shootDate) + '</span></div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' + chips + '</div><div style="display:flex;gap:8px;margin-top:14px">' +
        (s.reportUrl ? '<a class="pill press" style="flex:1;justify-content:center;height:44px" href="' + esc(s.reportUrl) + '" target="_blank" rel="noopener">View report</a>' : '<button class="pill" style="flex:1;justify-content:center" disabled>Report pending</button>') +
        (c.missing || c.damaged ? '<button class="pill press" style="flex:1;justify-content:center" data-act="resend" data-sid="' + esc(s.id) + '">Resend report</button>'
          : '<button class="pill press on" style="flex:1;justify-content:center" data-act="pack-again" data-sid="' + esc(s.id) + '">Pack again</button>') + '</div></div>';
    });
    return h + '</div>';
  }

  /* ---------- new session */
  function renderNew() {
    var f = S.form;
    var people = S.model.people;
    var kits = S.model.sessions.filter(function (s) { return Object.keys(s.packed || {}).length; }).slice(0, 6);
    var h = '<div class="view glow"><div class="topbar"><button class="circ glass press" data-act="back" aria-label="Cancel">' + ic('x', 20) + '</button><span class="ttl">New shoot</span><span style="width:44px"></span></div>' +
      '<div class="group" style="margin-top:14px"><label class="form-row" for="nm"><span class="muted" style="width:90px">Shoot</span><input id="nm" value="' + esc(f.name) + '" placeholder="e.g. Hutong reel" autocomplete="off" enterkeyhint="done"></label>' +
      '<label class="form-row" for="dt"><span class="muted" style="flex:1">Shoot date</span><input id="dt" type="date" value="' + esc(f.shootDate) + '" style="flex:none;width:auto"></label></div>' +
      '<p class="muted small" style="margin:8px 4px 0">No return date needed. It is recorded when the gear is checked back.</p>' +
      '<p class="sec">Who is going</p><div style="display:flex;flex-wrap:wrap;gap:8px">' + people.map(function (p) {
        var on = f.team.indexOf(p.email) > -1;
        return '<button class="pill press' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-act="team" data-email="' + esc(p.email) + '">' + (on ? ic('check', 16, 2.4) : '') + esc(first(p.name)) + (isMe(p.email) ? ' (you)' : '') + '</button>';
      }).join('') + '</div>';
    if (kits.length) {
      h += '<p class="sec">Start from a past kit</p><div class="group">' + kits.map(function (s) {
        var on = f.basedOn === s.id;
        return '<button class="row press" data-act="kit" data-sid="' + esc(s.id) + '" style="min-height:62px"><div class="grow"><p style="font-weight:' + (on ? 650 : 400) + '">' + esc(s.name) + '</p><p class="sub">' + fmtDate(s.shootDate) + ' · ' + plural(Object.keys(s.packed).length, 'item') + '</p></div>' +
          (on ? '<span style="color:var(--pack)">' + ic('check', 22, 2.6) + '</span>' : '') + '</button>';
      }).join('') + '<button class="row press" data-act="kit" data-sid=""><span style="flex:1">Start empty</span>' + (!f.basedOn ? '<span style="color:var(--pack)">' + ic('check', 22, 2.6) + '</span>' : '') + '</button></div>';
    }
    h += '<p class="err" data-err>' + esc(f.err || '') + '</p></div><div class="fade-bottom"></div><div class="bottom-action"><button class="cta press" data-act="create">' + ic('scan', 22, 2.2) + 'Start packing</button></div>';
    return h;
  }
  function openNew(basedOn) {
    var kit = basedOn ? sess(S.model, basedOn) : null;
    S.form = { name: '', shootDate: todayIso(), team: [S.me.email], basedOn: basedOn || '', err: '' };
    if (kit) S.form.team = kit.team.slice();
    if (S.form.team.indexOf(S.me.email) === -1) S.form.team.unshift(S.me.email);
    go('new');
  }
  function createSession() {
    var f = S.form;
    f.name = ($('#nm').value || '').trim(); f.shootDate = $('#dt').value || todayIso();
    if (!f.name) { f.err = 'Give the shoot a name.'; $('[data-err]').textContent = f.err; $('#nm').focus(); return; }
    var id = 'S' + todayIso().slice(2).replace(/-/g, '') + '-' + uid().slice(-4).toUpperCase();
    enqueue({ type: 'createSession', body: { id: id, name: f.name, shootDate: f.shootDate, team: f.team, basedOn: f.basedOn } });
    S.packTab = f.basedOn ? 'topack' : 'scanned';
    S.stack = [];
    go('pack', { sid: id }, true);
  }

  /* ---------- session detail */
  function renderSession() {
    var s = currentSession();
    if (!s) return '<div class="view"><div class="topbar"><button class="circ glass press" data-act="back" aria-label="Back">' + ic('back', 20) + '</button></div><div class="empty"><b>Shoot not found</b>It may have been deleted.</div></div>';
    var c = counts(s), out = Object.keys(s.packed).filter(function (k) { return !s.back[k]; });
    var chipx = s.overdue ? chip('Overdue · ' + plural(daysSince(s.packedAt || s.created), 'day'), 'red') : s.phase === 'Closed' ? chip('Closed', 'grey') : s.phase === 'Checking' ? chip('Checking back', 'v') : s.phase === 'Packing' ? chip('Packing', 'y') : chip('Out · ' + plural(c.packed, 'item'), 'y');
    var h = '<div class="view"><div class="topbar"><button class="circ glass press" data-act="back" aria-label="Back">' + ic('back', 20) + '</button><span data-sync>' + syncChip() + '</span>' +
      '<button class="circ glass press" data-act="menu" aria-label="More options">' + ic('more', 20) + '</button></div>' +
      '<div style="padding:8px 4px 0">' + chipx + '<h1 class="title" style="font-size:24px;margin-top:10px">' + esc(s.name) + '</h1>' +
      '<p class="muted" style="margin:4px 0 0">' + plural(out.length, 'item') + ' out with ' + esc(s.team.map(function (e) { return first(nameOf(e)); }).join(' and ').replace(/ and (?=.* and )/g, ', ')) + '</p></div>' +
      '<div class="group" style="margin-top:18px"><div class="row"><span class="muted" style="flex:1">Shoot</span><span>' + fmtDate(s.shootDate) + '</span></div>' +
      (s.packedAt ? '<div class="row"><span class="muted" style="flex:1">Out for</span><span' + (s.overdue ? ' style="color:var(--red)"' : '') + '>' + (daysSince(s.packedAt) ? plural(daysSince(s.packedAt), 'day') : 'Since ' + fmtTime(s.packedAt) + ' today') + (s.overdue ? ' · reminder sent' : '') + '</span></div>' : '') +
      '<div class="row"><span class="muted" style="flex:1">Packed by</span><span>' + esc(nameOf(s.packedBy)) + '</span></div></div>';
    groupByCat(Object.keys(s.packed)).forEach(function (g) {
      h += '<p class="sec">' + esc(CAT_PLURAL[g.cat] || g.cat) + ' · ' + g.codes.length + '</p><div class="group">' + g.codes.map(function (k) {
        var it = item(S.model, k) || {};
        return '<div class="row"><span class="id">' + esc(k) + '</span><span style="flex:1;min-width:0">' + esc(it.name) + '</span>' + (s.typed && s.typed[k] ? chip('Typed', 'y') : '') + (s.back[k] ? chip('Back', 'grey') : '') + '</div>';
      }).join('') + '</div>';
    });
    if (!c.packed) h += '<div class="empty"><b>No items yet</b>Scan gear to add it to this shoot.</div>';
    h += '</div><div class="fade-bottom"></div>';
    if (s.phase !== 'Closed') {
      h += '<div class="bottom-action">' + (s.phase !== 'Checking' ? '<button class="circ glass press" data-act="edit-items" aria-label="Add or remove items" style="width:56px;height:56px;border-radius:28px">' + ic('edit', 22) + '</button>' : '') +
        (s.phase === 'Packing' ? '<button class="cta press" data-act="edit-items" style="flex:1">Continue packing</button>' :
          '<button class="cta press" data-act="check" style="flex:1;background:var(--ret);box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 10px 28px rgba(var(--ret-rgb),.2)">' + ic('ret', 22, 2.2) + (s.phase === 'Checking' ? 'Continue checking' : 'Check gear back') + '</button>') + '</div>';
    }
    return h;
  }

  /* ---------- all back */
  function renderAllBack() {
    var s = currentSession(); if (!s) return '';
    var c = counts(s);
    return '<div class="view glow" style="display:flex;flex-direction:column;align-items:center;text-align:center">' +
      '<div style="margin-top:18vh"><span style="width:96px;height:96px;border-radius:48px;background:var(--green);color:var(--bg);display:flex;align-items:center;justify-content:center;margin:0 auto">' + ic('check', 52, 3) + '</span>' +
      '<h1 class="title" style="margin-top:26px">All ' + c.packed + ' back</h1><p class="muted" style="font-size:15px;margin-top:8px">Nothing missing.' + (c.damaged ? ' ' + plural(c.damaged, 'item') + ' marked damaged.' : ' Nothing damaged.') + '<br>Good shoot, go rest.</p>' + (Object.keys(s.typed || {}).length ? '<p class="small" style="margin-top:14px;color:var(--pack)">' + plural(Object.keys(s.typed).length, 'item') + ' typed in by hand. The report lists them.</p>' : '') + '</div></div>' +
      '<div class="bottom-action" style="flex-direction:column"><p class="muted small" style="text-align:center;margin:0">Report goes to Chamath' + (S.model.testMode ? '' : ', with the team on CC') + '</p>' +
      '<button class="cta press" data-act="close-session">Close and send report</button></div>';
  }

  /* ---------- scanner (packing and checking back) */
  var mountedScanner = '';
  function renderScanner() {
    var s = currentSession();
    if (!s) { S.view = 'home'; render(); return; }
    var key = S.view + ':' + s.id;
    var pack = S.view === 'pack';
    if (mountedScanner !== key || !$('.scanner')) {
      var camH = pack ? 'min(52vh, 460px)' : 'min(38vh, 320px)';
      app.innerHTML = '<div class="scanner glow">' +
        '<div class="cam" style="height:calc(' + camH + ' + var(--sat));' + (pack ? '' : 'margin:0;') + '"><video playsinline muted autoplay></video><div class="shade"></div>' +
        '<div class="frame" style="width:' + (pack ? 180 : 120) + 'px;height:' + (pack ? 180 : 120) + 'px;margin-top:calc(var(--sat) / 2 + ' + (pack ? 20 : 12) + 'px)"><i></i><i></i><i></i><i></i></div>' +
        '<div class="cam-msg" data-cammsg hidden></div>' +
        '<div class="cam-overlay" style="top:calc(var(--sat) + 8px)"><button class="circ glass press" data-act="leave" aria-label="Leave. Progress is saved">' + ic('x', 20) + '</button>' +
        '<div class="mode glass"><span class="k">' + (pack ? 'PACKING' : 'CHECKING BACK') + '</span><span class="n">' + esc(s.name) + '</span></div>' +
        '<button class="circ glass press" data-act="torch" aria-label="Flashlight" data-torch hidden>' + ic('flash', 20) + '</button><span class="circ" data-torch-gap></span></div>' +
        '<div class="cam-overlay" style="top:calc(var(--sat) + 64px);justify-content:center"><span class="live glass" data-live><i></i>Starting camera</span></div>' +
        '<div class="cam-overlay" style="top:calc(50% + var(--sat) / 2 - ' + (pack ? 2 : 0) + 'px)"><button class="zoom-btn glass press" data-act="zoom" aria-label="Zoom in for small stickers">2x</button>' +
        '</div></div>' +
        '<div class="panel"><div class="grab"></div><div class="scroll" data-panel></div></div>' +
        '<div class="scan-foot"><button class="type-link press" data-act="type-open">Can\u2019t scan? Type it</button><button class="foot-btn press" data-act="' + (pack ? 'done-packing' : 'finish') + '">' + (pack ? 'Done packing' : 'Finish') + ic('chev', 16, 2.4) + '</button></div>' +
        '<div class="cam-flash" data-camflash></div></div>';
      mountedScanner = key;
      startCamera();
    }
    renderScanPanel();
  }

  function renderScanPanel() {
    var el = $('[data-panel]'); if (!el) return;
    var s = currentSession(); if (!s) return;
    var zb = $('[data-act="zoom"]'); if (zb) zb.classList.toggle('on', S.zoom > 1);
    var h;
    if (S.view === 'pack') {
      var codes = Object.keys(s.packed), kit = kitCodes(s), todo = sortCodes(kit.filter(function (k) { return !s.packed[k]; }));
      var tab = S.packTab === 'topack' && kit.length ? 'topack' : 'scanned';
      h = '<div style="display:flex;align-items:center;gap:8px;padding:0 4px"><p style="margin:0;flex:1"><span class="big" style="font-size:24px">' + codes.length + '</span> <span class="muted" style="font-weight:500">scanned</span></p><span data-sync>' + syncChip() + '</span></div>';
      if (kit.length) h += '<div class="seg" style="margin:12px 0 4px"><button class="' + (tab === 'topack' ? 'on' : '') + '" data-act="ptab" data-t="topack">To pack ' + todo.length + '</button><button class="' + (tab === 'scanned' ? 'on' : '') + '" data-act="ptab" data-t="scanned">Scanned ' + codes.length + '</button></div>';
      if (tab === 'topack') {
        h += todo.length ? '<div>' + todo.map(function (k) { var it = item(S.model, k) || {}; return '<div class="row" style="padding:0 4px"><span class="id">' + esc(k) + '</span><span style="flex:1;min-width:0">' + esc(it.name) + '</span><span class="muted small">' + esc(it.cat || '') + '</span></div>'; }).join('') + '</div>'
          : '<div class="empty" style="padding:28px 12px"><b>Kit complete</b>Everything from the past kit is scanned.</div>';
      } else {
        var recent = codes.slice().sort(function (a, b) { return (s.packed[b].at || '').localeCompare(s.packed[a].at || ''); });
        h += recent.length ? '<div style="margin:4px -16px 0">' + recent.map(function (k) {
          var it = item(S.model, k) || {};
          return '<div class="swipe" data-swipe="' + esc(k) + '"><button class="under" data-act="remove" data-code="' + esc(k) + '">' + ic('trash', 20) + 'Remove</button>' +
            '<div class="over"><div class="row" style="padding:0 20px;min-height:60px"><span class="id">' + esc(k) + '</span><div class="grow"><p>' + esc(it.name) + '</p><p class="sub">' + (s.typed && s.typed[k] ? '<span style="color:var(--pack)">Typed</span> by ' : 'by ') + esc(whoShort(s.packed[k].by)) + ' · ' + ago(s.packed[k].at) + '</p></div></div></div></div>';
        }).join('') + '</div><p class="muted small" style="text-align:center;margin:12px 0 0">Swipe left or hold an item to remove it</p>'
          : '<div class="empty" style="padding:28px 12px"><b>Point the camera at a sticker</b>Check the name that pops up, then tap Add. The camera stays on.</div>';
      }
    } else {
      var c = counts(s), missing = sortCodes(Object.keys(s.packed).filter(function (k) { return !s.back[k]; }));
      var pct = c.packed ? Math.round(c.back / c.packed * 100) : 0;
      h = '<div style="display:flex;align-items:baseline;justify-content:space-between;padding:0 4px;gap:8px"><p style="margin:0"><span class="big">' + c.back + '</span> <span class="muted" style="font-size:15px;font-weight:500">of ' + c.packed + ' back</span></p>' +
        '<span data-sync>' + syncChip() + '</span>' + (c.missing ? '<span style="font-weight:650;color:var(--red)">' + c.missing + ' missing</span>' : '<span style="font-weight:650;color:var(--green)">All back</span>') + '</div>' +
        '<div class="bar" style="height:8px;margin:10px 4px 0"><i style="width:' + pct + '%"></i></div>';
      if (missing.length) {
        h += '<p class="sec" style="color:var(--red);margin-top:18px">Still missing · ' + missing.length + '</p><div class="group" style="background:var(--card2)">' + missing.map(function (k) {
          var it = item(S.model, k) || {};
          return '<div class="row" style="min-height:66px"><span class="dot"></span><div class="grow"><p style="font-size:16px;font-weight:600">' + esc(it.name) + '</p><p class="sub">' + esc(k) + ' · packed by ' + esc(whoShort(s.packed[k].by)) + '</p></div></div>';
        }).join('') + '</div>';
      }
      var backList = sortCodes(Object.keys(s.back)), extra = Object.keys(s.extra);
      h += '<div class="group" style="margin-top:12px;background:var(--card2)"><button class="row press" data-act="show-back"><span style="flex:1">Back</span><span class="muted">' + backList.length + '</span>' + ic('chev', 16) + '</button>' +
        (extra.length ? '<button class="row press" data-act="show-extra"><div class="grow"><p>Extra items</p><p class="sub">Came back but were not packed for this shoot</p></div><span class="muted">' + extra.length + '</span>' + ic('chev', 16) + '</button>' : '') + '</div>';
    }
    el.innerHTML = h;
    var fc = $('[data-foot-count]');
    if (fc && false) { var cc = counts(s); fc.textContent = S.view === 'pack' ? plural(cc.packed, 'item') + ' packed' : cc.back + ' of ' + cc.packed + ' back'; }
    bindSwipes();
  }

  function bindSwipes() {
    document.querySelectorAll('[data-swipe]').forEach(function (row) {
      var over = $('.over', row), sx = 0, sy = 0, dx = 0, open = false, holdT = null, dragging = false;
      over.addEventListener('pointerdown', function (e) {
        sx = e.clientX; sy = e.clientY; dx = 0; dragging = false;
        holdT = setTimeout(function () { if (!dragging) askRemove(row.dataset.swipe); }, 600);
      });
      over.addEventListener('pointermove', function (e) {
        if (!sx) return;
        var mx = e.clientX - sx, my = e.clientY - sy;
        if (!dragging && Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my)) { dragging = true; clearTimeout(holdT); try { over.setPointerCapture(e.pointerId); } catch (er) { } }
        if (Math.abs(my) > 10 && !dragging) clearTimeout(holdT);
        if (dragging) { dx = Math.min(0, Math.max(-120, mx + (open ? -96 : 0))); over.style.transition = 'none'; over.style.transform = 'translateX(' + dx + 'px)'; }
      });
      function end() {
        clearTimeout(holdT);
        if (dragging) { open = dx < -48; over.style.transition = ''; over.style.transform = open ? 'translateX(-96px)' : ''; }
        sx = 0; dragging = false;
      }
      over.addEventListener('pointerup', end); over.addEventListener('pointercancel', end);
    });
  }
  document.addEventListener('contextmenu', function (e) { if (e.target.closest('.swipe, .panel, .row, .card')) e.preventDefault(); });
  function askRemove(code) {
    var it = item(S.model, code) || {};
    vib(20);
    S.sheet = { type: 'remove', code: code, label: code + ' ' + (it.name || '') }; renderSheet();
  }

  /* ------------------------------------------------------------ camera */
  var Cam = { recent: {}, stream: null, track: null, worker: null, detector: null, timer: null, busy: false, n: 0, seen: {}, caps: {}, hwZoom: false, wake: null, canvas: null, ctx: null, jobs: {} };

  function camMsg(html) {
    var el = $('[data-cammsg]'); if (!el) return;
    if (!html) { el.hidden = true; return; }
    el.innerHTML = html; el.hidden = false;
  }
  function setLive(text, on) {
    var el = $('[data-live]'); if (!el) return;
    el.classList.toggle('off', !on); el.innerHTML = '<i></i>' + esc(text);
  }
  var hintShown = false;
  function hideHint() { if (hintShown) { hintShown = false; setLive('Camera on · keep scanning', true); } }

  function startCamera() {
    var video = $('.cam video'); if (!video) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camMsg('<span class="circ" style="background:var(--fill)">' + ic('camoff', 22) + '</span><b>This browser cannot use the camera</b><span class="muted small">Open the app in Safari on iPhone or Chrome on Android.</span>');
      setLive('Camera off', false); return;
    }
    stopStream();
    var base = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    var preferId = store.get('camId', '');
    var constraints = { audio: false, video: Object.assign(preferId ? { deviceId: { exact: preferId } } : { facingMode: { ideal: 'environment' } }, base) };
    navigator.mediaDevices.getUserMedia(constraints).catch(function (err) {
      if (preferId) { store.del('camId'); return navigator.mediaDevices.getUserMedia({ audio: false, video: Object.assign({ facingMode: { ideal: 'environment' } }, base) }); }
      throw err;
    }).then(function (stream) {
      return pickBestBackCamera(stream, base);
    }).then(function (stream) {
      if (!$('.cam video')) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      video = $('.cam video');
      Cam.stream = stream; Cam.track = stream.getVideoTracks()[0];
      video.srcObject = stream; video.muted = true; video.setAttribute('playsinline', '');
      var p = video.play(); if (p && p.catch) p.catch(function () { });
      Cam.caps = (Cam.track.getCapabilities && Cam.track.getCapabilities()) || {};
      if (Cam.caps.focusMode && Cam.caps.focusMode.indexOf('continuous') > -1) Cam.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () { });
      Cam.hwZoom = !!(Cam.caps.zoom && Cam.caps.zoom.max >= 1.5);
      var tb = $('[data-torch]'); if (tb) tb.hidden = !Cam.caps.torch; var tg = $('[data-torch-gap]'); if (tg) tg.hidden = !!Cam.caps.torch;
      applyZoom();
      camMsg(''); setLive('Camera on · keep scanning', true);
      S.lastScanAt = Date.now();
      setupDecoders().then(loop);
      keepAwake();
    }).catch(function (err) {
      var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      camMsg('<span class="circ" style="background:var(--fill)">' + ic('camoff', 22) + '</span><b>' + (denied ? 'Camera is off for this app' : 'Camera did not start') + '</b>' +
        '<span class="muted small" style="max-width:300px">' + (denied ? 'iPhone: Settings, Safari, Camera, Allow. Android: tap the lock next to the address, then allow Camera.' : 'Close other apps using the camera, then try again.') + '</span>' +
        '<button class="pill solid press" data-act="retry-cam">Try camera again</button>');
      setLive('Camera off', false);
    });
  }

  // iPhones with several back lenses expose a combined camera that switches to macro for close ups. Prefer it.
  function pickBestBackCamera(stream, base) {
    if (store.get('camId', '') || !navigator.mediaDevices.enumerateDevices) return Promise.resolve(stream);
    return navigator.mediaDevices.enumerateDevices().then(function (devs) {
      var cams = devs.filter(function (d) { return d.kind === 'videoinput'; });
      var best = cams.filter(function (d) { return /triple camera|dual wide camera|dual camera/i.test(d.label); })[0];
      var cur = stream.getVideoTracks()[0].getSettings().deviceId;
      if (!best || best.deviceId === cur) return stream;
      stream.getTracks().forEach(function (t) { t.stop(); });
      store.set('camId', best.deviceId);
      return navigator.mediaDevices.getUserMedia({ audio: false, video: Object.assign({ deviceId: { exact: best.deviceId } }, base) });
    }).catch(function () { return stream; });
  }

  function setupDecoders() {
    if (Cam.detector || Cam.worker) return Promise.resolve();
    var p = Promise.resolve();
    if ('BarcodeDetector' in window) {
      p = window.BarcodeDetector.getSupportedFormats().then(function (f) {
        if (f.indexOf('qr_code') > -1) Cam.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      }).catch(function () { });
    }
    return p.then(function () {
      if (!Cam.detector) {
        Cam.worker = new Worker('scan-worker.js');
        Cam.worker.onmessage = function (e) {
          var j = Cam.jobs[e.data.id]; delete Cam.jobs[e.data.id];
          Cam.busy = false;
          if (e.data.code) gotCode(e.data.code);
        };
      }
      Cam.canvas = document.createElement('canvas');
      Cam.ctx = Cam.canvas.getContext('2d', { willReadFrequently: true });
    });
  }

  function crop(video, frac, maxSide) {
    var vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return null;
    var side = Math.min(vw, vh) * frac, sx = (vw - side) / 2, sy = (vh - side) / 2;
    var out = Math.round(Math.min(side, maxSide));
    if (Cam.canvas.width !== out) { Cam.canvas.width = out; Cam.canvas.height = out; }
    Cam.ctx.drawImage(video, sx, sy, side, side, 0, 0, out, out);
    return out;
  }

  function loop() {
    clearTimeout(Cam.timer);
    var video = $('.cam video');
    if (!video || !Cam.stream) return;
    Cam.timer = setTimeout(loop, Cam.detector ? 110 : 90);
    if (Cam.busy || video.readyState < 2 || document.hidden || S.sheet) return;
    Cam.n++;
    var digital = S.zoom > 1 && !Cam.hwZoom;
    // alternate between a wide look and a tight centre crop so tiny stickers on memory cards still read
    var plan = digital ? [[0.5, 720], [0.3, 720]] : [[0.85, 720], [0.45, 720], [0.28, 600]];
    var step = plan[Cam.n % plan.length];
    try {
      if (Cam.detector) {
        Cam.busy = true;
        var src = (Cam.n % 2 === 0 && !digital) ? video : (crop(video, step[0], 900), Cam.canvas);
        Cam.detector.detect(src).then(function (codes) {
          Cam.busy = false;
          if (codes && codes.length) gotCode(codes[0].rawValue);
        }).catch(function () { Cam.busy = false; });
      } else if (Cam.worker) {
        var out = crop(video, step[0], step[1]); if (!out) return;
        var img = Cam.ctx.getImageData(0, 0, out, out);
        var id = Cam.n; Cam.jobs[id] = 1; Cam.busy = true;
        Cam.worker.postMessage({ id: id, w: out, h: out, data: img.data.buffer }, [img.data.buffer]);
        setTimeout(function () { if (Cam.jobs[id]) { delete Cam.jobs[id]; Cam.busy = false; } }, 1500);
      }
    } catch (e) { Cam.busy = false; }
    if (!hintShown && Date.now() - S.lastScanAt > 9000) {
      hintShown = true; setLive('Can’t read it? Hold 15 cm away or tap 2x', false);
      setTimeout(function () { if (hintShown) { S.lastScanAt = Date.now(); hideHint(); } }, 6000);
    }
  }

  function gotCode(raw) {
    var code = codeFromQr(raw), now = Date.now();
    if (!code) return;
    if (Cam.seen[code] && now - Cam.seen[code] < 2500) { Cam.seen[code] = now; return; }
    Cam.seen[code] = now;
    onScan(code);
  }
  function flashCam() {
    var f = $('[data-camflash]'); if (!f) return;
    f.classList.remove('on'); void f.offsetWidth; f.classList.add('on');
  }
  function flashFrame() {
    var f = $('.cam .frame'); if (!f) return;
    f.classList.add('hit'); setTimeout(function () { f.classList.remove('hit'); }, 350);
  }

  function applyZoom() {
    var video = $('.cam video'); if (!video) return;
    if (Cam.hwZoom && Cam.track) {
      var z = S.zoom > 1 ? Math.min(Cam.caps.zoom.max, 2) : Math.max(Cam.caps.zoom.min || 1, 1);
      Cam.track.applyConstraints({ advanced: [{ zoom: z }] }).catch(function () { });
      video.classList.remove('digital');
    } else {
      video.classList.toggle('digital', S.zoom > 1);
    }
    var cam = $('.cam'); if (cam) cam.classList.toggle('zoom', S.zoom > 1);
  }
  function toggleTorch() {
    if (!Cam.track || !Cam.caps.torch) return;
    S.torch = !S.torch;
    Cam.track.applyConstraints({ advanced: [{ torch: S.torch }] }).catch(function () { });
    var b = $('[data-torch]'); if (b) b.style.color = S.torch ? 'var(--accent)' : '';
  }
  function keepAwake() {
    try {
      if ('wakeLock' in navigator && !Cam.wake) navigator.wakeLock.request('screen').then(function (w) { Cam.wake = w; w.addEventListener('release', function () { Cam.wake = null; }); }).catch(function () { });
    } catch (e) { }
  }
  function stopStream() {
    clearTimeout(Cam.timer);
    if (Cam.stream) Cam.stream.getTracks().forEach(function (t) { t.stop(); });
    Cam.stream = null; Cam.track = null; Cam.busy = false; S.torch = false;
  }
  function stopCamera() {
    if (!mountedScanner) return;
    mountedScanner = '';
    stopStream();
    if (Cam.wake) { try { Cam.wake.release(); } catch (e) { } Cam.wake = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (mountedScanner) stopStream(); }
    else {
      if (mountedScanner && $('.cam video')) startCamera();
      if (S.token) { flush(); refresh(); }
    }
  });

  /* ------------------------------------------------------------ sheets */
  function sheetHead(title, closeAct) {
    return '<div class="sheet-head"><button class="circ press" style="background:rgba(255,255,255,.08)" data-act="' + (closeAct || 'close-sheet') + '" aria-label="Close">' + ic('x', 20) + '</button><span class="ttl">' + esc(title || '') + '</span><span style="width:44px"></span></div>';
  }
  function renderSheet() {
    var root = $('#sheet');
    var sh = S.sheet;
    if (!sh) { root.innerHTML = ''; return; }
    var s = currentSession(), h = '';
    if (sh.type === 'confirm') {
      var ci = item(S.model, sh.code) || {};
      var pk = sh.mode === 'pack';
      var lead = pk ? (sh.result === 'found' ? 'Found, it was missing' : 'Found') : (sh.result === 'back' ? 'Packed for this shoot' : (sh.otherName ? 'Extra, from ' + sh.otherName : 'Extra, not packed for this shoot'));
      root.innerHTML = '<div class="confirm glass" role="dialog" aria-label="Confirm scanned item">' +
        '<div style="display:flex;align-items:center;gap:12px"><span class="cf-id">' + esc(sh.code) + '</span><div style="flex:1;min-width:0"><p class="cf-name">' + esc(ci.name || '') + '</p>' +
        '<p class="muted small" style="margin:2px 0 0">' + esc((CAT_PLURAL[ci.cat] ? ci.cat : (ci.cat || '')) + ' · ' + lead) + '</p></div>' +
        '<button class="circ press" style="background:rgba(255,255,255,.08)" data-act="confirm-skip" aria-label="Skip this item">' + ic('x', 18) + '</button></div>' +
        '<div style="display:flex;gap:10px;margin-top:14px">' +
        (pk ? '<button class="cta press" data-act="confirm-add">' + ic('plus', 20, 2.4) + 'Add to this shoot</button>'
          : '<button class="btn2 press" style="flex:0 0 38%;color:var(--red)" data-act="confirm-damaged">Damaged</button><button class="cta press" style="flex:1" data-act="confirm-add">' + ic('check', 20, 2.6) + (sh.result === 'back' ? 'Back in' : 'Mark as extra') + '</button>') +
        '</div></div>';
      return;
    }
    if (sh.type === 'typein') {
      var pk2 = S.view === 'pack';
      var tit = sh.code ? item(S.model, sh.code) : null;
      h = sheetHead('Type the item ID') +
        '<p class="muted small" style="margin:8px 4px 0">Only when the sticker is lost or won\u2019t scan. It shows as typed in the report' + (pk2 ? '' : ', so the team can see it was not scanned') + '.</p>' +
        '<label class="sr" for="tid">Item ID</label><div class="field" style="margin-top:14px;background:rgba(255,255,255,.08)"><input id="tid" placeholder="e.g. 8-L" autocapitalize="characters" autocorrect="off" autocomplete="off" spellcheck="false" maxlength="8" value="' + esc(sh.code || '') + '" style="text-transform:uppercase;font-weight:700;letter-spacing:.04em"></div>' +
        '<p class="small" data-tmatch style="margin:8px 4px 0;min-height:18px;' + (sh.err ? 'color:var(--red)' : 'color:var(--muted)') + '">' + esc(sh.err || (tit ? tit.name + ' \u00b7 ' + tit.cat : '')) + '</p>' +
        '<p class="sec" style="margin-top:14px">Why are you typing it?</p><div style="display:flex;flex-wrap:wrap;gap:8px">' +
        ['Sticker missing', 'Sticker damaged', 'Sticker won\u2019t scan'].map(function (r) { return '<button class="pill press' + (sh.reason === r ? ' on' : '') + '" data-act="type-reason" data-r="' + esc(r) + '">' + (sh.reason === r ? ic('check', 16, 2.4) : '') + esc(r) + '</button>'; }).join('') + '</div>' +
        '<p class="muted small" style="margin:10px 4px 0">It goes on the sticker reprint list.</p>' +
        '<button class="cta press" style="margin-top:16px" data-act="type-save">' + (pk2 ? 'Add to this shoot' : 'Mark as back') + '</button>';
      root.innerHTML = '<div class="scrim" data-act="close-sheet"></div><div class="sheet glass" role="dialog" aria-modal="true">' + h + '</div>';
      var tin = $('#tid');
      tin.oninput = function () {
        tin.value = tin.value.toUpperCase().replace(/[^0-9A-Z-]/g, '');
        S.sheet.code = tin.value; S.sheet.err = '';
        var x = item(S.model, norm(tin.value)); var mt = $('[data-tmatch]');
        mt.style.color = 'var(--muted)'; mt.textContent = x ? x.name + ' \u00b7 ' + x.cat : (tin.value.length > 2 ? 'No item with this ID yet' : '');
      };
      if (!sh.code) setTimeout(function () { try { tin.focus(); } catch (e) { } }, 250);
      return;
    }
    if (sh.type === 'elsewhere') {
      var o = sh.other || {};
      h = '<div style="text-align:center;padding-top:10px"><span class="badge" style="background:rgba(var(--pack-rgb),.16);color:var(--pack)">' + ic('warn', 28) + '</span>' +
        '<h2 class="h2" style="margin-top:14px">' + esc(sh.label) + ' is out on another shoot</h2>' +
        '<p class="muted" style="margin:8px 0 0">It was packed for <b style="color:var(--text)">' + esc(o.name) + '</b>' + (o.by ? ' by ' + esc(first(o.by)) : '') + (o.since ? ' on ' + fmtDate(o.since) : '') + ' and never checked back.</p></div>' +
        '<button class="cta press" style="margin-top:22px;background:var(--pack)" data-act="move">Move it to this shoot</button>' +
        '<button class="btn2 press" style="margin-top:10px" data-act="close-sheet">Skip this item</button>' +
        '<p class="muted small" style="text-align:center;margin:14px 0 0">Moving it marks it back on ' + esc(o.name) + '.</p>';
    } else if (sh.type === 'done') {
      var codes = Object.keys(s.packed), kit = kitCodes(s), skipped = sortCodes(kit.filter(function (k) { return !s.packed[k]; }));
      h = sheetHead('Ready to head out?') +
        '<p style="margin:16px 0 0;text-align:center"><span class="big" style="font-size:36px">' + codes.length + '</span> <span class="muted" style="font-size:15px">' + (codes.length === 1 ? 'item' : 'items') + ' packed</span></p>' +
        '<p class="muted small" style="text-align:center;margin:4px 0 0">' + esc(catSummary(codes)) + '</p>';
      if (skipped.length) {
        h += '<p class="sec">From the past kit, not packed · ' + skipped.length + '</p><div class="group">' + skipped.slice(0, 8).map(function (k) {
          var it = item(S.model, k) || {}; return '<div class="row"><span class="id">' + esc(k) + '</span><span style="flex:1;min-width:0">' + esc(it.name) + '</span>' + chip('Not packed', 'grey') + '</div>';
        }).join('') + '</div><p class="muted small" style="margin:10px 4px 0">Not needed today? You can leave them.</p>';
      }
      h += codes.length ? '<button class="cta press" style="margin-top:18px" data-act="confirm-packing">Confirm packing</button>'
        : '<p class="err">Scan at least one item first.</p>';
      h += '<button class="link press" style="margin-top:4px" data-act="close-sheet">Keep scanning</button>';
    } else if (sh.type === 'finish') {
      var c = counts(s), missing = sortCodes(Object.keys(s.packed).filter(function (k) { return !s.back[k]; })), dmg = Object.keys(s.damaged);
      h = sheetHead('Finish checking') + '<div style="text-align:center;margin-top:10px"><span class="badge" style="background:rgba(var(--red-rgb),.16);color:var(--red)">' + ic('warn', 28) + '</span>' +
        '<h2 class="h2" style="margin-top:14px">' + plural(c.missing, 'item') + ' still missing</h2><p class="muted" style="margin:6px 0 0">Have one last look around before you leave.</p></div>' +
        '<div class="group" style="margin-top:16px">' + missing.slice(0, 6).map(function (k) { var it = item(S.model, k) || {}; return '<div class="row"><span class="id">' + esc(k) + '</span><span style="flex:1;min-width:0">' + esc(it.name) + '</span>' + chip('Missing', 'red') + '</div>'; }).join('') +
        dmg.slice(0, 3).map(function (k) { var it = item(S.model, k) || {}; return '<div class="row"><span class="id">' + esc(k) + '</span><span style="flex:1;min-width:0">' + esc(it.name) + '</span>' + chip('Damaged', 'red') + '</div>'; }).join('') + '</div>' +
        (Object.keys(s.typed || {}).length ? '<p class="small" style="margin:12px 4px 0;color:var(--pack)">' + plural(Object.keys(s.typed).length, 'item') + ' typed in by hand. The report lists them.</p>' : '') +
        '<button class="cta press" style="margin-top:18px" data-act="save-later">Save for now, finish at the office</button>' +
        '<button class="btn2 press" style="margin-top:10px" data-act="close-session">Close and send report</button>' +
        '<p class="muted small" style="text-align:center;margin:12px 0 0">Saving keeps this shoot open. Anyone can carry on checking later, on any phone. Close only when everything is done.</p>';
    } else if (sh.type === 'damaged') {
      var it2 = item(S.model, sh.code) || {};
      h = sheetHead('Mark as damaged') + '<p style="margin:16px 4px 0;font-size:17px;font-weight:700">' + esc(sh.code + ' · ' + (it2.name || '')) + '</p>' +
        '<label for="dn" class="sec" style="display:block;margin-top:14px">What happened? (optional)</label>' +
        '<textarea id="dn" class="note" rows="3" placeholder="Front element scratched">' + esc(sh.note || '') + '</textarea>' +
        '<label class="pill press" style="margin-top:10px">' + ic('photo', 16) + (sh.photo ? 'Photo added' : 'Add a photo') + '<input type="file" accept="image/*" capture="environment" data-photo hidden></label>' +
        (sh.photo ? '<img src="' + sh.photo + '" alt="Damage photo" style="display:block;margin-top:10px;max-height:140px;border-radius:14px">' : '') +
        '<button class="cta red press" style="margin-top:20px" data-act="save-damaged">Mark damaged</button>';
    } else if (sh.type === 'remove') {
      h = sheetHead('Remove item') + '<p style="margin:16px 4px 0;font-size:16px">Remove <b>' + esc(sh.label) + '</b> from this shoot?</p>' +
        '<button class="cta red press" style="margin-top:18px" data-act="remove" data-code="' + esc(sh.code) + '">Remove</button><button class="link press" data-act="close-sheet">Keep it</button>';
    } else if (sh.type === 'list') {
      h = sheetHead(sh.title) + '<div class="group" style="margin-top:12px">' + (sh.codes.length ? sh.codes.map(function (k) {
        var it = item(S.model, k) || {}; return '<div class="row"><span class="id">' + esc(k) + '</span><div class="grow"><p>' + esc(it.name) + '</p>' + (sh.subs && sh.subs[k] ? '<p class="sub">' + esc(sh.subs[k]) + '</p>' : '') + '</div>' + (s && s.typed && s.typed[k] ? chip('Typed', 'y') : '') + (s && s.damaged[k] ? chip('Damaged', 'red') : '') + '</div>';
      }).join('') : '<div class="empty">Nothing yet</div>') + '</div>';
    } else if (sh.type === 'menu') {
      var ss = s;
      h = sheetHead(ss.name) + '<div class="group" style="margin-top:12px">' +
        (ss.phase !== 'Closed' && ss.phase !== 'Checking' ? '<button class="row press" data-act="edit-items"><span style="flex:1">Add or remove items</span>' + ic('chev', 16) + '</button>' : '') +
        (ss.phase !== 'Closed' ? '<button class="row press" data-act="snooze"><span style="flex:1">Still shooting, remind me tomorrow</span></button>' : '') +
        (S.me.isAdmin ? '<button class="row press" data-act="ask-delete" style="color:var(--red)"><span style="flex:1">Delete this shoot</span>' + ic('trash', 18) + '</button>' : '') + '</div>';
    } else if (sh.type === 'delete') {
      h = sheetHead('Delete shoot') + '<p style="margin:16px 4px 0;font-size:15px">Delete <b>' + esc(s.name) + '</b>? All its scans are removed and every item goes back to In. This cannot be undone.</p>' +
        '<button class="cta red press" style="margin-top:18px" data-act="delete-session">Delete shoot</button><button class="link press" data-act="close-sheet">Keep it</button>';
    } else if (sh.type === 'account') {
      h = sheetHead('Account') + '<div class="group" style="margin-top:12px"><div class="row"><span class="muted" style="flex:1">Name</span><span>' + esc(S.me.name) + '</span></div>' +
        '<div class="row"><span class="muted" style="flex:1">Email</span><span>' + esc(S.me.email) + '</span></div>' +
        (S.me.isAdmin ? '<div class="row"><span class="muted" style="flex:1">Emails</span><span>' + (S.model.testMode ? 'Test mode, only you' : 'Team gets CC') + '</span></div>' : '') + '</div>' +
        '<button class="btn2 press" style="margin-top:14px" data-act="refresh">Refresh data</button>' +
        '<button class="link press" style="color:var(--red);margin-top:6px" data-act="signout">Sign out</button>';
    }
    root.innerHTML = '<div class="scrim" data-act="close-sheet"></div><div class="sheet glass" role="dialog" aria-modal="true">' + h + '</div>';
    var photo = $('[data-photo]', root);
    if (photo) photo.onchange = function () { readPhoto(photo.files[0]); };
  }
  function openDamaged(sid, code) { S.sheet = { type: 'damaged', sid: sid, code: code, note: '', photo: '' }; renderSheet(); }
  function readPhoto(file) {
    if (!file) return;
    var img = new Image(), url = URL.createObjectURL(file);
    img.onload = function () {
      var max = 1280, w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
      var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      S.sheet.note = ($('#dn') || {}).value || '';
      S.sheet.photo = c.toDataURL('image/jpeg', 0.75);
      URL.revokeObjectURL(url); renderSheet();
    };
    img.src = url;
  }

  /* ------------------------------------------------------------ actions */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    var a = el.dataset.act, s = currentSession();
    switch (a) {
      case 'tab': goTab(el.dataset.tab); break;
      case 'new': openNew(''); break;
      case 'back': try { history.back(); } catch (er) { goBack(); } break;
      case 'account': S.sheet = { type: 'account' }; renderSheet(); break;
      case 'signout': signOut(false); break;
      case 'refresh': S.sheet = null; renderSheet(); refresh().then(function () { toast({ title: 'Up to date', kind: 'grey', ms: 1500 }); }); break;
      case 'close-sheet': S.sheet = null; renderSheet(); break;
      case 'confirm-add': confirmScan('add'); break;
      case 'type-open': S.sheet = { type: 'typein', code: '', reason: '', err: '' }; renderSheet(); break;
      case 'type-reason': S.sheet.code = ($('#tid') || {}).value || S.sheet.code; S.sheet.reason = el.dataset.r; S.sheet.err = ''; renderSheet(); break;
      case 'type-save': saveTyped(); break;
      case 'clear-reprint': {
        var ids = S.model.items.filter(function (x) { return x.reprint; }).map(function (x) { return x.id; });
        enqueue({ type: 'clearReprint', body: { ids: ids } }); render();
        toast({ title: 'Reprint list cleared', kind: 'grey' }); break;
      }
      case 'confirm-damaged': confirmScan('damaged'); break;
      case 'confirm-skip':
        if (S.sheet && S.sheet.code) Cam.seen[S.sheet.code] = Date.now();
        S.sheet = null; renderSheet(); break;
      case 'si-back': S.signin.step = 'email'; S.signin.err = ''; store.del('signinStep'); render(); break;
      case 'si-resend': sendCode(S.signin.email); break;
      case 'si-verify': verify(($('#otp') || {}).value); break;
      case 'open': {
        var t = sess(S.model, el.dataset.sid); S.sid = t.id;
        if (t.phase === 'Packing') go('pack', { sid: t.id });
        else if (t.phase === 'Checking') go('check', { sid: t.id });
        else if (t.phase === 'Out') { enqueue({ type: 'startCheck', body: { sessionId: t.id } }); go('check', { sid: t.id }); }
        else go('session', { sid: t.id });
        break;
      }
      case 'open-detail': go('session', { sid: el.dataset.sid }); break;
      case 'ifilter': S.filters.items = el.dataset.f; render(); break;
      case 'hfilter': S.filters.history = el.dataset.f; render(); break;
      case 'resend':
        call('resend', { sessionId: el.dataset.sid }).then(function (j) { toast(j.ok ? { title: 'Report sent again', kind: 'ok' } : { title: 'Could not send', sub: j.error, kind: 'red' }); })
          .catch(function () { toast({ title: 'No connection', sub: 'Try again when you have signal', kind: 'red' }); });
        break;
      case 'pack-again': openNew(el.dataset.sid); break;
      case 'team': {
        var em = el.dataset.email, i = S.form.team.indexOf(em);
        S.form.name = $('#nm').value; S.form.shootDate = $('#dt').value;
        if (i > -1) { if (!isMe(em)) S.form.team.splice(i, 1); } else S.form.team.push(em);
        var sc = $('.view').scrollTop; render(); $('.view').scrollTop = sc; break;
      }
      case 'kit': {
        S.form.name = $('#nm').value; S.form.shootDate = $('#dt').value; S.form.basedOn = el.dataset.sid;
        var k = sess(S.model, el.dataset.sid);
        if (k && !S.form.name) S.form.name = k.name;
        var sc2 = $('.view').scrollTop; render(); $('.view').scrollTop = sc2; break;
      }
      case 'create': createSession(); break;
      case 'leave': S.stack = []; S.view = 'home'; S.tab = 'home'; S.sheet = null; render(); break;
      case 'done-packing': S.sheet = { type: 'done' }; renderSheet(); break;
      case 'confirm-packing':
        enqueue({ type: 'confirmPacking', body: { sessionId: s.id } });
        S.sheet = null; S.stack = [{ view: 'home', tab: 'home' }]; go('session', { sid: s.id }, true);
        toast({ title: 'Packing confirmed', sub: 'Have a good shoot', kind: 'ok' });
        break;
      case 'edit-items': S.sheet = null; S.packTab = 'scanned'; go('pack', { sid: s.id }); break;
      case 'check':
        enqueue({ type: 'startCheck', body: { sessionId: s.id } });
        go('check', { sid: s.id }); break;
      case 'ptab': S.packTab = el.dataset.t; renderScanPanel(); break;
      case 'zoom': S.zoom = S.zoom > 1 ? 1 : 2; applyZoom(); renderScanPanel(); break;
      case 'torch': toggleTorch(); break;
      case 'retry-cam': startCamera(); break;
      case 'remove':
        enqueue({ type: 'remove', body: { sessionId: s.id, itemId: el.dataset.code } });
        S.sheet = null; renderSheet(); renderScanPanel();
        toast({ title: el.dataset.code + ' removed', kind: 'grey', ms: 2000 });
        break;
      case 'move': {
        var sh = S.sheet; S.sheet = null; renderSheet();
        feedback('good'); flashFrame();
        enqueue({ type: 'scan', body: { sessionId: sh.sid, itemId: sh.code, mode: 'pack', move: true, clientId: uid() } });
        toast({ title: sh.code + ' moved to this shoot', sub: 'Marked back on ' + (sh.other && sh.other.name || 'the other shoot'), kind: 'ok' });
        renderScanPanel(); break;
      }
      case 'finish': {
        var c = counts(s);
        if (!c.missing) { go('allback', { sid: s.id }); }
        else { S.sheet = { type: 'finish' }; renderSheet(); }
        break;
      }
      case 'save-later':
        S.sheet = null; S.stack = []; S.view = 'home'; S.tab = 'home'; render();
        toast({ title: 'Saved', sub: 'Carry on checking from Shoots any time, on any phone', kind: 'grey' });
        break;
      case 'close-session':
        enqueue({ type: 'close', body: { sessionId: s.id } });
        S.sheet = null; S.stack = []; S.view = 'home'; S.tab = 'home'; render();
        if (!S.online) toast({ title: 'Shoot closed', sub: 'The report sends when you have signal', kind: 'sync' });
        break;
      case 'save-damaged': {
        var sh2 = S.sheet, note = ($('#dn').value || '').trim();
        enqueue({ type: 'damaged', body: { sessionId: sh2.sid, itemId: sh2.code, note: note || 'Damaged', photo: sh2.photo || '' } });
        S.sheet = null; renderSheet(); renderScanPanel();
        toast({ title: sh2.code + ' marked damaged', sub: 'It goes in the report', kind: 'warn' });
        break;
      }
      case 'show-back': S.sheet = { type: 'list', title: 'Back', codes: sortCodes(Object.keys(s.back)) }; renderSheet(); break;
      case 'show-extra': {
        var subs = {}; Object.keys(s.extra).forEach(function (k) { subs[k] = s.extra[k].note || 'Not packed for this shoot'; });
        S.sheet = { type: 'list', title: 'Extra items', codes: sortCodes(Object.keys(s.extra)), subs: subs }; renderSheet(); break;
      }
      case 'menu': S.sheet = { type: 'menu' }; renderSheet(); break;
      case 'snooze': enqueue({ type: 'snooze', body: { sessionId: s.id } }); S.sheet = null; renderSheet(); toast({ title: 'Okay, we will remind you tomorrow', kind: 'grey' }); break;
      case 'ask-delete': S.sheet = { type: 'delete' }; renderSheet(); break;
      case 'delete-session':
        enqueue({ type: 'deleteSession', body: { sessionId: s.id } });
        S.sheet = null; S.stack = []; S.view = 'home'; S.tab = 'home'; render();
        toast({ title: 'Shoot deleted', kind: 'grey' });
        break;
    }
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'q') {
      S.filters.q = e.target.value;
      var pos = e.target.selectionStart; render();
      var q = $('#q'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (er) { } }
    }
  });

  /* ------------------------------------------------------------ boot */
  function boot() {
    app = $('#app');
    if (!API) {
      app.innerHTML = '<div class="view"><div class="empty" style="margin-top:20vh"><b>Almost ready</b>The app is not connected to the Google Sheet yet.</div></div>';
      return;
    }
    rebuildModel();
    render();
    if (S.token) { flush(); refresh(); }
    // faster refresh while scanning so scans from other phones on the same shoot show up quickly
    var lastRefresh = 0;
    setInterval(function () {
      var scanning = S.view === 'pack' || S.view === 'check';
      if (S.token && !document.hidden && !S.queue.length && Date.now() - lastRefresh > (scanning ? 6000 : 20000)) { lastRefresh = Date.now(); refresh(); }
    }, 2000);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { });
  }
  boot();
})();
