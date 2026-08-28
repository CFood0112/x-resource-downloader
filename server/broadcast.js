const fs = require('fs');
const state = require('./appState');
const { config, settings, paths } = require('./config');
const { listDownloadAccounts, getDownloadAccountInfo } = require('./accounts');

function baseState() {
  return {
    running: false,
    status: 'idle',
    kind: '',
    taskId: '',
    source: '',
    currentMediaId: '',
    message: '',
    currentFile: '',
    currentIndex: 0,
    fileCount: 0,
    totalLinks: 0,
    percent: 0,
    speed: '',
    eta: '',
    elapsed: 0,
    progressLine: '',
    logs: [],
    logEntries: [],
    failures: [],
  };
}

function publicState() {
  const s = state.job ? state.job.state : baseState();
  const accountInfo = getDownloadAccountInfo();
  return {
    state: s,
    lastFailures: state.lastFailures,
    lastFailuresKind: state.lastFailuresKind,
    queueLength: state.queue.length,
    queuePaused: state.queuePaused,
    settings,
    config: {
      username: config.username || '',
      downloadDir:
        (settings.video && settings.video.downloadDir) || config.downloadDir || 'videos',
      downloadAccountReady: listDownloadAccounts().length > 0,
      downloadCookiesFile: require('path').basename(paths.downloadCookiesFile),
      mainAccountReady: fs.existsSync(paths.cookiesFile),
      downloadAccounts: accountInfo.map((a) => a.name),
      downloadAccountIds: Object.fromEntries(accountInfo.map((a) => [a.name, a.id])),
    },
  };
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of state.clients) {
    try {
      res.write(data);
    } catch {
      state.clients.delete(res);
    }
  }
}

function pushState(force = false) {
  if (!state.job) return;
  const now = Date.now();
  if (!force && now - state.lastPushAt < 300) return;
  state.lastPushAt = now;
  broadcast({ type: 'state', ...publicState() });
}

module.exports = { baseState, publicState, broadcast, pushState };
