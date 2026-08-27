const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const SETTINGS_PATH = path.join(ROOT, 'settings.json');

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

const writeJson = (p, data) => {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
};

const resolveRel = (p) => (path.isAbsolute(p) ? p : path.resolve(ROOT, p));

const LEGACY_PATH_MAP = {
  'videos': 'data/videos',
  'images': 'data/images',
  'profile': 'data/profiles/main',
  'profile_download': 'data/profiles/download',
  'cookies.txt': 'data/cookies/cookies.txt',
  'cookies_download.txt': 'data/cookies/cookies_download.txt',
  'liked_urls.txt': 'data/lists/liked_urls.txt',
  'seen_urls.txt': 'data/lists/seen_urls.txt',
  'skipped_urls.txt': 'data/lists/skipped_urls.txt',
  'lists/skipped_urls.txt': 'data/lists/skipped_urls.txt',
  'lists': 'data/lists',
  '.': 'data/run',
  'logs': 'data/logs',
  'archive.txt': 'data/lists/archive.txt',
  'backfill_position.txt': 'data/lists/backfill_position.txt',
  'lists/backfill_position.txt': 'data/lists/backfill_position.txt',
  'video_meta.txt': 'data/lists/video_meta.txt',
  'lists/video_meta.txt': 'data/lists/video_meta.txt',
  'image_urls.txt': 'data/lists/image_urls.txt',
  'image_archive.txt': 'data/lists/image_archive.txt',
  'image_meta.txt': 'data/lists/image_meta.txt',
  'retry_urls.txt': 'data/lists/retry_urls.txt',
  'active_batch.txt': 'data/lists/active_batch.txt',
  'manual_urls.txt': 'data/lists/manual_urls.txt',
  'manual_tweet_urls.txt': 'data/lists/manual_tweet_urls.txt',
  'image_failed.txt': 'data/lists/image_failed.txt',
  'image_skip_request.txt': 'data/lists/image_skip_request.txt',
};

const CONFIG_PATH_FIELDS = [
  'downloadDir',
  'imageDir',
  'profileDir',
  'downloadProfileDir',
  'downloadCookiesFile',
  'imageUrlsFile',
  'imageArchiveFile',
  'imageMetaFile',
  'listsDir',
  'runDir',
  'urlsFile',
  'seenUrlsFile',
  'skipUrlsFile',
  'logsDir',
  'cookiesFile',
  'archiveFile',
  'backfillPositionFile',
  'videoMetaFile',
];

function migrateLegacyPaths(configObj, settingsObj) {
  const config = { ...(configObj || {}) };
  const settings = {
    ...(settingsObj || {}),
    video: { ...((settingsObj && settingsObj.video) || {}) },
    image: { ...((settingsObj && settingsObj.image) || {}) },
  };
  let configChanged = false;
  let settingsChanged = false;

  for (const field of CONFIG_PATH_FIELDS) {
    if (typeof config[field] === 'string' && LEGACY_PATH_MAP[config[field]]) {
      config[field] = LEGACY_PATH_MAP[config[field]];
      configChanged = true;
    }
  }

  for (const key of ['downloadDir']) {
    if (typeof settings.video[key] === 'string' && LEGACY_PATH_MAP[settings.video[key]]) {
      settings.video[key] = LEGACY_PATH_MAP[settings.video[key]];
      settingsChanged = true;
    }
  }
  for (const key of ['downloadDir']) {
    if (typeof settings.image[key] === 'string' && LEGACY_PATH_MAP[settings.image[key]]) {
      settings.image[key] = LEGACY_PATH_MAP[settings.image[key]];
      settingsChanged = true;
    }
  }

  return { config, settings, configChanged, settingsChanged };
}

