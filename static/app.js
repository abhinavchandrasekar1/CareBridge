/* CareBridge front-end - vanilla JS, no build step. Real-time via Server-Sent Events. */
(() => {
'use strict';

// ------------------------------------------------------------------ helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const parseSlot = s => { const [d, t] = s.split(' '); const [y, m, dd] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return new Date(y, m - 1, dd, h, mi); };
const fmtSlot = s => { const d = parseSlot(s); return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }); };
const fmtDate = iso => new Date(iso + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const fmt12 = t => { const [h, m] = t.split(':').map(Number); return (h % 12 || 12) + ':' + pad(m) + ' ' + (h >= 12 ? 'PM' : 'AM'); };
const fmtTs = ts => { if (!ts) return 'never'; const d = new Date(ts.replace(' ', 'T')); const diff = (Date.now() - d) / 6e4; if (diff < 1) return 'just now'; if (diff < 60) return Math.round(diff) + ' min ago'; if (diff < 1440) return Math.round(diff / 60) + ' h ago'; return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }); };
const greet = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const initials = n => n.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
const MOODS = ['😣', '😕', '😐', '🙂', '😄'];
const ENERGY = ['🪫', '😴', '😐', '🙂', '⚡'];
const LEVEL_LABEL = { critical: 'Critical', high: 'High', moderate: 'Watch', low: 'Good', none: 'No data', stable: 'Stable', overdue: 'Overdue', silent: 'Silent' };
const STATE_LABEL = { overdue: 'OVERDUE', booked: 'Booked', pending: 'To book', due_soon: 'Due soon', done: 'Done' };

const S = {
  token: localStorage.getItem('cb_token'), role: localStorage.getItem('cb_role'), me: null,
  view: 'today', data: null, dash: null, sel: null, detail: null, slots: [],
  pick: { day: null, slot: null, fu: '', purpose: '' }, lastResult: null, es: null, live: false,
  ci: null, unread: 0, feed: [], alarm: localStorage.getItem('cb_alarm') === '1', rx: null, regRole: 'patient', authTab: 'login'
};
const resetCi = () => { S.ci = { pain: 3, temp: '', mood: 3, sleep: 7, energy: 3, flags: [], note: '' }; };
resetCi();

