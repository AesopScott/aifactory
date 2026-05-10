# SPEC-07 — Data Persistence

## Purpose

All persistent state is stored in JSON or JSONL files in the AppData runtime directory. This spec covers the schema and access pattern for every file Polaris writes.

---

## File Inventory

| File | Format | Purpose |
|------|--------|---------|
| `config.json` | JSON | All settings: API keys (encrypted), model strings, projects, saved dirs/repos |
| `sessions-persist.json` | JSON array | Session cards with terminal history, restored on restart |
| `locks.json` | JSON | File-to-session lock mappings |
| `file-versions.json` | JSON | File path → current version number |
| `prompt-history.json` | JSON array | Last 200 prompts, MRU order |
| `space/<project>/events.jsonl` | JSONL | Append-only SPACE event log per project |

---

## config.json

Full schema:

```json
{
  "openRouterApiKey":     "enc:...",
  "anthropicApiKey":      "enc:...",
  "openAiApiKey":         "enc:...",
  "deepSeekEmail":        "enc:...",
  "deepSeekPassword":     "enc:...",

  "openRouterFloorModel":    "openrouter/auto",
  "openRouterSonnetModel":   "anthropic/claude-sonnet-4-6",
  "openRouterOpusModel":     "anthropic/claude-opus-4-7",
  "chatModel":               "deepseek/deepseek-chat",

  "defaultTier":             "floor",
  "sessionTimeout":          600,

  "obsidianVaultPath":       "G:\\My Drive\\Aesop Academy\\Obsidian",
  "githubUsername":          "AesopScott",

  "palette":                 1,

  "protectedPatterns":       ["*.md"],

  "lastWorkDir":             "C:\\Users\\scott\\Code\\aesop",
  "lastRepo":                "AesopScott/Aesop",
  "lastProject":             "Aesop",

  "savedWorkDirs":           ["C:\\Users\\scott\\Code\\aesop"],
  "savedRepos":              ["AesopScott/Aesop"],

  "projects": [
    {
      "name":    "Polaris",
      "workDir": "",
      "repo":    ""
    },
    {
      "name":    "Aesop",
      "workDir": "C:\\Users\\scott\\Code\\aesop",
      "repo":    "AesopScott/Aesop"
    }
  ]
}
```

**Access pattern:**
- `readConfig()` — decrypts secrets before returning
- `maskedConfig(cfg)` — replaces secrets with `••••••••` for UI
- `saveConfig(incoming, currentRaw)` — re-encrypts secrets, merges with existing

---

## sessions-persist.json

```json
[
  {
    "id":              "s_1746123456789",
    "name":            "Fix Auth Middleware",
    "workDir":         "C:\\Users\\scott\\Code\\aesop",
    "projectName":     "Aesop",
    "model":           "anthropic/claude-sonnet-4-6",
    "isChat":          false,
    "status":          "done",
    "startAt":         1746123456789,
    "endAt":           1746123512345,
    "claudeSessionId": "sess_abc123",
    "lastPrompt":      "Fix the auth middleware to handle token expiry",
    "height":          "340px",
    "column":          1,
    "lines": [
      { "role": "user",      "text": "Fix the auth middleware to handle token expiry" },
      { "role": "assistant", "text": "I'll analyze the auth middleware..." },
      ...
    ]
  }
]
```

**Rules:**
- `status: 'running'` is never persisted — always written as `'done'` (running sessions stop when the app closes)
- `lines` capped at last 500 entries on persist
- Saved on: every assistant line, status change to done/error, height change, column change

---

## locks.json

```json
{
  "server.js": {
    "sessions": ["s_1746123456789"]
  },
  "resources/mockup.html": {
    "sessions": ["s_1746123456789", "s_1746123999999"]
  }
}
```

Keys are relative paths (relative to `process.cwd()`). A file can be locked by multiple sessions. Empty sessions array = file is unlocked; delete the key in that case.

