/**
 * EyeStudio Equipment Tracker API (Apps Script backend)
 * Front end: GitHub Pages. Data: a copy of eqtrackerbuildv3-3.
 * Run setup() once from the editor, then deploy as a web app:
 *   Execute as: Me    Who has access: Anyone
 */

var ORIGINAL_SHEET = '1DanwYhNexdTwyrodSTkhnVmiVQyrAP11azCw1UIWQC0';
var MAIN_FOLDER = '1Y8n0HlHOxmAzCgtJyEXbIfEYfwCJtqw4';
var DOMAIN = 'eyestudio.ae';
var ADMIN_EMAIL = 'chamath@eyestudio.ae';
var TOKEN_DAYS = 365;
var REMIND_AFTER_HOURS = 24;

var COLS = {
  Items: ['ItemID', 'Name', 'Category', 'Brand', 'Condition', 'Notes', 'Status', 'Session', 'LastSeen', 'Reprint'],
  People: ['Email', 'Name', 'IsAdmin'],
  Sessions: ['SessionID', 'ShootName', 'ShootDate', 'ReturnDate', 'BasedOn', 'PackedBy', 'Team', 'Phase', 'Created',
    'PackedAt', 'ClosedAt', 'ClosedBy', 'SendReport', 'ReportSent', 'ReminderSent', 'CheckStartedAt', 'SnoozeUntil', 'ReportUrl'],
  Scans: ['ScanID', 'Timestamp', 'Item', 'Session', 'Direction', 'ScannedBy', 'Damaged', 'Note', 'ClientID', 'Method']
};

function P() { return PropertiesService.getScriptProperties(); }
function prop(k) { return P().getProperty(k); }
function testMode() { return prop('TEST_MODE') !== 'false'; }

/* ------------------------------------------------------------------ setup */

function setup() {
  var props = P();
  if (!props.getProperty('SHEET_ID')) {
    var folder = DriveApp.getFolderById(MAIN_FOLDER);
    var copy = DriveApp.getFileById(ORIGINAL_SHEET).makeCopy('Equipment Tracker App (data)', folder);
    props.setProperty('SHEET_ID', copy.getId());
    var ssNew = SpreadsheetApp.openById(copy.getId());
    ['Sessions', 'Scans'].forEach(function (n) {
      var sh = ssNew.getSheetByName(n);
      if (sh && sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getMaxColumns()).clearContent();
    });
  }
  if (!props.getProperty('SECRET')) props.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  if (!props.getProperty('TEST_MODE')) props.setProperty('TEST_MODE', 'true');
  if (!props.getProperty('REPORTS_FOLDER')) {
    var f = DriveApp.getFolderById(MAIN_FOLDER).createFolder('App Reports');
    props.setProperty('REPORTS_FOLDER', f.getId());
  }
  var ss = book();
  Object.keys(COLS).forEach(function (n) { ensureCols(ss, n, COLS[n]); });
  // every item starts In unless already set
  var t = table('Items');
  t.rows.forEach(function (r) { if (!r.Status) setCell(t, r, 'Status', 'In'); });
  ScriptApp.getProjectTriggers().forEach(function (tr) { ScriptApp.deleteTrigger(tr); });
  ScriptApp.newTrigger('hourly').timeBased().everyHours(1).create();
  // touch MailApp so its permission is granted during setup
  MailApp.getRemainingDailyQuota();
  return 'Setup done. Data sheet: https://docs.google.com/spreadsheets/d/' + props.getProperty('SHEET_ID');
}

/** Run this when testing is finished: reports and reminders then CC the team. */
function goLive() { P().setProperty('TEST_MODE', 'false'); return 'Live: team now gets CC on reports and reminders.'; }
function backToTestMode() { P().setProperty('TEST_MODE', 'true'); return 'Test mode: emails only go to ' + ADMIN_EMAIL; }

function ensureCols(ss, name, cols) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  cols.forEach(function (c) {
    if (head.indexOf(c) === -1) {
      head = head.filter(function (h) { return h !== ''; });
      head.push(c);
      sh.getRange(1, head.length).setValue(c).setFontWeight('bold');
    }
  });
  sh.setFrozenRows(1);
}

/* ------------------------------------------------------------- sheet io */

var _book = null;
function book() { return _book || (_book = SpreadsheetApp.openById(prop('SHEET_ID'))); }

function table(name) {
  var sh = book().getSheetByName(name);
  var values = sh.getDataRange().getValues();
  var head = values[0].map(String);
  var idx = {};
  head.forEach(function (h, i) { if (h) idx[h] = i; });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var v = values[i];
    if (v.join('') === '') continue;
    var o = { _r: i + 1 };
    head.forEach(function (h, j) { if (h) o[h] = v[j]; });
    rows.push(o);
  }
  return { sh: sh, head: head, idx: idx, rows: rows };
}

function append(t, obj) {
  var row = t.head.map(function (h) { return obj[h] === undefined ? '' : obj[h]; });
  t.sh.appendRow(row);
  obj._r = t.sh.getLastRow();
  t.rows.push(obj);
  return obj;
}

function setCell(t, row, col, val) {
  var c = t.idx[col];
  if (c === undefined) throw new Error('Missing column ' + col);
  t.sh.getRange(row._r, c + 1).setValue(val);
  row[col] = val;
}

