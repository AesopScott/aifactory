'use strict'

// Direct OpenRouter agent for AI Factory build/test skills.
// Replaces the Claude CLI spawn path. Runs the agent loop natively in Node:
//   - POSTs to https://openrouter.ai/api/v1/chat/completions (streaming)
//   - Parses SSE delta events, accumulates assistant text + tool calls
//   - Dispatches tool calls server-side, appends tool results, iterates
//   - Caps at MAX_ITERATIONS to prevent runaway loops
//
// Tools mirror Polaris's runDirectAgent shapes (Read, Write, Edit, Glob, Grep,
// Bash, PowerShell) but trimmed: no cross-check, no version bumping, no locks,
// no project memory. Writes are confined to workDir — assertWritable refuses
// any path outside the build's working directory, so a misconfigured project
// record can't clobber an unrelated repo.

const https = require('https')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const MAX_ITERATIONS = 60
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000
const TOOL_BASH_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const TOOL_RESULT_PREVIEW_CHARS = 600

// ── Tool schemas (OpenAI function-calling format) ────────────────────────────

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a text file from the filesystem. Returns up to 2000 lines by default.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or workDir-relative path.' },
          offset: { type: 'integer', description: 'Line number to start from (0-based). Optional.' },
          limit: { type: 'integer', description: 'Max lines to return. Optional.' }
        },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write a file. Overwrites if it exists. Path must be inside the working directory.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['file_path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Edit',
      description: 'Replace exact string in a file. old_string must match exactly once unless replace_all is true.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' }
        },
        required: ['file_path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'Find files by glob pattern. Returns up to 250 paths sorted by mtime descending.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Optional search root. Defaults to workDir.' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Search file contents with a regex. Use output_mode "content" for matching lines, "files_with_matches" for paths only.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          glob: { type: 'string' },
          output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Run a shell command. On Windows runs via cmd.exe. Timeout in ms (default 300000).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout: { type: 'integer' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'PowerShell',
      description: 'Run a PowerShell command. Timeout in ms (default 300000).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout: { type: 'integer' }
        },
        required: ['command']
      }
    }
  }
]

// ── Path safety ──────────────────────────────────────────────────────────────

function resolveInsideWorkDir(filePath, workDir) {
  if (!filePath) throw new Error('file_path required')
  const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workDir, filePath)
  const wd = path.resolve(workDir)
  // Case-insensitive prefix match for Windows
  const a = absolute.toLowerCase()
  const w = wd.toLowerCase()
  if (a !== w && !a.startsWith(w + path.sep.toLowerCase()) && !a.startsWith(w + '\\') && !a.startsWith(w + '/')) {
    throw new Error(`Path outside working directory rejected: ${absolute} (workDir: ${wd})`)
  }
  return absolute
}

function resolveReadable(filePath, workDir) {
  // Reads are allowed anywhere readable on the system. Return absolute path.
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workDir, filePath)
}

// ── Tool implementations ─────────────────────────────────────────────────────

function toolRead({ file_path, offset, limit }, workDir) {
  const abs = resolveReadable(file_path, workDir)
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`)
  const stat = fs.statSync(abs)
  if (!stat.isFile()) throw new Error(`Not a file: ${abs}`)
  if (stat.size > 5 * 1024 * 1024) throw new Error(`File too large (${stat.size} bytes): ${abs}`)
  const content = fs.readFileSync(abs, 'utf8')
  const lines = content.split('\n')
  const start = Math.max(0, offset || 0)
  const end = limit ? Math.min(lines.length, start + limit) : Math.min(lines.length, start + 2000)
  const slice = lines.slice(start, end)
  return slice.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join('\n')
}

async function toolWrite({ file_path, content }, workDir) {
  const abs = resolveInsideWorkDir(file_path, workDir)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
  return `Wrote ${content.length} chars to ${abs}`
}

async function toolEdit({ file_path, old_string, new_string, replace_all }, workDir) {
  const abs = resolveInsideWorkDir(file_path, workDir)
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`)
  const original = fs.readFileSync(abs, 'utf8')
  if (old_string === new_string) throw new Error('old_string and new_string are identical')
  let updated
  if (replace_all) {
    if (!original.includes(old_string)) throw new Error('old_string not found in file')
    updated = original.split(old_string).join(new_string)
  } else {
    const idx = original.indexOf(old_string)
    if (idx === -1) throw new Error('old_string not found in file')
    const next = original.indexOf(old_string, idx + old_string.length)
    if (next !== -1) throw new Error('old_string is not unique. Use replace_all or include more context.')
    updated = original.slice(0, idx) + new_string + original.slice(idx + old_string.length)
  }
  fs.writeFileSync(abs, updated, 'utf8')
  return `Edited ${abs}`
}

