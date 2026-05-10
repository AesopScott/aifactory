# SPEC-09 — Global File Sync

## Purpose

Three global files — CLAUDE.md, MEMORY.md, and SOUL.md — are automatically synced to every project's working directory. This ensures every agent session starts with up-to-date context, memory, and purpose, regardless of which project it's running in.

---

## The Three Files

| File | Source | Purpose | Merge Rule |
|------|--------|---------|------------|
| `CLAUDE.md` | `<app-source-dir>/CLAUDE.md` | Agent context — rules, architecture, API layout | Preserve project-specific section |
| `MEMORY.md` | `~/.claude/MEMORY.md` | Persistent agent memory | Preserve project-specific section |
| `SOUL.md` | `<obsidianVaultPath>/SOUL.md` | Why the app exists | Full replace — no project additions |

---

## Project-Specific Marker

`CLAUDE.md` and `MEMORY.md` may have a project-specific section appended in each project's copy. The marker `<!-- PROJECT-SPECIFIC -->` separates global content (overwritten on sync) from project-specific content (preserved).

```
# CLAUDE.md

[Global content — overwritten on each sync]

<!-- PROJECT-SPECIFIC -->
[Project-specific additions — never touched by sync]
```

When syncing, the server:
1. Reads the current global file
2. Reads the existing project copy, extracts content after `<!-- PROJECT-SPECIFIC -->`
3. Writes: `${globalContent}\n\n<!-- PROJECT-SPECIFIC -->${projectSection}`

---

## Sync Implementation

```js
const PROJECT_SPECIFIC_MARKER = '<!-- PROJECT-SPECIFIC -->';

function syncGlobalToProjects() {
  const config   = readConfig();
  const projects = (config.projects || []).filter(p => p.workDir);
  const vaultPath = config.obsidianVaultPath || '';
  const globalSoulPath = vaultPath ? path.join(vaultPath, 'SOUL.md') : null;

  const fileDefs = [
    { name: 'CLAUDE.md', src: GLOBAL_CLAUDE_PATH, projectSpecific: true  },
    { name: 'MEMORY.md', src: GLOBAL_MEMORY_PATH, projectSpecific: true  },
    { name: 'SOUL.md',   src: globalSoulPath,      projectSpecific: false },
  ];

  const results = [];

  for (const { name, src, projectSpecific } of fileDefs) {
    if (!src) { results.push({ file: name, status: 'skipped', reason: 'no source path' }); continue; }

    let globalContent;
    try {
      globalContent = fs.readFileSync(src, 'utf8');
    } catch {
      results.push({ file: name, status: 'skipped', reason: 'source not found' });
      continue;
    }

    for (const project of projects) {
      if (!fs.existsSync(project.workDir)) continue;
      const dest = path.join(project.workDir, name);
      try {
        if (!projectSpecific) {
          // Full replace
          fs.writeFileSync(dest, globalContent, 'utf8');
        } else {
          // Preserve project-specific section
          let projectSection = '';
          if (fs.existsSync(dest)) {
            const existing = fs.readFileSync(dest, 'utf8');
            const idx = existing.indexOf(PROJECT_SPECIFIC_MARKER);
            if (idx !== -1) projectSection = existing.slice(idx + PROJECT_SPECIFIC_MARKER.length);
          }
          fs.writeFileSync(dest, `${globalContent}\n\n${PROJECT_SPECIFIC_MARKER}${projectSection}`, 'utf8');
        }
        results.push({ file: name, project: project.name || project.workDir, status: 'ok' });
      } catch (e) {
        results.push({ file: name, project: project.name || project.workDir, status: 'error', reason: e.message });
      }
    }
  }

  return results;
}
```

---

## File Watcher

After initial sync on startup, watchers trigger re-sync whenever a global file changes:

```js
function watchGlobalFiles() {
  const filesToWatch = [GLOBAL_CLAUDE_PATH, GLOBAL_MEMORY_PATH];
  const config = readConfig();
  if (config.obsidianVaultPath) {
    filesToWatch.push(path.join(config.obsidianVaultPath, 'SOUL.md'));
  }

  for (const filePath of filesToWatch) {
    if (!fs.existsSync(filePath)) continue;
    fs.watch(filePath, () => {
      const results = syncGlobalToProjects();
      broadcast({ type: 'sync-complete', results });
    });
  }
}
```

Called at server startup after the initial sync.

---

## Trigger Points

| Trigger | Handler |
|---------|---------|
| Server startup | `syncGlobalToProjects()` in boot sequence |
| Global file changed | `fs.watch()` → `syncGlobalToProjects()` |
| Manual — Settings button | `{ type: 'sync-global-files' }` WS message |

---

## Manual Sync (WS handler)

```js
if (type === 'sync-global-files') {
  const results = syncGlobalToProjects();
  const errors  = results.filter(r => r.status === 'error');
  const synced  = results.filter(r => r.status === 'ok').length;
  sendTo(ws, { type: 'sync-complete', results, synced, errors: errors.length });
  return;
}
```

UI response:
```js
if (msg.type === 'sync-complete') {
  const txt = msg.errors > 0
    ? `Sync: ${msg.synced} ok, ${msg.errors} errors`
    : `Sync complete — ${msg.synced} files updated`;
  showNotif(txt, msg.errors > 0);
}
```

---

## Path Constants (server.js)

```js
const GLOBAL_CLAUDE_PATH = path.join(__dirname, 'CLAUDE.md');        // app source dir
const GLOBAL_MEMORY_PATH = path.join(os.homedir(), '.claude', 'MEMORY.md');
// SOUL.md path is dynamic — derived from config.obsidianVaultPath at sync time
```

---

## Extending the Sync System

To add a new global file to the sync system:
1. Add an entry to `fileDefs` in `syncGlobalToProjects()`
2. Add the source path to `watchGlobalFiles()` if it should auto-sync on change
3. No UI changes needed — the "Sync Global Files" button handles it automatically

---

## Why This Matters for Agent Sessions

Every agent session launched in any project's working directory can immediately read:
- `CLAUDE.md` — knows the rules, the architecture, the file zones
- `MEMORY.md` — knows what was learned in previous sessions
- `SOUL.md` — knows why the app exists and what it's for

This context arrives automatically — the user doesn't need to paste it into the prompt. The agent starts already situated.
