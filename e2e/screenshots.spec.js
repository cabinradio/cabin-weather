// Renders Yellowknife end to end, checks the house-style sweep and console cleanliness,
// and writes full-page screenshots to e2e/screenshots/ (git-ignored; CI uploads them as an artifact).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

// Words and marks the house style never allows in anything a reader sees.
const BANNED = [/—/, /[°℃]/, /−/, /\b(today|yesterday|tomorrow)\b/i, /\bNT\b/, /%/, /!/, /\bokay\b/i, /\bunderway\b/i, /\bminus\s+\d/i];

function watchConsole(page) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  return errors;
}

async function settled(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

test('Yellowknife renders end to end with no console errors', async ({ page }, testInfo) => {
  const errors = watchConsole(page);
  await page.goto('#yellowknife');
  const app = page.locator('#cabin-weather');
  await expect(app.locator('.cw-name')).toHaveText('Yellowknife');
  await expect(app.locator('.cw-big')).toBeVisible();
  await expect(app.locator('.cw-hour').first()).toBeVisible();
  expect(await app.locator('.cw-week li').count()).toBeGreaterThan(0);
  await expect(app.locator('.cw-chart').first()).toBeVisible();
  await expect(app.locator('.cw-foot')).toContainText('Environment and Climate Change Canada');
  await settled(page);

  // Every glyph in use must resolve to a symbol in the sprite.
  const broken = await page.evaluate(() => {
    const ids = new Set(Array.from(document.querySelectorAll('#cabin-weather .cw-sprite [id]')).map(s => s.id));
    return Array.from(document.querySelectorAll('#cabin-weather use')).map(u => u.getAttribute('href').slice(1)).filter(id => !ids.has(id));
  });
  expect(broken).toEqual([]);

  const text = await app.innerText();
  for (const re of BANNED) expect(text, `house style: ${re}`).not.toMatch(re);

  // Tapping the chart shows that day's numbers.
  const chart = app.locator('.cw-chart').first();
  const box = await chart.boundingBox();
  await chart.click({ position: { x: box.width * 0.6, y: box.height * 0.5 } });
  await expect(app.locator('.cw-detail')).toContainText(/high|low|no observation/);
  await chart.press('ArrowRight');
  await expect(app.locator('.cw-detail')).not.toContainText('Select a day');
  await chart.evaluate(node => node.blur());

  await page.screenshot({ path: path.join(OUT, `yellowknife-${testInfo.project.name}.png`), fullPage: true });
  expect(errors).toEqual([]);
});

test('a failed current.json leaves a calm sentence, not a blank', async ({ page }, testInfo) => {
  await page.route('**/data/current.json*', route => route.fulfill({ status: 500, body: 'error' }));
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto('./');
  const app = page.locator('#cabin-weather');
  await expect(app.locator('.cw-notice')).toContainText('Live weather is temporarily unavailable');
  await expect(app.locator('.cw-name')).toHaveText('Yellowknife');
  await settled(page);
  await page.screenshot({ path: path.join(OUT, `unavailable-${testInfo.project.name}.png`), fullPage: true });
  expect(pageErrors).toEqual([]);
});

test('the community picker navigates by hash and the hash drives the page', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('./');
  const app = page.locator('#cabin-weather');
  await expect(app.locator('.cw-name')).toHaveText('Yellowknife');
  await app.locator('select').selectOption('inuvik');
  await expect(app.locator('.cw-name')).toHaveText('Inuvik');
  expect(page.url()).toMatch(/#inuvik$/);
  await page.goto('#fort-smith');
  await expect(app.locator('.cw-name')).toHaveText('Fort Smith');
  await settled(page);
  expect(errors).toEqual([]);
});
