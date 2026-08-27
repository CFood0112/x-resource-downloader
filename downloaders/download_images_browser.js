const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { parseEntry } = require('../server/imageParser');
const { downloadWithBrowser } = require('./browserDownload');

const configPath = path.resolve(process.argv[2] || 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const root = path.dirname(configPath);

const resolveRel = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));

const profileDir = resolveRel(config.profileDir);
const imageUrlsFile = resolveRel(config.imageUrlsFile || 'image_urls.txt');
const imageArchiveFile = resolveRel(config.imageArchiveFile || 'image_archive.txt');
const listsDir = resolveRel(config.listsDir || 'data/lists');
const imageFailedFile = path.join(listsDir, 'image_failed.txt');
const skipRequestFile = path.join(listsDir, 'image_skip_request.txt');

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
  fs.mkdirSync(listsDir, { recursive: true });
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
        const tweetUrl = item.tweetId
          ? `https://x.com/${item.uploader || 'x'}/status/${item.tweetId}`
          : item.url;
        log(`FAIL ${item.mediaId} ${tweetUrl} ${result.error || 'download failed'}`);
        fs.appendFileSync(
          imageFailedFile,
          `${item.mediaId}\t${tweetUrl}\t${item.url}\t${result.error || 'download failed'}\n`,
          'utf8'
        );
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