function toolGlob({ pattern, path: searchPath }, workDir) {
  const root = searchPath ? resolveReadable(searchPath, workDir) : workDir
  const results = []
  const limit = 250
  const skipDirs = new Set(['node_modules', '.git', 'dist', '.next', '.venv', '__pycache__'])

  // Convert simple glob to regex. Supports **, *, ?
  const re = globToRegex(pattern)

  function walk(dir, rel) {
    if (results.length >= limit) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (results.length >= limit) return
      if (skipDirs.has(entry.name)) continue
      const subRel = rel ? `${rel}/${entry.name}` : entry.name
      const subAbs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(subAbs, subRel)
      } else if (entry.isFile()) {
        if (re.test(subRel) || re.test(entry.name)) {
          let mtime = 0
          try { mtime = fs.statSync(subAbs).mtimeMs } catch {}
          results.push({ path: subAbs, mtime })
        }
      }
    }
  }

  walk(root, '')
  results.sort((a, b) => b.mtime - a.mtime)
  return results.slice(0, limit).map(r => r.path).join('\n') || '(no matches)'
}

function globToRegex(glob) {
  // Escape regex specials except glob ones
  let out = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i += 2; if (glob[i] === '/') i++ }
      else { out += '[^/]*'; i++ }
    } else if (c === '?') { out += '.'; i++ }
    else if (c === '.') { out += '\\.'; i++ }
    else if ('+^$(){}|[]\\'.includes(c)) { out += '\\' + c; i++ }
    else { out += c; i++ }
  }
  return new RegExp('(^|/)' + out + '$', 'i')
}

function toolGrep({ pattern, path: searchPath, glob, output_mode }, workDir) {
  const root = searchPath ? resolveReadable(searchPath, workDir) : workDir
  const mode = output_mode || 'files_with_matches'
  const re = new RegExp(pattern, 'i')
  const globRe = glob ? globToRegex(glob) : null
  const skipDirs = new Set(['node_modules', '.git', 'dist', '.next', '.venv', '__pycache__'])
  const filesMatched = []
  const contentLines = []
  let matchCount = 0
  const lineLimit = 200
  const fileLimit = 200

  function walk(dir, rel) {
    if (filesMatched.length >= fileLimit || contentLines.length >= lineLimit) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (filesMatched.length >= fileLimit || contentLines.length >= lineLimit) return
      if (skipDirs.has(entry.name)) continue
      const subRel = rel ? `${rel}/${entry.name}` : entry.name
      const subAbs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(subAbs, subRel)
      } else if (entry.isFile()) {
        if (globRe && !globRe.test(subRel) && !globRe.test(entry.name)) continue
        let stat
        try { stat = fs.statSync(subAbs) } catch { continue }
        if (stat.size > 2 * 1024 * 1024) continue
        let content
        try { content = fs.readFileSync(subAbs, 'utf8') } catch { continue }
        const lines = content.split('\n')
        let fileHit = false
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            fileHit = true
            matchCount++
            if (mode === 'content' && contentLines.length < lineLimit) {
              contentLines.push(`${subAbs}:${i + 1}: ${lines[i]}`)
            }
          }
        }
        if (fileHit) filesMatched.push(subAbs)
      }
    }
  }

  walk(root, '')

  if (mode === 'count') return `${matchCount} matches across ${filesMatched.length} files`
  if (mode === 'content') return contentLines.join('\n') || '(no matches)'
  return filesMatched.join('\n') || '(no matches)'
}

