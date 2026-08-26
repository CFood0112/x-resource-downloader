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
const skipRequestFile = path.join(root, 'image_skip_request.txt');

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
} catch {
  /* defaults */
}
const imageSettings = settings.image || {};
const imageSource = process.env.IMAGE_SOURCE || 'manual';
const baseImageDir = resolveRel(
  path.join(imageSettings.downloadDir || config.imageDir || 'images', imageSource)
);
const imageFolderMode = imageSettings.folderMode || 'flat';
const imageNameMode = imageSettings.nameMode || 'media_id';

function log(msg) {
  console.log(`[image] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEntry(line) {
  const parts = line.split('\t');
  if (parts.length >= 3) {
    return {
      mediaId: parts[0],
      url: parts[1],
      ext: parts[2] || 'jpg',
      tweetId: parts[3] || '',
      uploader: parts[4] || '',
      date: parts[5] || '',
    };
  }
  const url = parts[0];
  const mediaMatch = url.match(/\/media\/([A-Za-z0-9_-]+)/);
  const extMatch = url.match(/format=([a-z0-9]+)/);
  const mediaId = mediaMatch
    ? mediaMatch[1]
    : `img_${require('crypto').createHash('md5').update(url).digest('hex').slice(0, 12)}`;
  return { mediaId, url, ext: (extMatch ? extMatch[1] : 'jpg'), tweetId: '', uploader: '', date: '' };
}

async function downloadWithBrowser(context, item, outFile) {
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      page.close().catch(() => {});
      resolve({ ok: false, error: 'browser download timeout' });
    }, 60000);

    const onResponse = async (event) => {
      const url = event.response.url;
      if (event.type !== 'Image' && !url.includes('pbs.twimg.com/media/')) return;
      if (event.response.status >= 400) {
        clearTimeout(timer);
        page.close().catch(() => {});
        resolve({ ok: false, error: `http ${event.response.status}` });
        return;
      }
      try {
        const { body, base64Encoded } = await client.send('Network.getResponseBody', {
          requestId: event.requestId,
        });
        clearTimeout(timer);
        fs.writeFileSync(outFile, Buffer.from(body, base64Encoded ? 'base64' : 'utf8'));
        page.close().catch(() => {});
        resolve({ ok: true });
      } catch (err) {
        clearTimeout(timer);
        page.close().catch(() => {});
        resolve({ ok: false, error: err.message });
      }
    };

    client.on('Network.responseReceived', onResponse);
    page
      .goto(item.url, { waitUntil: 'commit', timeout: 60000 })
      .catch(() => {});
  });
}

async function main() {
  const archiveIds = new Set();
  try {
    const text = fs.readFileSync(imageArchiveFile, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const parts = line.trim().split('\t');
      if (parts[0]) archiveIds.add(parts[0]);
    }
  } catch {
    /* no image archive yet */
  }

  const lines = fs
    .readFileSync(imageUrlsFile, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseEntry);

  fs.mkdirSync(baseImageDir, { recursive: true });
  let context;
  let done = 0;
  let failed = 0;

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    for (let i = 0; i < lines.length; i++) {
      const item = lines[i];
      let skipRequest = '';
      try {
        skipRequest = fs.readFileSync(skipRequestFile, 'utf8').trim();
      } catch {
        /* no skip request */
      }
      if (skipRequest === item.mediaId || skipRequest === '*') {
        try {
          fs.unlinkSync(skipRequestFile);
        } catch {
          /* ignore */
        }
        log(`SKIP ${item.mediaId}`);
        continue;
      }
      if (archiveIds.has(item.mediaId)) {
        done++;
        continue;
      }

      const month = (item.date || '').slice(0, 7);
      let subDir = '';
      if (imageFolderMode === 'uploader' && item.uploader) {
        subDir = item.uploader;
      } else if (imageFolderMode === 'month' && month) {
        subDir = month;
      } else if (imageFolderMode === 'uploader_month' && item.uploader && month) {
        subDir = path.join(item.uploader, month);
      }
      const dir = subDir ? path.join(baseImageDir, subDir) : baseImageDir;
      fs.mkdirSync(dir, { recursive: true });
      const fileName =
        imageNameMode === 'full' && item.tweetId
          ? `${item.mediaId}_${item.tweetId}`
          : item.mediaId;
      const outFile = path.join(dir, `${fileName}.${item.ext}`);

      let result = { ok: false, error: 'download failed' };
      for (let attempt = 0; attempt < 3 && !result.ok; attempt++) {
        try {
          if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
        } catch {
          /* ignore */
        }
        result = await downloadWithBrowser(context, item, outFile);
        if (result.ok && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) break;
        if (attempt < 2) await sleep(2000 * (attempt + 1));
      }

      if (result.ok && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
        const size = fs.statSync(outFile).size;
        archiveIds.add(item.mediaId);
        fs.appendFileSync(imageArchiveFile, `${item.mediaId}\t${item.tweetId || ''}\n`, 'utf8');
        done++;
        log(`${done}/${lines.length} ${item.mediaId} (${size} bytes)`);
      } else {
        failed++;
        log(`FAIL ${item.mediaId} ${result.error || 'download failed'}`);
      }
    }
  } finally {
    if (context) await context.close().catch(() => {});
  }

  log(`图片下载完成：成功 ${done}，失败 ${failed}`);
}

main().catch((err) => {
  console.error(`[image] 失败：${err.message}`);
  process.exit(1);
});
