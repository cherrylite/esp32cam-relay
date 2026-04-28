/**
 * ESP32-CAM Relay Server
 * 
 * Deploy this on Railway.app or Render.com.
 * 
 * How it works:
 *   1. Local relay script (local-relay.js) connects here via WebSocket and
 *      pushes JPEG frames from the ESP32-CAM.
 *   2. This server buffers the latest frame and serves it as an MJPEG stream
 *      on GET /stream — viewable in any browser or VLC.
 *   3. A built-in web UI is served on GET /.
 * 
 * Environment variables (set in Railway/Render dashboard):
 *   PUSH_SECRET   — secret key the local relay must send to authenticate
 *   PORT          — set automatically by Railway/Render, no need to touch
 */

const express = require('express');
const http    = require('http');
const { WebSocketServer, WebSocket } = require('ws');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const PUSH_SECRET = process.env.PUSH_SECRET || 'changeme';   // CHANGE THIS

// ─── State ───────────────────────────────────────────────────────────────────
let latestFrame    = null;   // Buffer of the latest JPEG frame
let frameTimestamp = 0;
let relayConnected = false;
let fps            = 0;
let frameCount     = 0;

// FPS counter — updated every second
setInterval(() => {
  fps = frameCount;
  frameCount = 0;
}, 1000);

// ─── Express app ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ── Web UI ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const host = req.headers.host;
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32-CAM Live Stream</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', sans-serif;
    background: #080b14;
    color: #e2e8f0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 32px 16px;
  }
  header { text-align: center; margin-bottom: 28px; }
  h1 {
    font-size: 1.75rem; font-weight: 700;
    background: linear-gradient(135deg, #38bdf8, #818cf8);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    margin-bottom: 4px;
  }
  .subtitle { font-size: 0.8rem; color: #64748b; }
  .card {
    width: 100%; max-width: 860px;
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 20px;
    overflow: hidden;
    box-shadow: 0 0 60px rgba(56,189,248,0.08);
  }
  .stream-wrap {
    position: relative;
    background: #020408;
    min-height: 240px;
    display: flex; align-items: center; justify-content: center;
  }
  #stream { width: 100%; display: block; }
  #offline {
    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    color: #334155; font-size: 0.9rem; gap: 12px;
  }
  #offline svg { opacity: 0.3; }
  .footer-bar {
    padding: 14px 20px;
    display: flex; align-items: center; justify-content: space-between;
    flex-wrap: wrap; gap: 8px;
    border-top: 1px solid #1e293b;
  }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 0.73rem; padding: 4px 10px; border-radius: 50px;
    background: #1e293b; color: #94a3b8;
  }
  .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #ef4444;
    transition: background .4s;
  }
  .dot.live { background: #22c55e; animation: pulse 1.5s infinite; }
  @keyframes pulse {
    0%,100% { opacity: 1; } 50% { opacity: 0.4; }
  }
  .url-box {
    margin-top: 20px;
    width: 100%; max-width: 860px;
    background: #0f172a; border: 1px solid #1e293b;
    border-radius: 14px; padding: 16px 20px;
  }
  .url-box h2 { font-size: 0.8rem; color: #64748b; margin-bottom: 10px; }
  .url-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .url-row code {
    flex: 1; font-size: 0.8rem; color: #38bdf8;
    background: #020408; padding: 8px 12px; border-radius: 8px;
    border: 1px solid #1e293b; word-break: break-all;
  }
  button {
    background: linear-gradient(135deg, #38bdf8, #818cf8);
    border: none; color: #fff; padding: 8px 18px; border-radius: 8px;
    font-size: 0.8rem; font-weight: 600; cursor: pointer; white-space: nowrap;
    transition: opacity .2s;
  }
  button:hover { opacity: 0.8; }
</style>
</head>
<body>
<header>
  <h1>&#128247; ESP32-CAM Live</h1>
  <p class="subtitle">AI Thinker · OV3660 · Relay Server</p>
</header>

<div class="card">
  <div class="stream-wrap">
    <div id="offline">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
      </svg>
      Waiting for relay connection…
    </div>
    <img id="stream" src="/stream" alt="Live stream"
         style="display:none"
         onload="onStreamLoad()"
         onerror="onStreamError()" />
  </div>
  <div class="footer-bar">
    <span class="pill"><span class="dot" id="status-dot"></span><span id="status-text">Offline</span></span>
    <span class="pill" id="fps-label">0 fps</span>
    <span class="pill" id="ts-label">--:--:--</span>
  </div>
</div>

<div class="url-box">
  <h2>STREAM URL — paste in VLC, OpenCV, or your app</h2>
  <div class="url-row">
    <code id="stream-url">https://${host}/stream</code>
    <button onclick="copyUrl()">Copy</button>
  </div>
</div>

<script>
  const img = document.getElementById('stream');
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');

  function onStreamLoad() {
    document.getElementById('offline').style.display = 'none';
    img.style.display = 'block';
    dot.classList.add('live');
    txt.textContent = 'Live';
  }

  function onStreamError() {
    img.style.display = 'none';
    document.getElementById('offline').style.display = 'flex';
    dot.classList.remove('live');
    txt.textContent = 'Offline';
    setTimeout(() => { img.src = '/stream?t=' + Date.now(); }, 3000);
  }

  // Poll /status for FPS and timestamp
  async function pollStatus() {
    try {
      const r = await fetch('/status');
      const d = await r.json();
      document.getElementById('fps-label').textContent = d.fps + ' fps';
      document.getElementById('ts-label').textContent =
        d.relayConnected ? new Date().toLocaleTimeString() : '--:--:--';
      if (d.relayConnected && img.style.display === 'none') {
        img.src = '/stream?t=' + Date.now();
      }
    } catch {}
  }
  setInterval(pollStatus, 1500);
  pollStatus();

  function copyUrl() {
    navigator.clipboard.writeText(document.getElementById('stream-url').textContent);
  }
</script>
</body>
</html>`);
});

// ── Status JSON ───────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({ relayConnected, fps, frameTimestamp });
});

// ── MJPEG stream ──────────────────────────────────────────────────────────────
const BOUNDARY = 'mjpegboundary';

app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type':                `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control':               'no-cache, no-store, must-revalidate',
    'Pragma':                      'no-cache',
    'Connection':                  'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options':      'nosniff',
  });

  // Send the latest frame immediately so the browser doesn't show a blank img
  if (latestFrame) sendFrame(res);

  // Register this client
  streamClients.add(res);
  console.log(`[STREAM] Client connected — total: ${streamClients.size}`);

  req.on('close', () => {
    streamClients.delete(res);
    console.log(`[STREAM] Client disconnected — total: ${streamClients.size}`);
  });
});

