# Cabin Weather – architecture

## Two halves, decoupled

```
ECCC (Datamart XML, GeoMet-OGC-API JSON)
        │  scheduled GitHub Actions, Python
        ▼
  pipeline/*.py  ──►  data/*.json  (validated against pipeline/schemas/*.json)
                           │
                           ▼   GitHub Pages artifact = site/ + data/
                     weather.cabinradio.ca
                           │
                           ▼   <script src> via [cabin_weather] shortcode
                     cabinradio.ca/weather   (#cabin-weather div)
```

The front end only ever reads `data/current.json`, `data/forecast/{slug}.json` and `data/history/{slug}.json`. The data contracts are in `docs/implementation-plan.md` section 3 and, once written, `pipeline/schemas/`.

## Data sources (all ECCC, all free)

| Need | Source | Notes |
|---|---|---|
| Current conditions, 24-hour and 7-day forecast, normals for the day, sunrise/sunset, warnings | City Page Weather XML: `https://dd.weather.gc.ca/today/citypage_weather/NT/{HH}/` | UTC hour folders. Files are named `{timestamp}_MSC_CitypageWeather_{site_code}_en.xml`; take the newest per site, falling back one hour at a time up to six. `condition` and `iconCode` can be empty. |
| Site codes | `.../citypage_weather/docs/site_list_en.csv` | 30 NT rows; Ekati and Indin River are ignored. |
| Daily climate archive | GeoMet `climate-daily` | Filter by `CLIMATE_IDENTIFIER`; `datetime=start/end` range works; max 10,000 items, `offset` paging. The current day's row exists with all values `null` and must be ignored. `SPEED_MAX_GUST` is `null` whenever the day's peak gust was under 31 km/h, which is a known ECCC convention, not missing data. |
| Hourly (Yellowknife wind chill) | GeoMet `climate-hourly` | `WINDCHILL`, `TEMP`, `WIND_SPEED` per hour for 2204101. |
| Daily records | GeoMet `ltce-temperature`, `ltce-precipitation` | Keyed by `VIRTUAL_CLIMATE_ID` and month/day. Each row has record value and year, plus the previous record and the top five. `ltce-snowfall` exists too (Yellowknife only, if used). |
| Station metadata and threading | GeoMet `climate-stations`, `ltce-stations` | See below. |
| Fallback archive | `https://climate.weather.gc.ca/climate_data/bulk_data_e.html?format=csv&stationID={STN_ID}&Year={Y}&Month={M}&Day=1&timeframe=2` | Only if `climate-daily` returns nothing for a station. |

## Station threads (decided 2026-10-19)

ECCC's Long Term Climate Extremes (LTCE) product stitches stations into one "virtual station" per community. We follow those threads exactly, so our last-14-days values compare like for like with the published records. For the five regional centres the current station is the town's "Climate" station, not the airport "A" station; for Yellowknife it is Yellowknife A (2204101). Current conditions on the page still come from the airport, as ECCC's own City Page does.

| Community | LTCE id | Thread (oldest first) |
|---|---|---|
| Yellowknife | VSNT24V | 2204100 (1942-07-01 to 2013-01-16), 2204101 (2013-01-17 to present) |
| Inuvik | VSNT30V | 2202570 (1957-03-01 to 2003-07-31), 2202578 Inuvik Climate (2003-08-01 to present) |
| Norman Wells | VSNT21V | 2202800 (1943-05-01 to 2012-10-11), 2202810 Norman Wells Climate (2012-10-12 to present) |
| Fort Simpson | VSNT4VV | 2202100 (1895-11-01 to 1963-10-31), 2202101 (1963-11-01 to 2014-10-02), 2202102 Fort Simpson Climate (2014-10-03 to present) |
| Hay River | VSNT8VV | 2202398 (1893-09-01 to 1943-03-31), 2202400 (1943-04-01 to 2014-09-03), 2202402 Hay River Climate (2014-09-04 to present) |
| Fort Smith | VSNT17V | 2202196 (1913-07-01 to 1928-02-29), 2202198 (1928-03-01 to 1943-08-31), 2202200 (1943-09-01 to 2014-11-05), 2202202 Fort Smith Climate (2014-11-06 to present) |

Why not the airport "A" stations: the Inuvik A thread has a gap from 2013 to 2018, the newer "A" identifiers (2202403, 2202203, 2202104) overlap the older ones from 2018 with no clear cutover, and ECCC's records are computed on the Climate threads. `pipeline/discover_stations.py` fails if `stations.json` drifts from the LTCE threading.

The 20-year range period is 2006–2025 and the normal period 1991–2020; both are computed by `derive.py` from the committed archive, not taken from ECCC's published normals, so that every community uses the same method and the same thread.

## Pipeline

- `fetch_citypage.py` → `data/current.json` and `data/forecast/{slug}.json`, every 30 minutes.
- `fetch_climate.py` → `archive/{slug}.csv`, twice daily, re-pulling the last 10 days (ECCC back-fills and corrects).
- `fetch_ltce.py` → `archive/ltce/{slug}.json`.
- `derive.py` → `data/history/{slug}.json`.
- `validate.py` → schema checks; non-zero exit fails the job and the previous deploy stays up.
- `backfill.py` → one-off full archive pull.

