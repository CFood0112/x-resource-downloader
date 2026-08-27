const fs = require('fs');

function loadQueue(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rawQueue = Array.isArray(data) ? data : data.queue;
    if (!Array.isArray(rawQueue)) return { queue: [], paused: false };
    const queue = rawQueue
      .filter((q) => q && typeof q.mode === 'string')
      .map((q) => ({
        id: q.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mode: q.mode,
        body: q.body || {},
      }));
    const paused = !Array.isArray(data) && typeof data.paused === 'boolean' ? data.paused : false;
    return { queue, paused };
  } catch {
    return { queue: [], paused: false };
  }
}

function persistQueue(file, queue, paused) {
  try {
    fs.writeFileSync(file, JSON.stringify({ paused, queue }, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function nextQueueId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { loadQueue, persistQueue, nextQueueId };
