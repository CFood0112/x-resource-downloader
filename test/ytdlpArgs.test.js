const test = require('node:test');
const assert = require('node:assert/strict');
const { buildYtdlpArgs, buildOutputTemplate } = require('../server/ytdlpArgs');

const base = {
  urls: 'batch.txt',
  source: 'likes',
  activeCookies: 'cookies.txt',
  ffmpegPath: 'ffmpeg.exe',
  archiveFile: 'archive.txt',
  videoDir: 'D:/videos',
  settings: {
    proxy: 'custom',
    proxyUrl: 'http://127.0.0.1:7890',
    rateLimit: '5M',
    video: { folderMode: 'flat', nameMode: 'structured' },
  },
};

test('builds yt-dlp args with archive, proxy, rate limit and ffmpeg', () => {
  const args = buildYtdlpArgs(base);
  assert.ok(args.includes('--batch-file'));
  assert.ok(args.includes('batch.txt'));
  assert.ok(args.includes('--cookies'));
  assert.ok(args.includes('cookies.txt'));
  assert.ok(args.includes('--download-archive'));
  assert.ok(args.includes('archive.txt'));
  assert.ok(args.includes('--proxy'));
  assert.ok(args.includes('http://127.0.0.1:7890'));
  assert.ok(args.includes('--limit-rate'));
  assert.ok(args.includes('5M'));
  assert.ok(args.includes('--ffmpeg-location'));
  assert.ok(args.includes('ffmpeg.exe'));
});

test('force redownload drops archive and adds force-overwrites', () => {
  const args = buildYtdlpArgs({ ...base, force: true });
  assert.ok(!args.includes('--download-archive'));
  assert.ok(args.includes('--force-overwrites'));
});

test('omits cookies flag when no cookie file is available', () => {
  const args = buildYtdlpArgs({ ...base, activeCookies: '' });
  assert.ok(!args.includes('--cookies'));
});

test('builds output template by source folder', () => {
  const template = buildOutputTemplate({
    videoDir: 'D:/videos',
    source: 'bookmarks',
    videoSettings: { folderMode: 'uploader_month', nameMode: 'structured_title' },
  });
  assert.match(template, /^D:[\\/]videos[\\/]bookmarks/);
  assert.match(template, /uploader/);
  assert.match(template, /upload_date/);
});
