const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const configPath = path.resolve(process.argv[2] || 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const root = path.dirname(configPath);

const resolveRel = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));

const profileDir = resolveRel(config.profileDir);
const urlsFile = resolveRel(config.urlsFile);
const cookiesFile = resolveRel(config.cookiesFile);
const seenUrlsFile = resolveRel(config.seenUrlsFile || 'seen_urls.txt');
const archiveFile = resolveRel(config.archiveFile || 'archive.txt');
const logsDir = resolveRel(config.logsDir || 'logs');
const configuredMax = Number(config.maxLikesToScan) || 500;
const maxLikes = Number(process.env.COLLECT_MAX_LIKES) || configuredMax;
const maxScrollAttempts = Number(config.maxScrollAttempts) || 80;
const loginTimeoutMs = Number(config.loginTimeoutMs) || 600000;

function log(msg) {
  console.log(`[collect] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadArchiveSkipUrls() {
  const archiveIds = new Set();
  try {
    const text = fs.readFileSync(archiveFile, 'utf8');
    for (const m of text.matchAll(/twitter\s+(\d+)/g)) {
      archiveIds.add(m[1]);
    }
  } catch {
    /* no archive yet */
  }
  if (!archiveIds.size) return new Set();

  const urlByMedia = new Map();
  try {
    const files = fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith('.log'));
    for (const file of files) {
      const text = fs.readFileSync(path.join(logsDir, file), 'utf8');
      let currentUrl = '';
      for (const line of text.split(/\r?\n/)) {
        let m = line.match(/Extracting URL: (https:\/\/x\.com\/[^/\s]+\/status\/\d+)/);
        if (m) {
          currentUrl = m[1];
          continue;
        }
        m = line.match(/\[info\]\s+(\d+):\s+Downloading/);
        if (m && currentUrl) {
          urlByMedia.set(m[1], currentUrl);
          continue;
        }
        m = line.match(/^\[download\]\s+(\d+):\s+.+has already been recorded in the archive/);
        if (m && currentUrl) {
          urlByMedia.set(m[1], currentUrl);
          continue;
        }
        m = line.match(/\[download\] Destination: .*?(\d{15,20})[^\d]*\.mp4/);
        if (m && currentUrl) {
          urlByMedia.set(m[1], currentUrl);
        }
      }
    }
  } catch {
    /* no logs yet */
  }

  const skip = new Set();
  for (const id of archiveIds) {
    const url = urlByMedia.get(id);
    if (url) skip.add(url);
  }
  return skip;
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

async function collectLikedVideos(page, username) {
  const likesUrl = `https://x.com/${username}/likes`;
  log(`打开喜欢列表：${likesUrl}`);
  await page.goto(likesUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForSelector('article', { timeout: 60000 }).catch(() => {});

  const seenIds = new Set();
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
  for (const url of archiveSkipUrls) {
    seenUrls.add(url);
  }
  if (archiveSkipUrls.size > 0) {
    log(`根据下载记录识别到 ${archiveSkipUrls.size} 条已下载视频`);
  }
  const videoUrls = [];
  let skippedCount = 0;
  let emptyRounds = 0;

  for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
    if (videoUrls.length >= maxLikes) {
      log(`已达到上限 ${maxLikes} 个视频，停止扫描`);
      break;
    }

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

    const snapshot = await page.evaluate(() => {
      const found = [];
      for (const article of document.querySelectorAll('article')) {
        const link = article.querySelector('a[href*="/status/"]');
        if (!link) continue;
        const match = link.href.match(/\/[^/]+\/status\/(\d+)/);
        if (!match) continue;
        const hasVideo =
          !!article.querySelector('video') ||
          !!article.querySelector('[data-testid="videoPlayer"]');
        found.push({ id: match[1], url: `https://x.com${match[0]}`, hasVideo });
      }
      return found;
    });

    let newCount = 0;
    for (const item of snapshot) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      newCount++;
      if (!item.hasVideo) continue;
      if (seenUrls.has(item.url)) {
        skippedCount++;
      } else {
        videoUrls.push(item.url);
        seenUrls.add(item.url);
      }
    }

    emptyRounds = newCount === 0 ? emptyRounds + 1 : 0;
    log(
      `第 ${attempt + 1}/${maxScrollAttempts} 轮：累计发现 ${seenIds.size} 条推文，其中视频 ${videoUrls.length} 条，已跳过 ${skippedCount} 条旧视频`
    );

    if (emptyRounds >= 10) {
      log('连续多轮没有新内容，已到达列表底部');
      break;
    }

    await page.evaluate(() => window.scrollBy(0, 2400));
    await sleep(1300 + Math.random() * 900);
  }

  try {
    fs.writeFileSync(seenUrlsFile, `${[...seenUrls].join('\n')}\n`, 'utf8');
  } catch (err) {
    log(`[collect] 写入已采集记录失败：${err.message}`);
  }

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
