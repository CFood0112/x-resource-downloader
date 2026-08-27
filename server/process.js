const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const state = require('./appState');
const { paths } = require('./config');

function runProcess(cmd, args, env, onLine, onError) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    state.job.child = child;
    let buffer = '';
    const handle = (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line.trim()) onLine(line);
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (err) => {
      if (onError) onError(err.message);
      resolve(1);
    });
    child.on('close', (code) => {
      if (buffer.trim()) onLine(buffer.trim());
      resolve(code === null ? 1 : code);
    });
  });
}

function killTree(pid) {
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function tryAcquireLock(lockFile) {
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    fs.closeSync(fd);
    return { acquired: true };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    /* stale or unreadable lock */
  }
  if (existing && isPidAlive(existing.pid)) {
    return { acquired: false, port: existing.port };
  }

  try {
    fs.unlinkSync(lockFile);
  } catch {
    /* ignore */
  }
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    fs.closeSync(fd);
    return { acquired: true };
  } catch {
    return { acquired: false, port: null };
  }
}

function updateLock(lockFile, port) {
  try {
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }),
      'utf8'
    );
  } catch {
    /* ignore */
  }
}

function removeLock(lockFile) {
  try {
    const data = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (data.pid === process.pid) fs.unlinkSync(lockFile);
  } catch {
    /* ignore */
  }
}

function showAlreadyRunning(runDir, port) {
  const url = `http://127.0.0.1:${port || 8765}`;
  console.log(`GUI is already running at ${url}`);
  try {
    fs.writeFileSync(path.join(runDir, 'gui_ready.txt'), 'ready', 'utf8');
  } catch {
    /* ignore */
  }
  if (process.env.GUI_NO_OPEN !== '1') {
    spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }
  if (process.env.NO_POPUP !== '1') {
    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('X 资源下载器已经在运行。当前地址：${url}', 'X 资源下载器', 'OK', 'Information')`;
    spawn('powershell.exe', ['-NoProfile', '-Command', script], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }
}

function probeGui(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/', timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 8192) req.destroy();
        });
        res.on('end', () => resolve(body.includes('X 资源下载器')));
        res.on('error', () => resolve(false));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function getFfmpegPath() {
  if (paths.ffmpegPathConfig && fs.existsSync(paths.ffmpegPathConfig)) return paths.ffmpegPathConfig;
  try {
    const res = spawnSync(
      paths.pythonPath,
      ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],
      { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } }
    );
    return res.stdout.trim();
  } catch {
    return '';
  }
}

module.exports = {
  runProcess,
  killTree,
  isPidAlive,
  tryAcquireLock,
  updateLock,
  removeLock,
  showAlreadyRunning,
  probeGui,
  getFfmpegPath,
};
