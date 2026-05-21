'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── config ────────────────────────────────────────────────────────
const STORAGE_DIR = path.join(__dirname, 'storage');
const META_FILE = path.join(__dirname, 'file-meta.json');
const PORT = parseInt(process.env.PORT, 10) || 64991;
const MAX_LOG = 500;

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

// ── in-memory state ───────────────────────────────────────────────
let fileMeta = {};
let activityLog = [];

function loadMeta() {
  try {
    if (fs.existsSync(META_FILE)) fileMeta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch { fileMeta = {}; }
}
function saveMeta() {
  fs.writeFileSync(META_FILE, JSON.stringify(fileMeta, null, 2), 'utf8');
}

loadMeta();

// ── helpers ───────────────────────────────────────────────────────
function hashOf(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function safeName(name) {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  if (name.length > 255) return null;
  const clean = name.replace(/[<>:"|?*\x00-\x1f]/g, '_');
  return clean || null;
}

function pushLog(entry) {
  activityLog.push(entry);
  if (activityLog.length > MAX_LOG * 2) activityLog = activityLog.slice(-MAX_LOG);
}

function fileExt(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function syncMetaFromDisk() {
  let changed = false;
  let entries;
  try { entries = fs.readdirSync(STORAGE_DIR, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (fileMeta[e.name]) continue;
    try {
      const content = fs.readFileSync(path.join(STORAGE_DIR, e.name), 'utf8');
      fileMeta[e.name] = { hash: hashOf(content), editor: '', modified: '' };
      changed = true;
    } catch { }
  }
  if (changed) saveMeta();
}
syncMetaFromDisk();

// ── express ───────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── page routes ───────────────────────────────────────────────────

// Home – file list
app.get('/', (_req, res) => {
  let files = [];
  try {
    const entries = fs.readdirSync(STORAGE_DIR, { withFileTypes: true });
    files = entries
      .filter(e => e.isFile())
      .map(e => {
        const m = fileMeta[e.name] || {};
        return {
          name: e.name,
          ext: fileExt(e.name).replace('.', ''),
          editor: m.editor || '',
          modified: m.modified || '',
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { /* empty */ }
  res.render('index', { files });
});

// Editor page for a specific file
app.get('/edit/:name', (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(400).send('Invalid filename');

  const filePath = path.join(STORAGE_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

  const content = fs.readFileSync(filePath, 'utf8');
  const m = fileMeta[name] || {};
  const ext = fileExt(name);

  // recent logs for this file
  const fileLogs = activityLog.filter(l => l.fileName === name).slice(-50);

  res.render('editor', {
    name,
    content,
    hash: m.hash || hashOf(content),
    editor: m.editor || '',
    modified: m.modified || '',
    ext,
    fileLogs,
  });
});

// ── api routes ────────────────────────────────────────────────────

// list files
app.get('/api/files', (_req, res) => {
  let entries;
  try { entries = fs.readdirSync(STORAGE_DIR, { withFileTypes: true }); } catch {
    return res.json([]);
  }
  const result = entries
    .filter(e => e.isFile())
    .map(e => {
      const m = fileMeta[e.name] || {};
      return { name: e.name, hash: m.hash || '', editor: m.editor || '', modified: m.modified || '' };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(result);
});

// get file content + meta
app.get('/api/files/:name', (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid filename' });
  const filePath = path.join(STORAGE_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const content = fs.readFileSync(filePath, 'utf8');
  const m = fileMeta[name] || {};
  res.json({
    name, content,
    hash: m.hash || hashOf(content),
    editor: m.editor || '',
    modified: m.modified || '',
  });
});

// create new file
app.post('/api/files', (req, res) => {
  let { name } = req.body;
  const sname = safeName(name);
  if (!sname) return res.status(400).json({ error: 'Invalid filename' });

  name = sname.includes('.') ? sname : sname + '.txt';
  const filePath = path.join(STORAGE_DIR, name);
  if (fs.existsSync(filePath)) return res.status(409).json({ error: 'File already exists' });

  fs.writeFileSync(filePath, '', 'utf8');
  const h = hashOf('');
  fileMeta[name] = { hash: h, editor: '', modified: new Date().toISOString() };
  saveMeta();

  pushLog({ fileName: name, editor: 'system', action: 'created', timestamp: new Date().toISOString() });

  res.status(201).json({ success: true, name });
});

// apply edit (last-writer-wins)
app.post('/api/files/:name', (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid filename' });

  const { content, editor, expectedHash } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });

  const filePath = path.join(STORAGE_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const editorName = (typeof editor === 'string' && editor.trim())
    ? editor.trim().replace(/[\x00-\x1f]/g, '').slice(0, 50)
    : 'anonymous';
  const prev = fileMeta[name];

  // conflict detection (informational — we always apply)
  const conflict = !!(prev && typeof expectedHash === 'string' && expectedHash.length > 0
    && expectedHash !== prev.hash);

  // write file (last writer wins)
  fs.writeFileSync(filePath, content, 'utf8');

  // update hash AFTER file write is complete
  const newHash = hashOf(content);
  fileMeta[name] = { hash: newHash, editor: editorName, modified: new Date().toISOString() };
  saveMeta();

  const logEntry = {
    fileName: name,
    editor: editorName,
    timestamp: fileMeta[name].modified,
    hash: newHash,
    conflict,
    overwrittenEditor: conflict ? (prev ? prev.editor : '') : '',
  };
  pushLog(logEntry);

  // broadcast to file room via socket.io
  io.to(roomName(name)).emit('file:updated', {
    fileName: name,
    content,
    editor: editorName,
    timestamp: logEntry.timestamp,
    hash: newHash,
    conflict,
  });

  // broadcast log entry
  io.to(roomName(name)).emit('log:entry', logEntry);

  res.json({
    success: true,
    hash: newHash,
    modified: fileMeta[name].modified,
    conflict,
  });
});

// delete file
app.delete('/api/files/:name', (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid filename' });
  const filePath = path.join(STORAGE_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  fs.unlinkSync(filePath);
  delete fileMeta[name];
  saveMeta();
  res.json({ success: true });
});

// download file (for Minecraft server to fetch)
app.get('/api/files/:name/download', (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid filename' });
  const filePath = path.join(STORAGE_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.download(filePath, name);
});

// lightweight hash endpoint — O(1) in-memory lookup for high-frequency polling
app.get('/api/hash/:name', (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid filename' });

  const m = fileMeta[name];
  if (m) {
    return res.json({ fileName: name, hash: m.hash, editor: m.editor, modified: m.modified });
  }

  // fallback: read from disk if not in cache
  const filePath = path.join(STORAGE_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const h = hashOf(content);
    fileMeta[name] = { hash: h, editor: '', modified: '' };
    saveMeta();
    return res.json({ fileName: name, hash: h, editor: '', modified: '' });
  } catch {
    return res.status(500).json({ error: 'Unable to read file' });
  }
});

// recent activity log
app.get('/api/log', (_req, res) => {
  res.json(activityLog.slice(-100));
});

// rename file
app.put('/api/files/:name', (req, res) => {
  const oldName = safeName(req.params.name);
  if (!oldName) return res.status(400).json({ error: 'Invalid filename' });

  const { newName } = req.body;
  const sn = safeName(newName);
  if (!sn) return res.status(400).json({ error: 'Invalid newName' });

  const oldPath = path.join(STORAGE_DIR, oldName);
  const newPath = path.join(STORAGE_DIR, sn);
  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'File not found' });
  if (fs.existsSync(newPath)) return res.status(409).json({ error: 'Target already exists' });

  fs.renameSync(oldPath, newPath);
  fileMeta[sn] = fileMeta[oldName];
  delete fileMeta[oldName];
  saveMeta();
  res.json({ success: true, name: sn });
});

// ── socket.io ─────────────────────────────────────────────────────
function roomName(filename) {
  return 'file:' + filename;
}

io.on('connection', (socket) => {
  socket.on('join-room', (filename) => {
    const name = safeName(filename);
    if (!name) return;

    // leave any previous room
    for (const r of socket.rooms) {
      if (r !== socket.id) socket.leave(r);
    }
    socket.join(roomName(name));

    // send existing logs for this file
    const logs = activityLog.filter(l => l.fileName === name).slice(-50);
    socket.emit('init-logs', logs);
  });

  socket.on('disconnect', () => {
    // socket.io auto-cleans rooms on disconnect
  });
});

// ── start ─────────────────────────────────────────────────────────
function tryListen(port, retries) {
  server.removeAllListeners('error');
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.log(`Port ${port} in use, trying ${port + 1}...`);
      server.close();
      tryListen(port + 1, retries - 1);
    } else {
      console.error(`Failed to start: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, () => {
    console.log('═'.repeat(50));
    console.log('  File Editor Server');
    console.log(`  http://localhost:${port}`);
    console.log('═'.repeat(50));
    console.log('  Endpoints:');
    console.log(`  GET  /                      File list`);
    console.log(`  GET  /edit/:name             Editor page`);
    console.log(`  POST /api/files              Create file`);
    console.log(`  POST /api/files/:name        Apply edit`);
    console.log(`  GET  /api/files/:name/download  Download file`);
    console.log(`  GET  /api/hash/:name         Hash info (fast)`);
    console.log(`  GET  /api/log                Activity log`);
    console.log('═'.repeat(50));
  });
}

tryListen(PORT, 10);

function shutdown() {
  console.log('\nShutting down...');
  saveMeta();
  io.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