async function api(path, body, method) {
  const opt = { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' } };
  if (S.token) opt.headers.Authorization = 'Bearer ' + S.token;
  if (body) opt.body = JSON.stringify(body);
  const r = await fetch(path, opt);
  let j = {}; try { j = await r.json(); } catch (e) { /* empty */ }
  if (r.status === 401 && S.token) { logout(true); throw new Error(j.error || 'Signed out'); }
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}

function toast(title, msg = '', kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<b>${esc(title)}</b>${esc(msg)}`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 6500);
}
let actx;
function beep(urgent) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    (urgent ? [880, 660, 880, 660, 880] : [660, 880]).forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = f; o.type = 'sine'; o.connect(g); g.connect(actx.destination);
      const t = actx.currentTime + i * 0.22;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.28, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.start(t); o.stop(t + 0.21);
    });
  } catch (e) { /* audio blocked */ }
}
const wrapAsync = fn => async (...a) => { try { await fn(...a); } catch (e) { toast('Oops', e.message, 'danger'); } };

// ------------------------------------------------------------------ small charts
let gid = 0;
function spark(vals, { min = 0, max = 10, color = 'var(--accent)', w = 300, h = 80, fmt = v => v } = {}) {
  if (!vals.length) return '<div class="empty">No reports yet</div>';
  const id = 'g' + (++gid), n = vals.length;
  const pts = vals.map((v, i) => [n > 1 ? (i * (w - 16)) / (n - 1) + 8 : w / 2, h - 12 - ((v - min) / ((max - min) || 1)) * (h - 26)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = line + ` L${pts[n - 1][0].toFixed(1)} ${h} L${pts[0][0].toFixed(1)} ${h} Z`;
  const last = pts[n - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
  <path d="${area}" fill="url(#${id})"/><path d="${line}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  ${pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" fill="${color}"/>`).join('')}
  <text x="${Math.min(last[0], w - 18)}" y="${Math.max(last[1] - 9, 10)}" text-anchor="middle" font-size="11" font-weight="800" fill="${color}">${fmt(vals[n - 1])}</text></svg>`;
}
function ring(score, size = 140) {
  const r = 54, c = 2 * Math.PI * r;
  const col = score >= 75 ? 'var(--ok)' : score >= 50 ? 'var(--warn)' : 'var(--danger)';
  return `<div class="ring" style="width:${size}px;height:${size}px"><svg width="${size}" height="${size}" viewBox="0 0 140 140"><circle cx="70" cy="70" r="${r}" fill="none" stroke="var(--card-b)" stroke-width="12"/>
  <circle cx="70" cy="70" r="${r}" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - score / 100)).toFixed(1)}"/></svg>
  <div class="num" style="font-size:${Math.round(size / 4.1)}px"><div>${score}<small>PULSE</small></div></div></div>`;
}
const badge = (k, text) => `<span class="badge b-${k}">${esc(text || LEVEL_LABEL[k] || k)}</span>`;

// ------------------------------------------------------------------ auth screen
async function renderAuth() {
  let docs = [];
  try { docs = await api('/api/doctors'); } catch (e) { /* ignore */ }
  const reg = S.authTab === 'register';
  $('#app').innerHTML = `
  <div class="auth">
    <section class="hero">
      <div class="logo"><i>✚</i> CareBridge</div>
      <h1>Care doesn't end at <span>discharge.</span><br>Make every step count.</h1>
      <p>A continuous, personalised and proactive continuity-of-care platform: medicine reminders, daily recovery reports, smart follow-up tracking and a scannable QR Care Passport - all synced live between patient and doctor.</p>
      <div class="feat">
        <div><b>🔳 QR Care Passport</b>Anyone can scan to see medicine timings, or download a PDF.</div>
        <div><b>💓 Recovery Pulse</b>One explainable score from adherence, symptoms and follow-ups.</div>
        <div><b>⏰ Overdue radar</b>Missed bookings & silent patients surface for the doctor instantly.</div>
        <div><b>⚡ Real-time</b>Reports, replies and prescriptions sync with no refresh.</div>
      </div>
    </section>
    <section class="auth-card"><div class="panel">
      <div class="tabs2"><button data-act="authTab" data-v="login" class="${reg ? '' : 'on'}">Sign in</button><button data-act="authTab" data-v="register" class="${reg ? 'on' : ''}">Create account</button></div>
      ${reg ? `
        <div class="tabs2"><button data-act="regRole" data-v="patient" class="${S.regRole === 'patient' ? 'on' : ''}">I'm a patient</button><button data-act="regRole" data-v="doctor" class="${S.regRole === 'doctor' ? 'on' : ''}">I'm a doctor</button></div>
        <label>Full name</label><input id="rName" autocomplete="name">
        <label>Email</label><input id="rEmail" type="email" autocomplete="email">
        ${S.regRole === 'patient' ? `
          <div class="row"><div><label>Age</label><input id="rAge" type="number" min="0" max="120"></div><div><label>Phone</label><input id="rPhone"></div></div>
          <label>Your doctor</label><select id="rDoc">${docs.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select>
          <label>Condition / reason for care</label><input id="rCond" placeholder="e.g. Post knee surgery, Diabetes">
          <label>Your circumstances (helps personalise your plan)</label><input id="rCirc" placeholder="e.g. lives alone, works night shift, far from hospital">`
          : `<label>Doctor access code</label><input id="rCode" placeholder="SYNESIS26"><label>Clinic phone</label><input id="rPhone">`}
        <label>Password</label><input id="rPass" type="password" autocomplete="new-password" placeholder="6+ characters">
        <div class="err" id="err"></div><button class="btn block" data-act="register">Create account</button>`
      : `
        <label>Email</label><input id="lEmail" type="email" autocomplete="username">
        <label>Password</label><input id="lPass" type="password" autocomplete="current-password">
        <div class="err" id="err"></div><button class="btn block" data-act="login">Sign in</button>
        <div class="demo"><button class="btn ghost sm" style="flex:1" data-act="demo" data-e="patient@demo" data-p="patient123">🧑 Demo patient</button><button class="btn ghost sm" style="flex:1" data-act="demo" data-e="doctor@demo" data-p="doctor123">🩺 Demo doctor</button></div>`}
    </div></section>
  </div>`;
}

async function doAuth(path, payload) {
  const r = await api(path, payload);
  S.token = r.token; S.role = r.role;
  localStorage.setItem('cb_token', r.token); localStorage.setItem('cb_role', r.role);
  S.view = r.role === 'doctor' ? 'dash' : 'today'; S.sel = null;
  await boot();
}
function logout(silent) {
  if (S.token && !silent) api('/api/logout', {}).catch(() => {});
  if (S.es) S.es.close();
  S.token = null; S.role = null; localStorage.removeItem('cb_token'); localStorage.removeItem('cb_role');
  S.authTab = 'login'; renderAuth();
}

// ------------------------------------------------------------------ shell
function shell(tabs) {
  const doc = S.role === 'doctor';
  $('#app').innerHTML = `
  <header class="top">
    <div class="logo"><i>✚</i> CareBridge</div>
    <div class="right">
      <span class="live ${S.live ? '' : 'off'}" id="live">${S.live ? 'LIVE' : 'RECONNECTING'}</span>
      ${!doc ? `<button class="icon-btn" title="Medicine alarm sound" data-act="toggleAlarm" id="alarmBtn">${S.alarm ? '🔔' : '🔕'}</button>` : ''}
      <button class="icon-btn" title="Large text" data-act="largeText">Aa</button>
      <button class="icon-btn" title="Light / dark" data-act="theme">◐</button>
      <div class="who"><b>${esc(S.me.name)}</b>${doc ? 'Doctor' : 'Patient'}</div>
      <button class="btn ghost sm" data-act="logout">Sign out</button>
    </div>
  </header>
  <div class="wrap">
    ${tabs ? `<nav class="nav" id="nav">${tabs.map(t => `<button data-act="nav" data-v="${t[0]}" class="${S.view === t[0] ? 'on' : ''}"><span>${t[1]}</span>${t[2]}${t[0] === 'chat' && S.unread ? `<span class="dot">${S.unread}</span>` : ''}</button>`).join('')}</nav>` : ''}
    <div id="view"><div class="skeleton"></div></div>
  </div>`;
}
const PTABS = [['today', '🏠', 'Today'], ['checkin', '📝', 'Check-in'], ['meds', '💊', 'Medicines'], ['appts', '📅', 'Visits'], ['chat', '💬', 'Doctor'], ['passport', '🔳', 'Passport']];

function setLive(v) { S.live = v; const el = $('#live'); if (el) { el.className = 'live' + (v ? '' : ' off'); el.textContent = v ? 'LIVE' : 'RECONNECTING'; } }

// ------------------------------------------------------------------ boot / realtime
async function boot() {
  try { S.me = await api('/api/me'); } catch (e) { return renderAuth(); }
  S.role = S.me.role;
  shell(S.role === 'patient' ? PTABS : null);
  connect();
  if (S.role === 'patient') { await loadHome(); render(); loadSlots(); }
  else { await loadDash(); render(); }
}
function connect() {
  if (S.es) S.es.close();
  const es = new EventSource('/api/stream?t=' + encodeURIComponent(S.token));
  S.es = es;
  es.onopen = () => setLive(true);
  es.onerror = () => setLive(false);
  ['hello', 'checkin', 'message', 'appointment', 'adherence', 'prescription', 'followup', 'patient_joined', 'self_update'].forEach(ev =>
    es.addEventListener(ev, e => { setLive(true); if (ev !== 'hello') onEvent(ev, JSON.parse(e.data || '{}')); }));
}
let rt;
function reload() { clearTimeout(rt); rt = setTimeout(wrapAsync(async () => {
  if (S.role === 'patient') await loadHome(); else { await loadDash(); if (S.sel) await loadDetail(S.sel); }
  softRender();
}), 350); }
function feed(icon, text) { S.feed.unshift({ icon, text, t: new Date() }); S.feed = S.feed.slice(0, 8); }

function onEvent(ev, d) {
  if (S.role === 'doctor') {
    if (ev === 'checkin') {
      const kind = d.level === 'critical' ? 'danger' : d.level === 'high' ? 'warn' : '';
      toast(d.level === 'critical' ? '🚨 CRITICAL check-in' : 'New daily report', `${d.name} - ${LEVEL_LABEL[d.level]} (score ${d.score})`, kind);
      if (d.level === 'critical' || d.level === 'high') beep(d.level === 'critical');
      feed(d.level === 'critical' ? '🚨' : '📝', `${d.name} submitted a report - ${LEVEL_LABEL[d.level]}`);
    } else if (ev === 'message') { toast('💬 ' + d.name, d.body); beep(false); feed('💬', `${d.name}: ${d.body.slice(0, 48)}`); }
    else if (ev === 'appointment') { toast('📅 ' + d.name, d.cancelled ? 'cancelled an appointment' : 'booked ' + fmtSlot(d.slot)); feed('📅', `${d.name} ${d.cancelled ? 'cancelled' : 'booked ' + fmtSlot(d.slot)}`); }
    else if (ev === 'patient_joined') { toast('New patient', d.name + ' joined your care list'); feed('🧑', `${d.name} joined`); }
    else if (ev === 'adherence') { /* silent refresh */ }
  } else {
    if (ev === 'message') { toast('💬 Message from your doctor', d.body); beep(false); if (S.view !== 'chat') S.unread++; }
    else if (ev === 'prescription') { toast(d.stopped ? 'Medicine stopped' : '💊 New prescription', d.name + (d.stopped ? ' was stopped by your doctor' : ' added - reminders are set'), 'warn'); beep(false); }
    else if (ev === 'appointment') toast('📅 Appointment update', d.slot ? 'Your doctor scheduled ' + fmtSlot(d.slot) : 'Your appointment was updated');
    else if (ev === 'followup') toast('📋 Follow-up', d.title ? 'New follow-up: ' + d.title : 'Follow-up updated');
  }
  reload();
}

// ------------------------------------------------------------------ data loaders
async function loadHome() { S.data = await api('/api/patient/home'); }
async function loadSlots() { try { S.slots = await api('/api/slots'); if (!S.pick.day && S.slots.length) S.pick.day = S.slots[0].slice(0, 10); } catch (e) { /* ignore */ } }
async function loadDash() { S.dash = await api('/api/doctor/dashboard'); }
async function loadDetail(id) { S.detail = await api('/api/doctor/patient/' + id); }

// ------------------------------------------------------------------ rendering
function keepInputs(fn) {
  const saved = $$('#view input[id],#view textarea[id],#view select[id]').map(e => [e.id, e.value]);
  const f = document.activeElement && document.activeElement.id;
  fn();
  saved.forEach(([id, v]) => { const e = document.getElementById(id); if (e && e.value !== v) e.value = v; });
  if (f && document.getElementById(f)) { const e = document.getElementById(f); try { e.focus(); const l = e.value.length; e.setSelectionRange(l, l); } catch (x) { /* ignore */ } }
}
function updateNav() { const n = $('#nav'); if (n) n.innerHTML = PTABS.map(t => `<button data-act="nav" data-v="${t[0]}" class="${S.view === t[0] ? 'on' : ''}"><span>${t[1]}</span>${t[2]}${t[0] === 'chat' && S.unread ? `<span class="dot">${S.unread}</span>` : ''}</button>`).join(''); }
function softRender() {
  if (S.role === 'patient') {
    updateNav();
    if ((S.view === 'checkin' && !S.lastResult) || S.view === 'passport') return;
    if (S.view === 'chat') { paintMsgs(); return; }
  }
  render();
}
function render() {
  if (!S.me) return;
  if (S.role === 'patient') { updateNav(); keepInputs(renderPatient); } else keepInputs(renderDoctor);
}
function renderPatient() {
  if (!S.data) return;
  const v = $('#view');
  const fn = { today: pToday, checkin: pCheckin, meds: pMeds, appts: pAppts, chat: pChat, passport: pPassport }[S.view];
  v.innerHTML = fn();
  if (S.view === 'chat') paintMsgs(true);
}

// ------------------------------------------------------------------ patient: today
function doseStatus(d) {
  if (d.status === 'taken') return 'taken';
  const t = parseSlot(d.date + ' ' + d.time).getTime(), n = Date.now();
  if (n > t + 2 * 3600e3) return 'missed';
  if (n >= t - 30 * 60e3) return 'due';
  return 'upcoming';
}
function pToday() {
  const D = S.data, p = D.profile;
  const doses = D.doses.map(d => ({ ...d, st: doseStatus(d) }));
  const overdue = D.followups.filter(f => f.state === 'overdue');
  const soon = D.followups.filter(f => f.state === 'due_soon' || f.state === 'pending');
  const todays = D.checkins.find(c => c.date === todayISO());
  const next = doses.find(d => d.st === 'due' || d.st === 'upcoming');
  const taken = doses.filter(d => d.st === 'taken').length;
  const pains = D.checkins.slice().reverse().map(c => c.pain);
  const crit = D.checkins[0] && D.checkins[0].risk_level === 'critical' && D.checkins[0].date === todayISO();
  return `
  <div class="stack">
    ${crit ? `<div class="alert"><div><b>🚨 Your latest report shows warning signs</b><span class="small muted">Your doctor has been alerted. If you feel unsafe, call 108 or go to the nearest emergency room.</span></div><a class="btn danger sm" href="tel:108">Call 108</a></div>` : ''}
    ${overdue.map(f => `<div class="alert"><div><b>⏰ Overdue: ${esc(f.title)}</b><span class="small muted">${f.missed_visit ? 'You missed this visit.' : 'Due ' + fmtDate(f.due_date) + ' - ' + f.days_over + ' day' + (f.days_over > 1 ? 's' : '') + ' overdue.'} Please book now so your doctor can follow your recovery.</span></div><button class="btn sm" data-act="goBook" data-id="${f.id}">Book now</button></div>`).join('')}
    <div class="card today">
      ${ring(D.pulse)}
      <div>
        <div class="muted small">Day ${D.day_of_recovery} of your recovery</div>
        <h2>${greet()}, ${esc(p.name.split(' ')[0])} 👋</h2>
        <div class="muted small" style="margin-top:4px">${esc(p.condition || 'Recovery plan')} · Dr. ${esc(D.doctor.name.replace(/^Dr\.?\s*/, ''))}</div>
        <div class="pills"><span class="pill">💊 ${taken}/${doses.length} doses today</span><span class="pill">📈 Adherence ${D.adherence ?? '-'}${D.adherence != null ? '%' : ''}</span>${next ? `<span class="pill">⏭ Next ${fmt12(next.time)} · ${esc(next.name)}</span>` : ''}</div>
        ${todays ? '' : `<button class="btn" style="margin-top:16px" data-act="nav" data-v="checkin">📝 Log how you feel today</button>`}
      </div>
    </div>
    <div class="grid g2">
      <div class="card"><h3>Today's medicines <span class="tiny">${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })}</span></h3>
        ${doses.length ? doses.map(d => `<div class="dose ${d.st}"><div class="t">${fmt12(d.time).replace(' ', '<br><span class="tiny muted">') + '</span>'}</div><div class="n"><b>${esc(d.name)} <span class="muted small">${esc(d.dose)}</span></b><span class="small muted">${esc(d.meal)}${d.st === 'missed' ? ' · <b style="color:var(--danger)">missed</b>' : ''}${d.st === 'due' ? ' · <b style="color:var(--accent)">time to take</b>' : ''}</span></div>
          <button class="check ${d.st === 'taken' ? 'on' : ''}" data-act="take" data-med="${d.med_id}" data-time="${d.time}" data-date="${d.date}" data-undo="${d.st === 'taken' ? 1 : 0}" title="Mark as taken">✓</button></div>`).join('')
          : '<div class="empty">No medicines scheduled today 🎉</div>'}
      </div>
      <div class="stack">
        <div class="card"><h3>Coming up</h3>
          ${soon.length || D.followups.some(f => f.state === 'booked') ? D.followups.filter(f => f.state !== 'done' && f.state !== 'overdue').map(f => `<div class="fu"><div><b>${esc(f.title)}</b><span class="small muted">${f.appt ? fmtSlot(f.appt.slot) : 'Book before ' + fmtDate(f.due_date)}</span></div>${f.state === 'booked' ? badge('booked', 'Booked') : `<button class="btn sm" data-act="goBook" data-id="${f.id}">Book</button>`}</div>`).join('') : '<div class="empty">Nothing pending. 🙌</div>'}
        </div>
        <div class="card"><h3>Pain trend</h3>${spark(pains, { max: 10, color: 'var(--danger)' })}<div class="small muted">Lower is better. Last ${pains.length} reports.</div></div>
      </div>
    </div>
    <div class="card"><h3>Your personalised care plan</h3>${D.tips.map(t => `<div class="chk small">✨ ${esc(t)}</div>`).join('')}</div>
  </div>`;
}

// ------------------------------------------------------------------ patient: check-in
const FLAGS = [['chest_pain', 'Chest pain', 1], ['breathless', 'Trouble breathing', 1], ['bleeding', 'Heavy bleeding', 1], ['fainting', 'Fainting', 1],
  ['wound_infection', 'Wound red / pus', 0], ['vomiting', 'Vomiting', 0], ['swelling', 'New swelling', 0], ['dizziness', 'Dizzy', 0], ['missed_meds', "Couldn't take medicines", 0], ['confusion', 'Confused / very drowsy', 0]];
function pCheckin() {
  if (S.lastResult) {
    const r = S.lastResult;
    return `<div class="card" style="max-width:640px;margin:auto"><div class="result ${r.level}"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><h2 style="font-size:24px">${r.level === 'critical' ? '🚨' : r.level === 'low' ? '✅' : '⚠️'} Report sent</h2>${badge(r.level)}</div>
      <p style="line-height:1.55">${esc(r.advice)}</p>
      ${r.reasons.length ? `<div class="small muted">Why this rating:</div><ul style="margin:6px 0 0;padding-left:20px">${r.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      <div class="small muted" style="margin-top:12px">Risk score ${r.score}/100 - rule-based and explainable. Your doctor makes the clinical decision.</div></div>
      <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">${r.level === 'critical' ? '<a class="btn danger" href="tel:108">📞 Call 108</a>' : ''}<button class="btn" data-act="doneResult">Back to today</button></div></div>`;
  }
  const c = S.ci;
  return `<div class="card" style="max-width:720px;margin:auto"><h3>Daily health report <span class="tiny">Takes 30 seconds</span></h3>
    <label>Pain level</label><div style="display:flex;align-items:center;gap:16px"><div class="bigpain" id="painv">${c.pain}</div><input class="slider" type="range" min="0" max="10" value="${c.pain}" data-bind="pain"></div>
    <div class="row"><div><label>Temperature (°C)</label><input id="ciTemp" type="number" step="0.1" min="34" max="42" placeholder="e.g. 37.2" value="${esc(c.temp)}" data-bind="temp"></div><div><label>Sleep (hours)</label><input type="number" step="0.5" min="0" max="24" value="${c.sleep}" data-bind="sleep"></div></div>
    <label>Mood</label><div class="emojis">${MOODS.map((e, i) => `<button data-act="mood" data-k="mood" data-v="${i + 1}" class="${c.mood === i + 1 ? 'on' : ''}">${e}</button>`).join('')}</div>
    <label>Energy</label><div class="emojis">${ENERGY.map((e, i) => `<button data-act="mood" data-k="energy" data-v="${i + 1}" class="${c.energy === i + 1 ? 'on' : ''}">${e}</button>`).join('')}</div>
    <label>Any warning signs today?</label><div class="chips">${FLAGS.map(f => `<button class="chip ${f[2] ? 'red' : ''} ${c.flags.includes(f[0]) ? 'on' : ''}" data-act="flag" data-f="${f[0]}">${f[2] ? '⚠ ' : ''}${f[1]}</button>`).join('')}</div>
    <label>Anything else? (type or speak)</label><textarea id="ciNote" data-bind="note" placeholder="How is the wound, appetite, any side-effects…">${esc(c.note)}</textarea>
    <div style="display:flex;gap:8px;margin-top:8px"><button class="btn ghost sm" data-act="voice" data-l="en-IN">🎤 English</button><button class="btn ghost sm" data-act="voice" data-l="ta-IN">🎤 தமிழ்</button></div>
    <button class="btn block" data-act="submitCheckin">Send report to my doctor</button></div>`;
}

