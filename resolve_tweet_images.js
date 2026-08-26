const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const configPath = path.resolve(process.argv[2] || 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const root = path.dirname(configPath);

const resolveRel = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));

const profileDir = resolveRel(config.profileDir);
const manualTweetUrlsFile = resolveRel(config.manualTweetUrlsFile || 'manual_tweet_urls.txt');
const imageUrlsFile = resolveRel(config.imageUrlsFile || 'image_urls.txt');
const loginTimeoutMs = Number(config.loginTimeoutMs) || 600000;

function log(msg) {
  console.log(`[resolve-images] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLogin(page) {
  const deadline = Date.now() + loginTimeoutMs;
  log('正在打开 X；如果弹出登录页，请在 Chrome 窗口里完成登录...');
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('浏览器窗口已关闭');
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

async function collectImages(page) {
  return page.evaluate(() => {
    const images = [];
    for (const img of document.querySelectorAll('img[src*="pbs.twimg.com/media/"]')) {
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
    return images;
  });
}

async function main() {
  const urls = fs
    .readFileSync(manualTweetUrlsFile, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!urls.length) {
    log('没有待解析的推文链接');
    return;
  }

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

    const lines = [];
    for (const url of urls) {
      const match = url.match(/x\.com\/([^/]+)\/status\/(\d+)/);
      const uploader = match ? match[1] : '';
      const tweetId = match ? match[2] : '';
      log(`解析：${url}`);
      await page
        .goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch(() => {});
      await page.waitForTimeout(2500);
      const images = await collectImages(page);
      for (const image of images) {
        lines.push(`${image.mediaId}\t${image.url}\t${image.ext}\t${tweetId}\t${uploader}`);
      }
      log(`找到 ${images.length} 张图片`);
      await sleep(1000);
    }

    fs.writeFileSync(imageUrlsFile, `${lines.join('\n')}\n`, 'utf8');
    log(`已写入 ${lines.length} 条图片链接到 ${path.basename(imageUrlsFile)}`);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[resolve-images] 失败：${err.message}`);
  process.exit(1);
});
