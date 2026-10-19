"""Phase 0 discovery check for Cabin Weather.

Reads pipeline/config/communities.json and pipeline/config/stations.json and
checks them against live ECCC data:

  * every community's City Page site code exists in ECCC's site list;
  * every climate station in each thread exists in GeoMet's climate-stations
    collection, with the first and last daily dates ECCC reports;
  * the thread matches ECCC's own LTCE threading for that virtual station;
  * the current station in each thread has daily data in climate-daily, and
    the last 14 days are printed so they can be eyeballed against weather.gc.ca.

Stdlib only so it runs before the virtual environment exists. Exits non-zero
if any check fails. Run from the repo root:

    python3 pipeline/discover_stations.py
"""

from __future__ import annotations

import csv
import io
import json
import sys
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API = "https://api.weather.gc.ca/collections"
SITE_LIST = "https://dd.weather.gc.ca/today/citypage_weather/docs/site_list_en.csv"
USER_AGENT = "CabinWeather/0.1 (+https://cabinradio.ca)"
TIMEOUT = 20


def get(url: str, params: dict | None = None) -> bytes:
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def get_json(url: str, params: dict | None = None) -> dict:
    return json.loads(get(url, params))


def load_config() -> tuple[dict, dict]:
    communities = json.loads((ROOT / "config" / "communities.json").read_text("utf-8"))
    stations = json.loads((ROOT / "config" / "stations.json").read_text("utf-8"))
    return communities, stations


def check_site_codes(communities: dict) -> list[str]:
    problems = []
    text = get(SITE_LIST).decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    # Header row is "Codes,English Names,Province Codes,Latitude,Longitude"
    by_code = {r[0]: r for r in rows[1:] if len(r) >= 3}
    print("== City Page site codes ==")
    for c in communities["communities"]:
        row = by_code.get(c["site_code"])
        if not row:
            problems.append(f"{c['slug']}: site code {c['site_code']} not in site list")
            print(f"  MISSING {c['slug']} {c['site_code']}")
            continue
        if row[2] != "NT":
            problems.append(f"{c['slug']}: site code {c['site_code']} is in {row[2]}, not NT")
        print(f"  ok  {c['name']:<16} {c['site_code']}  ECCC name: {row[1]}  ({row[3]}, {row[4]})")
    nt_rows = [r for r in rows[1:] if len(r) >= 3 and r[2] == "NT"]
    used = {c["site_code"] for c in communities["communities"]}
    unused = [r[1] for r in nt_rows if r[0] not in used]
    print(f"  {len(nt_rows)} NT sites in ECCC list, {len(used)} used, unused: {', '.join(unused)}")
    return problems


def fetch_climate_stations() -> dict[str, dict]:
    data = get_json(f"{API}/climate-stations/items", {"PROV_STATE_TERR_CODE": "NT", "f": "json", "limit": 1000})
    return {f["properties"]["CLIMATE_IDENTIFIER"]: f["properties"] for f in data["features"]}


def fetch_ltce_threads() -> dict[str, list[dict]]:
    data = get_json(f"{API}/ltce-stations/items", {"PROVINCE_CODE": "NT", "f": "json", "limit": 1000})
    threads: dict[str, list[dict]] = {}
    for f in data["features"]:
        p = f["properties"]
        if p.get("ELEMENT_NAME_E") != "DAILY MAXIMUM TEMPERATURE":
            continue
        threads.setdefault(p["VIRTUAL_CLIMATE_ID"], []).append(p)
    for v in threads.values():
        v.sort(key=lambda p: p.get("START_DATE") or "")
    return threads


def fetch_last_days(climate_id: str, days: int = 14) -> list[dict]:
    end = date.today()
    start = end - timedelta(days=days)
    data = get_json(
        f"{API}/climate-daily/items",
        {
            "CLIMATE_IDENTIFIER": climate_id,
            "datetime": f"{start.isoformat()}/{end.isoformat()}",
            "sortby": "LOCAL_DATE",
            "f": "json",
            "limit": 100,
        },
    )
    return [f["properties"] for f in data["features"]]


