# Cabin Radio weather page – implementation plan

A plan for Claude Code. Read it all before starting. Phases are ordered so that each one leaves something working and deployable; do not start a later phase until the earlier one's acceptance checks pass.

## 0. What we are building, in one paragraph

A single static web app, "Cabin Weather", built from Environment and Climate Change Canada (ECCC) open data, served from GitHub Pages for free and embedded on cabinradio.ca/weather. Default view is Yellowknife. A reader can pick any of 28 NWT communities and the page flips to that community's current conditions, then its forecast, then (for six communities) its recent weather against the historical record. Two further views show every community's current weather and every community's next 24 hours. A scheduled GitHub Actions job refreshes the data; the browser never talks to ECCC directly. No servers, no databases, no paid services, no third-party JavaScript.

## 1. Decisions already made (do not relitigate)

**Hosting and cost.** Public GitHub repository (the data is open, so the code can be too; public repos get unlimited Actions minutes). GitHub Actions does all fetching and processing on a schedule. GitHub Pages serves the app and its JSON. Custom subdomain `weather.cabinradio.ca` (CNAME to GitHub Pages; Cloudflare already fronts cabinradio.ca, so proxy and cache it there). Total running cost: zero.

**Architecture.** Two halves, deliberately decoupled: a Python data pipeline that writes plain JSON files, and a vanilla HTML/CSS/JS front end that reads them. No framework, no bundler, no build step for the front end. Charts are hand-drawn inline SVG (small, fast, fully under our styling control, and they will match the Flourish look Cabin already uses). The only external resource the browser loads is Google Fonts (Lora and Domine, with Georgia as fallback).

**Embedding.** Primary: a shortcode `[cabin_weather]` registered in the existing must-use plugin `cabin-radio-patches.php`, which outputs `<div id="cabin-weather"></div>` and enqueues `https://weather.cabinradio.ca/app.css` and `app.js` on that page only. This keeps the weather page on cabinradio.ca, inherits the site's fonts, avoids iframe height problems and keeps community selection in the URL hash so links can be shared. Fallback (if WordPress.com blocks the enqueue): an iframe to `https://weather.cabinradio.ca/` with a postMessage height sync. Build the app so it works both ways: when it finds itself at the top of its own window it renders a minimal page header; when it finds itself inside `#cabin-weather` on cabinradio.ca it renders none. Ollie keeps a local copy of the theme files at `/Users/ollie/Documents/Cabin Radio/Website`; the shortcode change goes there and he deploys it.

**Scope.** Three tiers of community:

| Tier | Communities | Shows |
|---|---|---|
| Forecast (all 28) | Aklavik, Colville Lake, Délı̨nę, Dettah, Enterprise, Fort Good Hope, Fort Liard, Fort McPherson, Fort Providence, Fort Resolution, Fort Simpson, Fort Smith, Gamètì, Hay River, Inuvik, Łútsël K'é, Nahanni Butte, Norman Wells, Paulatuk, Sachs Harbour, Sambaa K'e, Tuktoyaktuk, Tulita, Ulukhaktok, Wekweètì, Whatì, Wrigley, Yellowknife | Current conditions, next 24 hours, 7-day forecast, sunrise/sunset, warnings |
| Comparison (5 regional centres) | Inuvik, Norman Wells, Fort Simpson, Hay River, Fort Smith | All of the above plus: last 14 days of temperature, precipitation and wind against the 1991–2020 normal and the 20-year range; daily records for those dates; records for the month and all time. **No snowfall or snow-on-ground in this tier.** |
| Standard plus (Yellowknife) | Yellowknife | All of the above plus: hourly wind chill for the last 14 days; "month so far" and "season so far" rankings against the full record since 1942; days since the last -30C night, first frost / first -10C / first snow dates for the current autumn-winter; snowfall and snow on ground where the Yellowknife A record has them |