// ------------------------------------------------------------------ patient: medicines
function pMeds() {
  const D = S.data;
  return `<div class="stack"><div class="card"><h3>Reminders <span class="tiny">${S.alarm ? 'Alarm ON' : 'Alarm OFF'}</span></h3>
    <div class="small muted" style="margin-bottom:12px">Medicines your doctor prescribes appear here automatically with reminders. Keep this tab open (or installed) to hear a chime and get a notification at each dose time.</div>
    <button class="btn ${S.alarm ? 'ghost' : ''}" data-act="toggleAlarm">${S.alarm ? '🔔 Alarm on - tap to turn off' : '🔕 Enable sound & notifications'}</button> <button class="btn ghost" data-act="testAlarm">Test chime</button></div>
    <div class="grid g2">${D.meds.length ? D.meds.map(m => {
      const done = Math.round(100 * (1 - Math.max(m.days_left, 0) / m.days));
      return `<div class="med"><div class="name">${esc(m.name)} <span class="muted small">${esc(m.dose)}</span></div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin:10px 0">${m.times.map(t => `<span class="timechip">${fmt12(t)}</span>`).join('')}<span class="mealchip">${esc(m.meal)}</span></div>
      ${m.notes ? `<div class="small muted">📝 ${esc(m.notes)}</div>` : ''}
      <div class="bar"><i style="width:${done}%"></i></div><div class="tiny muted" style="margin-top:6px">${m.days_left > 0 ? m.days_left + ' day(s) left' : 'Last day today'} · prescribed by Dr. ${esc(D.doctor.name.replace(/^Dr\.?\s*/, ''))}</div></div>`;
    }).join('') : '<div class="card empty">No active medicines. Your doctor will add prescriptions here.</div>'}</div></div>`;
}

