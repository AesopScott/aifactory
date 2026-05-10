# SPEC-06 — Layout & Session Cards

## Purpose

Covers the masonry 3-column grid, session card HTML structure, card resizing, drag-and-drop repositioning, and the column/height persistence loop.

---

## Masonry Grid

The session grid is a CSS flexbox layout with three equal columns. Cards are assigned to columns by the shortest-column algorithm, not CSS columns (which break persistence).

```css
.session-grid {
  flex: 1;
  padding: 12px 16px;
  display: flex;
  gap: 12px;
  align-items: stretch;      /* columns fill to tallest column's height */
  overflow-y: auto;
}

.session-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  justify-content: flex-start;
  min-height: 120px;         /* always droppable even when empty */
}
```

---

## renderGrid() Algorithm

```js
function renderGrid() {
  // Clear columns
  for (let i = 0; i < 3; i++) {
    document.getElementById(`col-${i}`).innerHTML = '';
  }

  const colHeights = [0, 0, 0];  // track cumulative px height per column

  for (const id of sessionOrder) {
    const s = sessionsStore[id];
    if (!s) continue;

    // Determine target column
    let col;
    if (s.column != null) {
      col = s.column;  // restore persisted assignment
    } else {
      col = colHeights.indexOf(Math.min(...colHeights));  // shortest-column packing
    }

    const card = buildCard(s);
    document.getElementById(`col-${col}`).appendChild(card);

    // Track height for packing algorithm
    const h = s.height ? parseInt(s.height) : 260;
    colHeights[col] += h + 12;  // +12 for gap
  }
}
```

**`sessionOrder` array** controls the visual stacking order within columns. It is updated on: init, session-created, session-closed, and drag-and-drop reorder.

---

## Session Card HTML Structure

```js
function buildCard(s) {
  const el = document.createElement('div');
  el.className = 'card palette' + (selectedSessionId === s.id ? ' selected' : '');
  el.setAttribute('data-sid', s.id);
  el.draggable = false;  // whole card is NOT draggable — only the grip handle is

  if (s.height) el.style.height = s.height;

  el.innerHTML = `
    <!-- Card header -->
    <div class="card-header">
      <span class="card-drag-handle" draggable="true" data-drag-id="${s.id}">⠿⠿</span>
      <span class="card-title">${escHtml(s.name)}</span>
      <span class="status-badge status-${s.status}">${s.status}</span>
      <div class="card-btns">
        <button class="card-btn" onclick="toggleCardLocks('${s.id}')" data-lock-btn="${s.id}">🔒</button>
        <button class="card-btn" onclick="resetCardSize('${s.id}')">↕</button>
        <button class="card-btn" onclick="closeSession('${s.id}')">✕</button>
      </div>
    </div>

    <!-- Terminal output -->
    <div class="terminal" data-terminal="${s.id}"></div>

    <!-- Context bar (token usage) -->
    <div class="context-bar-wrap">
      <div class="context-label-bar">
        <span>Context</span>
        <span data-ctx-label="${s.id}">—</span>
      </div>
      <div class="context-bar">
        <div class="context-fill" data-ctx-fill="${s.id}" style="width:0%"></div>
      </div>
    </div>

    <!-- Card footer -->
    <div class="card-footer">
      <div class="footer-timer" data-timer="${s.id}">0:00</div>
      <div class="footer-btns">
        <button class="fbtn" onclick="resumeSession('${s.id}')">↺ Resume</button>
        <button class="fbtn" onclick="rerunSession('${s.id}')">▶ Re-run</button>
        <button class="fbtn" onclick="copyTerminal('${s.id}')">Copy</button>
        <button class="fbtn" onclick="clearTerminal('${s.id}')">Clear</button>
        <button class="fbtn" onclick="stopSession('${s.id}')">■ Stop</button>
      </div>
    </div>

    <!-- Locks drawer (hidden by default) -->
    <div class="locks-drawer" id="locks-${s.id}">
      <div class="lock-protected-header">⚠ Approval required: *.md</div>
      <!-- lock chips populated by refreshCardLocks() -->
      <div class="lock-add-row">
        <input class="lock-add-input" placeholder="Add file path to lock…" id="lock-input-${s.id}">
        <button class="lock-add-btn" onclick="addLock('${s.id}')">+ Lock</button>
      </div>
    </div>

    <!-- Resize handle -->
    <div class="card-resize-handle" data-resize="${s.id}"></div>
  `;

  // Restore terminal lines
  const terminal = el.querySelector('[data-terminal]');
  for (const line of (s.lines || [])) {
    appendLine(terminal, line.text, line.role);
  }

  // Wire resize handle
  wireResizeHandle(el.querySelector('[data-resize]'), el, s.id);

  // Wire drag handle
  wireDragHandle(el.querySelector('[data-drag-id]'));

  return el;
}
```

