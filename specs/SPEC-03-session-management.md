# SPEC-03 — Session Management

## Purpose

Covers the full lifecycle of an agent session: creation, process spawn, stream parsing, timeout enforcement, file watching, and shutdown. This is the core of what makes Polaris work — everything else is presentation.

---

## Session Object Shape

```js
{
  id:             'string',      // e.g. 's_1746123456789'
  name:           'string',      // auto-generated from prompt
  workDir:        'string|null', // absolute path, or null for chat-dir fallback
  projectName:    'string|null', // from Projects panel
  model:          'string|null', // resolved model string
  isChat:         false,         // true = chat session, false = agent session
  status:         'running|done|error',
  startAt:        number,        // Date.now()
  endAt:          number|null,
  claudeSessionId: 'string|null', // captured from Claude result event, used for --resume
  lastPrompt:     'string|null',
  firstOutputAt:  number|null,   // for SPACE E (efficiency) scoring
  outputTokens:   number|null,   // from result event usage.output_tokens
  height:         'string|null', // e.g. '340px' — persisted card height
  column:         number|null,   // 0/1/2 — persisted grid column
  lines:          [],            // { role, text } — last 500 lines
  proc:           ChildProcess|null,
  watcher:        FSWatcher|null,
  timeout:        Timer|null,
  req:            http.ClientRequest|null, // for chat HTTP abort
  chatBuffer:     'string',      // accumulates partial SSE chunks
}
```

---

## Agent Session Spawn (Claude CLI)

```js
function spawnClaude(sessionId, prompt, workDir, resumeId = null, model = null) {
  const session = sessions.get(sessionId);
  if (!session) return;

  addToHistory(prompt);

  const config = readConfig();
  if (!config.openRouterApiKey) {
    broadcast({ type: 'line', sessionId, text: 'No OpenRouter API key configured.', role: 'error' });
    broadcast({ type: 'session-status', sessionId, status: 'error' });
    return;
  }

  // Build CLI args
  const args = ['--output-format', 'stream-json', '--verbose'];
  if (resumeId) args.push('--resume', resumeId);
  const effectiveModel = model || config.openRouterFloorModel || 'openrouter/auto';
  args.push('--model', effectiveModel);
  args.push('--append-system-prompt', buildSystemPrompt(config));
  args.push('-p', prompt);

  // OpenRouter routing (see SPEC-04 for the critical env var fix)
  const spawnEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL:   'https://openrouter.ai/api',
    ANTHROPIC_AUTH_TOKEN: config.openRouterApiKey,
    ANTHROPIC_API_KEY:    '',
  };

  const proc = spawn('claude', args, {
    cwd: workDir,
    env: spawnEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,   // CRITICAL — must be true so cmd.exe resolves claude on PATH
  });

  session.proc    = proc;
  session.status  = 'running';
  session.startAt = Date.now();

  // Stream parsing with line buffer
  let lineBuffer = '';
  proc.stdout.on('data', chunk => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop();  // last incomplete line stays in buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleStreamEvent(sessionId, msg);
      } catch {
        broadcast({ type: 'line', sessionId, text: line, role: 'assistant' });
      }
    }
  });

  proc.stderr.on('data', chunk => {
    broadcast({ type: 'line', sessionId, text: chunk.toString(), role: 'error' });
  });

  proc.on('error', err => {
    // Must handle — unhandled spawn error crashes the server process
    broadcast({ type: 'line', sessionId, text: `Failed to start Claude: ${err.message}`, role: 'error' });
    broadcast({ type: 'session-status', sessionId, status: 'error' });
  });

  proc.on('close', code => {
    const s = sessions.get(sessionId);
    if (s) {
      s.status = code === 0 ? 'done' : 'error';
      s.endAt  = Date.now();
    }
    broadcast({ type: 'session-status', sessionId, status: code === 0 ? 'done' : 'error' });
  });

  // File change watcher for version tracking
  const watcher = watchSessionFiles(sessionId, workDir);
  if (watcher) session.watcher = watcher;

  // Auto-kill at 10 minutes (prevents runaway sessions)
  session.timeout = setTimeout(() => {
    if (proc && !proc.killed) {
      proc.kill();
      broadcast({ type: 'line', sessionId, text: 'Session killed — 10 minute timeout.', role: 'error' });
    }
  }, 10 * 60 * 1000);
}
```

---

## Stream Event Handler

Claude CLI emits JSON events on stdout when `--output-format stream-json --verbose` is used:

```js
function handleStreamEvent(sessionId, msg) {
  if (!msg || !msg.type) return;

  // Text output from assistant
  if (msg.type === 'assistant' && msg.message && msg.message.content) {
    const s = sessions.get(sessionId);
    if (s && !s.firstOutputAt) {
      s.firstOutputAt = Date.now();
      // Log for SPACE E (efficiency) scoring
      if (s.projectName) spaceAppendEvent(s.projectName, {
        type: 'first-output', sessionId, elapsed: s.firstOutputAt - (s.startAt || s.firstOutputAt)
      });
    }
    for (const block of msg.message.content) {
      if (block.type === 'text') {
        broadcast({ type: 'line', sessionId, text: block.text, role: 'assistant' });
      }
    }
  }

  // Session complete — capture session_id for --resume and token usage
  if (msg.type === 'result') {
    const s = sessions.get(sessionId);
    if (s) {
      if (msg.usage) s.outputTokens = msg.usage.output_tokens || 0;
      if (msg.session_id) s.claudeSessionId = msg.session_id;
    }
    broadcast({ type: 'context-usage', sessionId, usage: msg.usage, claudeSessionId: msg.session_id || null });
  }
}
```

---

## Session Creation (in handleMessage)

```js
if (type === 'launch') {
  const { prompt, workDir, projectName } = msg;
  if (!prompt) return sendTo(ws, { type: 'error', text: 'Missing prompt' });

  const effectiveWorkDir = (workDir && workDir.trim())
    ? workDir.trim()
    : CHAT_DIR;  // fallback for promptless/chat sessions

  if (workDir && workDir.trim() && !fs.existsSync(effectiveWorkDir)) {
    return sendTo(ws, { type: 'error', text: `Working directory does not exist: ${effectiveWorkDir}` });
  }

  const id   = `s_${Date.now()}`;
  const name = generateSessionName(prompt);

  sessions.set(id, {
    id, name, workDir: effectiveWorkDir, projectName: projectName || null,
    model: msg.model || null, isChat: false, status: 'running',
    startAt: Date.now(), proc: null, watcher: null, timeout: null,
    lines: [], lastPrompt: prompt, claudeSessionId: null,
    height: null, column: null,
  });

  broadcast({ type: 'session-created', sessionId: id, name, workDir: effectiveWorkDir, projectName: projectName || null });
  saveSessions();
  spawnClaude(id, prompt, effectiveWorkDir, null, msg.model || null);
  return;
}
```

---

## Session Resume

```js
if (type === 'resume') {
  const { sessionId, prompt, displayPrompt, resumeId, model } = msg;
  const session = sessions.get(sessionId);
  if (!session) return sendTo(ws, { type: 'error', text: 'Session not found' });

  session.status     = 'running';
  session.lastPrompt = prompt;

  // displayPrompt is clean text for terminal; prompt may include injected file content
  broadcast({ type: 'line', sessionId, text: displayPrompt || prompt, role: 'user' });
  broadcast({ type: 'session-status', sessionId, status: 'running' });

  if (session.isChat) {
    spawnChat(sessionId, prompt, readConfig());
  } else {
    spawnClaude(sessionId, prompt, session.workDir, resumeId, model || null);
  }
  return;
}
```

---

## Session Stop

```js
if (type === 'stop') {
  const session = sessions.get(msg.sessionId);
  if (session) {
    if (session.proc && !session.proc.killed) session.proc.kill();
    if (session.timeout) clearTimeout(session.timeout);
    if (session.watcher) session.watcher.close();
    if (session.req) { session.req.destroy(); session.req = null; }  // abort chat HTTP
    session.status = 'done';
    session.endAt  = session.endAt || Date.now();
    saveSessions();
    broadcast({ type: 'session-status', sessionId: msg.sessionId, status: 'done' });
  }
  return;
}
```

---

## Session Persistence