// ------------------------------------------------------------------ patient: appointments
function groupSlots() { const g = {}; S.slots.forEach(s => (g[s.slice(0, 10)] ||= []).push(s)); return g; }
function pickerHTML(withFollow) {
  const g = groupSlots(), days = Object.keys(g);
  if (!days.length) return '<div class="empty">No free slots right now.</div>';
  if (!S.pick.day || !g[S.pick.day]) S.pick.day = days[0];
  const fus = (S.role === 'patient' ? S.data.followups : S.detail.followups).filter(f => f.state !== 'done' && f.state !== 'booked');
  return `${withFollow ? `<label>What is this visit for?</label><select id="pickFu" data-bind-pick="fu"><option value="">General visit</option>${fus.map(f => `<option value="${f.id}" ${String(S.pick.fu) === String(f.id) ? 'selected' : ''}>${esc(f.title)}${f.state === 'overdue' ? ' (overdue)' : ''}</option>`).join('')}</select>
    <div id="purposeWrap" ${S.pick.fu ? 'class="hidden"' : ''}><label>Reason</label><input id="pickPurpose" data-bind-pick="purpose" placeholder="e.g. Review, dressing change" value="${esc(S.pick.purpose)}"></div>` : ''}
    <label>Pick a day</label><div class="days">${days.slice(0, 10).map(d => { const dt = new Date(d + 'T00:00'); return `<div class="day ${S.pick.day === d ? 'on' : ''}" data-act="pickDay" data-d="${d}"><span>${dt.toLocaleDateString('en-IN', { weekday: 'short' })}</span><b>${dt.getDate()}</b><span>${dt.toLocaleDateString('en-IN', { month: 'short' })}</span></div>`; }).join('')}</div>
    <label>Pick a time</label><div class="slots">${g[S.pick.day].map(s => `<div class="slot ${S.pick.slot === s ? 'on' : ''}" data-act="pickSlot" data-s="${s}">${fmt12(s.slice(11))}</div>`).join('')}</div>`;
}
function repaintPicker() { const a = $('#pickarea'); if (a) a.innerHTML = pickerHTML(a.dataset.follow === '1'); }
function pAppts() {
  const D = S.data;
  const upcoming = D.appointments.filter(a => a.status === 'scheduled').sort((a, b) => a.slot.localeCompare(b.slot));
  const past = D.appointments.filter(a => a.status !== 'scheduled');
  return `<div class="grid g2"><div class="stack">
    <div class="card"><h3>Follow-ups requested by your doctor</h3>${D.followups.length ? D.followups.map(f => `<div class="fu ${f.state === 'overdue' ? 'overdue' : ''}"><div><b>${f.kind === 'test' ? '🧪' : '🩺'} ${esc(f.title)}</b><span class="small muted">${f.state === 'overdue' ? (f.missed_visit ? 'Missed visit - please rebook' : f.days_over + ' day(s) overdue (was due ' + fmtDate(f.due_date) + ')') : f.appt && f.state === 'booked' ? fmtSlot(f.appt.slot) : 'Book before ' + fmtDate(f.due_date)}</span></div>
      <div style="display:flex;gap:8px;align-items:center">${badge(f.state, STATE_LABEL[f.state])}${f.state !== 'done' && f.state !== 'booked' ? `<button class="btn sm" data-act="goBook" data-id="${f.id}">Book</button>` : ''}</div></div>`).join('') : '<div class="empty">No follow-ups yet.</div>'}</div>
    <div class="card"><h3>My appointments</h3>${upcoming.map(a => `<div class="fu"><div><b>${fmtSlot(a.slot)}</b><span class="small muted">${esc(a.purpose)}${a.created_by === 'doctor' ? ' · set by doctor' : ''}</span></div><button class="btn ghost sm" data-act="cancelAppt" data-id="${a.id}">Cancel</button></div>`).join('') || '<div class="empty">No upcoming appointments.</div>'}
      ${past.length ? `<h3 style="margin-top:18px">History</h3>${past.slice(0, 6).map(a => `<div class="fu"><div><b>${fmtSlot(a.slot)}</b><span class="small muted">${esc(a.purpose)}</span></div>${badge(a.status, a.status.toUpperCase())}</div>`).join('')}` : ''}</div>
  </div><div class="card" id="booker"><h3>Book a visit</h3><div id="pickarea" data-follow="1">${pickerHTML(true)}</div>
    <button class="btn block" data-act="confirmBook">Confirm appointment</button></div></div>`;
}

