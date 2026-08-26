const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const SETTINGS_PATH = path.join(ROOT, 'settings.json');
const LOG_DIR = path.join(ROOT, 'logs');
const COLLECT_JS = path.join(ROOT, 'collect_likes.js');
const LOGIN_JS = path.join(ROOT, 'login_download_account.js');
const COLLECT_IMAGES_JS = path.join(ROOT, 'collect_images.js');
const DOWNLOAD_IMAGES_JS = path.join(ROOT, 'download_images.js');
const LOCK_FILE = path.join(ROOT, '.gui.lock');

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

const writeJson = (p, data) => {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
};

const resolveRel = (p) => (path.isAbsolute(p) ? p : path.resolve(ROOT, p));

let config = readJson(CONFIG_PATH) || {};
let settings = readJson(SETTINGS_PATH) || {};

const nodePath = resolveRel(config.nodePath || 'node.exe');
const nodeModules = resolveRel(config.nodeModules || '');
const pythonPath = resolveRel(config.pythonPath || 'python.exe');
const urlsFile = resolveRel(config.urlsFile || 'liked_urls.txt');
const cookiesFile = resolveRel(config.cookiesFile || 'cookies.txt');
const downloadCookiesFile = resolveRel(config.downloadCookiesFile || 'cookies_download.txt');
const archiveFile = resolveRel(config.archiveFile || 'archive.txt');
const manualUrlsFile = path.join(ROOT, 'manual_urls.txt');
const imageUrlsFile = resolveRel(config.imageUrlsFile || 'image_urls.txt');
const retryUrlsFile = path.join(ROOT, 'retry_urls.txt');
const activeBatchFile = path.join(ROOT, 'active_batch.txt');
const skipUrlsFile = path.join(ROOT, 'skipped_urls.txt');
const downloadDir = resolveRel(config.downloadDir || 'videos');

function readSkipSet() {
  const set = new Set();
  try {
    const text = fs.readFileSync(skipUrlsFile, 'utf8');
    text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((url) => set.add(url));
  } catch {
    /* no skips yet */
  }
  return set;
}

