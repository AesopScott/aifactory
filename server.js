'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execSync } = require('child_process')
const { WebSocketServer } = require('ws')

const skills = require('./skills')
const routines = require('./routines')

const APPDATA = process.env.APPDATA || os.homedir()
const FACTORY_DIR = process.env.FACTORY_DIR || path.join(APPDATA, 'aifactory')
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(FACTORY_DIR, 'projects')
const MOCKUP_DEST = process.env.MOCKUP_DEST || path.join(FACTORY_DIR, 'mockup.html')
const PORT = parseInt(process.env.SERVER_PORT || '40100', 10)

const CONFIG_FILE = path.join(FACTORY_DIR, 'config.json')
const PROJECTS_FILE = path.join(FACTORY_DIR, 'projects.json')
const POLARIS_CONFIG = path.join(APPDATA, '.claude', 'polaris', 'config.json')

const MASK = '••••••••'
const SECRET_FIELDS = ['openRouterApiKey', 'anthropicApiKey']

// ── Crypto ────────────────────────────────────────────────────────────────────

function getMachineKey() {
  try {
    const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { stdio: 'pipe' })
    const guid = out.toString().match(/MachineGuid\s+REG_SZ\s+(.+)/)?.[1]?.trim()
    return crypto.createHash('sha256').update(guid || 'fallback').digest()
  } catch {
    return crypto.createHash('sha256').update('aifactory-fallback-key').digest()
  }
}

function encrypt(text) {
  const key = getMachineKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return 'enc:' + Buffer.concat([iv, tag, encrypted]).toString('base64')
}

