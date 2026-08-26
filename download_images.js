const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

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

function parseEntry(line) {
  const parts = line.split('\t');
  if (parts.length >= 2) {
    return { mediaId: parts[0], url: parts[1], ext: parts[2] || 'jpg' };
  }
  const url = parts[0];
  const mediaMatch = url.match(/\/media\/([A-Za-z0-9_-]+)/);
  const extMatch = url.match(/format=([a-z0-9]+)/);
  const mediaId = mediaMatch
    ? mediaMatch[1]
    : `img_${crypto.createHash('md5').update(url).digest('hex').slice(0, 12)}`;
  return { mediaId, url, ext: (extMatch ? extMatch[1] : 'jpg') };
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
    .map(parseEntry);

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
      const args = [
        '-sS', '-L', '-f',
        '--connect-timeout', '20',
        '--max-time', '120',
        '-A',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        '-o', outFile,
      ];
      if (cookieHeader) {
        args.push('-H', `Cookie: ${cookieHeader}`);
      }
      args.push(item.url);
      const res = spawnSync('curl.exe', args, { encoding: 'buffer', stdio: ['ignore', 'ignore', 'pipe'] });
      if (res.status !== 0 || !fs.existsSync(outFile)) {
        failed++;
        log(`FAIL ${item.mediaId} ${res.stderr ? res.stderr.toString().trim() : 'curl error'}`);
        continue;
      }
      const size = fs.statSync(outFile).size;
      archiveIds.add(item.mediaId);
      fs.appendFileSync(imageArchiveFile, `${item.mediaId}\n`, 'utf8');
      done++;
      log(`${done}/${lines.length} ${item.mediaId} (${size} bytes)`);
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