**Server handlers:**
```js
if (type === 'get-locks') {
  sendTo(ws, { type: 'locks', locks: readJSON(LOCKS_PATH, {}) });
  return;
}

if (type === 'set-lock') {
  const locks = readJSON(LOCKS_PATH, {});
  const { filePath, sessionId, locked } = msg;
  if (locked) {
    if (!locks[filePath]) locks[filePath] = { sessions: [] };
    if (!locks[filePath].sessions.includes(sessionId)) locks[filePath].sessions.push(sessionId);
  } else {
    if (locks[filePath]) {
      locks[filePath].sessions = locks[filePath].sessions.filter(s => s !== sessionId);
      if (locks[filePath].sessions.length === 0) delete locks[filePath];
    }
  }
  writeJSON(LOCKS_PATH, locks);
  sendTo(ws, { type: 'locks', locks });
  return;
}
```

---

## file-versions.json

```json
{
  "server.js":              "2.3",
  "resources/mockup.html":  "4.1",
  "CLAUDE.md":              "1.2"
}
```

Version bumping:
```js
function bumpVersion(filePath) {
  const versions = getVersions();
  const rel  = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
  const prev = versions[rel] || '1.0';
  const next = (parseFloat(prev) + 0.1).toFixed(1);
  versions[rel] = next;
  writeJSON(VERSIONS_PATH, versions);
  return { rel, prev, next };
}
```

Versions are bumped by `watchSessionFiles()` whenever a file changes in a session's working directory. This is not agent-only — any file system change (manual edit, tool output) triggers a bump.

---

## prompt-history.json

```json
[
  "Fix the auth middleware to handle token expiry",
  "Add pagination to the user list endpoint",
  "Review server.js for security issues",
  ...
]
```

MRU order: most recent prompt at index 0. Deduplicated — adding an existing prompt moves it to the front. Capped at 200 entries.

```js
function addToHistory(prompt) {
  const history = readJSON(HISTORY_PATH, []);
  const updated = [prompt, ...history.filter(p => p !== prompt)].slice(0, 200);
  writeJSON(HISTORY_PATH, updated);
}
```

---

## space/<project>/events.jsonl

Append-only event log. One JSON object per line:

```jsonl
{"ts":1746123456789,"type":"session-launch","sessionId":"s_123","concurrentCount":2}
{"ts":1746123512345,"type":"first-output","sessionId":"s_123","elapsed":3421}
{"ts":1746123612345,"type":"session-done","sessionId":"s_123","duration":155556,"outputTokens":842}
{"ts":1746124000000,"type":"session-error","sessionId":"s_456","duration":12000}
```

Event types:
- `session-launch` — session started; includes `concurrentCount` (for SPACE C scoring)
- `first-output` — first assistant text arrived; includes `elapsed` ms since launch (for SPACE E)
- `session-done` — session finished successfully; includes `duration` ms and `outputTokens` (for SPACE S/P)
- `session-error` — session ended in error; includes `duration` (for SPACE S)

Append function:
```js
function spaceAppendEvent(projectName, data) {
  if (!projectName) return;
  const dir = path.join(SPACE_DIR, spaceSlug(projectName));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, 'events.jsonl'),
    JSON.stringify({ ts: Date.now(), ...data }) + '\n',
    'utf8'
  );
}

function spaceSlug(name) {
  return (name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}
```

---

## AppData Path Pattern

Always use `process.env.APPDATA || os.homedir()` — not `process.env.HOME` alone. On Windows, `HOME` may be undefined or point to a different path than `APPDATA`. `APPDATA` resolves to `C:\Users\<user>\AppData\Roaming` for any logged-in user.

```js
const APPDATA     = process.env.APPDATA || os.homedir();
const APP_DIR     = path.join(APPDATA, '.claude', 'myapp');  // customize subdir per app
const CONFIG_PATH = path.join(APP_DIR, 'config.json');
```

---

## Atomic Write Pattern

Never write partial JSON. `JSON.stringify` + `writeFileSync` is atomic at the Node.js level (the OS may buffer, but from the app's perspective a crash mid-write leaves either the old file or the new one complete):

```js
function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}
```

For high-frequency writes (session persistence), silent error handling prevents a disk-full or permission error from crashing the app:

```js
function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_PERSIST_PATH, JSON.stringify(Array.from(sessions.values()).map(serializeSession), null, 2), 'utf8');
  } catch {}
}
```