---

## Card Resize

```js
function wireResizeHandle(handle, card, sessionId) {
  let startY, startH;

  handle.addEventListener('mousedown', e => {
    startY = e.clientY;
    startH = card.offsetHeight;
    handle.classList.add('dragging');

    function onMove(e) {
      const newH = Math.max(160, startH + (e.clientY - startY));
      card.style.height = newH + 'px';
    }

    function onUp() {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Persist height to server
      const finalH = card.style.height;
      sessionsStore[sessionId].height = finalH;
      send({ type: 'session-height', sessionId, height: finalH });
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

function resetCardSize(sessionId) {
  const card = document.querySelector(`[data-sid="${sessionId}"]`);
  if (!card) return;
  card.style.height = '';  // returns to CSS default (260px)
  sessionsStore[sessionId].height = null;
  send({ type: 'session-height', sessionId, height: null });
}
```

**Reset Layout (all cards):**
```js
function resetLayout() {
  for (const id of sessionOrder) {
    sessionsStore[id].height = null;
    sessionsStore[id].column = null;
    send({ type: 'session-height', sessionId: id, height: null });
    send({ type: 'session-column', sessionId: id, column: null });
  }
  renderGrid();
}
```

---

## Drag-and-Drop

**Why document-level handlers:** Per-card `dragover`/`drop` are swallowed by child elements. A single `document.addEventListener('dragover')` + `elementFromPoint` bypasses all interception.

**Why grip handle only:** `draggable=true` on the whole card causes terminal text, buttons, and inputs to intercept drag events. The grip handle is the only draggable element.

```js
let dragId = null;
let dragOverTarget = null;

function wireDragHandle(handle) {
  const sessionId = handle.getAttribute('data-drag-id');

  handle.addEventListener('dragstart', e => {
    dragId = sessionId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', sessionId);
    // Use whole card as drag image for visual feedback
    const card = handle.closest('.card');
    if (card) e.dataTransfer.setDragImage(card, 20, 20);
    card.classList.add('dragging');
  });

  handle.addEventListener('dragend', () => {
    const card = document.querySelector(`[data-sid="${dragId}"]`);
    if (card) card.classList.remove('dragging');
    // Clear all drop indicators
    document.querySelectorAll('.card[data-sid]').forEach(c => {
      c.style.borderTop = '';
      c.style.borderBottom = '';
    });
    dragOverTarget = null;
    dragId = null;
  });
}

document.addEventListener('dragover', e => {
  e.preventDefault();
  if (!dragId) return;

  const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.card[data-sid]');
  if (!target || target.getAttribute('data-sid') === dragId) {
    dragOverTarget = null;
    return;
  }

  const rect = target.getBoundingClientRect();
  const mid  = rect.top + rect.height / 2;
  const pos  = e.clientY < mid ? 'before' : 'after';

  // Find column index
  const col = target.parentElement;
  const colIdx = parseInt(col.id.replace('col-', '')) || 0;

  // Update visual indicator
  document.querySelectorAll('.card[data-sid]').forEach(c => {
    c.style.borderTop = ''; c.style.borderBottom = '';
  });
  target.style[pos === 'before' ? 'borderTop' : 'borderBottom'] = '2px solid #3b82f6';

  dragOverTarget = { cardId: target.getAttribute('data-sid'), pos, colIdx };
});

document.addEventListener('drop', e => {
  e.preventDefault();
  if (!dragId || !dragOverTarget) return;
  applyDrop(dragOverTarget.cardId, dragOverTarget.pos, dragOverTarget.colIdx);
});

function applyDrop(targetId, position, colIdx) {
  if (!dragId || dragId === targetId) return;

  // Update column
  sessionsStore[dragId].column = colIdx;
  send({ type: 'session-column', sessionId: dragId, column: colIdx });

  // Update order
  sessionOrder = sessionOrder.filter(id => id !== dragId);
  const targetIdx = sessionOrder.indexOf(targetId);
  if (targetIdx === -1) {
    sessionOrder.push(dragId);
  } else {
    sessionOrder.splice(position === 'before' ? targetIdx : targetIdx + 1, 0, dragId);
  }

  renderGrid();
}
```

