'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')
const testCriteria = require('./test-criteria')
const { runDirectAgent } = require('./lib/direct-agent')

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

    const result = await runDirectAgent({ prompt, model, apiKey, workDir, emit, registerKill: registerKill || (() => {}) })
    const lines = result.lines || []
    if (lines.length === 0) {
      throw new Error('Test agent produced no output (zero assistant lines).')
    }

    const { passed, failed } = testCriteria.parseTestResults(lines)

    const platform = project.spec?.answers?.platform || ''
    if (platform.includes('Web App')) {
      const httpResults = await httpSmokeTest(workDir, project.spec.answers, emit)
      for (const r of httpResults) {
        if (r.pass) passed.push(r.name)
        else failed.push(`${r.name} — ${r.reason}`)
      }
    }

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

function httpSmokeTest(workDir, specAnswers, emit) {
  return new Promise((resolve) => {
    const pkgPath = path.join(workDir, 'package.json')
    if (!fs.existsSync(pkgPath)) return resolve([])

    let pkg
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) } catch (_) { return resolve([]) }
    if (!pkg.scripts?.start) return resolve([])

    const urlSpec = (specAnswers.webpage_url || '').trim()
    const portMatch = urlSpec.match(/:(\d+)/)
    const port = portMatch ? parseInt(portMatch[1]) : 3000
    const url = urlSpec.startsWith('http') ? urlSpec : `http://localhost:${port}`

    emit({ text: `\n[HTTP smoke test] Starting app on port ${port}...\n`, role: 'system' })

    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.PORT = String(port)

    const proc = spawn('npm start', [], { shell: true, cwd: workDir, stdio: 'ignore', env })

    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      clearInterval(pollTimer)
      clearTimeout(giveUpTimer)
      proc.kill()
      resolve(result)
    }

    const giveUpTimer = setTimeout(() => {
      emit({ text: `[HTTP smoke test] App did not start within 30s\n`, role: 'error' })
      settle([{ name: `HTTP smoke test: GET ${url}`, pass: false, reason: 'App did not start within 30s' }])
    }, 30000)

    const pollTimer = setInterval(() => {
      const req = http.get(url, (res) => {
        res.resume()
        const ok = res.statusCode < 400
        emit({ text: `[HTTP smoke test] ${ok ? '✓' : '✗'} ${url} → ${res.statusCode}\n`, role: 'system' })
        settle([{ name: `HTTP smoke test: GET ${url}`, pass: ok, reason: ok ? '' : `HTTP ${res.statusCode}` }])
      })
      req.on('error', () => {})
      req.setTimeout(1000, () => req.destroy())
    }, 1000)
  })
}

// runClaudeAgent (Claude CLI spawn path) was removed in v1.0.22.
// AI Factory now runs agents directly against OpenRouter via lib/direct-agent.
