const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEntry } = require('../server/imageParser');

test('parses tab-separated image entry', () => {
  const line = 'HQkO7j3a4AAEEw9\thttps://pbs.twimg.com/media/HQkO7j3a4AAEEw9?format=jpg&name=orig\tjpg\t123\tuser\t2026-08-01';
  assert.deepEqual(parseEntry(line), {
    mediaId: 'HQkO7j3a4AAEEw9',
    url: 'https://pbs.twimg.com/media/HQkO7j3a4AAEEw9?format=jpg&name=orig',
    ext: 'jpg',
    tweetId: '123',
    uploader: 'user',
    date: '2026-08-01',
  });
});

test('parses raw pbs.twimg.com URL', () => {
  const entry = parseEntry('https://pbs.twimg.com/media/ABC123?format=png&name=orig');
  assert.equal(entry.mediaId, 'ABC123');
  assert.equal(entry.ext, 'png');
  assert.equal(entry.tweetId, '');
});

test('falls back to md5 media id for unknown URL', () => {
  const entry = parseEntry('https://example.com/image.jpg');
  assert.match(entry.mediaId, /^img_[0-9a-f]{12}$/);
  assert.equal(entry.ext, 'jpg');
});
