const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  mergeBatchFailures,
  savePersistentFailures,
  readPersistentFailures,
  readPersistentFailureKind,
} = require('../server/failures');

test('merges new failures and removes successes from existing records', () => {
  const merged = mergeBatchFailures(
    [
      { url: 'https://x.com/a/status/1', message: 'old' },
      { url: 'https://x.com/b/status/2', message: 'old b' },
    ],
    [{ url: 'https://x.com/a/status/1', message: 'new', attempts: 2, maxAttempts: 5 }],
    ['https://x.com/a/status/1', 'https://x.com/b/status/2']
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, 'https://x.com/a/status/1');
  assert.equal(merged[0].message, 'new');
  assert.equal(merged[0].attempts, 2);
});

test('persists and reloads failures with kind', (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xrd-fail-')), 'failures.json');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const failures = [{ url: 'https://x.com/c/status/3', message: 'err', attempts: 1, maxAttempts: 5 }];
  savePersistentFailures(file, failures, 'video');
  assert.equal(readPersistentFailureKind(file), 'video');
  assert.deepEqual(readPersistentFailures(file), failures);
});

test('caps persisted failures at the configured limit', () => {
  const many = Array.from({ length: 1200 }, (_, i) => ({
    url: `https://x.com/u/status/${i}`,
    message: 'x',
  }));
  const merged = mergeBatchFailures(many, [], []);
  assert.equal(merged.length, 1000);
});
