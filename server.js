'use strict';

/* =====================================================================
   PROJECT SOLWAT — server.js
   ---------------------------------------------------------------------
   One file that:
     1. Serves the entire UI (HTML/CSS/JS embedded below).
     2. Exposes the controller API  (/api/status, /api/logs, /api/pump/control).
     3. Simulates the ESP32 device (water, pump, solar, battery).
     4. Proxies SMS to TextBee so the API key never reaches the browser.
     5. Computes SOLAR EFFICIENCY and LOW / MEDIUM / FULL water categories.

   Run:   npm install express
          node server.js
   Requires Node 18+ (uses global fetch).
   ===================================================================== */

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------------------------------------------------------------
   CONFIG
   ------------------------------------------------------------------ */
const SMS_TOKEN   = process.env.TEXTBEE_TOKEN  || 'txb_VBwToaGsyTU88HhdhzBOk9NxMYCWaUap';
const SMS_DEVICE  = process.env.TEXTBEE_DEVICE || '6adacafda4996b8ebfd1cf68';
const SMS_BASE    = 'https://api.textbee.dev/api/v1/gateway/devices';

const PANEL_RATED_W = 400;   // total PV array rating (watts)
const SYSTEM_LOSS   = 0.90;  // wiring + inverter losses
const TICK_MS       = 2000;  // simulation tick

/* Water level categories — edit these to taste */
const WATER = {
  criticalMax: 15,   // below this  -> CRITICAL (a sub-state of LOW)
  lowMax:      35,   // below this  -> LOW
  fullMin:     75,   // at/above    -> FULL
  autoStartAt: 12,   // AUTO mode starts the pump here
  autoStopAt:  98    // AUTO mode stops the pump here
};

/* Simulation rates (percent / tick) */
const RATES = {
  fillMin: 0.25, fillMax: 0.50,
  drainMin: 0.01, drainMax: 0.03,
  battCharge: 0.008, battIdleDrain: 0.0004, battPumpDrain: 0.02
};

/* ---------------------------------------------------------------------
   HELPERS
   ------------------------------------------------------------------ */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rand  = (a, b) => a + Math.random() * (b - a);

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* LOW / MEDIUM / FULL classification */
function waterCategory(v) {
  if (v < WATER.criticalMax) {
    return { key: 'critical', label: 'Critical', text: 'Critical — refill immediately' };
  }
  if (v < WATER.lowMax) {
    return { key: 'low', label: 'Low', text: 'Low — monitor closely' };
  }
  if (v < WATER.fullMin) {
    return { key: 'medium', label: 'Medium', text: 'Medium — normal operating level' };
  }
  return { key: 'full', label: 'Full', text: 'Full — tank at capacity' };
}

/* ---------------------------------------------------------------------
   DEVICE STATE
   ------------------------------------------------------------------ */
const state = {
  waterLevel:     62,
  pumpStatus:     'OFF',
  pumpMode:       'AUTO',
  batteryLevel:   88,
  solarPower:     0,
  solarIdeal:     0,
  solarEfficiency: null,
  cloudFactor:    0.85,
  logs:           []
};

function log(activity) {
  state.logs.unshift({ timestamp: stamp(new Date()), activity });
  if (state.logs.length > 120) state.logs.pop();
}

/* ---------------------------------------------------------------------
   SOLAR MODEL  ->  power + efficiency
   ------------------------------------------------------------------ */
function sunFactor(d) {
  const h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  if (h < 6 || h >= 18) return 0;
  return Math.sin(Math.PI * (h - 6) / 12);   // 0 at sunrise/sunset, 1 at noon
}

function solarSnapshot(now) {
  const sun = sunFactor(now);

  if (sun <= 0.001) {
    return { power: 0, ideal: 0, efficiency: null, label: 'Night · solar idle', category: 'idle' };
  }

  const ideal     = PANEL_RATED_W * sun;                       // clear-sky expectation
  const cellTemp  = 22 + 16 * sun + rand(-1, 1);               // panels get hot at noon
  const tempDerate = 1 - 0.004 * Math.max(0, cellTemp - 25);   // -0.4 %/°C above 25 °C

  const power = Math.max(0, Math.round(ideal * state.cloudFactor * SYSTEM_LOSS * tempDerate));

  const efficiency = ideal > 1
    ? clamp(Math.round((power / ideal) * 100), 0, 100)
    : null;

  const label =
    efficiency === null ? '' :
    efficiency >= 80 ? 'Excellent · clear sky' :
    efficiency >= 65 ? 'Good · light haze'     :
    efficiency >= 45 ? 'Fair · cloud cover'    :
                       'Poor · heavy cloud';

  return { power, ideal, efficiency, label };
}

/* ---------------------------------------------------------------------
   SIMULATION TICK
   ------------------------------------------------------------------ */
function tick() {
  const now = new Date();

  /* --- solar --- */
  state.cloudFactor = clamp(state.cloudFactor + (Math.random() - 0.5) * 0.06, 0.45, 1);
  const solar = solarSnapshot(now);
  state.solarPower      = solar.power;
  state.solarIdeal      = Math.round(solar.ideal);
  state.solarEfficiency = solar.efficiency;

  /* --- battery --- */
  let battDelta = -RATES.battIdleDrain;
  if (solar.power > 0) battDelta += (solar.power / PANEL_RATED_W) * RATES.battCharge;
  if (state.pumpStatus === 'ON') battDelta -= RATES.battPumpDrain;
  state.batteryLevel = clamp(state.batteryLevel + battDelta, 0, 100);

  /* --- water --- */
  if (state.pumpStatus === 'ON') {
    state.waterLevel += rand(RATES.fillMin, RATES.fillMax);
  } else {
    state.waterLevel -= rand(RATES.drainMin, RATES.drainMax);
  }
  state.waterLevel = clamp(state.waterLevel, 0, 100);

  /* --- automation --- */
  if (state.pumpMode === 'AUTO') {
    if (state.pumpStatus === 'OFF' && state.waterLevel <= WATER.autoStartAt) {
      state.pumpStatus = 'ON';
      log('PUMP ON · auto-start (tank low)');
    } else if (state.pumpStatus === 'ON' && state.waterLevel >= WATER.autoStopAt) {
      state.pumpStatus = 'OFF';
      log('PUMP OFF · auto-stop (tank full)');
    }
  }
  if (state.pumpStatus === 'ON' && state.batteryLevel <= 8) {
    state.pumpStatus = 'OFF';
    log('PUMP OFF · battery protection');
  }
}

/* ---------------------------------------------------------------------
   STATUS PAYLOAD
   ------------------------------------------------------------------ */
function buildStatus() {
  const cat = waterCategory(state.waterLevel);
  return {
    waterLevel:          Math.round(state.waterLevel),
    waterCategory:       cat,
    waterState:          cat.text,
    pumpStatus:          state.pumpStatus,
    pumpMode:            state.pumpMode,
    solarPower:          state.solarPower,
    solarIdeal:          state.solarIdeal,
    solarEfficiency:     state.solarEfficiency,
    solarEfficiencyLabel: state.solarEfficiency === null
      ? 'Night · solar idle'
      : (state.solarEfficiency >= 80 ? 'Excellent · clear sky'
        : state.solarEfficiency >= 65 ? 'Good · light haze'
        : state.solarEfficiency >= 45 ? 'Fair · cloud cover'
        : 'Poor · heavy cloud'),
    panelRated:          PANEL_RATED_W,
    batteryLevel:        Math.round(state.batteryLevel),
    serverTime:          new Date().toISOString()
  };
}

/* ---------------------------------------------------------------------
   MIDDLEWARE + ROUTES
   ------------------------------------------------------------------ */
app.use(express.json({ limit: '64kb' }));

/* GET /api/status */
app.get('/api/status', (req, res) => res.json(buildStatus()));

/* GET /api/logs */
app.get('/api/logs', (req, res) => res.json({ logs: state.logs.slice(0, 60) }));

/* GET /api/config — thresholds so the UI can stay in sync */
app.get('/api/config', (req, res) => {
  res.json({ panelRated: PANEL_RATED_W, water: WATER, tickMs: TICK_MS });
});

/* POST /api/pump/control  { action: "ON" | "OFF", source } */
app.post('/api/pump/control', (req, res) => {
  const action = String((req.body && req.body.action) || '').toUpperCase();
  if (action !== 'ON' && action !== 'OFF') {
    return res.status(400).json({ ok: false, message: 'action must be ON or OFF' });
  }
  state.pumpStatus = action;
  const source = (req.body && req.body.source) || 'APP';
  log('PUMP ' + action + ' · ' + String(source).toLowerCase());
  res.json({ ok: true, message: 'PUMP ' + action + ' accepted.', status: buildStatus() });
});

/* POST /api/water/level  { level: 0-100 } — handy for testing the categories */
app.post('/api/water/level', (req, res) => {
  const level = Number(req.body && req.body.level);
  if (!Number.isFinite(level)) {
    return res.status(400).json({ ok: false, message: 'level must be a number 0-100' });
  }
  state.waterLevel = clamp(level, 0, 100);
  log('Water level set to ' + Math.round(state.waterLevel) + '% · ' + waterCategory(state.waterLevel).label);
  res.json({ ok: true, status: buildStatus() });
});

