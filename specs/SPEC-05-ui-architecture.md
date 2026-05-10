# SPEC-05 — UI Architecture (mockup.html)

## Purpose

The entire UI is a single HTML file with no build step, no framework, no external dependencies. It is served from AppData, connects to the server via WebSocket, and renders everything from server events.

---

## Why Single File

- Zero build pipeline — edit and reload to see changes
- Ships as a packaged resource, overwritten from source on every app launch
- No module bundler means no dependency tree, no stale node_modules, no version conflicts
- All state is in closure variables inside one IIFE — no module system needed at this scale

---

## File Structure

```
<!DOCTYPE html>
<html>
<head>
  <style>
    /* All CSS — palette vars, layout, component styles */
  </style>
</head>
<body>
  <!-- All HTML — header, launch bar, session grid, panels, modals -->

  <script>
  (function() {
    'use strict';

    // ── Constants ──────────────────────────────────────────────────────────────
    const WS_URL = 'ws://localhost:40000';

    // ── State ──────────────────────────────────────────────────────────────────
    let ws = null;
    const sessionsStore  = {};   // sessionId → { id, name, status, lines[], ... }
    let   configStore    = {};   // last config from server
    let   historyStore   = [];   // prompt history
    let   sessionOrder   = [];   // controls render order of cards
    let   locksStore     = {};   // filePath → { sessions: [] }
    let   versionsStore  = {};   // filePath → currentVersion
    const sessionFilesMap = {};  // sessionId → { filePath → { version, changes[] } }

    // ── WebSocket ──────────────────────────────────────────────────────────────
    // ... (see WebSocket Client section)

    // ── Render ─────────────────────────────────────────────────────────────────
    // ... (see Card Rendering section)

    // ── Event Handlers ─────────────────────────────────────────────────────────
    // ... (button wiring, etc.)

    // ── Exported to window (for inline onclick handlers in HTML) ───────────────
    window.switchPalette     = switchPalette;
    window.toggleDebugPanel  = toggleDebugPanel;
    window.launchSession     = launchSession;
    // etc.

  })();
  </script>
</body>
</html>
```

**IIFE is mandatory.** All variables are closure-scoped. Any function referenced from inline `onclick` handlers must be explicitly exported to `window.*`.

---

## Palette System

Five color themes implemented via CSS custom properties. All component styles reference variables; palette classes set the values.

```css
/* Palette variable definitions */
.p1 {
  --bg: #0a0e1a; --card-bg: #111827; --header-bg: #0d1117; --launch-bg: #0f1520;
  --text: #e2e8f0; --text-muted: #64748b; --border: #1e293b; --input-bg: #1e293b;
  --tag-bg: #1e3a5f; --tag-text: #60a5fa; --terminal-bg: #060d18;
  --footer-bg: #0d1528; --fbtn-bg: #1e293b; --fbtn-text: #94a3b8;
  --card-btn-bg: #1e293b; --debug-bg: #060d18;
}
/* .p2 through .p5 follow the same variable names with different values */

/* Components use variables — never hardcode colors in component rules */
.palette { background: var(--bg); color: var(--text); }
.palette .card { background: var(--card-bg); }
.palette .terminal { background: var(--terminal-bg); }
```

```js
let currentPalette = 1;

function switchPalette(n) {
  const app = document.getElementById('app-p1');
  app.className = `palette p${n} app`;
  currentPalette = n;
  // Save to config
  send({ type: 'save-config', config: { palette: n } });
}
```

On `init`, restore saved palette: `if (cfg.palette) switchPalette(cfg.palette);`

---

## WebSocket Client

```js
function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    pushDebugLog('[ws] connected');
    updateConnDot(true);
    clearInterval(reconnectTimer);
    send({ type: 'ping' });
  };

  ws.onmessage = e => {
    try { handleServerMessage(JSON.parse(e.data)); }
    catch (err) { pushDebugLog(`[ws] parse error: ${err.message}`, true); }
  };

  ws.onerror = () => pushDebugLog('[ws] connection error', true);

  ws.onclose = () => {
    updateConnDot(false);
    pushDebugLog('[ws] disconnected — reconnecting in 2s', true);
    reconnectTimer = setInterval(() => {
      if (ws.readyState === WebSocket.CLOSED) connect();
    }, 2000);
  };
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

connect();  // initiate connection on page load
```