function normalizeSettings(raw, cfg) {
  const config = cfg || readJson(CONFIG_PATH) || {};
  const legacy = !!(raw && raw.folderMode !== undefined);
  const video = (raw && raw.video) || {};
  const image = (raw && raw.image) || {};
  return {
    video: {
      folderMode: video.folderMode || (legacy ? raw.folderMode : 'flat'),
      nameMode: video.nameMode || (legacy ? raw.nameMode : 'structured'),
      downloadDir: video.downloadDir || (config.downloadDir || 'videos'),
    },
    image: {
      folderMode: image.folderMode || 'flat',
      nameMode: image.nameMode || 'media_id',
      downloadDir: image.downloadDir || (config.imageDir || 'images'),
    },
    proxy: (raw && raw.proxy) || 'auto',
    proxyUrl: (raw && raw.proxyUrl) || '',
    forceRedownload: !!(raw && raw.forceRedownload),
    useDownloadAccount: !!(raw && raw.useDownloadAccount),
    wizardDone: !!(raw && raw.wizardDone),
    rateLimit: (raw && raw.rateLimit) || '',
    proxyBySource: (raw && raw.proxyBySource) || {},
    dedupStrategy: (raw && raw.dedupStrategy) || 'move',
    schedules: Array.isArray(raw && raw.schedules) ? raw.schedules : [],
  };
}

const configRaw = readJson(CONFIG_PATH) || {};
const settingsRaw = readJson(SETTINGS_PATH) || {};
const migrated = migrateLegacyPaths(configRaw, settingsRaw);
if (migrated.configChanged) {
  writeJson(CONFIG_PATH, migrated.config);
}
if (migrated.settingsChanged) {
  writeJson(SETTINGS_PATH, migrated.settings);
}
const config = migrated.config;
let settings = normalizeSettings(migrated.settings, config);
if (migrated.settingsChanged || settingsRaw.folderMode !== undefined) {
  writeJson(SETTINGS_PATH, settings);
}

const paths = {
  nodePath: resolveRel(config.nodePath || 'node.exe'),
  nodeModules: resolveRel(config.nodeModules || ''),
  pythonPath: resolveRel(config.pythonPath || 'python.exe'),
  ytdlpPath: resolveRel(config.ytdlpPath || ''),
  ffmpegPathConfig: resolveRel(config.ffmpegPath || ''),
  urlsFile: resolveRel(config.urlsFile || 'liked_urls.txt'),
  cookiesFile: resolveRel(config.cookiesFile || 'cookies.txt'),
  downloadCookiesFile: resolveRel(config.downloadCookiesFile || 'cookies_download.txt'),
  archiveFile: resolveRel(config.archiveFile || 'archive.txt'),
  listsDir: resolveRel(config.listsDir || 'data/lists'),
  runDir: resolveRel(config.runDir || 'data/run'),
  jobsDir: resolveRel(config.jobsDir || 'data/jobs'),
  queueFile: '',
  failuresFile: '',
  logDir: resolveRel(config.logsDir || 'logs'),
  lockFile: '',
  manualUrlsFile: '',
  imageUrlsFile: resolveRel(config.imageUrlsFile || 'image_urls.txt'),
  manualTweetUrlsFile: '',
  retryUrlsFile: '',
  activeBatchFile: '',
  skipUrlsFile: '',
  imageSkipRequestFile: '',
  videoMetaFile: '',
  downloadDir: resolveRel(config.downloadDir || 'videos'),
  imageDir: resolveRel(config.imageDir || 'images'),
};

paths.queueFile = path.join(paths.jobsDir, 'queue.json');
paths.failuresFile = path.join(paths.listsDir, 'failures.json');
paths.lockFile = path.join(paths.runDir, '.gui.lock');
paths.manualUrlsFile = path.join(paths.listsDir, 'manual_urls.txt');
paths.manualTweetUrlsFile = path.join(paths.listsDir, 'manual_tweet_urls.txt');
paths.retryUrlsFile = path.join(paths.listsDir, 'retry_urls.txt');
paths.activeBatchFile = path.join(paths.listsDir, 'active_batch.txt');
paths.skipUrlsFile = path.join(paths.listsDir, 'skipped_urls.txt');
paths.imageSkipRequestFile = path.join(paths.listsDir, 'image_skip_request.txt');
paths.videoMetaFile = path.join(paths.listsDir, 'video_meta.txt');

module.exports = {
  ROOT,
  CONFIG_PATH,
  SETTINGS_PATH,
  config,
  settings,
  paths,
  readJson,
  writeJson,
  resolveRel,
  normalizeSettings,
  migrateLegacyPaths,
};
