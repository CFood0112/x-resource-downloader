const test = require('node:test');
const assert = require('node:assert/strict');
const { inferLogLevel } = require('../server/errors');

test('infers error level for failure and exception lines', () => {
  assert.equal(inferLogLevel('[error] 采集失败，退出码 1'), 'error');
  assert.equal(inferLogLevel('[collect] 失败：ENOENT no such file'), 'error');
  assert.equal(inferLogLevel('FileNotFoundError: No such file'), 'error');
  assert.equal(inferLogLevel('Traceback (most recent call last):'), 'error');
  assert.equal(inferLogLevel('[download] Destination: x.mp4'), 'info');
});
