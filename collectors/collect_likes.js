const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadArchiveSkipUrls: loadArchiveSkipUrlsModule } = require('./archiveSkip');
const {
  checkDailyScrollBudget,
  consumeDailyScrollBudget,
  humanScroll,
} = require('./risk');

const configPath = path.resolve(process.argv[2] || 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const root = path.dirname(configPath);

const resolveRel = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));

const profileDir = resolveRel(config.profileDir);
const urlsFile = resolveRel(config.urlsFile);
const cookiesFile = resolveRel(config.cookiesFile);
const seenUrlsFile = resolveRel(config.seenUrlsFile || 'seen_urls.txt');
const skipUrlsFile = resolveRel(config.skipUrlsFile || 'skipped_urls.txt');
const archiveFile = resolveRel(config.archiveFile || 'archive.txt');
const backfillPositionFile = resolveRel(config.backfillPositionFile || 'data/lists/backfill_position.txt');
const videoMetaFile = resolveRel(config.videoMetaFile || 'data/lists/video_meta.txt');
const logsDir = resolveRel(config.logsDir || 'logs');
const configuredMax = Number(config.maxLikesToScan) || 500;
const maxLikes = Number(process.env.COLLECT_MAX_LIKES) || configuredMax;
const loginTimeoutMs = Number(config.loginTimeoutMs) || 600000;
const stopOnOld = process.env.COLLECT_STOP_ON_OLD === '1';
const collectMode = process.env.COLLECT_MODE || 'recent';
const isBackfill = collectMode === 'backfill';
const collectSource = process.env.COLLECT_SOURCE || 'likes';
const collectExtra = process.env.COLLECT_EXTRA || '';
const configuredMaxScroll = Number(config.maxScrollAttempts) || 300;
const envMaxScroll = Number(process.env.COLLECT_MAX_ATTEMPTS);
const maxScrollAttempts =
  envMaxScroll || (isBackfill ? Math.max(configuredMaxScroll, 300) : configuredMaxScroll);
const maxScrollRoundsPerDay = Number(config.maxScrollRoundsPerDay) || 1500;
const scrollBudgetFile = resolveRel(config.scrollBudgetFile || 'data/lists/scroll_budget.txt');

function log(msg) {
  console.log(`[collect] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadArchiveSkipUrls() {
  const { skip } = loadArchiveSkipUrlsModule({
    archiveFile,
    videoMetaFile,
    logsDir,
    scanLogs: process.env.COLLECT_REPAIR_META === '1',
    log,
  });
  return skip;
}

async function waitForLogin(page) {
  const deadline = Date.now() + loginTimeoutMs;
  log('正在打开 X；如果弹出登录页，请在 Chrome 窗口里完成登录...');

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      throw new Error(
        '浏览器窗口已关闭：请保持 Chrome 窗口打开；若没有自动登录，请先在设置中点击“更换主账号”重新登录'
      );
    }

    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    if (/verify you are human|enable javascript and cookies|challenge/i.test(bodyText)) {
      log('检测到人机验证，请在浏览器里完成验证，脚本会继续等待');
    }

    const url = page.url();
    if (url.includes('x.com') && !url.includes('/i/flow/login')) {
      const profileLink = page.locator('a[data-testid="AppTabBar_Profile_Link"]');
      if ((await profileLink.count()) > 0) {
        log('已检测到登录状态');
        return;
      }
    }

    await sleep(2000);
  }

  throw new Error('等待登录超时，请重新运行并在 Chrome 中完成登录');
}

async function resolveUsername(page, cfg) {
  if (cfg.username && String(cfg.username).trim()) {
    return String(cfg.username).trim();
  }

  const profileLink = page.locator('a[data-testid="AppTabBar_Profile_Link"]');
  const href = await profileLink.getAttribute('href');
  const username = String(href).replace(/^\//, '').split('?')[0];
  cfg.username = username;
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  log(`已自动识别用户名：@${username}`);
  return username;
}

async function readSnapshot(page) {
  return page.evaluate(() => {
    const found = [];
    for (const article of document.querySelectorAll('article')) {
      const link = article.querySelector('a[href*="/status/"]');
      if (!link) continue;
      const match = link.href.match(/\/[^/]+\/status\/(\d+)/);
      if (!match) continue;
      const hasVideo =
        !!article.querySelector('video') ||
        !!article.querySelector('[data-testid="videoPlayer"]') ||
        !!article.querySelector('[data-testid="playButton"]') ||
        !!article.querySelector('[aria-label="Play"]');
      found.push({ id: match[1], url: `https://x.com${match[0]}`, hasVideo });
    }
    return found;
  });
}