function sendFrame(res) {
  if (!latestFrame) return;
  try {
    res.write(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame.length}\r\n\r\n`
    );
    res.write(latestFrame);
    res.write('\r\n');
  } catch { /* client disconnected */ }
}

const streamClients = new Set();

// ─── WebSocket server — push endpoint for local relay ────────────────────────
const wss = new WebSocketServer({ server, path: '/push' });

wss.on('connection', (ws, req) => {
  let authenticated = false;
  console.log('[WS] Relay connected from', req.socket.remoteAddress);

  ws.on('message', (data, isBinary) => {
    // First message must be the auth token (text)
    if (!authenticated) {
      const token = data.toString().trim();
      if (token === PUSH_SECRET) {
        authenticated = true;
        relayConnected = true;
        ws.send('OK');
        console.log('[WS] Relay authenticated ✓');
      } else {
        console.warn('[WS] Bad secret — closing');
        ws.close(4001, 'Unauthorized');
      }
      return;
    }

    // Subsequent binary messages are JPEG frames
    if (!isBinary) return;
    latestFrame    = data;
    frameTimestamp = Date.now();
    frameCount++;

    // Broadcast to all stream clients
    for (const res of streamClients) sendFrame(res);
  });

  ws.on('close', () => {
    relayConnected = false;
    console.log('[WS] Relay disconnected');
  });

  ws.on('error', (err) => console.error('[WS] Error:', err.message));

  // Ping/pong keepalive so Railway/Render don't kill the idle WebSocket
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25000);
  ws.on('close', () => clearInterval(ping));
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`);
  console.log(`[SERVER] PUSH_SECRET is "${PUSH_SECRET === 'changeme' ? 'changeme (PLEASE CHANGE!)' : '***'}"`);
});
