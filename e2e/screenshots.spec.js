// Renders the routes end to end, checks the house-style sweep, console cleanliness and the Phase 3
// acceptance list (every route, keyboard, no horizontal scroll at 375 px), and writes full-page
// screenshots to e2e/screenshots/ (git-ignored; CI uploads them as an artifact).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const SLUGS = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'current.json'), 'utf8')).communities);

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
async function styleSweep(app) {
  const text = await app.innerText();
  for (const re of BANNED) expect(text, `house style: ${re}`).not.toMatch(re);
}
const visibleSections = app => app.locator('.cw-sec:not([hidden])');

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
  // The styling agreed on 2026-10-23: a glyph beside the big temperature, shaded night hours, a blue low line.
  await expect(app.locator('.cw-now .cw-glyph')).toHaveCount(1);
  expect(await app.locator('.cw-hour.cw-night').count()).toBeGreaterThan(0);
  await expect(app.locator('.cw-chart .cw-line.cw-low')).toHaveCount(1);
  // The wind chill chart appears only when the history file carries hourly wind chill; CI builds that
  // file with derive.py --offline, which skips the hourly fetch, so follow the data rather than assume.
  const history = await (await page.request.get('data/history/yellowknife.json')).json();
  const hasWindChill = (history.plus.windchill_hourly || []).some(p => p.wind_chill != null);
  if (hasWindChill) await expect(app).toContainText('Hourly wind chill'); else await expect(app).not.toContainText('Hourly wind chill');
  await settled(page);

  // Every glyph in use must resolve to a shape in the sprite.
  const broken = await page.evaluate(() => {
    const ids = new Set(Array.from(document.querySelectorAll('#cabin-weather .cw-sprite [id]')).map(s => s.id));
    return Array.from(document.querySelectorAll('#cabin-weather use')).map(u => u.getAttribute('href').slice(1)).filter(id => !ids.has(id));
  });
  expect(broken).toEqual([]);
  await styleSweep(app);

  // Tapping the chart shows that day's numbers; the arrow keys step through days.
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

test('a forecast-tier community shows Now, the hours, the week and the footer only', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('#nahanni-butte');
  const app = page.locator('#cabin-weather');
  await expect(app.locator('.cw-name')).toHaveText('Nahanni Butte');
  await expect(app.locator('.cw-big')).toBeVisible();
  await expect(app.locator('.cw-week li').first()).toBeVisible();
  await expect(visibleSections(app)).toHaveCount(3);
  expect(await app.locator('.cw-chart').count()).toBe(0);
  await expect(app.locator('.cw-foot')).toContainText('Observations from Yohin Lake');
  await styleSweep(app);
  expect(errors).toEqual([]);
});

test('a comparison-tier community has the history sections without the Yellowknife extras', async ({ page }, testInfo) => {
  const errors = watchConsole(page);
  await page.goto('#inuvik');
  const app = page.locator('#cabin-weather');
  await expect(app.locator('.cw-name')).toHaveText('Inuvik');
  await expect(app.locator('.cw-chart').first()).toBeVisible();
  await expect(app.locator('.cw-week li').first()).toBeVisible();
  await expect(visibleSections(app)).toHaveCount(6);
  await expect(app).not.toContainText('Hourly wind chill');
  await expect(app).not.toContainText('-30C night');
  await expect(app).toContainText('Records');
  await expect(app.locator('.cw-foot')).toContainText('Inuvik Climate');
  await settled(page);
  await styleSweep(app);
  await page.screenshot({ path: path.join(OUT, `inuvik-${testInfo.project.name}.png`), fullPage: true });
  expect(errors).toEqual([]);
});

test('all communities now: 28 rows grouped by region, names lead to the community', async ({ page }, testInfo) => {
  const errors = watchConsole(page);
  await page.goto('#all-now');
  const app = page.locator('#cabin-weather');
  await expect(app.locator('.cw-name')).toHaveText('All communities now');
  await expect(app.locator('.cw-all-now .cw-cname a')).toHaveCount(28);
  await expect(app.locator('.cw-all-now .cw-region')).toHaveCount(6);
  await expect(app.locator('.cw-all-now .cw-region').first()).toHaveText('North Slave');
  await expect(visibleSections(app)).toHaveCount(1);
  await expect(app.locator('.cw-foot')).toContainText('Updated');
  await settled(page);
  await styleSweep(app);
  await page.screenshot({ path: path.join(OUT, `all-now-${testInfo.project.name}.png`), fullPage: true });
  await app.locator('.cw-all-now .cw-cname a', { hasText: 'Fort Smith' }).click();
  await expect(app.locator('.cw-name')).toHaveText('Fort Smith');
  expect(page.url()).toMatch(/#fort-smith$/);
  expect(errors).toEqual([]);
});

test('next 24 hours, all communities: eight temperatures and a sparkline per row', async ({ page }, testInfo) => {
  const errors = watchConsole(page);
  await page.goto('#all-24h');
  const app = page.locator('#cabin-weather');
  await expect(app.locator('.cw-name')).toHaveText('Next 24 hours, all communities');
  await expect(app.locator('.cw-all-24 .cw-cname a')).toHaveCount(28);
  await expect(app.locator('.cw-spark')).toHaveCount(28);
  await expect(app.locator('thead .cw-t8').first()).not.toBeEmpty();
  expect(await app.locator('tbody .cw-t8:not(:empty)').count()).toBe(28 * 8);
  await settled(page);
  await styleSweep(app);
  await page.screenshot({ path: path.join(OUT, `all-24h-${testInfo.project.name}.png`), fullPage: true });
  expect(errors).toEqual([]);
});

test('the overview links and the picker work from the keyboard', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('./');
  const app = page.locator('#cabin-weather');
  await expect(app.locator('.cw-name')).toHaveText('Yellowknife');
  await app.locator('.cw-links a').nth(1).focus();
  await page.keyboard.press('Enter');
  await expect(app.locator('.cw-name')).toHaveText('Next 24 hours, all communities');
  await app.locator('.cw-links a').nth(0).focus();
  await page.keyboard.press('Enter');
  await expect(app.locator('.cw-name')).toHaveText('All communities now');
  await app.locator('select').selectOption('inuvik');
  await expect(app.locator('.cw-name')).toHaveText('Inuvik');
  expect(page.url()).toMatch(/#inuvik$/);
  await page.goto('#fort-smith');
  await expect(app.locator('.cw-name')).toHaveText('Fort Smith');
  await settled(page);
  expect(errors).toEqual([]);
});

test('every route renders without console errors', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('./');
  const app = page.locator('#cabin-weather');
  for (const slug of SLUGS.concat(['all-now', 'all-24h'])) {
    await page.goto('#' + slug);
    await expect(app.locator('.cw-foot')).toBeVisible();
    await expect(app.locator('.cw-name')).not.toBeEmpty();
  }
  await expect(app.locator('.cw-spark')).toHaveCount(28);
  expect(errors).toEqual([]);
});

test('no route needs a horizontal scroll', async ({ page }) => {
  for (const route of ['#yellowknife', '#inuvik', '#all-now', '#all-24h']) {
    await page.goto(route);
    const app = page.locator('#cabin-weather');
    await expect(app.locator('.cw-foot')).toBeVisible();
    if (route === '#all-24h') await expect(app.locator('.cw-spark')).toHaveCount(28);
    await settled(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, route).toBeLessThanOrEqual(0);
  }
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
