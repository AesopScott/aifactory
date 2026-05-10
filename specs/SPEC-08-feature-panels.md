# SPEC-08 — Feature Panels

## Purpose

Covers every panel in the header nav: Settings, API Balance, Connections, Projects, SPACE Productivity, Code Health, File Manager, File Versions, Obsidian Up, and Routines (skeleton). Each panel has a distinct server interaction pattern.

---

## Panel Architecture

All panels (except Code Health and Preview) follow the same modal pattern:

```html
<!-- Overlay backdrop -->
<div class="overlay-bg hidden" id="overlay-bg" onclick="closeAllPanels()"></div>

<!-- Panel -->
<div class="projects-panel hidden" id="settings-panel">
  <div class="panel-header">Settings <button onclick="closePanel('settings-panel')">✕</button></div>
  <div class="projects-panel-body"><!-- panel content --></div>
  <div class="projects-footer"><!-- action buttons --></div>
</div>
```

```js
function openPanel(id) {
  document.getElementById(id).classList.remove('hidden');
  document.getElementById('overlay-bg').classList.remove('hidden');
}

function closePanel(id) {
  document.getElementById(id).classList.add('hidden');
  document.getElementById('overlay-bg').classList.add('hidden');
}

function closeAllPanels() {
  for (const id of ['settings-panel', 'projects-panel', 'connections-panel', 'balance-panel', ...]) {
    document.getElementById(id)?.classList.add('hidden');
  }
  document.getElementById('overlay-bg').classList.add('hidden');
}
```

Code Health and Preview panels are floating + draggable — they use `position: fixed` and don't use the overlay.

---

## Settings Panel

**Sections:** General | OpenRouter | API Keys | Chat | Obsidian

**On open:** `send({ type: 'get-config' })` — server returns masked config

**Save flow:**
```js
function saveSettings() {
  const cfg = {
    openRouterApiKey:      document.getElementById('or-key').value,    // masked value preserved
    openRouterFloorModel:  document.getElementById('floor-model').value,
    openRouterSonnetModel: document.getElementById('sonnet-model').value,
    openRouterOpusModel:   document.getElementById('opus-model').value,
    anthropicApiKey:       document.getElementById('anth-key').value,
    openAiApiKey:          document.getElementById('oai-key').value,
    chatModel:             document.getElementById('chat-model').value,
    deepSeekEmail:         document.getElementById('ds-email').value,
    deepSeekPassword:      document.getElementById('ds-pass').value,
    obsidianVaultPath:     document.getElementById('obsidian-path').value,
    githubUsername:        document.getElementById('github-username').value,
    defaultTier:           document.getElementById('default-tier').value,
    sessionTimeout:        parseInt(document.getElementById('session-timeout').value) || 600,
    protectedPatterns:     parsePatterns(document.getElementById('protected-patterns').value),
  };
  send({ type: 'save-config', config: cfg });
  closePanel('settings-panel');
}
```

**Masking rule:** The server sends `••••••••` for any set secret. When saving, if the field value equals `••••••••`, the server preserves the existing encrypted value. Users only need to re-enter a key to change it.

**API key test buttons:** Each key field has a "Test" button that sends `test-openrouter-key`, `test-anthropic-key`, or `test-openai-key`. Response: `openrouter-test-result`, etc. Show ✓/✗ inline next to the field.

**Model test buttons:** Each model tier has a "Test" button → `test-model` message → `test-model-result`. Shows the model string was validated as working.

**Sync Global Files button:** `send({ type: 'sync-global-files' })` → server returns `sync-complete` with per-file results.

---

## API Balance Panel

```js
function openBalancePanel() {
  openPanel('balance-panel');
  send({ type: 'check-openrouter-balance' });
}

// Handle response
if (msg.type === 'openrouter-balance') {
  if (msg.ok) {
    document.getElementById('balance-used').textContent  = `$${(msg.usage / 100).toFixed(4)}`;
    document.getElementById('balance-total').textContent = msg.limit ? `$${(msg.limit / 100).toFixed(2)}` : 'Pay-as-you-go';
  } else {
    document.getElementById('balance-error').textContent = msg.message;
  }
}
```

Also include a direct link button to `https://openrouter.ai/credits` for the user to top up.

---

## Connections Panel

