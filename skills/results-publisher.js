'use strict'

const fs = require('fs')
const path = require('path')

module.exports = {
  name: 'results-publisher',
  description: 'Formats build and test results and writes them to Obsidian',
  type: 'utility',

  async run({ project, config, emit, obsidianVaultPath }) {
    const vaultPath = config.obsidianVaultPath || obsidianVaultPath || ''
    if (!vaultPath) {
      emit({ text: 'No Obsidian vault configured — skipping publish. Set vault path in Settings.\n', role: 'system' })
      return { published: false }
    }

    const outDir = path.join(vaultPath, 'AIFactory_Results')
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

    const safeName = project.name.replace(/[^a-zA-Z0-9_\- ]/g, '').trim()
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `${safeName} ${timestamp}.md`
    const outPath = path.join(outDir, filename)

    const content = formatResults(project)
    fs.writeFileSync(outPath, content, 'utf8')

    project.obsidianPath = outPath
    emit({ text: `Results published to Obsidian: ${outPath}\n`, role: 'system' })
    return { published: true, path: outPath }
  }
}

function formatResults(project) {
  const results = project.testResults || {}
  const passed = results.passed || []
  const failed = results.failed || []
  const total = passed.length + failed.length
  const score = total > 0 ? Math.round((passed.length / total) * 100) : 0

  const lines = [
    `# ${project.name} — Build Results`,
    ``,
    `**Date:** ${new Date().toLocaleString()}`,
    `**Status:** ${project.status}`,
    `**Score:** ${score}% (${passed.length}/${total} tests passed)`,
    ``,
    `## Specification`,
    formatAnswers(project.spec?.answers || {}),
    ``,
    `## Test Criteria`,
    formatAnswers(project.testCriteria?.answers || {}),
    ``,
    `## Test Results`,
    ``,
  ]

  if (passed.length > 0) {
    lines.push('### Passed')
    for (const t of passed) lines.push(`- ✅ ${t}`)
    lines.push('')
  }

  if (failed.length > 0) {
    lines.push('### Failed')
    for (const t of failed) lines.push(`- ❌ ${t}`)
    lines.push('')
  }

  if (project.buildLog?.length > 0) {
    lines.push('## Build Log')
    lines.push('```')
    lines.push(...project.buildLog.slice(-50))
    lines.push('```')
    lines.push('')
  }

  return lines.join('\n')
}

function formatAnswers(answers) {
  return Object.entries(answers)
    .filter(([, v]) => v)
    .map(([k, v]) => `**${k}:** ${v}`)
    .join('\n')
}
