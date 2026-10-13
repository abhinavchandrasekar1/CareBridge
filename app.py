"""
CareBridge - Continuity-of-Care Platform (SYNESIS 26, Healthcare Problem #2)
Flask + SQLite + Server-Sent Events (real-time) + QR + PDF.

Run:  python app.py        ->  http://localhost:5000
Demo: patient@demo / patient123   |   doctor@demo / doctor123
"""
import io
import json
import os
import queue
import secrets
import socket
import sqlite3
import threading
from datetime import datetime, timedelta, date, time as dtime
from functools import wraps

import qrcode
from flask import (Flask, Response, abort, g, jsonify, render_template_string,
                   request, send_file, send_from_directory)
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import (Image, Paragraph, SimpleDocTemplate, Spacer,
                                Table, TableStyle)
from werkzeug.security import check_password_hash, generate_password_hash

os.environ.setdefault("TZ", "Asia/Kolkata")
if hasattr(__import__("time"), "tzset"):
    __import__("time").tzset()

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("CAREBRIDGE_DB", os.path.join(BASE, "carebridge.db"))
DOCTOR_CODE = os.environ.get("DOCTOR_CODE", "SYNESIS26")

app = Flask(__name__, static_folder="static", static_url_path="/static")

# --------------------------------------------------------------------------
# Database helpers
# --------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL, pw TEXT NOT NULL, phone TEXT DEFAULT '',
  created TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
  created TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS patients(
  user_id INTEGER PRIMARY KEY, doctor_id INTEGER NOT NULL, age INTEGER DEFAULT 0,
  condition TEXT DEFAULT '', circumstances TEXT DEFAULT '', emergency_contact TEXT DEFAULT '',
  passport_token TEXT UNIQUE, discharge_date TEXT);
CREATE TABLE IF NOT EXISTS meds(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL, name TEXT NOT NULL,
  dose TEXT DEFAULT '', times TEXT NOT NULL, meal TEXT DEFAULT 'Any time', notes TEXT DEFAULT '',
  start_date TEXT NOT NULL, days INTEGER DEFAULT 7, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS med_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, med_id INTEGER NOT NULL, patient_id INTEGER NOT NULL,
  date TEXT NOT NULL, time TEXT NOT NULL, taken_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(med_id, date, time));
