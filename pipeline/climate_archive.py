"""The committed daily climate archive: one CSV per history community.

Columns are fixed (COLUMNS). Values are numbers or empty (null). One row per
date; rows where every measurement is null are dropped, so a missing day is
simply absent. `source_station` records which climate identifier the row came
from, following the station thread in config/stations.json.

Two sources feed it: GeoMet's climate-daily collection (normal) and the bulk
CSV download on climate.weather.gc.ca (fallback). Both are normalized here so
backfill.py, fetch_climate.py and derive.py never see a raw ECCC row.
"""

from __future__ import annotations

import csv
import io
import json
import logging
from datetime import date, timedelta
from pathlib import Path

import eccc_http

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE_DIR = ROOT / "archive"
CONFIG_DIR = Path(__file__).resolve().parent / "config"
API = "https://api.weather.gc.ca/collections/climate-daily/items"
BULK = "https://climate.weather.gc.ca/climate_data/bulk_data_e.html"

COLUMNS = [
    "date", "source_station", "max", "min", "mean", "precip", "rain", "snow", "snow_on_ground",
    "gust", "gust_dir", "max_flag", "min_flag", "precip_flag",
]
MEASUREMENTS = ["max", "min", "mean", "precip", "rain", "snow", "snow_on_ground", "gust", "gust_dir"]
CHUNK_YEARS = 5
PAGE = 10_000


# ---------------------------------------------------------------- config

def load_stations() -> dict:
    return json.loads((CONFIG_DIR / "stations.json").read_text("utf-8"))["stations"]


def load_communities() -> list[dict]:
    return json.loads((CONFIG_DIR / "communities.json").read_text("utf-8"))["communities"]


def history_slugs() -> list[str]:
    return [c["slug"] for c in load_communities() if c["tier"] in ("comparison", "plus")]


def thread_for(slug: str) -> dict:
    """The stations.json entry for a community slug (communities.json maps slug -> climate key)."""
    climate_key = next(c["climate"] for c in load_communities() if c["slug"] == slug)
    return load_stations()[climate_key]


def station_windows(thread: dict, today: date | None = None) -> list[tuple[dict, date, date]]:
    """[(station, first_date, last_date)] for every segment of a thread, clipped to today."""
    today = today or date.today()
    out = []
    for station in thread["daily"]:
        first = date.fromisoformat(station["from"])
        last = date.fromisoformat(station["to"]) if station["to"] else today
        out.append((station, first, min(last, today)))
    return out


def archive_path(slug: str) -> Path:
    return ARCHIVE_DIR / f"{slug}.csv"


# ---------------------------------------------------------------- values

def num(value) -> float | None:
    """ECCC numbers come as floats, ints, strings, '' or '<31' (gust under the reporting threshold)."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if text == "" or text.startswith("<"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def fmt(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def is_empty(row: dict) -> bool:
    return all(row.get(k) is None for k in MEASUREMENTS)


# ---------------------------------------------------------------- normalizing sources

def row_from_api(props: dict) -> dict | None:
    """Normalize one climate-daily feature's properties. None if the row has no measurements."""
    row = {
        "date": props["LOCAL_DATE"][:10],
        "source_station": props["CLIMATE_IDENTIFIER"],
        "max": num(props.get("MAX_TEMPERATURE")),
        "min": num(props.get("MIN_TEMPERATURE")),
        "mean": num(props.get("MEAN_TEMPERATURE")),
        "precip": num(props.get("TOTAL_PRECIPITATION")),
        "rain": num(props.get("TOTAL_RAIN")),
        "snow": num(props.get("TOTAL_SNOW")),
        "snow_on_ground": num(props.get("SNOW_ON_GROUND")),
        "gust": num(props.get("SPEED_MAX_GUST")),
        "gust_dir": num(props.get("DIRECTION_MAX_GUST")),
        "max_flag": (props.get("MAX_TEMPERATURE_FLAG") or "") or "",
        "min_flag": (props.get("MIN_TEMPERATURE_FLAG") or "") or "",
        "precip_flag": (props.get("TOTAL_PRECIPITATION_FLAG") or "") or "",
    }
    return None if is_empty(row) else row