function appendSkipUrl(url) {
  try {
    fs.appendFileSync(skipUrlsFile, `${url}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

function writeListFile(file, urls) {
  fs.writeFileSync(file, `${urls.join('\n')}\n`, 'utf8');
}

function filterBatchFile(file, skipSet) {
  const urls = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((url) => !skipSet.has(url));
  if (!urls.length) return null;
  writeListFile(activeBatchFile, urls);
  return activeBatchFile;
}

function writeRemainingBatch(file, anchorUrl, skipSet) {
  const urls = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const idx = urls.indexOf(anchorUrl);
  const remaining = (idx === -1 ? urls : urls.slice(idx + 1)).filter(
    (url) => !skipSet.has(url)
  );
  if (!remaining.length) return null;
  writeListFile(activeBatchFile, remaining);
  return activeBatchFile;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function tryAcquireLock() {
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    fs.closeSync(fd);
    return { acquired: true };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    /* stale or unreadable lock */
  }
  if (existing && isPidAlive(existing.pid)) {
    return { acquired: false, port: existing.port };
  }

  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    fs.closeSync(fd);
    return { acquired: true };
  } catch {
    return { acquired: false, port: null };
  }
}

function updateLock(port) {
  try {
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }),
      'utf8'
    );
  } catch {
    /* ignore */
  }
}

function removeLock() {
  try {
    const data = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (data.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
}

function showAlreadyRunning(port) {
  const url = `http://127.0.0.1:${port || 8765}`;
  console.log(`GUI is already running at ${url}`);
  if (process.env.NO_POPUP !== '1') {
    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('X 下载器已经在运行。当前地址：${url}', 'X 下载器', 'OK', 'Information')`;
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
        res.on('end', () => resolve(body.includes('X 喜欢视频下载器')));
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
  try {
    const res = spawnSync(
      pythonPath,
      ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],
      { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } }
    );
    return res.stdout.trim();
  } catch {
    return '';
  }
}

const ffmpegPath = getFfmpegPath();

function buildOutputTemplate() {
  const subPaths = {
    flat: '',
    uploader: '%(uploader|unknown)s/',
    month: '%(upload_date>%Y-%m|unknown)s/',
    uploader_month: '%(uploader|unknown)s/%(upload_date>%Y-%m|unknown)s/',
  };
  const subPath = subPaths[settings.folderMode] || '';
  const titlePart = settings.nameMode === 'structured_title' ? ' - %(title).40s' : '';
  return path.join(
    downloadDir,
    `${subPath}%(upload_date|unknown)s - %(uploader|unknown)s - %(id)s${titlePart}%(playlist_index& - {0}|)s.%(ext)s`
  );
}

function buildYtdlpArgs(urls, force) {
  const activeCookies =
    settings.useDownloadAccount && fs.existsSync(downloadCookiesFile)
      ? downloadCookiesFile
      : cookiesFile;
  const args = [
    '--batch-file', urls,
    '--cookies', activeCookies,
    '--ignore-errors',
    '--newline',
    '--no-colors',
    '--retries', '10',
    '--extractor-retries', '10',
    '--fragment-retries', '10',
    '--file-access-retries', '10',
    '--retry-sleep', '3',
    '--sleep-requests', '2',
    '--sleep-interval', '2',
    '--socket-timeout', '30',
    '--http-chunk-size', '10M',
    '--legacy-server-connect',
    '--concurrent-fragments', '3',
    '--yes-playlist',
    '-f', 'best/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', buildOutputTemplate(),
  ];

  if (force) {
    args.push('--force-overwrites');
  } else {
    args.push('--download-archive', archiveFile);
  }

  if (settings.proxy === 'off') {
    args.push('--proxy', '');
  } else if (settings.proxy === 'custom' && settings.proxyUrl) {
    args.push('--proxy', settings.proxyUrl);
  }

  if (ffmpegPath) {
    args.push('--ffmpeg-location', ffmpegPath);
  }

  return args;
}

function baseState() {
  return {
    running: false,
    status: 'idle',
    message: '',
    currentFile: '',
    currentIndex: 0,
    fileCount: 0,
    totalLinks: 0,
    percent: 0,
    speed: '',
    eta: '',
    elapsed: 0,
    progressLine: '',
    logs: [],
    failures: [],
  };
}

let job = null;
let jobTimer = null;
let clients = new Set();
let lastPushAt = 0;
let hasEverHadClient = false;
let shutdownTimer = null;
let guiCloseRequested = false;

function publicState() {
  const s = job ? job.state : baseState();
  return {
    state: s,
    settings,
    config: {
      username: config.username || '',
      downloadDir: config.downloadDir || 'videos',
      downloadAccountReady: fs.existsSync(downloadCookiesFile),
      downloadCookiesFile: path.basename(downloadCookiesFile),
    },
  };
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      clients.delete(res);
    }
  }
}

function cancelAutoShutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
}

function scheduleAutoShutdown() {
  if (!hasEverHadClient || (job && job.state.running)) return;
  if (shutdownTimer) return;
  if (!guiCloseRequested && clients.size > 0) return;
  shutdownTimer = setTimeout(() => {
    console.log('GUI closed, shutting down server');
    removeLock();
    process.exit(0);
  }, 8000);
}

function sweepClients() {
  for (const res of clients) {
    try {
      res.write(': ping\n\n');
    } catch {
      clients.delete(res);
    }
  }
  if (!hasEverHadClient || (job && job.state.running) || shutdownTimer) return;
  if (clients.size === 0) {
    shutdownTimer = setTimeout(() => {
      console.log('GUI closed, shutting down server');
      removeLock();
      process.exit(0);
    }, 8000);
  }
}

function addLog(line) {
  if (!job) return;
  job.state.logs.push(line);
  if (job.state.logs.length > 2000) {
    job.state.logs.splice(0, job.state.logs.length - 2000);
  }
}

function pushState(force = false) {
  if (!job) return;
  const now = Date.now();
  if (!force && now - lastPushAt < 300) return;
  lastPushAt = now;
  broadcast({ type: 'state', ...publicState() });
}

function lineCount(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
  } catch {
    return 0;
  }
}

function killTree(pid) {
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

function runProcess(cmd, args, env, onLine) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    job.child = child;
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
      addLog(`[process] ${err.message}`);
      resolve(1);
    });
    child.on('close', (code) => {
      if (buffer.trim()) onLine(buffer.trim());
      resolve(code === null ? 1 : code);
    });
  });
}

const progressRe = /^\[download\]\s+([\d.]+)% of\s+~?([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)\s+ETA ([\d:]+|Unknown)/;
const doneRe = /^\[download\]\s+100% of .+ in [\d:]+ at ([\d.]+\w+\/s)/;
const destRe = /^\[download\] Destination: (.+)$/;
const itemRe = /^\[download\] Downloading item (\d+) of (\d+)/;
const extractRe = /^\[[^\]]+\] Extracting URL: (.+)$/;
const infoRe = /^\[info\] (\S+): Downloading/;

function parseDownloadLine(line) {
  if (!job) return;

  const progressMatch = line.match(progressRe);
  if (progressMatch) {
    job.state.percent = Number(progressMatch[1]);
    job.state.speed = progressMatch[3];
    job.state.eta = progressMatch[4] === 'Unknown' ? '未知' : progressMatch[4];
    job.state.progressLine = line;
    pushState();
    return;
  }

  addLog(line);

  let m = line.match(extractRe);
  if (m) {
    job.state.currentUrl = m[1];
    pushState();
    return;
  }

  m = line.match(destRe);
  if (m) {
    job.state.currentFile = path.basename(m[1].trim());
    job.state.fileCount += 1;
    job.state.currentIndex = job.state.fileCount;
    pushState();
    return;
  }

  m = line.match(itemRe);
  if (m) {
    job.state.currentIndex = Number(m[1]);
    pushState();
    return;
  }

  m = line.match(infoRe);
  if (m) {
    job.state.currentFile = m[1];
    pushState();
    return;
  }

  m = line.match(doneRe);
  if (m) {
    job.state.percent = 100;
    job.state.speed = m[1];
    job.state.eta = '';
    job.state.progressLine = '';
    pushState();
    return;
  }

  if (line.startsWith('ERROR:')) {
    job.state.failures.push({
      url: job.state.currentUrl || '',
      message: line.replace(/^ERROR:\s*/, ''),
    });
    pushState(true);
    return;
  }

  pushState();
}

function parseImageLine(line) {
  if (!job) return;
  addLog(line);

  let m = line.match(/\[image\] (\d+)\/(\d+) (\S+) \(\d+ bytes\)/);
  if (m) {
    job.state.currentIndex = Number(m[1]);
    job.state.totalLinks = Number(m[2]);
    job.state.fileCount = Number(m[1]);
    job.state.currentFile = m[3];
    job.state.percent = Math.round((Number(m[1]) / Number(m[2])) * 1000) / 10;
    pushState();
    return;
  }

  m = line.match(/\[image\] FAIL (.+)/);
  if (m) {
    job.state.failures.push({
      url: `图片 ${m[1]}`,
      message: '图片下载失败',
    });
    pushState(true);
    return;
  }

  if (line.includes('图片下载完成')) {
    job.state.percent = 100;
    pushState(true);
    return;
  }

  pushState();
}

async function runDownload(urls, force, ignoreSkips = false) {
  job.state.status = 'downloading';
  job.state.message = '正在下载';
  job.state.currentFile = '';
  job.state.currentIndex = 0;
  job.state.fileCount = 0;
  job.state.percent = 0;
  job.state.speed = '';
  job.state.eta = '';
  if (settings.useDownloadAccount && !fs.existsSync(downloadCookiesFile)) {
    addLog('[job] 未找到小号 Cookie，本次回退使用主账号 Cookie');
  }

  const skipSet = ignoreSkips ? new Set() : readSkipSet();
  let allFailures = [];
  let activeBatch = filterBatchFile(urls, skipSet);
  const maxRounds = 5;
  let retryRound = 0;

  if (!activeBatch) {
    job.state.status = 'done';
    job.state.message = '列表中的视频都已被跳过，无需下载';
    addLog('[job] 列表中的视频都已被跳过，无需下载');
    broadcast({ type: 'state', ...publicState() });
    return;
  }

  while (!job.cancelled) {
    job.state.totalLinks = lineCount(activeBatch);
    addLog(`[job] 开始下载 ${job.state.totalLinks} 条链接`);
    broadcast({ type: 'state', ...publicState() });

    const args = buildYtdlpArgs(activeBatch, force);
    const code = await runProcess(
      pythonPath,
      ['-m', 'yt_dlp', ...args],
      { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      parseDownloadLine
    );

    if (job.cancelled) return;

    if (job.skipRequested) {
      const skippedUrl = job.state.currentUrl;
      job.skipRequested = false;
      if (skippedUrl && !skipSet.has(skippedUrl)) {
        skipSet.add(skippedUrl);
        appendSkipUrl(skippedUrl);
        allFailures.push({ url: skippedUrl, message: '用户已跳过' });
        job.state.failures = [...allFailures];
        addLog(`[job] 已跳过：${skippedUrl}`);
        broadcast({ type: 'state', ...publicState() });
      }
      activeBatch = skippedUrl
        ? writeRemainingBatch(activeBatch, skippedUrl, skipSet)
        : filterBatchFile(activeBatch, skipSet);
      if (!activeBatch) break;
      addLog(`[job] 从下一个视频继续，剩余 ${lineCount(activeBatch)} 条`);
      broadcast({ type: 'state', ...publicState() });
      continue;
    }

    if (code !== 0 && job.state.failures.length === 0) {
      throw new Error(`下载异常，退出码 ${code}`);
    }
    if (job.state.failures.length === 0) break;

    const retryUrls = job.state.failures
      .map((f) => f.url)
      .filter(Boolean)
      .filter((url) => !skipSet.has(url));
    if (!retryUrls.length) break;
    allFailures.push(...job.state.failures);
    job.state.failures = [];
    retryRound++;
    if (retryRound > maxRounds) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
    writeListFile(retryUrlsFile, retryUrls);
    activeBatch = retryUrlsFile;
    job.state.totalLinks = retryUrls.length;
    addLog(`[job] 第 ${retryRound} 次重试 ${retryUrls.length} 条失败链接`);
    broadcast({ type: 'state', ...publicState() });
  }

  if (job.state.failures.length) {
    allFailures.push(...job.state.failures);
  }
  const seenFailed = new Set();
  job.state.failures = allFailures.filter((f) => {
    if (seenFailed.has(f.url)) return false;
    seenFailed.add(f.url);
    return true;
  });
  addLog(`[job] 下载结束，失败 ${job.state.failures.length} 条`);
}

async function runCollect(count, stopOnOld = false, mode = 'recent') {
  job.state.status = 'collecting';
  job.state.message = `正在采集最近 ${count} 条喜欢视频`;
  addLog(`[job] 开始采集最近 ${count} 条喜欢视频`);
  broadcast({ type: 'state', ...publicState() });

  const code = await runProcess(
    nodePath,
    [COLLECT_JS, CONFIG_PATH],
    {
      ...process.env,
      NODE_PATH: nodeModules,
      COLLECT_MAX_LIKES: String(count),
      COLLECT_STOP_ON_OLD: stopOnOld ? '1' : '0',
      COLLECT_MODE: mode,
    },
    (line) => {
      addLog(line);
      pushState();
      const m = line.match(/\[collect\] 已检测到登录状态/);
      if (m) {
        job.state.message = '已登录，正在滚动喜欢列表';
        broadcast({ type: 'state', ...publicState() });
      }
    }
  );

  if (job.cancelled) return;
  if (code !== 0) {
    throw new Error(`采集失败，退出码 ${code}`);
  }

  const text = fs.existsSync(urlsFile) ? fs.readFileSync(urlsFile, 'utf8') : '';
  const urls = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!urls.length) {
    job.state.status = 'done';
    job.state.message = '没有找到新的视频推文';
    addLog('[job] 没有找到新的视频推文');
    broadcast({ type: 'state', ...publicState() });
    return;
  }

  await runDownload(urlsFile, false);
}

function startJob(mode, body) {
  if (job) return { ok: false, error: '已有任务在运行' };

  job = {
    state: baseState(),
    child: null,
    cancelled: false,
    skipRequested: false,
    startedAt: Date.now(),
  };
  job.state.running = true;
  job.state.status = 'starting';
  job.state.message = '准备中';

  jobTimer = setInterval(() => {
    if (job) {
      job.state.elapsed = Math.floor((Date.now() - job.startedAt) / 1000);
      pushState(true);
    }
  }, 1000);

  broadcast({ type: 'state', ...publicState() });

  (async () => {
    try {
      if (mode === 'manual') {
        const links = (body.links || [])
          .map((s) => String(s).trim())
          .filter((s) => /^https?:\/\//i.test(s));
        if (!links.length) throw new Error('没有有效的链接');
        fs.writeFileSync(manualUrlsFile, `${links.join('\n')}\n`, 'utf8');
        addLog(`[job] 收到 ${links.length} 条手动链接`);
        await runDownload(manualUrlsFile, !!settings.forceRedownload, true);
      } else if (mode === 'refresh') {
        await runCollect(20, true);
      } else if (mode === 'login_download') {
        job.state.status = 'logging_in';
        job.state.message = '正在打开下载小号登录窗口';
        addLog('[job] 开始下载小号登录流程');
        broadcast({ type: 'state', ...publicState() });
        const code = await runProcess(
          nodePath,
          [LOGIN_JS, CONFIG_PATH],
          { ...process.env, NODE_PATH: nodeModules },
          (line) => {
            addLog(line);
            pushState();
          }
        );
        if (job.cancelled) return;
        if (code !== 0) {
          throw new Error(`小号登录失败，退出码 ${code}`);
        }
        settings.useDownloadAccount = true;
        writeJson(SETTINGS_PATH, settings);
        job.state.message = '下载账号 Cookie 已保存';
        addLog('[job] 下载账号 Cookie 已保存');
      } else if (mode === 'download') {
        await runCollect(50, true);
      } else if (mode === 'backfill') {
        await runCollect(Number(body.count) || 50, false, 'backfill');
      } else if (mode === 'images') {
        const imageSource = body.source === 'bookmarks' ? 'bookmarks' : 'likes';
        const imageCount = Number(body.count) || 50;
        job.state.status = 'collecting_images';
        job.state.message = `正在采集${imageSource === 'bookmarks' ? '书签' : '喜欢'}图片`;
        addLog(`[job] 开始采集${imageSource === 'bookmarks' ? '书签' : '喜欢'}图片，目标 ${imageCount} 张`);
        broadcast({ type: 'state', ...publicState() });
        const c1 = await runProcess(
          nodePath,
          [COLLECT_IMAGES_JS, CONFIG_PATH],
          {
            ...process.env,
            NODE_PATH: nodeModules,
            IMAGE_SOURCE: imageSource,
            IMAGE_MAX: String(imageCount),
          },
          (line) => {
            addLog(line);
            pushState();
          }
        );
        if (job.cancelled) return;
        if (c1 !== 0) throw new Error(`图片采集失败，退出码 ${c1}`);

        job.state.status = 'downloading_images';
        job.state.message = '正在下载图片';
        broadcast({ type: 'state', ...publicState() });
        const c2 = await runProcess(
          nodePath,
          [DOWNLOAD_IMAGES_JS, CONFIG_PATH],
          process.env,
          parseImageLine
        );
        if (job.cancelled) return;
        if (c2 !== 0) throw new Error(`图片下载失败，退出码 ${c2}`);
      } else if (mode === 'images_manual') {
        const links = (body.links || [])
          .map((s) => String(s).trim())
          .filter((s) => /^https?:\/\//i.test(s));
        if (!links.length) throw new Error('没有有效的图片链接');
        fs.writeFileSync(imageUrlsFile, `${links.join('\n')}\n`, 'utf8');
        job.state.status = 'downloading_images';
        job.state.message = '正在下载图片';
        addLog(`[job] 收到 ${links.length} 条图片链接`);
        broadcast({ type: 'state', ...publicState() });
        const c2 = await runProcess(
          nodePath,
          [DOWNLOAD_IMAGES_JS, CONFIG_PATH],
          process.env,
          parseImageLine
        );
        if (job.cancelled) return;
        if (c2 !== 0) throw new Error(`图片下载失败，退出码 ${c2}`);
      } else {
        const count =
          mode === '50' ? 50 : mode === '100' ? 100 : Number(body.count);
        if (!Number.isInteger(count) || count <= 0) throw new Error('采集数量无效');
        await runCollect(count);
      }

      if (!job.cancelled) {
        job.state.status = 'done';
        job.state.message = '完成';
        addLog('[job] 完成');
      }
    } catch (err) {
      if (job) {
        job.state.status = 'error';
        job.state.message = err.message;
        addLog(`[error] ${err.message}`);
      }
    } finally {
      if (job) {
        job.state.running = false;
        clearInterval(jobTimer);
        writeJobFiles();
        broadcast({ type: 'state', ...publicState() });
        job = null;
      }
      scheduleAutoShutdown();
    }
  })();

  return { ok: true };
}

function writeJobFiles() {
  if (!job) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const runLog = path.join(LOG_DIR, `run_${stamp}.log`);
    fs.writeFileSync(runLog, `${job.state.logs.join('\n')}\n`, 'utf8');

    if (job.state.failures.length) {
      const failFile = path.join(LOG_DIR, `failures_${stamp}.txt`);
      const failText = job.state.failures
        .map((f) => `${f.url}\n${f.message}\n---`)
        .join('\n');
      fs.writeFileSync(failFile, `${failText}\n`, 'utf8');
      fs.appendFileSync(
        path.join(LOG_DIR, 'errors.log'),
        `[${stamp}] ${job.state.failures.length} 条失败\n${failText}\n`,
        'utf8'
      );
    }
  } catch {
    /* ignore */
  }
}

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

const htmlCache = fs.readFileSync(path.join(ROOT, 'gui.html'), 'utf8');

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
    hasEverHadClient = true;
    guiCloseRequested = false;
    cancelAutoShutdown();
    clients.add(res);
    const handleClose = () => {
      clients.delete(res);
      scheduleAutoShutdown();
    };
    req.on('close', handleClose);
    res.on('close', handleClose);
    return;
  }

  if (req.method === 'POST' && url === '/api/gui-close') {
    req.resume();
    guiCloseRequested = true;
    scheduleAutoShutdown();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url === '/api/settings') {
    const body = await readBody(req);
    settings = { ...settings, ...body.settings };
    writeJson(SETTINGS_PATH, settings);
    broadcast({ type: 'settings', ...publicState() });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url === '/api/run') {
    const body = await readBody(req);
    const result = startJob(body.mode || '', body);
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === 'POST' && url === '/api/cancel') {
    if (job && job.child) {
      job.cancelled = true;
      killTree(job.child.pid);
      job.state.status = 'cancelled';
      job.state.message = '已停止';
      addLog('[job] 已停止');
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url === '/api/skip') {
    if (job && job.child && job.state.status === 'downloading') {
      job.skipRequested = true;
      killTree(job.child.pid);
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 409, { ok: false, error: '当前没有正在下载的视频' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not Found' });
};

const preferredPort = Number(process.env.GUI_PORT) || 8765;

function startServer(port) {
  if (port > preferredPort + 20) {
    console.error('No free port available for the GUI server');
    process.exit(1);
  }

  const server = http.createServer(requestHandler);
  server.once('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      if (await probeGui(port)) {
        removeLock();
        showAlreadyRunning(port);
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
    updateLock(actualPort);
    console.log(`X video downloader GUI: http://127.0.0.1:${actualPort}`);
    if (!process.argv.includes('--no-open')) {
      spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${actualPort}`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
  });
}

const lock = tryAcquireLock();
if (!lock.acquired) {
  showAlreadyRunning(lock.port);
  process.exit(0);
}

process.on('exit', removeLock);
process.on('SIGINT', () => {
  removeLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  removeLock();
  process.exit(0);
});

startServer(preferredPort);
setInterval(sweepClients, 10000);
