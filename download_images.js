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
const listsDir = resolveRel(config.listsDir || 'data/lists');
const imageFailedFile = path.join(listsDir, 'image_failed.txt');
const skipRequestFile = path.join(listsDir, 'image_skip_request.txt');
const downloadCookiesFile = resolveRel(config.downloadCookiesFile || 'cookies_download.txt');
const mainCookiesFile = resolveRel(config.cookiesFile || 'cookies.txt');

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
const pythonPath = resolveRel(config.pythonPath || 'python.exe');

function log(msg) {
  console.log(`[image] ${msg}`);
}

function loadCookieHeader() {
  if (process.env.IMAGE_NO_COOKIES === '1') return '';
  if (process.env.ACTIVE_DOWNLOAD_COOKIE && fs.existsSync(process.env.ACTIVE_DOWNLOAD_COOKIE)) {
    return readCookieHeader(process.env.ACTIVE_DOWNLOAD_COOKIE);
  }
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
  return readCookieHeader(file);
}

function readCookieHeader(file) {
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

function loadCookieFile() {
  if (process.env.IMAGE_NO_COOKIES === '1') return '';
  if (process.env.ACTIVE_DOWNLOAD_COOKIE && fs.existsSync(process.env.ACTIVE_DOWNLOAD_COOKIE)) {
    return process.env.ACTIVE_DOWNLOAD_COOKIE;
  }
  let currentSettings = {};
  try {
    currentSettings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
  } catch {
    /* defaults */
  }
  const file =
    currentSettings.useDownloadAccount && fs.existsSync(downloadCookiesFile)
      ? downloadCookiesFile
      : mainCookiesFile;
  return fs.existsSync(file) ? file : '';
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
    : `img_${crypto.createHash('md5').update(url).digest('hex').slice(0, 12)}`;
  return {
    mediaId,
    url,
    ext: (extMatch ? extMatch[1] : 'jpg'),
    tweetId: '',
    uploader: '',
    date: '',
  };
}

async function main() {
  fs.mkdirSync(baseImageDir, { recursive: true });
  fs.mkdirSync(listsDir, { recursive: true });
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

  const cookieHeader = loadCookieHeader();
  const cookieFile = loadCookieFile();
  let done = 0;
  let failed = 0;

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
    let lastError = '';
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
      } catch {
        /* ignore */
      }
      try {
        const pyRes = spawnSync(
          pythonPath,
          [path.join(root, 'download_image.py'), item.url, outFile, cookieFile],
          { encoding: 'buffer', stdio: ['ignore', 'ignore', 'pipe'], timeout: 90000 }
        );
        lastError = pyRes.stderr ? pyRes.stderr.toString().trim() : 'python error';
        if (pyRes.status === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size) {
          ok = true;
          break;
        }
        const args = [
          '-sS', '-L', '-f',
          '--connect-timeout', '30',
          '--max-time', '120',
          '-A',
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          '-o', outFile,
        ];
        if (cookieHeader) {
          args.push('-H', `Cookie: ${cookieHeader}`);
        }
        args.push(item.url);
        const curlRes = spawnSync('curl.exe', args, {
          encoding: 'buffer',
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: 90000,
        });
        lastError = curlRes.stderr ? curlRes.stderr.toString().trim() : 'curl error';
        if (curlRes.status === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size) {
          ok = true;
          break;
        }
      } catch (err) {
        lastError = err.message;
      }
      if (!ok && attempt < 2) await sleep(2000 * (attempt + 1));
    }
    if (!ok) {
      failed++;
      const tweetUrl = item.tweetId
        ? `https://x.com/${item.uploader || 'x'}/status/${item.tweetId}`
        : item.url;
      log(`FAIL ${item.mediaId} ${tweetUrl} ${lastError}`);
      fs.appendFileSync(
        imageFailedFile,
        `${item.mediaId}\t${tweetUrl}\t${item.url}\t${lastError}\n`,
        'utf8'
      );
      continue;
    }
    const size = fs.statSync(outFile).size;
    archiveIds.add(item.mediaId);
    fs.appendFileSync(imageArchiveFile, `${item.mediaId}\t${item.tweetId || ''}\n`, 'utf8');
    done++;
    log(`${done}/${lines.length} ${item.mediaId} (${size} bytes)`);
    await sleep(300);
  }

  log(`图片下载完成：成功 ${done}，失败 ${failed}`);
}

main().catch((err) => {
  console.error(`[image] 失败：${err.message}`);
  process.exit(1);
});