---

## Server Message Handler

```js
function handleServerMessage(msg) {
  if (msg.type === 'init') {
    configStore   = msg.config  || {};
    historyStore  = msg.history || [];
    sessionOrder  = [];

    applyConfig(configStore);

    for (const s of (msg.sessions || [])) {
      sessionsStore[s.id] = s;
      sessionOrder.push(s.id);
    }
    renderGrid();

    // Restore locks and versions
    send({ type: 'get-locks' });
    send({ type: 'get-versions' });
    return;
  }

  if (msg.type === 'session-created') {
    sessionsStore[msg.sessionId] = {
      id: msg.sessionId, name: msg.name, workDir: msg.workDir,
      projectName: msg.projectName, model: msg.model, isChat: msg.isChat || false,
      status: 'running', startAt: Date.now(), lines: [],
      height: msg.height || null, column: msg.column != null ? msg.column : null,
    };
    if (!sessionOrder.includes(msg.sessionId)) sessionOrder.push(msg.sessionId);
    renderGrid();
    return;
  }

  if (msg.type === 'line') {
    const s = sessionsStore[msg.sessionId];
    if (!s) return;
    s.lines.push({ role: msg.role, text: msg.text });

    // Append to terminal element
    const terminal = document.querySelector(`[data-terminal="${msg.sessionId}"]`);
    if (terminal) {
      appendLine(terminal, msg.text, msg.role);
      terminal.scrollTop = terminal.scrollHeight;
    }
    pushDebugLog(`[${msg.role}] ${msg.text.slice(0, 80)}`);
    return;
  }

  if (msg.type === 'session-status') {
    const s = sessionsStore[msg.sessionId];
    if (s) s.status = msg.status;
    updateCardStatus(msg.sessionId, msg.status);
    return;
  }

  if (msg.type === 'context-usage') {
    updateContextBar(msg.sessionId, msg.usage);
    if (msg.claudeSessionId) {
      const s = sessionsStore[msg.sessionId];
      if (s) s.claudeSessionId = msg.claudeSessionId;
    }
    return;
  }

  if (msg.type === 'session-closed') {
    delete sessionsStore[msg.sessionId];
    sessionOrder = sessionOrder.filter(id => id !== msg.sessionId);
    renderGrid();
    return;
  }

  if (msg.type === 'reload') {
    window.location.reload();
    return;
  }

  if (msg.type === 'config') {
    configStore = msg.config;
    applyConfig(configStore);
    return;
  }

  if (msg.type === 'locks') {
    locksStore = msg.locks || {};
    refreshAllCardLocks();
    return;
  }

  if (msg.type === 'versions') {
    versionsStore = msg.versions || {};
    return;
  }

  if (msg.type === 'file-version') {
    versionsStore[msg.file] = msg.next;
    if (!sessionFilesMap[msg.sessionId]) sessionFilesMap[msg.sessionId] = {};
    const sf = sessionFilesMap[msg.sessionId];
    if (!sf[msg.file]) sf[msg.file] = { version: msg.next, changes: [] };
    sf[msg.file].changes.push({ prev: msg.prev, next: msg.next, ts: Date.now() });
    sf[msg.file].version = msg.next;
    pushDebugLog(`[file] ${msg.file} v${msg.prev}→v${msg.next}`);
    return;
  }
}
```

---

## Terminal Line Rendering

```js
function appendLine(terminal, text, role) {
  const div = document.createElement('div');
  div.className = role === 'error' ? 't-warn' : role === 'user' ? 't-user' : 't-normal';
  div.textContent = text;
  terminal.appendChild(div);

  // Purge old lines if over 1000 — prevents DOM bloat in long-running sessions
  while (terminal.children.length > 1000) terminal.removeChild(terminal.firstChild);
}
```

---

## applyConfig Pattern

