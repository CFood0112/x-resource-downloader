const fs = require('fs');
const path = require('path');
const { settings, paths } = require('./config');

let accountIndex = 0;

function listDownloadAccounts() {
  const names = [];
  const cookiesBase = path.dirname(paths.cookiesFile);
  if (!fs.existsSync(cookiesBase)) return names;
  try {
    for (const f of fs.readdirSync(cookiesBase)) {
      const m = f.match(/^cookies_download_(.+)\.txt$/);
      if (m) names.push(m[1]);
    }
  } catch {
    /* ignore */
  }
  if (!names.length && fs.existsSync(paths.downloadCookiesFile)) names.push('');
  return names;
}

function readCookieUserId(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const cols = line.split('\t');
      if (cols.length >= 7 && cols[5] === 'twid') {
        let value = cols[6];
        try {
          value = decodeURIComponent(value);
        } catch {
          /* keep raw value */
        }
        const m = value.match(/(\d{10,25})/);
        if (m) return m[1];
      }
    }
  } catch {
    /* ignore */
  }
  return '';
}

function getDownloadAccountInfo() {
  const names = listDownloadAccounts();
  return names.map((name) => {
    const file = name
      ? path.join(path.dirname(paths.cookiesFile), `cookies_download_${name}.txt`)
      : paths.downloadCookiesFile;
    return { name, file, id: readCookieUserId(file) };
  });
}

function nextDownloadCookieFile() {
  if (!settings.useDownloadAccount) return paths.cookiesFile;
  const names = listDownloadAccounts();
  if (!names.length) {
    return fs.existsSync(paths.cookiesFile) ? paths.cookiesFile : '';
  }
  const name = names[accountIndex++ % names.length];
  const candidate = name
    ? path.join(path.dirname(paths.cookiesFile), `cookies_download_${name}.txt`)
    : paths.downloadCookiesFile;
  if (fs.existsSync(candidate)) return candidate;
  return fs.existsSync(paths.cookiesFile) ? paths.cookiesFile : '';
}

module.exports = { listDownloadAccounts, getDownloadAccountInfo, nextDownloadCookieFile };
