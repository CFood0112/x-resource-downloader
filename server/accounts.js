const fs = require('fs');
const path = require('path');
const { settings, paths } = require('./config');

let accountIndex = 0;

function listDownloadAccounts() {
  const names = [];
  try {
    const cookiesBase = path.dirname(paths.cookiesFile);
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

function nextDownloadCookieFile() {
  if (!settings.useDownloadAccount) return paths.cookiesFile;
  const names = listDownloadAccounts();
  if (!names.length) return paths.cookiesFile;
  const name = names[accountIndex++ % names.length];
  return name
    ? path.join(path.dirname(paths.cookiesFile), `cookies_download_${name}.txt`)
    : paths.downloadCookiesFile;
}

module.exports = { listDownloadAccounts, nextDownloadCookieFile };
