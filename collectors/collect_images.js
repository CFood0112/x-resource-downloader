const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
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
const imageUrlsFile = resolveRel(config.imageUrlsFile || 'image_urls.txt');
const imageArchiveFile = resolveRel(config.imageArchiveFile || 'image_archive.txt');
const imageMetaFile = resolveRel(config.imageMetaFile || 'image_meta.txt');
const source = process.env.IMAGE_SOURCE || 'likes';
const sourceExtra = process.env.IMAGE_EXTRA || '';
const imageMode = process.env.IMAGE_MODE === 'backfill' ? 'backfill' : 'recent';
const maxImages = Number(process.env.IMAGE_MAX) || 50;
const configuredMaxScroll = Number(config.maxScrollAttempts) || 300;
const maxScrollAttempts =
  imageMode === 'backfill' ? Math.max(configuredMaxScroll, 300) : configuredMaxScroll;
const loginTimeoutMs = Number(config.loginTimeoutMs) || 600000;
const maxScrollRoundsPerDay = Number(config.maxScrollRoundsPerDay) || 1500;
const scrollBudgetFile = resolveRel(config.scrollBudgetFile || 'data/lists/scroll_budget.txt');
const imageBackfillStateFile = resolveRel(
  config.imageBackfillPositionFile || 'data/lists/image_backfill_position.json'
);