/* POST /api/sms/send  { recipient, message } — server-side TextBee proxy */
app.post('/api/sms/send', async (req, res) => {
  const recipient = String((req.body && req.body.recipient) || '').trim();
  const message   = String((req.body && req.body.message)   || '').trim();

  if (!recipient) return res.status(400).json({ ok: false, message: 'Recipient number is missing.' });
  if (!message)   return res.status(400).json({ ok: false, message: 'Message body is empty.' });

  const url = SMS_BASE + '/' + encodeURIComponent(SMS_DEVICE) + '/send-sms';

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': SMS_TOKEN },
      body: JSON.stringify({ recipients: [recipient], message })
    });

    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }

    if (!r.ok) {
      log('SMS failed · ' + (data.message || ('HTTP ' + r.status)));
      return res.status(r.status).json({ ok: false, message: data.message || data.error || ('HTTP ' + r.status) });
    }

    log('SMS sent → ' + recipient);
    return res.json({ ok: true, message: 'SMS queued by gateway.', gateway: data });
  } catch (err) {
    log('SMS failed · ' + err.message);
    return res.status(502).json({ ok: false, message: 'Gateway unreachable: ' + err.message });
  }
});

/* ---------------------------------------------------------------------
   THE UI  (served at /)
   ------------------------------------------------------------------ */
