"""archive/{slug}.csv + archive/ltce/{slug}.json -> data/history/{slug}.json

The only file the front end reads for history. Everything here is computed
from the committed archive so every community uses one method on one
station thread (plan section 4, rule 6):

  * 1991–2020 normals per calendar day, smoothed over a ±7-day window
  * the 2006–2025 range per calendar day (null unless all 20 years are present)
  * the last 14 complete days with LTCE records and record flags
  * month so far and season so far: mean, normal, rank among valid years
  * all-time extremes and the LTCE records for today and the next two days
  * a house-style summary sentence (formatters.py)
  * for Yellowknife: hourly wind chill, days since -30C, first frost/-10/snow

Daily mean is (max+min)/2, ECCC's convention. Dates are Mountain Time.

    .venv/bin/python pipeline/derive.py [--offline] [--today YYYY-MM-DD] [slug ...]
"""

from __future__ import annotations

import argparse
import json
import logging
import statistics
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import climate_archive as ca
import eccc_http
import formatters as fmt
from fetch_ltce import ltce_path

log = logging.getLogger("derive")

TZ = ZoneInfo("America/Yellowknife")
HISTORY_DIR = ca.ROOT / "data" / "history"
HOURLY_API = "https://api.weather.gc.ca/collections/climate-hourly/items"

NORMAL_YEARS = range(1991, 2021)
NORMAL_WINDOW = 7
NORMAL_MIN_YEARS = 20
RANGE_YEARS = range(2006, 2026)
WINDOW_DAYS = 14
PERIOD_MIN_COVERAGE = 0.8

SEASONS = {12: "winter", 1: "winter", 2: "winter", 3: "spring", 4: "spring", 5: "spring",
           6: "summer", 7: "summer", 8: "summer", 9: "autumn", 10: "autumn", 11: "autumn"}


# ---------------------------------------------------------------- helpers

def r1(value: float | None) -> float | None:
    return None if value is None else fmt.round_half_up(value, 1)


def daily_mean(row: dict | None) -> float | None:
    if not row or row["max"] is None or row["min"] is None:
        return None
    return (row["max"] + row["min"]) / 2


def safe_date(year: int, month: int, day: int) -> date:
    """Feb 29 in a non-leap year becomes Feb 28."""
    try:
        return date(year, month, day)
    except ValueError:
        return date(year, month, 28)