_BULK_FIELDS = {
    "max": "Max Temp (", "max_flag": "Max Temp Flag", "min": "Min Temp (", "min_flag": "Min Temp Flag",
    "mean": "Mean Temp (", "rain": "Total Rain (", "snow": "Total Snow (", "precip": "Total Precip (",
    "precip_flag": "Total Precip Flag", "snow_on_ground": "Snow on Grnd (", "gust_dir": "Dir of Max Gust (",
    "gust": "Spd of Max Gust (",
}


def rows_from_bulk_csv(text: str, climate_id: str) -> list[dict]:
    """Normalize the climate.weather.gc.ca bulk daily CSV (timeframe=2). Headers carry a degree sign, so match by prefix."""
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    headers = reader.fieldnames or []

    def col(prefix: str) -> str | None:
        return next((h for h in headers if h.startswith(prefix)), None)

    cols = {key: col(prefix) for key, prefix in _BULK_FIELDS.items()}
    date_col = col("Date/Time")
    rows = []
    for rec in reader:
        if not date_col or not rec.get(date_col):
            continue
        row = {"date": rec[date_col][:10], "source_station": climate_id}
        for key in MEASUREMENTS:
            row[key] = num(rec.get(cols[key] or "", "")) if cols[key] else None
        for key in ("max_flag", "min_flag", "precip_flag"):
            row[key] = (rec.get(cols[key] or "", "") or "").strip() if cols[key] else ""
        if not is_empty(row):
            rows.append(row)
    return rows


# ---------------------------------------------------------------- fetching

def fetch_api_rows(climate_id: str, start: date, end: date) -> list[dict]:
    """All climate-daily rows for one station between two dates, chunked by CHUNK_YEARS and paged."""
    rows: list[dict] = []
    chunk_start = start
    while chunk_start <= end:
        chunk_end = min(date(chunk_start.year + CHUNK_YEARS - 1, 12, 31), end)
        offset = 0
        while True:
            data = eccc_http.get_json(API, {
                "CLIMATE_IDENTIFIER": climate_id,
                "datetime": f"{chunk_start.isoformat()}/{chunk_end.isoformat()}",
                "sortby": "LOCAL_DATE", "f": "json", "limit": PAGE, "offset": offset,
            })
            feats = data.get("features", [])
            for f in feats:
                row = row_from_api(f["properties"])
                if row:
                    rows.append(row)
            if len(feats) < PAGE:
                break
            offset += PAGE
        chunk_start = chunk_end + timedelta(days=1)
    return rows


def fetch_bulk_rows(stn_id: int, climate_id: str, year: int) -> list[dict]:
    text = eccc_http.get_text(BULK, {
        "format": "csv", "stationID": stn_id, "Year": year, "Month": 1, "Day": 1, "timeframe": 2,
    })
    return rows_from_bulk_csv(text, climate_id)


def clip(rows: list[dict], start: date, end: date) -> list[dict]:
    return [r for r in rows if start.isoformat() <= r["date"] <= end.isoformat()]


# ---------------------------------------------------------------- the CSV on disk

def read_archive(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    out: dict[str, dict] = {}
    with path.open("r", encoding="utf-8", newline="") as fh:
        for rec in csv.DictReader(fh):
            row = {"date": rec["date"], "source_station": rec["source_station"]}
            for key in MEASUREMENTS:
                row[key] = num(rec.get(key, ""))
            for key in ("max_flag", "min_flag", "precip_flag"):
                row[key] = rec.get(key, "") or ""
            out[row["date"]] = row
    return out


def write_archive(path: Path, rows: dict[str, dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".csv.tmp")
    with tmp.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(COLUMNS)
        for d in sorted(rows):
            row = rows[d]
            writer.writerow([fmt(row.get(c)) if c in MEASUREMENTS else (row.get(c) or "") for c in COLUMNS])
    tmp.replace(path)


def merge(rows: dict[str, dict], new_rows: list[dict]) -> int:
    """Replace rows by date. Returns how many rows were added or changed."""
    changed = 0
    for row in new_rows:
        if rows.get(row["date"]) != row:
            rows[row["date"]] = row
            changed += 1
    return changed