async function collectLikedVideos(page, username) {
  let targetUrl;
  if (collectSource === 'bookmarks') {
    targetUrl = 'https://x.com/i/bookmarks';
  } else if (collectSource === 'search') {
    targetUrl = `https://x.com/search?q=${encodeURIComponent(collectExtra)}&src=typed_query&f=live`;
  } else if (collectSource === 'replies') {
    targetUrl = `https://x.com/${username}/with_replies`;
  } else if (collectSource === 'following') {
    targetUrl = 'https://x.com/home';
  } else if (collectSource === 'list') {
    targetUrl = collectExtra || 'https://x.com/i/lists';
  } else {
    targetUrl = `https://x.com/${username}/likes`;
  }
  log(`打开${collectSource === 'bookmarks' ? '书签' : '喜欢'}列表：${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  if (collectSource === 'following') {
    await page
      .locator('a[href="/home"]')
      .filter({ hasText: 'Following' })
      .first()
      .click()
      .catch(() => {});
    await sleep(2000);
  }
  await page.waitForSelector('article', { timeout: 60000 }).catch(() => {});

  const processedIds = new Set();
  const pendingIds = new Map();
  const allSeenIds = new Set();
  const seenUrls = new Set();
  try {
    const text = fs.readFileSync(seenUrlsFile, 'utf8');
    text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((url) => seenUrls.add(url));
  } catch {
    /* no history yet */
  }
  if (seenUrls.size === 0) {
    try {
      const text = fs.readFileSync(urlsFile, 'utf8');
      text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((url) => seenUrls.add(url));
    } catch {
      /* no previous batch */
    }
  }
  const archiveSkipUrls = loadArchiveSkipUrls();
  const skipUrls = new Set(archiveSkipUrls);
  try {
    const text = fs.readFileSync(skipUrlsFile, 'utf8');
    text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((url) => skipUrls.add(url));
  } catch {
    /* no explicit skips yet */
  }
  if (archiveSkipUrls.size > 0) {
    log(`根据下载记录识别到 ${archiveSkipUrls.size} 条已下载视频`);
  }
  const collectedUrls = new Set();

  let anchorId = null;
  if (isBackfill) {
    let min = null;
    for (const url of archiveSkipUrls) {
      const m = url.match(/\/status\/(\d+)/);
      if (m) {
        const id = BigInt(m[1]);
        if (min === null || id < min) min = id;
      }
    }
    if (min !== null) {
      anchorId = min;
      log(`已下载视频记录共 ${archiveSkipUrls.size} 条，本次按下载记录推进，确认越过最早一条后再收集更早内容`);
    } else {
      log('未找到已下载记录作为起点，本次按最近模式扫描');
    }
  }

  let resumeId = null;
  let resumeSkipped = 0;
  let deepestSeenId = null;
  let lazyWarned = false;
  let seenDownloaded = new Set();
  let passedAllDownloaded = false;
  let roundsWithoutDownloadedSeen = 0;
  if (isBackfill && archiveSkipUrls.size === 0) {
    passedAllDownloaded = true;
  }
  if (isBackfill) {
    try {
      const text = fs.readFileSync(backfillPositionFile, 'utf8').trim();
      if (text) {
        const parsed = JSON.parse(text);
        if (parsed && parsed.position) {
          resumeId = BigInt(parsed.position);
          seenDownloaded = new Set(parsed.seen || []);
          passedAllDownloaded = !!parsed.passedAll;
          log(`检测到上次续扫位置（ID ${resumeId}），先快速回到该位置`);
        } else if (/^\d+$/.test(text)) {
          resumeId = BigInt(text);
          log(`检测到上次续扫位置（ID ${resumeId}），先快速回到该位置`);
        }
      }
    } catch {
      /* no resume position yet */
    }
    if (resumeId === null && anchorId !== null) {
      log('没有上次续扫位置，本次从顶部开始扫描');
    }
    if (passedAllDownloaded) {
      log('上次已越过最早下载记录，本次直接继续收集更早内容');
    } else if (seenDownloaded.size) {
      log(`已确认 ${seenDownloaded.size}/${archiveSkipUrls.size} 条已下载内容，继续向最早记录推进`);
    }
  }

  const saveBackfillPosition = () => {
    if (!isBackfill || deepestSeenId === null) return;
    try {
      fs.mkdirSync(path.dirname(backfillPositionFile), { recursive: true });
      fs.writeFileSync(
        backfillPositionFile,
        JSON.stringify({
          position: deepestSeenId.toString(),
          seen: [...seenDownloaded],
          passedAll: passedAllDownloaded,
        }),
        'utf8'
      );
    } catch {
      /* ignore */
    }
  };

  const videoUrls = [];
  let skippedCount = 0;
  let newerPendingSkipped = 0;
  let emptyRounds = 0;
  let stopCollecting = false;
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
    if (videoUrls.length >= maxLikes) {
      log(`已达到上限 ${maxLikes} 个视频，停止扫描`);
      break;
    }

    const budget = checkDailyScrollBudget(scrollBudgetFile, maxScrollRoundsPerDay);
    if (!budget.ok) {
      log(`今日滚动预算已用完（${budget.used}/${budget.max}），停止采集`);
      break;
    }

    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    if (/something went wrong|出错了|try again/i.test(bodyText)) {
      consecutiveErrors++;
      log(`页面报错（连续 ${consecutiveErrors} 次），刷新后继续`);
      if (consecutiveErrors >= 3) {
        log('连续多次页面出错，暂停本轮采集以避免风控');
        break;
      }
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(8000 + Math.random() * 8000);
      continue;
    }
    consecutiveErrors = 0;

    const snapshot = await readSnapshot(page);

    let newCount = 0;
    let newDownloadedSeenThisRound = false;
    for (const item of snapshot) {
      if (processedIds.has(item.id)) continue;
      if (!allSeenIds.has(item.id)) {
        allSeenIds.add(item.id);
        newCount++;
        if (
          (resumeId === null || BigInt(item.id) <= resumeId) &&
          (deepestSeenId === null || BigInt(item.id) < deepestSeenId)
        ) {
          deepestSeenId = BigInt(item.id);
        }
      }
      if (resumeId !== null && item.id && BigInt(item.id) > resumeId) {
        resumeSkipped++;
        processedIds.add(item.id);
        continue;
      }
      if (resumeId !== null && item.id && BigInt(item.id) <= resumeId) {
        resumeId = null;
        log('已回到上次续扫位置，继续向更早扫描');
      }
      if (item.hasVideo) {
        if (skipUrls.has(item.url)) {
          skippedCount++;
          if (isBackfill && !seenDownloaded.has(item.url)) {
            seenDownloaded.add(item.url);
            newDownloadedSeenThisRound = true;
            if (seenDownloaded.size >= archiveSkipUrls.size && !passedAllDownloaded) {
              passedAllDownloaded = true;
              log(`已越过最早一条已下载内容（共 ${seenDownloaded.size} 条），开始收集更早内容`);
            }
          }
          if (stopOnOld) {
            if (videoUrls.length > 0) {
              stopCollecting = true;
              break;
            }
            if (!lazyWarned) {
              lazyWarned = true;
              log('顶部可能还有未加载的新视频，继续扫描');
            }
          }
        } else if (isBackfill && !passedAllDownloaded) {
          newerPendingSkipped++;
        } else if (!collectedUrls.has(item.url)) {
          videoUrls.push(item.url);
          collectedUrls.add(item.url);
          seenUrls.add(item.url);
        }
        processedIds.add(item.id);
        pendingIds.delete(item.id);
        continue;
      }
      const attempts = pendingIds.get(item.id) || 0;
      if (attempts >= 3) {
        processedIds.add(item.id);
        pendingIds.delete(item.id);
      } else {
        pendingIds.set(item.id, attempts + 1);
      }
    }

    if (stopCollecting) {
      log('发现已下载视频，停止继续检索');
      break;
    }

    if (isBackfill && !passedAllDownloaded) {
      roundsWithoutDownloadedSeen = newDownloadedSeenThisRound
        ? 0
        : roundsWithoutDownloadedSeen + 1;
      if (roundsWithoutDownloadedSeen >= 40) {
        log('连续多轮未见新的已下载记录，可能部分记录已不在列表中，提前开始收集更早内容');
        passedAllDownloaded = true;
      }
    }

    emptyRounds = newCount === 0 ? emptyRounds + 1 : 0;
    log(
      `第 ${attempt + 1}/${maxScrollAttempts} 轮：累计发现 ${allSeenIds.size} 条推文，其中视频 ${videoUrls.length} 条，已跳过 ${skippedCount} 条已下载视频${newerPendingSkipped ? `，跳过 ${newerPendingSkipped} 条未达起点的未下载内容` : ''}${resumeSkipped ? `，回滚跳过 ${resumeSkipped} 条` : ''}`
    );

    if (emptyRounds >= 10) {
      log('连续多轮没有新内容，已到达列表底部');
      break;
    }

    await humanScroll(page, { fast: isBackfill && resumeId !== null });
    if (!consumeDailyScrollBudget(scrollBudgetFile, maxScrollRoundsPerDay, 1)) {
      log('今日滚动预算已用完，停止采集');
      break;
    }
    saveBackfillPosition();
  }

  if (!stopCollecting && !isBackfill && videoUrls.length < maxLikes) {
    log('重新扫描顶部，补齐可能未及时加载的视频...');
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(2500);
    for (let pass = 0; pass < 3 && videoUrls.length < maxLikes; pass++) {
      const topSnapshot = await readSnapshot(page);
      for (const item of topSnapshot) {
        if (processedIds.has(item.id) || !item.hasVideo) continue;
        if (collectedUrls.has(item.url)) continue;
        videoUrls.push(item.url);
        collectedUrls.add(item.url);
        seenUrls.add(item.url);
        processedIds.add(item.id);
      }
      if (pass < 2) {
        await page.evaluate(() => window.scrollBy(0, 700));
        await sleep(1500);
      }
    }
  }

  try {
    fs.writeFileSync(seenUrlsFile, `${[...seenUrls].join('\n')}\n`, 'utf8');
  } catch (err) {
    log(`[collect] 写入已采集记录失败：${err.message}`);
  }
  saveBackfillPosition();

  return [...new Set(videoUrls)];
}

function netscapeCookieLine(cookie) {
  const domain = cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`;
  const secure = cookie.secure ? 'TRUE' : 'FALSE';
  const expires =
    Number.isFinite(cookie.expires) && cookie.expires > 0 ? Math.floor(cookie.expires) : 0;
  const prefix = cookie.httpOnly ? '#HttpOnly_' : '';
  return `${prefix}${domain}\tTRUE\t${cookie.path || '/'}\t${secure}\t${expires}\t${cookie.name}\t${cookie.value}`;
}

async function saveCookies(context) {
  const cookies = await context.cookies();
  const lines = ['# Netscape HTTP Cookie File', ...cookies.map(netscapeCookieLine)];
  fs.mkdirSync(path.dirname(cookiesFile), { recursive: true });
  fs.writeFileSync(cookiesFile, `${lines.join('\n')}\n`, 'utf8');
  log(`已导出 ${cookies.length} 个 Cookie 到 ${path.basename(cookiesFile)}`);
}

async function main() {
  fs.mkdirSync(profileDir, { recursive: true });
  let context;

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const page = context.pages()[0] || (await context.newPage());
    await page
      .goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch(() => {});

    await waitForLogin(page);
    const username = await resolveUsername(page, config);
    const videoUrls = await collectLikedVideos(page, username);

    await saveCookies(context);

    if (videoUrls.length === 0) {
      log('没有找到新的视频推文');
      fs.writeFileSync(urlsFile, '', 'utf8');
    } else {
      fs.writeFileSync(urlsFile, `${videoUrls.join('\n')}\n`, 'utf8');
      log(`已保存 ${videoUrls.length} 个视频链接到 ${path.basename(urlsFile)}`);
    }
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[collect] 失败：${err.message}`);
  process.exit(1);
});
