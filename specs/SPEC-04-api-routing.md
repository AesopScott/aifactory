# SPEC-04 — API Routing, Model Tiers & Secret Encryption

## Purpose

Covers the two-API architecture (Claude CLI via OpenRouter for agents, HTTP completions for chat), the critical env var fix that makes OpenRouter + Claude CLI work, the three-tier model selector, and AES-256-GCM secret encryption for API keys at rest.

---

## Two-System Architecture

| System | Provider | Mechanism |
|--------|----------|-----------|
| **Agent sessions** | OpenRouter | Claude CLI subprocess with custom env vars |
| **Chat sessions** | OpenRouter (or any OpenAI-compatible endpoint) | HTTPS chat completions with SSE streaming |

These must never be mixed. Agent sessions rely on Claude CLI's full capability (tool use, multi-turn, session resume). Chat sessions are stateless HTTP — cheaper, faster, no CLI dependency.

---

## Critical OpenRouter + Claude CLI Fix

Claude CLI **does NOT work** with the standard OpenAI-style env var configuration:

```
// WRONG — causes duration_api_ms: 0 and model: <synthetic>
ANTHROPIC_BASE_URL = 'https://openrouter.ai/api/v1'
ANTHROPIC_API_KEY  = '<your-openrouter-key>'
```

**Root cause:** Claude CLI requires `ANTHROPIC_AUTH_TOKEN` (not `ANTHROPIC_API_KEY`), and the base URL must omit the `/v1` suffix when routing through OpenRouter.

```js
// CORRECT — confirmed working
const spawnEnv = {
  ...process.env,
  ANTHROPIC_BASE_URL:   'https://openrouter.ai/api',   // no /v1
  ANTHROPIC_AUTH_TOKEN: config.openRouterApiKey,         // AUTH_TOKEN, not API_KEY
  ANTHROPIC_API_KEY:    '',                              // must be empty string
};
```

**Why `shell: true` on spawn:**
```js
spawn('claude', args, { cwd: workDir, env: spawnEnv, stdio: [...], shell: true })
```
When Electron forks a child process, it may not inherit the user's npm PATH. `shell: true` routes through `cmd.exe` which resolves `claude` the same way a terminal does. Without it: ENOENT crash.

---

## Model Tier System

Three tiers map to config keys, resolved at launch time:

| Tier | UI Label | Config Key | Example Value |
|------|----------|-----------|---------------|
| Floor | Cheap | `openRouterFloorModel` | `openrouter/auto` |
| Balanced | Performance | `openRouterSonnetModel` | `anthropic/claude-sonnet-4-6` |
| Power | Power | `openRouterOpusModel` | `anthropic/claude-opus-4-7` |

```js
function resolveModel(tier, config) {
  if (tier === 'floor')    return config.openRouterFloorModel    || 'openrouter/auto';
  if (tier === 'balanced') return config.openRouterSonnetModel   || 'openrouter/auto';
  if (tier === 'power')    return config.openRouterOpusModel     || 'openrouter/auto';
  return tier;  // pass-through if already a model string
}
```

The UI sends the resolved model string in the `launch` message. The server uses it directly.

---

## Model Test (in Settings)

Validates that a model string works with OpenRouter before saving:

```js
function testModel(ws, model, tier, apiKey) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 16,
    stream: true,
  });

  const req = https.request({
    hostname: 'openrouter.ai',
    path:     '/api/v1/messages',
    method:   'POST',
    headers: {
      'x-api-key':          apiKey,
      'anthropic-version':  '2023-06-01',
      'content-type':       'application/json',
      'content-length':     Buffer.byteLength(body),
    },
  }, res => {
    let raw = '';
    res.on('data', c => raw += c);
    res.on('end', () => {
      if (res.statusCode === 200) {
        const firstLine = raw.split('\n').find(l => l.startsWith('data:') && !l.includes('[DONE]'));
        if (firstLine) {
          try {
            const data = JSON.parse(firstLine.slice(5).trim());
            if (data.type || data.choices) {
              sendTo(ws, { type: 'test-model-result', tier, ok: true, message: `Model valid (${model})` });
            } else {
              sendTo(ws, { type: 'test-model-result', tier, ok: false, message: 'Malformed streaming response' });
            }
          } catch {
            sendTo(ws, { type: 'test-model-result', tier, ok: false, message: 'Response not valid JSON' });
          }
        } else {
          sendTo(ws, { type: 'test-model-result', tier, ok: false, message: 'No SSE data received' });
        }
      } else if (res.statusCode === 404) {
        sendTo(ws, { type: 'test-model-result', tier, ok: false, message: `Model not found (404)` });
      } else {
        sendTo(ws, { type: 'test-model-result', tier, ok: false, message: `HTTP ${res.statusCode}` });
      }
    });
  });

  req.on('error', err => sendTo(ws, { type: 'test-model-result', tier, ok: false, message: err.message }));
  req.write(body);
  req.end();
}
```

**Important caveat:** A green test means the model supports Anthropic streaming format. It does NOT guarantee tool-use compatibility — Claude CLI sends full tool definitions which can behave differently.

---

## API Key Validation

Pattern for all three providers (OpenRouter, Anthropic, OpenAI):

