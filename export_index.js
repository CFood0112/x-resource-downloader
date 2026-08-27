const fs = require('fs');
const path = require('path');

const configPath = path.resolve(process.argv[2] || 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const root = path.dirname(configPath);

const resolveRel = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));

const videoDirs = [resolveRel(config.downloadDir || 'data/videos')].filter((d) => fs.existsSync(d));
const imageDir = resolveRel(config.imageDir || 'data/images');
const videoMetaFile = resolveRel(config.videoMetaFile || 'data/lists/video_meta.txt');
const imageMetaFile = resolveRel(config.imageMetaFile || 'data/lists/image_meta.txt');
const outJson = resolveRel('data/index.json');
const outCsv = resolveRel('data/index.csv');

const videoMeta = new Map();
try {
  for (const line of fs.readFileSync(videoMetaFile, 'utf8').split(/\r?\n/)) {
    const [url, id] = line.trim().split('\t');
    if (url && id) videoMeta.set(id, url);
  }
} catch {
  /* ignore */
}

const imageMeta = new Map();
try {
  for (const line of fs.readFileSync(imageMetaFile, 'utf8').split(/\r?\n/)) {
    const parts = line.trim().split('\t');
    if (parts.length >= 2) {
      imageMeta.set(parts[0], {
        url: parts[1] || '',
        ext: parts[2] || '',
        tweetId: parts[3] || '',
        uploader: parts[4] || '',
        date: parts[5] || '',
      });
    }
  }
} catch {
  /* ignore */
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const records = [];

for (const dir of videoDirs) {
  for (const file of walk(dir)) {
    const base = path.basename(file);
    if (!/\.(mp4|mkv|webm|mov)$/i.test(base)) continue;
    const idMatch = base.match(/(\d{15,20})/);
    if (!idMatch) continue;
    const mediaId = idMatch[1];
    const tweetUrl = videoMeta.get(mediaId) || '';
    const st = fs.statSync(file);
    records.push({
      type: 'video',
      mediaId,
      tweetUrl,
      uploader: tweetUrl ? tweetUrl.match(/x\.com\/([^/]+)\/status/)?.[1] || '' : '',
      uploadDate: '',
      downloadTime: st.mtime.toISOString(),
      filePath: file,
      fileSize: st.size,
    });
  }
}

if (fs.existsSync(imageDir)) {
  for (const file of walk(imageDir)) {
    if (!/\.(jpg|jpeg|png|webp|gif)$/i.test(file)) continue;
    const base = path.basename(file, path.extname(file));
    const mediaId = base.split('_')[0];
    if (!mediaId || !/^[A-Za-z0-9-]{10,}$/.test(mediaId)) continue;
    const meta = imageMeta.get(mediaId) || {};
    const st = fs.statSync(file);
    records.push({
      type: 'image',
      mediaId,
      tweetUrl: meta.url || '',
      uploader: meta.uploader || '',
      uploadDate: meta.date || '',
      downloadTime: st.mtime.toISOString(),
      filePath: file,
      fileSize: st.size,
    });
  }
}

fs.writeFileSync(outJson, JSON.stringify(records, null, 2), 'utf8');
const header = 'type,media_id,tweet_url,uploader,upload_date,download_time,file_path,file_size';
const rows = records.map((r) =>
  [
    r.type,
    r.mediaId,
    r.tweetUrl,
    r.uploader,
    r.uploadDate,
    r.downloadTime,
    r.filePath,
    r.fileSize,
  ]
    .map((v) => `"${String(v).replace(/"/g, '""')}"`)
    .join(',')
);
fs.writeFileSync(outCsv, `${header}\n${rows.join('\n')}\n`, 'utf8');

console.log(`[export] 生成 ${records.length} 条索引：${outJson} ${outCsv}`);
