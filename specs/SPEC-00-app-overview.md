# SPEC-00 — App Overview & Spec Index

## Purpose

This document is the entry point for building an Electron desktop AI command center in the style of Polaris. Read this first to understand the full stack, then pull the specific SPEC files for each component you need.

---

## What This Stack Builds

A Windows Electron desktop app that:
- Runs multiple parallel AI agent sessions side by side
- Streams agent output in real time to terminal-style cards
- Routes agent sessions through OpenRouter (via Claude CLI) or direct LLM APIs
- Persists sessions, config, and layout across restarts
- Provides a single-file HTML UI served over localhost WebSocket

**Reference implementation:** Polaris (C:\Users\scott\Code\Polaris)

---

## Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Desktop shell | Electron | Native window, IPC, system dialogs, packaged installer |
| Backend | Node.js HTTP + WebSocket (`ws` package) | Real-time streaming, process management, no framework overhead |
| Frontend | Single-file HTML (no build step) | Instant iteration, served from AppData, no bundler complexity |
| AI sessions | Claude CLI (`claude` command) via OpenRouter | Multi-turn, tool use, streaming JSON, session resume |
| Chat sessions | OpenRouter chat completions API | Stateless HTTP streaming, conversation history sent each turn |
| Packaging | electron-builder | `.exe` installer, auto-updates path, resources bundling |

---

## Three-Zone File Architecture

Every app using this stack has three zones with hard rules:

| Zone | Path | Rule |
|------|------|------|
| Source | `C:\Users\<user>\Code\<AppName>\` | Edit here. Not the running app. Requires rebuild to take effect. |
| Installed app | `C:\Users\<user>\AppData\Local\Programs\<AppName>\resources\` | Never edit. Destroyed on every reinstall. |
| Runtime data | `C:\Users\<user>\AppData\Roaming\<appdata-dir>\` | Only location for runtime reads/writes. Survives reinstalls. |

The UI HTML file lives in runtime data and is **overwritten from source on every app launch** — this is how UI changes deploy without losing runtime config.

---

## Process Architecture

```
Electron main process (main.js)
  ├── Creates BrowserWindow → loads http://localhost:PORT
  ├── Forks server.js as child process
  └── IPC bridge for system dialogs (folder picker, etc.)

Node.js server process (server.js)
  ├── HTTP server on 127.0.0.1:PORT
  │     ├── GET / → serves mockup.html from AppData
  │     └── POST /space/event → event logging endpoint
  ├── WebSocket server (same HTTP server)
  │     └── handleMessage() — all client↔server communication
  └── Session management
        ├── spawnClaude() — Claude CLI agent sessions
        └── spawnChat() — OpenRouter HTTP chat sessions

Browser (mockup.html, WebSocket client)
  ├── Connects to ws://localhost:PORT
  ├── Sends commands (launch, stop, resume, save-config, …)
  └── Renders session cards from server events
```

---

## Data Flow for a Session Launch

```
1. User fills prompt + working directory → clicks Launch
2. mockup.html sends { type: 'launch', prompt, workDir, projectName } via WebSocket
3. server.js creates session, broadcasts session-created
4. server.js spawns: claude --output-format stream-json --verbose --model <model> --append-system-prompt <rules> -p <prompt>
   with env: ANTHROPIC_BASE_URL=https://openrouter.ai/api, ANTHROPIC_AUTH_TOKEN=<key>
5. Claude stdout → JSON events → server parses → broadcasts { type: 'line', sessionId, text, role }
6. mockup.html appends lines to session card terminal in real time
7. On exit → session-status done/error
8. result event captures session_id → enables --resume on next prompt
```

---

## Spec Index

| Spec | What It Covers | Read When |
|------|---------------|-----------|
| [SPEC-01](SPEC-01-electron-shell.md) | Electron entry, BrowserWindow, IPC, app lifecycle | Building main.js |
| [SPEC-02](SPEC-02-node-ws-server.md) | HTTP + WebSocket server, message routing, helpers | Building server.js skeleton |
| [SPEC-03](SPEC-03-session-management.md) | Session lifecycle, spawn, stream, persist | Implementing agent session execution |
| [SPEC-04](SPEC-04-api-routing.md) | OpenRouter, Claude CLI fix, chat API, secret encryption | Wiring API keys and model routing |
| [SPEC-05](SPEC-05-ui-architecture.md) | Single-file HTML, palette system, WS client | Building mockup.html |
| [SPEC-06](SPEC-06-layout-and-cards.md) | Masonry grid, card resize, drag-and-drop | Implementing the session card grid |
| [SPEC-07](SPEC-07-data-persistence.md) | Config, session persist, locks, file versions | All JSON/JSONL storage patterns |
| [SPEC-08](SPEC-08-feature-panels.md) | SPACE, Code Health, File Manager, Connections, Projects, Settings | Adding feature panels |
| [SPEC-09](SPEC-09-file-sync.md) | Global file sync to project working dirs | Syncing CLAUDE.md / MEMORY.md / SOUL.md |
| [SPEC-10](SPEC-10-build-workflow.md) | electron-builder, dist, reinstall | Packaging and shipping |

---

## The AI Factory Build Lifecycle

New apps are built using the `/aifactory` skill (`~/.claude/skills/aifactory/SKILL.md`), which drives the full lifecycle in five mandatory stages. The specs in this library are the implementation reference for Stage 3.

### Stage 1 — Interview
The skill asks structured questions across seven categories: purpose & users, core features, platform & shell, AI & APIs, data & persistence, UI & experience, and constraints. No code is written until this is complete.

### Stage 2 — Build Plan
The skill synthesizes interview answers into a formal build plan covering: app name & goal, which SPEC files apply, a numbered feature list with complexity estimates, phased build schedule, file structure, open questions, and a post-v1.0 parking lot. The user must explicitly say "start the build" before any code is written.

### Stage 3 — Build
The skill executes the build plan phase by phase, reading the relevant SPEC files before each phase. Each phase ends with a status report and waits for user confirmation before the next begins.

### Stage 4 — Documentation
Before v1.0 is declared, the skill writes `docs/USER-GUIDE.md` covering: what the app is, installation, configuration, core workflow, feature reference, keyboard shortcuts, troubleshooting, data & files, and the post-v1.0 roadmap.

### Stage 5 — Pre-GA Audit
The skill runs a full checklist audit across six categories: Security, Correctness, Robustness, Code Quality, Documentation, and UX. Every item is explicitly checked — nothing is assumed to pass. Any ❌ FAIL item must be fixed before v1.0 is declared. The audit produces a summary table and a final ship/no-ship verdict.

---

## Reading the Specs Directly (Without the Skill)

If building manually without the `/aifactory` skill:

1. Read SPEC-00 (this file) to understand the stack.
2. Read SPEC-01 + SPEC-02 to scaffold main.js and server.js.
3. Read SPEC-03 + SPEC-04 to wire agent sessions.
4. Read SPEC-05 to build the UI shell in mockup.html.
5. Add features from SPEC-06 through SPEC-09 as needed.
6. Read SPEC-10 to package and ship.
7. Write `docs/USER-GUIDE.md` before declaring v1.0.
8. Run the Stage 5 audit checklist from the skill before shipping.

Each spec is self-contained — you can implement them in order or skip components that don't apply to your app.