def mean_or_none(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


# ---------------------------------------------------------------- climatology

class Climatology:
    """Normals and ranges per calendar day, computed once per archive."""

    def __init__(self, rows: dict[str, dict]):
        self.rows = rows
        self._normal_cache: dict[tuple[int, int], dict] = {}
        self._range_cache: dict[tuple[int, int], dict] = {}

    def normal(self, month: int, day: int) -> dict:
        key = (month, day)
        if key not in self._normal_cache:
            maxes, mins, precips = [], [], []
            years_seen = set()
            for year in NORMAL_YEARS:
                centre = safe_date(year, month, day)
                for offset in range(-NORMAL_WINDOW, NORMAL_WINDOW + 1):
                    row = self.rows.get((centre + timedelta(days=offset)).isoformat())
                    if not row:
                        continue
                    if row["max"] is not None:
                        maxes.append(row["max"])
                        years_seen.add(year)
                    if row["min"] is not None:
                        mins.append(row["min"])
                    if row["precip"] is not None:
                        precips.append(row["precip"])
            enough = len(years_seen) >= NORMAL_MIN_YEARS
            self._normal_cache[key] = {
                "max": mean_or_none(maxes) if enough else None,
                "min": mean_or_none(mins) if enough else None,
                "precip": mean_or_none(precips) if enough else None,
            }
        return self._normal_cache[key]

    def range(self, month: int, day: int) -> dict:
        key = (month, day)
        if key not in self._range_cache:
            maxes, mins = [], []
            for year in RANGE_YEARS:
                row = self.rows.get(safe_date(year, month, day).isoformat())
                if row and row["max"] is not None and row["min"] is not None:
                    maxes.append(row["max"])
                    mins.append(row["min"])
            if len(maxes) >= len(RANGE_YEARS):
                self._range_cache[key] = {"max_hi": max(maxes), "max_lo": min(maxes), "min_hi": max(mins), "min_lo": min(mins)}
            else:
                self._range_cache[key] = {"max_hi": None, "max_lo": None, "min_hi": None, "min_lo": None}
        return self._range_cache[key]


# ---------------------------------------------------------------- records and flags

def top(ltce_day: dict | None, key: str) -> list[list]:
    return (ltce_day or {}).get(key) or []


def compare(value: float | None, ranked: list[list], higher_is_better: bool, year: int) -> tuple[str | None, list | None]:
    """('record' | 'top3' | None, previous best [value, year]) against an LTCE top-five list, ignoring this year's own entry."""
    if value is None:
        return None, None
    others = [entry for entry in ranked if entry[1] != year]
    if not others:
        return None, None
    best = others[0]
    beats = (value >= best[0]) if higher_is_better else (value <= best[0])
    if beats:
        return "record", best
    if len(others) >= 3:
        third = others[2][0]
        if (value >= third) if higher_is_better else (value <= third):
            return "top3", best
    return None, best


FLAG_KINDS = [
    # (flag kind, archive field, ltce key, higher is better, sentence kind)
    ("high", "max", "high", True, "high"),
    ("low", "min", "low", False, "low"),
    ("warm_low", "min", "warm_low", True, "warm_low"),
    ("cold_high", "max", "cold_high", False, "cold_high"),
]


def flags_and_sentences(d: date, row: dict | None, ltce_day: dict | None) -> tuple[list[str], list[str]]:
    flags, sentences = [], []
    if not row:
        return flags, sentences
    for kind, field, key, higher, sentence_kind in FLAG_KINDS:
        value = row.get(field)
        result, best = compare(value, top(ltce_day, key), higher, d.year)
        if result == "record":
            flags.append(f"record_{kind}")
            tied = best is not None and value == best[0]
            sentences.append(fmt.record_sentence(sentence_kind, value, d, best[0] if best else None, best[1] if best else None, tied=tied))
        elif result == "top3":
            flags.append(f"{kind}_top3")
    return flags, sentences


def calendar_records(ltce_days: dict, start: date, count: int) -> list[dict]:
    out = []
    for i in range(count):
        d = start + timedelta(days=i)
        day = ltce_days.get(f"{d.month:02d}-{d.day:02d}")
        high, low, precip = top(day, "high"), top(day, "low"), top(day, "precip")
        out.append({
            "date": d.isoformat(),
            "record_high": high[0][0] if high else None, "record_high_year": high[0][1] if high else None,
            "record_low": low[0][0] if low else None, "record_low_year": low[0][1] if low else None,
            "record_precip": precip[0][0] if precip else None, "record_precip_year": precip[0][1] if precip else None,
        })
    return out


# ---------------------------------------------------------------- periods

def period_dates(start: date, end: date) -> list[date]:
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def period_stats(rows: dict[str, dict], dates: list[date]) -> tuple[float | None, float | None, int]:
    """(mean temperature, precipitation total, days with data) for a list of dates, or None if coverage is too thin."""
    means, precips = [], []
    for d in dates:
        row = rows.get(d.isoformat())
        m = daily_mean(row)
        if m is not None:
            means.append(m)
        if row and row["precip"] is not None:
            precips.append(row["precip"])
    need = max(1, int(len(dates) * PERIOD_MIN_COVERAGE + 0.999))
    mean = statistics.fmean(means) if len(means) >= need else None
    precip = sum(precips) if len(precips) >= need else None
    return mean, precip, len(means)


def shifted(dates: list[date], year: int) -> list[date]:
    """The same calendar dates in another year, keeping a Dec–Feb span across the year end."""
    first_year = dates[0].year
    return [safe_date(year + (d.year - first_year), d.month, d.day) for d in dates]


def period_block(rows: dict[str, dict], clim: Climatology, start: date, end: date, name: str, label: str,
                 record_start: int) -> dict:
    dates = period_dates(start, end)
    mean, precip, days = period_stats(rows, dates)
    normal_means, normal_precips = [], []
    for d in dates:
        n = clim.normal(d.month, d.day)
        if n["max"] is not None and n["min"] is not None:
            normal_means.append((n["max"] + n["min"]) / 2)
        if n["precip"] is not None:
            normal_precips.append(n["precip"])
    normal = mean_or_none(normal_means) if len(normal_means) == len(dates) else None
    precip_normal = sum(normal_precips) if len(normal_precips) == len(dates) else None

    # Every other year with enough data over the same dates.
    this_year = start.year
    by_year: dict[int, tuple[float, float | None]] = {}
    for year in range(record_start, this_year):
        m, p, _ = period_stats(rows, shifted(dates, year))
        if m is not None:
            by_year[year] = (m, p)
    if mean is not None:
        by_year[this_year] = (mean, precip)
    # Ranks are tie-aware: 1 + the number of years strictly warmer (or colder, or wetter).
    ordered = sorted(by_year.items(), key=lambda kv: kv[1][0], reverse=True)
    of = len(ordered)
    rank = cold_rank = None
    if mean is not None:
        rank = 1 + sum(1 for y, (m, _) in by_year.items() if y != this_year and m > mean)
        cold_rank = 1 + sum(1 for y, (m, _) in by_year.items() if y != this_year and m < mean)
    rank_text = None
    if rank is not None and of >= 10:
        if rank <= of / 2:
            rank_text = fmt.rank_phrase(rank, of, "warmest", label)
        else:
            rank_text = fmt.rank_phrase(cold_rank, of, "coldest", label)
    wet = sorted(((p, y) for y, (_, p) in by_year.items() if p is not None), reverse=True)
    wettest_rank = None
    if precip is not None:
        wettest_rank = 1 + sum(1 for p, y in wet if y != this_year and p > precip)
    others = [(y, v) for y, v in ordered if y != this_year] or ordered
    return {
        "name": name, "label": label, "from": start.isoformat(), "to_date": end.isoformat(), "days": days,
        "mean": r1(mean), "normal": r1(normal), "anomaly": r1(mean - normal) if mean is not None and normal is not None else None,
        "rank": rank, "of": of if rank is not None else None, "rank_text": rank_text,
        "precip": r1(precip), "precip_normal": r1(precip_normal), "wettest_rank": wettest_rank,
        "record_warm": {"value": r1(others[0][1][0]), "year": others[0][0]},
        "record_cold": {"value": r1(others[-1][1][0]), "year": others[-1][0]},
        "record_wet": {"value": r1(wet[0][0]), "year": wet[0][1]} if wet else {"value": None, "year": None},
    }


def month_period(rows, clim, to_date: date, record_start: int) -> dict:
    start = to_date.replace(day=1)
    last_day = (start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    name = fmt.MONTHS[start.month - 1]
    label = name if to_date == last_day else fmt.fmt_date_range(start, to_date)
    return period_block(rows, clim, start, to_date, name, label, record_start)


def season_period(rows, clim, to_date: date, record_start: int) -> dict:
    name = SEASONS[to_date.month]
    start_month = {"winter": 12, "spring": 3, "summer": 6, "autumn": 9}[name]
    start_year = to_date.year - 1 if (name == "winter" and to_date.month < 12) else to_date.year
    start = date(start_year, start_month, 1)
    end_of_season = (start + timedelta(days=93)).replace(day=1) - timedelta(days=1)
    label = name if to_date == end_of_season else f"{name} so far"
    return period_block(rows, clim, start, to_date, name, label, record_start)


# ---------------------------------------------------------------- extremes

def extreme(rows: dict[str, dict], field: str, biggest: bool) -> dict:
    best = None
    for d in sorted(rows):
        v = rows[d][field]
        if v is None:
            continue
        if best is None or (v > best[0] if biggest else v < best[0]):
            best = (v, d)
    return {"value": best[0], "date": best[1]} if best else {"value": None, "date": None}


# ---------------------------------------------------------------- plus tier (Yellowknife)

def local_iso(utc_text: str) -> str:
    dt = datetime.fromisoformat(utc_text).replace(tzinfo=timezone.utc).astimezone(TZ)
    return dt.replace(second=0, microsecond=0).isoformat(timespec="minutes")


def fetch_windchill_hourly(climate_id: str, start: date, end: date) -> list[dict]:
    data = eccc_http.get_json(HOURLY_API, {
        "CLIMATE_IDENTIFIER": climate_id,
        # ECCC's LOCAL_DATE is local standard time, so ask a day either side and keep what falls in the window after conversion.
        "datetime": f"{(start - timedelta(days=1)).isoformat()}/{(end + timedelta(days=1)).isoformat()}",
        "sortby": "UTC_DATE", "f": "json", "limit": 1000,
    })
    out = []
    for f in data.get("features", []):
        p = f["properties"]
        if not p.get("UTC_DATE"):
            continue
        local = local_iso(p["UTC_DATE"])
        if not (start.isoformat() <= local[:10] <= end.isoformat()):
            continue
        out.append({"time": local, "temp": ca.num(p.get("TEMP")), "wind_chill": ca.num(p.get("WINDCHILL"))})
    return out


def plus_block(rows: dict[str, dict], thread: dict, window_end: date, hourly: list[dict] | None) -> dict:
    yesterday = window_end
    last_minus30 = None
    for d in sorted(rows, reverse=True):
        if d > yesterday.isoformat():
            continue
        if rows[d]["min"] is not None and rows[d]["min"] <= -30:
            last_minus30 = d
            break
    cold_season_start = date(yesterday.year if yesterday.month >= 8 else yesterday.year - 1, 8, 1)
    first_frost = first_minus10 = first_snow = None
    season_snow = []
    for d in sorted(rows):
        if d < cold_season_start.isoformat() or d > yesterday.isoformat():
            continue
        row = rows[d]
        if first_frost is None and row["min"] is not None and row["min"] <= 0:
            first_frost = d
        if first_minus10 is None and row["min"] is not None and row["min"] <= -10:
            first_minus10 = d
        if first_snow is None and ((row["snow"] or 0) > 0 or (row["snow_on_ground"] or 0) > 0):
            first_snow = d
        if row["snow"] is not None:
            season_snow.append(row["snow"])
    sog, sog_date = None, None
    for d in sorted(rows, reverse=True):
        if d > yesterday.isoformat():
            continue
        if d < (yesterday - timedelta(days=WINDOW_DAYS)).isoformat():
            break
        if rows[d]["snow_on_ground"] is not None:
            sog, sog_date = rows[d]["snow_on_ground"], d
            break
    return {
        "windchill_hourly": hourly or [],
        "days_since_minus30": (yesterday - date.fromisoformat(last_minus30)).days if last_minus30 else None,
        "last_minus30": last_minus30,
        "first_frost": first_frost, "first_minus10": first_minus10, "first_snow": first_snow,
        "snow_on_ground": sog, "snow_on_ground_date": sog_date,
        "season_snowfall": r1(sum(season_snow)) if season_snow else None,
    }


# ---------------------------------------------------------------- build

def build(slug: str, name: str, thread: dict, rows: dict[str, dict], ltce: dict, today: date,
          hourly: list[dict] | None, is_plus: bool) -> dict:
    clim = Climatology(rows)
    yesterday = today - timedelta(days=1)
    window = period_dates(yesterday - timedelta(days=WINDOW_DAYS - 1), yesterday)
    ltce_days = ltce.get("days", {})
    record_start = int(sorted(rows)[0][:4])

    days, record_sentences = [], []
    window_means, window_normals = [], []
    for d in window:
        row = rows.get(d.isoformat())
        n = clim.normal(d.month, d.day)
        rg = clim.range(d.month, d.day)
        ltce_day = ltce_days.get(f"{d.month:02d}-{d.day:02d}")
        flags, sentences = flags_and_sentences(d, row, ltce_day)
        record_sentences += sentences
        high, low = top(ltce_day, "high"), top(ltce_day, "low")
        m = daily_mean(row)
        if m is not None and n["max"] is not None and n["min"] is not None:
            window_means.append(m)
            window_normals.append((n["max"] + n["min"]) / 2)
        days.append({
            "date": d.isoformat(),
            "max": row["max"] if row else None, "min": row["min"] if row else None,
            "precip": row["precip"] if row else None, "gust": row["gust"] if row else None,
            "normal_max": r1(n["max"]), "normal_min": r1(n["min"]), "normal_precip": r1(n["precip"]),
            "range_max_hi": rg["max_hi"], "range_max_lo": rg["max_lo"], "range_min_hi": rg["min_hi"], "range_min_lo": rg["min_lo"],
            "record_high": high[0][0] if high else None, "record_high_year": high[0][1] if high else None,
            "record_low": low[0][0] if low else None, "record_low_year": low[0][1] if low else None,
            "flags": flags,
        })

    window_mean = mean_or_none(window_means) if len(window_means) >= 10 else None
    anomaly = (window_mean - statistics.fmean(window_normals)) if window_mean is not None else None
    summary = fmt.fortnight_summary(name, r1(window_mean), r1(anomaly), record_sentences)

    return {
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "slug": slug, "name": name, "station": thread["daily"][-1]["name"],
        "record_start": record_start,
        "normal_period": fmt.fmt_range(NORMAL_YEARS.start, NORMAL_YEARS.stop - 1),
        "range_period": fmt.fmt_range(RANGE_YEARS.start, RANGE_YEARS.stop - 1),
        "days": days,
        "month": month_period(rows, clim, yesterday, record_start),
        "season": season_period(rows, clim, yesterday, record_start),
        "alltime": {
            "high": extreme(rows, "max", True), "low": extreme(rows, "min", False),
            "wettest_day": extreme(rows, "precip", True), "windiest_gust": extreme(rows, "gust", True),
        },
        "calendar": calendar_records(ltce_days, today, 3),
        "summary": summary,
        "plus": plus_block(rows, thread, yesterday, hourly) if is_plus else None,
    }


def derive(slug: str, today: date, offline: bool) -> Path:
    community = next(c for c in ca.load_communities() if c["slug"] == slug)
    thread = ca.thread_for(slug)
    rows = ca.read_archive(ca.archive_path(slug))
    ltce = json.loads(ltce_path(slug).read_text("utf-8")) if ltce_path(slug).exists() else {}
    if not ltce:
        log.warning("%s: no LTCE file; records will be null", slug)
    is_plus = community["tier"] == "plus"
    hourly = None
    if is_plus and not offline and thread.get("hourly"):
        yesterday = today - timedelta(days=1)
        try:
            hourly = fetch_windchill_hourly(thread["hourly"]["climate_id"], yesterday - timedelta(days=WINDOW_DAYS - 1), yesterday)
        except eccc_http.FetchError as exc:
            log.warning("%s: hourly wind chill unavailable (%s)", slug, exc)
    doc = build(slug, community["name"], thread, rows, ltce, today, hourly, is_plus)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    path = HISTORY_DIR / f"{slug}.json"
    path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")
    log.info("%s: wrote %s (%d bytes)", slug, path.name, path.stat().st_size)
    return path


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--offline", action="store_true", help="skip the hourly wind chill fetch")
    parser.add_argument("--today", type=date.fromisoformat, default=None)
    parser.add_argument("slugs", nargs="*")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    today = args.today or datetime.now(TZ).date()
    for slug in (args.slugs or ca.history_slugs()):
        derive(slug, today, args.offline)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
