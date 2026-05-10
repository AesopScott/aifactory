'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const testCriteria = require('./test-criteria')

const TEST_TIMEOUT_MS = 10 * 60 * 1000

module.exports = {
  name: 'test-runner',
  description: 'Tests the built project using a Claude CLI agent against the defined criteria',
  type: 'agent',

  async run({ project, config, model: contextModel, emit, projectsDir, polarisProjects, obsidianVaultPath, registerKill }) {
    const workDir = project.workDir || path.join(projectsDir, project.id, 'build')
    if (!fs.existsSync(workDir)) throw new Error('No build directory found. Check the target directory in Specifications.')

    const criteriaText = testCriteria.formatForPrompt(project.testCriteria.answers)
    const prompt = testPrompt(criteriaText, workDir, polarisProjects || [], obsidianVaultPath || '')
    const apiKey = config.openRouterApiKey || config.anthropicApiKey
    const model = contextModel || config.openRouterSonnetModel || 'anthropic/claude-sonnet-4-5'

    if (!apiKey) throw new Error('No API key configured. Add one in Settings.')

    emit({ text: `Starting test agent (model: ${model})...\n`, role: 'system' })

    const lines = await runClaudeAgent({ prompt, model, apiKey, workDir, emit, registerKill: registerKill || (() => {}) })

    const { passed, failed } = testCriteria.parseTestResults(lines)
    project.testLog = lines
    project.testResults = {
      passed,
      failed,
      summary: `${passed.length} passed, ${failed.length} failed`
    }

    emit({ text: `\nTest complete: ${project.testResults.summary}\n`, role: 'system' })
    return { passed, failed }
  }
}

function testPrompt(criteriaText, workDir, polarisProjects, obsidianVaultPath) {
  const lines = [
    'You are a QA engineer testing a software project that has already been built.',
    'Run the tests as defined in the criteria below.',
    'For each test, output exactly one of:',
    '  PASS: <test name>',
    '  FAIL: <test name> — <reason>',
    '',
    '## Test Criteria',
    criteriaText,
    '',
    '## Project Location',
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
    lines.push('')
  }

  lines.push(
    '## Instructions',
    '- Inspect the project files thoroughly before testing.',
    '- Run any test commands or scripts that exist.',
    '- Test manually where needed.',
    '- End with: "TEST COMPLETE: X passed, Y failed"'
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
      reject(new Error('Test agent timed out after 10 minutes'))
    }, TEST_TIMEOUT_MS)

    proc.on('close', (code) => {
      registerKill(null)
      clearTimeout(timer)
      emit({ text: `[debug] claude exited with code ${code}\n`, role: 'system' })
      if (code === 0 || code === null) {
        emit({ text: `[debug] test agent produced ${lines.length} output lines\n`, role: 'system' })
        resolve(lines)
      } else {
        const detail = stderrBuffer.trim() ? `\nStderr:\n${stderrBuffer.trim()}` : ''
        reject(new Error(`Test agent exited with code ${code}${detail}`))
      }
    })
  })
}