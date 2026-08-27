const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadArchiveSkipUrls } = require('../collectors/archiveSkip');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

test('maps archive ids through video_meta without scanning logs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrd-archive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  write(path.join(dir, 'archive.txt'), 'twitter 111\n# comment\ntwitter 222\n');
  write(
    path.join(dir, 'video_meta.txt'),
    'https://x.com/alice/status/111\t111\nhttps://x.com/bob/status/222\t222\n'
  );
  write(path.join(dir, 'run.log'), '');

  const { skip, mapped, total } = loadArchiveSkipUrls({
    archiveFile: path.join(dir, 'archive.txt'),
    videoMetaFile: path.join(dir, 'video_meta.txt'),
    logsDir: dir,
    scanLogs: false,
  });

  assert.equal(mapped, 2);
  assert.equal(total, 2);
  assert.ok(skip.has('https://x.com/alice/status/111'));
  assert.ok(skip.has('https://x.com/bob/status/222'));
});

test('repair mode reconstructs missing mappings from logs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrd-repair-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  write(path.join(dir, 'archive.txt'), 'twitter 111\ntwitter 222\n');
  write(path.join(dir, 'video_meta.txt'), 'https://x.com/alice/status/111\t111\n');
  write(
    path.join(dir, 'run.log'),
    'Extracting URL: https://x.com/bob/status/222\n[info] 222: Downloading\n'
  );

  const { skip, mapped } = loadArchiveSkipUrls({
    archiveFile: path.join(dir, 'archive.txt'),
    videoMetaFile: path.join(dir, 'video_meta.txt'),
    logsDir: dir,
    scanLogs: true,
  });

  assert.equal(mapped, 2);
  assert.ok(skip.has('https://x.com/bob/status/222'));
});
