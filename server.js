/**
 * ESP32-CAM Relay Server — MQTT frame intake
 * 
 * ESP32-CAM publishes JPEG frames to HiveMQ public broker (plain TCP, no TLS).
 * This server subscribes and serves MJPEG to browsers.
 * 
 * Topic: rehatch/cam/<PUSH_SECRET>/frame
 */

const express = require('express');
const http    = require('http');
const mqtt    = require('mqtt');

const PORT        = process.env.PORT || 3000;
const PUSH_SECRET = process.env.PUSH_SECRET || 'changeme';
const MQTT_TOPIC  = `rehatch/cam/${PUSH_SECRET}/frame`;
const MQTT_BROKER = 'mqtt://broker.hivemq.com:1883';

// ─── State ───────────────────────────────────────────────────────────────────
let latestFrame  = null;
let camOnline    = false;
let fps = 0, frameCount = 0, lastFrameAt = 0;

setInterval(() => {
  fps = frameCount; frameCount = 0;
  camOnline = (Date.now() - lastFrameAt) < 10000;
}, 1000);

// ─── MQTT ────────────────────────────────────────────────────────────────────
const mqttClient = mqtt.connect(MQTT_BROKER, {
  clientId: `relay-server-${Math.random().toString(16).slice(2)}`,
  clean: true,
  reconnectPeriod: 5000,
});

mqttClient.on('connect', () => {
  console.log('[MQTT] Connected to broker.hivemq.com');
  mqttClient.subscribe(MQTT_TOPIC, (err) => {
    if (err) console.error('[MQTT] Subscribe error:', err.message);
    else console.log(`[MQTT] Subscribed to: ${MQTT_TOPIC}`);
  });
});

mqttClient.on('message', (topic, payload) => {
  latestFrame = payload;
  lastFrameAt = Date.now();
  camOnline   = true;
  frameCount++;
  for (const res of streamClients) sendFrame(res);
});

mqttClient.on('error', (err) => console.error('[MQTT] Error:', err.message));
mqttClient.on('reconnect', () => console.log('[MQTT] Reconnecting...'));

// ─── Express ─────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.get('/status', (req, res) => res.json({ camOnline, fps }));

// ── MJPEG stream ─────────────────────────────────────────────────────────────
const BOUNDARY    = 'mjpegboundary';
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
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  if (latestFrame) sendFrame(res);
  streamClients.add(res);
  console.log(`[STREAM] +client (total: ${streamClients.size})`);
  req.on('close', () => { streamClients.delete(res); });
});

// ── Web UI ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const host = req.headers.host;
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32-CAM Live</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;background:#080b14;color:#e2e8f0;min-height:100vh;
    display:flex;flex-direction:column;align-items:center;padding:32px 16px}
  h1{font-size:1.75rem;font-weight:700;margin-bottom:4px;
    background:linear-gradient(135deg,#38bdf8,#818cf8);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .sub{font-size:.8rem;color:#64748b;margin-bottom:24px}
  .card{width:100%;max-width:860px;background:#0f172a;border:1px solid #1e293b;
    border-radius:20px;overflow:hidden;box-shadow:0 0 60px rgba(56,189,248,.08)}
  .wrap{position:relative;background:#020408;min-height:240px;display:flex;
    align-items:center;justify-content:center}
  #stream{width:100%;display:block}
  #off{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
    justify-content:center;color:#334155;font-size:.9rem;gap:12px}
  .bar{padding:14px 20px;display:flex;align-items:center;justify-content:space-between;
    flex-wrap:wrap;gap:8px;border-top:1px solid #1e293b}
  .pill{display:inline-flex;align-items:center;gap:6px;font-size:.73rem;
    padding:4px 10px;border-radius:50px;background:#1e293b;color:#94a3b8}
  .dot{width:7px;height:7px;border-radius:50%;background:#ef4444;transition:background .4s}
  .dot.live{background:#22c55e;animation:p 1.5s infinite}
  @keyframes p{0%,100%{opacity:1}50%{opacity:.4}}
  .url-box{margin-top:20px;width:100%;max-width:860px;background:#0f172a;
    border:1px solid #1e293b;border-radius:14px;padding:16px 20px}
  .url-box h2{font-size:.8rem;color:#64748b;margin-bottom:10px}
  .url-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  code{flex:1;font-size:.8rem;color:#38bdf8;background:#020408;padding:8px 12px;
    border-radius:8px;border:1px solid #1e293b;word-break:break-all}
  button{background:linear-gradient(135deg,#38bdf8,#818cf8);border:none;color:#fff;
    padding:8px 18px;border-radius:8px;font-size:.8rem;font-weight:600;cursor:pointer;
    white-space:nowrap;transition:opacity .2s}
  button:hover{opacity:.8}
</style></head><body>
<h1>&#128247; ESP32-CAM Live</h1>
<p class="sub">AI Thinker · OV3660 · Re-Hatch Incubator</p>
<div class="card">
  <div class="wrap">
    <div id="off">
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.5" opacity=".3">
        <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
      </svg>Waiting for camera…
    </div>
    <img id="stream" src="/stream" alt="Live stream" style="display:none"
         onload="onL()" onerror="onE()"/>
  </div>
  <div class="bar">
    <span class="pill"><span class="dot" id="dot"></span><span id="st">Offline</span></span>
    <span class="pill" id="fps">0 fps</span>
    <span class="pill" id="ts">--:--:--</span>
  </div>
</div>
<div class="url-box">
  <h2>STREAM URL — VLC · OpenCV · your app</h2>
  <div class="url-row">
    <code>https://${host}/stream</code>
    <button onclick="navigator.clipboard.writeText('https://${host}/stream')">Copy</button>
  </div>
</div>
<script>
  const img=document.getElementById('stream');
  function onL(){document.getElementById('off').style.display='none';
    img.style.display='block';document.getElementById('dot').classList.add('live');
    document.getElementById('st').textContent='Live';}
  function onE(){img.style.display='none';document.getElementById('off').style.display='flex';
    document.getElementById('dot').classList.remove('live');
    document.getElementById('st').textContent='Offline';
    setTimeout(()=>{img.src='/stream?t='+Date.now();},3000);}
  async function poll(){try{
    const d=await(await fetch('/status')).json();
    document.getElementById('fps').textContent=d.fps+' fps';
    document.getElementById('ts').textContent=d.camOnline?new Date().toLocaleTimeString():'--:--:--';
    if(d.camOnline&&img.style.display==='none')img.src='/stream?t='+Date.now();
  }catch{}}
  setInterval(poll,1500);poll();
</script></body></html>`);
});

server.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`);
  console.log(`[SERVER] MQTT topic: ${MQTT_TOPIC}`);
});