function runShell(shell, args, command, workDir, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(shell, args, { cwd: workDir, shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try { proc.kill('SIGKILL') } catch {}
    }, timeoutMs)
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.stdin.write(command)
    proc.stdin.end()
    proc.on('close', (code) => {
      clearTimeout(timer)
      const trimmedOut = stdout.length > 50000 ? stdout.slice(0, 50000) + `\n[truncated ${stdout.length - 50000} chars]` : stdout
      const trimmedErr = stderr.length > 10000 ? stderr.slice(0, 10000) + `\n[truncated]` : stderr
      let result = `exit code: ${code}${killed ? ' (KILLED — timeout)' : ''}\n--- stdout ---\n${trimmedOut}`
      if (trimmedErr.trim()) result += `\n--- stderr ---\n${trimmedErr}`
      resolve(result)
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve(`spawn error: ${err.message}`)
    })
  })
}

async function toolBash({ command, timeout }, workDir) {
  const t = timeout || TOOL_BASH_DEFAULT_TIMEOUT_MS
  if (process.platform === 'win32') {
    return runShell('cmd.exe', ['/Q', '/D', '/C', command], '', workDir, t)
  }
  return runShell('/bin/bash', ['-c', command], '', workDir, t)
}

async function toolPowerShell({ command, timeout }, workDir) {
  const t = timeout || TOOL_BASH_DEFAULT_TIMEOUT_MS
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
  return runShell(shell, ['-NoProfile', '-NonInteractive', '-Command', '-'], command, workDir, t)
}

// ── Tool dispatch ────────────────────────────────────────────────────────────

async function executeTool(name, input, workDir) {
  switch (name) {
    case 'Read': return toolRead(input, workDir)
    case 'Write': return await toolWrite(input, workDir)
    case 'Edit': return await toolEdit(input, workDir)
    case 'Glob': return toolGlob(input, workDir)
    case 'Grep': return toolGrep(input, workDir)
    case 'Bash': return await toolBash(input, workDir)
    case 'PowerShell': return await toolPowerShell(input, workDir)
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

// ── OpenRouter streaming call ────────────────────────────────────────────────

function callOpenRouter({ messages, model, apiKey, tools }) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      messages,
      tools,
      stream: true,
      temperature: 0.2
    })

    const req = https.request({
      method: 'POST',
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://aifactory.local',
        'X-Title': 'AI Factory',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: REQUEST_TIMEOUT_MS
    }, (res) => {
      if (res.statusCode !== 200) {
        let errBody = ''
        res.on('data', d => { errBody += d.toString() })
        res.on('end', () => {
          resolve({ error: `HTTP ${res.statusCode}: ${errBody.slice(0, 1000)}`, text: '', toolCalls: [] })
        })
        return
      }

      let buffer = ''
      let textAccum = ''
      const toolCallsByIndex = {}

      res.on('data', (chunk) => {
        buffer += chunk.toString()
        const parts = buffer.split('\n')
        buffer = parts.pop()
        for (const part of parts) {
          const trimmed = part.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') continue
          let evt
          try { evt = JSON.parse(data) } catch { continue }
          const delta = evt.choices?.[0]?.delta
          if (!delta) continue
          if (typeof delta.content === 'string' && delta.content) {
            textAccum += delta.content
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!toolCallsByIndex[idx]) toolCallsByIndex[idx] = { id: '', name: '', arguments: '' }
              if (tc.id) toolCallsByIndex[idx].id = tc.id
              if (tc.function?.name) toolCallsByIndex[idx].name = tc.function.name
              if (tc.function?.arguments) toolCallsByIndex[idx].arguments += tc.function.arguments
            }
          }
        }
      })

      res.on('end', () => {
        const toolCalls = Object.keys(toolCallsByIndex).sort((a, b) => +a - +b).map(k => toolCallsByIndex[k])
        resolve({ text: textAccum, toolCalls, error: null })
      })

      res.on('error', (err) => {
        resolve({ error: `stream error: ${err.message}`, text: textAccum, toolCalls: [] })
      })
    })

    req.on('error', (err) => {
      resolve({ error: `request error: ${err.message}`, text: '', toolCalls: [] })
    })
    req.on('timeout', () => {
      try { req.destroy() } catch {}
      resolve({ error: 'request timeout', text: '', toolCalls: [] })
    })

    req.write(body)
    req.end()
  })
}

// ── Agent loop ───────────────────────────────────────────────────────────────