function log(msg) {
  console.log(`[collect-images] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      log('检测到人机验证，请在浏览器里完成验证');
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

  throw new Error('等待登录超时，请重新运行');
}

async function resolveUsername(page) {
  const profileLink = page.locator('a[data-testid="AppTabBar_Profile_Link"]');
  const href = await profileLink.getAttribute('href');
  return String(href).replace(/^\//, '').split('?')[0];
}

async function readSnapshot(page) {
  return page.evaluate(() => {
    const found = [];
    for (const article of document.querySelectorAll('article')) {
      const link = article.querySelector('a[href*="/status/"]');
      const match = link ? link.href.match(/\/([^/]+)\/status\/(\d+)/) : null;
      const tweetId = match ? match[2] : '';
      const uploader = match ? match[1] : '';
      const timeEl = article.querySelector('time[datetime]');
      const date = timeEl ? timeEl.getAttribute('datetime').slice(0, 10) : '';
      const videoEl = article.querySelector('video');
      const isVideo = !!videoEl || !!article.querySelector('[data-testid="videoPlayer"]');
      const posterBase = videoEl && videoEl.poster ? videoEl.poster.split('?')[0] : '';
      const images = [];
      for (const img of article.querySelectorAll('img[src*="pbs.twimg.com/media/"]')) {
        const src = img.src;
        const mediaMatch = src.match(/\/media\/([A-Za-z0-9_-]+)\?/);
        if (!mediaMatch) continue;
        const base = src.split('?')[0];
        if (isVideo && posterBase && base === posterBase) continue;
        const format = (src.match(/format=([a-z0-9]+)/) || [null, 'jpg'])[1];
        images.push({
          mediaId: mediaMatch[1],
          url: `${base}?format=${format}&name=orig`,
          ext: format,
        });
      }
      if (images.length) found.push({ tweetId, uploader, date, images });
    }
    return found;
  });
}

async function main() {
  fs.mkdirSync(profileDir, { recursive: true });
  const archiveIds = new Set();
  const archiveTweetById = new Map();
  try {
    const text = fs.readFileSync(imageArchiveFile, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const parts = line.trim().split('\t');
      if (!parts[0]) continue;
      archiveIds.add(parts[0]);
      if (parts[1]) archiveTweetById.set(parts[0], parts[1]);
    }
  } catch {
    /* no image archive yet */
  }

  let anchorId = null;
  if (imageMode === 'backfill') {
    let min = null;
    for (const tweetId of archiveTweetById.values()) {
      const id = BigInt(tweetId);
      if (min === null || id < min) min = id;
    }
    if (min !== null) {
      anchorId = min;
      log(`已下载图片记录中最旧推文（ID ${anchorId}），本次按下载记录跳过已下载项`);
    } else {
      log('未找到已下载图片记录作为起点，本次按最近模式扫描');
    }
  }

  let seenDownloadedTweets = new Set();
  let passedAllDownloaded = false;
  let roundsWithoutDownloadedSeen = 0;
  let deepestSeenId = null;
  if (imageMode === 'backfill') {
    try {
      const text = fs.readFileSync(imageBackfillStateFile, 'utf8').trim();
      if (text) {
        const parsed = JSON.parse(text);
        if (parsed && parsed.position) {
          deepestSeenId = BigInt(parsed.position);
          seenDownloadedTweets = new Set(parsed.seen || []);
          passedAllDownloaded = !!parsed.passedAll;
          log(`检测到上次图片续扫位置（ID ${deepestSeenId}），先快速回到该位置`);
        }
      }
    } catch {
      /* no resume state yet */
    }
    if (archiveTweetById.size === 0) passedAllDownloaded = true;
    if (passedAllDownloaded) {
      log('上次已越过最早下载图片记录，本次直接继续收集更早内容');
    } else if (seenDownloadedTweets.size) {
      log(`已确认 ${seenDownloadedTweets.size}/${archiveTweetById.size} 条已下载图片推文，继续向最早记录推进`);
    }
  }

  const saveBackfillState = () => {
    if (imageMode !== 'backfill' || deepestSeenId === null) return;
    try {
      fs.mkdirSync(path.dirname(imageBackfillStateFile), { recursive: true });
      fs.writeFileSync(
        imageBackfillStateFile,
        JSON.stringify({
          position: deepestSeenId.toString(),
          seen: [...seenDownloadedTweets],
          passedAll: passedAllDownloaded,
        }),
        'utf8'
      );
    } catch {
      /* ignore */
    }
  };

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

    let targetUrl;
    if (source === 'bookmarks') {
      targetUrl = 'https://x.com/i/bookmarks';
    } else if (source === 'search') {
      targetUrl = `https://x.com/search?q=${encodeURIComponent(sourceExtra)}&src=typed_query&f=live`;
    } else if (source === 'replies') {
      const username = await resolveUsername(page);
      targetUrl = `https://x.com/${username}/with_replies`;
    } else if (source === 'following') {
      targetUrl = 'https://x.com/home';
    } else if (source === 'list') {
      targetUrl = sourceExtra || 'https://x.com/i/lists';
    } else {
      const username = await resolveUsername(page);
      targetUrl = `https://x.com/${username}/likes`;
    }
    log(`打开来源页面：${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    if (source === 'following') {
      await page
        .locator('a[href="/home"]')
        .filter({ hasText: 'Following' })
        .first()
        .click()
        .catch(() => {});
      await sleep(2000);
    }
    await page.waitForSelector('article', { timeout: 60000 }).catch(() => {});

    const collected = new Map();
    const seenMedia = new Set();
    let emptyRounds = 0;
    let consecutiveErrors = 0;
    let newerPendingSkipped = 0;
    let downloadedSkipped = 0;

    for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
      if (collected.size >= maxImages) break;

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
        if (item.tweetId) {
          if (deepestSeenId === null || BigInt(item.tweetId) < deepestSeenId) {
            deepestSeenId = BigInt(item.tweetId);
          }
          const hasDownloadedImage = item.images.some((img) => archiveIds.has(img.mediaId));
          if (hasDownloadedImage && !seenDownloadedTweets.has(item.tweetId)) {
            seenDownloadedTweets.add(item.tweetId);
            newDownloadedSeenThisRound = true;
            if (seenDownloadedTweets.size >= archiveTweetById.size && !passedAllDownloaded) {
              passedAllDownloaded = true;
              log(`已越过最早一条已下载图片推文（共 ${seenDownloadedTweets.size} 条），开始收集更早内容`);
            }
          }
        }
        for (const image of item.images) {
          if (seenMedia.has(image.mediaId)) continue;
          seenMedia.add(image.mediaId);
          newCount++;
          if (archiveIds.has(image.mediaId)) {
            downloadedSkipped++;
            continue;
          }
          if (imageMode === 'backfill' && !passedAllDownloaded) {
            newerPendingSkipped++;
            continue;
          }
          collected.set(image.mediaId, {
            tweetId: item.tweetId,
            uploader: item.uploader,
            date: item.date,
            mediaId: image.mediaId,
            url: image.url,
            ext: image.ext,
          });
          if (collected.size >= maxImages) break;
        }
        if (collected.size >= maxImages) break;
      }

      if (imageMode === 'backfill' && !passedAllDownloaded) {
        roundsWithoutDownloadedSeen = newDownloadedSeenThisRound
          ? 0
          : roundsWithoutDownloadedSeen + 1;
        if (roundsWithoutDownloadedSeen >= 40) {
          log('连续多轮未见新的已下载图片记录，可能部分记录已不在列表中，提前开始收集更早内容');
          passedAllDownloaded = true;
        }
      }

      emptyRounds = newCount === 0 ? emptyRounds + 1 : 0;
      log(
        `第 ${attempt + 1}/${maxScrollAttempts} 轮：累计发现 ${seenMedia.size} 张图片，待下载 ${collected.size} 张，已跳过 ${downloadedSkipped} 张已下载图片${newerPendingSkipped ? `，跳过 ${newerPendingSkipped} 张未达起点的未下载图片` : ''}`
      );

      if (emptyRounds === 10) {
        log('连续多轮未发现新图片，继续滚动查找...');
      }

      if (emptyRounds >= (imageMode === 'backfill' ? 40 : 30)) {
        log('连续多轮没有新内容，已到达列表底部');
        break;
      }

      await humanScroll(page);
      if (!consumeDailyScrollBudget(scrollBudgetFile, maxScrollRoundsPerDay, 1)) {
        log('今日滚动预算已用完，停止采集');
        break;
      }
      saveBackfillState();
    }

    saveBackfillState();

    const lines = [...collected.values()].map(
      (item) =>
        `${item.mediaId}\t${item.url}\t${item.ext}\t${item.tweetId}\t${item.uploader}\t${item.date}`
    );
    fs.writeFileSync(imageUrlsFile, `${lines.join('\n')}\n`, 'utf8');
    fs.appendFileSync(imageMetaFile, `${lines.join('\n')}\n`, 'utf8');
    log(`已保存 ${lines.length} 张图片链接到 ${path.basename(imageUrlsFile)}`);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[collect-images] 失败：${err.message}`);
  process.exit(1);
});