CREATE TABLE IF NOT EXISTS appointments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL, doctor_id INTEGER NOT NULL,
  slot TEXT NOT NULL, purpose TEXT DEFAULT 'Follow-up visit', status TEXT DEFAULT 'scheduled',
  created_by TEXT DEFAULT 'patient', created TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS followups(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL, title TEXT NOT NULL,
  kind TEXT DEFAULT 'visit', due_date TEXT NOT NULL, status TEXT DEFAULT 'pending',
  appt_id INTEGER, created TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS checkins(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL, date TEXT NOT NULL,
  pain INTEGER DEFAULT 0, temp REAL, mood INTEGER DEFAULT 3, sleep REAL DEFAULT 7,
  energy INTEGER DEFAULT 3, flags TEXT DEFAULT '[]', note TEXT DEFAULT '',
  risk_score INTEGER DEFAULT 0, risk_level TEXT DEFAULT 'low', reasons TEXT DEFAULT '[]',
  created TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL, sender TEXT NOT NULL,
  body TEXT NOT NULL, created TEXT DEFAULT (datetime('now','localtime')), read INTEGER DEFAULT 0);
"""


def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=15)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys=ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    d = g.pop("db", None)
    if d is not None:
        d.close()


def q(sql, args=(), one=False):
    rows = db().execute(sql, args).fetchall()
    if one:
        return rows[0] if rows else None
    return rows


def ex(sql, args=()):
    cur = db().execute(sql, args)
    db().commit()
    return cur.lastrowid


def rows(sql, args=()):
    return [dict(r) for r in q(sql, args)]


def now():
    return datetime.now()


def today_s():
    return date.today().strftime("%Y-%m-%d")


def body():
    return request.get_json(silent=True) or {}


# --------------------------------------------------------------------------
# Real-time (Server-Sent Events)
# --------------------------------------------------------------------------
SUBS = {}
SUBS_LOCK = threading.Lock()


def publish(user_id, event, data=None):
    with SUBS_LOCK:
        for qu in list(SUBS.get(user_id, ())):
            qu.put((event, data or {}))


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------
def auth(role=None):
    def deco(f):
        @wraps(f)
        def wrapper(*a, **k):
            tok = request.headers.get("Authorization", "").replace("Bearer ", "") or request.args.get("t", "")
            u = q("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?", (tok,), one=True)
            if not u:
                return jsonify(error="Please sign in again"), 401
            if role and u["role"] != role:
                return jsonify(error="Not allowed"), 403
            g.user = u
            return f(*a, **k)
        return wrapper
    return deco


def new_session(uid):
    tok = secrets.token_urlsafe(32)
    ex("INSERT INTO sessions(token,user_id) VALUES(?,?)", (tok, uid))
    return tok


def new_passport_token():
    return secrets.token_urlsafe(9)


# --------------------------------------------------------------------------
# Clinical logic: risk engine, adherence, follow-ups, recovery pulse
# --------------------------------------------------------------------------
RED_FLAGS = {"chest_pain": "Chest pain", "breathless": "Difficulty breathing",
             "bleeding": "Uncontrolled bleeding", "fainting": "Fainting / blackout"}
AMBER_FLAGS = {"wound_infection": ("Wound redness / pus / swelling", 25),
               "vomiting": ("Persistent vomiting", 15), "swelling": ("New leg / body swelling", 15),
               "dizziness": ("Dizziness", 12), "missed_meds": ("Could not take medicines", 12),
               "confusion": ("Confusion / unusual drowsiness", 30)}


def assess_risk(pain, temp, mood, sleep, energy, flags):
    """Transparent, rule-based triage - explainable, never replaces clinical judgment."""
    score, reasons, red = 0, [], False
    for f in flags:
        if f in RED_FLAGS:
            score += 50
            red = True
            reasons.append(f"Red-flag symptom: {RED_FLAGS[f]}")
        elif f in AMBER_FLAGS:
            label, w = AMBER_FLAGS[f]
            score += w
            reasons.append(label)
    if pain >= 8:
        score += 30; reasons.append(f"Severe pain ({pain}/10)")
    elif pain >= 6:
        score += 18; reasons.append(f"High pain ({pain}/10)")
    elif pain >= 4:
        score += 8; reasons.append(f"Moderate pain ({pain}/10)")
    if temp:
        if temp >= 39.0:
            score += 25; reasons.append(f"High fever ({temp:.1f} C)")
        elif temp >= 38.0:
            score += 15; reasons.append(f"Fever ({temp:.1f} C)")
        elif temp < 35.5:
            score += 10; reasons.append(f"Low body temperature ({temp:.1f} C)")
    if mood <= 2:
        score += 8; reasons.append("Low mood")
    if sleep < 4:
        score += 5; reasons.append("Very little sleep")
    if energy <= 1:
        score += 6; reasons.append("Very low energy")
    level = "low"
    if red or score >= 50:
        level = "critical"
    elif score >= 30:
        level = "high"
    elif score >= 12:
        level = "moderate"
    return min(score, 100), level, reasons


ADVICE = {
    "critical": "Warning signs detected - your doctor has been alerted immediately. If you feel unsafe or symptoms are severe, call 108 (ambulance) or go to the nearest emergency room now.",
    "high": "Your doctor will review this today. Rest, take your medicines on time and message us if anything gets worse.",
    "moderate": "A few things need watching. Your care team can see this. Keep logging daily.",
    "low": "You're on track. Keep taking your medicines and logging daily - small steps count.",
}


def active_meds(pid, on_date=None):
    d = on_date or today_s()
    out = []
    for m in q("SELECT * FROM meds WHERE patient_id=? AND active=1", (pid,)):
        start = datetime.strptime(m["start_date"], "%Y-%m-%d").date()
        end = start + timedelta(days=m["days"] - 1)
        if start <= datetime.strptime(d, "%Y-%m-%d").date() <= end:
            out.append(m)
    return out


def todays_doses(pid):
    n = now()
    out = []
    for m in active_meds(pid):
        for t in json.loads(m["times"]):
            taken = q("SELECT 1 FROM med_logs WHERE med_id=? AND date=? AND time=?", (m["id"], today_s(), t), one=True)
            sched = datetime.strptime(f"{today_s()} {t}", "%Y-%m-%d %H:%M")
            if taken:
                st = "taken"
            elif n > sched + timedelta(hours=2):
                st = "missed"
            elif n >= sched - timedelta(minutes=30):
                st = "due"
            else:
                st = "upcoming"
            out.append({"med_id": m["id"], "name": m["name"], "dose": m["dose"], "meal": m["meal"],
                        "time": t, "status": st, "date": today_s()})
    out.sort(key=lambda x: x["time"])
    return out


def adherence(pid, days=7):
    n = now()
    sched = taken = 0
    for i in range(days):
        d = (date.today() - timedelta(days=i)).strftime("%Y-%m-%d")
        for m in active_meds(pid, d):
            for t in json.loads(m["times"]):
                when = datetime.strptime(f"{d} {t}", "%Y-%m-%d %H:%M")
                if when > n:
                    continue
                sched += 1
                if q("SELECT 1 FROM med_logs WHERE med_id=? AND date=? AND time=?", (m["id"], d, t), one=True):
                    taken += 1
    return None if sched == 0 else round(100 * taken / sched)


def refresh_missed():
    """Appointments whose slot passed an hour ago without being completed become 'missed'."""
    cutoff = (now() - timedelta(minutes=60)).strftime("%Y-%m-%d %H:%M")
    db().execute("UPDATE appointments SET status='missed' WHERE status='scheduled' AND slot < ?", (cutoff,))
    db().commit()


def followup_view(f):
    f = dict(f)
    due = datetime.strptime(f["due_date"], "%Y-%m-%d").date()
    delta = (due - date.today()).days
    appt = q("SELECT * FROM appointments WHERE id=?", (f["appt_id"],), one=True) if f["appt_id"] else None
    f["appt"] = dict(appt) if appt else None
    if f["status"] == "done":
        f["state"] = "done"
    elif appt and appt["status"] == "scheduled":
        f["state"] = "booked"
    elif appt and appt["status"] == "missed":
        f["state"] = "overdue"
        f["days_over"] = max(1, -delta) if delta < 0 else 1
        f["missed_visit"] = True
    elif delta < 0:
        f["state"] = "overdue"
        f["days_over"] = -delta
    elif delta <= 2:
        f["state"] = "due_soon"
        f["days_left"] = delta
    else:
        f["state"] = "pending"
        f["days_left"] = delta
    return f


def followups_for(pid):
    refresh_missed()
    return [followup_view(f) for f in q(
        "SELECT * FROM followups WHERE patient_id=? ORDER BY due_date", (pid,))]


def latest_checkin(pid):
    r = q("SELECT * FROM checkins WHERE patient_id=? ORDER BY id DESC LIMIT 1", (pid,), one=True)
    return dict(r) if r else None


def silent_days(pid):
    last = latest_checkin(pid)
    p = q("SELECT discharge_date FROM patients WHERE user_id=?", (pid,), one=True)
    base = last["date"] if last else (p["discharge_date"] if p and p["discharge_date"] else today_s())
    return (date.today() - datetime.strptime(base, "%Y-%m-%d").date()).days


def recovery_pulse(pid):
    """0-100 composite: adherence 40% + latest symptom risk 40% + follow-up health 20%."""
    adh = adherence(pid)
    adh_v = 80 if adh is None else adh
    last = latest_checkin(pid)
    sym = {"low": 95, "moderate": 70, "high": 42, "critical": 15}.get(last["risk_level"], 70) if last else 65
    sd = silent_days(pid)
    if sd >= 3:
        sym -= 15
    over = sum(1 for f in followups_for(pid) if f["state"] == "overdue")
    fu = max(0, 100 - 35 * over)
    return max(0, min(100, round(0.4 * adh_v + 0.4 * max(sym, 0) + 0.2 * fu)))


def care_tips(p):
    """Personalised plan tips adapted to the patient's stated circumstances."""
    txt = f"{p.get('circumstances', '')} {p.get('condition', '')}".lower()
    tips = []
    if any(k in txt for k in ("alone", "live by myself", "no one")):
        tips.append("You live alone: share your Care Passport QR with a neighbour or friend so they can see your medicine timings in an emergency.")
    if any(k in txt for k in ("night shift", "night duty", "shift")):
        tips.append("Shift work: anchor doses to your wake-up and meal times, not the clock. Tell your doctor so timings can be adjusted.")
    if any(k in txt for k in ("village", "rural", "far", "remote", "no transport", "travel")):
        tips.append("Travel is hard for you: ask your doctor if a teleconsult can replace a follow-up, and book the earliest slots to avoid repeat trips.")
    if any(k in txt for k in ("vision", "eye", "cannot read", "blind")):
        tips.append("Low vision: enable the large-text mode (top right) and rely on audible dose reminders.")
    if any(k in txt for k in ("diabet", "sugar")):
        tips.append("Diabetes: log fasting sugar in your daily note and never skip meals when taking tablets.")
    if any(k in txt for k in ("bp", "hypertension", "pressure")):
        tips.append("Blood pressure: reduce salt and note any dizziness in your check-in.")
    if any(k in txt for k in ("surgery", "operation", "appendix", "knee", "replacement", "stent", "wound")):
        tips.append("Post-surgery: keep the wound dry, watch for redness/pus/fever and tick the warning-sign box if you notice any.")
    if (p.get("age") or 0) >= 65:
        tips.append("Use a weekly pill organiser and ask a family member to review your dose log on Sundays.")
    if not tips:
        tips.append("Log how you feel once a day - 30 seconds. It helps your doctor spot problems before they grow.")
    return tips[:4]


def patient_row(pid):
    r = q("""SELECT u.id, u.name, u.email, u.phone, p.* FROM users u JOIN patients p ON p.user_id=u.id WHERE u.id=?""",
          (pid,), one=True)
    return dict(r) if r else None


def triage_summary(pid):
    last = latest_checkin(pid)
    fus = followups_for(pid)
    overdue = [f for f in fus if f["state"] == "overdue"]
    sd = silent_days(pid)
    unread = q("SELECT COUNT(*) c FROM messages WHERE patient_id=? AND sender='patient' AND read=0", (pid,), one=True)["c"]
    adh = adherence(pid)
    level = last["risk_level"] if last else "none"
    status = "stable"
    if level == "critical":
        status = "critical"
    elif overdue:
        status = "overdue"
    elif level == "high":
        status = "high"
    elif sd >= 2:
        status = "silent"
    prio = {"critical": 0, "overdue": 1, "high": 2, "silent": 3, "stable": 4}[status]
    return {"status": status, "priority": prio, "last_level": level,
            "last_score": last["risk_score"] if last else None,
            "last_checkin": last["created"] if last else None,
            "last_reasons": json.loads(last["reasons"]) if last else [],
            "silent_days": sd, "overdue_count": len(overdue), "adherence": adh,
            "unread": unread, "pulse": recovery_pulse(pid)}


# --------------------------------------------------------------------------
# Slots
# --------------------------------------------------------------------------
def free_slots(doctor_id, days=10):
    n = now()
    booked = {r["slot"] for r in q("SELECT slot FROM appointments WHERE doctor_id=? AND status='scheduled'", (doctor_id,))}
    out = []
    for d in range(days):
        day = (n + timedelta(days=d)).date()
        if day.weekday() == 6:  # Sunday off
            continue
        for h in range(9, 17):
            for m in (0, 30):
                if h == 13 or (h == 16 and m == 30):
                    continue
                s = datetime.combine(day, dtime(h, m))
                if s <= n + timedelta(minutes=30):
                    continue
                st = s.strftime("%Y-%m-%d %H:%M")
                if st not in booked:
                    out.append(st)
    return out


def book(patient_id, doctor_id, slot, purpose, followup_id, by):
    if slot not in free_slots(doctor_id, 14):
        return None, "That slot is no longer available - please pick another."
    aid = ex("INSERT INTO appointments(patient_id,doctor_id,slot,purpose,created_by) VALUES(?,?,?,?,?)",
             (patient_id, doctor_id, slot, purpose, by))
    if followup_id:
        ex("UPDATE followups SET appt_id=?, status='pending' WHERE id=? AND patient_id=?", (aid, followup_id, patient_id))
    return aid, None


# --------------------------------------------------------------------------
# QR + PDF + public Care Passport
# --------------------------------------------------------------------------
def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def base_url():
    pu = os.environ.get("PUBLIC_URL")
    if pu:
        return pu.rstrip("/")
    host = request.host
    if host.startswith(("localhost", "127.0.0.1")):
        port = host.split(":")[1] if ":" in host else "80"
        return f"http://{lan_ip()}:{port}"
    return request.host_url.rstrip("/")


def make_qr_png(url, box=8):
    img = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=box, border=2)
    img.add_data(url)
    img.make(fit=True)
    buf = io.BytesIO()
    img.make_image(fill_color="#0b3b3c", back_color="white").save(buf, format="PNG")
    buf.seek(0)
    return buf


