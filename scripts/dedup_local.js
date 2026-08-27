const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const configPath = path.resolve(process.argv[2] || 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const root = path.dirname(configPath);

const resolveRel = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));

const videoDirs = [resolveRel(config.downloadDir || 'data/videos')].filter((d) => fs.existsSync(d));
const imageDir = resolveRel(config.imageDir || 'data/images');
const strategy = process.env.DEDUP_STRATEGY || 'move';
const duplicateDir = resolveRel('data/duplicates');

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
} catch {
  /* defaults */
}
const useStrategy = process.env.DEDUP_STRATEGY || settings.dedupStrategy || 'move';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function main() {
  const files = [];
  for (const dir of videoDirs) files.push(...walk(dir));
  if (fs.existsSync(imageDir)) files.push(...walk(imageDir));

  const byHash = new Map();
  for (const file of files) {
    try {
      const hash = await hashFile(file);
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash).push(file);
    } catch {
      /* skip unreadable */
    }
  }

  let moved = 0;
  let linked = 0;
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    const keep = group[0];
    for (const dup of group.slice(1)) {
      try {
        if (useStrategy === 'hardlink') {
          fs.unlinkSync(dup);
          fs.linkSync(keep, dup);
          linked++;
        } else {
          fs.mkdirSync(duplicateDir, { recursive: true });
          const rel = path.relative(root, dup);
          const target = path.join(duplicateDir, rel.replace(/[<>:"/\\|?*]/g, '_'));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.renameSync(dup, target);
          moved++;
        }
        console.log(`[dedup] ${dup} -> ${useStrategy}`);
      } catch {
        /* ignore */
      }
    }
  }
  console.log(`[dedup] 完成：${useStrategy}，移动 ${moved}，硬链接 ${linked}`);
}

main().catch((err) => {
  console.error(`[dedup] 失败：${err.message}`);
  process.exit(1);
});