function iso(v) { return v instanceof Date ? v.toISOString() : (v || ''); }
function dateOnly(v) {
  if (!v) return '';
  var d = v instanceof Date ? v : new Date(v);
  return Utilities.formatDate(d, 'Asia/Dubai', 'yyyy-MM-dd');
}
function truthy(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function norm(id) { return String(id || '').trim().toUpperCase(); }

/* ---------------------------------------------------------------- auth */

function sign(payload) {
  var sig = Utilities.computeHmacSha256Signature(payload, prop('SECRET'));
  return Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '');
}

function makeToken(email) {
  var payload = Utilities.base64EncodeWebSafe(JSON.stringify({ e: email, x: Date.now() + TOKEN_DAYS * 864e5 })).replace(/=+$/, '');
  return payload + '.' + sign(payload);
}

function readToken(token) {
  if (!token) return null;
  var parts = String(token).split('.');
  if (parts.length !== 2 || sign(parts[0]) !== parts[1]) return null;
  var pad = parts[0] + '==='.slice((parts[0].length + 3) % 4);
  var data = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(pad)).getDataAsString());
  if (!data.x || data.x < Date.now()) return null;
  return person(data.e);
}

function people() {
  return table('People').rows.filter(function (r) { return r.Email; }).map(function (r) {
    return { email: String(r.Email).trim().toLowerCase(), name: String(r.Name || r.Email).trim(), isAdmin: truthy(r.IsAdmin) };
  });
}
function person(email) {
  email = String(email || '').trim().toLowerCase();
  return people().filter(function (p) { return p.email === email; })[0] || null;
}

function requestCode(email) {
  email = String(email || '').trim().toLowerCase();
  if (email.indexOf('@') === -1) email = email + '@' + DOMAIN;
  if (email.split('@')[1] !== DOMAIN) return { ok: false, error: 'Use your ' + DOMAIN + ' email.' };
  var p = person(email);
  if (!p) return { ok: false, error: 'This email is not on the team list. Ask Chamath to add you.' };
  var cache = CacheService.getScriptCache();
  var countKey = 'cnt:' + email;
  var count = Number(cache.get(countKey) || 0);
  if (count >= 5) return { ok: false, error: 'Too many codes asked for. Try again in an hour.' };
  cache.put(countKey, String(count + 1), 3600);
  var code = String(Math.floor(100000 + Math.random() * 900000));
  cache.put('code:' + email, sign(code + email), 600);
  cache.remove('tries:' + email);
  MailApp.sendEmail({
    to: email,
    subject: 'Your Equipment Tracker code: ' + code,
    htmlBody: '<div style="font-family:Arial,sans-serif;font-size:15px;color:#111">Hi ' + p.name +
      ',<br><br>Your sign in code is<br><div style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:12px 0">' + code +
      '</div>It works for 10 minutes. If you did not ask for it, you can ignore this email.<br><br>EyeStudio Equipment Tracker</div>',
    name: 'EyeStudio Equipment Tracker'
  });
  return { ok: true, email: email };
}

function verifyCode(email, code) {
  email = String(email || '').trim().toLowerCase();
  var cache = CacheService.getScriptCache();
  var tries = Number(cache.get('tries:' + email) || 0);
  if (tries >= 5) return { ok: false, error: 'Too many wrong codes. Ask for a new one.' };
  var stored = cache.get('code:' + email);
  if (!stored || stored !== sign(String(code).trim() + email)) {
    cache.put('tries:' + email, String(tries + 1), 600);
    return { ok: false, error: stored ? 'That code is not right. Check the email and try again.' : 'That code has expired. Ask for a new one.' };
  }
  cache.remove('code:' + email);
  var p = person(email);
  if (!p) return { ok: false, error: 'This email is not on the team list.' };
  return { ok: true, token: makeToken(p.email), me: p };
}

/* ------------------------------------------------------------- web app */

