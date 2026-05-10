# SPEC-02 — Node.js WebSocket Server (server.js skeleton)

## Purpose

server.js is the backend of the app. It owns all state, all process spawning, all file I/O, and all communication with external APIs. The UI (mockup.html) is a thin WebSocket client that only renders what the server tells it to.

---

## Responsibilities

- Serve `mockup.html` over HTTP (GET /)
- Maintain a `sessions` Map as the single source of truth
- Accept WebSocket connections from the UI
- Route all incoming messages through `handleMessage()`
- Broadcast events to all connected clients via `broadcast()`
- Send targeted responses to one client via `sendTo()`
- Persist state to disk so restarts are transparent to the user

---

## Server Skeleton

```js
'use strict';

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const WebSocket = require('ws');
const crypto    = require('crypto');
const https     = require('https');
const { spawn, exec, execSync } = require('child_process');

// ── Paths (injected by main.js via env vars) ──────────────────────────────────
const APPDATA     = process.env.APPDATA || os.homedir();
const POLARIS_DIR = process.env.POLARIS_DIR || path.join(APPDATA, '.claude', 'polaris');
const MOCKUP_DEST = process.env.MOCKUP_DEST || path.join(POLARIS_DIR, 'mockup.html');
const PORT        = Number(process.env.SERVER_PORT) || 40000;

// ── State ─────────────────────────────────────────────────────────────────────
const sessions = new Map();  // sessionId → session object
let   wss      = null;

// ── HTTP Server ───────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    fs.readFile(MOCKUP_DEST, 'utf8', (err, data) => {
      if (err) { res.writeHead(500); res.end('Could not load UI'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
    return;
  }
  res.writeHead(404); res.end('Not found');
});

// ── Boot ──────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] Listening on http://127.0.0.1:${PORT}`);
});

wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', ws => {
  // Send full state to newly connected client
  sendTo(ws, {
    type: 'init',
    sessions: Array.from(sessions.values()).map(serializeSession),
    config:   maskedConfig(readConfig()),
    history:  readJSON(HISTORY_PATH, []),
  });

  ws.on('message', raw => handleMessage(ws, raw));
  ws.on('close', () => console.log('[server] Client disconnected'));
  ws.on('error', err => console.error('[server] WS error:', err));
});
```

---

## Core Helpers

```js
// Send to all connected clients
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// Send to one specific client
function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// Safe JSON read with fallback
function readJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

// Atomic JSON write
function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}
```

---

## Message Handler Pattern

All client→server communication goes through one function. Use chained `if` blocks (not switch) for clarity and because each branch often has early returns or async work:

```js
function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const { type } = msg;

  if (type === 'ping') {
    sendTo(ws, { type: 'pong' });
    return;
  }

  if (type === 'launch') {
    // ... create session, spawn Claude
    return;
  }

  if (type === 'stop') {
    // ... kill process
    return;
  }

  if (type === 'save-config') {
    // ... write to config.json
    return;
  }

  if (type === 'get-config') {
    sendTo(ws, { type: 'config', config: maskedConfig(readConfig()) });
    return;
  }

  // ... all other message types
}
```

**Rule:** Every branch ends with `return`. No fall-through.

---

## Standard WebSocket Message Types

### Client → Server

| Type | Payload | Purpose |
|------|---------|---------|
| `launch` | `{ prompt, workDir, projectName, model }` | Start new agent session |
| `launch-chat` | `{ prompt }` | Start chat session |
| `resume` | `{ sessionId, prompt, resumeId, model }` | Continue agent session |
| `stop` | `{ sessionId }` | Kill process |
| `close-session` | `{ sessionId }` | Kill + remove |
| `save-config` | `{ config: {...} }` | Write to config.json |
| `get-config` | — | Returns masked config |
| `get-history` | — | Returns prompt history |
| `session-height` | `{ sessionId, height }` | Persist card height |
| `session-column` | `{ sessionId, column }` | Persist card column |
| `reload-ui` | — | Broadcast reload to all clients |
| `restart` | — | Server calls process.exit(0) |
| `ping` | — | Keepalive |

### Server → Client

| Type | Payload | Purpose |
|------|---------|---------|
| `init` | `{ sessions, config, history }` | Full state on connect |
| `session-created` | `{ sessionId, name, workDir, ... }` | New session started |
| `line` | `{ sessionId, text, role }` | Terminal output |
| `session-status` | `{ sessionId, status }` | running / done / error |
| `context-usage` | `{ sessionId, usage, claudeSessionId }` | Token counts |
| `session-closed` | `{ sessionId }` | Session removed |
| `reload` | — | All clients reload |

---

## broadcast() with Side Effects

`broadcast()` is also the right place to update in-memory session state before sending to clients, because every relevant event flows through it:

```js
function broadcast(data) {
  // Update in-memory state for persistence
  if (data.type === 'line' && data.sessionId) {
    const s = sessions.get(data.sessionId);
    if (s) {
      s.lines.push({ text: data.text, role: data.role });
      if (data.role === 'user') s.lastPrompt = data.text;
      if (data.role === 'assistant') saveSessions();
    }
  }
  if (data.type === 'session-status' && data.sessionId) {
    const s = sessions.get(data.sessionId);
    if (s) {
      s.status = data.status;
      if (data.status === 'done' || data.status === 'error') {
        s.endAt = s.endAt || Date.now();
        saveSessions();
      }
    }
  }

  // Broadcast to all connected clients
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}
```

---

## IPC Bridge (receives from main.js)

```js
const pendingDirPicks = new Map();  // requestId → ws

if (typeof process.on === 'function') {
  process.on('message', msg => {
    if (!msg || !msg.type) return;
    if (msg.type === 'directory-picked') {
      const ws = pendingDirPicks.get(msg.requestId);
      pendingDirPicks.delete(msg.requestId);
      if (ws) sendTo(ws, { type: 'directory-picked', path: msg.path || null });
    }
  });
}

// In handleMessage, when pick-directory is received from UI:
if (type === 'pick-directory') {
  if (typeof process.send !== 'function') {
    sendTo(ws, { type: 'error', text: 'Folder picker only available inside Electron.' });
    return;
  }
  const requestId = crypto.randomBytes(8).toString('hex');
  pendingDirPicks.set(requestId, ws);
  process.send({ type: 'pick-directory', requestId, defaultPath: msg.defaultPath || null });
  return;
}
```

---

## Git Helper

```js
function runGit(args, cwd) {
  return new Promise(resolve => {
    exec(`git ${args.map(a => `"${a}"`).join(' ')}`, { cwd }, (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}
```

Used for Code Health (churn/contributors) and Connections (branch/dirty/ahead/behind). Returns empty string on error — callers handle missing git gracefully.

---

## Session Name Generation

Auto-generate a human-readable name from the prompt by stripping stop words:

```js
const STOP_WORDS = new Set(['a','an','the','and','or','but','in','on','at','to','for','of','with','by','from','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','may','might','just','also','then','than','as','if','that','this','it','its','i','you','he','she','we','they']);

function generateSessionName(prompt) {
  const words = prompt
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()));
  return words.slice(0, 7).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'New Session';
}
```
