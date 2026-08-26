const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const configPath = path.resolve(process.argv[2] || 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const root = path.dirname(configPath);

const resolveRel = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));

const profileDir = resolveRel(config.profileDir);
const imageUrlsFile = resolveRel(config.imageUrlsFile || 'image_urls.txt');
const imageArchiveFile = resolveRel(config.imageArchiveFile || 'image_archive.txt');
const source = process.env.IMAGE_SOURCE === 'bookmarks' ? 'bookmarks' : 'likes';
const imageMode = process.env.IMAGE_MODE === 'backfill' ? 'backfill' : 'recent';
const maxImages = Number(process.env.IMAGE_MAX) || 50;
const configuredMaxScroll = Number(config.maxScrollAttempts) || 300;
const maxScrollAttempts =
  imageMode === 'backfill' ? Math.max(configuredMaxScroll, 300) : configuredMaxScroll;
const loginTimeoutMs = Number(config.loginTimeoutMs) || 600000;

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
    if (page.isClosed()) throw new Error('浏览器窗口已关闭');

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
      const isVideo =
        !!article.querySelector('video') ||
        !!article.querySelector('[data-testid="videoPlayer"]');
      if (isVideo) continue;

      const images = [];
      for (const img of article.querySelectorAll('img[src*="pbs.twimg.com/media/"]')) {
        const src = img.src;
        const mediaMatch = src.match(/\/media\/([A-Za-z0-9_-]+)\?/);
        if (!mediaMatch) continue;
        const base = src.split('?')[0];
        const format = (src.match(/format=([a-z0-9]+)/) || [null, 'jpg'])[1];
        images.push({
          mediaId: mediaMatch[1],
          url: `${base}?format=${format}&name=orig`,
          ext: format,
        });
      }
      if (images.length) found.push({ tweetId, uploader, images });
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
      log(`从最早一张已下载图片所在推文（ID ${anchorId}）开始向更早扫描`);
    } else {
      log('未找到已下载图片记录作为起点，本次按最近模式扫描');
    }
  }

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
    } else {
      const username = await resolveUsername(page);
      targetUrl = `https://x.com/${username}/likes`;
    }
    log(`打开${source === 'bookmarks' ? '书签' : '喜欢'}页面：${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForSelector('article', { timeout: 60000 }).catch(() => {});

    const collected = new Map();
    const seenMedia = new Set();
    let emptyRounds = 0;

    for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
      if (collected.size >= maxImages) break;

      const bodyText = await page
        .locator('body')
        .innerText()
        .catch(() => '');
      if (/something went wrong|出错了|try again/i.test(bodyText)) {
        log('页面报错，刷新后继续');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(3000);
        continue;
      }

      const snapshot = await readSnapshot(page);
      let newCount = 0;
      for (const item of snapshot) {
        if (
          imageMode === 'backfill' &&
          anchorId !== null &&
          item.tweetId &&
          BigInt(item.tweetId) >= anchorId
        ) {
          continue;
        }
        for (const image of item.images) {
          if (seenMedia.has(image.mediaId)) continue;
          seenMedia.add(image.mediaId);
          newCount++;
          if (archiveIds.has(image.mediaId)) continue;
          collected.set(image.mediaId, {
            tweetId: item.tweetId,
            uploader: item.uploader,
            mediaId: image.mediaId,
            url: image.url,
            ext: image.ext,
          });
          if (collected.size >= maxImages) break;
        }
        if (collected.size >= maxImages) break;
      }

      emptyRounds = newCount === 0 ? emptyRounds + 1 : 0;
      log(
        `第 ${attempt + 1}/${maxScrollAttempts} 轮：累计发现 ${seenMedia.size} 张图片，待下载 ${collected.size} 张`
      );

      if (emptyRounds === 10) {
        log('连续多轮未发现新图片，继续滚动查找...');
      }

      if (emptyRounds >= (imageMode === 'backfill' ? 40 : 30)) {
        log('连续多轮没有新内容，已到达列表底部');
        break;
      }

      await page.evaluate(() => window.scrollBy(0, 2400));
      await sleep(1300 + Math.random() * 900);
    }

    const lines = [...collected.values()].map(
      (item) => `${item.mediaId}\t${item.url}\t${item.ext}\t${item.tweetId}\t${item.uploader}`
    );
    fs.writeFileSync(imageUrlsFile, `${lines.join('\n')}\n`, 'utf8');
    log(`已保存 ${lines.length} 张图片链接到 ${path.basename(imageUrlsFile)}`);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[collect-images] 失败：${err.message}`);
  process.exit(1);
});
