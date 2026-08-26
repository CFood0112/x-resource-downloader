const fs = require('fs');
const path = require('path');

const configPath = path.resolve(process.argv[2] || 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const root = path.dirname(configPath);

const resolveRel = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));

const imageUrlsFile = resolveRel(config.imageUrlsFile || 'image_urls.txt');
const imageArchiveFile = resolveRel(config.imageArchiveFile || 'image_archive.txt');
const imageDir = resolveRel(config.imageDir || 'images');
const downloadCookiesFile = resolveRel(config.downloadCookiesFile || 'cookies_download.txt');
const mainCookiesFile = resolveRel(config.cookiesFile || 'cookies.txt');

function log(msg) {
  console.log(`[image] ${msg}`);
}

function loadCookieHeader() {
  if (process.env.IMAGE_NO_COOKIES === '1') return '';
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
  } catch {
    /* defaults */
  }
  const file =
    settings.useDownloadAccount && fs.existsSync(downloadCookiesFile)
      ? downloadCookiesFile
      : mainCookiesFile;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parts = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const cols = line.split('\t');
      if (cols.length >= 7) parts.push(`${cols[5]}=${cols[6]}`);
    }
    return parts.join('; ');
  } catch {
    return '';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  fs.mkdirSync(imageDir, { recursive: true });
  const archiveIds = new Set();
  try {
    const text = fs.readFileSync(imageArchiveFile, 'utf8');
    text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((id) => archiveIds.add(id));
  } catch {
    /* no image archive yet */
  }

  const lines = fs
    .readFileSync(imageUrlsFile, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const [mediaId, url, ext] = line.split('\t');
      return { mediaId, url, ext: ext || 'jpg' };
    });

  const cookieHeader = loadCookieHeader();
  let done = 0;
  let failed = 0;

  for (let i = 0; i < lines.length; i++) {
    const item = lines[i];
    if (archiveIds.has(item.mediaId)) {
      done++;
      continue;
    }
    const outFile = path.join(imageDir, `${item.mediaId}.${item.ext}`);
    try {
      const res = await fetch(item.url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          Cookie: cookieHeader,
        },
      });
      if (!res.ok) {
        failed++;
        log(`FAIL ${item.mediaId} http=${res.status}`);
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(outFile, buffer);
      archiveIds.add(item.mediaId);
      fs.appendFileSync(imageArchiveFile, `${item.mediaId}\n`, 'utf8');
      done++;
      log(`${done}/${lines.length} ${item.mediaId} (${buffer.length} bytes)`);
    } catch (err) {
      failed++;
      log(`FAIL ${item.mediaId} ${err.message}`);
    }
    await sleep(300);
  }

  log(`图片下载完成：成功 ${done}，失败 ${failed}`);
}

main().catch((err) => {
  console.error(`[image] 失败：${err.message}`);
  process.exit(1);
});
