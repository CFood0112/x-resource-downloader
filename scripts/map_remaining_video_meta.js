const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const configPath = path.resolve(process.argv[2] || 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const root = path.dirname(configPath);

const resolveRel = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));

const pythonPath = resolveRel(config.pythonPath || 'python.exe');
const ytdlpPath = config.ytdlpPath ? resolveRel(config.ytdlpPath) : '';
const archiveFile = resolveRel(config.archiveFile || 'data/lists/archive.txt');
const videoMetaFile = resolveRel(config.videoMetaFile || 'data/lists/video_meta.txt');
const seenUrlsFile = resolveRel(config.seenUrlsFile || 'data/lists/seen_urls.txt');
const cookiesFile = resolveRel(config.cookiesFile || 'data/cookies/cookies.txt');
const downloadCookiesFile = resolveRel(config.downloadCookiesFile || 'data/cookies/cookies_download.txt');

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
} catch {
  /* defaults */
}
const cookieFile =
  settings.useDownloadAccount && fs.existsSync(downloadCookiesFile)
    ? downloadCookiesFile
    : cookiesFile;

const archiveIds = new Set();
try {
  const text = fs.readFileSync(archiveFile, 'utf8');
  for (const m of text.matchAll(/twitter\s+(\d+)/g)) {
    archiveIds.add(m[1]);
  }
} catch {
  /* no archive */
}

const urlByMedia = new Map();
try {
  const text = fs.readFileSync(videoMetaFile, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split('\t');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      urlByMedia.set(parts[1], parts[0]);
    }
  }
} catch {
  /* no existing meta */
}
const mappedUrls = new Set(urlByMedia.values());

const seenUrls = new Set();
try {
  const text = fs.readFileSync(seenUrlsFile, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const url = line.trim();
    if (url && !mappedUrls.has(url)) seenUrls.add(url);
  }
} catch {
  /* no seen urls */
}

const minDelay = Number(process.env.MIN_DELAY) || 3000;
const maxDelay = Number(process.env.MAX_DELAY) || 9000;
const maxUrls = process.env.MAX_URLS ? Number(process.env.MAX_URLS) : Infinity;
const maxRetries = Number(process.env.MAX_RETRIES) || 3;
const mappedArchive = new Set([...urlByMedia.keys()].filter((id) => archiveIds.has(id)));
const pendingUrls = [...seenUrls];
const attempts = new Map();
let checked = 0;
let dropped = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendMappings(newMappings) {
  if (!newMappings.length) return;
  fs.mkdirSync(path.dirname(videoMetaFile), { recursive: true });
  fs.appendFileSync(
    videoMetaFile,
    `${newMappings.map(([url, id]) => `${url}\t${id}`).join('\n')}\n`,
    'utf8'
  );
}

async function main() {
  if (mappedArchive.size >= archiveIds.size) {
    console.log(`[map] 已全部匹配（${mappedArchive.size}/${archiveIds.size}），无需运行`);
    return;
  }

  while (pendingUrls.length && mappedArchive.size < archiveIds.size && checked < maxUrls) {
    const url = pendingUrls.shift();
    const baseArgs = [
      '--simulate', '--no-warnings', '--yes-playlist',
      '--print', '%(id)s',
      '--extractor-retries', '5',
      '--legacy-server-connect',
      '--socket-timeout', '30',
      '--cookies', cookieFile,
    ];
    const args = ytdlpPath
      ? [...baseArgs, url]
      : ['-m', 'yt_dlp', ...baseArgs, url];
    const res = spawnSync(ytdlpPath || pythonPath, args, {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    checked++;

    if (res.status !== 0) {
      const n = (attempts.get(url) || 0) + 1;
      attempts.set(url, n);
      if (n < maxRetries) {
        pendingUrls.push(url);
      } else {
        dropped++;
        console.log(`[map] 放弃 ${url}（连续失败 ${n} 次）`);
      }
      console.log(
        `[map] 失败 ${checked} archive=${mappedArchive.size}/${archiveIds.size} retry=${n}/${maxRetries}`
      );
    } else {
      attempts.delete(url);
      const ids = (res.stdout || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const newMappings = [];
      for (const id of ids) {
        if (archiveIds.has(id) && !urlByMedia.has(id)) {
          urlByMedia.set(id, url);
          newMappings.push([url, id]);
          mappedArchive.add(id);
          mappedUrls.add(url);
        }
      }
      appendMappings(newMappings);
      console.log(
        `[map] ${checked} archive=${mappedArchive.size}/${archiveIds.size} found=${newMappings.length} 剩余候选=${pendingUrls.length}`
      );
    }

    if (pendingUrls.length && mappedArchive.size < archiveIds.size && checked < maxUrls) {
      const delay = Math.floor(minDelay + Math.random() * (maxDelay - minDelay));
      console.log(`[map] sleep ${(delay / 1000).toFixed(1)}s`);
      await sleep(delay);
    }
  }

  console.log(
    `[map] 结束：检查 ${checked}，匹配 ${mappedArchive.size}/${archiveIds.size}，剩余候选 ${pendingUrls.length}，放弃 ${dropped}`
  );
}

main().catch((err) => {
  console.error(`[map] 失败：${err.message}`);
  process.exit(1);
});