Reliability rules (plan section 4) in one line each: start from the live file and only overwrite what was fetched; refuse to write if fewer than 20 of 28 communities are fresh; `stale: true` when an observation is more than three hours old; every HTTP call has a 20-second timeout and three retries; at most four concurrent requests per ECCC host; a Cabin Radio User-Agent on every request.

The "live file" is read from the GitHub Pages origin (`cabinradio.github.io/cabin-weather/...`) with a cache-busting query string, not through Cloudflare, so the comparison is always against the real latest deploy.

## Time

Everything presented is Mountain Time (`America/Yellowknife`). Timestamps are stored as ISO 8601 with offsets. The pipeline always converts from UTC with `zoneinfo`, never from ECCC's local strings, because ECCC's climate-hourly `LOCAL_DATE` is local *standard* time all year (UTC-7), while City Page local times follow the clock.

**Clock change, flagged 2026-10-19.** The IANA time-zone database (2026e, and the `tzdata` package pinned in `pipeline/requirements.txt`) says America/Edmonton and America/Yellowknife stop changing clocks after November 2026 and stay on UTC-6, labelled CST, from then on. The workflows set `PYTHONTZPATH=""` so CI uses the pinned package rather than whatever the runner has, and local runs on a current macOS agree. What the page should call the zone after that ("MT" per the Style Guide today) is a decision for Ollie; it is one label in the front-end formatter.

## ECCC quirks the code relies on

- `climate-daily` leaves `SPEED_MAX_GUST` null whenever the day's peak gust was under 31 km/h (the bulk CSV says `<31`); `climate_archive.num()` turns both into null. A null gust means "under 31", not "unknown".
- The current day's `climate-daily` row exists with every value null; rows with no measurements are dropped from the archive.
- LTCE records are updated daily and already include this year, so `derive.compare()` ignores entries from the current year when deciding whether a value is a record or top-three. A tie with the standing record counts as a record ("matching").
- Six NWT automatic stations report no condition text or icon (Aklavik, Fort Providence, Nahanni Butte, Sambaa K'e, Whatì, Wrigley): `condition` is null and `icon` is `na`; the page shows temperature only.
- Dettah's observations come from Yellowknife Airport, Enterprise's from Hay River's airport, Nahanni Butte's from Yohin Lake. The `station` field says so.
- ECCC spells some station names its own way (Łutselk'e, Whatı̀, Deline, Gameti, Wekweeti, Detah); `fetch_citypage.station_name()` maps them to Style Guide spellings. ECCC forecast prose says "minus 4" and "plus 1"; `house_prose()` makes that "-4" and "1" and changes nothing else.
- ECCC's seventh forecast day has a day period only, so its `low` and `night_text` are null.
- The `warnings` element carries `url`; each `event` has `type`, `priority`, `description` and `expiryTime` (ECCC tag table). None were active in the NWT on the day this was written, so the parser is covered by a test, not by a live file.

## Scheduling and deploy

- `refresh-current.yml`: `7,37 * * * *`. It was `*/30` until 2026-10-21; in the first 42 hours GitHub ran only 10 of the expected 84 scheduled runs (one every three to five hours). GitHub's documentation says schedules queued at the top of the hour are the most delayed, so the minutes were moved off :00 and :30. If runs are still sparse after that, the fallback is a `workflow_dispatch` poke from an external scheduler, which is outside this repo and Ollie's call.
- `refresh-climate.yml`: `10 9,15 * * *` (after ECCC's overnight archive update). Commits archive and history changes to `main` first, which also keeps the repo active so GitHub never disables the scheduled workflows (public repos lose schedules after 60 days without a commit).
- `deploy.yml`: reusable (`workflow_call`); checks out the tip of `main`, runs `fetch_citypage.py` then `validate.py`, assembles `_site/` from `site/` plus `data/`, and deploys with `actions/deploy-pages`. The `pages` concurrency group is declared only in the two calling workflows: declaring it inside the called job as well deadlocks the run (learned on the first deploy).
- `refresh-current.yml` also runs on every push to `main`, so site changes deploy at once. Commits made by the climate workflow use `GITHUB_TOKEN`, which never triggers other workflows, so there is no loop.
- `ci.yml`: `pytest` plus an offline end-to-end (fetch, derive, validate) on pull requests and on pipeline changes pushed to `main`. Playwright screenshots arrive with the front end.

## Hosting

Public repo `cabinradio/cabin-weather` (a personal account, not an organization). GitHub Pages is enabled with Actions as the source (`build_type: workflow`); the `github-pages` environment allows deployments from `main` only. Custom domain `weather.cabinradio.ca` to come: a CNAME in Cloudflare to `cabinradio.github.io`, DNS-only until GitHub issues the certificate, then proxied. Ollie owns DNS. Until the CNAME exists, test on `https://cabinradio.github.io/cabin-weather/`, which is also where `fetch_citypage.py` reads the live files (`CABIN_WEATHER_LIVE_BASE` overrides it).

## Embedding

The `[cabin_weather]` shortcode in `cabin-radio-patches.php` outputs `<div id="cabin-weather"></div>` and enqueues `app.css` and `app.js` from `weather.cabinradio.ca` on that page only. cabinradio.ca already loads Domine and Lora, so the app loads Google Fonts only when it is at the top of its own window. Fallback if WordPress.com blocks the enqueue: an iframe with postMessage height sync, documented in `wordpress/`.
