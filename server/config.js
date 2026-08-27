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

function normalizeSettings(raw) {
  const config = readJson(CONFIG_PATH) || {};
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

const config = readJson(CONFIG_PATH) || {};
const rawSettings = readJson(SETTINGS_PATH) || {};
let settings = normalizeSettings(rawSettings);
if (rawSettings.folderMode !== undefined) {
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
};