def passport_data(token):
    p = q("""SELECT u.id, u.name, p.*, d.name AS doctor_name, d.phone AS doctor_phone
             FROM patients p JOIN users u ON u.id=p.user_id JOIN users d ON d.id=p.doctor_id
             WHERE p.passport_token=?""", (token,), one=True)
    if not p:
        return None
    p = dict(p)
    meds = []
    for m in active_meds(p["id"]):
        start = datetime.strptime(m["start_date"], "%Y-%m-%d").date()
        meds.append({"name": m["name"], "dose": m["dose"], "times": json.loads(m["times"]), "meal": m["meal"],
                     "notes": m["notes"], "ends": (start + timedelta(days=m["days"] - 1)).strftime("%d %b %Y")})
    refresh_missed()
    appts = rows("SELECT slot,purpose FROM appointments WHERE patient_id=? AND status='scheduled' ORDER BY slot", (p["id"],))
    # next dose
    n = now()
    nxt = None
    for m in meds:
        for t in m["times"]:
            when = datetime.strptime(f"{today_s()} {t}", "%Y-%m-%d %H:%M")
            if when >= n and (nxt is None or when < nxt[0]):
                nxt = (when, m["name"], m["dose"], t)
    first = p["name"].split()[0]
    return {"first_name": first, "doctor": p["doctor_name"], "doctor_phone": p["doctor_phone"], "meds": meds,
            "appts": appts, "next_dose": {"med": nxt[1], "dose": nxt[2], "time": nxt[3]} if nxt else None,
            "generated": n.strftime("%d %b %Y, %I:%M %p")}


