const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function readDailyBudget(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.date && Number.isFinite(data.count)) {
      return { date: data.date, count: data.count };
    }
  } catch {
    /* no budget file yet */
  }
  return { date: '', count: 0 };
}

function checkDailyScrollBudget(file, max) {
  const budget = readDailyBudget(file);
  const used = budget.date === todayKey() ? budget.count : 0;
  return { ok: used < max, used, max };
}

function consumeDailyScrollBudget(file, max, rounds = 1) {
  const key = todayKey();
  const budget = readDailyBudget(file);
  const count = budget.date === key ? budget.count + rounds : rounds;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ date: key, count }), 'utf8');
  } catch {
    /* ignore */
  }
  return count < max;
}

async function humanScroll(page, { fast = false } = {}) {
  if (fast) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(400 + Math.random() * 600);
    return;
  }

  const step = Math.floor(1600 + Math.random() * 2800);
  await page.evaluate((delta) => window.scrollBy(0, delta), step);
  await sleep(1500 + Math.random() * 1800);

  if (Math.random() < 0.15) {
    const back = Math.floor(300 + Math.random() * 600);
    await page.evaluate((delta) => window.scrollBy(0, delta), -back);
    await sleep(500 + Math.random() * 600);
  }

  if (Math.random() < 0.08) {
    await page.mouse.move(
      40 + Math.floor(Math.random() * 600),
      40 + Math.floor(Math.random() * 600)
    );
    await sleep(300 + Math.random() * 500);
  }
}

module.exports = {
  sleep,
  todayKey,
  checkDailyScrollBudget,
  consumeDailyScrollBudget,
  humanScroll,
};
