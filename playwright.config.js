// Screenshots and smoke checks for the front end at phone and desktop sizes.
// Default target is the local static server (e2e/serve.py, which needs data/ populated:
// `python pipeline/fetch_citypage.py --no-live` and `python pipeline/derive.py --offline`).
// Set BASE_URL=https://cabinradio.github.io/cabin-weather/ to run against the live feed instead.
const { defineConfig } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765/';

module.exports = defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.js/,
  timeout: 60000,
  retries: 0,
  reporter: 'list',
  use: { baseURL: BASE_URL },
  projects: [
    { name: 'mobile', use: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
  ],
  webServer: process.env.BASE_URL ? undefined : {
    command: 'python3 e2e/serve.py 8765',
    url: 'http://127.0.0.1:8765/',
    reuseExistingServer: true,
    timeout: 15000,
  },
});