Communities without an ECCC forecast site (Behchokǫ̀, Jean Marie River, Kakisa, Tsiigehtchic, Kátł'odeeche First Nation, Ndılǫ) are not shown as entries. Do not fake them from a neighbouring site.

**Data sources.** All from ECCC, all free, attribution "Based on Environment and Climate Change Canada data". The source map, query patterns and caveats are in the project doc `claude/weather_page_data_sources_oct2026.md`; the short version:

- City Page Weather XML on the MSC Datamart for current conditions and forecasts: `https://dd.weather.gc.ca/today/citypage_weather/NT/{HH}/` (UTC hour folders; one dated file per site per refresh; take the newest file per site). Site list: `https://dd.weather.gc.ca/today/citypage_weather/docs/site_list_en.csv` (30 NT rows; ignore Ekati and Indin River).
- MSC GeoMet-OGC-API (`https://api.weather.gc.ca`) collections `climate-stations`, `climate-daily`, `climate-hourly`, `climate-monthly`, `ltce-stations`, `ltce-temperature`, `ltce-precipitation`. Max 10,000 items per request, `offset` paging, `f=json` or `f=csv`.
- Fallback for stations missing from the API's daily collection: `https://climate.weather.gc.ca/climate_data/bulk_data_e.html?format=csv&stationID={STN_ID}&Year={Y}&Month={M}&Day=1&timeframe=2`.

## 2. Repository layout

```
cabin-weather/
  README.md
  pipeline/                 # Python 3.12, stdlib + requests + lxml only
    config/
      communities.json      # the 28 entries: slug, display name (style guide spelling), ECCC site code, region, tier, station mapping
      stations.json         # per comparison community: ordered list of climate IDs / STN_IDs to stitch, LTCE virtual station id
    fetch_citypage.py       # -> data/current.json, data/forecast/{slug}.json
    fetch_climate.py        # incremental daily archive update -> archive/{slug}.csv
    fetch_ltce.py           # -> archive/ltce/{slug}.json
    derive.py               # archive -> data/history/{slug}.json (the only file the front end reads for history)
    backfill.py             # one-off full archive pull
    formatters.py           # shared number/date/text formatting used by derive.py (tested)
    validate.py             # JSON schema checks; exits non-zero on failure
    tests/
  archive/                  # committed: full daily CSV per comparison community (~1–2 MB each), LTCE JSON
  data/                     # committed by the daily job (history/, records) or built at deploy (current.json, forecast/)
  site/                     # the front end, deployed as-is
    index.html
    app.js
    app.css
    icons.svg               # one sprite, ECCC icon codes mapped to ~20 simple glyphs
  wordpress/
    cabin-weather-shortcode.php   # the snippet to paste into cabin-radio-patches.php
  .github/workflows/
    refresh-current.yml     # every 30 minutes
    refresh-climate.yml     # twice daily
    deploy.yml              # builds the Pages artifact (called by both)
    ci.yml                  # tests + Playwright screenshots on pull requests
```

## 3. Data contracts (the front end only ever reads these)

Write these schemas first (`pipeline/schemas/*.json`) and validate every file against them before deploy. Keep numbers as numbers, not formatted strings; formatting is the front end's job except where noted.

`data/current.json` (one file, all communities, target under 40 KB):

```json
{
  "generated_at": "2026-10-19T03:40:00Z",
  "communities": {
    "yellowknife": {
      "name": "Yellowknife", "region": "North Slave", "tier": "plus",
      "observed_at": "2026-10-18T21:00:00-06:00", "station": "Yellowknife Airport",
      "temp": 5.1, "condition": "Mostly cloudy", "icon": "cloudy",
      "wind_kmh": 20, "wind_gust_kmh": null, "wind_dir": "SE",
      "wind_chill": null, "humidex": null, "humidity": 71, "dewpoint": 0.3,
      "pressure_kpa": 100.9, "pressure_tendency": "falling",
      "warnings": [{"type": "warning", "title": "Wind warning", "url": "https://weather.gc.ca/..."}],
      "sunrise": "08:31", "sunset": "18:13",
      "today_high": 7, "today_low": -2, "normal_high": 1, "normal_low": -6,
      "stale": false
    }
  }
}
```

`data/forecast/{slug}.json`: `hourly` (24 entries: local time, temp, condition, icon, wind, pop) and `daily` (7 entries: day name, date, high, low, icon, text summary, pop; keep ECCC's day/night split in the source but present one row per day with day text and night text). Include `issued_at`.

`data/history/{slug}.json` (comparison and plus tiers; target under 60 KB):

```json
{
  "generated_at": "...", "record_start": 1942, "normal_period": "1991–2020", "range_period": "2006–2025",
  "days": [
    {"date": "2026-10-05", "max": 7.5, "min": 4.8, "precip": 0.4, "gust": 42,
     "normal_max": 3.9, "normal_min": -3.4, "range_max_hi": 14.2, "range_max_lo": -6.1, "range_min_hi": 6.0, "range_min_lo": -15.5,
     "record_high": 14.4, "record_high_year": 1963, "record_low": -19.1, "record_low_year": 1996,
     "flags": ["warm_low_top3"]}
  ],
  "month": {"name": "October", "to_date": "2026-10-18", "mean": 2.9, "normal": 1.2, "rank": 23, "of": 84, "wettest_rank": null,
            "record_warm": {"value": 6.5, "year": 2023}, "record_cold": {"value": -8.1, "year": 1959}},
  "season": {...},
  "alltime": {"high": {"value": 32.5, "date": "1989-07-16"}, "low": {"value": -51.2, "date": "1947-01-31"}, "wettest_day": {...}, "windiest_gust": {...}},
  "plus": {"windchill_hourly": [...], "days_since_minus30": 201, "first_frost": "2026-09-16", "first_minus10": null, "first_snow": null, "snow_on_ground": null}
}
```

Rule: every value that could be missing is `null`, never 0 and never omitted. Every file carries `generated_at`. The front end treats `current.json` older than three hours as stale and says so.

## 4. Pipeline rules (reliability is the whole point)

1. Every HTTP call: 20-second timeout, three retries with backoff, a User-Agent that names Cabin Radio and a contact address. Never more than four concurrent requests to any ECCC host.
2. **Never publish a worse file than the one already live.** `fetch_citypage.py` starts by downloading the live `https://weather.cabinradio.ca/data/current.json`; it then overwrites only the communities it successfully fetched and parsed this run, stamps `stale: true` on any entry whose `observed_at` is more than three hours old, and refuses to write the file at all if fewer than 20 of 28 communities are fresh (the live file stays). Same pattern for `forecast/*.json`.
3. `validate.py` runs on every output; a validation failure fails the job and the previous deploy stays up. A failed job sends GitHub's default failure email to Ollie; nothing else needs to be built for alerting.
4. Parsing City Page XML: take the newest file per site code in the latest hour folder that has one, falling back one hour at a time up to six hours. Handle empty `<condition/>` and `<iconCode/>` (seen in live files) by showing temperature only. Map ECCC icon codes (0–48) to our sprite; unknown codes map to a neutral glyph, never to a broken image.
5. `fetch_climate.py` re-pulls the last 10 days per station every run (ECCC back-fills and corrects), merges into the committed CSV by date, and commits. Stitch multiple station IDs per community by date precedence listed in `stations.json` (Yellowknife: climate ID 2204101 from 2013, 2204100 before). If the API returns nothing for a station, fall back to the bulk CSV endpoint; if both fail, keep the existing archive and continue.
6. `derive.py` computes, per comparison community: 1991–2020 normals per calendar day (smoothed with a ±7-day window), the 2006–2025 range per calendar day, month-so-far mean and its rank against every complete year with at least 25 days of data, all-time extremes, and merges LTCE daily records (always with the year). Records "set in the last 14 days" are computed by comparing each day's values against the LTCE record for that date and flagged. Daily mean is (max+min)/2, the ECCC convention. For Yellowknife, add wind chill from `climate-hourly` for the last 14 days, and the plus-tier items. Where the archive has fewer than 20 valid years for a calendar day, emit `null` for the range and let the front end omit the band rather than draw a misleading one.
7. Timezone: everything presented in Mountain Time (`America/Edmonton` / `America/Yellowknife`; the whole NWT keeps one clock). Store ISO timestamps with offsets; never present UTC.
8. Schedules: `refresh-current` every 30 minutes (`*/30 * * * *`; Actions cron drifts a few minutes, which is fine). `refresh-climate` at 09:10 and 15:10 UTC (after ECCC's overnight archive update). Each run builds the full Pages artifact (site + committed data + fresh current/forecast JSON) and deploys with `actions/deploy-pages`; the daily job commits archive and history changes to `main` first. Add `concurrency: pages` so runs never overlap. Keep each run under two minutes.
9. Backfill (`backfill.py`, run once by hand): full daily archive for each of the six communities' station threads via `climate-daily` paged by year, written to `archive/{slug}.csv` with a header row and a `source_station` column. Commit the result.

## 5. Front-end rules

**Structure and navigation.** One page. URL hash is the state: `#yellowknife`, `#fort-smith`, `#all-now`, `#all-24h`. No hash means Yellowknife. Top of the app: the community name as the heading, a native `<select>` labelled "Change community" listing the 28 in alphabetical order grouped by region (`<optgroup>`), and two plain text links: "All communities now" and "Next 24 hours, all communities". Below, sections in this fixed order with short H3 subheads and generous spacing:

1. **Now** – big temperature, condition, wind (with gust if present), wind chill or humidex when ECCC supplies one, humidity, "Observed at the airport, 9pm". Any warning sits above this as a single quiet line with a link, orange text, no banner.
2. **Next 24 hours** – a horizontal strip of hours (scrolls sideways on mobile, fits on desktop): time, glyph, temperature. Nothing else.
3. **This week** – seven rows: day name and date, glyph, high/low, one-line text. Sunrise and sunset for the first day as a footnote line.
4. **The past two weeks** (comparison and plus tiers only) – the headline chart: daily high and low as two orange lines/points, the normal high–low as a soft grey band, the 20-year range as a fainter band, record days marked with a small dot and a label. Under it: precipitation bars for the same 14 days with normal shown as a thin line; peak gust as a small sparkline. A one-paragraph auto-generated sentence in Cabin style summarises the fortnight ("The past two weeks in Fort Smith averaged 3.2C, about 1.5C above normal. No daily records were set."). Plus tier adds an hourly wind chill chart.
5. **This month and this season** (comparison and plus) – a short list: month-so-far mean against normal and its rank in plain words ("23rd warmest October 1–18 in 84 years"), warmest and coldest such month on record with years, wettest. Plus tier adds "days since the last -30C night" and the first-frost/first-snow lines.
6. **Records** – all-time high, low, wettest day, strongest gust, each with its date, plus the records for the current calendar day ("On October 19 the record high is 14.4C, set in 1963").
7. **Footer** – "Based on Environment and Climate Change Canada data. Observations from {station}. Updated 9:40pm MT." and a link to the ECCC page for the community.

Sections that do not apply to a tier are simply absent; never show an empty section or "no data available" box.

**All-communities views.** A single table with no borders, grouped by region with a small region label, one row per community: name, glyph, temperature, wind, condition. The 24-hour view is the same table with each row showing eight three-hourly temperatures as text with a tiny sparkline. Tap a name to go to that community. On phones the table collapses to two columns (name, temperature) with the rest on a second line.

**Performance budget.** `app.js` under 40 KB, `app.css` under 12 KB, `icons.svg` under 15 KB, all uncompressed. First paint needs only `index.html`, CSS, fonts and `current.json`. Forecast and history JSON are fetched on demand when a community is shown, cached in memory. Prefetch Yellowknife's forecast and history immediately after first paint. Use `fetch` with `cache: 'default'` and let GitHub Pages' cache headers do the rest. Lighthouse mobile performance 95 or better on a throttled 4G profile.

**Resilience.** If `current.json` fails to load, show the page skeleton with one calm sentence ("Live weather is temporarily unavailable. Try weather.gc.ca.") and a link; never a blank. If a community's forecast fails, show Now from `current.json` and omit the rest. Stale data shows the observation time in the normal place plus "Observations are delayed" in muted text. No console errors on any route. Works with JavaScript disabled to the extent of showing the heading, the select (which falls back to navigating by hash) and the ECCC link.

**Accessibility.** Semantic headings, `aria-live="polite"` on the main region so the community change is announced, charts carry a `<title>` and an `aria-describedby` paragraph with the key numbers, colour never the only carrier of meaning (record dots also have labels), focus styles visible, all tap targets at least 44 px.

## 6. Look and feel (measured from cabinradio.ca on October 18, 2026)

Copy the site, not a dashboard aesthetic. Measured values:

- Body text: **Domine**, 19px, 400, line-height 1.57, colour `#000`. Headings: **Lora**, 500, colour `#111`; article H1 40px, H2 24px, H3 27px. Small meta text (bylines): Domine 12px, colour `#999`.
- Accent: Cabin orange `#ed5734` – used on the site only for links and small highlights. Secondary colours seen on the site: `#1e1e1e`, `#444`, `#999` (muted), `#eee` (rules), `#2c4d24` (green, menu only – do not use). Background is white everywhere.
- Content column is 710 px wide on desktop. Charts in Cabin's Flourish embeds use **Lora** for all chart text, white background, light hairline gridlines, a title at about 1.4× body size and a subtitle sentence beneath, a one-line source footnote, and a **single-hue monochrome palette per chart** (recent examples: five purples from `#dfd6ee` to `#503e70`; five reds from `#ffc0c0` to `#440909`). There is no multi-colour brand palette; Cabin charts read as one colour family at a time.

Translate that into tokens in `app.css` and use nothing else:

```css
#cabin-weather {
  --font-body: 'Domine', Georgia, serif;
  --font-head: 'Lora', Georgia, serif;
  --ink: #000; --ink-2: #111; --ink-3: #444; --muted: #999; --rule: #eee; --grid: #ebebeb;
  --accent: #ed5734;            /* observed values, links, the "now" marker */
  --band-normal: #e9e3dc;       /* normal high–low band: warm grey */
  --band-range: #f4f1ee;        /* 20-year range band: fainter warm grey */
  --precip: #8ea6b8;            /* one muted blue-grey for precipitation and wind, the only second hue */
  --space: 1.5rem;              /* vertical rhythm unit; sections are separated by 3rem */
}
```

Charts: Lora labels at 13px, `--grid` hairlines, no axis lines, no chart borders, no legends when a subtitle sentence can say what the colours mean, no tooltips on mobile (tap a point shows its value inline beneath the chart instead). Temperature lines and points in `--accent`; bands in the two greys; precipitation in `--precip`. Big numbers (the current temperature) in Lora 500 at 64px desktop / 48px mobile. Everything else at body size. Whitespace does the structuring: no cards, no boxes, no background tints, no icons beyond the weather glyphs, one hairline rule between sections.

Weather glyphs: a single inline SVG sprite of about 20 line-drawn symbols (sun, moon, part cloud day/night, cloud, rain, showers, snow, flurries, freezing rain, thunder, fog, blowing snow, wind, clear night, ice crystals) drawn at 1.5 px stroke in `currentColor`. No colour fills, no emoji.

Glyphs and charts must look right in Zeen's CSS context: scope every selector under `#cabin-weather`, set `box-sizing`, `line-height` and `font-family` explicitly at the root, and reset table and list styles the theme may impose.

## 7. House style (enforce in `formatters.py` and the front-end formatter, with tests)

From the Cabin Radio Style Guide; these are not optional.

- Temperatures: figure, then `C`, no space, no degree sign, no "minus": `20C`, `-20C`. Use a hyphen-minus for negatives, as the guide does. One decimal only where the source has it and it matters (daily means, anomalies); whole numbers for current temperature, forecasts and records display.
- Measurements: number, space, unit: `25 km/h`, `0.4 mm`, `12 cm`. Wind chill is a bare number (`wind chill -31`), as ECCC gives it.
- Dates: `October 5` (no "th"), `Monday, October 5`, `October 5, 2025` only when the year is needed. Years always digits. Decades `80s`.
- Times: `4pm`, `8:30am`, no space, `MT` when a timezone is needed, `noon`, `midnight`. Never 24-hour clock in the interface.
- Never "today", "yesterday" or "tomorrow": use the day name. The forecast table's first row is the day name, not "Today".
- Dashes: the en dash with spaces for a break in a sentence – like this – and the en dash without spaces for ranges (`1991–2020`, `high–low`). Never an em dash.
- Numbers in sentences: one to nine in words, 10 and up in digits, comma in thousands (`1,000`); digits are fine in tables and charts. `percent`, not `%`, in sentences. "More than", not "over".
- Communities exactly as the guide spells them, with diacritics: Aklavik, Colville Lake, Délı̨nę, Dettah, Enterprise, Fort Good Hope, Fort Liard, Fort McPherson, Fort Providence, Fort Resolution, Fort Simpson, Fort Smith, Gamètì, Hay River, Inuvik, Łútsël K'é, Nahanni Butte, Norman Wells, Paulatuk, Sachs Harbour, Sambaa K'e, Tuktoyaktuk, Tulita, Ulukhaktok, Wekweètì, Whatì, Wrigley, Yellowknife. Regions: North Slave, South Slave, Beaufort Delta, Sahtu, Dehcho, Tłı̨chǫ. `NWT`, never `NT`, in anything a reader sees.
- Abbreviations without periods. `OK` not okay. `-ize` spellings. "Under way" two words. Quote marks are only needed in generated sentences if quoting ECCC text; use double quotes.
- Generated sentences are short, plain and in the past tense for observations ("averaged", "was"), present for records ("the record high is"). No exclamation marks, no adjectives like "balmy" or "frigid".

## 8. Phases and acceptance checks

**Phase 0 – discovery (half a day).** Run the `climate-stations` and `ltce-stations` queries for NT, pick the station threads for the six communities, fill `config/stations.json` and `config/communities.json`, and confirm each of the six is actually present in `climate-daily` (fall back to bulk CSV where not). Check: a one-off script prints, per community, the station chain with first and last dates, and the last 14 days of data.

**Phase 1 – pipeline and data (two to three days).** Backfill, incremental update, LTCE, derive, validate, both workflows deploying to Pages with the data only (no front end yet). Check: `weather.cabinradio.ca/data/current.json` refreshes every 30 minutes for 24 hours without a failed run; killing network access in a test run leaves the live file untouched; `pytest` passes, including formatter tests for every rule in section 7; schema validation rejects a hand-corrupted file.

**Phase 2 – front end, Yellowknife only (two to three days).** Build the single-community page end to end for Yellowknife, including the plus tier. Check: Playwright screenshots at 375×812 and 1280×900 reviewed by Ollie; Lighthouse mobile performance ≥ 95, accessibility ≥ 95; no console errors; renders correctly when `current.json` is replaced by a 500 response.

**Phase 3 – all communities and the two overview views (one to two days).** Check: every hash route renders; the select and the overview links work with the keyboard; the all-communities table at 375 px needs no horizontal scroll.

**Phase 4 – embed on cabinradio.ca (half a day plus Ollie).** Add the shortcode to `cabin-radio-patches.php` in the local theme copy, with the fallback iframe snippet documented in `wordpress/`. Check: on a staging copy of the weather page, fonts inherit, nothing from Zeen leaks in, the Windy embed above or below still works, mobile layout holds inside the 710 px column.

**Phase 5 – soak (one week, no code).** Watch Actions for failures and stale flags; compare a handful of values against weather.gc.ca by hand; then switch the live page.

## 9. Things not to do

- Do not add a JavaScript framework, a chart library, a CSS framework, analytics, or any CDN script.
- Do not call ECCC from the browser, and do not call weatherstats.ca at all.
- Do not invent data for communities ECCC does not cover, and do not show snowfall or snow depth outside the Yellowknife tier.
- Do not use colour-coded temperature scales, gradients, cards, shadows, badges or icons beyond the weather glyphs. If a design choice would not look at home in a Cabin Radio article, leave it out.
- Do not use "today", "tomorrow", em dashes, degree signs or `NT`.
- Do not store anything in `localStorage` except, optionally, the last selected community.

## 10. Reference material

- Project docs: `claude/weather_page_data_sources_oct2026.md` (source map, URLs, caveats), `claude/yk_autumn_2026_weather_analysis_oct17.md` and `claude/yk_el_nino_winter_analysis_oct2026.md` (worked examples of the kinds of comparison the history tier should make).
- Cabin Radio Style Guide (project file).
- ECCC: GeoMet-OGC-API docs `https://eccc-msc.github.io/open-data/msc-geomet/ogc_api_en`; LTCE technical documentation on canada.ca; City Page Weather dated-files notice (June 2025) on the dd_info list; ECCC data licence `https://www.climate.weather.gc.ca/prods_servs/attachment1_e.html`.
