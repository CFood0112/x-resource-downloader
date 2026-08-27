const state = require('./appState');
const { paths } = require('./config');
const { removeLock } = require('./process');

function cancelAutoShutdown() {
  if (state.shutdownTimer) {
    clearTimeout(state.shutdownTimer);
    state.shutdownTimer = null;
  }
}

function scheduleAutoShutdown() {
  if (!state.hasEverHadClient || (state.job && state.job.state.running)) return;
  if (state.shutdownTimer) return;
  if (!state.guiCloseRequested && state.clients.size > 0) return;
  state.shutdownTimer = setTimeout(() => {
    console.log('GUI closed, shutting down server');
    removeLock(paths.lockFile);
    process.exit(0);
  }, 8000);
}

function sweepClients() {
  for (const res of state.clients) {
    try {
      res.write(': ping\n\n');
    } catch {
      state.clients.delete(res);
    }
  }
  if (!state.hasEverHadClient || (state.job && state.job.state.running) || state.shutdownTimer) {
    return;
  }
  if (state.clients.size === 0) {
    state.shutdownTimer = setTimeout(() => {
      console.log('GUI closed, shutting down server');
      removeLock(paths.lockFile);
      process.exit(0);
    }, 8000);
  }
}

module.exports = { cancelAutoShutdown, scheduleAutoShutdown, sweepClients };
