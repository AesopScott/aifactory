# SPEC-10 — Build Workflow & Packaging

## Purpose

Covers electron-builder configuration, the dist-and-reinstall workflow, the three-zone file architecture, and deployment patterns.

---

## Three-Zone Architecture (Recap)

Every app using this stack has three zones with hard rules:

| Zone | Path | Contents | Rule |
|------|------|----------|------|
| **Source** | `C:\Users\<user>\Code\<AppName>\` | main.js, server.js, resources/mockup.html, assets/ | Edit here. Requires rebuild. |
| **Installed** | `C:\Users\<user>\AppData\Local\Programs\<AppName>\resources\` | Built app binary + packaged resources | Never edit. Destroyed on reinstall. |
| **Runtime** | `C:\Users\<user>\AppData\Roaming\<data-dir>\` | config.json, sessions, logs, UI HTML | Only runtime writes. Survives reinstalls. |

The UI HTML file lives in the runtime zone. On every app launch, `main.js` overwrites it from the packaged source. This is how UI updates deploy without wiping user config.

---

## package.json Configuration

```json
{
  "name": "polaris",
  "version": "1.0.0",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "dist":  "electron-builder"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "electron":         "^latest",
    "electron-builder": "^latest"
  },
  "build": {
    "appId":       "com.aesopscott.polaris",
    "productName": "Polaris",
    "directories": {
      "output": "dist"
    },
    "files": [
      "main.js",
      "server.js",
      "assets/**",
      "node_modules/**",
      "!node_modules/.bin"
    ],
    "extraResources": [
      {
        "from":   "resources/",
        "to":     "resources/",
        "filter": ["**/*"]
      }
    ],
    "win": {
      "target": "nsis",
      "icon":   "assets/icon.ico"
    },
    "nsis": {
      "oneClick":           false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true
    }
  }
}
```

**Key points:**
- `extraResources` bundles `resources/mockup.html` under `process.resourcesPath/resources/` in the packaged app
- `files` includes only what the app needs to run — excludes devDependencies source
- Icon must be at least 256×256 for electron-builder Windows NSIS target

---

## Build & Reinstall Workflow

```powershell
# From the project source directory
Set-Location "C:\Users\scott\Code\Polaris"
npm run dist

# Find the generated installer
$installer = Get-ChildItem "dist\*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1

# Run the installer (NSIS handles uninstall of the previous version automatically)
Start-Process $installer.FullName -Wait
```

After reinstall:
- Launch Polaris — it overwrites `mockup.html` from packaged source on startup
- All runtime data (config, sessions, logs) is untouched
- No manual copy step needed

---

## Why Always Overwrite mockup.html

```js
// main.js — runs before server starts
function ensureAppData() {
  // ...
  fs.copyFileSync(MOCKUP_SRC, MOCKUP_DEST);  // always, unconditionally
}
```

This means:
- UI changes are immediately live after reinstall
- No "which version of mockup.html is running?" confusion
- Runtime data (config, sessions) is in config.json and sessions-persist.json, not in the HTML — so overwriting the HTML is always safe

---

## App Icon Generation

```js
// generate-icon.js — run once when icon changes
// Creates assets/icon.ico with 16×16, 32×32, 48×48, 256×256 sizes
// Uses the 4-pointed sparkle SVG path for the Polaris star shape
// electron-builder requires at least 256×256 — anything smaller causes a build warning
```

After changing the icon: `node generate-icon.js`, then rebuild.

---

## Dev vs Packaged Path Resolution

```js
// In main.js — MOCKUP_SRC must handle both environments
const MOCKUP_SRC = app.isPackaged
  ? path.join(process.resourcesPath, 'resources', 'mockup.html')
  : path.join(__dirname, 'resources', 'mockup.html');
```

```js
// In server.js — __dirname works in both environments
const GLOBAL_CLAUDE_PATH = path.join(__dirname, 'CLAUDE.md');
```

`__dirname` in server.js resolves to the app's root in both dev and packaged modes because server.js is not moved during packaging.

---

## Development Workflow (No Build)

For UI changes during development, run the app with `npm start`. The window reloads after the server sends a `reload` message. No reinstall needed — just reload.

For server.js changes:
1. Edit source
2. Use the "Restart" button in the app header (sends `{ type: 'restart' }` via WS → server calls `process.exit(0)` → main.js detects exit code 0 → forks new server)

For main.js changes:
- Must restart Electron: `Ctrl+C` in the terminal, `npm start` again

For packaged distribution:
- Full `npm run dist` → reinstall cycle required

---

## Environment Variable Injection

main.js passes runtime paths to server.js via `fork()` env:

```js
serverProcess = fork(serverPath, [], {
  env: {
    ...process.env,
    POLARIS_DIR,    // absolute path to AppData/Roaming/.claude/polaris
    MOCKUP_DEST,    // absolute path to mockup.html in AppData
    SERVER_PORT: String(SERVER_PORT),
  },
  silent: false,
});
```

server.js reads these at startup:
```js
const POLARIS_DIR = process.env.POLARIS_DIR  || path.join(APPDATA, '.claude', 'polaris');
const MOCKUP_DEST = process.env.MOCKUP_DEST  || path.join(POLARIS_DIR, 'mockup.html');
const PORT        = Number(process.env.SERVER_PORT) || 40000;
```

The fallbacks ensure server.js works when run directly (e.g., `node server.js` for debugging).

---

## Port Assignment

Use a high, static port (40000+) to avoid conflicts with common development ports (3000, 8080, etc.). The port is hardcoded in main.js and passed to server.js — no dynamic port assignment needed since only one instance of the app runs.

---

## Auto-Restart on Clean Exit

```js
// In main.js — server process exit handler
serverProcess.on('exit', code => {
  if (code === 0) setTimeout(startServer, 500);
  // Non-zero exit = crash — don't auto-restart to avoid restart loops
});
```

The server calls `process.exit(0)` in response to the "Restart" button. main.js detects the clean exit and forks a new server after 500ms.

---

## What Survives a Reinstall

| Data | Location | Survives? |
|------|----------|-----------|
| API keys | `config.json` (encrypted) | ✅ |
| Projects + settings | `config.json` | ✅ |
| Session cards + history | `sessions-persist.json` | ✅ |
| Prompt history | `prompt-history.json` | ✅ |
| SPACE event logs | `space/*/events.jsonl` | ✅ |
| File versions | `file-versions.json` | ✅ |
| Locks | `locks.json` | ✅ |
| UI customization (palette) | `config.json` | ✅ |
| App binary | Installed zone | ❌ Replaced |
| mockup.html copy | Runtime zone | ❌ Overwritten on next launch |

Nothing in the runtime data zone is lost by a reinstall — only the installed binary and its bundled resources change.
