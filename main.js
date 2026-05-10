const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { fork } = require('child_process')

const APPDATA = process.env.APPDATA || os.homedir()
const FACTORY_DIR = path.join(APPDATA, 'aifactory')
const PROJECTS_DIR = path.join(FACTORY_DIR, 'projects')
const LOGS_DIR = path.join(FACTORY_DIR, 'logs')
const MOCKUP_DEST = path.join(FACTORY_DIR, 'mockup.html')
const SERVER_PORT = 40100

let serverProcess = null
let mainWindow = null

function ensureDirs() {
  for (const d of [FACTORY_DIR, PROJECTS_DIR, LOGS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  }
}

function mockupSrc() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'resources', 'mockup.html')
    : path.join(__dirname, 'resources', 'mockup.html')
}

function copyUI() {
  const src = mockupSrc()
  if (fs.existsSync(src)) fs.copyFileSync(src, MOCKUP_DEST)
}

function forkServer() {
  serverProcess = fork(path.join(__dirname, 'server.js'), [], {
    silent: false,
    env: {
      ...process.env,
      FACTORY_DIR,
      PROJECTS_DIR,
      LOGS_DIR,
      MOCKUP_DEST,
      SERVER_PORT: String(SERVER_PORT)
    }
  })

  const fallback = setTimeout(() => mainWindow?.loadURL(`http://localhost:${SERVER_PORT}`).catch(() => {}), 5000)

  serverProcess.on('message', async (msg) => {
    if (msg.type === 'server-ready') {
      clearTimeout(fallback)
      mainWindow?.loadURL(`http://localhost:${SERVER_PORT}`).catch(() => {})
    }
    if (msg.type === 'pick-directory') {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        defaultPath: msg.defaultPath || FACTORY_DIR
      })
      serverProcess.send({
        type: 'directory-picked',
        requestId: msg.requestId,
        dirPath: result.canceled ? null : result.filePaths[0]
      })
    }
    if (msg.type === 'open-external') {
      shell.openExternal(msg.url)
    }
  })

  serverProcess.on('exit', (code) => {
    if (code === 0) setTimeout(forkServer, 500)
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0d0d',
    center: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false
    }
  })

  // URL loaded by forkServer once server-ready signal arrives
}

app.whenReady().then(() => {
  ensureDirs()
  copyUI()
  forkServer()
  createWindow()

  ipcMain.on('reload-ui', () => mainWindow?.reload())
  ipcMain.on('restart-server', () => {
    if (serverProcess) {
      serverProcess.kill()
      setTimeout(forkServer, 500)
    }
  })
  ipcMain.on('open-external', (_, url) => shell.openExternal(url))
})

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill()
  app.quit()
})
