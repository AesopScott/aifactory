'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const specInterview = require('./spec-interview')

const BUILD_TIMEOUT_MS = 15 * 60 * 1000
const MAX_BUILD_ATTEMPTS = 3

module.exports = {
  name: 'project-builder',
  description: 'Builds the project using a Claude CLI agent guided by the project specification',
  type: 'agent',

  async run({ project, config, model: contextModel, emit, projectsDir, polarisProjects, obsidianVaultPath, registerKill }) {
    const workDir = project.workDir || path.join(projectsDir, project.id, 'build')
    fs.mkdirSync(workDir, { recursive: true })

    const specText = specInterview.formatForPrompt(project.spec.answers)
    const apiKey = config.openRouterApiKey || config.anthropicApiKey
    const model = contextModel || config.openRouterSonnetModel || 'anthropic/claude-sonnet-4-5'

    if (!apiKey) throw new Error('No API key configured. Add one in Settings.')

    emit({ text: `Starting build agent (model: ${model})...\n`, role: 'system' })
    emit({ text: `Working directory: ${workDir}\n`, role: 'system' })

    let allLines = []
    let lastError = null

    for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        emit({ text: `\nRetrying build (attempt ${attempt}/${MAX_BUILD_ATTEMPTS})...\n`, role: 'system' })
      }

      const prompt = buildPrompt(specText, workDir, polarisProjects || [], obsidianVaultPath || '', lastError)

      try {
        const lines = await runClaudeAgent({ prompt, model, apiKey, workDir, emit, registerKill: registerKill || (() => {}) })
        allLines = allLines.concat(lines)
        lastError = null
        break
      } catch (err) {
        lastError = err.message
        allLines = allLines.concat([`[Build attempt ${attempt} failed: ${err.message}]`])
        emit({ text: `\nBuild attempt ${attempt} failed: ${err.message}\n`, role: 'error' })
        if (attempt === MAX_BUILD_ATTEMPTS) {
          throw new Error(`Build failed after ${MAX_BUILD_ATTEMPTS} attempts. Last error: ${err.message}`)
        }
      }
    }

    await installDependencies(workDir, emit)

    project.builtFiles = listBuiltFiles(workDir)
    emit({ text: `\nGenerated ${project.builtFiles.length} files.\n`, role: 'system' })

    await gitAutoCommit(workDir, emit)

    project.buildLog = allLines
    emit({ text: '\nBuild agent finished.\n', role: 'system' })
    return { workDir, lineCount: allLines.length }
  }
}

function buildPrompt(specText, workDir, polarisProjects, obsidianVaultPath, previousError) {
  const lines = [
    'You are a senior software engineer building a complete project from the following specification.',
    'Create ALL files necessary for the project to work. Do not leave placeholders or TODOs.',
    'The project must be fully functional when you are done.',
    '',
    '## Project Specification',
    specText,
    '',
    '## Working Directory',
    workDir,
    ''
  ]

  if (previousError) {
    lines.push('## Previous Build Error')
    lines.push('The previous build attempt failed. Fix all issues before finishing:')
    lines.push(previousError)
    lines.push('')
  }

  if (polarisProjects.length > 0) {
    lines.push('## All Available Project Directories')
    lines.push('You have full read/write access to all of these directories:')
    for (const p of polarisProjects) {
      lines.push(`- ${p.name}: ${p.workDir}`)
    }
    lines.push('')
  }

  if (obsidianVaultPath) {
    lines.push('## Obsidian Vault')
    lines.push(`Path: ${obsidianVaultPath}`)
    lines.push('Write spec documents and build results here when relevant.')
    lines.push('')
  }

  lines.push(
    '## Instructions',
    '- Create every file the project needs (source, config, package.json, README, etc.)',
    '- Follow the spec exactly. Do not add features not specified.',
    '- Use conventional commits style for any git operations.',
    '- When done, output a summary: "BUILD COMPLETE: <one sentence summary>"'
  )

  return lines.join('\n')
}

