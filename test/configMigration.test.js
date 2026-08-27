const test = require('node:test');
const assert = require('node:assert/strict');
const { migrateLegacyPaths } = require('../server/config');

test('migrates legacy release config paths into data/', () => {
  const { config, configChanged } = migrateLegacyPaths(
    {
      profileDir: 'profile',
      downloadProfileDir: 'profile_download',
      downloadCookiesFile: 'cookies_download.txt',
      downloadDir: 'videos',
      imageDir: 'images',
      imageUrlsFile: 'image_urls.txt',
      listsDir: 'lists',
      runDir: '.',
      urlsFile: 'liked_urls.txt',
      skipUrlsFile: 'lists/skipped_urls.txt',
      logsDir: 'logs',
      cookiesFile: 'cookies.txt',
      archiveFile: 'archive.txt',
    },
    {}
  );
  assert.equal(configChanged, true);
  assert.equal(config.profileDir, 'data/profiles/main');
  assert.equal(config.downloadDir, 'data/videos');
  assert.equal(config.imageDir, 'data/images');
  assert.equal(config.listsDir, 'data/lists');
  assert.equal(config.runDir, 'data/run');
  assert.equal(config.urlsFile, 'data/lists/liked_urls.txt');
  assert.equal(config.skipUrlsFile, 'data/lists/skipped_urls.txt');
  assert.equal(config.cookiesFile, 'data/cookies/cookies.txt');
});

test('migrates legacy settings download dirs', () => {
  const { settings, settingsChanged } = migrateLegacyPaths(
    {},
    {
      video: { downloadDir: 'videos' },
      image: { downloadDir: 'images' },
    }
  );
  assert.equal(settingsChanged, true);
  assert.equal(settings.video.downloadDir, 'data/videos');
  assert.equal(settings.image.downloadDir, 'data/images');
});