function decrypt(value) {
  if (!value || !value.startsWith('enc:')) return value
  try {
    const key = getMachineKey()
    const buf = Buffer.from(value.slice(4), 'base64')
    const iv = buf.slice(0, 12)
    const tag = buf.slice(12, 28)
    const encrypted = buf.slice(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return decipher.update(encrypted) + decipher.final('utf8')
  } catch {
    return ''
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  openRouterApiKey: '',
  anthropicApiKey: '',
  openRouterFloorModel: 'anthropic/claude-haiku-4-5',
  openRouterSonnetModel: 'anthropic/claude-sonnet-4-5',
  openRouterOpusModel: 'anthropic/claude-opus-4-5',
  obsidianVaultPath: '',
  defaultRoutine: 'full-pipeline'
}

function readConfig() {
  const raw = readJSON(CONFIG_FILE, DEFAULT_CONFIG)
  const cfg = { ...DEFAULT_CONFIG, ...raw }
  for (const f of SECRET_FIELDS) {
    if (cfg[f]) cfg[f] = decrypt(cfg[f])
  }
  return cfg
}

function maskedConfig(cfg) {
  const out = { ...cfg }
  for (const f of SECRET_FIELDS) {
    if (out[f]) out[f] = MASK
  }
  return out
}

function saveConfig(incoming) {
  const current = readJSON(CONFIG_FILE, {})
  const next = { ...DEFAULT_CONFIG, ...current }
  for (const [k, v] of Object.entries(incoming)) {
    if (SECRET_FIELDS.includes(k)) {
      if (v === MASK) continue
      next[k] = v ? encrypt(v) : ''
    } else {
      next[k] = v
    }
  }
  writeJSON(CONFIG_FILE, next)
}

// ── Polaris registry ──────────────────────────────────────────────────────────

function readPolarisRegistry() {
  try {
    const cfg = JSON.parse(fs.readFileSync(POLARIS_CONFIG, 'utf8'))
    return {
      projects: (cfg.projects || []).map(p => ({ name: p.name, workDir: p.workDir, repo: p.repo || '' })),
      obsidianVaultPath: cfg.obsidianVaultPath || ''
    }
  } catch {
    return { projects: [], obsidianVaultPath: '' }
  }
}

// ── AI Factory Projects ───────────────────────────────────────────────────────

let projects = []

function loadProjects() {
  projects = readJSON(PROJECTS_FILE, [])
}

function saveProjects() {
  const serialized = projects.map(p => ({
    ...p,
    buildLog: (p.buildLog || []).slice(-200),
    testLog: (p.testLog || []).slice(-200)
  }))
  writeJSON(PROJECTS_FILE, serialized)
}

function findProject(id) { return projects.find(p => p.id === id) || null }

function createProject(name, workDir, polarisProjectName) {
  const id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const project = {
    id, name,
    createdAt: new Date().toISOString(),
    status: 'specifying',
    workDir: workDir || null,
    polarisProjectName: polarisProjectName || null,
    spec: { answers: {}, complete: false },
    testCriteria: { answers: {}, complete: false },
    buildLog: [],
    testLog: [],
    testResults: null,
    obsidianPath: null
  }
  projects.push(project)
  saveProjects()
  return project
}

function safeProject(p) {
  return {
    id: p.id, name: p.name, createdAt: p.createdAt, status: p.status,
    workDir: p.workDir || null,
    polarisProjectName: p.polarisProjectName || null,
    spec: p.spec, testCriteria: p.testCriteria,
    testResults: p.testResults, obsidianPath: p.obsidianPath,
    buildLogLength: (p.buildLog || []).length,
    testLogLength: (p.testLog || []).length
  }
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

const activeKillers = new Map() // projectId -> () => void

function killActive(projectId) {
  const kill = activeKillers.get(projectId)
  if (kill) {
    kill()
    activeKillers.delete(projectId)
  }
}

function pipelineLog(projectId, text, role = 'system') {
  const ts = new Date().toISOString().slice(11, 23)
  const line = `[${ts}] ${text}\n`
  console.log(`[pipeline:${projectId}] ${text}`)
  broadcast({ type: 'agent-line', projectId, text: line, role })
}

async function runPipeline(projectId, routineName, modelTier) {
  const project = findProject(projectId)
  if (!project) throw new Error(`Project ${projectId} not found`)
  const routine = routines.get(routineName)
  if (!routine) throw new Error(`Routine ${routineName} not found`)

  killActive(projectId)
  pipelineLog(projectId, `Starting pipeline: ${routineName}`)
  pipelineLog(projectId, `Stages: ${routine.stages.join(' → ')}`)
  pipelineLog(projectId, `Project: ${project.name} | WorkDir: ${project.workDir || '(auto)'}`)

  const { projects: polarisProjects, obsidianVaultPath } = readPolarisRegistry()
  pipelineLog(projectId, `Polaris projects available: ${polarisProjects.length} | Vault: ${obsidianVaultPath || '(not set)'}`)

  function registerKill(fn) {
    if (fn) activeKillers.set(projectId, fn)
    else activeKillers.delete(projectId)
  }

  for (const skillName of routine.stages) {
    const skill = skills.get(skillName)
    if (!skill || skill.type === 'ui') continue

    pipelineLog(projectId, `━━ Stage: ${skillName} ━━`)
    project.status = `running:${skillName}`
    saveProjects()
    broadcast({ type: 'project-updated', project: safeProject(project) })
    broadcast({ type: 'stage-started', projectId, stage: skillName })

    try {
      const config = readConfig()
      const tierMap = { floor: config.openRouterFloorModel, sonnet: config.openRouterSonnetModel, opus: config.openRouterOpusModel }
      const resolvedModel = tierMap[modelTier] || config.openRouterSonnetModel
      pipelineLog(projectId, `Model tier: ${modelTier || 'sonnet'} → ${resolvedModel}`)
      await skill.run({
        project, config, model: resolvedModel, projectsDir: PROJECTS_DIR, polarisProjects, obsidianVaultPath,
        registerKill,
        emit: (data) => broadcast({ type: 'agent-line', projectId, stage: skillName, ...data })
      })
      pipelineLog(projectId, `✓ Stage complete: ${skillName}`)
      broadcast({ type: 'stage-done', projectId, stage: skillName, success: true })
    } catch (err) {
      activeKillers.delete(projectId)
      pipelineLog(projectId, `✗ Stage failed: ${skillName}`, 'error')
      pipelineLog(projectId, `  Error: ${err.message}`, 'error')
      if (err.stack) pipelineLog(projectId, err.stack, 'error')
      project.status = 'failed'
      saveProjects()
      broadcast({ type: 'stage-done', projectId, stage: skillName, success: false, error: err.message })
      broadcast({ type: 'project-updated', project: safeProject(project) })
      return
    }
  }

  activeKillers.delete(projectId)
  pipelineLog(projectId, `Pipeline complete: ${routineName}`)
  project.status = 'done'
  saveProjects()
  broadcast({ type: 'project-updated', project: safeProject(project) })
  broadcast({ type: 'pipeline-done', projectId })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function saveSpecDocument(project) {
  const specSkill = skills.get('spec-interview')
  const formatted = specSkill ? specSkill.formatForPrompt(project.spec.answers) : JSON.stringify(project.spec.answers, null, 2)
  const lines = [
    `# ${project.name} — Specification`,
    ``,
    `**Created:** ${new Date().toLocaleString()}`,
    `**Polaris Project:** ${project.polarisProjectName || '(none)'}`,
    `**Working Directory:** ${project.workDir || '(auto)'}`,
    ``,
    formatted
  ].join('\n')

  const targets = []
  if (project.workDir) targets.push(path.join(project.workDir, 'spec.md'))
  const { obsidianVaultPath } = readPolarisRegistry()
  if (obsidianVaultPath) {
    const dir = path.join(obsidianVaultPath, 'AIFactory_Results')
    try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
    targets.push(path.join(dir, `${project.name.replace(/[^a-zA-Z0-9_\- ]/g, '').trim()} spec.md`))
  }

  for (const target of targets) {
    try {
      fs.writeFileSync(target, lines, 'utf8')
      console.log(`[spec] saved to ${target}`)
    } catch (e) {
      console.error(`[spec] failed to write ${target}:`, e.message)
    }
  }
}

function readJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return fallback }
}

function writeJSON(filePath, data) {
  try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8') } catch (e) { console.error('writeJSON failed:', filePath, e.message) }
}

function makeInitPayload() {
  const { projects: polarisProjects, obsidianVaultPath: polarisVaultPath } = readPolarisRegistry()
  return {
    type: 'init',
    projects: projects.map(safeProject),
    polarisProjects,
    polarisVaultPath,
    specQuestions: skills.getSpecQuestions(),
    testQuestions: skills.getTestQuestions(),
    skills: skills.list(),
    routines: routines.list(),
    config: maskedConfig(readConfig())
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

const clients = new Set()

function broadcast(data) {
  const msg = JSON.stringify(data)
  for (const ws of clients) {
    try { ws.send(msg) } catch (_) {}
  }
}

function sendTo(ws, data) {
  try { ws.send(JSON.stringify(data)) } catch (_) {}
}

function handleMessage(ws, msg) {
  if (msg.type === 'ping') { sendTo(ws, { type: 'pong' }); return }

  if (msg.type === 'get-state') {
    sendTo(ws, makeInitPayload())
    return
  }

  if (msg.type === 'create-project') {
    if (!msg.name || !msg.name.trim()) { sendTo(ws, { type: 'error', message: 'Project name required' }); return }
    const project = createProject(msg.name.trim(), msg.workDir || null, msg.polarisProjectName || null)
    broadcast({ type: 'project-created', project: safeProject(project) })
    return
  }

  if (msg.type === 'link-polaris-project') {
    const project = findProject(msg.projectId)
    if (!project) return
    project.workDir = msg.workDir || null
    project.polarisProjectName = msg.polarisProjectName || null
    saveProjects()
    broadcast({ type: 'project-updated', project: safeProject(project) })
    return
  }

  if (msg.type === 'update-spec') {
    const project = findProject(msg.projectId)
    if (!project) return
    project.spec.answers = { ...project.spec.answers, ...msg.answers }
    const specSkill = skills.get('spec-interview')
    const wasComplete = project.spec.complete
    project.spec.complete = specSkill ? specSkill.isComplete(project.spec.answers) : false
    if (project.status === 'specifying' && project.spec.complete) project.status = 'spec-complete'
    saveProjects()
    if (project.spec.complete && !wasComplete) saveSpecDocument(project)
    broadcast({ type: 'project-updated', project: safeProject(project) })
    return
  }

  if (msg.type === 'delete-project') {
    const idx = projects.findIndex(p => p.id === msg.projectId)
    if (idx < 0) return
    projects.splice(idx, 1)
    saveProjects()
    broadcast({ type: 'project-deleted', projectId: msg.projectId })
    return
  }

  if (msg.type === 'update-test-criteria') {
    const project = findProject(msg.projectId)
    if (!project) return
    project.testCriteria.answers = { ...project.testCriteria.answers, ...msg.answers }
    const tcSkill = skills.get('test-criteria')
    project.testCriteria.complete = tcSkill ? tcSkill.isComplete(project.testCriteria.answers) : false
    saveProjects()
    broadcast({ type: 'project-updated', project: safeProject(project) })
    return
  }

  if (msg.type === 'stop-pipeline') {
    const project = findProject(msg.projectId)
    if (!project) return
    killActive(msg.projectId)
    project.status = 'stopped'
    saveProjects()
    broadcast({ type: 'pipeline-stopped', projectId: msg.projectId })
    broadcast({ type: 'project-updated', project: safeProject(project) })
    return
  }

  if (msg.type === 'start-pipeline') {
    const project = findProject(msg.projectId)
    if (!project) { sendTo(ws, { type: 'error', message: 'Project not found' }); return }
    runPipeline(msg.projectId, msg.routine || 'full-pipeline', msg.modelTier).catch(err => {
      broadcast({ type: 'error', message: err.message })
    })
    return
  }

  if (msg.type === 'run-skill') {
    const project = findProject(msg.projectId)
    const skill = skills.get(msg.skillName)
    if (!project || !skill || skill.type === 'ui') return
    const config = readConfig()
    const { projects: polarisProjects, obsidianVaultPath } = readPolarisRegistry()
    skill.run({
      project, config, projectsDir: PROJECTS_DIR, polarisProjects, obsidianVaultPath,
      emit: (data) => broadcast({ type: 'agent-line', projectId: project.id, stage: skill.name, ...data })
    }).then(() => {
      saveProjects()
      broadcast({ type: 'project-updated', project: safeProject(project) })
    }).catch(err => broadcast({ type: 'error', message: err.message }))
    return
  }

  if (msg.type === 'run-routine') {
    if (!msg.projectId) { sendTo(ws, { type: 'error', message: 'projectId required' }); return }
    runPipeline(msg.projectId, msg.routineName).catch(err => {
      broadcast({ type: 'error', message: err.message })
    })
    return
  }

  if (msg.type === 'save-config') {
    saveConfig(msg.config || {})
    sendTo(ws, { type: 'config', config: maskedConfig(readConfig()) })
    return
  }

  if (msg.type === 'get-config') {
    sendTo(ws, { type: 'config', config: maskedConfig(readConfig()) })
    return
  }

  if (msg.type === 'pick-directory') {
    const requestId = `req_${Date.now()}`
    pendingDirPicks.set(requestId, ws)
    process.send({ type: 'pick-directory', requestId, defaultPath: msg.defaultPath || FACTORY_DIR })
    return
  }
}

const pendingDirPicks = new Map()

process.on('message', (msg) => {
  if (msg.type === 'directory-picked') {
    const ws = pendingDirPicks.get(msg.requestId)
    pendingDirPicks.delete(msg.requestId)
    if (ws) sendTo(ws, { type: 'directory-picked', requestId: msg.requestId, dirPath: msg.dirPath })
  }
})

// ── HTTP + WS Servers ─────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return }
  try {
    const html = fs.readFileSync(MOCKUP_DEST, 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  } catch {
    res.writeHead(500)
    res.end('UI not found')
  }
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  clients.add(ws)
  sendTo(ws, makeInitPayload())
  ws.on('message', (raw) => {
    try { handleMessage(ws, JSON.parse(raw.toString())) } catch (_) {}
  })
  ws.on('close', () => clients.delete(ws))
})

loadProjects()
server.listen(PORT, '127.0.0.1', () => {
  console.log(`AI Factory server running on http://127.0.0.1:${PORT}`)
  if (process.send) process.send({ type: 'server-ready' })
})
