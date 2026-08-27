const path = require('path');

function buildOutputTemplate({ videoDir, source, videoSettings }) {
  const subPaths = {
    flat: '',
    uploader: '%(uploader|unknown)s/',
    month: '%(upload_date>%Y-%m|unknown)s/',
    uploader_month: '%(uploader|unknown)s/%(upload_date>%Y-%m|unknown)s/',
  };
  const subPath = subPaths[(videoSettings && videoSettings.folderMode) || 'flat'] || '';
  const titlePart =
    (videoSettings && videoSettings.nameMode) === 'structured_title' ? ' - %(title).40s' : '';
  const sourceDir = source === 'bookmarks' ? 'bookmarks' : source === 'manual' ? 'manual' : 'likes';
  return path.join(
    videoDir,
    sourceDir,
    `${subPath}%(upload_date|unknown)s - %(uploader|unknown)s - %(id)s${titlePart}%(playlist_index& - {0}|)s.%(ext)s`
  );
}

function buildYtdlpArgs({
  urls,
  force,
  source = 'likes',
  activeCookies,
  settings = {},
  ffmpegPath,
  archiveFile,
  videoDir,
}) {
  const args = [
    '--batch-file', urls,
    '--cookies', activeCookies,
    '--ignore-errors',
    '--newline',
    '--no-colors',
    '--retries', '10',
    '--extractor-retries', '10',
    '--fragment-retries', '10',
    '--file-access-retries', '10',
    '--retry-sleep', '3',
    '--sleep-requests', '2',
    '--sleep-interval', '2',
    '--socket-timeout', '30',
    '--http-chunk-size', '10M',
    '--legacy-server-connect',
    '--concurrent-fragments', '3',
    '--yes-playlist',
    '-f', 'best/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', buildOutputTemplate({
      videoDir: videoDir || (settings.video && settings.video.downloadDir) || 'videos',
      source,
      videoSettings: settings.video || {},
    }),
  ];

  if (force) {
    args.push('--force-overwrites');
  } else {
    args.push('--download-archive', archiveFile);
  }

  const sourceProxy = settings.proxyBySource && settings.proxyBySource[source];
  if (sourceProxy) {
    args.push('--proxy', sourceProxy);
  } else if (settings.proxy === 'off') {
    args.push('--proxy', '');
  } else if (settings.proxy === 'custom' && settings.proxyUrl) {
    args.push('--proxy', settings.proxyUrl);
  }
  if (settings.rateLimit) {
    args.push('--limit-rate', settings.rateLimit);
  }
  if (ffmpegPath) {
    args.push('--ffmpeg-location', ffmpegPath);
  }

  return args;
}

module.exports = { buildOutputTemplate, buildYtdlpArgs };