---

## Card Selection & Resume Focus

```js
let selectedSessionId = null;

// Click card body to select
document.addEventListener('click', e => {
  const card = e.target.closest('.card[data-sid]');
  if (card) {
    const id = card.getAttribute('data-sid');
    selectSession(id);
  } else if (!e.target.closest('.launch-bar')) {
    // Click outside cards/launch bar = deselect
    selectSession(null);
  }
});

function selectSession(id) {
  // Update visual state
  document.querySelectorAll('.card[data-sid]').forEach(c => {
    c.classList.toggle('selected', c.getAttribute('data-sid') === id);
  });
  selectedSessionId = id;

  // Show/hide resume banner in launch bar
  const s = id ? sessionsStore[id] : null;
  updateResumeBanner(s);
}

function updateResumeBanner(s) {
  const banner = document.getElementById('resume-banner');
  if (!s || !s.claudeSessionId) {
    banner.style.display = 'none';
    return;
  }
  banner.style.display = 'flex';
  banner.querySelector('.resume-session-name').textContent = s.name;
}
```

**Sticky selection:** After submitting a prompt in resume mode, the selection stays on the resumed session. It only clears on explicit click-outside.

---

## Session Timers

```js
const timerInterval = setInterval(() => {
  for (const id of sessionOrder) {
    const s = sessionsStore[id];
    if (!s || s.status !== 'running') continue;
    const elapsed = Math.floor((Date.now() - (s.startAt || Date.now())) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const el = document.querySelector(`[data-timer="${id}"]`);
    if (el) el.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
  }
}, 1000);
```

---

## Context Bar Update

```js
function updateContextBar(sessionId, usage) {
  if (!usage) return;
  const fill  = document.querySelector(`[data-ctx-fill="${sessionId}"]`);
  const label = document.querySelector(`[data-ctx-label="${sessionId}"]`);
  if (!fill || !label) return;

  const s = sessionsStore[sessionId];
  const limit = s?.model?.includes('opus') ? 1000000 : 200000;
  const pct   = Math.min(100, Math.round(((usage.input_tokens || 0) / limit) * 100));

  fill.style.width = pct + '%';
  if (pct >= 80) fill.classList.add('high');
  label.textContent = `${pct}% (${((usage.input_tokens || 0) / 1000).toFixed(1)}k / ${(limit / 1000).toFixed(0)}k)`;
}
```

---

## Minimized Row (Running Sessions Summary)

```js
function updateMiniRow() {
  const row = document.getElementById('minimized-row');
  row.innerHTML = '';
  const running = sessionOrder.filter(id => sessionsStore[id]?.status === 'running');
  for (const id of running) {
    const chip = document.createElement('div');
    chip.className = 'mini-card';
    chip.textContent = sessionsStore[id].name;
    chip.onclick = () => selectSession(id);
    row.appendChild(chip);
  }
}
```
