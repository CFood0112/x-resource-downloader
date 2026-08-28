const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const state = require('./appState');
const {
  ROOT,
  CONFIG_PATH,
  SETTINGS_PATH,
  config,
  settings,
  paths,
  writeJson,
  normalizeSettings,
  resolveRel,
} = require('./config');
const { publicState, broadcast } = require('./broadcast');
const { startJob, cancelJob, skipCurrent, startNextQueued } = require('./jobs');
const { persistQueue } = require('./queue');
const {
  tryAcquireLock,
  updateLock,
  removeLock,
  probeGui,
  showAlreadyRunning,
} = require('./process');
const { cancelAutoShutdown, scheduleAutoShutdown } = require('./shutdown');

const htmlCache = fs.readFileSync(path.join(ROOT, 'ui', 'gui.html'), 'utf8');
const EXPORT_JS = path.join(ROOT, 'scripts', 'export_index.js');
const DEDUP_JS = path.join(ROOT, 'scripts', 'dedup_local.js');
const preferredPort = Number(process.env.GUI_PORT) || 8765;

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const requestHandler = async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlCache);
    return;
  }

  if (req.method === 'GET' && url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url === '/api/state') {
    sendJson(res, 200, publicState());
    return;
  }

  if (req.method === 'GET' && url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', ...publicState() })}\n\n`);
    state.hasEverHadClient = true;
    state.guiCloseRequested = false;
    cancelAutoShutdown();
    state.clients.add(res);
    const handleClose = () => {
      state.clients.delete(res);
      scheduleAutoShutdown();
    };
    req.on('close', handleClose);
    res.on('close', handleClose);
    return;
  }

  if (req.method === 'POST' && url === '/api/gui-close') {
    req.resume();
    state.guiCloseRequested = true;
    scheduleAutoShutdown();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url === '/api/settings') {
    const body = await readBody(req);
    const next = normalizeSettings(body.settings || settings);
    Object.keys(next).forEach((k) => {
      settings[k] = next[k];
    });
    writeJson(SETTINGS_PATH, settings);
    broadcast({ type: 'settings', ...publicState() });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url === '/api/browse-dir') {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = '选择下载位置'; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }";
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', script],
      { encoding: 'utf8', timeout: 180000 }
    );
    const selected =
      (result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    sendJson(res, result.status === 0 ? 200 : 500, {
      ok: result.status === 0,
      path: selected,
    });
    return;
  }

  if (req.method === 'POST' && url === '/api/run') {
    const body = await readBody(req);
    const result = startJob(body.mode || '', body);
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === 'POST' && url === '/api/cancel') {
    cancelJob();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url === '/api/skip') {
    const result = skipCurrent();
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === 'GET' && url === '/api/jobs') {
    let jobs = [];
    try {
      jobs = fs
        .readdirSync(paths.jobsDir)
        .filter((f) => f !== 'queue.json' && f.endsWith('.json'))
        .map((f) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(paths.jobsDir, f), 'utf8'));
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    } catch {
      /* ignore */
    }
    sendJson(res, 200, { jobs });
    return;
  }

  if (req.method === 'GET' && url === '/api/queue') {
    sendJson(res, 200, { queue: state.queue });
    return;
  }

  if (req.method === 'POST' && url === '/api/queue/start') {
    const body = await readBody(req);
    const id = String(body.id || '');
    const idx = state.queue.findIndex((q) => q.id === id);
    if (idx === -1) {
      sendJson(res, 404, { ok: false, error: '任务不在队列中' });
      return;
    }
    const [item] = state.queue.splice(idx, 1);
    persistQueue(paths.queueFile, state.queue, state.queuePaused);
    const result = startJob(item.mode, item.body || {});
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === 'POST' && url === '/api/queue/remove') {
    const body = await readBody(req);
    const id = String(body.id || '');
    const idx = state.queue.findIndex((q) => q.id === id);
    if (idx !== -1) {
      state.queue.splice(idx, 1);
      persistQueue(paths.queueFile, state.queue, state.queuePaused);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url === '/api/queue/pause') {
    state.queuePaused = true;
    persistQueue(paths.queueFile, state.queue, state.queuePaused);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url === '/api/queue/resume') {
    state.queuePaused = false;
    persistQueue(paths.queueFile, state.queue, state.queuePaused);
    startNextQueued();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url === '/api/jobs/resume') {
    const body = await readBody(req);
    const file = path.join(
      paths.jobsDir,
      `${String(body.id || '').replace(/[^a-zA-Z0-9-]/g, '')}.json`
    );
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const result = startJob(data.mode, data.body || {});
      sendJson(res, 200, result);
    } catch {
      sendJson(res, 404, { ok: false, error: '任务不存在' });
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/open-dir') {
    const body = await readBody(req);
    const kind = body.kind === 'images' ? 'image' : 'video';
    const dir =
      kind === 'image'
        ? resolveRel((settings.image && settings.image.downloadDir) || config.imageDir || 'images')
        : resolveRel(
            (settings.video && settings.video.downloadDir) || config.downloadDir || 'videos'
          );
    fs.mkdirSync(dir, { recursive: true });
    spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
    sendJson(res, 200, { ok: true, path: dir });
    return;
  }

  if (req.method === 'POST' && url === '/api/export') {
    const runResult = spawnSync(
      paths.nodePath,
      [EXPORT_JS, CONFIG_PATH],
      { encoding: 'utf8', timeout: 180000, env: { ...process.env, NODE_PATH: paths.nodeModules } }
    );
    sendJson(res, runResult.status === 0 ? 200 : 500, {
      ok: runResult.status === 0,
      output: runResult.stdout || runResult.stderr || '',
      path: path.join(ROOT, 'data', 'index.csv'),
    });
    return;
  }

  if (req.method === 'POST' && url === '/api/dedup') {
    const strategy = (settings && settings.dedupStrategy) || 'move';
    const runResult = spawnSync(
      paths.nodePath,
      [DEDUP_JS, CONFIG_PATH],
      {
        encoding: 'utf8',
        timeout: 600000,
        env: { ...process.env, NODE_PATH: paths.nodeModules, DEDUP_STRATEGY: strategy },
      }
    );
    sendJson(res, runResult.status === 0 ? 200 : 500, {
      ok: runResult.status === 0,
      output: runResult.stdout || runResult.stderr || '',
    });
    return;
  }

  sendJson(res, 404, { error: 'Not Found' });
};

function startServer(port) {
  if (port > preferredPort + 20) {
    console.error('No free port available for the GUI server');
    process.exit(1);
  }

  const server = http.createServer(requestHandler);
  server.once('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      if (await probeGui(port)) {
        removeLock(paths.lockFile);
        showAlreadyRunning(paths.runDir, port);
        process.exit(0);
      }
      console.log(`Port ${port} is in use, trying ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error(`Failed to start GUI server: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const actualPort = server.address().port;
    updateLock(paths.lockFile, actualPort);
    console.log(`X video downloader GUI: http://127.0.0.1:${actualPort}`);
    try {
      fs.writeFileSync(path.join(paths.runDir, 'gui_ready.txt'), 'ready', 'utf8');
    } catch {
      /* ignore */
    }
    if (!process.argv.includes('--no-open') && process.env.GUI_NO_OPEN !== '1') {
      spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${actualPort}`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
  });
}

module.exports = { startServer, requestHandler };