// ------------------------------------------------------------------ patient: chat
function pChat() {
  return `<div class="card" style="max-width:760px;margin:auto"><h3>Chat with Dr. ${esc(S.data.doctor.name.replace(/^Dr\.?\s*/, ''))}</h3><div class="chat" id="msgs"></div>
    <div class="sendrow"><input id="msgInput" placeholder="Ask your doctor or report a concern…" autocomplete="off"><button class="btn" data-act="sendMsg">Send</button></div></div>`;
}
function msgHTML(m, mine) {
  const cls = m.sender === 'system' ? 'system' : (m.sender === mine ? 'me' : 'them');
  return `<div class="msg ${cls}">${esc(m.body)}<small>${fmtTs(m.created)}</small></div>`;
}
function paintMsgs(scroll) {
  const box = $('#msgs'); if (!box) return;
  const atEnd = scroll || box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.innerHTML = S.data.messages.length ? S.data.messages.map(m => msgHTML(m, 'patient')).join('') : '<div class="empty">Say hello 👋 - your doctor will reply here.</div>';
  if (atEnd) box.scrollTop = box.scrollHeight;
  S.unread = 0; updateNav();
}

// ------------------------------------------------------------------ patient: passport
function pPassport() {
  const D = S.data, url = D.passport_url, priv = /\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost)/.test(url);
  return `<div class="grid g2"><div class="card qrbox"><h3 style="justify-content:center">My QR Care Passport</h3>
    <img src="/qr/${D.token}.png" alt="Care passport QR"><div><b>Scan with any phone camera</b><div class="small muted">No app or login needed. Shows medicine names, dose timings, food instructions and next appointments - always up to date.</div></div>
    <div class="url">${esc(url)}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center"><a class="btn" href="/p/${D.token}.pdf" target="_blank">⬇ Download PDF</a><a class="btn ghost" href="/p/${D.token}" target="_blank">Open page</a><button class="btn ghost" data-act="copyUrl">Copy link</button><button class="btn ghost" onclick="window.print()">🖨 Print</button></div>
    ${priv ? '<div class="tiny muted">Demo tip: phone and laptop must share the same Wi-Fi for this QR to open. Set PUBLIC_URL (e.g. an ngrok link) to share over the internet.</div>' : ''}
    <button class="btn ghost sm" data-act="rotate">🔄 Generate new QR (revokes the old one)</button></div>
    <div class="stack"><div class="card"><h3>What the QR shows</h3><div class="chk small">✅ First name, doctor name & clinic phone</div><div class="chk small">✅ Active medicines, dose, times, with/without food</div><div class="chk small">✅ Upcoming appointments</div><div class="chk small">🔒 Never shown: diagnosis, symptoms, reports or messages</div></div>
    <div class="card"><h3>My circumstances</h3><div class="small muted">Tell us about your life - your care tips adapt to it.</div>
      <label>About me</label><textarea id="circ" placeholder="e.g. lives alone, night shifts, far from hospital">${esc(D.profile.circumstances)}</textarea>
      <label>Phone</label><input id="phone" value="${esc(D.profile.phone)}"><button class="btn block" data-act="saveProfile">Save</button></div></div></div>`;
}

