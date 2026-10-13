# CareBridge - Continuity-of-Care Platform (SYNESIS 26, Healthcare #2)

Flask + SQLite + Server-Sent Events (real-time) + vanilla JS. No build step.

## Run
    pip install -r requirements.txt
    python app.py            # http://localhost:5000

Demo logins: patient@demo / patient123  |  doctor@demo / doctor123
(also priya@demo, ravi@demo, anitha@demo, all patient123). Doctor sign-up code: SYNESIS26.

Reset demo data: delete carebridge.db and restart.

## QR passport on a real phone
The QR encodes http://<your-LAN-IP>:5000/p/<token>. Phone and laptop must share Wi-Fi.
For internet access: `ngrok http 5000` then `PUBLIC_URL=https://xxxx.ngrok.app python app.py`.


## Files
app.py (API, risk engine, QR, PDF, SSE, seed) | static/index.html, style.css, app.js
