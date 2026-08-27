function classifyError(msg = '') {
  const m = String(msg);
  if (/timeout|timed out|IncompleteRead|SSL|EOF|fetch failed|connect/i.test(m)) return '网络';
  if (/no video|not found|404|deleted|unavailable|410/i.test(m)) return '内容不可用';
  if (/login|authoriz|authentication|401|403/i.test(m)) return '认证/权限';
  return '其他';
}

module.exports = { classifyError };