```js
function serializeSession(s) {
  return {
    id: s.id, name: s.name, workDir: s.workDir, projectName: s.projectName,
    model: s.model || null, isChat: s.isChat || false,
    status: s.status === 'running' ? 'done' : s.status,  // running → done on persist
    startAt: s.startAt, endAt: s.endAt || null,
    claudeSessionId: s.claudeSessionId || null,
    lastPrompt: s.lastPrompt || null,
    height: s.height || null,
    column: s.column != null ? s.column : null,
    lines: (s.lines || []).slice(-500),  // keep last 500 lines
  };
}

function saveSessions() {
  try {
    fs.writeFileSync(
      SESSIONS_PERSIST_PATH,
      JSON.stringify(Array.from(sessions.values()).map(serializeSession), null, 2),
      'utf8'
    );
  } catch {}  // silent — persistence failure must not crash the app
}

function loadPersistedSessions() {
  try {
    const arr = JSON.parse(fs.readFileSync(SESSIONS_PERSIST_PATH, 'utf8'));
    if (!Array.isArray(arr)) return;
    for (const s of arr) {
      if (!s.id) continue;
      sessions.set(s.id, {
        ...s,
        status: s.status === 'running' ? 'done' : s.status,
        proc: null, watcher: null, timeout: null, req: null, chatBuffer: '',
        lines: s.lines || [],
      });
    }
  } catch {}
}

// Call at startup, before server listens
loadPersistedSessions();
```

**Save triggers:** every assistant line, session-done, session-error, height change, column change.

---

## File Watcher (Version Tracking)

```js
function watchSessionFiles(sessionId, workDir) {
  if (!fs.existsSync(workDir)) return;
  const watcher = fs.watch(workDir, { recursive: true }, (event, filename) => {
    if (event !== 'change' || !filename) return;
    const full = path.join(workDir, filename);
    const { rel, prev, next } = bumpVersion(full);
    broadcast({ type: 'file-version', sessionId, file: rel, prev, next });
  });
  return watcher;
}
```

The watcher is closed when the session is stopped or removed. It emits `file-version` events that the UI uses to populate the Versions panel.

---

## Chat Session (OpenRouter HTTP)

Chat sessions do not use Claude CLI. They send conversation history to the OpenRouter chat completions endpoint and stream SSE:

```js
function spawnChat(sessionId, prompt, config) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Build full message history from stored lines
  const rawLines = (session.lines || []).filter(l => l.role === 'user' || l.role === 'assistant');
  const messages = [];
  for (const l of rawLines) {
    // Merge consecutive same-role lines (handles streamed multi-chunk output)
    if (messages.length && messages[messages.length - 1].role === l.role) {
      messages[messages.length - 1].content += '\n' + l.text;
    } else {
      messages.push({ role: l.role, content: l.text });
    }
  }
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: prompt });
  }

  const model   = config.chatModel || 'deepseek/deepseek-chat';
  const payload = JSON.stringify({ model, messages, stream: true });

  const req = https.request({
    hostname: 'openrouter.ai',
    path:     '/api/v1/chat/completions',
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Authorization':  `Bearer ${config.openRouterApiKey}`,
      'Content-Length': Buffer.byteLength(payload),
      'HTTP-Referer':   'https://your-app.com',
      'X-Title':        'YourApp',
    },
  }, res => {
    let lineBuffer = '';
    res.on('data', chunk => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer  = lines.pop();
      for (const line of lines) {
        if (!line.trim() || line.trim() === 'data: [DONE]') continue;
        if (!line.startsWith('data: ')) continue;
        try {
          const data    = JSON.parse(line.slice(6));
          const content = data.choices?.[0]?.delta?.content || '';
          if (!content) continue;
          session.chatBuffer = (session.chatBuffer || '') + content;
          const parts = session.chatBuffer.split('\n');
          session.chatBuffer = parts.pop();
          for (const part of parts) {
            if (part.trim()) broadcast({ type: 'line', sessionId, text: part, role: 'assistant' });
          }
        } catch {}
      }
    });
    res.on('end', () => {
      const rem = (session.chatBuffer || '').trim();
      if (rem) broadcast({ type: 'line', sessionId, text: rem, role: 'assistant' });
      session.chatBuffer = '';
      session.status = 'done';
      broadcast({ type: 'session-status', sessionId, status: 'done' });
    });
  });

  req.on('error', err => {
    if (err.code === 'ECONNRESET' || err.message === 'socket hang up') return;  // user-stopped
    broadcast({ type: 'line', sessionId, text: `Chat error: ${err.message}`, role: 'error' });
    broadcast({ type: 'session-status', sessionId, status: 'error' });
  });

  session.req = req;  // stored so stop handler can call req.destroy()
  req.write(payload);
  req.end();
}
```

---

## Prompt History

```js
function addToHistory(prompt) {
  const history = readJSON(HISTORY_PATH, []);
  const updated = [prompt, ...history.filter(p => p !== prompt)].slice(0, 200);
  writeJSON(HISTORY_PATH, updated);
}
```

Deduplicated (most recent at index 0), capped at 200 entries. UI uses ↑/↓ to cycle.
