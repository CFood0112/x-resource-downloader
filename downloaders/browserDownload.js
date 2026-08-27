const fs = require('fs');

async function downloadWithBrowser(context, item, outFile) {
  const page = await context.newPage();
  try {
    await page.goto(item.url, { waitUntil: 'load', timeout: 60000 });
    const bytes = await page.evaluate(async () => {
      const res = await fetch(window.location.href, { credentials: 'include' });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const buf = await res.arrayBuffer();
      return Array.from(new Uint8Array(buf));
    });
    fs.writeFileSync(outFile, Buffer.from(bytes));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    page.close().catch(() => {});
  }
}

module.exports = { downloadWithBrowser };
