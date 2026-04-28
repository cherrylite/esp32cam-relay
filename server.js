/**
 * ESP32-CAM Relay Server — HTTP POST frame intake
 * 
 * ESP32-CAM POSTs JPEG frames to POST /frame (with Bearer token auth).
 * Server buffers latest frame and serves MJPEG stream to browsers.
 */

const express = require('express');
const http    = require('http');

const PORT        = process.env.PORT || 3000;
const PUSH_SECRET = process.env.PUSH_SECRET || 'changeme';

// ─── State ───────────────────────────────────────────────────────────────────
let latestFrame    = null;
let frameTimestamp = 0;
let camOnline      = false;
let fps            = 0;
let frameCount     = 0;
let lastFrameAt    = 0;

setInterval(() => {
  fps = frameCount;
  frameCount = 0;
  // Mark camera offline if no frame in 10s
  camOnline = (Date.now() - lastFrameAt) < 10000;
}, 1000);

// ─── Express ─────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// Parse raw binary bodies up to 1MB (for JPEG frames)
app.use('/frame', express.raw({ type: '*/*', limit: '1mb' }));

// ── POST /frame — ESP32-CAM pushes frames here ────────────────────────────
app.post('/frame', (req, res) => {
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${PUSH_SECRET}`) {
    return res.status(401).send('Unauthorized');
  }

  if (!req.body || req.body.length === 0) {
    return res.status(400).send('Empty frame');
  }

  latestFrame    = req.body;
  frameTimestamp = Date.now();
  lastFrameAt    = Date.now();
  camOnline      = true;
  frameCount++;

  // Push to all active MJPEG stream clients immediately
  for (const client of streamClients) sendFrame(client);

  res.status(200).send('OK');
});

// ── GET /status ───────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({ camOnline, fps, frameTimestamp });
});

// ── GET / — Web UI ────────────────────────────────────────────────────────
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
    background: #080b14; color: #e2e8f0;
    min-height: 100vh; display: flex; flex-direction: column;
    align-items: center; padding: 32px 16px;
  }
  h1 {
    font-size: 1.75rem; font-weight: 700; margin-bottom: 4px;
    background: linear-gradient(135deg, #38bdf8, #818cf8);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .subtitle { font-size: 0.8rem; color: #64748b; margin-bottom: 24px; }
  .card {
    width: 100%; max-width: 860px; background: #0f172a;
    border: 1px solid #1e293b; border-radius: 20px; overflow: hidden;
    box-shadow: 0 0 60px rgba(56,189,248,0.08);
  }
  .stream-wrap {
    position: relative; background: #020408;
    min-height: 240px; display: flex; align-items: center; justify-content: center;
  }
  #stream { width: 100%; display: block; }
  #offline {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    color: #334155; font-size: 0.9rem; gap: 12px;
  }
  .footer-bar {
    padding: 14px 20px; display: flex; align-items: center;
    justify-content: space-between; flex-wrap: wrap; gap: 8px;
    border-top: 1px solid #1e293b;
  }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 0.73rem; padding: 4px 10px; border-radius: 50px;
    background: #1e293b; color: #94a3b8;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #ef4444; transition: background .4s; }
  .dot.live { background: #22c55e; animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%,100%{opacity:1}50%{opacity:.4} }
  .url-box {
    margin-top: 20px; width: 100%; max-width: 860px;
    background: #0f172a; border: 1px solid #1e293b;
    border-radius: 14px; padding: 16px 20px;
  }
  .url-box h2 { font-size: 0.8rem; color: #64748b; margin-bottom: 10px; }
  .url-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .url-row code {
    flex: 1; font-size: 0.8rem; color: #38bdf8; background: #020408;
    padding: 8px 12px; border-radius: 8px; border: 1px solid #1e293b; word-break: break-all;
  }
  button {
    background: linear-gradient(135deg, #38bdf8, #818cf8);
    border: none; color: #fff; padding: 8px 18px; border-radius: 8px;
    font-size: 0.8rem; font-weight: 600; cursor: pointer; white-space: nowrap; transition: opacity .2s;
  }
  button:hover { opacity:.8; }
</style>
</head>
<body>
<h1>&#128247; ESP32-CAM Live</h1>
<p class="subtitle">AI Thinker · OV3660 · Re-Hatch Incubator</p>
<div class="card">
  <div class="stream-wrap">
    <div id="offline">
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".3">
        <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
      </svg>
      Waiting for camera…
    </div>
    <img id="stream" src="/stream" alt="Live stream" style="display:none"
         onload="onLoad()" onerror="onErr()" />
  </div>
  <div class="footer-bar">
    <span class="pill"><span class="dot" id="dot"></span><span id="status">Offline</span></span>
    <span class="pill" id="fps">0 fps</span>
    <span class="pill" id="ts">--:--:--</span>
  </div>
</div>
<div class="url-box">
  <h2>STREAM URL — use in VLC · OpenCV · your app</h2>
  <div class="url-row">
    <code>https://${host}/stream</code>
    <button onclick="navigator.clipboard.writeText('https://${host}/stream')">Copy</button>
  </div>
</div>
<script>
  const img = document.getElementById('stream');
  function onLoad() {
    document.getElementById('offline').style.display='none';
    img.style.display='block';
    document.getElementById('dot').classList.add('live');
    document.getElementById('status').textContent='Live';
  }
  function onErr() {
    img.style.display='none';
    document.getElementById('offline').style.display='flex';
    document.getElementById('dot').classList.remove('live');
    document.getElementById('status').textContent='Offline';
    setTimeout(()=>{ img.src='/stream?t='+Date.now(); }, 3000);
  }
  async function poll() {
    try {
      const d = await (await fetch('/status')).json();
      document.getElementById('fps').textContent = d.fps+' fps';
      document.getElementById('ts').textContent  = d.camOnline ? new Date().toLocaleTimeString() : '--:--:--';
      if (d.camOnline && img.style.display==='none') img.src='/stream?t='+Date.now();
    } catch {}
  }
  setInterval(poll, 1500);
  poll();
</script>
</body>
</html>`);
});

// ── GET /stream — MJPEG stream to browsers ────────────────────────────────
const BOUNDARY = 'mjpegboundary';

const streamClients = new Set();

function sendFrame(res) {
  if (!latestFrame) return;
  try {
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame.length}\r\n\r\n`);
    res.write(latestFrame);
    res.write('\r\n');
  } catch { /* client gone */ }
}

app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type':                `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control':               'no-cache, no-store',
    'Connection':                  'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  if (latestFrame) sendFrame(res);

  streamClients.add(res);
  console.log(`[STREAM] +client (total: ${streamClients.size})`);

  req.on('close', () => {
    streamClients.delete(res);
    console.log(`[STREAM] -client (total: ${streamClients.size})`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`);
  console.log(`[SERVER] ESP32 should POST frames to /frame with "Authorization: Bearer ${PUSH_SECRET}"`);
});