async function runDirectAgent({ prompt, model, apiKey, workDir, emit, registerKill, systemPrompt }) {
  if (!apiKey) throw new Error('No API key supplied to direct-agent')
  if (!model) throw new Error('No model supplied to direct-agent')
  if (!fs.existsSync(workDir)) throw new Error(`workDir does not exist: ${workDir}`)

  emit({ text: `[direct-agent] model: ${model}\n`, role: 'system' })
  emit({ text: `[direct-agent] workDir: ${workDir}\n`, role: 'system' })
  emit({ text: `[direct-agent] prompt length: ${prompt.length} chars\n`, role: 'system' })

  const finalSystem = systemPrompt || defaultSystemPrompt(workDir)

  const messages = [
    { role: 'system', content: finalSystem },
    { role: 'user', content: prompt }
  ]

  const lines = []
  let aborted = false
  if (registerKill) registerKill(() => { aborted = true })

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    if (aborted) {
      emit({ text: '[direct-agent] aborted\n', role: 'system' })
      throw new Error('Agent aborted')
    }

    const result = await callOpenRouter({ messages, model, apiKey, tools: TOOL_SCHEMAS })

    if (result.error) {
      emit({ text: `[direct-agent] API error (iter ${iter}): ${result.error}\n`, role: 'error' })
      // simple retry with backoff for first 2 attempts
      if (iter <= 2) {
        await new Promise(r => setTimeout(r, 2000 * iter))
        continue
      }
      throw new Error(`Direct agent API error: ${result.error}`)
    }

    const { text, toolCalls } = result

    if (text && text.trim()) {
      emit({ text, role: 'assistant' })
      lines.push(text)
    }

    if (!toolCalls || toolCalls.length === 0) {
      // Terminal text response — done.
      return { lines, iterations: iter }
    }

    // Append assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: text || '',
      tool_calls: toolCalls.map(tc => ({
        id: tc.id || `call_${iter}_${tc.name}`,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments || '{}' }
      }))
    })

    // Execute each tool call and append results
    for (const tc of toolCalls) {
      const argsStr = tc.arguments || '{}'
      let args
      try { args = JSON.parse(argsStr) } catch (e) {
        const errMsg = `tool argument parse error: ${e.message}`
        emit({ text: `[tool] ${tc.name} parse error\n`, role: 'tool' })
        messages.push({ role: 'tool', tool_call_id: tc.id || `call_${iter}_${tc.name}`, content: errMsg })
        continue
      }

      emit({ text: `[tool] ${tc.name} ${summarizeArgs(args)}\n`, role: 'tool' })
      let toolResult
      try {
        toolResult = await executeTool(tc.name, args, workDir)
      } catch (err) {
        toolResult = `ERROR: ${err.message}`
      }
      const preview = String(toolResult).slice(0, TOOL_RESULT_PREVIEW_CHARS)
      emit({ text: `[tool] ↳ ${preview}${String(toolResult).length > TOOL_RESULT_PREVIEW_CHARS ? '…' : ''}\n`, role: 'tool' })
      messages.push({
        role: 'tool',
        tool_call_id: tc.id || `call_${iter}_${tc.name}`,
        content: String(toolResult).slice(0, 80000)
      })
    }
  }

  emit({ text: `[direct-agent] hit MAX_ITERATIONS (${MAX_ITERATIONS})\n`, role: 'error' })
  return { lines, iterations: MAX_ITERATIONS, truncated: true }
}

function summarizeArgs(args) {
  try {
    if (args.file_path) return args.file_path
    if (args.pattern) return `pattern=${args.pattern}`
    if (args.command) return args.command.split('\n')[0].slice(0, 100)
    return JSON.stringify(args).slice(0, 100)
  } catch { return '' }
}

function defaultSystemPrompt(workDir) {
  return [
    'You are an AI Factory build agent. Use the provided tools to read, write, and run code.',
    '',
    'Rules:',
    '- The working directory is: ' + workDir,
    '- All file writes must stay inside this directory.',
    '- Use Glob and Grep to discover existing files before assuming structure.',
    '- Use Bash or PowerShell to run install commands and tests.',
    '- When the task is complete, output a final text response (no further tool calls) summarizing what you did.',
    '- Be concise. Do not narrate every tool call in prose — the framework already logs them.'
  ].join('\n')
}

module.exports = {
  runDirectAgent,
  TOOL_SCHEMAS,
  // export for tests
  _internal: { resolveInsideWorkDir, toolRead, toolWrite, toolEdit, toolGlob, toolGrep }
}