Two tabs: **Git Status** (per project) | **MCP Servers** (edit ~/.claude.json)

**Git Status tab:**
```js
function loadConnections() {
  send({ type: 'get-connections' });
}

// Handle response
if (msg.type === 'connections') {
  renderConnectionsList(msg.data);
}

function renderConnectionsList(projects) {
  // Each item: project name, branch, dirty indicator, ahead/behind counts
  // { name, workDir, branch, dirty, ahead, behind }
}
```

Server uses `git branch --show-current`, `git status --porcelain`, and `git rev-list --count --left-right @{upstream}...HEAD` per project.

**MCP Servers tab:**
```js
send({ type: 'get-mcp-servers' });   // returns { type: 'mcp-servers', servers: {...} }
send({ type: 'save-mcp-servers', servers: {...} });  // writes to ~/.claude.json
```

Servers are displayed as a raw JSON textarea for direct editing.

---

## Projects Panel

**Purpose:** Define named projects with working directory and remote repo. Projects appear in the launch bar dropdown and auto-fill the context fields.

```js
let projectsList = [];  // [{ name, workDir, repo }]

function renderProjectsTable() {
  const tbody = document.getElementById('projects-tbody');
  tbody.innerHTML = '';
  projectsList.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input value="${escHtml(p.name)}" onchange="projectsList[${i}].name=this.value"></td>
      <td>
        <input value="${escHtml(p.workDir)}" onchange="projectsList[${i}].workDir=this.value">
        <button onclick="pickDirForProject(${i})">📁</button>
      </td>
      <td>
        <input value="${escHtml(p.repo)}" onchange="projectsList[${i}].repo=this.value">
        <button onclick="listReposForProject(${i})">🔗</button>
      </td>
      <td>
        <button onclick="openSpaceForProject('${escHtml(p.name)}')">📊 Productivity</button>
        <button onclick="removeProject(${i})">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function saveProjects() {
  send({ type: 'save-config', config: { projects: projectsList } });
  refreshProjectDropdowns();
  refreshFieldTags();
  closePanel('projects-panel');
}
```

**Folder picker:** `send({ type: 'pick-directory' })` → server IPC → native dialog → `directory-picked` response → populate input.

**Repo selector:** `send({ type: 'list-github-repos' })` → server fetches GitHub API → `github-repos` response → show dropdown of owner/name strings.

**Tag rules:**
- Working dirs assigned to a project do NOT get standalone tag buttons
- Same for repos
- All comparisons are `.toLowerCase()` — Windows paths are case-insensitive

---

## SPACE Productivity Panel

**Access:** 📊 Productivity button per row in Projects panel.

**On open:** `send({ type: 'get-space-data', projectName })` → server computes scores → `space-data` response.

**Five dimensions:**

| Dim | Proxy | Formula |
|-----|-------|---------|
| S (Satisfaction) | Session success rate | % sessions ending `done` vs `error` |
| P (Performance) | Output throughput | avg output tokens per session (500 tokens = 100 pts) |
| A (Activity) | Sessions per day | sessions launched per day (5/day = 100 pts) |
| C (Collaboration) | Parallel work | avg concurrent sessions at launch (2+ = 100 pts) |
| E (Efficiency) | Time to first output | 0ms = 100 pts, 30s = 0 pts |

All scores are 0–100, 7-day rolling window.

**Display:**
```js
function renderSpacePanel(scores) {
  for (const [dim, data] of Object.entries(scores)) {
    const bar  = document.getElementById(`space-bar-${dim}`);
    const val  = document.getElementById(`space-val-${dim}`);
    const trend = document.getElementById(`space-trend-${dim}`);
    bar.style.width  = data.score + '%';
    bar.style.background = data.score >= 75 ? '#22c55e' : data.score >= 50 ? '#eab308' : '#ef4444';
    val.textContent  = data.score;
    trend.textContent = data.trend === 'up' ? '↑' : data.trend === 'down' ? '↓' : '→';
    renderSparkline(`space-spark-${dim}`, data.last7);
  }
}

function renderSparkline(id, values) {
  const max = Math.max(...values, 1);
  const bars = values.map(v => {
    const h = Math.round((v / max) * 24);
    return `<rect x="${i * 9}" y="${24 - h}" width="7" height="${h}" fill="currentColor"/>`;
  }).join('');
  document.getElementById(id).innerHTML = `<svg width="63" height="24" viewBox="0 0 63 24">${bars}</svg>`;
}
```

