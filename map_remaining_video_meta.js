const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const configPath = path.resolve(process.argv[2] || 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const root = path.dirname(configPath);

const resolveRel = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));

const pythonPath = resolveRel(config.pythonPath || 'python.exe');
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

const batchLimit = Number(process.env.BATCH_LIMIT) || 200;
const minDelay = Number(process.env.MIN_DELAY) || 3000;
const maxDelay = Number(process.env.MAX_DELAY) || 9000;
const mappedArchive = new Set([...urlByMedia.keys()].filter((id) => archiveIds.has(id)));
let checked = 0;

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
  for (const url of seenUrls) {
    if (mappedArchive.size >= archiveIds.size) break;
    if (checked >= batchLimit) break;

    const args = [
      '-m', 'yt_dlp',
      '--simulate', '--no-warnings', '--yes-playlist',
      '--print', '%(id)s',
      '--extractor-retries', '5',
      '--legacy-server-connect',
      '--socket-timeout', '30',
      '--cookies', cookieFile,
      url,
    ];
    const res = spawnSync(pythonPath, args, {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    checked++;

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
      `[map] ${checked}/${batchLimit} archive=${mappedArchive.size}/${archiveIds.size} found=${newMappings.length}`
    );

    if (mappedArchive.size < archiveIds.size && checked < batchLimit) {
      const delay = Math.floor(minDelay + Math.random() * (maxDelay - minDelay));
      console.log(`[map] sleep ${(delay / 1000).toFixed(1)}s`);
      await sleep(delay);
    }
  }

  console.log(
    `[map] 完成：检查 ${checked} 条，archive 已映射 ${mappedArchive.size}/${archiveIds.size}`
  );
}

main().catch((err) => {
  console.error(`[map] 失败：${err.message}`);
  process.exit(1);
});