function doGet(e) {
  var a = e && e.parameter && e.parameter.a;
  if (a === 'snooze') return snoozeFromEmail(e.parameter.s, e.parameter.sig);
  return json({ ok: true, app: 'EyeStudio Equipment Tracker API' });
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'Bad request' }); }
  try {
    if (body.action === 'requestCode') return json(requestCode(body.email));
    if (body.action === 'verifyCode') return json(verifyCode(body.email, body.code));
    var me = readToken(body.token);
    if (!me) return json({ ok: false, error: 'signin', message: 'Please sign in again.' });
    var fn = ACTIONS[body.action];
    if (!fn) return json({ ok: false, error: 'Unknown action' });
    var lock = LockService.getScriptLock();
    if (body.action !== 'state') lock.waitLock(20000);
    try {
      var out = fn(me, body) || {};
      out.ok = out.ok !== false;
      return json(out);
    } finally { if (body.action !== 'state') lock.releaseLock(); }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

var ACTIONS = {
  state: function (me) { return { state: buildState(me) }; },
  createSession: createSession,
  scan: scanItem,
  remove: removeItem,
  confirmPacking: confirmPacking,
  startCheck: startCheck,
  damaged: markDamaged,
  close: closeSession,
  resend: resendReport,
  clearReprint: clearReprint,
  deleteSession: deleteSession,
  snooze: function (me, b) { var t = table('Sessions'); var s = findSession(t, b.sessionId); setCell(t, s, 'SnoozeUntil', new Date(Date.now() + 864e5)); return {}; }
};

/* ---------------------------------------------------------- domain logic */

function findSession(t, id) {
  var s = t.rows.filter(function (r) { return String(r.SessionID) === String(id); })[0];
  if (!s) throw new Error('Session not found');
  return s;
}

function itemMap(t) {
  var m = {};
  t.rows.forEach(function (r) { if (r.ItemID) m[norm(r.ItemID)] = r; });
  return m;
}

function nameOf(email) {
  var p = person(email);
  return p ? p.name : String(email || '').split('@')[0];
}

function addToTeam(st, s, email) {
  var team = String(s.Team || '').split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(String);
  if (team.indexOf(email) === -1) { team.push(email); setCell(st, s, 'Team', team.join(', ')); }
}

function scanRow(scans, o) {
  return append(scans, {
    ScanID: Utilities.getUuid().slice(0, 8), Timestamp: new Date(), Item: o.item, Session: o.session,
    Direction: o.dir, ScannedBy: o.by, Damaged: false, Note: o.note || '', ClientID: o.clientId || '', Method: o.method || ''
  });
}

function sessionSummary(s, scans) {
  var id = String(s.SessionID);
  var packed = {}, back = {}, extra = {}, damaged = {}, damagedBy = {}, typed = {}, log = [];
  scans.rows.forEach(function (r) {
    if (String(r.Session) !== id) return;
    var it = norm(r.Item);
    var d = String(r.Direction);
    if (d === 'OUT') packed[it] = { by: r.ScannedBy, at: iso(r.Timestamp) };
    if (d === 'REMOVED') delete packed[it];
    if (d === 'IN') back[it] = { by: r.ScannedBy, at: iso(r.Timestamp), note: r.Note };
    if (d === 'EXTRA') extra[it] = { by: r.ScannedBy, at: iso(r.Timestamp), note: r.Note };
    if (truthy(r.Damaged)) damaged[it] = r.Note || 'Damaged';
    var how = String(r.Method || '').indexOf('Typed') === 0 ? String(r.Method).replace(/^Typed:\s*/, '') : '';
    if (how && d === 'OUT') packed[it].typed = how;
    if (how && d === 'IN') back[it].typed = how;
    if (how && d === 'EXTRA') extra[it].typed = how;
    if (truthy(r.Damaged)) damagedBy[it] = r.ScannedBy;
    if (how && (d === 'OUT' || d === 'IN' || d === 'EXTRA')) typed[it] = { by: r.ScannedBy, at: iso(r.Timestamp), reason: String(r.Method).replace(/^Typed:\s*/, ''), step: d === 'OUT' ? 'packing' : 'checking back' };
    log.push({ item: it, dir: d, by: r.ScannedBy, at: iso(r.Timestamp) });
  });
  return { packed: packed, back: back, extra: extra, damaged: damaged, damagedBy: damagedBy, typed: typed, log: log };
}

function dueTime(s) {
  var base = s.PackedAt instanceof Date ? s.PackedAt.getTime() : (s.Created instanceof Date ? s.Created.getTime() : Date.now());
  if (s.ShootDate instanceof Date) {
    var shoot = new Date(s.ShootDate.getTime()); shoot.setHours(9, 0, 0, 0);
    base = Math.max(base, shoot.getTime());
  }
  var due = base + REMIND_AFTER_HOURS * 36e5;
  if (s.SnoozeUntil instanceof Date) due = Math.max(due, s.SnoozeUntil.getTime());
  return due;
}

function buildState(me) {
  var items = table('Items'), st = table('Sessions'), scans = table('Scans');
  var cutoff = Date.now() - 120 * 864e5;
  var sessions = st.rows.filter(function (s) {
    if (!s.SessionID) return false;
    if (s.Phase !== 'Closed') return true;
    return s.ClosedAt instanceof Date ? s.ClosedAt.getTime() > cutoff : true;
  }).map(function (s) {
    var sum = sessionSummary(s, scans);
    var due = dueTime(s);
    return {
      id: String(s.SessionID), name: s.ShootName, shootDate: dateOnly(s.ShootDate), basedOn: s.BasedOn || '',
      packedBy: s.PackedBy, team: String(s.Team || '').split(',').map(function (x) { return x.trim(); }).filter(String),
      phase: s.Phase, created: iso(s.Created), packedAt: iso(s.PackedAt), closedAt: iso(s.ClosedAt), closedBy: s.ClosedBy || '',
      reportUrl: s.ReportUrl || '', due: new Date(due).toISOString(), overdue: s.Phase !== 'Closed' && s.Phase !== 'Packing' && Date.now() > due,
      packed: sum.packed, back: sum.back, extra: sum.extra, damaged: sum.damaged, typed: sum.typed
    };
  }).sort(function (a, b) { return (b.created || '').localeCompare(a.created || ''); });
  return {
    me: me, now: new Date().toISOString(), testMode: testMode(),
    people: people(),
    items: items.rows.filter(function (r) { return r.ItemID; }).map(function (r) {
      return { id: norm(r.ItemID), name: r.Name, cat: r.Category, cond: r.Condition || 'OK', status: r.Status || 'In', session: String(r.Session || ''), reprint: truthy(r.Reprint), lastSeen: iso(r.LastSeen) };
    }),
    sessions: sessions
  };
}

function createSession(me, b) {
  var st = table('Sessions');
  var name = String(b.name || '').trim();
  if (!name) throw new Error('Give the shoot a name.');
  var id = String(b.id || '');
  if (!/^S[0-9A-Z-]{4,24}$/.test(id)) id = 'S' + Utilities.formatDate(new Date(), 'Asia/Dubai', 'yyMMdd') + '-' + Utilities.getUuid().slice(0, 4).toUpperCase();
  if (st.rows.some(function (r) { return String(r.SessionID) === id; })) return { sessionId: id };
  var team = (b.team || []).map(function (x) { return String(x).toLowerCase(); });
  if (team.indexOf(me.email) === -1) team.unshift(me.email);
  var shoot = b.shootDate ? new Date(b.shootDate + 'T00:00:00') : new Date();
  append(st, {
    SessionID: id, ShootName: name, ShootDate: shoot, ReturnDate: '', BasedOn: b.basedOn || '', PackedBy: me.email,
    Team: team.join(', '), Phase: 'Packing', Created: new Date(), PackedAt: '', ClosedAt: '', ClosedBy: '',
    SendReport: '', ReportSent: '', ReminderSent: '', CheckStartedAt: '', SnoozeUntil: '', ReportUrl: ''
  });
  return { sessionId: id };
}

function scanItem(me, b) {
  var items = table('Items'), st = table('Sessions'), scans = table('Scans');
  var s = findSession(st, b.sessionId);
  var code = norm(b.itemId);
  var m = itemMap(items);
  var it = m[code];
  if (!it) return { result: 'unknown', code: code };
  if (b.clientId && scans.rows.some(function (r) { return String(r.ClientID) === String(b.clientId); })) return { result: 'dup', item: code };
  var sid = String(s.SessionID);
  var label = code + ' ' + it.Name;
  if (s.Phase === 'Closed') return { result: 'closed' };
  var method = b.typed ? 'Typed: ' + String(b.reason || 'No reason given').slice(0, 60) : 'Scanned';

  if (b.mode === 'pack') {
    if (String(it.Condition) === 'Out of service') return { result: 'oos', item: code, label: label };
    if (it.Status === 'Out' && String(it.Session) === sid) return { result: 'already', item: code, label: label };
    if (it.Status === 'Out' && String(it.Session) !== sid) {
      var other = st.rows.filter(function (r) { return String(r.SessionID) === String(it.Session); })[0];
      if (!b.move) return { result: 'elsewhere', item: code, label: label, other: other ? { id: String(other.SessionID), name: other.ShootName, by: nameOf(other.PackedBy), since: iso(other.PackedAt || other.Created) } : null };
      scanRow(scans, { item: code, session: it.Session, dir: 'IN', by: me.email, note: 'Moved to ' + s.ShootName });
    }
    var found = it.Status === 'Missing';
    if (found) scanRow(scans, { item: code, session: it.Session, dir: 'IN', by: me.email, note: 'Found while packing ' + s.ShootName });
    scanRow(scans, { item: code, session: sid, dir: 'OUT', by: me.email, clientId: b.clientId, method: method });
    markSticker(items, it, b);
    setCell(items, it, 'Status', 'Out'); setCell(items, it, 'Session', sid); setCell(items, it, 'LastSeen', new Date());
    addToTeam(st, s, me.email);
    if (found) notifyFound(it, me);
    return { result: b.move ? 'moved' : (found ? 'found' : 'added'), item: code, label: label };
  }

  // checking gear back
  if (s.Phase === 'Packing' || s.Phase === 'Out') { setCell(st, s, 'Phase', 'Checking'); if (!s.CheckStartedAt) setCell(st, s, 'CheckStartedAt', new Date()); }
  var sum = sessionSummary(s, scans);
  if (sum.back[code] || sum.extra[code]) return { result: 'already', item: code, label: label };
  addToTeam(st, s, me.email);
  if (it.Status === 'Out' && String(it.Session) === sid) {
    scanRow(scans, { item: code, session: sid, dir: 'IN', by: me.email, clientId: b.clientId, method: method });
    markSticker(items, it, b);
    setCell(items, it, 'Status', 'In'); setCell(items, it, 'Session', ''); setCell(items, it, 'LastSeen', new Date());
    return { result: 'back', item: code, label: label };
  }
  var otherName = '';
  if ((it.Status === 'Out' || it.Status === 'Missing') && it.Session) {
    var o = st.rows.filter(function (r) { return String(r.SessionID) === String(it.Session); })[0];
    otherName = o ? o.ShootName : '';
    scanRow(scans, { item: code, session: it.Session, dir: 'IN', by: me.email, note: 'Came back with ' + s.ShootName });
    if (it.Status === 'Missing') notifyFound(it, me);
  }
  scanRow(scans, { item: code, session: sid, dir: 'EXTRA', by: me.email, clientId: b.clientId, note: otherName ? 'From ' + otherName : '', method: method });
  markSticker(items, it, b);
  setCell(items, it, 'Status', 'In'); setCell(items, it, 'Session', ''); setCell(items, it, 'LastSeen', new Date());
  return { result: otherName ? 'extra_other' : 'extra', item: code, label: label, otherName: otherName };
}

function removeItem(me, b) {
  var items = table('Items'), st = table('Sessions'), scans = table('Scans');
  var s = findSession(st, b.sessionId);
  var it = itemMap(items)[norm(b.itemId)];
  if (!it || String(it.Session) !== String(s.SessionID)) return { result: 'notinsession' };
  scanRow(scans, { item: norm(b.itemId), session: String(s.SessionID), dir: 'REMOVED', by: me.email });
  setCell(items, it, 'Status', 'In'); setCell(items, it, 'Session', '');
  return { result: 'removed' };
}

function confirmPacking(me, b) {
  var st = table('Sessions'), scans = table('Scans');
  var s = findSession(st, b.sessionId);
  var sum = sessionSummary(s, scans);
  if (!Object.keys(sum.packed).length) return { ok: false, error: 'Scan at least one item first.' };
  var firstConfirm = s.Phase === 'Packing';
  if (s.Phase === 'Packing') setCell(st, s, 'Phase', 'Out');
  if (!s.PackedAt) setCell(st, s, 'PackedAt', new Date());
  if (firstConfirm) { try { sendPackedEmail(s, table('Items'), scans, me); } catch (e) { console.error(e); } }
  return {};
}

function startCheck(me, b) {
  var st = table('Sessions');
  var s = findSession(st, b.sessionId);
  if (s.Phase === 'Packing' || s.Phase === 'Out') { setCell(st, s, 'Phase', 'Checking'); setCell(st, s, 'CheckStartedAt', new Date()); }
  return {};
}

function markDamaged(me, b) {
  var scans = table('Scans'), items = table('Items');
  var code = norm(b.itemId);
  var rows = scans.rows.filter(function (r) { return String(r.Session) === String(b.sessionId) && norm(r.Item) === code && (r.Direction === 'IN' || r.Direction === 'EXTRA'); });
  if (!rows.length) return { ok: false, error: 'Scan the item back first.' };
  var r = rows[rows.length - 1];
  var note = String(b.note || 'Damaged').slice(0, 500) + ' (by ' + nameOf(me.email) + ')';
  if (b.photo && /^data:image\/(jpeg|png);base64,/.test(b.photo) && b.photo.length < 4e6) {
    var bytes = Utilities.base64Decode(b.photo.split(',')[1]);
    var blob = Utilities.newBlob(bytes, 'image/jpeg', code + ' damage ' + Utilities.formatDate(new Date(), 'Asia/Dubai', 'yyyy-MM-dd HHmm') + '.jpg');
    var f = photosFolder().createFile(blob);
    note += ' Photo: ' + f.getUrl();
  }
  setCell(scans, r, 'Damaged', true);
  setCell(scans, r, 'Note', note);
  var it = itemMap(items)[code];
  if (it) setCell(items, it, 'Condition', 'Damaged');
  return {};
}

function closeSession(me, b) {
  var items = table('Items'), st = table('Sessions'), scans = table('Scans');
  var s = findSession(st, b.sessionId);
  var sid = String(s.SessionID);
  items.rows.forEach(function (it) {
    if (it.Status === 'Out' && String(it.Session) === sid) setCell(items, it, 'Status', 'Missing');
  });
  setCell(st, s, 'Phase', 'Closed'); setCell(st, s, 'ClosedAt', new Date()); setCell(st, s, 'ClosedBy', me.email);
  setCell(st, s, 'ReturnDate', new Date());
  var url = sendReport(s, items, scans);
  setCell(st, s, 'ReportSent', new Date()); setCell(st, s, 'ReportUrl', url);
  return { reportUrl: url };
}

function resendReport(me, b) {
  var items = table('Items'), st = table('Sessions'), scans = table('Scans');
  var s = findSession(st, b.sessionId);
  var url = sendReport(s, items, scans);
  setCell(st, s, 'ReportUrl', url);
  return { reportUrl: url };
}

/* ------------------------------------------------------------- emails */

function teamCc(s) {
  if (testMode()) return '';
  return String(s.Team || '').split(',').map(function (x) { return x.trim().toLowerCase(); })
    .filter(function (x) { return x && x !== ADMIN_EMAIL; }).join(',');
}

function esc(x) { return String(x === undefined || x === null ? '' : x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

function sendReport(s, items, scans) {
  var m = itemMap(items);
  var sum = sessionSummary(s, scans);
  var packed = Object.keys(sum.packed);
  var missing = packed.filter(function (k) { return !sum.back[k]; });
  var html = reportHtml(s, m, sum, MAIL_DARK);
  var printHtml = reportHtml(s, m, sum, MAIL_DARK, true);
  var pdf = Utilities.newBlob(printHtml, 'text/html', 'report.html').getAs('application/pdf')
    .setName(dateOnly(s.ShootDate) + ' ' + s.ShootName + ' report.pdf');
  var file = DriveApp.getFolderById(prop('REPORTS_FOLDER')).createFile(pdf);
  var subject = (missing.length ? missing.length + ' missing · ' : 'All back · ') + s.ShootName;
  MailApp.sendEmail({
    to: ADMIN_EMAIL, cc: teamCc(s), subject: subject, htmlBody: html, attachments: [pdf], name: 'EyeStudio Equipment Tracker'
  });
  return file.getUrl();
}

function notifyFound(it, me) {
  MailApp.sendEmail({
    to: ADMIN_EMAIL, subject: 'Found: ' + it.ItemID + ' ' + it.Name,
    htmlBody: '<div style="font-family:Arial,sans-serif">' + esc(nameOf(me.email)) + ' just scanned <b>' + esc(it.ItemID + ' ' + it.Name) + '</b>, which was marked missing. It is now back in.</div>',
    name: 'EyeStudio Equipment Tracker'
  });
}

/* --------------------------------------------------- hourly reminder */

function hourly() {
  var nowD = new Date();
  if (nowD.getMonth() === 0 && nowD.getDate() === 1 && nowD.getHours() === 3) archiveOldScans();
  var st = table('Sessions'), scans = table('Scans');
  var now = Date.now();
  st.rows.forEach(function (s) {
    if (!s.SessionID || s.Phase === 'Closed') return;
    var due = dueTime(s);
    if (now < due) return;
    if (s.ReminderSent instanceof Date && now - s.ReminderSent.getTime() < 24 * 36e5) return;
    var sum = sessionSummary(s, scans);
    var count = Object.keys(sum.packed).length - Object.keys(sum.back).length;
    if (count <= 0 && s.Phase === 'Packing') return;
    var link = (prop('API_URL') || ScriptApp.getService().getUrl()) + '?a=snooze&s=' + encodeURIComponent(s.SessionID) + '&sig=' + sign('snooze' + s.SessionID);
    MailApp.sendEmail({
      to: ADMIN_EMAIL, cc: teamCc(s), name: 'EyeStudio Equipment Tracker',
      subject: 'Not checked back yet · ' + s.ShootName,
      htmlBody: '<div style="font-family:Arial,sans-serif;font-size:14px">' + count + ' items from <b>' + esc(s.ShootName) + '</b> are still out.<br><br>' +
        'Open the Equipment Tracker and check the gear back.<br><br>Still shooting? <a href="' + link + '">Remind me tomorrow instead</a>.</div>'
    });
    setCell(st, s, 'ReminderSent', new Date());
  });
}

function snoozeFromEmail(id, sig) {
  if (!id || sign('snooze' + id) !== sig) return HtmlService.createHtmlOutput('<p style="font-family:Arial">This link is not valid.</p>');
  var st = table('Sessions');
  var s = findSession(st, id);
  setCell(st, s, 'SnoozeUntil', new Date(Date.now() + 864e5));
  return HtmlService.createHtmlOutput('<div style="font-family:Arial;font-size:18px;padding:40px">Okay. We will remind you about <b>' + esc(s.ShootName) + '</b> tomorrow.</div>');
}

function photosFolder() {
  var id = prop('PHOTOS_FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { } }
  var f = DriveApp.getFolderById(MAIN_FOLDER).createFolder('Damage Photos');
  P().setProperty('PHOTOS_FOLDER', f.getId());
  return f;
}

function deleteSession(me, b) {
  if (!me.isAdmin) return { ok: false, error: 'Only Chamath can delete sessions.' };
  var items = table('Items'), st = table('Sessions'), scans = table('Scans');
  var s = findSession(st, b.sessionId);
  var sid = String(s.SessionID);
  items.rows.forEach(function (it) {
    if (String(it.Session) === sid) { setCell(items, it, 'Status', 'In'); setCell(items, it, 'Session', ''); }
  });
  var dead = scans.rows.filter(function (r) { return String(r.Session) === sid; }).map(function (r) { return r._r; });
  dead.sort(function (a, c) { return c - a; }).forEach(function (rowNum) { scans.sh.deleteRow(rowNum); });
  st.sh.deleteRow(s._r);
  return {};
}

/** Once a year: moves scans of sessions closed more than a year ago to "Scans Archive", so the app stays fast. */
function archiveOldScans() {
  var st = table('Sessions'), scans = table('Scans');
  var cutoff = Date.now() - 365 * 864e5;
  var old = {};
  st.rows.forEach(function (s) { if (s.Phase === 'Closed' && s.ClosedAt instanceof Date && s.ClosedAt.getTime() < cutoff) old[String(s.SessionID)] = 1; });
  var move = scans.rows.filter(function (r) { return old[String(r.Session)]; });
  if (!move.length) return 'Nothing to archive';
  var ss = book();
  var arch = ss.getSheetByName('Scans Archive');
  if (!arch) { arch = ss.insertSheet('Scans Archive'); arch.getRange(1, 1, 1, scans.head.length).setValues([scans.head]).setFontWeight('bold'); arch.setFrozenRows(1); }
  var values = move.map(function (r) { return scans.head.map(function (h) { return r[h] === undefined ? '' : r[h]; }); });
  arch.getRange(arch.getLastRow() + 1, 1, values.length, scans.head.length).setValues(values);
  move.map(function (r) { return r._r; }).sort(function (a, c) { return c - a; }).forEach(function (n) { scans.sh.deleteRow(n); });
  return 'Archived ' + move.length + ' scans';
}

/** Typed in because the sticker is gone or broken: put it on the reprint list. A real scan later clears it. */
function markSticker(items, it, b) {
  if (items.idx.Reprint === undefined) return;
  if (b.typed) { if (/sticker/i.test(String(b.reason || ''))) setCell(items, it, 'Reprint', true); }
  else if (truthy(it.Reprint)) setCell(items, it, 'Reprint', false);
}

function clearReprint(me, b) {
  if (!me.isAdmin) return { ok: false, error: 'Only Chamath can clear the reprint list.' };
  var items = table('Items');
  var ids = (b.ids || []).map(norm);
  items.rows.forEach(function (it) { if (truthy(it.Reprint) && (!ids.length || ids.indexOf(norm(it.ItemID)) > -1)) setCell(items, it, 'Reprint', false); });
  return {};
}

var CAT_ORDER = ['Camera', 'Lens', 'Light', 'Stand / Tripod', 'Bag', 'Gimbal', 'Drone', 'Mic', 'Battery', 'Charger', 'Memory Card', 'Lens Filter', 'Cable', 'Miscellaneous', 'New Equipment (2026)'];
var CAT_NAMES = { 'Camera': 'Cameras', 'Lens': 'Lenses', 'Light': 'Lights', 'Stand / Tripod': 'Stands and tripods', 'Bag': 'Bags', 'Gimbal': 'Gimbals', 'Drone': 'Drones', 'Mic': 'Mics', 'Battery': 'Batteries', 'Charger': 'Chargers', 'Memory Card': 'Memory cards', 'Lens Filter': 'Lens filters', 'Cable': 'Cables', 'Miscellaneous': 'Other', 'New Equipment (2026)': 'New equipment' };

/* ------------------------------------------------ email look (dark like the app, light for the printable PDF) */
var MAIL_DARK = { bg: '#0B0C11', card: '#181A23', line: '#262935', text: '#F5F6FA', muted: '#9A9DA8', yellow: '#FFD43B', violet: '#9D8CFF', red: '#FF5C7A', green: '#3DDC84', warn: '#2A2512' };
var MAIL_LIGHT = { bg: '#FFFFFF', card: '#F5F6FA', line: '#E3E4EA', text: '#111111', muted: '#666A75', yellow: '#8A6D00', violet: '#5B4BD6', red: '#C0264A', green: '#1E8C4E', warn: '#FFF6DD' };

function mailShell(T, inner, pre) {
  return (pre ? '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + esc(pre) + '</div>' : '') + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + T.bg + '" style="background:' + T.bg + '"><tr><td align="center" style="padding:32px 20px 40px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:-apple-system,Helvetica,Arial,sans-serif;color:' + T.text + ';font-size:15px;line-height:1.5"><tr><td>' + inner + '</td></tr></table></td></tr></table>';
}
function mailHead(T, eyebrow, color, title, meta) {
  return '<div style="font-size:11px;font-weight:bold;letter-spacing:.12em;color:' + color + '">' + eyebrow + '</div>' +
    '<div style="font-size:28px;line-height:1.15;letter-spacing:-.02em;font-weight:bold;margin:8px 0 10px;color:' + T.text + '">' + esc(title) + '</div>' +
    '<div style="color:' + T.muted + ';font-size:14px;line-height:1.7;margin:0 0 28px">' + meta + '</div>';
}
function mailSection(T, label, color, n) {
  return '<div style="margin:26px 0 8px 4px;font-size:11px;font-weight:bold;letter-spacing:.1em;color:' + (color || T.muted) + '">' + label.toUpperCase() + (n !== undefined ? ' · ' + n : '') + '</div>';
}
/** One card of items, one line each. by(k) returns { who, note, typed }: who sits on the right, note (if any) under the name. */
function mailItems(T, m, list, accent, by, head) {
  if (!list.length) return '<div style="color:' + T.muted + ';font-size:13px;margin-left:4px">None</div>';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + T.card + '" style="background:' + T.card + ';border-radius:16px;border-collapse:separate">' +
    list.map(function (k, i) {
      var l = (by && by(k)) || {};
      var h = head ? head(k, i) : '';
      var top = i && !h ? 'border-top:1px solid ' + T.line + ';' : '';
      return (h ? '<tr><td colspan="3" style="' + (i ? 'border-top:1px solid ' + T.line + ';' : '') + 'padding:' + (i ? 16 : 14) + 'px 16px 2px;font-size:11px;font-weight:bold;letter-spacing:.1em;color:' + T.muted + '">' + h + '</td></tr>' : '') +
        '<tr><td valign="top" style="' + top + 'padding:12px 0 12px 16px;width:56px;white-space:nowrap;font-weight:bold;font-size:13px;line-height:1.45;color:' + accent + '">' + esc(k) + '</td>' +
        '<td valign="top" style="' + top + 'padding:12px 8px;font-size:14px;line-height:1.45;color:' + T.text + '">' + esc((m[k] || {}).Name || 'Unknown item') +
        (l.note ? '<div style="font-size:12px;margin-top:2px;color:' + (l.typed ? T.yellow : T.muted) + '">' + esc(l.note) + '</div>' : '') + '</td>' +
        '<td valign="top" align="right" style="' + top + 'padding:12px 16px 12px 0;white-space:nowrap;font-size:12px;line-height:1.7;color:' + (l.typed ? T.yellow : T.muted) + '">' + esc(l.who || '') + '</td></tr>';
    }).join('') + '</table>';
}
function mailTypedNote(T, list, sum) {
  if (!list.length) return '';
  return '<div style="background:' + T.warn + ';border-radius:16px;padding:14px 16px;margin:12px 0 0;color:' + T.yellow + ';font-size:14px;line-height:1.5"><b>' + list.length + ' typed in by hand, not scanned:</b> ' +
    list.map(function (k) { return '<span style="white-space:nowrap">' + esc(k) + '</span>'; }).join(', ') + '</div>';
}
function whoLine(verb, rec) {
  if (!rec) return null;
  var who = (verb ? verb + ' ' : '') + nameOf(rec.by);
  return rec.typed ? { who: who, note: 'Typed in · ' + rec.typed, typed: true } : { who: who };
}
function teamNames(s) { return String(s.Team || '').split(',').map(function (e) { return nameOf(e.trim()); }).filter(String).join(', '); }

/** Email when packing is confirmed: what went out, grouped by type, with who packed each item. */
function packedEmailHtml(s, m, sum, me, T) {
  T = T || MAIL_DARK;
  var codes = Object.keys(sum.packed);
  var groups = {};
  codes.forEach(function (k) { var c = (m[k] && m[k].Category) || 'Miscellaneous'; if (CAT_ORDER.indexOf(c) === -1) c = 'Miscellaneous'; (groups[c] = groups[c] || []).push(k); });
  var when = Utilities.formatDate(s.PackedAt instanceof Date ? s.PackedAt : new Date(), 'Asia/Dubai', 'EEE d MMM, HH:mm');
  var typed = codes.filter(function (k) { return sum.packed[k].typed; });
  var packers = codes.map(function (k) { return nameOf(sum.packed[k].by); }).filter(function (n, i, a) { return n && a.indexOf(n) === i; }).join(', ') || nameOf(me.email);
  var inner = mailHead(T, 'GEAR IS OUT', T.yellow, s.ShootName,
    codes.length + ' items · packed by ' + esc(packers) + ' · ' + when + '<br>Shoot ' + dateOnly(s.ShootDate) + ' · Team: ' + esc(teamNames(s))) +
    mailTypedNote(T, typed, sum);
  var ordered = [], headAt = {};
  CAT_ORDER.forEach(function (c) {
    if (!groups[c]) return;
    var list = groups[c].sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
    headAt[ordered.length] = esc((CAT_NAMES[c] || c).toUpperCase()) + ' · ' + list.length;
    ordered = ordered.concat(list);
  });
  inner += '<div style="height:20px"></div>' + mailItems(T, m, ordered, T.yellow, function (k) { return whoLine('', sum.packed[k]); }, function (k, i) { return headAt[i] || ''; });
  inner += '<div style="color:' + T.muted + ';font-size:14px;line-height:1.6;margin:36px 4px 0">After the shoot, open the Equipment Tracker and tap Check gear back. A reminder goes out if it is not checked back within 24 hours.</div>' +
    '<div style="color:' + T.muted + ';opacity:.6;font-size:11px;margin:28px 4px 0">EyeStudio Equipment Tracker · Shoot ' + esc(s.SessionID) + '</div>';
  return { html: mailShell(T, inner, codes.length + ' items packed by ' + packers + (typed.length ? '. ' + typed.length + ' typed in by hand.' : '')), count: codes.length };
}

/** Report when a shoot is closed: missing first, then damaged, extra and back, with who handled each item. */
function reportHtml(s, m, sum, T, full) {
  var num = function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); };
  var packed = Object.keys(sum.packed).sort(num);
  var back = packed.filter(function (k) { return sum.back[k]; });
  var missing = packed.filter(function (k) { return !sum.back[k]; });
  var extra = Object.keys(sum.extra).sort(num);
  var dmg = Object.keys(sum.damaged).sort(num);
  var typed = Object.keys(sum.typed).sort(num);
  var closed = s.ClosedAt ? Utilities.formatDate(new Date(s.ClosedAt), 'Asia/Dubai', 'EEE d MMM, HH:mm') : '';
  function tile(n, label, color) {
    return '<td width="20%" align="center" style="padding:18px 2px 16px"><div style="font-size:24px;line-height:1.1;font-weight:bold;color:' + color + '">' + n + '</div><div style="font-size:12px;margin-top:6px;color:' + T.muted + '">' + label + '</div></td>';
  }
  var inner = mailHead(T, missing.length ? 'SHOOT CLOSED · ' + missing.length + ' MISSING' : 'SHOOT CLOSED · ALL BACK', missing.length ? T.red : T.violet, s.ShootName,
    'Closed by ' + esc(nameOf(s.ClosedBy)) + ' · ' + closed + '<br>Shoot ' + dateOnly(s.ShootDate) + ' · Team: ' + esc(teamNames(s))) +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + T.card + '" style="background:' + T.card + ';border-radius:16px"><tr>' +
    tile(packed.length, 'packed', T.text) + tile(back.length, 'back', T.violet) + tile(missing.length, 'missing', missing.length ? T.red : T.muted) +
    tile(dmg.length, 'damaged', dmg.length ? T.red : T.muted) + tile(extra.length, 'extra', T.muted) + '</tr></table>' +
    '';
  if (missing.length) inner += mailSection(T, 'Missing', T.red, missing.length) + mailItems(T, m, missing, T.red, function (k) { return whoLine('packed by', sum.packed[k]); });
  if (dmg.length) inner += mailSection(T, 'Damaged', T.red, dmg.length) + mailItems(T, m, dmg, T.red, function (k) { return { note: String(sum.damaged[k]).replace(/\s*\(by [^)]*\)/, ''), who: sum.damagedBy[k] ? nameOf(sum.damagedBy[k]) : '' }; });
  if (extra.length) inner += mailSection(T, 'Extra, not packed for this shoot', null, extra.length) + mailItems(T, m, extra, T.muted, function (k) { return whoLine('found by', sum.extra[k]); });
  var typedBack = back.filter(function (k) { return sum.back[k].typed; });
  if (typedBack.length && !full) inner += mailSection(T, 'Typed in at check back', T.yellow, typedBack.length) + mailItems(T, m, typedBack, T.yellow, function (k) { return whoLine('', sum.back[k]); });
  if (full) inner += mailSection(T, 'Back', T.violet, back.length) + mailItems(T, m, back, T.violet, function (k) { return whoLine('', sum.back[k]); });
  else inner += '<div style="background:' + T.card + ';border-radius:16px;padding:14px 16px;margin:28px 0 0;font-size:14px;line-height:1.5;color:' + T.muted + '"><b style="color:' + T.violet + '">' + back.length + ' of ' + packed.length + ' back.</b> The full list with who checked each item back is in the attached PDF.</div>';
  inner += '<div style="color:' + T.muted + ';opacity:.6;font-size:11px;margin:36px 4px 0">EyeStudio Equipment Tracker · Shoot ' + esc(s.SessionID) + '</div>';
  return mailShell(T, inner, (missing.length ? missing.length + ' missing' : 'All back') + '. ' + back.length + ' of ' + packed.length + ' back' + (dmg.length ? ', ' + dmg.length + ' damaged' : '') + (extra.length ? ', ' + extra.length + ' extra' : '') + '. Closed by ' + nameOf(s.ClosedBy) + '.');
}

function sendPackedEmail(s, items, scans, me) {
  var e = packedEmailHtml(s, itemMap(items), sessionSummary(s, scans), me);
  MailApp.sendEmail({ to: ADMIN_EMAIL, cc: teamCc(s), subject: 'Gear out · ' + s.ShootName + ' · ' + e.count + ' items', htmlBody: e.html, name: 'EyeStudio Equipment Tracker' });
}
