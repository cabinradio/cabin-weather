# Cabin Weather

A small static weather app for the Northwest Territories, built by [Cabin Radio](https://cabinradio.ca) from Environment and Climate Change Canada (ECCC) open data and embedded on cabinradio.ca/weather.

- Current conditions, the next 24 hours and a seven-day forecast for 28 NWT communities.
- For Yellowknife, Inuvik, Norman Wells, Fort Simpson, Hay River and Fort Smith: the past two weeks against the 1991–2020 normal, the 20-year range and the daily records, plus month, season and all-time context.
- No servers, no databases, no frameworks. A scheduled GitHub Actions job fetches and processes the data into plain JSON; GitHub Pages serves the app and the JSON; the browser never talks to ECCC directly.

Based on Environment and Climate Change Canada data. See the [ECCC data licence](https://www.climate.weather.gc.ca/prods_servs/attachment1_e.html).

## Layout

| Path | What it is |
|---|---|
| `pipeline/` | Python 3.12 data pipeline (stdlib, `requests`, `lxml`). Writes the JSON the front end reads. |
| `pipeline/config/` | `communities.json` (the 28 communities) and `stations.json` (climate station threads for the six history communities). |
| `archive/` | Committed daily climate archive, one CSV per history community, plus LTCE record JSON. |
| `data/` | The JSON the front end reads. `history/` is committed by the daily job; `current.json` and `forecast/` are built at deploy time. |
| `site/` | The front end: `index.html`, `app.js`, `app.css`, `icons.svg`. Deployed as-is. |
| `wordpress/` | The shortcode snippet for cabinradio.ca. |
| `docs/` | The implementation plan and working notes. |

## Running the pipeline locally

```bash
python3 -m venv .venv
.venv/bin/pip install -r pipeline/requirements-dev.txt
.venv/bin/python pipeline/discover_stations.py   # Phase 0 check against live ECCC data
.venv/bin/pytest pipeline/tests
```

See `CLAUDE.md` for the working rules and `ARCHITECTURE.md` for how the pieces fit together.
