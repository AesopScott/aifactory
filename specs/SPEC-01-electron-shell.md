# SPEC-01 — Electron Shell (main.js)

## Purpose

main.js is the Electron entry point. It owns: the BrowserWindow, the server child process, and the IPC bridge for any OS-level actions (system dialogs, external links) that the server process cannot perform directly.

---

## Responsibilities

- Ensure AppData directories exist on first launch
- Copy the UI HTML file from packaged resources to AppData (overwrite every launch)
- Fork server.js as a child process, passing runtime paths via env vars
- Create and configure the BrowserWindow
- Load the UI by pointing the window at `http://localhost:PORT`
- Bridge IPC messages between server.js and Electron (e.g. folder picker dialog)

---

## Directory Setup

```js
function ensureAppData() {
  const dirs = [
    POLARIS_DIR,
    path.join(POLARIS_DIR, 'sessions'),
    path.join(POLARIS_DIR, 'logs'),
    path.join(POLARIS_DIR, 'polaris_chat'),  // fallback workDir for chat sessions
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  // Always overwrite mockup.html — this is how UI updates deploy
  fs.copyFileSync(MOCKUP_SRC, MOCKUP_DEST);
}
```

**Key:** `MOCKUP_SRC` must handle both packaged (`process.resourcesPath`) and dev (`__dirname`) cases:
```js
const MOCKUP_SRC = app.isPackaged
  ? path.join(process.resourcesPath, 'resources', 'mockup.html')
  : path.join(__dirname, 'resources', 'mockup.html');
```

---

## Path Constants

```js
const APPDATA      = process.env.APPDATA || os.homedir();  // never use HOME alone on Windows
const POLARIS_DIR  = path.join(APPDATA, '.claude', 'polaris');
const MOCKUP_DEST  = path.join(POLARIS_DIR, 'mockup.html');
const SERVER_PORT  = 40000;
```

Use `process.env.APPDATA || os.homedir()` — not `process.env.HOME` — so the app works for any Windows user account.

---

## Forking the Server

```js
function startServer() {
  const serverPath = path.join(__dirname, 'server.js');
  serverProcess = fork(serverPath, [], {
    env: {
      ...process.env,
      POLARIS_DIR,
      MOCKUP_DEST,
      SERVER_PORT: String(SERVER_PORT),
    },
    silent: false,  // server logs flow to main process stdout
  });

  serverProcess.on('error', err => console.error('[main] Server error:', err));

  serverProcess.on('exit', code => {
    console.log('[main] Server exited with code', code);
    if (code === 0) setTimeout(startServer, 500);  // auto-restart on clean exit
  });

  // IPC bridge — server sends messages via process.send(), main handles here
  serverProcess.on('message', async msg => {
    if (!msg || !msg.type) return;
    if (msg.type === 'pick-directory') {
      // Handle folder picker — only Electron can open native dialogs
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Working Directory',
        properties: ['openDirectory'],
        defaultPath: msg.defaultPath || undefined,
      });
      const picked = (!result.canceled && result.filePaths.length) ? result.filePaths[0] : null;
      serverProcess.send({ type: 'directory-picked', requestId: msg.requestId, path: picked });
    }
  });
}
```

**Why fork instead of spawn:** `fork()` establishes a message channel (`process.send` / `process.on('message')`) that `spawn()` does not. This is the only way for the server child process to trigger Electron-only APIs (dialogs, notifications, etc.).

---

## BrowserWindow Configuration

```js
mainWindow = new BrowserWindow({
  width: 1400,
  height: 900,
  minWidth: 900,
  minHeight: 600,
  title: 'Polaris',
  backgroundColor: '#0a0e1a',           // prevents white flash on load
  icon: path.join(__dirname, 'assets', 'icon.ico'),
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    webviewTag: true,                   // required for embedded preview webview
  },
  autoHideMenuBar: true,
});

mainWindow.maximize();

// Delay load to give server time to start
setTimeout(() => {
  mainWindow.loadURL(`http://localhost:${SERVER_PORT}`);
}, 800);
```

**Note:** The 800ms delay avoids a race condition where the window loads before the HTTP server is listening. A more robust approach would be to poll the health endpoint, but the delay is reliable enough for localhost.

---

## IPC Handlers (Renderer → Main)

```js
ipcMain.handle('reload-ui', () => {
  if (mainWindow) mainWindow.webContents.reload();
});

ipcMain.handle('restart-server', () => {
  if (serverProcess) serverProcess.kill();
  setTimeout(startServer, 500);
});

ipcMain.handle('open-external', (_, url) => {
  shell.openExternal(url);
});
```

These are registered with `ipcMain.handle` and called from the renderer with `ipcRenderer.invoke`. In this stack, the renderer does not use ipcRenderer directly — all communication goes through the WebSocket. These handlers exist only for cases where server.js needs to delegate back to main.js.

---

## App Lifecycle

```js
app.whenReady().then(() => {
  ensureAppData();
  startServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
```

---

## IPC Bridge Pattern (Server → Main → Back to Server)

For any OS-level action the server needs but cannot do itself:

1. Server calls `process.send({ type: 'pick-directory', requestId, defaultPath })`
2. Main receives via `serverProcess.on('message', msg => { ... })`
3. Main performs the action (dialog, etc.)
4. Main sends result back: `serverProcess.send({ type: 'directory-picked', requestId, path })`
5. Server receives via `process.on('message', msg => { ... })`, resolves the pending WebSocket client using `requestId`

The `requestId` is a random hex string (`crypto.randomBytes(8).toString('hex')`) that correlates the request to the waiting WebSocket client.

---

## Imports Required

```js
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { fork } = require('child_process');
```

---

## Package.json Keys Required

```json
{
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "dist": "electron-builder"
  },
  "dependencies": {
    "ws": "^8.0.0"
  },
  "devDependencies": {
    "electron": "^latest",
    "electron-builder": "^latest"
  },
  "build": {
    "appId": "com.yourname.appname",
    "productName": "AppName",
    "directories": { "output": "dist" },
    "win": {
      "target": "nsis",
      "icon": "assets/icon.ico"
    },
    "extraResources": [
      { "from": "resources/", "to": "resources/", "filter": ["**/*"] }
    ]
  }
}
```
