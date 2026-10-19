# Cabin Weather – guide for Claude sessions

Read this first, then `ARCHITECTURE.md`, then `docs/implementation-plan.md` (the agreed spec; do not relitigate its section 1 decisions).

## What this is

A static weather app for 28 NWT communities, built from ECCC open data by a scheduled GitHub Actions pipeline, served from GitHub Pages at `weather.cabinradio.ca`, and embedded on cabinradio.ca/weather with a `[cabin_weather]` shortcode. Owner: Ollie at Cabin Radio. Zero running cost is a design constraint.

## Key files

- `pipeline/config/communities.json` – the 28 communities: slug, Style Guide spelling, ECCC site code, region, tier.
- `pipeline/config/stations.json` – climate station threads for the six history communities, following ECCC's LTCE threading. Change these only with a reason written down in `ARCHITECTURE.md`.
- `pipeline/discover_stations.py` – Phase 0 check. Run it whenever the config changes.
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
.venv/bin/python pipeline/discover_stations.py           # check config against live ECCC data
.venv/bin/pytest pipeline/tests                          # tests
```

Local Python is 3.14; CI pins 3.12. Write code that runs on both (no 3.13+ only features).

## Status

- 2026-10-19: Phase 0 (discovery) done. Config files written and verified against live ECCC data. Repo created.
- Next: Phase 1, the pipeline (backfill, incremental update, LTCE, derive, validate, workflows).

Keep this section and `ARCHITECTURE.md` current as phases land.
