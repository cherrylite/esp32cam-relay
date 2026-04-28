/**
 * ESP32-CAM Local Relay
 * 
 * Run this on any PC on the same WiFi as your ESP32-CAM.
 * It pulls JPEG frames from the cam and pushes them to the
 * relay server on Railway/Render via WebSocket.
 * 
 * Requirements: Node.js 18+
 *   npm install ws node-fetch   (or: npm install — see package.json)
 * 
 * Usage:
 *   node local-relay.js
 * 
 * Or with env overrides:
 *   CAM_URL=http://192.168.1.50:81/stream SERVER_URL=wss://your-app.railway.app/push SECRET=mysecret node local-relay.js
 */

const { WebSocket } = require('ws');

// ─── Configuration ─────────────────────────────────────────────────────────
const CAM_URL    = process.env.CAM_URL    || 'http://192.168.1.105:81/stream';  // ← your ESP32-CAM IP
const SERVER_URL = process.env.SERVER_URL || 'wss://YOUR-APP.railway.app/push'; // ← your Railway/Render URL
const SECRET     = process.env.SECRET     || 'changeme';                         // ← must match server PUSH_SECRET
// ───────────────────────────────────────────────────────────────────────────

// HTTP client for fetching MJPEG stream
const http  = require('http');
const https = require('https');

let ws = null;
let reconnectTimer = null;
let camReq = null;

// ─── Parse MJPEG stream and extract individual JPEG frames ─────────────────
function readMjpegStream(url, onFrame) {
  const client = url.startsWith('https') ? https : http;

  camReq = client.get(url, (res) => {
    if (res.statusCode !== 200) {
      console.error(`[CAM] HTTP ${res.statusCode} — is the ESP32-CAM online?`);
      res.destroy();
      return;
    }

    console.log('[CAM] Connected to MJPEG stream ✓');

    const contentType = res.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1] : '123456789000000000000987654321';
    const boundaryBuf = Buffer.from('--' + boundary);

    let buffer = Buffer.alloc(0);

    res.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Scan for complete JPEG frames delimited by MJPEG boundary
      let start = -1;
      while (true) {
        const boundaryPos = buffer.indexOf(boundaryBuf);
        if (boundaryPos === -1) break;

        if (start !== -1) {
          // Extract the content between two boundaries
          const part = buffer.slice(start, boundaryPos);
          const jpegStart = part.indexOf(Buffer.from([0xFF, 0xD8]));
          const jpegEnd   = part.lastIndexOf(Buffer.from([0xFF, 0xD9]));
          if (jpegStart !== -1 && jpegEnd !== -1) {
            const frame = part.slice(jpegStart, jpegEnd + 2);
            onFrame(frame);
          }
        }

        buffer = buffer.slice(boundaryPos + boundaryBuf.length);
        start = 0;
      }
    });

    res.on('error', (err) => {
      console.error('[CAM] Stream error:', err.message);
    });

    res.on('close', () => {
      console.warn('[CAM] Stream closed — will retry in 5s');
      setTimeout(() => connectCam(), 5000);
    });
  });

  camReq.on('error', (err) => {
    console.error('[CAM] Connection error:', err.message, '— retrying in 5s');
    setTimeout(() => connectCam(), 5000);
  });
}

// ─── WebSocket connection to relay server ──────────────────────────────────
function connectServer() {
  if (ws) { try { ws.terminate(); } catch {} }

  console.log(`[SERVER] Connecting to ${SERVER_URL} ...`);
  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    console.log('[SERVER] WebSocket open — authenticating...');
    ws.send(SECRET);
  });

  ws.on('message', (msg) => {
    const text = msg.toString();
    if (text === 'OK') {
      console.log('[SERVER] Authenticated ✓  — starting camera stream');
      connectCam();
    } else {
      console.log('[SERVER]', text);
    }
  });

  ws.on('close', (code, reason) => {
    console.warn(`[SERVER] Disconnected (${code}) — reconnecting in 5s`);
    if (camReq) { camReq.destroy(); camReq = null; }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectServer, 5000);
  });

  ws.on('error', (err) => {
    console.error('[SERVER] WS error:', err.message);
  });

  ws.on('pong', () => { /* keepalive response from server */ });
}

// ─── Start camera stream and pipe frames to server ─────────────────────────
function connectCam() {
  readMjpegStream(CAM_URL, (frame) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(frame, { binary: true });
    }
  });
}

// ─── Entry point ────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════');
console.log('  ESP32-CAM Local Relay');
console.log(`  Camera : ${CAM_URL}`);
console.log(`  Server : ${SERVER_URL}`);
console.log('═══════════════════════════════════════');
connectServer();