---

## Code Health Panel

**Access:** Red "Code Health" button — floating draggable panel (no overlay).

**Project selector:** Dropdown of projects with a `workDir`. Changing selection loads new data.

**On select:** `send({ type: 'get-code-health', projectName })` → server runs `computeCodeHealth(workDir)` → `code-health` response.

**Three sections:**

```js
function renderCodeHealth(data) {
  renderChurnTable(data.churn);      // file, commits, added, deleted lines
  renderAuthorsTable(data.authors);  // name, email, commit count
  renderComplexityTable(data.fileStats);  // file, lines, functions, branches, loops, complexity score
}
```

**Complexity coloring:** score relative to max in the set. Green < 40%, amber 40–70%, red > 70%.

**Server computation:**
```js
async function computeCodeHealth(workDir) {
  // git log --numstat for churn
  // git shortlog -sne HEAD for authors
  // Walk JS/TS files, count: functions (/\bfunction\b|=>|\bclass\b/g), branches (/\bif\b|\bswitch\b|\belse\s+if\b|\bcase\b/g), loops (/\bfor\b|\bwhile\b|\bdo\b/g)
  // complexity = functions + branches + loops
  // Skip: node_modules, .git, dist, release
}
```

---

## File Manager Panel

**Access:** Via session card footer or header nav.

**On open:** `send({ type: 'browse-dir', dirPath: session.workDir })` → `dir-listing` response.

```js
if (msg.type === 'dir-listing') {
  renderFileTree(msg.dirPath, msg.items);
}

// Clicking a folder sends browse-dir for that path (expand in place)
```

Items: `{ name, isDir, path }`, sorted dirs-first then alphabetical.

Skipped dirs: `node_modules`, `.git`, `dist`, `release`.

---

## File Versions Panel

**Access:** Blue "Versions" button in header nav.

**Data sources:**
- `versionsStore` — flat map from `file-versions.json` (current version per file)
- `sessionFilesMap` — built live from `file-version` WS events

**Two views:**
- **Registry tab:** All versioned files with current version, filterable by path
- **Changelog tab:** Sessions as collapsible groups; each group shows files touched with per-change entries (v1.0 → v1.1 at HH:MM:SS)

```js
function renderVersionsPanel() {
  renderVersionRegistry();
  renderVersionChangelog();
}

function renderVersionRegistry() {
  const filter = document.getElementById('version-filter').value.toLowerCase();
  for (const [file, version] of Object.entries(versionsStore)) {
    if (filter && !file.toLowerCase().includes(filter)) continue;
    // render row: file path | version
  }
}

function renderVersionChangelog() {
  for (const [sessionId, files] of Object.entries(sessionFilesMap)) {
    const s = sessionsStore[sessionId];
    // render collapsible group: session name
    for (const [file, info] of Object.entries(files)) {
      for (const change of info.changes) {
        // render: file | v{prev} → v{next} | HH:MM:SS
      }
    }
  }
}
```

---

## Obsidian Up

**Purpose:** Push a session's terminal output to the Obsidian vault as a markdown note.

```js
function obsidianUp(sessionId) {
  const s = sessionsStore[sessionId];
  if (!s) return;
  const content = s.lines
    .map(l => l.role === 'user' ? `**User:** ${l.text}` : l.text)
    .join('\n\n');
  send({ type: 'obsidian-up', sessionName: s.name, content });
}

// Handle response
if (msg.type === 'obsidian-up-done') {
  showNotif(`Saved to Obsidian: ${msg.filePath}`);
}
```

Server writes to `<vaultPath>/Polaris_Build/<SessionName>.md`. Creates directory if needed.

---

## Close All Button

Sequentially prompts for each session before closing:

```js
async function closeAll() {
  for (const id of [...sessionOrder]) {
    const s = sessionsStore[id];
    if (!s) continue;
    const action = await showCloseModal(s.name);  // 'obsidian' | 'skip' | 'cancel'
    if (action === 'cancel') return;
    if (action === 'obsidian') obsidianUp(id);
    send({ type: 'close-session', sessionId: id });
  }
}
```

The close modal shows three buttons per session: "Push to Obsidian + Close", "Skip", "Cancel All".
