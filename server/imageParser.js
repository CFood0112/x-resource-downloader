const crypto = require('crypto');

function parseEntry(line) {
  const parts = line.split('\t');
  if (parts.length >= 3) {
    return {
      mediaId: parts[0],
      url: parts[1],
      ext: parts[2] || 'jpg',
      tweetId: parts[3] || '',
      uploader: parts[4] || '',
      date: parts[5] || '',
    };
  }
  const url = parts[0];
  const mediaMatch = url.match(/\/media\/([A-Za-z0-9_-]+)/);
  const extMatch = url.match(/format=([a-z0-9]+)/);
  const mediaId = mediaMatch
    ? mediaMatch[1]
    : `img_${crypto.createHash('md5').update(url).digest('hex').slice(0, 12)}`;
  return {
    mediaId,
    url,
    ext: (extMatch ? extMatch[1] : 'jpg'),
    tweetId: '',
    uploader: '',
    date: '',
  };
}

module.exports = { parseEntry };
