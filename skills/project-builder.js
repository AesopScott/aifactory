'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const specInterview = require('./spec-interview')

const BUILD_TIMEOUT_MS = 15 * 60 * 1000

module.exports = {
  name: 'project-builder',
  description: 'Builds the project using a Claude CLI agent guided by the project specification',
  type: 'agent',

  async run({ project, config, model: contextModel, emit, projectsDir, polarisProjects, obsidianVaultPath, registerKill }) {
    const workDir = project.workDir || path.join(projectsDir, project.id, 'build')
    fs.mkdirSync(workDir, { recursive: true })

    const specText = specInterview.formatForPrompt(project.spec.answers)
    const prompt = buildPrompt(specText, workDir, polarisProjects || [], obsidianVaultPath || '')
    const apiKey = config.openRouterApiKey || config.anthropicApiKey
    const model = contextModel || config.openRouterSonnetModel || 'anthropic/claude-sonnet-4-5'

    if (!apiKey) throw new Error('No API key configured. Add one in Settings.')

    emit({ text: `Starting build agent (model: ${model})...\n`, role: 'system' })
    emit({ text: `Working directory: ${workDir}\n`, role: 'system' })

    const lines = await runClaudeAgent({ prompt, model, apiKey, workDir, emit, registerKill: registerKill || (() => {}) })

    project.buildLog = lines
    emit({ text: '\nBuild agent finished.\n', role: 'system' })
    return { workDir, lineCount: lines.length }
  }
}

function buildPrompt(specText, workDir, polarisProjects, obsidianVaultPath) {
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