// ------------------------------------------------------------------ doctor
function renderDoctor() {
  if (!S.dash) return;
  $('#view').innerHTML = S.sel && S.detail && S.detail.patient.id === S.sel ? dDetail() : dDash();
  if (S.sel && $('#dmsgs')) paintDMsgs(true);
}
function dDash() {
  const D = S.dash, st = D.stats;
  const tile = (ico, n, label, col) => `<div class="card stat"><div class="ico" style="background:${col}22;color:${col}">${ico}</div><div><div class="big">${n}</div><div class="small muted">${label}</div></div></div>`;
  return `<div class="stack">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><div><h1 style="font-size:28px;letter-spacing:-.02em">${greet()}, Dr. ${esc(D.doctor.name.replace(/^Dr\.?\s*/, ''))}</h1><div class="muted small">Continuity-of-care command centre · ${st.patients} patients · live</div></div><button class="btn" data-act="addPatient">＋ Add patient</button></div>
    <div class="grid g4">${tile('🚨', st.critical, 'Critical reports', '#ff5d6c')}${tile('⏰', st.overdue, 'Overdue follow-ups', '#fb923c')}${tile('🔇', st.silent, 'Silent patients (2+ days)', '#fbbf24')}${tile('📅', st.today, "Today's appointments", '#2dd4bf')}</div>
    <div class="grid g2"><div class="card"><h3>Patient triage <span class="tiny">Most urgent first</span></h3>${D.patients.map(p => {
      const col = p.pulse >= 75 ? 'var(--ok)' : p.pulse >= 50 ? 'var(--warn)' : 'var(--danger)';
      return `<div class="pt ${p.status}" data-act="openPatient" data-id="${p.id}"><div class="avatar">${initials(p.name)}</div>
        <div><b>${esc(p.name)} ${p.unread ? `<span class="badge b-critical">${p.unread} new msg</span>` : ''}</b><span class="small muted">${esc(p.condition || '-')} · ${p.age || '-'}y</span><div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">${p.status === 'overdue' ? badge('overdue', p.overdue_count + ' overdue') : badge(p.status)}${p.status !== 'overdue' && p.overdue_count ? badge('overdue', p.overdue_count + ' overdue') : ''}${p.silent_days >= 2 && p.status !== 'silent' ? badge('silent', 'silent ' + p.silent_days + 'd') : ''}</div></div>
        <div class="hide-m small"><b>${p.last_level !== 'none' ? 'Score ' + p.last_score : 'No reports'}</b><span class="muted">${p.last_checkin ? fmtTs(p.last_checkin) : ''}</span></div>
        <div class="hide-m small"><b>${p.adherence ?? '-'}${p.adherence != null ? '%' : ''}</b><span class="muted">adherence 7d</span></div>
        <div class="mini" style="border-color:${col};color:${col}">${p.pulse}</div></div>`;
    }).join('') || '<div class="empty">No patients yet. Add one to get started.</div>'}</div>
    <div class="stack"><div class="card"><h3>Today's schedule</h3>${D.today.length ? D.today.map(a => `<div class="fu"><div><b>${fmt12(a.slot.slice(11))} · ${esc(a.name)}</b><span class="small muted">${esc(a.purpose)}</span></div></div>`).join('') : '<div class="empty">No visits today.</div>'}</div>
    <div class="card"><h3>Live activity</h3>${S.feed.length ? S.feed.map(f => `<div class="chk small">${f.icon} ${esc(f.text)} <span class="muted tiny">· ${f.t.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</span></div>`).join('') : '<div class="empty">Waiting for patient activity…<br><span class="tiny">Reports, bookings and messages appear here instantly.</span></div>'}</div></div></div></div>`;
}
function dDetail() {
  const X = S.detail, p = X.patient;
  const chk = X.checkins.slice().reverse();
  const adh = X.adherence_days;
  const overdue = X.followups.filter(f => f.state === 'overdue');
  return `<div class="stack"><button class="back" data-act="backDash">← All patients</button>
  <div class="card today"><div>${ring(p.pulse, 112)}</div><div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h2>${esc(p.name)}</h2>${p.status === 'overdue' ? '' : badge(p.status)}${overdue.length ? badge('overdue', overdue.length + ' overdue') : ''}${p.silent_days >= 2 ? badge('silent', 'silent ' + p.silent_days + 'd') : ''}</div>
    <div class="muted small" style="margin-top:4px">${esc(p.condition || '-')} · ${p.age || '-'} yrs · ${esc(p.phone || 'no phone')}</div>
    ${p.circumstances ? `<div class="small" style="margin-top:6px">🧭 ${esc(p.circumstances)}</div>` : ''}
    ${p.last_reasons && p.last_reasons.length ? `<div class="small" style="margin-top:6px;color:var(--warn)">Latest flags: ${p.last_reasons.map(esc).join(' · ')}</div>` : ''}
    <div class="pills"><button class="btn sm" data-act="rxModal">💊 Prescribe</button><button class="btn sm ghost" data-act="fuModal">📋 Add follow-up</button><button class="btn sm ghost" data-act="schedModal">📅 Schedule visit</button>${p.silent_days >= 2 ? `<button class="btn sm ghost" data-act="nudge">🔔 Nudge to check in</button>` : ''}</div></div></div>
  <div class="grid g2"><div class="stack">
    <div class="card"><h3>Recovery trends</h3><div class="grid" style="gap:14px"><div><div class="small muted">Pain (0-10)</div>${spark(chk.map(c => c.pain), { color: 'var(--danger)' })}</div>
      <div><div class="small muted">Temperature °C</div>${spark(chk.filter(c => c.temp).map(c => c.temp), { min: 36, max: 40, color: 'var(--warn)', fmt: v => v.toFixed(1) })}</div>
      <div><div class="small muted">Medicine adherence - last 7 days</div><div style="display:flex;gap:6px;align-items:flex-end;height:70px;margin-top:6px">${adh.map(d => { const pc = d.scheduled ? Math.round(100 * d.taken / d.scheduled) : 0; return `<div style="flex:1;text-align:center" title="${d.date}: ${d.taken}/${d.scheduled}"><div style="height:${Math.max(pc * .55, 4)}px;border-radius:6px;background:${d.scheduled ? (pc >= 80 ? 'var(--ok)' : pc >= 50 ? 'var(--warn)' : 'var(--danger)') : 'var(--card-b)'}"></div><div class="tiny muted">${d.date.slice(8)}</div></div>`; }).join('')}</div></div></div></div>
    <div class="card"><h3>Daily reports from patient <span class="tiny">${X.checkins.length}</span></h3>${X.checkins.length ? X.checkins.map(c => `<div class="chk"><div class="head"><b>${fmtDate(c.date)} · pain ${c.pain}/10${c.temp ? ' · ' + c.temp + '°C' : ''} · ${MOODS[c.mood - 1]}</b>${badge(c.risk_level)}</div>
      ${c.reasons.length ? `<div class="small" style="margin-top:6px;color:var(--warn)">${c.reasons.map(esc).join(' · ')}</div>` : ''}${c.note ? `<div class="small" style="margin-top:6px">“${esc(c.note)}”</div>` : ''}<div class="tiny muted" style="margin-top:4px">sleep ${c.sleep}h · energy ${ENERGY[c.energy - 1]} · ${fmtTs(c.created)}</div></div>`).join('') : '<div class="empty">No reports yet.</div>'}</div></div>
  <div class="stack">
    <div class="card"><h3>Follow-ups <button class="btn sm ghost" data-act="fuModal">＋</button></h3>${X.followups.length ? X.followups.map(f => `<div class="fu ${f.state === 'overdue' ? 'overdue' : ''}"><div><b>${f.kind === 'test' ? '🧪' : '🩺'} ${esc(f.title)}</b><span class="small muted">Due ${fmtDate(f.due_date)}${f.state === 'overdue' ? ' · ' + (f.missed_visit ? 'visit MISSED' : f.days_over + 'd OVERDUE - not booked') : f.appt && f.state === 'booked' ? ' · booked ' + fmtSlot(f.appt.slot) : ''}</span></div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end">${badge(f.state, STATE_LABEL[f.state])}${f.state === 'overdue' || f.state === 'pending' || f.state === 'due_soon' ? `<button class="btn sm" data-act="schedModal" data-fu="${f.id}">Schedule</button>` : ''}${f.state !== 'done' ? `<button class="btn ghost sm" data-act="fuDone" data-id="${f.id}">✓</button>` : ''}</div></div>`).join('') : '<div class="empty">No follow-ups.</div>'}</div>
    <div class="card"><h3>Appointments</h3>${X.appointments.length ? X.appointments.slice(0, 8).map(a => `<div class="fu"><div><b>${fmtSlot(a.slot)}</b><span class="small muted">${esc(a.purpose)}</span></div><div style="display:flex;gap:6px;align-items:center">${badge(a.status, a.status.toUpperCase())}${a.status === 'scheduled' || a.status === 'missed' ? `<button class="btn ghost sm" data-act="apptStatus" data-id="${a.id}" data-s="completed">Completed</button>` : ''}</div></div>`).join('') : '<div class="empty">No appointments.</div>'}</div>
    <div class="card"><h3>Medicines <button class="btn sm ghost" data-act="rxModal">＋ Prescribe</button></h3>${X.meds.filter(m => m.active).map(m => `<div class="med" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:8px"><div class="name">${esc(m.name)} <span class="muted small">${esc(m.dose)}</span></div><button class="btn ghost sm" data-act="stopMed" data-id="${m.id}">Stop</button></div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">${m.times.map(t => `<span class="timechip">${fmt12(t)}</span>`).join('')}<span class="mealchip">${esc(m.meal)}</span><span class="pill tiny">${m.days}d</span></div></div>`).join('') || '<div class="empty">No active medicines.</div>'}</div>
    <div class="card"><h3>Conversation</h3><div class="chat" id="dmsgs"></div>
      <div class="quick">${['Thanks for the update - continue the same medicines.', 'Please book your follow-up visit this week.', 'Please visit the hospital today for a check-up.'].map(q => `<button class="chip" data-act="quick" data-q="${esc(q)}">${esc(q.slice(0, 34))}…</button>`).join('')}</div>
      <div class="sendrow"><input id="reply" placeholder="Reply to ${esc(p.name.split(' ')[0])}…" autocomplete="off"><button class="btn" data-act="sendReply">Send</button></div></div>
  </div></div></div>`;
}
function paintDMsgs(scroll) {
  const box = $('#dmsgs'); if (!box || !S.detail) return;
  const atEnd = scroll || box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.innerHTML = S.detail.messages.length ? S.detail.messages.map(m => msgHTML(m, 'doctor')).join('') : '<div class="empty">No messages yet.</div>';
  if (atEnd) box.scrollTop = box.scrollHeight;
}

// ------------------------------------------------------------------ modals
function openModal(html) {
  closeModal();
  const bg = document.createElement('div');
  bg.className = 'modal-bg'; bg.id = 'modal';
  bg.innerHTML = `<div class="modal">${html}</div>`;
  bg.addEventListener('mousedown', e => { if (e.target === bg) closeModal(); });
  document.body.appendChild(bg);
}
function closeModal() { const m = $('#modal'); if (m) m.remove(); }
const TIMES = ['06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '21:00', '22:00'];
function rxModal() {
  S.rx = { times: new Set(['08:00', '20:00']) };
  openModal(`<h2>💊 Prescribe medicine</h2><div class="muted small">The patient gets reminders and a live notification instantly.</div>
    <label>Medicine</label><input id="rxName" placeholder="e.g. Amoxicillin">
    <div class="row"><div><label>Dose</label><input id="rxDose" placeholder="500 mg"></div><div><label>Duration (days)</label><input id="rxDays" type="number" value="7" min="1" max="365"></div></div>
    <label>Timing (tap to choose)</label><div class="chips" id="rxTimes">${rxTimesHTML()}</div>
    <div style="display:flex;gap:8px;margin-top:8px"><input type="time" id="rxCustom" style="max-width:150px"><button class="btn ghost sm" data-act="rxAddTime">+ custom time</button></div>
    <label>With food?</label><select id="rxMeal">${['After food', 'Before food', 'With food', 'Empty stomach', 'At bedtime', 'Any time'].map(m => `<option>${m}</option>`).join('')}</select>
    <label>Notes</label><input id="rxNotes" placeholder="e.g. Finish the full course">
    <div class="acts"><button class="btn ghost" data-act="closeModal">Cancel</button><button class="btn" data-act="rxSave">Prescribe</button></div>`);
}
const rxTimesHTML = () => [...new Set([...TIMES, ...S.rx.times])].sort().map(t => `<button class="chip ${S.rx.times.has(t) ? 'on' : ''}" data-act="rxTime" data-t="${t}">${fmt12(t)}</button>`).join('');
function fuModal() {
  const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
  openModal(`<h2>📋 Request a follow-up</h2><div class="muted small">If the patient does not book before the due date, it shows as <b>OVERDUE</b> on your dashboard.</div>
    <label>Title</label><input id="fuTitle" placeholder="e.g. Stitch removal, HbA1c test"><div class="row"><div><label>Type</label><select id="fuKind"><option value="visit">Visit</option><option value="test">Lab test</option></select></div><div><label>Due date</label><input id="fuDue" type="date" value="${d(7)}"></div></div>
    <div class="chips" style="margin-top:8px">${[[3, '3 days'], [7, '1 week'], [14, '2 weeks'], [30, '1 month']].map(x => `<button class="chip" data-act="fuQuick" data-v="${d(x[0])}">${x[1]}</button>`).join('')}</div>
    <div class="acts"><button class="btn ghost" data-act="closeModal">Cancel</button><button class="btn" data-act="fuSave">Send to patient</button></div>`);
}
async function schedModal(fu) {
  S.pick = { day: null, slot: null, fu: fu || '', purpose: '' };
  await loadSlots();
  openModal(`<h2>📅 Schedule next appointment</h2><div class="muted small">Pick a free slot - the patient is notified right away.</div><div id="pickarea" data-follow="1">${pickerHTML(true)}</div>
    <div class="acts"><button class="btn ghost" data-act="closeModal">Cancel</button><button class="btn" data-act="schedSave">Schedule</button></div>`);
}
function addPatientModal() {
  openModal(`<h2>＋ Add patient</h2><label>Full name</label><input id="apName"><label>Email</label><input id="apEmail" type="email"><div class="row"><div><label>Age</label><input id="apAge" type="number"></div><div><label>Phone</label><input id="apPhone"></div></div>
    <label>Condition</label><input id="apCond"><label>Circumstances</label><input id="apCirc" placeholder="lives alone, night shift…"><label>Temporary password</label><input id="apPass" value="welcome123">
    <div class="acts"><button class="btn ghost" data-act="closeModal">Cancel</button><button class="btn" data-act="apSave">Add patient</button></div>`);
}

// ------------------------------------------------------------------ dose alarm engine
function alarmTick() {
  if (S.role !== 'patient' || !S.data) return;
  const done = JSON.parse(localStorage.getItem('cb_alerted') || '{}');
  let changed = false;
  S.data.doses.forEach(d => {
    if (d.status === 'taken') return;
    const t = parseSlot(d.date + ' ' + d.time).getTime(), n = Date.now(), key = `${d.date}|${d.time}|${d.med_id}`;
    if (n >= t && n < t + 2 * 3600e3 && !done[key]) {
      done[key] = 1; changed = true;
      toast('💊 Time for your medicine', `${d.name} ${d.dose} - ${d.meal}`, 'warn');
      if (S.alarm) {
        beep(false);
        if ('Notification' in window && Notification.permission === 'granted') new Notification('CareBridge - medicine time', { body: `${d.name} ${d.dose} (${d.meal})` });
      }
    }
  });
  if (changed) { localStorage.setItem('cb_alerted', JSON.stringify(done)); if (S.view === 'today') render(); }
}
setInterval(alarmTick, 15000);
setInterval(() => { if (S.role === 'patient' && S.data && (S.view === 'today')) render(); }, 60000);
setInterval(() => { if (S.token && S.me) { const f = S.role === 'patient' ? loadHome() : loadDash(); f.then(() => { if (S.role === 'patient') alarmTick(); }).catch(() => {}); } }, 120000);

// ------------------------------------------------------------------ actions (event delegation)
const A = {
  authTab: a => { S.authTab = a.dataset.v; renderAuth(); },
  regRole: a => { S.regRole = a.dataset.v; renderAuth(); },
  login: wrapAsync(async () => { try { await doAuth('/api/login', { email: $('#lEmail').value, password: $('#lPass').value }); } catch (e) { $('#err').textContent = e.message; } }),
  demo: wrapAsync(async a => { await doAuth('/api/login', { email: a.dataset.e, password: a.dataset.p }); }),
  register: async () => {
    const pl = { role: S.regRole, name: $('#rName').value, email: $('#rEmail').value, password: $('#rPass').value, phone: $('#rPhone').value };
    if (S.regRole === 'patient') Object.assign(pl, { age: $('#rAge').value, doctor_id: $('#rDoc').value, condition: $('#rCond').value, circumstances: $('#rCirc').value });
    else pl.code = $('#rCode').value;
    try { await doAuth('/api/register', pl); } catch (e) { $('#err').textContent = e.message; }
  },
  logout: () => logout(),
  theme: () => { const l = document.documentElement.dataset.theme === 'light'; document.documentElement.dataset.theme = l ? '' : 'light'; localStorage.setItem('cb_theme', l ? '' : 'light'); },
  largeText: () => { const on = document.documentElement.classList.toggle('large'); localStorage.setItem('cb_large', on ? '1' : ''); },
  nav: a => { S.view = a.dataset.v; if (S.view === 'chat') { S.unread = 0; } if (S.view === 'checkin') S.lastResult = null; if (S.view === 'appts') loadSlots().then(() => render()); render(); window.scrollTo({ top: 0 }); },
  // patient
  take: wrapAsync(async a => { await api('/api/patient/med/take', { med_id: +a.dataset.med, time: a.dataset.time, date: a.dataset.date, undo: a.dataset.undo === '1' }); if (a.dataset.undo !== '1') toast('✅ Dose recorded', 'Great job staying on track!'); await loadHome(); render(); }),
  goBook: wrapAsync(async a => { S.pick = { day: null, slot: null, fu: a.dataset.id, purpose: '' }; await loadSlots(); S.view = 'appts'; render(); window.scrollTo({ top: 0 }); }),
  mood: a => { S.ci[a.dataset.k] = +a.dataset.v; $$(`[data-act=mood][data-k=${a.dataset.k}]`).forEach(b => b.classList.toggle('on', b === a)); },
  flag: a => { const f = a.dataset.f, i = S.ci.flags.indexOf(f); if (i >= 0) S.ci.flags.splice(i, 1); else S.ci.flags.push(f); a.classList.toggle('on'); },
  voice: a => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast('Voice not supported', 'Try Chrome or Edge on desktop / Android.', 'warn');
    const r = new SR(); r.lang = a.dataset.l; r.interimResults = false;
    r.onresult = e => { const ta = $('#ciNote'); ta.value = (ta.value + ' ' + e.results[0][0].transcript).trim(); S.ci.note = ta.value; };
    r.onerror = () => toast('Could not hear you', 'Please allow the microphone and try again.', 'warn');
    r.start(); toast('🎤 Listening…', a.dataset.l === 'ta-IN' ? 'Speak in Tamil' : 'Speak now');
  },
  submitCheckin: wrapAsync(async () => {
    const c = S.ci;
    S.lastResult = await api('/api/patient/checkin', { pain: c.pain, temp: c.temp, mood: c.mood, sleep: c.sleep, energy: c.energy, flags: c.flags, note: c.note });
    resetCi(); if (S.lastResult.level === 'critical') beep(true); await loadHome(); render();
  }),
  doneResult: () => { S.lastResult = null; S.view = 'today'; render(); },
  toggleAlarm: async () => {
    if (!S.alarm && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) { /* ignore */ } }
    S.alarm = !S.alarm; localStorage.setItem('cb_alarm', S.alarm ? '1' : ''); if (S.alarm) beep(false);
    const b = $('#alarmBtn'); if (b) b.textContent = S.alarm ? '🔔' : '🔕'; toast(S.alarm ? 'Alarm enabled' : 'Alarm off', S.alarm ? 'You will hear a chime at each dose time.' : '', ''); render();
  },
  testAlarm: () => { beep(false); toast('💊 Time for your medicine', 'This is how your reminder will look'); },
  pickDay: a => { S.pick.day = a.dataset.d; S.pick.slot = null; repaintPicker(); },
  pickSlot: a => { S.pick.slot = a.dataset.s; repaintPicker(); },
  confirmBook: wrapAsync(async () => {
    if (!S.pick.slot) return toast('Pick a time', 'Choose a slot first.', 'warn');
    try { await api('/api/patient/book', { slot: S.pick.slot, followup_id: S.pick.fu || null, purpose: S.pick.purpose || 'Follow-up visit' }); }
    catch (e) { await loadSlots(); S.pick.slot = null; render(); throw e; }
    toast('✅ Appointment booked', fmtSlot(S.pick.slot)); S.pick = { day: null, slot: null, fu: '', purpose: '' };
    await Promise.all([loadHome(), loadSlots()]); render();
  }),
  cancelAppt: wrapAsync(async a => { if (!confirm('Cancel this appointment?')) return; await api('/api/patient/cancel', { appt_id: +a.dataset.id }); await Promise.all([loadHome(), loadSlots()]); render(); }),
  sendMsg: wrapAsync(async () => { const i = $('#msgInput'), v = i.value.trim(); if (!v) return; i.value = ''; await api('/api/patient/message', { body: v }); await loadHome(); paintMsgs(true); }),
  copyUrl: () => { navigator.clipboard && navigator.clipboard.writeText(S.data.passport_url); toast('Link copied', 'Share it with family or caregivers.'); },
  rotate: wrapAsync(async () => { if (!confirm('This makes the old QR code stop working. Continue?')) return; await api('/api/patient/passport/rotate', {}); await loadHome(); S.view = 'passport'; $('#view').innerHTML = pPassport(); toast('New QR generated', 'The previous code no longer works.'); }),
  saveProfile: wrapAsync(async () => { await api('/api/patient/profile', { circumstances: $('#circ').value, phone: $('#phone').value }); await loadHome(); toast('Saved', 'Your care tips have been updated.'); }),
  // doctor
  openPatient: wrapAsync(async a => { S.sel = +a.dataset.id; S.detail = null; await loadDetail(S.sel); await loadDash(); render(); window.scrollTo({ top: 0 }); }),
  backDash: wrapAsync(async () => { S.sel = null; S.detail = null; await loadDash(); render(); }),
  closeModal,
  rxTime: a => { const t = a.dataset.t; S.rx.times.has(t) ? S.rx.times.delete(t) : S.rx.times.add(t); $('#rxTimes').innerHTML = rxTimesHTML(); },
  rxAddTime: () => { const v = $('#rxCustom').value; if (v) { S.rx.times.add(v); $('#rxTimes').innerHTML = rxTimesHTML(); } },
  rxModal, fuModal, addPatient: addPatientModal,
  rxSave: wrapAsync(async () => {
    await api('/api/doctor/prescribe', { patient_id: S.sel, name: $('#rxName').value, dose: $('#rxDose').value, days: $('#rxDays').value, times: [...S.rx.times], meal: $('#rxMeal').value, notes: $('#rxNotes').value });
    closeModal(); toast('💊 Prescribed', 'Reminders were set on the patient\'s profile.'); await loadDetail(S.sel); render();
  }),
  stopMed: wrapAsync(async a => { if (!confirm('Stop this medicine?')) return; await api('/api/doctor/med/stop', { med_id: +a.dataset.id }); await loadDetail(S.sel); render(); }),
  fuQuick: a => { $('#fuDue').value = a.dataset.v; },
  fuSave: wrapAsync(async () => { await api('/api/doctor/followup', { patient_id: S.sel, title: $('#fuTitle').value, kind: $('#fuKind').value, due_date: $('#fuDue').value }); closeModal(); toast('📋 Follow-up requested', 'The patient has been notified.'); await Promise.all([loadDetail(S.sel), loadDash()]); render(); }),
  fuDone: wrapAsync(async a => { await api('/api/doctor/followup/done', { followup_id: +a.dataset.id }); await Promise.all([loadDetail(S.sel), loadDash()]); render(); }),
  schedModal: a => schedModal(a.dataset.fu),
  schedSave: wrapAsync(async () => {
    if (!S.pick.slot) return toast('Pick a time', 'Choose a slot first.', 'warn');
    try { await api('/api/doctor/schedule', { patient_id: S.sel, slot: S.pick.slot, followup_id: S.pick.fu || null, purpose: S.pick.purpose || 'Follow-up visit' }); }
    catch (e) { await loadSlots(); S.pick.slot = null; repaintPicker(); throw e; }
    closeModal(); toast('📅 Scheduled', fmtSlot(S.pick.slot)); await Promise.all([loadDetail(S.sel), loadDash()]); render();
  }),
  apptStatus: wrapAsync(async a => { await api('/api/doctor/appt/status', { appt_id: +a.dataset.id, status: a.dataset.s }); await Promise.all([loadDetail(S.sel), loadDash()]); render(); }),
  sendReply: wrapAsync(async () => { const i = $('#reply'), v = i.value.trim(); if (!v) return; i.value = ''; await api('/api/doctor/reply', { patient_id: S.sel, body: v }); await loadDetail(S.sel); paintDMsgs(true); }),
  quick: a => { $('#reply').value = a.dataset.q; $('#reply').focus(); },
  nudge: wrapAsync(async () => { await api('/api/doctor/nudge', { patient_id: S.sel }); toast('Nudge sent', 'The patient was reminded to check in.'); await loadDetail(S.sel); render(); }),
  apSave: wrapAsync(async () => {
    const r = await api('/api/doctor/patient', { name: $('#apName').value, email: $('#apEmail').value, age: $('#apAge').value, phone: $('#apPhone').value, condition: $('#apCond').value, circumstances: $('#apCirc').value, password: $('#apPass').value });
    closeModal(); toast('Patient added', 'Temporary password: ' + r.temp_password); await loadDash(); render();
  })
};
document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]');
  if (!a || a.tagName === 'A') return;
  const fn = A[a.dataset.act]; if (fn) fn(a, e);
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.bind && S.ci) { S.ci[t.dataset.bind] = t.value; if (t.dataset.bind === 'pain') $('#painv').textContent = t.value; }
  if (t.dataset.bindPick) {
    S.pick[t.dataset.bindPick] = t.value;
    if (t.dataset.bindPick === 'fu') { const w = $('#purposeWrap'); if (w) w.classList.toggle('hidden', !!t.value); }
  }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'msgInput') A.sendMsg(); else if (e.target.id === 'reply') A.sendReply();
  else if (e.target.id === 'lPass' || e.target.id === 'lEmail') A.login();
});

// ------------------------------------------------------------------ init
if (localStorage.getItem('cb_theme') === 'light') document.documentElement.dataset.theme = 'light';
if (localStorage.getItem('cb_large')) document.documentElement.classList.add('large');
if (S.token) boot(); else renderAuth();
})();
