const fs = require('fs');
const path = require('path');
const {
  ROOT,
  CONFIG_PATH,
  SETTINGS_PATH,
  config,
  settings,
  paths,
  writeJson,
  resolveRel,
} = require('./config');
const state = require('./appState');
const { baseState, publicState, broadcast, pushState } = require('./broadcast');
const { runProcess, killTree, getFfmpegPath } = require('./process');
const { buildYtdlpArgs } = require('./ytdlpArgs');
const { nextDownloadCookieFile } = require('./accounts');
const { persistQueue, nextQueueId } = require('./queue');
const {
  readPersistentFailures,
  savePersistentFailures,
  mergeBatchFailures,
} = require('./failures');
const { classifyError } = require('./errors');
const { scheduleAutoShutdown } = require('./shutdown');

const COLLECT_JS = path.join(ROOT, 'collect_likes.js');
const LOGIN_JS = path.join(ROOT, 'login_download_account.js');
const LOGIN_MAIN_JS = path.join(ROOT, 'login_main_account.js');
const COLLECT_IMAGES_JS = path.join(ROOT, 'collect_images.js');
const DOWNLOAD_IMAGES_BROWSER_JS = path.join(ROOT, 'download_images_browser.js');
const RESOLVE_TWEET_IMAGES_JS = path.join(ROOT, 'resolve_tweet_images.js');

const videoMetaSeen = new Set();
const ffmpegPath = getFfmpegPath();

function addLog(line, meta = {}) {
  if (!state.job) return;
  state.job.state.logs.push(line);
  if (state.job.state.logs.length > 2000) {
    state.job.state.logs.splice(0, state.job.state.logs.length - 2000);
  }
  state.job.state.logEntries.push({
    time: new Date().toISOString(),
    taskId: state.job.state.taskId,
    source: meta.source || state.job.state.source || '',
    mediaId: meta.mediaId || state.job.state.currentMediaId || '',
    elapsed: state.job.state.elapsed,
    level: meta.level || 'info',
    message: line,
  });
  if (state.job.state.logEntries.length > 2000) {
    state.job.state.logEntries.splice(0, state.job.state.logEntries.length - 2000);
  }
}

