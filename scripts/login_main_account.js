const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const configPath = path.resolve(process.argv[2] || 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const root = path.dirname(configPath);

const resolveRel = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));

const profileDir = resolveRel(config.profileDir);
const cookiesFile = resolveRel(config.cookiesFile || 'cookies.txt');
const loginTimeoutMs = Number(config.loginTimeoutMs) || 600000;

function log(msg) {
  console.log(`[login-main] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLogin(page) {
  const deadline = Date.now() + loginTimeoutMs;
  log('正在打开 X；请在 Chrome 窗口里登录主账号...');

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
        const href = await profileLink.getAttribute('href');
        log(`已检测到登录状态：@${String(href).replace(/^\//, '')}`);
        return;
      }
    }

    await sleep(2000);
  }

  throw new Error('等待登录超时，请重新运行');
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
    await saveCookies(context);
    log('主账号登录完成');
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[login-main] 失败：${err.message}`);
  process.exit(1);
});