```js
function applyConfig(cfg) {
  // Restore launch bar fields
  document.getElementById('work-dir-input').value  = cfg.lastWorkDir  || '';
  document.getElementById('repo-input').value      = cfg.lastRepo     || '';

  // Restore datalists
  populateDatalist('work-dir-list', cfg.savedWorkDirs || []);
  populateDatalist('repo-list',     cfg.savedRepos    || []);

  // Restore projects
  projectsList = cfg.projects || [];
  refreshProjectDropdowns();
  refreshFieldTags();

  // Restore palette
  if (cfg.palette) switchPalette(cfg.palette);

  // Restore protected patterns
  protectedPatterns = cfg.protectedPatterns || ['*.md'];
}
```

---

## Debug Log

```js
function pushDebugLog(text, isError = false) {
  const now = new Date();
  const ts  = `[${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}]`;
  const entry = `${ts} ${text}`;

  debugLog.unshift({ text: entry, isError });
  if (debugLog.length > 100) debugLog.pop();

  // Update all debug panels (one per palette)
  for (const panel of document.querySelectorAll('.debug-panel-inner')) {
    const div = document.createElement('div');
    div.className = 'debug-entry' + (isError ? ' de-error' : '');
    div.textContent = entry;
    panel.prepend(div);
    while (panel.children.length > 100) panel.removeChild(panel.lastChild);
  }
}

function toggleDebugPanel(bar) {
  const panel = bar.nextElementSibling;
  const isOpen = panel.classList.toggle('open');
  bar.querySelector('.debug-chevron').textContent = isOpen ? '▲ collapse' : '▼ expand';
}
window.toggleDebugPanel = toggleDebugPanel;
```

---

## Session Search / Filter

```js
let searchQuery = '';

function filterCards(query) {
  searchQuery = query.toLowerCase();
  for (const id of sessionOrder) {
    const card = document.querySelector(`[data-sid="${id}"]`);
    if (!card) continue;
    const s = sessionsStore[id];
    const match = !searchQuery
      || (s.name || '').toLowerCase().includes(searchQuery)
      || (s.projectName || '').toLowerCase().includes(searchQuery);
    card.style.display = match ? '' : 'none';
  }
}
```

---

## Prompt History (↑/↓ navigation)

```js
let historyIndex = -1;

promptArea.addEventListener('keydown', e => {
  if (e.key === 'ArrowUp' && historyStore.length) {
    e.preventDefault();
    historyIndex = Math.min(historyIndex + 1, historyStore.length - 1);
    promptArea.value = historyStore[historyIndex];
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    historyIndex = Math.max(historyIndex - 1, -1);
    promptArea.value = historyIndex >= 0 ? historyStore[historyIndex] : '';
  } else if (e.key === 'Escape') {
    historyIndex = -1;
    promptArea.value = '';
  }
});

// Reset index on new typing
promptArea.addEventListener('input', () => { historyIndex = -1; });
```

---

## Token Counter

```js
const MODEL_LIMITS = { floor: 200000, balanced: 200000, power: 1000000 };

promptArea.addEventListener('input', () => {
  const chars = promptArea.value.length;
  const approxTokens = Math.ceil(chars / 4);
  const limit = MODEL_LIMITS[currentTier] || 200000;
  tokenCountEl.textContent = `~${approxTokens.toLocaleString()} / ${(limit / 1000).toFixed(0)}k`;
});
```

---

## UI Layout

```html
<div id="app-p1" class="palette p1 app">
  <!-- Header: 3-column grid -->
  <div class="header">
    <div class="header-identity"><!-- Logo, tagline --></div>
    <div class="header-center"><!-- Search --></div>
    <div class="header-buttons"><!-- Button grid (5×2) --></div>
  </div>

  <!-- Launch Bar -->
  <div class="launch-bar">
    <div class="launch-context-row"><!-- Dir | Repo | Project --></div>
    <div class="prompt-wrap"><!-- Textarea + token count --></div>
    <div class="launch-action-row"><!-- Mode toggle + Launch btn --></div>
  </div>

  <!-- Session Grid -->
  <div class="session-grid">
    <div class="session-col" id="col-0"></div>
    <div class="session-col" id="col-1"></div>
    <div class="session-col" id="col-2"></div>
  </div>

  <!-- Debug Bar -->
  <div class="debug-bar" onclick="toggleDebugPanel(this)">
    🪲 Debug Log <span class="debug-chevron">▼ expand</span>
  </div>
  <div class="debug-panel"><div class="debug-panel-inner"></div></div>
</div>
```