def fmt(v) -> str:
    return "  -  " if v is None else f"{v:>5}"


def check_threads(communities: dict, stations: dict) -> list[str]:
    problems = []
    by_climate_id = fetch_climate_stations()
    ltce = fetch_ltce_threads()
    names = {c["climate"]: c["name"] for c in communities["communities"] if c.get("climate")}
    for key, cfg in stations["stations"].items():
        print(f"\n== {names.get(key, key)} (LTCE {cfg['ltce']}) ==")
        chain = cfg["daily"]
        for s in chain:
            meta = by_climate_id.get(s["climate_id"])
            if not meta:
                problems.append(f"{key}: climate id {s['climate_id']} not in climate-stations")
                print(f"  MISSING {s['climate_id']}")
                continue
            if meta["STN_ID"] != s["stn_id"]:
                problems.append(f"{key}: {s['climate_id']} STN_ID is {meta['STN_ID']}, config says {s['stn_id']}")
            first = (meta.get("DLY_FIRST_DATE") or "")[:10]
            last = (meta.get("DLY_LAST_DATE") or "")[:10]
            print(
                f"  {s['climate_id']}  STN_ID {meta['STN_ID']:<6} {meta['STATION_NAME']:<24} "
                f"daily {first} -> {last}  hourly: {meta.get('HAS_HOURLY_DATA')}  "
                f"config: {s['from']} -> {s['to'] or 'present'}"
            )
        # Compare with ECCC's LTCE threading (collapse LTCE's split segments of one station).
        ltce_chain = []
        for seg in ltce.get(cfg["ltce"], []):
            if not ltce_chain or ltce_chain[-1] != seg["CLIMATE_IDENTIFIER"]:
                ltce_chain.append(seg["CLIMATE_IDENTIFIER"])
        ours = [s["climate_id"] for s in chain]
        if ltce_chain != ours:
            problems.append(f"{key}: config thread {ours} differs from LTCE thread {ltce_chain}")
            print(f"  LTCE thread differs: {ltce_chain}")
        else:
            print(f"  LTCE thread matches ({len(ltce_chain)} stations)")
        wxo = next((seg.get("WXO_CITY_CODE") for seg in ltce.get(cfg["ltce"], []) if seg.get("WXO_CITY_CODE")), None)
        if wxo:
            print(f"  WXO city code: {wxo}")
        # Last 14 days from the current station.
        current = chain[-1]
        rows = fetch_last_days(current["climate_id"])
        if not rows:
            problems.append(f"{key}: no climate-daily rows in the last 14 days for {current['climate_id']}")
            print("  NO RECENT DAILY DATA")
            continue
        print(f"  last {len(rows)} days from {current['climate_id']} ({rows[0]['STATION_NAME']}):")
        print("    date         max    min  precip  gust")
        for r in rows:
            print(
                f"    {r['LOCAL_DATE'][:10]}  {fmt(r.get('MAX_TEMPERATURE'))}  {fmt(r.get('MIN_TEMPERATURE'))}  "
                f"{fmt(r.get('TOTAL_PRECIPITATION'))}  {fmt(r.get('SPEED_MAX_GUST'))}"
            )
        complete = [r for r in rows if r.get("MAX_TEMPERATURE") is not None]
        if not complete:
            problems.append(f"{key}: all recent rows have null MAX_TEMPERATURE")
        hourly = cfg.get("hourly")
        if hourly:
            meta = by_climate_id.get(hourly["climate_id"], {})
            if meta.get("HAS_HOURLY_DATA") != "Y":
                problems.append(f"{key}: hourly station {hourly['climate_id']} has no hourly data")
            else:
                print(f"  hourly station {hourly['climate_id']} has hourly data to {(meta.get('HLY_LAST_DATE') or '')[:10]}")
    return problems


def main() -> int:
    communities, stations = load_config()
    problems = []
    problems += check_site_codes(communities)
    problems += check_threads(communities, stations)
    print()
    if problems:
        print("PROBLEMS:")
        for p in problems:
            print("  -", p)
        return 1
    print("All Phase 0 checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
