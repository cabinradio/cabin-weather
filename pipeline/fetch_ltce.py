"""Daily records from ECCC's Long Term Climate Extremes (LTCE) -> archive/ltce/{slug}.json.

For each history community's virtual station: the top five highs, lows,
warmest lows and coldest highs for every calendar day (ltce-temperature),
the top five wettest days (ltce-precipitation) and, for Yellowknife only, the
snowiest (ltce-snowfall). Values are [value, year] pairs, best first.

A file is only rewritten when the fetch is complete (366 calendar days of
temperature records); otherwise the committed file is kept and the run
continues.

    .venv/bin/python pipeline/fetch_ltce.py [slug ...]
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

import climate_archive as ca
import eccc_http

log = logging.getLogger("fetch_ltce")

API = "https://api.weather.gc.ca/collections"
LTCE_DIR = ca.ARCHIVE_DIR / "ltce"
RANKS = ["FIRST", "SECOND", "THIRD", "FOURTH", "FIFTH"]

# key in our file -> (field stem, year suffix) in ltce-temperature
TEMP_ELEMENTS = {
    "high": ("HIGH_MAX_TEMP", "YEAR"),
    "low": ("LOW_MIN_TEMP", "YEAR"),
    "warm_low": ("HIGH_MIN_TEMP", "YEAR"),
    "cold_high": ("LOW_MAX_TEMP", "YEAR"),
}


def top5(props: dict, stem: str, year_suffix: str) -> list[list]:
    """[[value, year], ...] for the five ranked fields of one element, skipping empty ranks."""
    out = []
    for rank in RANKS:
        value = props.get(f"{rank}_{stem}")
        year = props.get(f"{rank}_{stem}_{year_suffix}")
        if value is None or year is None:
            continue
        out.append([float(value), int(year)])
    return out


def key_for(props: dict) -> str:
    return f"{int(props['LOCAL_MONTH']):02d}-{int(props['LOCAL_DAY']):02d}"


def fetch_collection(name: str, virtual_id: str) -> list[dict]:
    data = eccc_http.get_json(f"{API}/{name}/items", {"VIRTUAL_CLIMATE_ID": virtual_id, "f": "json", "limit": 1000})
    return [f["properties"] for f in data.get("features", [])]


def build(virtual_id: str, temperature: list[dict], precipitation: list[dict], snowfall: list[dict] | None) -> dict:
    days: dict[str, dict] = {}
    meta = {"wxo_city_code": None, "record_begin": None}
    for p in temperature:
        day = days.setdefault(key_for(p), {})
        for key, (stem, year_suffix) in TEMP_ELEMENTS.items():
            day[key] = top5(p, stem, year_suffix)
        meta["wxo_city_code"] = meta["wxo_city_code"] or p.get("WXO_CITY_CODE")
        begin = p.get("MAX_TEMP_RECORD_BEGIN")
        if begin and (meta["record_begin"] is None or begin < meta["record_begin"]):
            meta["record_begin"] = begin
    for p in precipitation:
        days.setdefault(key_for(p), {})["precip"] = top5(p, "PRECIPITATION", "YEAR")
    for p in snowfall or []:
        days.setdefault(key_for(p), {})["snow"] = top5(p, "SNOWFALL", "YEAR")
    return {
        "fetched_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "virtual_id": virtual_id,
        "wxo_city_code": meta["wxo_city_code"],
        "record_begin": (meta["record_begin"] or "")[:10] or None,
        "days": dict(sorted(days.items())),
    }


def ltce_path(slug: str) -> Path:
    return LTCE_DIR / f"{slug}.json"


def update(slug: str) -> bool:
    thread = ca.thread_for(slug)
    virtual_id = thread["ltce"]
    want_snow = slug == "yellowknife"
    try:
        temperature = fetch_collection("ltce-temperature", virtual_id)
        precipitation = fetch_collection("ltce-precipitation", virtual_id)
        snowfall = fetch_collection("ltce-snowfall", virtual_id) if want_snow else None
    except eccc_http.FetchError as exc:
        log.error("%s: LTCE fetch failed, keeping the committed file (%s)", slug, exc)
        return False
    if len(temperature) < 366:
        log.error("%s: only %d temperature days (want 366), keeping the committed file", slug, len(temperature))
        return False
    if len(precipitation) < 366:
        log.warning("%s: only %d precipitation days", slug, len(precipitation))
    doc = build(virtual_id, temperature, precipitation, snowfall)
    path = ltce_path(slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")
    log.info("%s: wrote %s (%d days, %d bytes)", slug, path.name, len(doc["days"]), path.stat().st_size)
    return True


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    results = {slug: update(slug) for slug in (argv or ca.history_slugs())}
    log.info("done: %s", ", ".join(f"{s}={'ok' if r else 'kept'}" for s, r in results.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
