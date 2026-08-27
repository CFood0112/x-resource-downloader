const fs = require('fs');

const LIMIT = 1000;

function readPersistentFailures(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data)) return data.slice(0, LIMIT);
    if (Array.isArray(data.failures)) return data.failures.slice(0, LIMIT);
  } catch {
    /* ignore */
  }
  return [];
}

function readPersistentFailureKind(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data.kind === 'string') return data.kind;
  } catch {
    /* ignore */
  }
  return '';
}

function savePersistentFailures(file, failures, kind) {
  try {
    const capped = Array.isArray(failures) ? failures.slice(0, LIMIT) : [];
    fs.writeFileSync(
      file,
      JSON.stringify({ kind, updatedAt: new Date().toISOString(), failures: capped }, null, 2),
      'utf8'
    );
  } catch {
    /* ignore */
  }
}

function mergeBatchFailures(existing, finalFailures, batchUrls, limit = LIMIT) {
  const existingMap = new Map(
    (Array.isArray(existing) ? existing : []).map((f) => [f.url || '(未知链接)', f])
  );
  const finalMap = new Map(
    (Array.isArray(finalFailures) ? finalFailures : []).map((f) => [f.url || '(未知链接)', f])
  );
  for (const url of batchUrls || []) {
    const key = url || '(未知链接)';
    if (finalMap.has(key)) existingMap.set(key, finalMap.get(key));
    else existingMap.delete(key);
  }
  return [...existingMap.values()]
    .sort((a, b) => String(a.url || '').localeCompare(String(b.url || '')))
    .slice(0, limit);
}

module.exports = {
  LIMIT,
  readPersistentFailures,
  readPersistentFailureKind,
  savePersistentFailures,
  mergeBatchFailures,
};