function readSkipSet() {
  const set = new Set();
  try {
    const text = fs.readFileSync(paths.skipUrlsFile, 'utf8');
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
    fs.appendFileSync(paths.skipUrlsFile, `${url}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

function recordVideoMeta(url, mediaId) {
  if (!url || !mediaId) return;
  const key = `${url}\t${mediaId}`;
  if (videoMetaSeen.has(key)) return;
  videoMetaSeen.add(key);
  try {
    fs.appendFileSync(paths.videoMetaFile, `${key}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

function writeJobFile() {
  if (!state.job) return;
  let urls = [];
  try {
    if (fs.existsSync(paths.activeBatchFile)) {
      urls = fs
        .readFileSync(paths.activeBatchFile, 'utf8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  } catch {
    /* ignore */
  }
  const data = {
    id: state.job.state.taskId,
    kind: state.job.state.kind,
    mode: state.job._mode || '',
    source: state.job.state.source || '',
    body: state.job._body || {},
    status: state.job.state.status || 'running',
    createdAt: state.job._startedAt,
    updatedAt: new Date().toISOString(),
    failures: state.lastFailures.length ? state.lastFailures : state.job.state.failures,
    urls,
  };
  try {
    fs.writeFileSync(path.join(paths.jobsDir, `${data.id}.json`), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function startNextQueued() {
  if (state.job || state.queuePaused || !state.queue.length) return;
  const next = state.queue.shift();
  persistQueue(paths.queueFile, state.queue, state.queuePaused);
  startJob(next.mode, next.body);
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
  writeListFile(paths.activeBatchFile, urls);
  return paths.activeBatchFile;
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
  writeListFile(paths.activeBatchFile, remaining);
  return paths.activeBatchFile;
}

function lineCount(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
  } catch {
    return 0;
  }
}

const progressRe = /^\[download\]\s+([\d.]+)% of\s+~?([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)\s+ETA ([\d:]+|Unknown)/;
const doneRe = /^\[download\]\s+100% of .+ in [\d:]+ at ([\d.]+\w+\/s)/;
const destRe = /^\[download\] Destination: (.+)$/;
const itemRe = /^\[download\] Downloading item (\d+) of (\d+)/;
const extractRe = /^\[[^\]]+\] Extracting URL: (.+)$/;
const infoRe = /^\[info\] (\S+): Downloading/;

function parseDownloadLine(line) {
  if (!state.job) return;

  const progressMatch = line.match(progressRe);
  if (progressMatch) {
    state.job.state.percent = Number(progressMatch[1]);
    state.job.state.speed = progressMatch[3];
    state.job.state.eta = progressMatch[4] === 'Unknown' ? '未知' : progressMatch[4];
    state.job.state.progressLine = line;
    pushState();
    return;
  }

  addLog(line);

  let m = line.match(extractRe);
  if (m) {
    state.job.state.currentUrl = m[1];
    pushState();
    return;
  }

  m = line.match(destRe);
  if (m) {
    state.job.state.currentFile = path.basename(m[1].trim());
    const idMatch = state.job.state.currentFile.match(/(\d{15,20})/);
    if (idMatch) {
      state.job.state.currentMediaId = idMatch[1];
      recordVideoMeta(state.job.state.currentUrl, idMatch[1]);
    }
    state.job.state.fileCount += 1;
    state.job.state.currentIndex = state.job.state.fileCount;
    pushState();
    return;
  }

  m = line.match(itemRe);
  if (m) {
    state.job.state.currentIndex = Number(m[1]);
    pushState();
    return;
  }

  m = line.match(infoRe);
  if (m) {
    state.job.state.currentFile = m[1];
    recordVideoMeta(state.job.state.currentUrl, m[1]);
    pushState();
    return;
  }

  m = line.match(doneRe);
  if (m) {
    state.job.state.percent = 100;
    state.job.state.speed = m[1];
    state.job.state.eta = '';
    state.job.state.progressLine = '';
    pushState();
    return;
  }

  if (line.startsWith('ERROR:')) {
    state.job.state.failures.push({
      url: state.job.state.currentUrl || '',
      message: line.replace(/^ERROR:\s*/, ''),
    });
    if (state.job.state.logEntries.length) {
      state.job.state.logEntries[state.job.state.logEntries.length - 1].level = 'error';
    }
    pushState(true);
    return;
  }

  m = line.match(/^\[download\]\s+(\d+):\s+.+has already been recorded in the archive/);
  if (m) {
    recordVideoMeta(state.job.state.currentUrl, m[1]);
  }

  pushState();
}

function parseImageLine(line) {
  if (!state.job) return;
  addLog(line);

  let m = line.match(/\[image\] (\d+)\/(\d+) (\S+) \(\d+ bytes\)/);
  if (m) {
    state.job.state.currentIndex = Number(m[1]);
    state.job.state.totalLinks = Number(m[2]);
    state.job.state.fileCount = Number(m[1]);
    state.job.state.currentFile = m[3];
    state.job.state.percent = Math.round((Number(m[1]) / Number(m[2])) * 1000) / 10;
    pushState();
    return;
  }

  m = line.match(/\[image\] FAIL (\S+) (\S+) (.+)/);
  if (m) {
    state.job.state.failures.push({
      url: m[2],
      message: `图片 ${m[1]} 下载失败：${m[3]}`,
      attempts: 3,
      maxAttempts: 3,
      category: classifyError(m[3]),
      thumbUrl: m[2].includes('pbs.twimg.com/media/')
        ? m[2]
        : `https://pbs.twimg.com/media/${m[1]}?format=jpg&name=small`,
    });
    if (state.job.state.logEntries.length) {
      state.job.state.logEntries[state.job.state.logEntries.length - 1].level = 'error';
    }
    pushState(true);
    return;
  }

  m = line.match(/\[image\] FAIL (.+)/);
  if (m) {
    state.job.state.failures.push({
      url: `图片 ${m[1]}`,
      message: '图片下载失败',
      attempts: 3,
      maxAttempts: 3,
      category: '其他',
    });
    pushState(true);
    return;
  }

  m = line.match(/\[image\] SKIP (\S+)/);
  if (m) {
    state.job.state.failures.push({
      url: `图片 ${m[1]}`,
      message: '用户已跳过',
      attempts: 1,
      maxAttempts: 3,
      category: '用户跳过',
    });
    pushState(true);
    return;
  }

  if (line.includes('图片下载完成')) {
    state.job.state.percent = 100;
    pushState(true);
    return;
  }

  pushState();
}

async function runDownload(urls, force, ignoreSkips = false, source = 'likes') {
  state.job.state.status = 'downloading';
  state.job.state.message = '正在下载';
  state.job.state.currentFile = '';
  state.job.state.currentIndex = 0;
  state.job.state.fileCount = 0;
  state.job.state.percent = 0;
  state.job.state.speed = '';
  state.job.state.eta = '';
  if (settings.useDownloadAccount && !fs.existsSync(paths.downloadCookiesFile)) {
    addLog('[job] 未找到小号 Cookie，本次回退使用主账号 Cookie');
  }

  const skipSet = ignoreSkips ? new Set() : readSkipSet();
  let allFailures = [];
  const attemptMap = new Map();
  let activeBatch = filterBatchFile(urls, skipSet);
  const maxRounds = 5;
  let retryRound = 0;

  if (!activeBatch) {
    state.job.state.status = 'done';
    state.job.state.message = '列表中的视频都已被跳过，无需下载';
    addLog('[job] 列表中的视频都已被跳过，无需下载');
    broadcast({ type: 'state', ...publicState() });
    return;
  }

  while (!state.job.cancelled) {
    state.job.state.totalLinks = lineCount(activeBatch);
    addLog(`[job] 开始下载 ${state.job.state.totalLinks} 条链接`);
    broadcast({ type: 'state', ...publicState() });

    const activeCookies = settings.useDownloadAccount
      ? nextDownloadCookieFile()
      : paths.cookiesFile;
    const args = buildYtdlpArgs({
      urls: activeBatch,
      force,
      source,
      activeCookies,
      settings,
      ffmpegPath,
      archiveFile: paths.archiveFile,
      videoDir: resolveRel(
        (settings.video && settings.video.downloadDir) || config.downloadDir || 'videos'
      ),
    });
    const code =
      paths.ytdlpPath && fs.existsSync(paths.ytdlpPath)
        ? await runProcess(
            paths.ytdlpPath,
            args,
            { ...process.env },
            parseDownloadLine,
            (msg) => addLog(`[process] ${msg}`)
          )
        : await runProcess(
            paths.pythonPath,
            ['-m', 'yt_dlp', ...args],
            { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
            parseDownloadLine,
            (msg) => addLog(`[process] ${msg}`)
          );

    if (state.job.cancelled) return;

    if (state.job.skipRequested) {
      const skippedUrl = state.job.state.currentUrl;
      state.job.skipRequested = false;
      if (skippedUrl && !skipSet.has(skippedUrl)) {
        skipSet.add(skippedUrl);
        appendSkipUrl(skippedUrl);
        allFailures.push({ url: skippedUrl, message: '用户已跳过' });
        attemptMap.set(skippedUrl, 1);
        state.job.state.failures = [...allFailures];
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

    if (code !== 0 && state.job.state.failures.length === 0) {
      throw new Error(`下载异常，退出码 ${code}`);
    }
    if (state.job.state.failures.length === 0) break;

    for (const f of state.job.state.failures) {
      const key = f.url || '(未知链接)';
      attemptMap.set(key, (attemptMap.get(key) || 0) + 1);
    }
    const retryUrls = state.job.state.failures
      .map((f) => f.url)
      .filter(Boolean)
      .filter((url) => !skipSet.has(url));
    if (!retryUrls.length) break;
    allFailures.push(...state.job.state.failures);
    state.job.state.failures = [];
    retryRound++;
    if (retryRound > maxRounds) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
    writeListFile(paths.retryUrlsFile, retryUrls);
    activeBatch = paths.retryUrlsFile;
    state.job.state.totalLinks = retryUrls.length;
    addLog(`[job] 第 ${retryRound} 次重试 ${retryUrls.length} 条失败链接`);
    broadcast({ type: 'state', ...publicState() });
  }

  if (state.job.state.failures.length) {
    allFailures.push(...state.job.state.failures);
  }
  const seenFailed = new Set();
  state.job.state.failures = allFailures.filter((f) => {
    if (seenFailed.has(f.url)) return false;
    seenFailed.add(f.url);
    return true;
  }).map((f) => ({
    ...f,
    attempts:
      f.message === '用户已跳过'
        ? 1
        : Math.min(attemptMap.get(f.url || '(未知链接)') || 1, maxRounds),
    maxAttempts: maxRounds,
    category: f.category || classifyError(f.message),
  }));
  addLog(`[job] 下载结束，失败 ${state.job.state.failures.length} 条`);

  const batchUrls = new Set();
  try {
    const text = fs.readFileSync(urls, 'utf8');
    text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((url) => batchUrls.add(url));
  } catch {
    /* ignore */
  }
  const existing = readPersistentFailures(paths.failuresFile);
  const merged = mergeBatchFailures(existing, state.job.state.failures, [...batchUrls]);
  state.job.state.failures = merged;
  savePersistentFailures(paths.failuresFile, merged, state.job.state.kind);
  state.lastFailures = merged;
  state.lastFailuresKind = state.job.state.kind;
  addLog(`[job] 失败记录已持久化 ${merged.length} 条`);
}

async function runCollect(count, stopOnOld = false, mode = 'recent', source = 'likes', extra = '') {
  state.job.state.status = 'collecting';
  const action = stopOnOld ? '扫描喜欢列表并下载新增视频' : `采集最近 ${count} 条喜欢视频`;
  state.job.state.message = `正在${action}`;
  addLog(`[job] 开始${action}`);
  broadcast({ type: 'state', ...publicState() });

  const code = await runProcess(
    paths.nodePath,
    [COLLECT_JS, CONFIG_PATH],
    {
      ...process.env,
      NODE_PATH: paths.nodeModules,
      COLLECT_MAX_LIKES: String(count),
      COLLECT_STOP_ON_OLD: stopOnOld ? '1' : '0',
      COLLECT_MODE: mode,
      COLLECT_SOURCE: source,
      COLLECT_EXTRA: extra,
    },
    (line) => {
      addLog(line);
      pushState();
      const m = line.match(/\[collect\] 已检测到登录状态/);
      if (m) {
        state.job.state.message = '已登录，正在滚动喜欢列表';
        broadcast({ type: 'state', ...publicState() });
      }
    },
    (msg) => addLog(`[process] ${msg}`)
  );

  if (state.job.cancelled) return;
  if (code !== 0) {
    throw new Error(`采集失败，退出码 ${code}`);
  }

  const text = fs.existsSync(paths.urlsFile) ? fs.readFileSync(paths.urlsFile, 'utf8') : '';
  const urls = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!urls.length) {
    state.job.state.status = 'done';
    state.job.state.message = '没有找到新的视频推文';
    addLog('[job] 没有找到新的视频推文');
    broadcast({ type: 'state', ...publicState() });
    return;
  }

  await runDownload(paths.urlsFile, false, false, source);
}

function startJob(mode, body) {
  if (state.job) {
    state.queue.push({
      id: nextQueueId(),
      mode,
      body,
    });
    persistQueue(paths.queueFile, state.queue, state.queuePaused);
    return { ok: true, queued: true };
  }

  state.job = {
    state: baseState(),
    child: null,
    cancelled: false,
    skipRequested: false,
    startedAt: Date.now(),
  };
  state.job._mode = mode;
  state.job._body = body || {};
  state.job._startedAt = new Date().toISOString();
  state.job.state.kind = ['images', 'images_backfill', 'images_manual'].includes(mode)
    ? 'images'
    : 'video';
  state.job.state.taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.job.state.source =
    body.source || (mode === 'manual' || mode === 'images_manual' ? 'manual' : 'likes');
  state.lastFailures = [];
  state.lastFailuresKind = '';
  state.job.state.running = true;
  state.job.state.status = 'starting';
  state.job.state.message = '准备中';

  state.jobTimer = setInterval(() => {
    if (state.job) {
      state.job.state.elapsed = Math.floor((Date.now() - state.job.startedAt) / 1000);
      pushState(true);
      if (state.job.state.elapsed % 10 === 0) writeJobFile();
    }
  }, 1000);

  writeJobFile();
  broadcast({ type: 'state', ...publicState() });

  (async () => {
    try {
      if (mode === 'manual') {
        const links = (body.links || [])
          .map((s) => String(s).trim())
          .filter((s) => /^https?:\/\//i.test(s));
        if (!links.length) throw new Error('没有有效的链接');
        fs.writeFileSync(paths.manualUrlsFile, `${links.join('\n')}\n`, 'utf8');
        addLog(`[job] 收到 ${links.length} 条手动链接`);
        await runDownload(paths.manualUrlsFile, !!settings.forceRedownload, true, 'manual');
      } else if (mode === 'refresh') {
        await runCollect(20, true, 'recent', body.source || 'likes', body.extra || '');
      } else if (mode === 'login_download') {
        state.job.state.status = 'logging_in';
        state.job.state.message = '正在打开下载小号登录窗口';
        addLog('[job] 开始下载小号登录流程');
        broadcast({ type: 'state', ...publicState() });
        const code = await runProcess(
          paths.nodePath,
          [LOGIN_JS, CONFIG_PATH],
          { ...process.env, NODE_PATH: paths.nodeModules, ACCOUNT_NAME: body.accountName || '' },
          (line) => {
            addLog(line);
            pushState();
          },
          (msg) => addLog(`[process] ${msg}`)
        );
        if (state.job.cancelled) return;
        if (code !== 0) {
          throw new Error(`小号登录失败，退出码 ${code}`);
        }
        settings.useDownloadAccount = true;
        writeJson(SETTINGS_PATH, settings);
        state.job.state.message = '下载账号 Cookie 已保存';
        addLog('[job] 下载账号 Cookie 已保存');
      } else if (mode === 'login_main') {
        state.job.state.status = 'logging_in';
        state.job.state.message = '正在打开主账号登录窗口';
        addLog('[job] 开始主账号登录流程');
        broadcast({ type: 'state', ...publicState() });
        const code = await runProcess(
          paths.nodePath,
          [LOGIN_MAIN_JS, CONFIG_PATH],
          { ...process.env, NODE_PATH: paths.nodeModules },
          (line) => {
            addLog(line);
            pushState();
          },
          (msg) => addLog(`[process] ${msg}`)
        );
        if (state.job.cancelled) return;
        if (code !== 0) {
          throw new Error(`主账号登录失败，退出码 ${code}`);
        }
        state.job.state.message = '主账号 Cookie 已保存';
        addLog('[job] 主账号 Cookie 已保存');
      } else if (mode === 'download') {
        await runCollect(50, true, 'recent', body.source || 'likes', body.extra || '');
      } else if (mode === 'backfill') {
        await runCollect(
          Number(body.count) || 50,
          false,
          'backfill',
          body.source || 'likes',
          body.extra || ''
        );
      } else if (mode === 'images') {
        const imageSource = body.source === 'bookmarks' ? 'bookmarks' : 'likes';
        const imageCount = Number(body.count) || 50;
        state.job.state.status = 'collecting_images';
        state.job.state.message = `正在采集${imageSource === 'bookmarks' ? '书签' : '喜欢'}图片`;
        addLog(`[job] 开始采集${imageSource === 'bookmarks' ? '书签' : '喜欢'}图片，目标 ${imageCount} 张`);
        broadcast({ type: 'state', ...publicState() });
        const c1 = await runProcess(
          paths.nodePath,
          [COLLECT_IMAGES_JS, CONFIG_PATH],
          {
            ...process.env,
            NODE_PATH: paths.nodeModules,
            IMAGE_SOURCE: imageSource,
            IMAGE_MAX: String(imageCount),
            IMAGE_MODE: 'recent',
            IMAGE_EXTRA: body.extra || '',
          },
          (line) => {
            addLog(line);
            pushState();
          },
          (msg) => addLog(`[process] ${msg}`)
        );
        if (state.job.cancelled) return;
        if (c1 !== 0) throw new Error(`图片采集失败，退出码 ${c1}`);

        state.job.state.status = 'downloading_images';
        state.job.state.message = '正在下载图片';
        broadcast({ type: 'state', ...publicState() });
        const c2 = await runProcess(
          paths.nodePath,
          [DOWNLOAD_IMAGES_BROWSER_JS, CONFIG_PATH],
          {
            ...process.env,
            IMAGE_SOURCE: imageSource,
            ACTIVE_DOWNLOAD_COOKIE: settings.useDownloadAccount ? nextDownloadCookieFile() : '',
          },
          parseImageLine,
          (msg) => addLog(`[process] ${msg}`)
        );
        if (state.job.cancelled) return;
        if (c2 !== 0) throw new Error(`图片下载失败，退出码 ${c2}`);
      } else if (mode === 'images_backfill') {
        const imageSource = body.source === 'bookmarks' ? 'bookmarks' : 'likes';
        const imageCount = Number(body.count) || 50;
        state.job.state.status = 'collecting_images';
        state.job.state.message = '正在从最早补录图片';
        addLog(`[job] 开始从最早补录${imageSource === 'bookmarks' ? '书签' : '喜欢'}图片，目标 ${imageCount} 张`);
        broadcast({ type: 'state', ...publicState() });
        const c1 = await runProcess(
          paths.nodePath,
          [COLLECT_IMAGES_JS, CONFIG_PATH],
          {
            ...process.env,
            NODE_PATH: paths.nodeModules,
            IMAGE_SOURCE: imageSource,
            IMAGE_MAX: String(imageCount),
            IMAGE_MODE: 'backfill',
            IMAGE_EXTRA: body.extra || '',
          },
          (line) => {
            addLog(line);
            pushState();
          },
          (msg) => addLog(`[process] ${msg}`)
        );
        if (state.job.cancelled) return;
        if (c1 !== 0) throw new Error(`图片补录失败，退出码 ${c1}`);

        state.job.state.status = 'downloading_images';
        state.job.state.message = '正在下载图片';
        broadcast({ type: 'state', ...publicState() });
        const c2 = await runProcess(
          paths.nodePath,
          [DOWNLOAD_IMAGES_BROWSER_JS, CONFIG_PATH],
          {
            ...process.env,
            IMAGE_SOURCE: imageSource,
            ACTIVE_DOWNLOAD_COOKIE: settings.useDownloadAccount ? nextDownloadCookieFile() : '',
          },
          parseImageLine,
          (msg) => addLog(`[process] ${msg}`)
        );
        if (state.job.cancelled) return;
        if (c2 !== 0) throw new Error(`图片下载失败，退出码 ${c2}`);
      } else if (mode === 'images_manual') {
        const links = (body.links || [])
          .map((s) => String(s).trim())
          .filter((s) => /^https?:\/\//i.test(s));
        if (!links.length) throw new Error('没有有效的图片链接');
        const tweetLinks = links.filter((s) => /x\.com\/[^/]+\/status\/\d+/.test(s));
        const directLinks = links.filter((s) => !tweetLinks.includes(s));
        if (tweetLinks.length) {
          fs.writeFileSync(paths.manualTweetUrlsFile, `${tweetLinks.join('\n')}\n`, 'utf8');
          state.job.state.status = 'collecting_images';
          state.job.state.message = '正在解析推文图片';
          addLog(`[job] 解析 ${tweetLinks.length} 条推文图片`);
          broadcast({ type: 'state', ...publicState() });
          const c1 = await runProcess(
            paths.nodePath,
            [RESOLVE_TWEET_IMAGES_JS, CONFIG_PATH],
            { ...process.env, NODE_PATH: paths.nodeModules },
            (line) => {
              addLog(line);
              pushState();
            },
            (msg) => addLog(`[process] ${msg}`)
          );
          if (state.job.cancelled) return;
          if (c1 !== 0) throw new Error(`推文图片解析失败，退出码 ${c1}`);
          if (directLinks.length) {
            fs.appendFileSync(paths.imageUrlsFile, `${directLinks.join('\n')}\n`, 'utf8');
          }
        } else {
          fs.writeFileSync(paths.imageUrlsFile, `${links.join('\n')}\n`, 'utf8');
        }
        state.job.state.status = 'downloading_images';
        state.job.state.message = '正在下载图片';
        addLog(`[job] 开始下载图片`);
        broadcast({ type: 'state', ...publicState() });
        const c2 = await runProcess(
          paths.nodePath,
          [DOWNLOAD_IMAGES_BROWSER_JS, CONFIG_PATH],
          {
            ...process.env,
            IMAGE_SOURCE: 'manual',
            ACTIVE_DOWNLOAD_COOKIE: settings.useDownloadAccount ? nextDownloadCookieFile() : '',
          },
          parseImageLine,
          (msg) => addLog(`[process] ${msg}`)
        );
        if (state.job.cancelled) return;
        if (c2 !== 0) throw new Error(`图片下载失败，退出码 ${c2}`);
      } else {
        const count =
          mode === '50' ? 50 : mode === '100' ? 100 : Number(body.count);
        if (!Number.isInteger(count) || count <= 0) throw new Error('采集数量无效');
        await runCollect(count, false, 'recent', body.source || 'likes', body.extra || '');
      }

      if (!state.job.cancelled) {
        state.job.state.status = 'done';
        state.job.state.message = '完成';
        addLog('[job] 完成');
      }
    } catch (err) {
      if (state.job) {
        state.job.state.status = 'error';
        state.job.state.message = err.message;
        addLog(`[error] ${err.message}`);
      }
    } finally {
      if (state.job) {
        state.job.state.running = false;
        clearInterval(state.jobTimer);
        writeJobFiles();
        state.lastFailures = state.job.state.failures;
        state.lastFailuresKind = state.job.state.kind;
        writeJobFile();
        broadcast({ type: 'state', ...publicState() });
        state.job = null;
      }
      scheduleAutoShutdown();
      startNextQueued();
    }
  })();

  return { ok: true };
}

function writeJobFiles() {
  if (!state.job) return;
  try {
    fs.mkdirSync(paths.logDir, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const runLog = path.join(paths.logDir, `run_${stamp}.log`);
    fs.writeFileSync(runLog, `${state.job.state.logs.join('\n')}\n`, 'utf8');

    if (state.job.state.failures.length) {
      const failFile = path.join(paths.logDir, `failures_${stamp}.txt`);
      const failText = state.job.state.failures
        .map((f) => `${f.url}\n${f.message}\n---`)
        .join('\n');
      fs.writeFileSync(failFile, `${failText}\n`, 'utf8');
      fs.appendFileSync(
        path.join(paths.logDir, 'errors.log'),
        `[${stamp}] ${state.job.state.failures.length} 条失败\n${failText}\n`,
        'utf8'
      );
    }
  } catch {
    /* ignore */
  }
}

function cancelJob() {
  if (state.job && state.job.child) {
    state.job.cancelled = true;
    killTree(state.job.child.pid);
    state.job.state.status = 'cancelled';
    state.job.state.message = '已停止';
    addLog('[job] 已停止');
    return { ok: true };
  }
  return { ok: true };
}

function skipCurrent() {
  if (state.job && state.job.state.status === 'downloading_images') {
    fs.writeFileSync(paths.imageSkipRequestFile, state.job.state.currentFile || '*', 'utf8');
    return { ok: true };
  }
  if (state.job && state.job.child && state.job.state.status === 'downloading') {
    state.job.skipRequested = true;
    killTree(state.job.child.pid);
    return { ok: true };
  }
  return { ok: false, error: '当前没有正在下载的任务' };
}

module.exports = {
  startJob,
  cancelJob,
  skipCurrent,
  startNextQueued,
};
