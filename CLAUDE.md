# Cabin Weather – guide for Claude sessions

Read this first, then `ARCHITECTURE.md`, then `docs/implementation-plan.md` (the agreed spec; do not relitigate its section 1 decisions).

## What this is

A static weather app for 28 NWT communities, built from ECCC open data by a scheduled GitHub Actions pipeline, served from GitHub Pages at `weather.cabinradio.ca`, and embedded on cabinradio.ca/weather with a `[cabin_weather]` shortcode. Owner: Ollie at Cabin Radio. Zero running cost is a design constraint.

## Key files

- `pipeline/config/communities.json` – the 28 communities: slug, Style Guide spelling, ECCC site code, region, tier.
- `pipeline/config/stations.json` – climate station threads for the six history communities, following ECCC's LTCE threading. Change these only with a reason written down in `ARCHITECTURE.md`.
- `pipeline/discover_stations.py` – Phase 0 check. Run it whenever the config changes.
- `pipeline/eccc_http.py` – the only place that talks HTTP: timeout, retries, User-Agent, four-per-host cap.
- `pipeline/formatters.py` – house style for generated text, with `style_problems()` used by the tests.
- `pipeline/climate_archive.py`, `backfill.py`, `fetch_climate.py` – the committed daily archive and how it is filled.
- `pipeline/fetch_ltce.py` – daily records from ECCC's LTCE collections into `archive/ltce/`.
- `pipeline/derive.py` – archive + LTCE -> `data/history/{slug}.json`.
- `pipeline/fetch_citypage.py`, `icons.py` – City Page XML -> `data/current.json` and `data/forecast/`.
- `pipeline/validate.py`, `pipeline/schemas/` – the data contracts; run before every deploy.
- `.github/workflows/` – `refresh-current` (at :07 and :37, and on push to main), `refresh-climate` (09:10 and 15:10 UTC, commits to main), `deploy` (reusable), `ci` (pytest, formatter tests, Playwright screenshots).
- `site/` – the front end: `index.html` (standalone shell), `app.js` (formatter, generated text, charts, rendering; under 40 KB), `app.css` (scoped under `#cabin-weather`), `icons.svg` (the `cw-` glyph sprite). See ARCHITECTURE.md, Front end.
- `e2e/` – front-end checks: `formatter.test.js` (house style, `npm test`), `screenshots.spec.js` (Playwright, 375x812 and 1280x900), `serve.py` (local static server), `fixtures/` (frozen live JSON).
- `docs/implementation-plan.md` – the spec: data contracts, pipeline rules, front-end rules, look and feel, house style, phases.
- `wordpress/cabin-weather-shortcode.php` – the snippet for `cabin-radio-patches.php`. That plugin lives in Ollie's local theme copy at `~/Documents/Cabin Radio/Website/Jan Feb 2026 alterations/Theme/`, not in this repo, and Ollie deploys it.

## Critical rules

1. **Never publish a worse file than the one live.** Every fetcher starts from the live JSON, overwrites only what it fetched successfully, and refuses to write if too little is fresh. `validate.py` must pass before deploy.
2. **Never call ECCC from the browser.** Only the pipeline talks to ECCC, with a 20-second timeout, three retries, a Cabin Radio User-Agent, and at most four concurrent requests per host.
3. **No frameworks, no chart libraries, no CDN scripts, no analytics.** Vanilla HTML, CSS and JS; hand-drawn inline SVG charts; Google Fonts is the only external resource.
4. **House style is enforced in code** (`formatters.py` and the front-end formatter, with tests): `-20C` not `−20°C`, `25 km/h`, `October 5`, `4pm`, never "today" or "tomorrow", en dashes only, `NWT` never `NT`, community names exactly as in `communities.json`.
5. **Do not invent data.** Communities without an ECCC site are not shown. Missing values are `null`, never 0. Snowfall and snow on ground appear only for Yellowknife.
6. **Branch and deploy discipline.** Until the site is live, work on `main`. Once Phase 5 starts, work on a branch and open a pull request; `main` deploys automatically. Never use `--force`, never bare `firebase deploy` style commands, never delete archive data without a dry run and Ollie's confirmation.
7. **Checkpoint before big changes**: `git commit -m "checkpoint: before ..."`.
8. **Ask Ollie** when a fix did not work and you are about to try a second approach, when scope grows, or when something outside this repo (DNS, WordPress, Cloudflare) needs changing. Ollie does DNS and WordPress deploys himself.

## Common tasks

```bash
.venv/bin/pip install -r pipeline/requirements-dev.txt   # once
.venv/bin/pytest                                         # tests (57 at the end of Phase 2)
.venv/bin/python pipeline/discover_stations.py           # check config against live ECCC data
.venv/bin/python pipeline/fetch_citypage.py --no-live    # current + forecasts into data/ without touching the live file
.venv/bin/python pipeline/fetch_climate.py               # last 10 days into archive/*.csv
.venv/bin/python pipeline/fetch_ltce.py                  # records into archive/ltce/
.venv/bin/python pipeline/derive.py [--offline]          # data/history/*.json (offline skips the hourly wind chill fetch)
.venv/bin/python pipeline/validate.py                    # every file under data/ against pipeline/schemas/
gh run list --limit 5                                    # what Actions has been doing
python3 e2e/serve.py 8765                                # preview the site at http://127.0.0.1:8765/ (or the app's Preview button)
npm test                                                 # front-end formatter tests (needs `npm install` once)
npx playwright test                                      # screenshots and smoke checks into e2e/screenshots/
BASE_URL=https://cabinradio.github.io/cabin-weather/ npx playwright test   # the same against the live site
```

`data/current.json` and `data/forecast/` are built at deploy time and git-ignored; `data/history/` and `archive/` are committed by the climate workflow.

Local Python is 3.14; CI pins 3.12. Write code that runs on both (no 3.13+ only features).

## Status

- 2026-10-19: Phase 0 (discovery) done. Config files written and verified against live ECCC data. Repo created.
- 2026-10-19: Phase 1 (pipeline) built: archive backfilled, LTCE fetched, derive/validate/fetch_citypage working locally with 54 tests; workflows pushed; Pages enabled at https://cabinradio.github.io/cabin-weather/. Phase 1 acceptance (24 hours of clean 30-minute runs) runs from here.
- Open with Ollie: the time-zone change (see ARCHITECTURE.md, Time), the User-Agent contact address, a licence file, the three project docs for `docs/`, and whether Łútsël K'é belongs under South Slave.
- 2026-10-21: Phase 1 soak passed: no failed runs in the 24 hours from 16:47 UTC on 2026-10-19, live `current.json` fresh with no stale flags. But GitHub ran only 10 of the expected 84 scheduled refreshes (every three to five hours), so the cron moved from `*/30` to `7,37`; see ARCHITECTURE.md, Scheduling. Watch whether the gaps close.
- 2026-10-21: Phase 2 built: the Yellowknife page end to end (Now, Next 24 hours, This week, The past two weeks with the temperature, precipitation, gust and hourly wind chill charts, This month and this season, Records, Footer), a front-end formatter with 20 house-style tests, Playwright screenshots and a CI job, `.claude/launch.json` for previews. Lighthouse mobile against the local server: performance 97, accessibility 100, best practices 100, SEO 100; no console errors. Open for Ollie: the contrast trade-off (links black with an orange underline, small text `#444`, see ARCHITECTURE.md, Front end, Contrast).
- Next: Phase 3, every community and the two overview views (the renderer already takes any slug; the overview tables and their two links are what remain).

Keep this section and `ARCHITECTURE.md` current as phases land.
