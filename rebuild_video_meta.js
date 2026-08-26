const fs = require('fs');
const path = require('path');

const configPath = path.resolve(process.argv[2] || 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const root = path.dirname(configPath);

const resolveRel = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));

const logsDir = resolveRel(config.logsDir || 'data/logs');
const archiveFile = resolveRel(config.archiveFile || 'data/lists/archive.txt');
const videoMetaFile = resolveRel(config.videoMetaFile || 'data/lists/video_meta.txt');

const urlByMedia = new Map();

function addMapping(mediaId, url) {
  if (mediaId && url) urlByMedia.set(mediaId, url);
}

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

let archiveCount = 0;
try {
  const text = fs.readFileSync(archiveFile, 'utf8');
  for (const m of text.matchAll(/twitter\s+(\d+)/g)) {
    archiveCount++;
  }
} catch {
  /* no archive */
}

let scannedLogs = 0;
try {
  const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
  for (const file of files) {
    scannedLogs++;
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
        addMapping(m[1], currentUrl);
        continue;
      }
      m = line.match(/^\[download\]\s+(\d+):\s+.+has already been recorded in the archive/);
      if (m && currentUrl) {
        addMapping(m[1], currentUrl);
        continue;
      }
      m = line.match(/\[download\] Destination: .*?(\d{15,20})[^\d]*\.mp4/);
      if (m && currentUrl) {
        addMapping(m[1], currentUrl);
      }
    }
  }
} catch {
  /* no logs */
}

fs.mkdirSync(path.dirname(videoMetaFile), { recursive: true });
const lines = [...urlByMedia.entries()].map(([mediaId, url]) => `${url}\t${mediaId}`);
fs.writeFileSync(videoMetaFile, `${lines.join('\n')}\n`, 'utf8');

console.log(
  `[rebuild-meta] archive=${archiveCount} logs=${scannedLogs} mappings=${urlByMedia.size}`
);