```js
// OpenRouter — GET /api/v1/models with Bearer auth
https.request({
  hostname: 'openrouter.ai',
  path:     '/api/v1/models',
  method:   'GET',
  headers:  { 'Authorization': `Bearer ${apiKey}` },
}, res => { /* check statusCode === 200, parse model count */ })

// Anthropic — GET /v1/models with x-api-key header
https.request({
  hostname: 'api.anthropic.com',
  path:     '/v1/models',
  method:   'GET',
  headers:  { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
}, res => { /* check statusCode === 200 */ })

// OpenAI — GET /v1/models with Bearer auth
https.request({
  hostname: 'api.openai.com',
  path:     '/v1/models',
  method:   'GET',
  headers:  { 'Authorization': `Bearer ${apiKey}` },
}, res => { /* check statusCode === 200 */ })
```

---

## Credit Balance Check

```js
// OpenRouter balance
https.request({
  hostname: 'openrouter.ai',
  path:     '/api/v1/credits',
  method:   'GET',
  headers:  { 'Authorization': `Bearer ${apiKey}` },
}, res => {
  // res body: { data: { total_credits, total_usage } }
})
```

---

## Secret Encryption (AES-256-GCM, Machine-Bound)

API keys, passwords, and other secrets are stored encrypted in `config.json`. The encryption key is derived from the Windows `MachineGuid` registry value — machine-bound, so the config file is not portable between machines.

```js
const SENSITIVE_KEYS = new Set(['openRouterApiKey', 'anthropicApiKey', 'openAiApiKey', 'deepSeekEmail', 'deepSeekPassword']);
const SECRET_MASK    = '••••••••';

let _machineKey = null;
function getMachineKey() {
  if (_machineKey) return _machineKey;
  try {
    const out   = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const match = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
    if (match) {
      _machineKey = crypto.createHash('sha256').update(match[1]).digest();
      return _machineKey;
    }
  } catch {}
  // Fallback: user@hostname (weaker but works when registry is inaccessible)
  _machineKey = crypto.createHash('sha256').update(`${os.userInfo().username}@${os.hostname()}`).digest();
  return _machineKey;
}

function encryptSecret(plaintext) {
  if (!plaintext) return '';
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMachineKey(), iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptSecret(value) {
  if (!value || !value.startsWith('enc:')) return value || '';
  try {
    const buf    = Buffer.from(value.slice(4), 'base64');
    const iv     = buf.slice(0, 16);
    const tag    = buf.slice(16, 32);
    const enc    = buf.slice(32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getMachineKey(), iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc) + decipher.final('utf8');
  } catch { return ''; }
}
```

**Format:** `enc:` prefix + base64(16-byte IV + 16-byte GCM auth tag + ciphertext).

---

## Config Read/Write/Mask Pattern

```js
// Always decrypt in memory — never return encrypted values to code that needs the real key
function readConfig() {
  const raw = readJSON(CONFIG_PATH, {});
  const result = { ...raw };
  for (const key of SENSITIVE_KEYS) {
    if (result[key]) result[key] = decryptSecret(result[key]);
  }
  return result;
}

// Always mask for UI — UI never receives real values
function maskedConfig(cfg) {
  const result = { ...cfg };
  for (const key of SENSITIVE_KEYS) {
    result[key] = cfg[key] ? SECRET_MASK : '';
  }
  return result;
}

// Always re-encrypt when saving — skip if value is the mask (user didn't change it)
function saveConfig(incoming, currentRaw) {
  const updates = { ...incoming };
  for (const key of SENSITIVE_KEYS) {
    if (updates[key] === SECRET_MASK || updates[key] === undefined) {
      delete updates[key];  // preserve existing encrypted value
    } else if (updates[key]) {
      updates[key] = encryptSecret(updates[key]);
    }
  }
  writeJSON(CONFIG_PATH, { ...currentRaw, ...updates });
}

// Migrate plaintext secrets written before encryption was added
function migrateSecretsToEncrypted() {
  const raw = readJSON(CONFIG_PATH, {});
  let changed = false;
  for (const key of SENSITIVE_KEYS) {
    if (raw[key] && !raw[key].startsWith('enc:')) {
      raw[key] = encryptSecret(raw[key]);
      changed = true;
    }
  }
  if (changed) writeJSON(CONFIG_PATH, raw);
}
```

Call `migrateSecretsToEncrypted()` at server startup to handle any pre-encryption config files.

---

## System Prompt Injection

Every agent session gets a system prompt appended with app-specific rules:

```js
const BASE_SYSTEM_PROMPT = [
  'Path awareness — source: <source-dir>. Do not read from or write here.',
  'Path awareness — installed app: <installed-dir>. Never edit. Destroyed on reinstall.',
  'Path awareness — runtime data: <data-dir>. Only location for runtime reads/writes.',
  'Code changes require a rebuild. Tell the user. They run npm run dist and reinstall.',
  'Never restart the server from code. If a restart is needed, tell the user.',
  'Platform: Windows. Use Windows paths. No Unix shell commands.',
  'Before any code change or file write, state what you plan to do and wait for confirmation.',
].join('\n');

function buildSystemPrompt(config) {
  const patterns = config.protectedPatterns || ['*.md'];
  return BASE_SYSTEM_PROMPT + '\n' +
    `Protected file patterns — require explicit user approval before modification: ${patterns.join(', ')}`;
}
```

Injected via `--append-system-prompt <text>` flag on the Claude CLI invocation.
