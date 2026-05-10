'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const specInterview = require('./spec-interview')
const { runDirectAgent } = require('./lib/direct-agent')

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
    let agentSucceeded = false

    for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        emit({ text: `\nRetrying build (attempt ${attempt}/${MAX_BUILD_ATTEMPTS})...\n`, role: 'system' })
      }

      const prompt = buildPrompt(specText, workDir, polarisProjects || [], obsidianVaultPath || '', lastError)

      try {
        const result = await runDirectAgent({ prompt, model, apiKey, workDir, emit, registerKill: registerKill || (() => {}) })
        const lines = result.lines || []
        // Silent-failure gate: agent must produce at least one assistant text line.
        // A zero-line return means the model emitted no usable output (auth fail,
        // empty response, etc.). Without this gate the v1.0.21 incident shipped:
        // gitAutoCommit ran on Aesop's pre-existing files, producing a 2780-file
        // phantom "build" commit even though the agent never actually wrote anything.
        if (lines.length === 0) {
          throw new Error('Agent produced no output (zero assistant lines). Refusing to proceed to install/commit.')
        }
        allLines = allLines.concat(lines)
        lastError = null
        agentSucceeded = true
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

    if (!agentSucceeded) {
      throw new Error('Build agent did not succeed — skipping install and commit.')
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

// runClaudeAgent (Claude CLI spawn path) was removed in v1.0.22.
// AI Factory now runs agents directly against OpenRouter via lib/direct-agent.