PASSPORT_HTML = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Care Passport - {{d.first_name}}</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:linear-gradient(160deg,#052f31,#0b5d5b 55%,#14b8a6);min-height:100vh;color:#0f2b2c;padding:18px}
.card{max-width:560px;margin:0 auto 14px;background:#fff;border-radius:22px;padding:20px;box-shadow:0 18px 50px rgba(0,0,0,.25)}
h1{margin:0;font-size:22px}h2{margin:0 0 10px;font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:#0b7a75}
.brand{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}.badge{background:#e6fffb;color:#0b7a75;border-radius:99px;padding:4px 10px;font-size:12px;font-weight:700}
.next{background:linear-gradient(135deg,#0b7a75,#14b8a6);color:#fff}.next h2{color:#c8fff6}.big{font-size:28px;font-weight:800}
.med{border:1px solid #d7eeee;border-radius:16px;padding:12px;margin-bottom:10px}.med b{font-size:17px}.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.chip{background:#e6fffb;color:#075e59;border-radius:99px;padding:4px 11px;font-weight:700;font-size:14px}.meal{background:#fff4d6;color:#8a5a00}
.muted{color:#5b7778;font-size:13px}.btn{display:block;text-align:center;background:#0b7a75;color:#fff;text-decoration:none;font-weight:700;padding:14px;border-radius:14px;margin-top:6px}
.lang{background:none;border:1px solid #bfe3e0;border-radius:99px;padding:5px 12px;cursor:pointer;font-weight:700;color:#0b7a75}
.warn{font-size:12px;color:#5b7778;text-align:center;max-width:560px;margin:0 auto;color:#d5f5f1}
</style></head><body>
<div class="card"><div class="brand"><div><span class="badge">CareBridge Care Passport</span></div>
<button class="lang" onclick="toggle()" id="lb">தமிழ்</button></div>
<h1><span data-t="hi">Medicine plan for</span> {{d.first_name}}</h1>
<div class="muted"><span data-t="doc">Doctor</span>: {{d.doctor}}{% if d.doctor_phone %} - {{d.doctor_phone}}{% endif %} &middot; <span data-t="upd">Updated</span> {{d.generated}}</div></div>
{% if d.next_dose %}<div class="card next"><h2 data-t="next">Next dose today</h2><div class="big">{{d.next_dose.time}}</div>
<div>{{d.next_dose.med}} {{d.next_dose.dose}}</div></div>{% endif %}
<div class="card"><h2 data-t="meds">Medicines & timing</h2>
{% for m in d.meds %}<div class="med"><b>{{m.name}}</b> <span class="muted">{{m.dose}}</span>
<div class="chips">{% for t in m.times %}<span class="chip">{{t}}</span>{% endfor %}<span class="chip meal">{{m.meal}}</span></div>
{% if m.notes %}<div class="muted" style="margin-top:6px">{{m.notes}}</div>{% endif %}
<div class="muted" style="margin-top:4px"><span data-t="till">Continue until</span> {{m.ends}}</div></div>
{% else %}<div class="muted">No active medicines.</div>{% endfor %}</div>
<div class="card"><h2 data-t="appt">Next appointments</h2>
{% for a in d.appts %}<div class="med"><b>{{a.slot}}</b><div class="muted">{{a.purpose}}</div></div>
{% else %}<div class="muted">No upcoming appointments.</div>{% endfor %}
<a class="btn" href="{{pdf}}" data-t="pdf">Download as PDF</a></div>
<div class="warn">This passport shows medicine timing only. It does not replace your doctor's advice. In an emergency call 108.</div>
<script>
var T={en:{hi:"Medicine plan for",doc:"Doctor",upd:"Updated",next:"Next dose today",meds:"Medicines & timing",till:"Continue until",appt:"Next appointments",pdf:"Download as PDF"},
ta:{hi:"மருந்து அட்டவணை -",doc:"மருத்துவர்",upd:"புதுப்பிப்பு",next:"இன்றைய அடுத்த மருந்து",meds:"மருந்துகள் & நேரம்",till:"இது வரை தொடரவும்",appt:"அடுத்த சந்திப்புகள்",pdf:"PDF பதிவிறக்கம்"}};
var cur="en";function toggle(){cur=cur==="en"?"ta":"en";document.querySelectorAll("[data-t]").forEach(function(e){e.textContent=T[cur][e.dataset.t]});document.getElementById("lb").textContent=cur==="en"?"தமிழ்":"English"}
</script></body></html>"""


def build_pdf(d, url):
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=1.8 * cm, rightMargin=1.8 * cm,
                            topMargin=1.6 * cm, bottomMargin=1.6 * cm, title="CareBridge Care Passport")
    ss = getSampleStyleSheet()
    teal = colors.HexColor("#0b7a75")
    h1 = ParagraphStyle("h1", parent=ss["Title"], textColor=teal, fontSize=22, alignment=0, spaceAfter=2)
    h2 = ParagraphStyle("h2", parent=ss["Heading2"], textColor=teal, fontSize=13, spaceBefore=12)
    nm = ParagraphStyle("nm", parent=ss["Normal"], fontSize=10, leading=14)
    small = ParagraphStyle("sm", parent=ss["Normal"], fontSize=8, textColor=colors.grey)
    story = [Paragraph("CareBridge Care Passport", h1),
             Paragraph(f"Medicine &amp; timing plan for <b>{d['first_name']}</b> &nbsp;|&nbsp; Doctor: {d['doctor']}"
                       f"{(' (' + d['doctor_phone'] + ')') if d['doctor_phone'] else ''}", nm),
             Paragraph(f"Generated {d['generated']}", small), Spacer(1, 8)]
    if d["next_dose"]:
        nd = d["next_dose"]
        story.append(Paragraph(f"<b>Next dose today:</b> {nd['med']} {nd['dose']} at <b>{nd['time']}</b>", nm))
    story.append(Paragraph("Medicines &amp; timing", h2))
    data = [["Medicine", "Dose", "Timing", "With food", "Until"]]
    for m in d["meds"]:
        data.append([Paragraph(f"<b>{m['name']}</b>" + (f"<br/><font size=8 color='grey'>{m['notes']}</font>" if m["notes"] else ""), nm),
                     m["dose"], "  ".join(m["times"]), m["meal"], m["ends"]])
    if len(data) == 1:
        data.append(["No active medicines", "", "", "", ""])
    t = Table(data, colWidths=[5.2 * cm, 2.6 * cm, 4 * cm, 2.8 * cm, 2.4 * cm], repeatRows=1)
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), teal), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                           ("FONTSIZE", (0, 0), (-1, -1), 9), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                           ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#effaf9")]),
                           ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#c9e6e3")),
                           ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
    story.append(t)
    story.append(Paragraph("Upcoming appointments", h2))
    if d["appts"]:
        for a in d["appts"]:
            story.append(Paragraph(f"&bull; <b>{a['slot']}</b> - {a['purpose']}", nm))
    else:
        story.append(Paragraph("No upcoming appointments. Please book your follow-up in the CareBridge app.", nm))
    story.append(Spacer(1, 14))
    qr = Image(make_qr_png(url), 3.4 * cm, 3.4 * cm)
    foot = Table([[qr, Paragraph("<b>Scan to see the live version</b><br/>Medicine timings and appointments update "
                                 "automatically when your doctor changes them.<br/><font size=8 color='grey'>" + url + "</font>", nm)]],
                 colWidths=[4 * cm, 13 * cm])
    foot.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story += [foot, Spacer(1, 12),
              Paragraph("This document lists medicine timing only and does not replace your doctor's advice. "
                        "In an emergency call 108 or visit the nearest hospital.", small)]
    doc.build(story)
    buf.seek(0)
    return buf


@app.route("/p/<token>")
def passport_page(token):
    d = passport_data(token)
    if not d:
        abort(404)
    return render_template_string(PASSPORT_HTML, d=d, pdf=f"/p/{token}.pdf")


@app.route("/p/<token>.pdf")
def passport_pdf(token):
    d = passport_data(token)
    if not d:
        abort(404)
    return send_file(build_pdf(d, f"{base_url()}/p/{token}"), mimetype="application/pdf",
                     download_name=f"CareBridge-Passport-{d['first_name']}.pdf")


@app.route("/qr/<token>.png")
def passport_qr(token):
    if not q("SELECT 1 FROM patients WHERE passport_token=?", (token,), one=True):
        abort(404)
    return send_file(make_qr_png(f"{base_url()}/p/{token}", 10), mimetype="image/png")


# --------------------------------------------------------------------------
# API: auth
# --------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/doctors")
def api_doctors():
    return jsonify(rows("SELECT id,name FROM users WHERE role='doctor' ORDER BY name"))


@app.post("/api/register")
def api_register():
    b = body()
    name, email, pw = (b.get("name") or "").strip(), (b.get("email") or "").strip().lower(), b.get("password") or ""
    role = b.get("role", "patient")
    if len(name) < 2 or "@" not in email or len(pw) < 6:
        return jsonify(error="Enter a name, a valid email and a password of 6+ characters"), 400
    if q("SELECT 1 FROM users WHERE email=?", (email,), one=True):
        return jsonify(error="This email is already registered"), 400
    if role == "doctor":
        if b.get("code") != DOCTOR_CODE:
            return jsonify(error="Invalid doctor access code"), 403
        uid = ex("INSERT INTO users(role,name,email,pw,phone) VALUES('doctor',?,?,?,?)",
                 (name, email, generate_password_hash(pw), b.get("phone", "")))
    else:
        doc = q("SELECT id FROM users WHERE id=? AND role='doctor'", (b.get("doctor_id"),), one=True)
        if not doc:
            return jsonify(error="Please choose your doctor"), 400
        uid = ex("INSERT INTO users(role,name,email,pw,phone) VALUES('patient',?,?,?,?)",
                 (name, email, generate_password_hash(pw), b.get("phone", "")))
        ex("""INSERT INTO patients(user_id,doctor_id,age,condition,circumstances,passport_token,discharge_date)
              VALUES(?,?,?,?,?,?,?)""", (uid, doc["id"], int(b.get("age") or 0), b.get("condition", ""),
                                          b.get("circumstances", ""), new_passport_token(), today_s()))
        publish(doc["id"], "patient_joined", {"name": name})
    return jsonify(token=new_session(uid), role=role)


@app.post("/api/login")
def api_login():
    b = body()
    u = q("SELECT * FROM users WHERE email=?", ((b.get("email") or "").strip().lower(),), one=True)
    if not u or not check_password_hash(u["pw"], b.get("password") or ""):
        return jsonify(error="Wrong email or password"), 401
    return jsonify(token=new_session(u["id"]), role=u["role"])


@app.post("/api/logout")
@auth()
def api_logout():
    tok = request.headers.get("Authorization", "").replace("Bearer ", "")
    ex("DELETE FROM sessions WHERE token=?", (tok,))
    return jsonify(ok=True)


@app.get("/api/me")
@auth()
def api_me():
    u = g.user
    out = {"id": u["id"], "name": u["name"], "role": u["role"], "email": u["email"]}
    return jsonify(out)


@app.get("/api/stream")
@auth()
def api_stream():
    uid = g.user["id"]
    qu = queue.Queue()
    with SUBS_LOCK:
        SUBS.setdefault(uid, set()).add(qu)

    def gen():
        try:
            yield "retry: 3000\n\n"
            yield "event: hello\ndata: {}\n\n"
            while True:
                try:
                    ev, data = qu.get(timeout=15)
                    yield f"event: {ev}\ndata: {json.dumps(data)}\n\n"
                except queue.Empty:
                    yield ": ping\n\n"
        finally:
            with SUBS_LOCK:
                SUBS.get(uid, set()).discard(qu)

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --------------------------------------------------------------------------
# API: patient
# --------------------------------------------------------------------------
@app.get("/api/patient/home")
@auth("patient")
def patient_home():
    pid = g.user["id"]
    refresh_missed()
    p = patient_row(pid)
    doc = q("SELECT id,name,phone FROM users WHERE id=?", (p["doctor_id"],), one=True)
    checkins = rows("SELECT * FROM checkins WHERE patient_id=? ORDER BY id DESC LIMIT 14", (pid,))
    for c in checkins:
        c["flags"] = json.loads(c["flags"]); c["reasons"] = json.loads(c["reasons"])
    meds = []
    for m in active_meds(pid):
        start = datetime.strptime(m["start_date"], "%Y-%m-%d").date()
        left = (start + timedelta(days=m["days"] - 1) - date.today()).days
        meds.append({**dict(m), "times": json.loads(m["times"]), "days_left": left})
    appts = rows("SELECT * FROM appointments WHERE patient_id=? ORDER BY slot DESC LIMIT 20", (pid,))
    msgs = rows("SELECT * FROM messages WHERE patient_id=? ORDER BY id", (pid,))
    ex("UPDATE messages SET read=1 WHERE patient_id=? AND sender!='patient'", (pid,))
    p.pop("passport_token", None)
    token = q("SELECT passport_token FROM patients WHERE user_id=?", (pid,), one=True)["passport_token"]
    return jsonify(profile=p, doctor=dict(doc), meds=meds, doses=todays_doses(pid), followups=followups_for(pid),
                   appointments=appts, checkins=checkins, messages=msgs, adherence=adherence(pid),
                   pulse=recovery_pulse(pid), tips=care_tips(p), token=token,
                   passport_url=f"{base_url()}/p/{token}", server_time=now().strftime("%Y-%m-%d %H:%M"),
                   day_of_recovery=(date.today() - datetime.strptime(p["discharge_date"] or today_s(), "%Y-%m-%d").date()).days + 1)


@app.post("/api/patient/checkin")
@auth("patient")
def patient_checkin():
    pid, b = g.user["id"], body()
    pain = max(0, min(10, int(b.get("pain") or 0)))
    mood = max(1, min(5, int(b.get("mood") or 3)))
    energy = max(1, min(5, int(b.get("energy") or 3)))
    sleep = max(0, min(24, float(b.get("sleep") or 7)))
    try:
        temp = float(b["temp"]) if b.get("temp") not in (None, "") else None
    except ValueError:
        temp = None
    flags = [f for f in (b.get("flags") or []) if f in RED_FLAGS or f in AMBER_FLAGS]
    score, level, reasons = assess_risk(pain, temp, mood, sleep, energy, flags)
    ex("""INSERT INTO checkins(patient_id,date,pain,temp,mood,sleep,energy,flags,note,risk_score,risk_level,reasons)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""", (pid, today_s(), pain, temp, mood, sleep, energy, json.dumps(flags),
                                                (b.get("note") or "")[:500], score, level, json.dumps(reasons)))
    p = patient_row(pid)
    if level in ("critical", "high"):
        ex("INSERT INTO messages(patient_id,sender,body) VALUES(?,?,?)",
           (pid, "system", f"Auto-alert: your check-in was rated {level.upper()}. {ADVICE[level]}"))
    publish(p["doctor_id"], "checkin", {"patient_id": pid, "name": g.user["name"], "level": level, "score": score})
    publish(pid, "self_update", {})
    return jsonify(level=level, score=score, reasons=reasons, advice=ADVICE[level])


@app.post("/api/patient/med/take")
@auth("patient")
def patient_med_take():
    pid, b = g.user["id"], body()
    m = q("SELECT * FROM meds WHERE id=? AND patient_id=?", (b.get("med_id"), pid), one=True)
    if not m:
        return jsonify(error="Unknown medicine"), 404
    d, t = b.get("date") or today_s(), b.get("time")
    if b.get("undo"):
        ex("DELETE FROM med_logs WHERE med_id=? AND date=? AND time=?", (m["id"], d, t))
    else:
        db().execute("INSERT OR IGNORE INTO med_logs(med_id,patient_id,date,time) VALUES(?,?,?,?)", (m["id"], pid, d, t))
        db().commit()
    p = patient_row(pid)
    publish(p["doctor_id"], "adherence", {"patient_id": pid})
    return jsonify(ok=True, adherence=adherence(pid), pulse=recovery_pulse(pid))


@app.get("/api/slots")
@auth()
def api_slots():
    if g.user["role"] == "patient":
        did = patient_row(g.user["id"])["doctor_id"]
    else:
        did = g.user["id"]
    return jsonify(free_slots(did, 14))


@app.post("/api/patient/book")
@auth("patient")
def patient_book():
    pid, b = g.user["id"], body()
    p = patient_row(pid)
    fid = b.get("followup_id")
    purpose = (b.get("purpose") or "Follow-up visit")[:120]
    if fid:
        f = q("SELECT * FROM followups WHERE id=? AND patient_id=?", (fid, pid), one=True)
        if not f:
            return jsonify(error="Unknown follow-up"), 404
        purpose = f["title"]
    aid, err = book(pid, p["doctor_id"], b.get("slot", ""), purpose, fid, "patient")
    if err:
        return jsonify(error=err), 409
    publish(p["doctor_id"], "appointment", {"patient_id": pid, "name": g.user["name"], "slot": b.get("slot")})
    return jsonify(ok=True, id=aid)


@app.post("/api/patient/cancel")
@auth("patient")
def patient_cancel():
    pid, b = g.user["id"], body()
    a = q("SELECT * FROM appointments WHERE id=? AND patient_id=? AND status='scheduled'", (b.get("appt_id"), pid), one=True)
    if not a:
        return jsonify(error="Appointment not found"), 404
    ex("UPDATE appointments SET status='cancelled' WHERE id=?", (a["id"],))
    ex("UPDATE followups SET appt_id=NULL WHERE appt_id=?", (a["id"],))
    publish(a["doctor_id"], "appointment", {"patient_id": pid, "name": g.user["name"], "cancelled": True})
    return jsonify(ok=True)


@app.post("/api/patient/message")
@auth("patient")
def patient_message():
    pid, b = g.user["id"], body()
    text = (b.get("body") or "").strip()[:800]
    if not text:
        return jsonify(error="Type a message"), 400
    ex("INSERT INTO messages(patient_id,sender,body) VALUES(?,?,?)", (pid, "patient", text))
    publish(patient_row(pid)["doctor_id"], "message", {"patient_id": pid, "name": g.user["name"], "body": text})
    return jsonify(ok=True)


@app.post("/api/patient/profile")
@auth("patient")
def patient_profile():
    pid, b = g.user["id"], body()
    ex("UPDATE patients SET circumstances=?, emergency_contact=? WHERE user_id=?",
       ((b.get("circumstances") or "")[:300], (b.get("emergency_contact") or "")[:80], pid))
    if b.get("phone") is not None:
        ex("UPDATE users SET phone=? WHERE id=?", (b["phone"][:20], pid))
    return jsonify(ok=True)


@app.post("/api/patient/passport/rotate")
@auth("patient")
def passport_rotate():
    tok = new_passport_token()
    ex("UPDATE patients SET passport_token=? WHERE user_id=?", (tok, g.user["id"]))
    return jsonify(token=tok)


# --------------------------------------------------------------------------
# API: doctor
# --------------------------------------------------------------------------
def my_patient(pid):
    p = patient_row(pid)
    if not p or p["doctor_id"] != g.user["id"]:
        abort(404)
    return p


@app.get("/api/doctor/dashboard")
@auth("doctor")
def doctor_dashboard():
    refresh_missed()
    out = []
    for r in q("SELECT user_id FROM patients WHERE doctor_id=?", (g.user["id"],)):
        p = patient_row(r["user_id"])
        p.pop("passport_token", None)
        p.update(triage_summary(p["id"]))
        out.append(p)
    out.sort(key=lambda x: (x["priority"], -(x["last_score"] or 0)))
    today_appts = rows("""SELECT a.*, u.name FROM appointments a JOIN users u ON u.id=a.patient_id
                          WHERE a.doctor_id=? AND a.status='scheduled' AND substr(a.slot,1,10)=? ORDER BY a.slot""",
                       (g.user["id"], today_s()))
    stats = {"critical": sum(1 for p in out if p["status"] == "critical"),
             "overdue": sum(p["overdue_count"] for p in out),
             "silent": sum(1 for p in out if p["status"] == "silent" or p["silent_days"] >= 2),
             "today": len(today_appts), "patients": len(out),
             "unread": sum(p["unread"] for p in out)}
    return jsonify(patients=out, stats=stats, today=today_appts, doctor={"name": g.user["name"]})


@app.get("/api/doctor/patient/<int:pid>")
@auth("doctor")
def doctor_patient(pid):
    p = my_patient(pid)
    p.pop("passport_token", None)
    p.update(triage_summary(pid))
    checkins = rows("SELECT * FROM checkins WHERE patient_id=? ORDER BY id DESC LIMIT 20", (pid,))
    for c in checkins:
        c["flags"] = json.loads(c["flags"]); c["reasons"] = json.loads(c["reasons"])
    meds = []
    for m in q("SELECT * FROM meds WHERE patient_id=? ORDER BY active DESC, id DESC", (pid,)):
        meds.append({**dict(m), "times": json.loads(m["times"])})
    msgs = rows("SELECT * FROM messages WHERE patient_id=? ORDER BY id", (pid,))
    ex("UPDATE messages SET read=1 WHERE patient_id=? AND sender='patient'", (pid,))
    # 7-day adherence per day for the chart
    days = []
    for i in range(6, -1, -1):
        d = (date.today() - timedelta(days=i)).strftime("%Y-%m-%d")
        s = tk = 0
        for m in active_meds(pid, d):
            for t in json.loads(m["times"]):
                if datetime.strptime(f"{d} {t}", "%Y-%m-%d %H:%M") > now():
                    continue
                s += 1
                tk += 1 if q("SELECT 1 FROM med_logs WHERE med_id=? AND date=? AND time=?", (m["id"], d, t), one=True) else 0
        days.append({"date": d, "scheduled": s, "taken": tk})
    appts = rows("SELECT * FROM appointments WHERE patient_id=? ORDER BY slot DESC LIMIT 20", (pid,))
    return jsonify(patient=p, checkins=checkins, meds=meds, messages=msgs, followups=followups_for(pid),
                   appointments=appts, adherence_days=days, tips=care_tips(p))


@app.post("/api/doctor/patient")
@auth("doctor")
def doctor_add_patient():
    b = body()
    name, email, pw = (b.get("name") or "").strip(), (b.get("email") or "").strip().lower(), b.get("password") or "welcome123"
    if len(name) < 2 or "@" not in email:
        return jsonify(error="Name and valid email required"), 400
    if q("SELECT 1 FROM users WHERE email=?", (email,), one=True):
        return jsonify(error="Email already registered"), 400
    uid = ex("INSERT INTO users(role,name,email,pw,phone) VALUES('patient',?,?,?,?)",
             (name, email, generate_password_hash(pw), b.get("phone", "")))
    ex("""INSERT INTO patients(user_id,doctor_id,age,condition,circumstances,passport_token,discharge_date)
          VALUES(?,?,?,?,?,?,?)""", (uid, g.user["id"], int(b.get("age") or 0), b.get("condition", ""),
                                      b.get("circumstances", ""), new_passport_token(), today_s()))
    return jsonify(ok=True, id=uid, temp_password=pw)


@app.post("/api/doctor/prescribe")
@auth("doctor")
def doctor_prescribe():
    b = body()
    p = my_patient(int(b.get("patient_id") or 0))
    name = (b.get("name") or "").strip()
    times = sorted({t for t in (b.get("times") or []) if len(t) == 5 and t[2] == ":"})
    if not name or not times:
        return jsonify(error="Medicine name and at least one time are required"), 400
    days = max(1, min(365, int(b.get("days") or 7)))
    mid = ex("""INSERT INTO meds(patient_id,name,dose,times,meal,notes,start_date,days) VALUES(?,?,?,?,?,?,?,?)""",
             (p["id"], name[:80], (b.get("dose") or "")[:40], json.dumps(times), b.get("meal") or "Any time",
              (b.get("notes") or "")[:200], today_s(), days))
    ex("INSERT INTO messages(patient_id,sender,body) VALUES(?,?,?)",
       (p["id"], "system", f"New medicine prescribed: {name} {b.get('dose', '')} at {', '.join(times)} ({b.get('meal') or 'any time'}) for {days} days. Reminders are set."))
    publish(p["id"], "prescription", {"name": name})
    return jsonify(ok=True, id=mid)


@app.post("/api/doctor/med/stop")
@auth("doctor")
def doctor_med_stop():
    b = body()
    m = q("SELECT m.*, p.doctor_id FROM meds m JOIN patients p ON p.user_id=m.patient_id WHERE m.id=?", (b.get("med_id"),), one=True)
    if not m or m["doctor_id"] != g.user["id"]:
        abort(404)
    ex("UPDATE meds SET active=0 WHERE id=?", (m["id"],))
    publish(m["patient_id"], "prescription", {"name": m["name"], "stopped": True})
    return jsonify(ok=True)


@app.post("/api/doctor/followup")
@auth("doctor")
def doctor_followup():
    b = body()
    p = my_patient(int(b.get("patient_id") or 0))
    title = (b.get("title") or "").strip()
    try:
        datetime.strptime(b.get("due_date", ""), "%Y-%m-%d")
    except ValueError:
        return jsonify(error="Pick a due date"), 400
    if not title:
        return jsonify(error="Give the follow-up a title"), 400
    fid = ex("INSERT INTO followups(patient_id,title,kind,due_date) VALUES(?,?,?,?)",
             (p["id"], title[:100], b.get("kind", "visit"), b["due_date"]))
    ex("INSERT INTO messages(patient_id,sender,body) VALUES(?,?,?)",
       (p["id"], "system", f"Follow-up requested: {title} - please book before {b['due_date']}."))
    publish(p["id"], "followup", {"title": title})
    return jsonify(ok=True, id=fid)


@app.post("/api/doctor/schedule")
@auth("doctor")
def doctor_schedule():
    b = body()
    p = my_patient(int(b.get("patient_id") or 0))
    aid, err = book(p["id"], g.user["id"], b.get("slot", ""), (b.get("purpose") or "Follow-up visit")[:120],
                    b.get("followup_id"), "doctor")
    if err:
        return jsonify(error=err), 409
    ex("INSERT INTO messages(patient_id,sender,body) VALUES(?,?,?)",
       (p["id"], "system", f"Dr. {g.user['name']} scheduled your appointment on {b['slot']} ({b.get('purpose') or 'Follow-up visit'})."))
    publish(p["id"], "appointment", {"slot": b["slot"], "by": "doctor"})
    return jsonify(ok=True, id=aid)


@app.post("/api/doctor/appt/status")
@auth("doctor")
def doctor_appt_status():
    b = body()
    a = q("SELECT * FROM appointments WHERE id=? AND doctor_id=?", (b.get("appt_id"), g.user["id"]), one=True)
    if not a or b.get("status") not in ("completed", "missed", "cancelled"):
        abort(404)
    ex("UPDATE appointments SET status=? WHERE id=?", (b["status"], a["id"]))
    if b["status"] == "completed":
        ex("UPDATE followups SET status='done' WHERE appt_id=?", (a["id"],))
    elif b["status"] in ("missed", "cancelled"):
        pass
    publish(a["patient_id"], "appointment", {"status": b["status"]})
    return jsonify(ok=True)


@app.post("/api/doctor/followup/done")
@auth("doctor")
def doctor_followup_done():
    b = body()
    f = q("SELECT f.* FROM followups f JOIN patients p ON p.user_id=f.patient_id WHERE f.id=? AND p.doctor_id=?",
          (b.get("followup_id"), g.user["id"]), one=True)
    if not f:
        abort(404)
    ex("UPDATE followups SET status='done' WHERE id=?", (f["id"],))
    publish(f["patient_id"], "followup", {"done": True})
    return jsonify(ok=True)


@app.post("/api/doctor/reply")
@auth("doctor")
def doctor_reply():
    b = body()
    p = my_patient(int(b.get("patient_id") or 0))
    text = (b.get("body") or "").strip()[:800]
    if not text:
        return jsonify(error="Type a reply"), 400
    ex("INSERT INTO messages(patient_id,sender,body) VALUES(?,?,?)", (p["id"], "doctor", text))
    publish(p["id"], "message", {"from": g.user["name"], "body": text})
    return jsonify(ok=True)


@app.post("/api/doctor/nudge")
@auth("doctor")
def doctor_nudge():
    p = my_patient(int(body().get("patient_id") or 0))
    ex("INSERT INTO messages(patient_id,sender,body) VALUES(?,?,?)",
       (p["id"], "doctor", "Hello! We haven't heard from you for a few days. Please complete today's check-in so we know how you're recovering."))
    publish(p["id"], "message", {"from": g.user["name"], "body": "Please complete your daily check-in"})
    return jsonify(ok=True)


# --------------------------------------------------------------------------
# Seed demo data
# --------------------------------------------------------------------------
def ds(offset):
    return (date.today() + timedelta(days=offset)).strftime("%Y-%m-%d")


def seed():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    if con.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
        con.close()
        return
    import random
    random.seed(7)

    def user(role, name, email, pw, phone=""):
        return con.execute("INSERT INTO users(role,name,email,pw,phone) VALUES(?,?,?,?,?)",
                           (role, name, email, generate_password_hash(pw), phone)).lastrowid

    doc = user("doctor", "Dr. Meera Nair", "doctor@demo", "doctor123", "+91 98400 11223")
    pats = [
        ("Arun Kumar", "patient@demo", "patient123", 34, "Post-appendectomy recovery", "Lives alone, works night shift", 5),
        ("Priya Sundaram", "priya@demo", "patient123", 58, "Type 2 diabetes + hypertension", "Lives in a village, far from the hospital", 9),
        ("Ravi Menon", "ravi@demo", "patient123", 67, "Knee replacement recovery", "Elderly, lives with spouse", 6),
        ("Anitha Raj", "anitha@demo", "patient123", 41, "Post-viral recovery", "", 4),
    ]
    ids = {}
    for name, email, pw, age, cond, circ, dis in pats:
        uid = user("patient", name, email, pw, "+91 90000 0000" + str(len(ids)))
        con.execute("INSERT INTO patients(user_id,doctor_id,age,condition,circumstances,passport_token,discharge_date) VALUES(?,?,?,?,?,?,?)",
                    (uid, doc, age, cond, circ, secrets.token_urlsafe(9), ds(-dis)))
        ids[email] = (uid, dis)

    def med(pid, name, dose, times, meal, notes, start, days):
        return con.execute("INSERT INTO meds(patient_id,name,dose,times,meal,notes,start_date,days) VALUES(?,?,?,?,?,?,?,?)",
                           (pid, name, dose, json.dumps(times), meal, notes, ds(start), days)).lastrowid

    def logs(pid, mid, times, start, upto_offset=0, skip=0.0):
        for off in range(start, upto_offset + 1):
            for t in times:
                if off == 0 and datetime.strptime(f"{ds(0)} {t}", "%Y-%m-%d %H:%M") > datetime.now():
                    continue
                if random.random() >= skip:
                    con.execute("INSERT OR IGNORE INTO med_logs(med_id,patient_id,date,time) VALUES(?,?,?,?)", (mid, pid, ds(off), t))

    def checkin(pid, off, pain, temp, mood, sleep, energy, flags, note=""):
        score, level, reasons = assess_risk(pain, temp, mood, sleep, energy, flags)
        con.execute("""INSERT INTO checkins(patient_id,date,pain,temp,mood,sleep,energy,flags,note,risk_score,risk_level,reasons,created)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (pid, ds(off), pain, temp, mood, sleep, energy, json.dumps(flags), note,
                                                               score, level, json.dumps(reasons), f"{ds(off)} 09:{random.randint(10, 50)}:00"))

    def msg(pid, sender, text, off=0, hh="10:15:00"):
        con.execute("INSERT INTO messages(patient_id,sender,body,created,read) VALUES(?,?,?,?,1)", (pid, sender, text, f"{ds(off)} {hh}"))

    # Arun: improving, adherent, overdue stitch-removal follow-up (the 'failed to book' demo)
    a, _ = ids["patient@demo"]
    m1 = med(a, "Amoxicillin", "500 mg", ["08:00", "14:00", "20:00"], "After food", "Finish the full course", -4, 7)
    m2 = med(a, "Paracetamol", "650 mg", ["09:00", "21:00"], "After food", "Only if pain persists", -4, 5)
    logs(a, m1, ["08:00", "14:00", "20:00"], -4, 0, 0.08)
    logs(a, m2, ["09:00", "21:00"], -4, 0, 0.1)
    for off, pain, temp in [(-4, 7, 37.8), (-3, 6, 37.6), (-2, 5, 37.2), (-1, 4, 37.0)]:
        checkin(a, off, pain, temp, 3, 6, 3, [], "")
    con.execute("INSERT INTO followups(patient_id,title,kind,due_date) VALUES(?,?,?,?)", (a, "Stitch removal & wound check", "visit", ds(-2)))
    con.execute("INSERT INTO followups(patient_id,title,kind,due_date) VALUES(?,?,?,?)", (a, "Blood test (CBC)", "test", ds(3)))
    msg(a, "doctor", "Welcome Arun! Log how you feel each day and take the medicines on time. I'm watching your progress.", -4)

    # Priya: silent 4 days, poor adherence, overdue HbA1c test
    p2, _ = ids["priya@demo"]
    m3 = med(p2, "Metformin", "500 mg", ["08:00", "20:00"], "With food", "", -8, 30)
    m4 = med(p2, "Amlodipine", "5 mg", ["09:00"], "After food", "Morning", -8, 30)
    logs(p2, m3, ["08:00", "20:00"], -8, -4, 0.15)
    logs(p2, m4, ["09:00"], -8, -4, 0.15)
    for off, pain in [(-8, 2), (-7, 2), (-6, 3), (-5, 2), (-4, 3)]:
        checkin(p2, off, pain, 36.8, 3, 7, 3, ["dizziness"] if off == -5 else [], "")
    con.execute("INSERT INTO followups(patient_id,title,kind,due_date) VALUES(?,?,?,?)", (p2, "HbA1c blood test", "test", ds(-5)))
    con.execute("INSERT INTO followups(patient_id,title,kind,due_date) VALUES(?,?,?,?)", (p2, "Diabetes review visit", "visit", ds(4)))
    msg(p2, "doctor", "Please get your HbA1c test done this week.", -6)

    # Ravi: CRITICAL today (fever + wound infection)
    r, _ = ids["ravi@demo"]
    m5 = med(r, "Cefuroxime", "500 mg", ["08:00", "20:00"], "After food", "", -5, 10)
    m6 = med(r, "Enoxaparin", "40 mg", ["21:00"], "Any time", "Injection as taught", -5, 14)
    logs(r, m5, ["08:00", "20:00"], -5, 0, 0.05)
    logs(r, m6, ["21:00"], -5, 0, 0.05)
    for off, pain, temp, fl in [(-5, 5, 37.2, []), (-4, 5, 37.3, []), (-3, 6, 37.5, []), (-2, 6, 37.9, ["swelling"]), (-1, 7, 38.4, ["wound_infection"])]:
        checkin(r, off, pain, temp, 2, 5, 2, fl, "")
    checkin(r, 0, 8, 39.2, 2, 4, 1, ["wound_infection", "swelling"], "The wound is red and warm with some discharge.")
    msg(r, "patient", "The wound is red and warm with some discharge.", 0, "08:40:00")
    con.execute("INSERT INTO followups(patient_id,title,kind,due_date) VALUES(?,?,?,?)", (r, "Wound dressing review", "visit", ds(1)))

    # Anitha: stable, booked appointment
    n_, _ = ids["anitha@demo"]
    m7 = med(n_, "Vitamin D3", "60000 IU", ["10:00"], "After food", "Weekly", -3, 8)
    logs(n_, m7, ["10:00"], -3, 0, 0.0)
    for off in (-3, -2, -1, 0):
        checkin(n_, off, 1, 36.7, 4, 8, 4, [], "")
    slot = (datetime.now() + timedelta(days=2)).replace(hour=11, minute=0).strftime("%Y-%m-%d %H:%M")
    aid = con.execute("INSERT INTO appointments(patient_id,doctor_id,slot,purpose,created_by) VALUES(?,?,?,?,?)",
                      (n_, doc, slot, "Recovery review", "patient")).lastrowid
    con.execute("INSERT INTO followups(patient_id,title,kind,due_date,appt_id) VALUES(?,?,?,?,?)", (n_, "Recovery review", "visit", ds(3), aid))
    con.commit()
    con.close()


with app.app_context():
    pass
seed()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"\n  CareBridge running ->  http://localhost:{port}   (LAN: http://{lan_ip()}:{port})\n"
          f"  Demo logins: patient@demo / patient123  |  doctor@demo / doctor123\n")
    app.run(host="0.0.0.0", port=port, threaded=True, debug=False)
