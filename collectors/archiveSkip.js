const fs = require('fs');
const path = require('path');

function loadArchiveSkipUrls({ archiveFile, videoMetaFile, logsDir, scanLogs = false, log = () => {} }) {
  const archiveIds = new Set();
  try {
    const text = fs.readFileSync(archiveFile, 'utf8');
    for (const m of text.matchAll(/twitter\s+(\d+)/g)) {
      archiveIds.add(m[1]);
    }
  } catch {
    /* no archive yet */
  }
  if (!archiveIds.size) return { skip: new Set(), mapped: 0, total: 0 };

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
    /* no persistent video meta yet */
  }

  if (scanLogs) {
    try {
      const files = fs
        .readdirSync(logsDir)
        .filter((f) => f.endsWith('.log'));
      for (const file of files) {
        const text = fs.readFileSync(path.join(logsDir, file), 'utf8');
        let currentUrl = '';
        for (const line of text.split(/\r?\n/)) {
          let m = line.match(/Extracting URL: (https:\/\/x\.com\/[^/\s]+\/status\/\d+)/);
          if (m) {
            currentUrl = m[1];
            continue;
          }
          m = line.match(/\[info\]\s+(\d+):\s+Downloading/);
          if (m && currentUrl) {
            urlByMedia.set(m[1], currentUrl);
            continue;
          }
          m = line.match(/^\[download\]\s+(\d+):\s+.+has already been recorded in the archive/);
          if (m && currentUrl) {
            urlByMedia.set(m[1], currentUrl);
            continue;
          }
          m = line.match(/\[download\] Destination: .*?(\d{15,20})[^\d]*\.mp4/);
          if (m && currentUrl) {
            urlByMedia.set(m[1], currentUrl);
          }
        }
      }
    } catch {
      /* no logs yet */
    }
  } else if (urlByMedia.size < archiveIds.size) {
    log(
      `video_meta 映射 ${urlByMedia.size}/${archiveIds.size}，如需补全请运行 scripts/rebuild_video_meta.js 或 scripts/map_remaining_video_meta.js`
    );
  }

  const skip = new Set();
  for (const id of archiveIds) {
    const url = urlByMedia.get(id);
    if (url) skip.add(url);
  }
  return { skip, mapped: urlByMedia.size, total: archiveIds.size };
}

module.exports = { loadArchiveSkipUrls };
