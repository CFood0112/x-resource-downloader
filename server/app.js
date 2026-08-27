const fs = require('fs');
const state = require('./appState');
const { settings, paths } = require('./config');
const { loadQueue } = require('./queue');
const { readPersistentFailures, readPersistentFailureKind } = require('./failures');
const { startJob, startNextQueued } = require('./jobs');
const { startServer } = require('./http');
const {
  tryAcquireLock,
  removeLock,
  showAlreadyRunning,
} = require('./process');
const { sweepClients } = require('./shutdown');

fs.mkdirSync(paths.listsDir, { recursive: true });
fs.mkdirSync(paths.runDir, { recursive: true });
fs.mkdirSync(paths.logDir, { recursive: true });
fs.mkdirSync(paths.jobsDir, { recursive: true });
fs.mkdirSync(paths.downloadDir, { recursive: true });
fs.mkdirSync(paths.imageDir, { recursive: true });

const savedQueue = loadQueue(paths.queueFile);
state.queue = savedQueue.queue;
state.queuePaused = savedQueue.paused;
state.lastFailures = readPersistentFailures(paths.failuresFile);
state.lastFailuresKind = readPersistentFailureKind(paths.failuresFile);

const lock = tryAcquireLock(paths.lockFile);
if (!lock.acquired) {
  showAlreadyRunning(paths.runDir, lock.port);
  process.exit(0);
}

process.on('exit', () => removeLock(paths.lockFile));
process.on('SIGINT', () => {
  removeLock(paths.lockFile);
  process.exit(0);
});
process.on('SIGTERM', () => {
  removeLock(paths.lockFile);
  process.exit(0);
});

startServer(Number(process.env.GUI_PORT) || 8765);
setInterval(sweepClients, 10000);

if (!state.queuePaused && state.queue.length) {
  setTimeout(startNextQueued, 800);
}

let lastScheduleMinute = '';
setInterval(() => {
  const now = new Date();
  const key = `${now.getHours()}:${now.getMinutes()}`;
  if (key === lastScheduleMinute) return;
  lastScheduleMinute = key;
  for (const s of settings.schedules || []) {
    if (!s.enabled) continue;
    if (Number(s.hour) === now.getHours() && Number(s.minute) === now.getMinutes()) {
      const body = {
        count: Number(s.count) || 50,
        source: s.source || 'likes',
        extra: s.extra || '',
      };
      startJob(s.mode || '50', body);
    }
  }
}, 30000);