const HTML = String.raw`<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PROJECT SOLWAT · Water Tank Management</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>💧</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">

<style>
:root {
  --bg: #f6f8fb;
  --bg-subtle: #eef2f7;
  --surface: #ffffff;
  --surface-2: #f8fafc;
  --surface-hover: #fafbfc;
  --border: #e5e9f0;
  --border-strong: #d1dae5;
  --text: #0d1b2a;
  --text-2: #3d4d5e;
  --muted: #64748b;
  --muted-2: #94a3b8;

  --primary: #0891b2;
  --primary-hover: #0e7490;
  --primary-soft: #ecfeff;
  --primary-ring: rgba(8, 145, 178, 0.18);

  --success: #10b981;
  --success-soft: #ecfdf5;
  --danger: #ef4444;
  --danger-soft: #fef2f2;
  --warning: #f59e0b;
  --warning-soft: #fffbeb;
  --violet: #7c3aed;
  --violet-soft: #f5f3ff;

  --shadow-xs: 0 1px 2px rgba(13, 27, 42, 0.04);
  --shadow-sm: 0 1px 3px rgba(13, 27, 42, 0.06), 0 1px 2px rgba(13, 27, 42, 0.04);
  --shadow: 0 4px 6px -1px rgba(13, 27, 42, 0.06), 0 2px 4px -2px rgba(13, 27, 42, 0.04);
  --shadow-md: 0 10px 15px -3px rgba(13, 27, 42, 0.08), 0 4px 6px -4px rgba(13, 27, 42, 0.05);
  --shadow-lg: 0 20px 25px -5px rgba(13, 27, 42, 0.08), 0 8px 10px -6px rgba(13, 27, 42, 0.04);

  --radius-sm: 8px;
  --radius: 12px;
  --radius-lg: 16px;
  --radius-xl: 20px;

  --track: #eef2f7;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
}

[data-theme="dark"] {
  --bg: #0a0f17;
  --bg-subtle: #101822;
  --surface: #131c27;
  --surface-2: #17212d;
  --surface-hover: #1a2430;
  --border: #1f2c3d;
  --border-strong: #2a3a4f;
  --text: #e8eef6;
  --text-2: #b8c5d6;
  --muted: #7d8fa3;
  --muted-2: #5a6b7f;

  --primary: #22d3ee;
  --primary-hover: #67e8f9;
  --primary-soft: #072d3b;
  --primary-ring: rgba(34, 211, 238, 0.22);

  --success: #34d399;
  --success-soft: #052e2b;
  --danger: #f87171;
  --danger-soft: #2a0f0f;
  --warning: #fbbf24;
  --warning-soft: #2a1f05;
  --violet: #a78bfa;
  --violet-soft: #1e1636;

  --shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.5);
  --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.4);
  --shadow-md: 0 10px 15px -3px rgba(0, 0, 0, 0.5);
  --shadow-lg: 0 20px 25px -5px rgba(0, 0, 0, 0.6);

  --track: #1a2c42;
}

* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text);
  background: var(--bg);
  transition: background-color .3s var(--ease), color .3s var(--ease);
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
}
h1, h2, h3, h4, p { margin: 0; }
button { font: inherit; }
.hidden { display: none !important; }
.wide { width: 100%; }
::selection { background: var(--primary-soft); color: var(--primary); }

:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
  border-radius: 6px;
}

.icon { width: 16px; height: 16px; flex-shrink: 0; display: inline-block; vertical-align: middle; }
.icon-lg { width: 18px; height: 18px; }
.icon-xl { width: 22px; height: 22px; }

/* AUTH */
.auth-view { min-height: 100vh; display: grid; grid-template-columns: 1.05fr 1fr; }
.auth-brand {
  position: relative; overflow: hidden; color: #fff; padding: 56px;
  display: flex; flex-direction: column; justify-content: space-between;
  background:
    radial-gradient(circle at 20% 15%, rgba(34, 211, 238, 0.22), transparent 55%),
    radial-gradient(circle at 80% 85%, rgba(20, 184, 166, 0.14), transparent 55%),
    linear-gradient(135deg, #0a1c2b 0%, #0f2a3f 55%, #0a2233 100%);
}
.auth-brand::before {
  content: ""; position: absolute; inset: 0;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
  background-size: 44px 44px; pointer-events: none;
  mask-image: radial-gradient(circle at center, black 40%, transparent 80%);
  -webkit-mask-image: radial-gradient(circle at center, black 40%, transparent 80%);
}
.auth-brand > * { position: relative; z-index: 1; }
.auth-brand-top { display: flex; flex-direction: column; gap: 28px; }
.auth-brand .brand-logo {
  width: 56px; height: 56px; border-radius: 16px; display: grid; place-items: center;
  background: linear-gradient(140deg, #22d3ee, #0891b2);
  box-shadow: 0 12px 32px -8px rgba(34, 211, 238, 0.55);
}
.auth-brand .brand-logo .icon-xl { width: 28px; height: 28px; stroke: #fff; }
.auth-brand h1 { font-size: 32px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.1; }
.auth-brand p { color: rgba(255, 255, 255, 0.72); font-size: 15px; line-height: 1.65; max-width: 420px; }
.auth-brand ul { list-style: none; padding: 0; margin: 8px 0 0; display: flex; flex-direction: column; gap: 14px; }
.auth-brand li { display: flex; align-items: center; gap: 12px; font-size: 14px; color: rgba(255, 255, 255, 0.88); }
.auth-brand li .feature-icon {
  width: 32px; height: 32px; flex-shrink: 0; border-radius: 8px; display: grid; place-items: center;
  background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.12); color: #22d3ee;
}
.auth-brand-foot { font-size: 11px; letter-spacing: 0.16em; color: rgba(255, 255, 255, 0.5); text-transform: uppercase; font-weight: 600; }
.auth-panel { display: grid; place-items: center; padding: 40px 20px; background: var(--bg); }
.auth-card {
  width: min(420px, 100%); background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-xl); padding: 32px; box-shadow: var(--shadow-lg);
}
.auth-card h2 { font-size: 22px; letter-spacing: -0.02em; font-weight: 700; margin-bottom: 4px; }
.auth-card .sub { font-size: 13.5px; color: var(--muted); margin-bottom: 22px; }
.tabs {
  display: flex; gap: 4px; background: var(--surface-2); border: 1px solid var(--border);
  padding: 4px; border-radius: var(--radius); margin-bottom: 22px;
}
.tab {
  flex: 1; padding: 9px; border: none; background: transparent; border-radius: 8px;
  font-weight: 600; font-size: 12.5px; letter-spacing: 0.02em; cursor: pointer;
  color: var(--muted); transition: all .2s var(--ease);
}
.tab:hover { color: var(--text-2); }
.tab.active { background: var(--surface); color: var(--text); box-shadow: var(--shadow-xs); }
.form-error { color: var(--danger); font-size: 12.5px; min-height: 18px; margin: 6px 0; }
.auth-note { font-size: 12px; color: var(--muted); margin-top: 18px; text-align: center; line-height: 1.55; }
@media (max-width: 900px) { .auth-view { grid-template-columns: 1fr; } .auth-brand { display: none; } }

/* TOPBAR */
.topbar {
  position: sticky; top: 0; z-index: 40; height: 64px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 24px;
  background: color-mix(in srgb, var(--surface) 85%, transparent);
  backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
.brand-logo {
  width: 38px; height: 38px; flex-shrink: 0; border-radius: 10px; display: grid; place-items: center;
  background: linear-gradient(140deg, #06b6d4, #0891b2);
  box-shadow: 0 4px 14px -4px rgba(8, 145, 178, 0.5); color: #fff;
}
.brand h1 { font-size: 14px; font-weight: 700; letter-spacing: 0.06em; white-space: nowrap; color: var(--text); }
.brand p { font-size: 11.5px; color: var(--muted); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.topbar-actions { display: flex; align-items: center; gap: 8px; }

.pill {
  display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px;
  border-radius: 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
  border: 1px solid var(--border); background: var(--surface-2); white-space: nowrap;
  transition: all .3s var(--ease);
}
.pill .dot {
  width: 7px; height: 7px; border-radius: 50%; background: currentColor;
  box-shadow: 0 0 0 0 currentColor; animation: pulse 2s infinite;
}
.pill.live { color: var(--success); border-color: color-mix(in srgb, var(--success) 30%, transparent); background: var(--success-soft); }
.pill.offline { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 30%, transparent); background: var(--danger-soft); }

.icon-btn {
  width: 38px; height: 38px; display: grid; place-items: center; border-radius: 10px;
  cursor: pointer; font-size: 16px; background: transparent; color: var(--muted);
  border: 1px solid transparent; transition: all .2s var(--ease);
}
.icon-btn:hover { background: var(--surface-2); color: var(--text); border-color: var(--border); }
.icon-btn:active { transform: scale(0.95); }
[data-theme="light"] .icon-sun { display: none; }
[data-theme="dark"] .icon-moon { display: none; }

.user-chip {
  display: flex; align-items: center; gap: 10px; padding: 4px 12px 4px 4px;
  border-radius: 10px; background: var(--surface-2); border: 1px solid var(--border);
}
.avatar {
  width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center;
  font-weight: 700; font-size: 12px; color: #fff;
  background: linear-gradient(140deg, #06b6d4, #0891b2); text-transform: uppercase;
}
.user-meta { display: flex; flex-direction: column; line-height: 1.2; min-width: 0; }
.user-meta strong { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
.user-meta small { font-size: 10.5px; color: var(--muted); white-space: nowrap; }
@media (max-width: 640px) { .user-meta { display: none; } }

/* LAYOUT */
.container { max-width: 1180px; margin: 0 auto; padding: 24px 24px 48px; }

.welcome {
  display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg);
  padding: 20px 24px; margin-bottom: 20px; box-shadow: var(--shadow-xs);
  position: relative; overflow: hidden;
}
.welcome::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 2px; background: linear-gradient(90deg, var(--primary), transparent 60%); }
.welcome h2 { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; color: var(--text); }
.welcome h2 span { color: var(--primary); }
.welcome p { font-size: 13px; color: var(--muted); margin-top: 4px; }
.welcome-clock { text-align: right; font-variant-numeric: tabular-nums; }
.welcome-clock .clock-big { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; color: var(--text); }
.welcome-clock .clock-sub { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-top: 2px; }

.offline-banner {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 14px 18px;
  border-radius: var(--radius); margin-bottom: 20px;
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  background: var(--warning-soft); color: var(--text); font-size: 13px; line-height: 1.5;
  animation: fadeUp .35s var(--ease) both;
}
.offline-banner .banner-icon {
  width: 34px; height: 34px; flex-shrink: 0; border-radius: 9px; display: grid; place-items: center;
  background: color-mix(in srgb, var(--warning) 22%, transparent); color: var(--warning);
}
.offline-banner .banner-body { flex: 1; min-width: 180px; }
.offline-banner strong { font-weight: 600; color: var(--warning); display: block; font-size: 13px; }
.offline-banner p { color: var(--text-2); font-size: 12.5px; margin-top: 1px; }

/* CARDS */
.card {
  position: relative; background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 20px; box-shadow: var(--shadow-xs);
  transition: box-shadow .3s var(--ease), border-color .3s var(--ease), transform .3s var(--ease);
}
.card:hover { box-shadow: var(--shadow-md); border-color: var(--border-strong); }

.stats-grid {
  display: grid; grid-template-columns: 1.4fr 1fr 1fr 1fr; gap: 16px; margin-bottom: 20px;
  animation: fadeUp .5s var(--ease) both;
}
@media (max-width: 1000px) { .stats-grid { grid-template-columns: 1fr 1fr; } }
@media (max-width: 600px) { .stats-grid { grid-template-columns: 1fr; } }

.card-stat { display: flex; flex-direction: column; min-height: 240px; }
.card-head { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.icon-chip { width: 34px; height: 34px; flex-shrink: 0; border-radius: 9px; display: grid; place-items: center; }
.icon-chip .icon { width: 17px; height: 17px; }
.icon-chip-water { background: var(--primary-soft); color: var(--primary); }
.icon-chip-pump { background: var(--success-soft); color: var(--success); }
.icon-chip-solar { background: var(--warning-soft); color: var(--warning); }
.icon-chip-battery { background: var(--violet-soft); color: var(--violet); }
.icon-chip-neutral { background: var(--surface-2); color: var(--muted); }

.card-head-text { min-width: 0; }
.card-head h3 { font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.card-head .sub { font-size: 12px; color: var(--muted); margin-top: 2px; line-height: 1.45; }

.card-body { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 8px 0; }
.card-foot { flex-shrink: 0; padding-top: 8px; }

.water-gauge-wrap { position: relative; width: 140px; height: 140px; margin-bottom: 8px; }
.gauge { width: 100%; height: 100%; display: block; }
.gauge-track { fill: none; stroke: var(--track); stroke-width: 8; }
.gauge-fill {
  fill: none; stroke: url(#waterGrad); stroke-width: 8; stroke-linecap: round;
  stroke-dasharray: 326.726; stroke-dashoffset: 326.726;
  transition: stroke-dashoffset .7s var(--ease), stroke .4s var(--ease);
}
[data-theme="dark"] .gauge-fill { stroke: #22d3ee; }

/* gauge colours by category — kept AFTER the dark rule so they win */
.gauge-fill.level-critical { stroke: #ef4444; }
.gauge-fill.level-low      { stroke: #f59e0b; }
.gauge-fill.level-medium   { stroke: url(#waterGrad); }
.gauge-fill.level-full     { stroke: #10b981; }
[data-theme="dark"] .gauge-fill.level-critical { stroke: #f87171; }
[data-theme="dark"] .gauge-fill.level-low      { stroke: #fbbf24; }
[data-theme="dark"] .gauge-fill.level-medium   { stroke: #22d3ee; }
[data-theme="dark"] .gauge-fill.level-full     { stroke: #34d399; }

.gauge-center {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; text-align: center; pointer-events: none;
}
.gauge-value {
  font-size: 30px; font-weight: 800; letter-spacing: -0.03em; line-height: 1;
  font-variant-numeric: tabular-nums; color: var(--text);
}
.gauge-value small { font-size: 14px; font-weight: 600; color: var(--muted); margin-left: 2px; }
.water-status { font-size: 12.5px; color: var(--muted); text-align: center; font-weight: 500; margin-top: 4px; }

/* LOW / MEDIUM / FULL badge */
.level-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 12px; border-radius: 999px; margin-bottom: 8px;
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
  border: 1px solid transparent; transition: all .3s var(--ease);
}
.level-badge.low      { color: var(--warning); background: var(--warning-soft); border-color: color-mix(in srgb, var(--warning) 32%, transparent); }
.level-badge.critical { color: var(--danger);  background: var(--danger-soft);  border-color: color-mix(in srgb, var(--danger) 32%, transparent); }
.level-badge.medium   { color: var(--primary); background: var(--primary-soft); border-color: color-mix(in srgb, var(--primary) 32%, transparent); }
.level-badge.full     { color: var(--success); background: var(--success-soft); border-color: color-mix(in srgb, var(--success) 32%, transparent); }

.stat-value {
  font-size: 34px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.1;
  font-variant-numeric: tabular-nums; color: var(--text); display: flex; align-items: baseline; gap: 3px;
}
.stat-value .unit { font-size: 15px; font-weight: 600; color: var(--muted); }
.stat-value.on { color: var(--success); }
.stat-value.off { color: var(--danger); }
.stat-label { font-size: 12.5px; color: var(--muted); margin-top: 6px; text-align: center; }

.progress { height: 6px; border-radius: 999px; overflow: hidden; background: var(--track); position: relative; }
.bar {
  height: 100%; width: 0%; border-radius: 999px;
  background: linear-gradient(90deg, var(--primary), #22d3ee);
  transition: width .7s var(--ease), background .4s var(--ease);
  position: relative; overflow: hidden;
}
.bar::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.4), transparent);
  transform: translateX(-100%); animation: shine 2.5s ease-in-out infinite;
}
.bar.low  { background: linear-gradient(90deg, var(--warning), var(--danger)); }
.bar.full { background: linear-gradient(90deg, #10b981, #34d399); }
.bar.violet { background: linear-gradient(90deg, var(--violet), #c4b5fd); }
.bar.sun  { background: linear-gradient(90deg, #f59e0b, #fbbf24); }

/* solar efficiency block */
.eff-row {
  display: flex; align-items: baseline; justify-content: space-between;
  font-size: 11.5px; color: var(--muted); margin-bottom: 6px; font-weight: 500;
}
.eff-row strong { font-size: 13px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.eff-label { font-size: 11px; color: var(--muted); margin-top: 6px; text-align: center; }

/* PUMP HERO */
.pump-hero {
  margin-bottom: 20px;
  background: linear-gradient(135deg, var(--surface) 0%, var(--surface-2) 100%);
  border-color: var(--border-strong);
  animation: fadeUp .5s .08s var(--ease) both;
}
.pump-hero .card-head { margin-bottom: 18px; }
.pump-hero-grid {
  display: grid; grid-template-columns: 1.15fr 1fr; gap: 16px; align-items: stretch;
}
@media (max-width: 720px) { .pump-hero-grid { grid-template-columns: 1fr; } }

.pump-hero-controls { display: flex; gap: 12px; flex-wrap: wrap; }
.pump-hero-controls .btn { flex: 1; min-width: 140px; }

.btn-lg { padding: 16px 26px; font-size: 14px; font-weight: 700; border-radius: 12px; letter-spacing: 0.01em; }

.pump-hero-status {
  display: flex; flex-direction: column; justify-content: center;
  padding: 18px 22px; border-radius: 12px;
  background: var(--surface); border: 1px solid var(--border);
  min-height: 88px;
}
.pump-timer {
  font-size: 32px; font-weight: 800; letter-spacing: -0.02em; line-height: 1;
  font-variant-numeric: tabular-nums; color: var(--primary);
}
.pump-timer.idle { color: var(--muted-2); font-size: 22px; }
.pump-timer.done { color: var(--success); }
.pump-timer-label {
  font-size: 11px; color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.06em; font-weight: 600; margin-top: 8px;
}

.pump-hero-recipient {
  margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--border);
  display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: end;
}
@media (max-width: 600px) { .pump-hero-recipient { grid-template-columns: 1fr; } }
.pump-hero-recipient > div:first-child { min-width: 0; }
.pump-hero-recipient label { margin-top: 0; }

.sms-badge {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-radius: 10px;
  font-size: 12px; font-weight: 500; white-space: nowrap;
  border: 1px solid var(--border); background: var(--surface-2); color: var(--muted);
  transition: all .25s var(--ease);
  min-height: 42px;
}
.sms-badge .icon { width: 14px; height: 14px; }
.sms-badge.sending { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 30%, transparent); background: var(--warning-soft); }
.sms-badge.sending .icon { animation: spin 1s linear infinite; }
.sms-badge.sent { color: var(--success); border-color: color-mix(in srgb, var(--success) 30%, transparent); background: var(--success-soft); }
.sms-badge.error { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 30%, transparent); background: var(--danger-soft); }
.sms-badge.no-recipient { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 30%, transparent); background: var(--warning-soft); }

/* LOGS */
.logs-card { animation: fadeUp .5s .16s var(--ease) both; }
.logs-card .card-head { margin-bottom: 6px; }
.logs { max-height: 320px; overflow-y: auto; margin-top: 8px; padding-right: 4px; }
.logs::-webkit-scrollbar { width: 6px; }
.logs::-webkit-scrollbar-thumb { background: var(--border); border-radius: 99px; }
.log-item {
  display: flex; gap: 14px; align-items: flex-start; padding: 11px 4px;
  border-bottom: 1px solid var(--border); font-size: 13px;
  animation: fadeUp .3s var(--ease) both;
}
.log-item:last-child { border-bottom: none; }
.log-time {
  flex: 0 0 auto; font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
  color: var(--muted); font-variant-numeric: tabular-nums; min-width: 76px; padding-top: 1px;
}
.log-text { color: var(--text-2); line-height: 1.5; flex: 1; }
.empty { color: var(--muted); font-size: 13px; padding: 20px 4px; text-align: center; }

/* FORMS */
label {
  display: block; font-size: 11.5px; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--muted); margin: 14px 0 6px;
}
input, textarea {
  width: 100%; padding: 11px 14px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--surface-2); color: var(--text); font: inherit; font-size: 14px;
  transition: border-color .2s var(--ease), box-shadow .2s var(--ease), background .2s var(--ease);
  resize: vertical;
}
input:hover, textarea:hover { border-color: var(--border-strong); }
input:focus, textarea:focus {
  outline: none; border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-ring); background: var(--surface);
}
input::placeholder, textarea::placeholder { color: var(--muted-2); }

/* BUTTONS */
.btn {
  position: relative; overflow: hidden; display: inline-flex; align-items: center; justify-content: center;
  gap: 8px; padding: 11px 18px; border: 1px solid transparent; border-radius: 10px;
  cursor: pointer; font-size: 13px; font-weight: 600; letter-spacing: -0.005em;
  color: #fff; transition: all .2s var(--ease); box-shadow: var(--shadow-xs); white-space: nowrap;
}
.btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: var(--shadow-sm); }
.btn:active:not(:disabled) { transform: translateY(0); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-on { background: linear-gradient(135deg, #10b981, #059669); box-shadow: 0 4px 14px -6px rgba(16, 185, 129, 0.5); }
.btn-off { background: linear-gradient(135deg, #ef4444, #dc2626); box-shadow: 0 4px 14px -6px rgba(239, 68, 68, 0.5); }
.btn-send { background: linear-gradient(135deg, #06b6d4, #0891b2); box-shadow: 0 4px 14px -6px rgba(8, 145, 178, 0.5); }
.btn-ghost { background: var(--surface-2); color: var(--text); border-color: var(--border); box-shadow: none; }
.btn-ghost:hover:not(:disabled) { background: var(--surface); border-color: var(--border-strong); }

.ripple {
  position: absolute; border-radius: 50%; pointer-events: none;
  background: rgba(255, 255, 255, 0.5); transform: scale(0);
  animation: rippleAnim .6s ease-out;
}

.btn-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }

/* TOASTS */
.toasts {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  display: flex; flex-direction: column; gap: 10px; z-index: 90;
  width: min(420px, 92vw); pointer-events: none;
}
.toast {
  display: flex; align-items: flex-start; gap: 12px; padding: 13px 16px;
  border-radius: 12px; background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-left: 3px solid var(--primary);
  box-shadow: var(--shadow-lg); font-size: 13px; line-height: 1.5;
  animation: toastIn .3s var(--ease) both;
}
.toast.success { border-left-color: var(--success); }
.toast.error { border-left-color: var(--danger); }
.toast.warn { border-left-color: var(--warning); }
.toast.out { animation: toastOut .25s var(--ease) forwards; }

/* DRAWER */
.drawer-backdrop {
  position: fixed; inset: 0; z-index: 60; background: rgba(10, 15, 23, 0.5);
  backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
  opacity: 0; pointer-events: none; transition: opacity .3s var(--ease);
}
.drawer-backdrop.open { opacity: 1; pointer-events: auto; }
.drawer {
  position: fixed; top: 0; right: 0; z-index: 70; height: 100%;
  width: min(420px, 94vw); background: var(--surface); border-left: 1px solid var(--border);
  padding: 28px; overflow-y: auto; transform: translateX(105%);
  transition: transform .35s var(--ease); box-shadow: var(--shadow-lg);
}
.drawer.open { transform: translateX(0); }
.drawer h2 { font-size: 16px; letter-spacing: 0.02em; font-weight: 700; margin-bottom: 4px; }
.drawer .sub { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
.drawer .note {
  font-size: 11.5px; color: var(--muted); line-height: 1.6; margin-top: 12px;
  padding: 12px 14px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--border);
}
.drawer .note strong { color: var(--text-2); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; word-break: break-all; color: var(--primary); }

.switch-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 18px; padding: 4px 0; }
.switch-row + .switch-row { margin-top: 14px; }
.switch-row strong { font-size: 13px; font-weight: 600; display: block; }
.switch-row .sub { font-size: 11.5px; color: var(--muted); margin: 2px 0 0 0; line-height: 1.4; }
.switch { position: relative; width: 48px; height: 28px; flex-shrink: 0; }
.switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; z-index: 2; }
.switch span { position: absolute; inset: 0; border-radius: 999px; background: var(--track); transition: background .25s var(--ease); }
.switch span::after {
  content: ""; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: transform .25s var(--ease);
}
.switch input:checked + span { background: var(--primary); }
.switch input:checked + span::after { transform: translateX(20px); }

footer {
  text-align: center; padding: 24px 18px 36px; color: var(--muted-2);
  font-size: 11.5px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;
}

@keyframes fadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes toastIn { from { opacity: 0; transform: translateY(16px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes toastOut { to { opacity: 0; transform: translateY(10px) scale(0.98); } }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 currentColor; } 70% { box-shadow: 0 0 0 6px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
@keyframes shine { 0% { transform: translateX(-100%); } 55%, 100% { transform: translateX(100%); } }
@keyframes rippleAnim { to { transform: scale(2.5); opacity: 0; } }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 640px) {
  .brand p { display: none; }
  .topbar { padding: 0 16px; }
  .container { padding: 16px 16px 32px; }
  .welcome { padding: 16px 18px; }
  .welcome-clock { text-align: left; }
  .card { padding: 16px; }
  .card-stat { min-height: 220px; }
  .drawer { padding: 24px 20px; }
  .btn-lg { padding: 14px 20px; }
  .pump-timer { font-size: 26px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .001ms !important; animation-iteration-count: 1 !important;
    transition-duration: .001ms !important;
  }
}
</style>
</head>

<body>

<!-- AUTH -->
<div id="authView" class="auth-view">
  <aside class="auth-brand">
    <div class="auth-brand-top">
      <div class="brand-logo">
        <svg class="icon-xl" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>
      </div>
      <div>
        <h1>Water tank management, done right.</h1>
        <p style="margin-top: 12px;">Monitor, control, and automate your household water system — with automatic SMS alerts and solar-aware scheduling built in.</p>
      </div>
      <ul>
        <li>
          <span class="feature-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></span>
          Live tank and pump readings from your controller
        </li>
        <li>
          <span class="feature-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg></span>
          Time-aware solar and battery monitoring
        </li>
        <li>
          <span class="feature-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg></span>
          Automatic pump cycles with automatic SMS notifications
        </li>
      </ul>
    </div>
    <span class="auth-brand-foot">PROJECT SOLWAT · LNHS</span>
  </aside>

  <main class="auth-panel">
    <div class="auth-card">
      <h2 id="authTitle">Welcome back</h2>
      <p class="sub">Sign in to monitor your water tank system.</p>

      <div class="tabs">
        <button class="tab active" data-tab="login" type="button">Sign in</button>
        <button class="tab" data-tab="register" type="button">Register</button>
      </div>

      <form id="loginForm" class="form" novalidate>
        <label for="loginPhone">Phone number</label>
        <input id="loginPhone" type="tel" placeholder="+639171234567" autocomplete="username">
        <label for="loginPass">Password</label>
        <input id="loginPass" type="password" placeholder="••••••••" autocomplete="current-password">
        <p class="form-error" id="loginError"></p>
        <button class="btn btn-send wide" type="submit">Sign in</button>
      </form>

      <form id="registerForm" class="form hidden" novalidate>
        <label for="regName">Home owner name</label>
        <input id="regName" type="text" placeholder="e.g. Juan Dela Cruz" autocomplete="name">
        <label for="regPhone">Phone number</label>
        <input id="regPhone" type="tel" placeholder="+639171234567" autocomplete="tel">
        <label for="regPass">Password</label>
        <input id="regPass" type="password" placeholder="At least 6 characters" autocomplete="new-password">
        <label for="regPass2">Confirm password</label>
        <input id="regPass2" type="password" placeholder="Re-enter password" autocomplete="new-password">
        <p class="form-error" id="regError"></p>
        <button class="btn btn-send wide" type="submit">Create account</button>
      </form>

      <p class="auth-note">Accounts are stored locally in this browser. Use your phone number to sign in.</p>
    </div>
  </main>
</div>

<!-- APP -->
<div id="appView" class="app-view hidden">

  <header class="topbar">
    <div class="brand">
      <div class="brand-logo">
        <svg class="icon-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>
      </div>
      <div>
        <h1>PROJECT SOLWAT</h1>
        <p>Solar-powered water tank management</p>
      </div>
    </div>
    <div class="topbar-actions">
      <div id="connection" class="pill offline">
        <span class="dot"></span><span id="connectionText">Connecting…</span>
      </div>
      <div class="user-chip" title="Signed in">
        <span class="avatar" id="userAvatar">?</span>
        <span class="user-meta">
          <strong id="userName">—</strong>
          <small id="userPhone">—</small>
        </span>
      </div>
      <button class="icon-btn" id="themeBtn" title="Toggle theme" aria-label="Toggle theme">
        <svg class="icon icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        <svg class="icon icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
      </button>
      <button class="icon-btn" id="settingsBtn" title="Settings" aria-label="Settings">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
      <button class="icon-btn" id="logoutBtn" title="Sign out" aria-label="Sign out">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      </button>
    </div>
  </header>

  <main class="container">

    <section class="welcome">
      <div>
        <h2><span id="greeting">Welcome back</span>, <span id="welcomeName">—</span></h2>
        <p id="welcomeSub">Connecting to controller…</p>
      </div>
      <div class="welcome-clock">
        <div class="clock-big" id="welcomeClock">--:--</div>
        <div class="clock-sub" id="clockSub">—</div>
      </div>
    </section>

    <div id="offlineBanner" class="offline-banner hidden">
      <span class="banner-icon">
        <svg class="icon-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </span>
      <div class="banner-body">
        <strong>Controller not detected</strong>
        <p>Make sure the ESP32 is powered and joined to the same Wi-Fi network as this browser.</p>
      </div>
      <button class="btn btn-ghost" id="retryBtn" type="button">Retry</button>
    </div>

    <section class="stats-grid">

      <article class="card card-stat">
        <div class="card-head">
          <span class="icon-chip icon-chip-water">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>
          </span>
          <div class="card-head-text">
            <h3>Water Level</h3>
            <p class="sub">Live tank volume</p>
          </div>
        </div>
        <div class="card-body">
          <div class="water-gauge-wrap">
            <svg class="gauge" viewBox="0 0 120 120">
              <defs>
                <linearGradient id="waterGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#06b6d4"/>
                  <stop offset="100%" stop-color="#0891b2"/>
                </linearGradient>
              </defs>
              <circle class="gauge-track" cx="60" cy="60" r="52"/>
              <circle class="gauge-fill level-medium" id="waterGauge" cx="60" cy="60" r="52" transform="rotate(-90 60 60)"/>
            </svg>
            <div class="gauge-center">
              <div class="gauge-value"><span id="waterLevel">—</span><small>%</small></div>
            </div>
          </div>
          <span class="level-badge medium" id="waterBadge">—</span>
          <p class="water-status" id="waterState">Reading tank sensor…</p>
        </div>
        <div class="card-foot">
          <div class="progress"><div id="waterBar" class="bar"></div></div>
        </div>
      </article>

      <article class="card card-stat">
        <div class="card-head">
          <span class="icon-chip icon-chip-pump">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>
          </span>
          <div class="card-head-text">
            <h3>Water Pump</h3>
            <p class="sub">Motor state</p>
          </div>
        </div>
        <div class="card-body">
          <div class="stat-value off" id="pumpStatus">--</div>
          <p class="stat-label" id="pumpMode">Mode: --</p>
        </div>
      </article>

      <article class="card card-stat">
        <div class="card-head">
          <span class="icon-chip icon-chip-solar">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
          </span>
          <div class="card-head-text">
            <h3>Solar Power</h3>
            <p class="sub">PV output &amp; efficiency</p>
          </div>
        </div>
        <div class="card-body">
          <div class="stat-value"><span id="solarPower">—</span><span class="unit">W</span></div>
          <p class="stat-label" id="solarHint">Reading solar sensor…</p>
        </div>
        <div class="card-foot">
          <div class="eff-row"><span>Panel efficiency</span><strong id="solarEfficiency">—</strong></div>
          <div class="progress"><div id="solarBar" class="bar sun"></div></div>
          <p class="eff-label" id="solarEffLabel">—</p>
        </div>
      </article>

      <article class="card card-stat">
        <div class="card-head">
          <span class="icon-chip icon-chip-battery">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2"/></svg>
          </span>
          <div class="card-head-text">
            <h3>Battery</h3>
            <p class="sub">Reserve power</p>
          </div>
        </div>
        <div class="card-body">
          <div class="stat-value"><span id="batteryLevel">—</span><span class="unit">%</span></div>
          <p class="stat-label" id="batteryHint">Reading battery…</p>
        </div>
        <div class="card-foot">
          <div class="progress"><div id="batteryBar" class="bar violet"></div></div>
        </div>
      </article>

    </section>

    <!-- HERO PUMP CONTROL -->
    <article class="card pump-hero">
      <div class="card-head">
        <span class="icon-chip icon-chip-pump">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>
        </span>
        <div class="card-head-text">
          <h3>Pump Automation</h3>
          <p class="sub">PUMP ON runs for 9 minutes then auto-off. SMS is sent automatically on both events.</p>
        </div>
      </div>

      <div class="pump-hero-grid">
        <div class="pump-hero-controls">
          <button class="btn btn-on btn-lg" data-pump="ON">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>
            Pump on
          </button>
          <button class="btn btn-off btn-lg" data-pump="OFF">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
            Pump off
          </button>
        </div>

        <div class="pump-hero-status">
          <div class="pump-timer idle" id="pumpTimer">Idle</div>
          <div class="pump-timer-label" id="pumpTimerLabel">No active cycle</div>
        </div>
      </div>

      <div class="pump-hero-recipient">
        <div>
          <label for="smsRecipient">SMS recipient</label>
          <input id="smsRecipient" type="tel" placeholder="+639XXXXXXXXX" autocomplete="tel">
        </div>
        <div class="sms-badge idle" id="smsBadge">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
          <span id="smsBadgeText">SMS ready</span>
        </div>
      </div>
    </article>

    <article class="card logs-card">
      <div class="card-head">
        <span class="icon-chip icon-chip-neutral">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
        </span>
        <div class="card-head-text">
          <h3>System Activity</h3>
          <p class="sub">Latest controller, sensor and command events</p>
        </div>
      </div>
      <div id="logs" class="logs">
        <p class="empty">No activity records available.</p>
      </div>
    </article>
  </main>

  <footer>PROJECT SOLWAT · LNHS</footer>
</div>

<div id="toasts" class="toasts" aria-live="polite"></div>
<div id="drawerBackdrop" class="drawer-backdrop"></div>

<aside id="drawer" class="drawer" aria-hidden="true">
  <h2>Settings</h2>
  <p class="sub">Configure the controller endpoint and pump automation.</p>

  <label for="apiBaseInput">Controller API base URL</label>
  <input id="apiBaseInput" type="url" placeholder="/api">
  <button class="btn btn-ghost wide" id="testApiBtn" type="button" style="margin-top: 8px;">Test connection</button>

  <label for="autoOffMinutesInput">Auto-off after PUMP ON (minutes)</label>
  <input id="autoOffMinutesInput" type="number" min="1" max="60" step="1">

  <div class="switch-row">
    <div>
      <strong>Automatic pump shutdown</strong>
      <p class="sub">Turn the pump off and send SMS after the cycle.</p>
    </div>
    <label class="switch">
      <input id="autoOffToggle" type="checkbox">
      <span></span>
    </label>
  </div>

  <div class="switch-row">
    <div>
      <strong>Fallback readings</strong>
      <p class="sub">Use built-in readings when the controller cannot be reached.</p>
    </div>
    <label class="switch">
      <input id="fallbackToggle" type="checkbox">
      <span></span>
    </label>
  </div>

  <div class="btn-row">
    <button class="btn btn-send" id="saveSettingsBtn" type="button">Save</button>
    <button class="btn btn-ghost" id="closeDrawerBtn" type="button">Close</button>
  </div>

  <p class="note">
    <strong>SMS gateway:</strong> messages are relayed by the server, so the TextBee API key never reaches the browser.
    Override it with the <code>TEXTBEE_TOKEN</code> and <code>TEXTBEE_DEVICE</code> environment variables.
  </p>

  <p class="note">
    SMS is sent automatically whenever the pump changes state — no manual message is required.
  </p>
</aside>

<script>
/* =====================================================================
   PROJECT SOLWAT — front-end controller
   ===================================================================== */

const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 52;

const $ = (id) => document.getElementById(id);
const clamp = (v,a,b) => Math.min(b, Math.max(a, v));
const rand  = (a,b) => a + Math.random() * (b - a);

const store = {
  get(k,d){ try{ const v=localStorage.getItem("solwat."+k); return v===null?d:v; }catch{ return d; } },
  set(k,v){ try{ localStorage.setItem("solwat."+k, v); }catch{} }
};

const USERS_KEY   = "solwat.users";
const SESSION_KEY = "solwat.session";
const CYCLE_KEY   = "solwat.pumpCycle";

/* The server owns the API, so the default base is same-origin "/api". */
const storedApi = store.get("apiBase", "");
const initialApi = (!storedApi || storedApi === "http://192.168.4.1/api") ? "/api" : storedApi;

const state = {
  apiBase:   initialApi,
  recipient: store.get("recipient", ""),
  autoOff:   store.get("autoOff", "true") === "true",
  autoOffMinutes: Number(store.get("autoOffMinutes", "9")) || 9,
  fallback:  (store.get("fallback", "true") === "true"),
  activityLogs: []
};

const sim = { water: 46, pump: "OFF", mode: "AUTO", battery: 88 };

let pollStatusId = null, pollLogsId = null, clockId = null;
let pumpCycle = null, pumpCycleInt = null;
let esp32Online = false;
let statusInFlight = false;

/* --- AUTH ------------------------------------------------------------ */
function getUsers(){ try{ return JSON.parse(store.get(USERS_KEY,"[]")); }catch{ return []; } }
function saveUsers(list){ store.set(USERS_KEY, JSON.stringify(list)); }
function currentUser(){
  const phone = store.get(SESSION_KEY,"");
  if (!phone) return null;
  return getUsers().find(u => u.phone === phone) || null;
}
function isLoggedIn(){ return !!currentUser(); }

async function hashPass(p){
  const str = p + "::solwat";
  if (window.crypto && crypto.subtle){
    try{
      const buf = new TextEncoder().encode(str);
      const d = await crypto.subtle.digest("SHA-256", buf);
      return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,"0")).join("");
    }catch{}
  }
  let h = 0x811c9dc5;
  for (let i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return "fnv:" + (h>>>0).toString(16);
}

function normalizePhone(p){ return p.replace(/[^\d+]/g,""); }
function validPhone(p){ return /^\+?[0-9]{10,15}$/.test(p); }

/* --- UI -------------------------------------------------------------- */
function toast(message, type){
  const box = $("toasts");
  const el = document.createElement("div");
  el.className = "toast " + (type || "info");
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once:true });
  }, 4200);
}

function animateNumber(el, to, decimals){
  if (!el) return;
  decimals = decimals || 0;
  const from = parseFloat(el.dataset.value || "0");
  const target = Number.isFinite(to) ? to : 0;
  if (Math.abs(from - target) < 0.05){ el.textContent = target.toFixed(decimals); el.dataset.value = target; return; }
  const start = performance.now(), dur = 700;
  function step(now){
    const p = Math.min(1, (now-start)/dur);
    const e = 1 - Math.pow(1-p,3);
    el.textContent = (from + (target-from)*e).toFixed(decimals);
    if (p<1) requestAnimationFrame(step);
    else { el.dataset.value = target; el.textContent = target.toFixed(decimals); }
  }
  el.dataset.value = target;
  requestAnimationFrame(step);
}

function setGauge(percent){
  const g = $("waterGauge");
  if (!g) return;
  const clamped = clamp(percent, 0, 100);
  g.style.strokeDashoffset = String(GAUGE_CIRCUMFERENCE * (1 - clamped / 100));
}

function setConnection(online){
  const pill = $("connection"), text = $("connectionText");
  pill.className = "pill " + (online ? "live" : "offline");
  text.textContent = online ? "SYSTEM ONLINE" : "SYSTEM OFFLINE";
  $("offlineBanner").classList.toggle("hidden", online);
  const el = $("welcomeSub");
  if (el){
    el.textContent = online
      ? "Controller connected · readings current"
      : "Controller offline · reconnecting";
  }
}

/* --- SMS BADGE ------------------------------------------------------- */
function setSmsBadge(kind, text){
  const badge = $("smsBadge");
  const textEl = $("smsBadgeText");
  if (!badge || !textEl) return;
  badge.className = "sms-badge " + kind;
  textEl.textContent = text;
}

/* --- TIME-BASED SOLAR (fallback only) -------------------------------- */
function estimatedSolar(){
  const now = new Date();
  const h = now.getHours() + now.getMinutes()/60;
  if (h < 6 || h >= 18) return 0;
  const t = (h - 6) / 12;
  return Math.round(Math.sin(t * Math.PI) * 300);
}

/* --- WATER CATEGORIES ------------------------------------------------ */
function waterCategory(v){
  if (v < 15) return { key:"critical", label:"Critical", text:"Critical — refill immediately" };
  if (v < 35) return { key:"low",      label:"Low",      text:"Low — monitor closely" };
  if (v < 75) return { key:"medium",   label:"Medium",   text:"Medium — normal operating level" };
  return              { key:"full",     label:"Full",     text:"Full — tank at capacity" };
}

/* --- RENDER ---------------------------------------------------------- */
function renderOffline(){
  $("waterLevel").textContent = "—"; $("waterLevel").dataset.value = "0";
  setGauge(0);
  $("waterBar").style.width = "0%";
  $("waterBar").className = "bar";
  $("waterBadge").className = "level-badge medium";
  $("waterBadge").textContent = "—";
  $("waterState").textContent = "Waiting for controller…";
  $("pumpStatus").textContent = "--"; $("pumpStatus").className = "stat-value off";
  $("pumpMode").textContent = "Mode: --";
  $("solarPower").textContent = "—"; $("solarPower").dataset.value = "0";
  $("solarHint").textContent = "No data from controller";
  $("solarEfficiency").textContent = "—";
  $("solarBar").style.width = "0%";
  $("solarEffLabel").textContent = "No data from controller";
  $("batteryLevel").textContent = "—"; $("batteryLevel").dataset.value = "0";
  $("batteryBar").style.width = "0%";
  $("batteryHint").textContent = "No data from controller";
}

function render(d){
  if (!d){ renderOffline(); return; }

  /* ---- WATER LEVEL ---- */
  const water = clamp(Number(d.waterLevel)||0, 0, 100);
  const cat = (d.waterCategory && d.waterCategory.key) ? d.waterCategory : waterCategory(water);

  animateNumber($("waterLevel"), water, 0);
  setGauge(water);

  const gauge = $("waterGauge");
  gauge.classList.remove("level-critical","level-low","level-medium","level-full");
  gauge.classList.add("level-" + cat.key);

  const bar = $("waterBar");
  bar.style.width = water + "%";
  bar.className = "bar" + (cat.key === "critical" || cat.key === "low" ? " low" : cat.key === "full" ? " full" : "");

  const badge = $("waterBadge");
  badge.className = "level-badge " + cat.key;
  badge.textContent = cat.label;

  $("waterState").textContent = d.waterState || cat.text;

  /* ---- PUMP ---- */
  const pump = String(d.pumpStatus || "--").toUpperCase();
  const pumpEl = $("pumpStatus");
  pumpEl.textContent = pump;
  pumpEl.className = "stat-value " + (pump === "ON" ? "on" : "off");
  $("pumpMode").textContent = "Mode: " + (d.pumpMode || "--");

  /* ---- SOLAR + EFFICIENCY ---- */
  const solar = Number(d.solarPower) || 0;
  animateNumber($("solarPower"), solar, 0);

  const eff = d.solarEfficiency;
  const hasEff = (eff !== null && eff !== undefined && Number.isFinite(Number(eff)));

  if (hasEff){
    const effNum = clamp(Number(eff), 0, 100);
    $("solarEfficiency").textContent = effNum + "%";
    $("solarBar").style.width = effNum + "%";
    $("solarHint").textContent = d.solarIdeal
      ? ("of " + d.solarIdeal + " W clear-sky")
      : "Live PV output";
    $("solarEffLabel").textContent = d.solarEfficiencyLabel || "";
  } else {
    $("solarEfficiency").textContent = "—";
    $("solarBar").style.width = "0%";
    $("solarHint").textContent = "Night · no charging";
    $("solarEffLabel").textContent = d.solarEfficiencyLabel || "Night · solar idle";
  }

  /* ---- BATTERY ---- */
  const batt = clamp(Number(d.batteryLevel)||0, 0, 100);
  animateNumber($("batteryLevel"), batt, 0);
  $("batteryBar").style.width = batt + "%";
  $("batteryHint").textContent = batt >= 60 ? "Battery healthy" : batt >= 30 ? "Battery moderate" : "Battery low — conserve power";
}

function renderLogs(list){
  const box = $("logs");
  if (!Array.isArray(list) || list.length === 0){
    box.innerHTML = '<p class="empty">No activity records available.</p>';
    return;
  }
  box.innerHTML = "";
  list.slice(0,60).forEach(item => {
    const row = document.createElement("div");
    row.className = "log-item";
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = item.timestamp || "—";
    const text = document.createElement("span");
    text.className = "log-text";
    text.textContent = item.activity || "";
    row.append(time, text);
    box.appendChild(row);
  });
}

function pushLog(activity){
  const entry = {
    timestamp: new Date().toLocaleTimeString([], { hour:"2-digit", minute:"2-digit", second:"2-digit" }),
    activity
  };
  state.activityLogs.unshift(entry);
  if (state.activityLogs.length > 60) state.activityLogs.pop();
  if (!esp32Online) renderLogs(state.activityLogs);
}

/* --- BUILT-IN READINGS (fallback mode) ------------------------------- */
function builtInTick(){
  if (sim.pump === "ON") sim.water = Math.min(100, sim.water + rand(1.2, 3.0));
  else                   sim.water = Math.max(0,   sim.water - rand(0.2, 0.7));

  if (sim.pump === "ON" && sim.water >= 99){
    sim.pump = "OFF";
    pushLog("Auto-stop · tank reached full capacity");
  }
  if (sim.pump === "OFF" && sim.mode === "AUTO" && sim.water <= 8){
    sim.pump = "ON";
    pushLog("Auto-start · water level critical");
  }

  const solar = estimatedSolar();
  if (solar > 0) sim.battery = clamp(sim.battery + rand(0.02, 0.12) * (solar/300), 5, 100);
  else           sim.battery = clamp(sim.battery - rand(0.02, 0.08), 5, 100);
  if (sim.pump === "ON") sim.battery = clamp(sim.battery - 0.05, 5, 100);

  const level = Math.round(sim.water);
  const cat = waterCategory(level);

  return {
    waterLevel:   level,
    waterCategory: cat,
    waterState:   cat.text,
    pumpStatus:   sim.pump,
    pumpMode:     sim.mode,
    solarPower:   solar,
    solarIdeal:   solar,
    solarEfficiency: solar > 0 ? 85 : null,
    solarEfficiencyLabel: solar > 0 ? "Excellent · clear sky" : "Night · solar idle",
    batteryLevel: Math.round(sim.battery)
  };
}

/* --- NETWORK --------------------------------------------------------- */
function withTimeout(promise, ms){
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Request timed out")), ms);
    promise.then(v => { clearTimeout(t); resolve(v); },
                 e => { clearTimeout(t); reject(e); });
  });
}

async function fetchJSON(url, options, timeout){
  options = options || {};
  const res = await withTimeout(fetch(url, options), timeout || 6000);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok) throw new Error(data.message || data.error || ("HTTP " + res.status));
  return data;
}

async function updateStatus(){
  if (!isLoggedIn() || statusInFlight) return;
  statusInFlight = true;
  try{
    try{
      const data = await fetchJSON(state.apiBase + "/status", { cache:"no-store" }, 3500);
      esp32Online = true;
      render(data);
      setConnection(true);
      return;
    } catch (e) {
      esp32Online = false;
    }

    if (state.fallback){
      render(builtInTick());
      setConnection(true);
      return;
    }

    renderOffline();
    setConnection(false);
  } finally {
    statusInFlight = false;
  }
}

async function loadLogs(){
  if (!isLoggedIn()) return;
  try{
    const data = await fetchJSON(state.apiBase + "/logs", { cache:"no-store" }, 5000);
    if (Array.isArray(data.logs) && data.logs.length > 0){
      renderLogs(data.logs);
      return;
    }
  } catch (e) {}
  renderLogs(state.activityLogs);
}

/* --- CLOCK ----------------------------------------------------------- */
function tickClock(){
  const el = $("welcomeClock");
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
  const h = now.getHours();
  const sub = $("clockSub");
  if (sub) sub.textContent = (h < 6 || h >= 18) ? "Night · solar idle" : "Daytime · solar active";
  const g = $("greeting");
  if (g){
    const greeting = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    if (g.textContent !== greeting) g.textContent = greeting;
  }
}

/* --- PUMP CYCLE ------------------------------------------------------ */
function startPumpCycle(minutes){
  cancelPumpCycle(false);
  const endsAt = Date.now() + minutes * 60 * 1000;
  pumpCycle = { endsAt: endsAt, durationMin: minutes };
  store.set(CYCLE_KEY, JSON.stringify(pumpCycle));
  tickPumpCycle();
  pumpCycleInt = setInterval(tickPumpCycle, 1000);
}

function tickPumpCycle(){
  if (!pumpCycle) return;
  const left = pumpCycle.endsAt - Date.now();
  if (left <= 0){
    cancelPumpCycle(true);
    controlPump("OFF", { automated: true });
    return;
  }
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  const timerEl = $("pumpTimer");
  const labelEl = $("pumpTimerLabel");
  if (timerEl){
    timerEl.textContent = m + ":" + String(s).padStart(2,"0");
    timerEl.className = "pump-timer";
  }
  if (labelEl) labelEl.textContent = "Auto-off in";
}

function cancelPumpCycle(expired){
  if (pumpCycleInt){ clearInterval(pumpCycleInt); pumpCycleInt = null; }
  pumpCycle = null;
  store.set(CYCLE_KEY, "");
  const timerEl = $("pumpTimer");
  const labelEl = $("pumpTimerLabel");
  if (timerEl){
    timerEl.textContent = expired ? "Done" : "Idle";
    timerEl.className = "pump-timer " + (expired ? "done" : "idle");
  }
  if (labelEl) labelEl.textContent = expired ? "Cycle complete" : "No active cycle";
}

function restorePumpCycle(){
  const raw = store.get(CYCLE_KEY, "");
  if (!raw) return;
  try{
    const obj = JSON.parse(raw);
    if (!obj || !obj.endsAt) return;
    pumpCycle = obj;
    if (obj.endsAt <= Date.now()){
      cancelPumpCycle(true);
      setTimeout(() => controlPump("OFF", { automated: true }), 800);
    } else {
      tickPumpCycle();
      pumpCycleInt = setInterval(tickPumpCycle, 1000);
    }
  } catch (e) {}
}

/* --- SMS (server proxy) ---------------------------------------------- */
async function sendViaGateway(recipient, message){
  if (!recipient) throw new Error("Recipient number is missing.");
  return fetchJSON("/api/sms/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: recipient, message: message })
  }, 15000);
}

async function notifyPump(action, extra){
  const inputEl = $("smsRecipient");
  const recipient = (inputEl && inputEl.value.trim()) || state.recipient;
  if (!recipient){
    setSmsBadge("no-recipient", "Set recipient above");
    return;
  }
  const message = "SOLWAT: Water pump is " + action + "." + (extra ? " " + extra : "");
  setSmsBadge("sending", "Sending SMS…");
  try{
    await sendViaGateway(recipient, message);
    const timeStr = new Date().toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
    setSmsBadge("sent", "Last SMS: PUMP " + action + " · " + timeStr);
    pushLog("SMS · PUMP " + action + " → " + recipient);
  } catch (err){
    setSmsBadge("error", "SMS failed: " + err.message);
    pushLog("SMS failed · " + err.message);
    toast("SMS: " + err.message, "error");
  }
}

/* --- PUMP CONTROL ---------------------------------------------------- */
async function controlPump(action, opts){
  opts = opts || {};
  const automated = !!opts.automated;
  const buttons = document.querySelectorAll("[data-pump]");

  buttons.forEach(b => b.disabled = true);

  if (esp32Online){
    try{
      const result = await fetchJSON(state.apiBase + "/pump/control", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ action: action, source: automated ? "AUTO" : "APP" })
      }, 6000);
      toast(result.message || ("PUMP " + action + " accepted."), "success");
    } catch (err){
      toast("Controller error: " + err.message, "error");
    }
  } else {
    sim.pump = action;
    toast("PUMP " + action + " applied.", "success");
  }

  if (action === "ON"){
    if (state.autoOff && state.autoOffMinutes > 0) startPumpCycle(state.autoOffMinutes);
    else cancelPumpCycle(false);
    notifyPump("ON", (state.autoOff && state.autoOffMinutes > 0)
      ? ("Auto-off in " + state.autoOffMinutes + " min.") : "");
  } else {
    cancelPumpCycle(false);
    notifyPump("OFF", automated ? "Cycle complete." : "");
  }

  pushLog("PUMP " + action + " " + (automated ? "· auto cycle" : "· manual"));
  buttons.forEach(b => b.disabled = false);
  updateStatus();
  loadLogs();
}

/* --- THEME ----------------------------------------------------------- */
function initTheme(){
  const saved = store.get("theme", "light");
  document.documentElement.setAttribute("data-theme", saved);
  const btn = $("themeBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    store.set("theme", next);
  });
}

/* --- SETTINGS -------------------------------------------------------- */
function openDrawer(){
  $("apiBaseInput").value  = state.apiBase;
  $("autoOffMinutesInput").value = state.autoOffMinutes;
  $("autoOffToggle").checked = state.autoOff;
  $("fallbackToggle").checked = state.fallback;
  $("drawer").classList.add("open");
  $("drawerBackdrop").classList.add("open");
  $("drawer").setAttribute("aria-hidden","false");
}
function closeDrawer(){
  $("drawer").classList.remove("open");
  $("drawerBackdrop").classList.remove("open");
  $("drawer").setAttribute("aria-hidden","true");
}
function saveSettings(){
  state.apiBase   = $("apiBaseInput").value.trim() || "/api";
  state.autoOffMinutes = clamp(Number($("autoOffMinutesInput").value) || 9, 1, 60);
  state.autoOff   = $("autoOffToggle").checked;
  state.fallback  = $("fallbackToggle").checked;

  store.set("apiBase", state.apiBase);
  store.set("autoOffMinutes", String(state.autoOffMinutes));
  store.set("autoOff", String(state.autoOff));
  store.set("fallback", String(state.fallback));

  closeDrawer();
  toast("Settings saved.", "success");
  pushLog("Settings updated");
  updateStatus();
  loadLogs();
}

async function testApi(){
  const url = $("apiBaseInput").value.trim() || state.apiBase;
  try{
    const data = await fetchJSON(url + "/status", { cache:"no-store" }, 5000);
    toast("Controller responded: " + JSON.stringify(data).slice(0, 80), "success");
  } catch (err){
    toast("No response: " + err.message, "error");
  }
}

/* --- VIEW SWITCHING -------------------------------------------------- */
function showAuth(){
  $("authView").classList.remove("hidden");
  $("appView").classList.add("hidden");
  stopPolling();
  const u = currentUser();
  if (u) $("loginPhone").value = u.phone;
}

function showApp(user){
  $("authView").classList.add("hidden");
  $("appView").classList.remove("hidden");

  $("welcomeName").textContent = user.name;
  $("userName").textContent = user.name;
  $("userPhone").textContent = user.phone;
  $("userAvatar").textContent = (user.name || "?").trim().charAt(0) || "?";

  if (!state.recipient) state.recipient = user.phone;
  const rec = $("smsRecipient");
  if (rec && !rec.value) rec.value = state.recipient || user.phone;

  if (rec){
    rec.addEventListener("change", () => {
      state.recipient = rec.value.trim();
      store.set("recipient", state.recipient);
    });
  }

  startPolling();
  restorePumpCycle();
  updateStatus();
  loadLogs();
}

function startPolling(){
  stopPolling();
  pollStatusId = setInterval(updateStatus, 3000);
  pollLogsId   = setInterval(loadLogs, 10000);
}
function stopPolling(){
  if (pollStatusId){ clearInterval(pollStatusId); pollStatusId = null; }
  if (pollLogsId){ clearInterval(pollLogsId); pollLogsId = null; }
}

/* --- AUTH EVENTS ----------------------------------------------------- */
function setupAuth(){
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t === tab));
      $("loginForm").classList.toggle("hidden", target !== "login");
      $("registerForm").classList.toggle("hidden", target !== "register");
      $("authTitle").textContent = target === "login" ? "Welcome back" : "Create your account";
    });
  });

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("loginError");
    err.textContent = "";
    const phone = normalizePhone($("loginPhone").value.trim());
    const pass  = $("loginPass").value;

    if (!validPhone(phone)){ err.textContent = "Enter a valid phone number."; return; }
    if (!pass){ err.textContent = "Enter your password."; return; }

    const user = getUsers().find(u => u.phone === phone);
    if (!user){ err.textContent = "No account found for this number."; return; }

    const hash = await hashPass(pass);
    if (hash !== user.passHash){ err.textContent = "Incorrect password."; return; }

    store.set(SESSION_KEY, user.phone);
    $("loginPass").value = "";
    toast("Signed in successfully.", "success");
    showApp(user);
  });

  $("registerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("regError");
    err.textContent = "";
    const name  = $("regName").value.trim();
    const phone = normalizePhone($("regPhone").value.trim());
    const pass  = $("regPass").value;
    const pass2 = $("regPass2").value;

    if (name.length < 2){ err.textContent = "Enter the home owner's full name."; return; }
    if (!validPhone(phone)){ err.textContent = "Enter a valid phone number."; return; }
    if (pass.length < 6){ err.textContent = "Password must be at least 6 characters."; return; }
    if (pass !== pass2){ err.textContent = "Passwords do not match."; return; }
    if (getUsers().some(u => u.phone === phone)){ err.textContent = "This number is already registered."; return; }

    const user = { name: name, phone: phone, passHash: await hashPass(pass), createdAt: Date.now() };
    const list = getUsers(); list.push(user); saveUsers(list);
    store.set(SESSION_KEY, phone);
    toast("Account created. Welcome!", "success");
    showApp(user);
  });

  $("logoutBtn").addEventListener("click", () => {
    store.set(SESSION_KEY, "");
    cancelPumpCycle(false);
    toast("Signed out.", "info");
    showAuth();
  });
}

/* --- SETTINGS / MISC EVENTS ----------------------------------------- */
function setupApp(){
  initTheme();

  document.querySelectorAll("[data-pump]").forEach(btn => {
    btn.addEventListener("click", () => controlPump(btn.dataset.pump));
  });

  $("settingsBtn").addEventListener("click", openDrawer);
  $("closeDrawerBtn").addEventListener("click", closeDrawer);
  $("saveSettingsBtn").addEventListener("click", saveSettings);
  $("testApiBtn").addEventListener("click", testApi);
  $("drawerBackdrop").addEventListener("click", closeDrawer);
  $("retryBtn").addEventListener("click", () => updateStatus());

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
}

/* --- RIPPLE ---------------------------------------------------------- */
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn");
  if (!btn || btn.disabled) return;
  const rect = btn.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const ripple = document.createElement("span");
  ripple.className = "ripple";
  ripple.style.width = ripple.style.height = size + "px";
  ripple.style.left = (e.clientX - rect.left - size/2) + "px";
  ripple.style.top  = (e.clientY - rect.top  - size/2) + "px";
  btn.appendChild(ripple);
  setTimeout(() => ripple.remove(), 600);
});

/* --- BOOTSTRAP ------------------------------------------------------- */
function init(){
  setupAuth();
  setupApp();
  tickClock();
  clockId = setInterval(tickClock, 1000);

  const user = currentUser();
  if (user) showApp(user);
  else showAuth();
}

document.addEventListener("DOMContentLoaded", init);
</script>

</body>
</html>`;

/* ---------------------------------------------------------------------
   STATIC
   ------------------------------------------------------------------ */
app.get('/', (req, res) => res.type('html').send(HTML));
app.get('/index.html', (req, res) => res.type('html').send(HTML));

/* ---------------------------------------------------------------------
   BOOT
   ------------------------------------------------------------------ */
setInterval(tick, TICK_MS);

log('System ready · panel rating ' + PANEL_RATED_W + ' W');
log('Water categories: LOW < ' + WATER.lowMax + '% · MEDIUM < ' + WATER.fullMin + '% · FULL ≥ ' + WATER.fullMin + '%');

app.listen(PORT, () => {
  console.log('PROJECT SOLWAT running at http://localhost:' + PORT);
  console.log('  API base   : /api');
  console.log('  SMS device : ' + SMS_DEVICE);
});