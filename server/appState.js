const state = {
  job: null,
  jobTimer: null,
  clients: new Set(),
  lastPushAt: 0,
  hasEverHadClient: false,
  shutdownTimer: null,
  guiCloseRequested: false,
  lastFailures: [],
  lastFailuresKind: '',
  queue: [],
  queuePaused: false,
};

module.exports = state;
