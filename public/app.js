'use strict';

(function () {
  const FILENAME = document.querySelector('.editor-filename')?.textContent.trim() || '';
  const nameInput = document.getElementById('editor-name');
  const logContainer = document.getElementById('log');
  const statusEl = document.getElementById('editor-status');
  const conflictWarning = document.getElementById('conflict-warning');
  const applyBtn = document.getElementById('apply-btn');
  const deleteBtn = document.getElementById('delete-btn');
  const codeTextarea = document.getElementById('code-editor');

  const savedName = localStorage.getItem('editor-name');
  if (savedName && !nameInput.value) nameInput.value = savedName;

  // ── CodeMirror ────────────────────────────────────────────────────
  const modeMap = {
    '.json': { name: 'javascript', json: true },
    '.yml': 'yaml', '.yaml': 'yaml',
    '.properties': 'properties',
    '.xml': 'xml', '.html': 'xml',
    '.js': 'javascript', '.mjs': 'javascript',
    '.py': 'python',
    '.sh': 'shell', '.bash': 'shell',
  };

  const fileExt = FILENAME.lastIndexOf('.') >= 0
    ? FILENAME.slice(FILENAME.lastIndexOf('.')).toLowerCase() : '';

  const cm = CodeMirror.fromTextArea(codeTextarea, {
    mode: modeMap[fileExt] || 'text/plain',
    theme: 'material-darker',
    lineNumbers: true,
    lineWrapping: false,
    indentUnit: 2,
    tabSize: 2,
    indentWithTabs: false,
    autoCloseBrackets: true,
    styleActiveLine: true,
    extraKeys: {
      'Ctrl-S': () => applyFile(),
      'Cmd-S': () => applyFile(),
      'Ctrl-Enter': () => applyFile(),
    },
  });

  const contentEl = document.getElementById('initial-content');
  if (contentEl) {
    cm.setValue(contentEl.textContent);
    contentEl.remove();
  }

  // ── Socket.io ─────────────────────────────────────────────────────
  const socket = io();
  let currentHash = '';

  socket.emit('join-room', FILENAME);

  socket.on('init-logs', (logs) => {
    logContainer.innerHTML = '';
    if (logs.length === 0) {
      logContainer.innerHTML = '<div class="empty-state">No edits yet</div>';
    } else {
      logs.reverse().forEach(addLogEntry);
    }
  });

  socket.on('log:entry', (entry) => addLogEntry(entry, true));

  socket.on('file:updated', (data) => {
    addLogEntry({
      fileName: data.fileName,
      editor: data.editor,
      timestamp: data.timestamp,
      conflict: data.conflict
    }, true);

    if (data.hash !== currentHash && data.content !== undefined) {
      const cursor = cm.getCursor();
      cm.setValue(data.content);
      cm.setCursor(cursor);
      currentHash = data.hash;

      if (data.conflict) {
        conflictWarning.style.display = 'inline-flex';
        conflictWarning.innerHTML = 'File updated by <strong>' + esc(data.editor) + '</strong>';
        setTimeout(() => { conflictWarning.style.display = 'none'; }, 4000);
      }
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function userColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return 'hsl(' + (Math.abs(hash) % 360) + ', 60%, 55%)';
  }

  function addLogEntry(data, prepend) {
    const empty = logContainer.querySelector('.empty-state');
    if (empty) empty.remove();

    const entry = document.createElement('div');
    entry.className = 'log-entry';
    const time = new Date(data.timestamp).toLocaleTimeString('ja-JP');
    const color = userColor(data.editor);
    const badge = data.conflict
      ? '<span class="log-conflict">⚠ overwrote ' + esc(data.overwrittenEditor || 'someone') + '</span>'
      : '';
    entry.innerHTML =
      '<span class="log-time">' + time + '</span>' +
      '<span class="log-body">' +
        '<span class="log-editor" style="color:' + color + '">' + esc(data.editor) + '</span>' +
        '<span class="log-action"> applied </span>' +
        badge +
      '</span>';

    if (prepend) {
      logContainer.insertBefore(entry, logContainer.firstChild);
    } else {
      logContainer.appendChild(entry);
    }
    logContainer.scrollTop = prepend ? 0 : logContainer.scrollHeight;

    while (logContainer.children.length > 200) logContainer.removeChild(logContainer.lastChild);
  }

  // ── Apply ──────────────────────────────────────────────────────────
  async function applyFile() {
    const editor = nameInput.value.trim().slice(0, 50);
    if (!editor) {
      alert('Please enter your name before applying.');
      nameInput.focus();
      return;
    }

    localStorage.setItem('editor-name', editor);

    const content = cm.getValue();
    applyBtn.disabled = true;
    applyBtn.textContent = 'Saving…';
    statusEl.textContent = 'Saving…';

    try {
      const res = await fetch('/api/files/' + encodeURIComponent(FILENAME), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          editor,
          expectedHash: currentHash
        }),
      });
      const data = await res.json();

      if (data.success) {
        currentHash = data.hash;
        if (data.conflict) {
          statusEl.textContent = 'Saved (overwrote previous edit) ✓';
        } else {
          statusEl.textContent = 'Saved ✓';
        }
      } else {
        statusEl.textContent = 'Error: ' + (data.error || 'unknown');
      }
    } catch (err) {
      statusEl.textContent = 'Network error';
    } finally {
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    }
  }

  applyBtn.addEventListener('click', applyFile);

  // ── Delete ─────────────────────────────────────────────────────────
  deleteBtn.addEventListener('click', () => {
    if (!confirm('Delete "' + FILENAME + '"? This cannot be undone.')) return;
    fetch('/api/files/' + encodeURIComponent(FILENAME), { method: 'DELETE' })
      .then(r => {
        if (r.ok) window.location.href = '/';
        else alert('Delete failed');
      })
      .catch(() => alert('Delete failed'));
  });

  // ── Init ───────────────────────────────────────────────────────────
  (async function init() {
    try {
      const res = await fetch('/api/files/' + encodeURIComponent(FILENAME));
      const data = await res.json();
      currentHash = data.hash;
      cm.setValue(data.content);
      cm.clearHistory();
      cm.focus();
    } catch { }
  })();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.location.href = '/';
  });

})();