function installDependencies(workDir, emit) {
  const managers = [
    { file: 'package.json', cmd: 'npm install', label: 'npm' },
    { file: 'requirements.txt', cmd: 'pip install -r requirements.txt', label: 'pip' },
    { file: 'Gemfile', cmd: 'bundle install', label: 'bundler' },
    { file: 'go.mod', cmd: 'go mod download', label: 'go' },
  ]

  return managers.reduce((chain, { file, cmd, label }) => {
    return chain.then(() => {
      if (!fs.existsSync(path.join(workDir, file))) return
      emit({ text: `Installing dependencies (${label})...\n`, role: 'system' })
      return runCommand(cmd, workDir, emit, label)
    })
  }, Promise.resolve())
}

function listBuiltFiles(workDir) {
  const results = []
  function walk(dir, prefix) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
      else results.push(rel)
    }
  }
  walk(workDir, '')
  return results
}

async function gitAutoCommit(workDir, emit) {
  const isRepo = fs.existsSync(path.join(workDir, '.git'))
  if (!isRepo) {
    emit({ text: 'Initializing git repo and committing generated files...\n', role: 'system' })
    await runCommand('git init && git add -A && git commit -m "feat: initial build by AI Factory"', workDir, emit, 'git')
  } else {
    emit({ text: 'Committing generated files...\n', role: 'system' })
    await runCommand('git add -A && git commit -m "feat: build by AI Factory" --allow-empty', workDir, emit, 'git')
  }
}

function runCommand(cmd, cwd, emit, label) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, [], { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    proc.stdout.on('data', (chunk) => emit({ text: chunk.toString(), role: 'system' }))
    proc.stderr.on('data', (chunk) => emit({ text: chunk.toString(), role: 'error' }))
    proc.on('close', (code) => {
      if (code !== 0) emit({ text: `${label} exited with code ${code} — continuing\n`, role: 'error' })
      else emit({ text: `${label} complete.\n`, role: 'system' })
      resolve()
    })
  })
}

function runClaudeAgent({ prompt, model, apiKey, workDir, emit, registerKill }) {
  return new Promise((resolve, reject) => {
    const args = [
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '-p', prompt
    ]
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_API_KEY: ''
    }

    emit({ text: `[debug] model: ${model}\n`, role: 'system' })
    emit({ text: `[debug] workDir: ${workDir}\n`, role: 'system' })
    emit({ text: `[debug] prompt length: ${prompt.length} chars\n`, role: 'system' })
    emit({ text: `[debug] base URL: ${env.ANTHROPIC_BASE_URL}\n`, role: 'system' })
    emit({ text: `[debug] API key present: ${!!apiKey}\n`, role: 'system' })

    const proc = spawn('claude', args, { shell: true, cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    emit({ text: `[debug] spawned claude PID: ${proc.pid}\n`, role: 'system' })
    registerKill(() => proc.kill())

    const lines = []
    let buffer = ''
    let stderrBuffer = ''

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      const parts = buffer.split('\n')
      buffer = parts.pop()
      for (const part of parts) {
        if (!part.trim()) continue
        try {
          const event = JSON.parse(part)
          if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
            for (const block of event.message.content) {
              if (block.type === 'text') {
                emit({ text: block.text, role: 'assistant' })
                lines.push(block.text)
              }
            }
          }
        } catch (_) {}
      }
    })

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderrBuffer += text
      emit({ text, role: 'error' })
    })

    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('Build agent timed out after 15 minutes'))
    }, BUILD_TIMEOUT_MS)

    proc.on('close', (code) => {
      registerKill(null)
      clearTimeout(timer)
      emit({ text: `[debug] claude exited with code ${code}\n`, role: 'system' })
      if (code === 0 || code === null) {
        emit({ text: `[debug] build agent produced ${lines.length} output lines\n`, role: 'system' })
        resolve(lines)
      } else {
        const detail = stderrBuffer.trim() ? `\nStderr:\n${stderrBuffer.trim()}` : ''
        reject(new Error(`Build agent exited with code ${code}${detail}`))
      }
    })
  })
}
