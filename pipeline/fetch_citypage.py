"""City Page Weather XML -> data/current.json and data/forecast/{slug}.json (plan section 4, rules 2 and 4).

Runs every 30 minutes. Never publishes a worse file than the one live:

  1. download the live current.json and forecast files from the Pages origin;
  2. for each community, take the newest XML in the newest UTC hour folder
     that has one, looking back up to six hours;
  3. overwrite only the communities fetched and parsed this run; keep the live
     entry for the rest; stamp stale=true where the observation is more than
     three hours old;
  4. if fewer than 20 of 28 communities were fetched this run, write the live
     file unchanged (or exit non-zero when there is no live file either).

    .venv/bin/python pipeline/fetch_citypage.py [--no-live] [--out DIR]
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import climate_archive as ca
import eccc_http
import formatters as fmt
from icons import glyph

log = logging.getLogger("fetch_citypage")

TZ = ZoneInfo("America/Yellowknife")
DATAMART = "https://dd.weather.gc.ca/today/citypage_weather/NT"
LIVE_BASE = os.environ.get("CABIN_WEATHER_LIVE_BASE", "https://cabinradio.github.io/cabin-weather")
DATA_DIR = ca.ROOT / "data"
MIN_FRESH = 20
STALE_AFTER = timedelta(hours=3)
LOOKBACK_HOURS = 6
FILE_RE = re.compile(r'href="((\d{8}T\d{6}\.\d+Z)_MSC_CitypageWeather_(s\d{7})_en\.xml)"')


# ---------------------------------------------------------------- small helpers

def num(text) -> float | None:
    return ca.num(text)


def text_of(parent: ET.Element | None, tag: str) -> str | None:
    if parent is None:
        return None
    el = parent.find(tag)
    if el is None or el.text is None:
        return None
    t = el.text.strip()
    return t or None


def sentence_case(text: str | None) -> str | None:
    if not text:
        return None
    return text[0].upper() + text[1:].lower()


# ECCC's spellings of community names in station names -> Style Guide spellings.
STATION_SPELLINGS = {
    "Łutselk'e": "Łútsël K'é", "Lutselk'e": "Łútsël K'é", "Lutselke": "Łútsël K'é",
    "Whatı̀": "Whatì", "Whati": "Whatì", "Deline": "Délı̨nę", "Gameti": "Gamètì",
    "Wekweeti": "Wekweètì", "Detah": "Dettah",
}
_MINUS_RE = re.compile(r"\b(minus|plus) (\d+)")


def station_name(text: str | None) -> str | None:
    """'Łutselk'e Airport' -> 'Łútsël K'é Airport'; names the guide already spells correctly pass through."""
    if not text:
        return None
    for theirs, ours in STATION_SPELLINGS.items():
        if text == theirs or text.startswith(theirs + " "):
            return ours + text[len(theirs):]
    return text


def house_prose(text: str | None) -> str | None:
    """ECCC says 'Low minus 4' and 'High plus 1'; the Style Guide says -4 and 1. Nothing else is rewritten."""
    if not text:
        return None
    return _MINUS_RE.sub(lambda m: ("-" if m.group(1) == "minus" else "") + m.group(2), text)


def utc_stamp_to_local(stamp: str | None) -> datetime | None:
    """'20261019150000' (UTC) -> aware datetime in Mountain Time."""
    if not stamp or len(stamp) < 12:
        return None
    try:
        dt = datetime.strptime(stamp[:12], "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return dt.astimezone(TZ)


def iso_minutes(dt: datetime | None) -> str | None:
    return None if dt is None else dt.isoformat(timespec="minutes")


def utc_of(parent: ET.Element | None, name: str | None = None) -> str | None:
    """The UTC timeStamp of a <dateTime zone="UTC" [name=...]> child."""
    if parent is None:
        return None
    for dt in parent.findall("dateTime"):
        if dt.attrib.get("zone") == "UTC" and (name is None or dt.attrib.get("name") == name):
            return text_of(dt, "timeStamp")
    return None


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------- parsing

def parse_current(root: ET.Element, community: dict) -> dict:
    cc = root.find("currentConditions")
    wind = cc.find("wind") if cc is not None else None
    pressure = cc.find("pressure") if cc is not None else None
    observed = utc_stamp_to_local(utc_of(cc))
    warnings = []
    w = root.find("warnings")
    if w is not None:
        url = w.attrib.get("url") or ""
        for ev in w.findall("event"):
            title = sentence_case(ev.attrib.get("description", "").strip())
            if title:
                warnings.append({"type": ev.attrib.get("type", "warning").lower(), "title": title,
                                 "url": url if url.startswith("https://") else "https://weather.gc.ca/warnings/index_e.html"})
    rise = set_ = None
    rs = root.find("riseSet")
    if rs is not None:
        rise = utc_stamp_to_local(utc_of(rs, "sunrise"))
        set_ = utc_stamp_to_local(utc_of(rs, "sunset"))
    fg = root.find("forecastGroup")
    normals = fg.find("regionalNormals") if fg is not None else None
    normal_high = normal_low = None
    if normals is not None:
        for t in normals.findall("temperature"):
            if t.attrib.get("class") == "high":
                normal_high = num(t.text)
            elif t.attrib.get("class") == "low":
                normal_low = num(t.text)
    today_high = today_low = None
    periods = fg.findall("forecast") if fg is not None else []
    for p in periods[:2]:
        name = (p.find("period").attrib.get("textForecastName") or "") if p.find("period") is not None else ""
        temps = p.find("temperatures")
        for t in (temps.findall("temperature") if temps is not None else []):
            if name == "Today" and t.attrib.get("class") == "high":
                today_high = num(t.text)
            elif name == "Tonight" and t.attrib.get("class") == "low":
                today_low = num(t.text)
    return {
        "name": community["name"], "region": community["region"], "tier": community["tier"],
        "site_code": community["site_code"],
        "eccc_url": f"https://weather.gc.ca/en/location/index.html?coords={community['lat']},{community['lon']}",
        "observed_at": iso_minutes(observed),
        "station": station_name(text_of(cc, "station")),
        "temp": num(text_of(cc, "temperature")),
        "condition": sentence_case(text_of(cc, "condition")),
        "icon": glyph(text_of(cc, "iconCode")),
        "wind_kmh": num(text_of(wind, "speed")),
        "wind_gust_kmh": num(text_of(wind, "gust")),
        "wind_dir": text_of(wind, "direction"),
        "wind_chill": num(text_of(cc, "windChill")),
        "humidex": num(text_of(cc, "humidex")),
        "humidity": num(text_of(cc, "relativeHumidity")),
        "dewpoint": num(text_of(cc, "dewpoint")),
        "pressure_kpa": num(pressure.text if pressure is not None else None),
        "pressure_tendency": (pressure.attrib.get("tendency") or None) if pressure is not None else None,
        "warnings": warnings,
        "sunrise": rise.strftime("%H:%M") if rise else None,
        "sunset": set_.strftime("%H:%M") if set_ else None,
        "today_high": today_high, "today_low": today_low,
        "normal_high": normal_high, "normal_low": normal_low,
        "stale": False,
    }


def parse_hourly(root: ET.Element) -> list[dict]:
    hg = root.find("hourlyForecastGroup")
    out = []
    for h in (hg.findall("hourlyForecast") if hg is not None else [])[:24]:
        local = utc_stamp_to_local(h.attrib.get("dateTimeUTC"))
        if local is None:
            continue
        wind = h.find("wind")
        out.append({
            "time": iso_minutes(local),
            "temp": num(text_of(h, "temperature")),
            "condition": sentence_case(text_of(h, "condition")),
            "icon": glyph(text_of(h, "iconCode")),
            "wind_kmh": num(text_of(wind, "speed")),
            "wind_gust_kmh": num(text_of(wind, "gust")),
            "wind_dir": text_of(wind, "direction"),
            "pop": num(text_of(h, "lop")),
            "wind_chill": num(text_of(h, "windChill")),
            "humidex": num(text_of(h, "humidex")),
        })
    return out


def parse_daily(root: ET.Element, issued_local: datetime) -> list[dict]:
    """One row per calendar day from ECCC's day/night periods."""
    fg = root.find("forecastGroup")
    periods = fg.findall("forecast") if fg is not None else []
    rows: dict[str, dict] = {}
    order: list[str] = []
    current = issued_local.date()
    for i, p in enumerate(periods):
        period = p.find("period")
        name = period.attrib.get("textForecastName", "") if period is not None else ""
        is_night = name == "Tonight" or name.endswith(" night")
        day_name = name.replace(" night", "")
        if name in ("Today", "Tonight"):
            d = current
        else:
            d = current
            if day_name in fmt.DAYS:
                target = fmt.DAYS.index(day_name)
                # The next date on or after `current` with that weekday; a new day name after a night moves forward.
                if not is_night and i > 0:
                    d = current + timedelta(days=1)
                while d.weekday() != target:
                    d += timedelta(days=1)
        current = d
        key = d.isoformat()
        if key not in rows:
            rows[key] = {"day": fmt.day_name(d), "date": key, "high": None, "low": None, "icon": None,
                         "day_summary": None, "night_summary": None, "day_text": None, "night_text": None, "pop": None}
            order.append(key)
        row = rows[key]
        temps = p.find("temperatures")
        for t in (temps.findall("temperature") if temps is not None else []):
            if t.attrib.get("class") == "high" and not is_night:
                row["high"] = num(t.text)
            elif t.attrib.get("class") == "low":
                row["low"] = num(t.text)
        abbr = p.find("abbreviatedForecast")
        icon = glyph(text_of(abbr, "iconCode")) if abbr is not None else "na"
        pop = num(text_of(abbr, "pop")) if abbr is not None else None
        summary = sentence_case(text_of(abbr, "textSummary")) if abbr is not None else None
        if is_night:
            row["night_text"] = house_prose(text_of(p, "textSummary"))
            row["night_summary"] = summary
            if row["icon"] is None:
                row["icon"] = icon
        else:
            row["day_text"] = house_prose(text_of(p, "textSummary"))
            row["day_summary"] = summary
            row["icon"] = icon
        if pop is not None:
            row["pop"] = pop if row["pop"] is None else max(row["pop"], pop)
    out = []
    for key in order[:7]:
        row = rows[key]
        row["icon"] = row["icon"] or "na"
        out.append(row)
    return out


def parse_citypage(xml_bytes: bytes, community: dict) -> tuple[dict, dict]:
    root = ET.fromstring(xml_bytes)
    current = parse_current(root, community)
    fg = root.find("forecastGroup")
    issued = utc_stamp_to_local(utc_of(fg)) or datetime.now(TZ)
    forecast = {
        "generated_at": now_iso(),
        "issued_at": iso_minutes(issued),
        "slug": community["slug"],
        "hourly": parse_hourly(root),
        "daily": parse_daily(root, issued),
    }
    return current, forecast


# ---------------------------------------------------------------- Datamart listing

def hour_folders(now: datetime | None = None) -> list[str]:
    now = now or datetime.now(timezone.utc)
    return [f"{(now - timedelta(hours=i)).hour:02d}" for i in range(LOOKBACK_HOURS + 1)]


def newest_files(site_codes: set[str], now: datetime | None = None) -> dict[str, str]:
    """site code -> URL of its newest English XML, searching this hour's folder then back up to six hours."""
    found: dict[str, str] = {}
    for hour in hour_folders(now):
        if len(found) == len(site_codes):
            break
        try:
            listing = eccc_http.get_text(f"{DATAMART}/{hour}/")
        except eccc_http.FetchError as exc:
            log.warning("hour folder %s unavailable: %s", hour, exc)
            continue
        newest: dict[str, tuple[str, str]] = {}
        for filename, stamp, code in FILE_RE.findall(listing):
            if code in site_codes and code not in found and (code not in newest or stamp > newest[code][0]):
                newest[code] = (stamp, filename)
        for code, (_, filename) in newest.items():
            found[code] = f"{DATAMART}/{hour}/{filename}"
    return found


# ---------------------------------------------------------------- live files and merge

def load_live(path: str) -> dict | None:
    url = f"{LIVE_BASE}/{path}"
    try:
        resp = eccc_http.get(url, {"t": int(time.time())})
    except eccc_http.FetchError as exc:
        log.warning("live %s unavailable: %s", path, exc)
        return None
    if resp.status_code != 200:
        log.info("live %s: HTTP %s (treating as absent)", path, resp.status_code)
        return None
    try:
        return resp.json()
    except ValueError:
        log.warning("live %s is not JSON", path)
        return None


def is_stale(entry: dict, now: datetime) -> bool:
    observed = entry.get("observed_at")
    if not observed:
        return True
    try:
        return now - datetime.fromisoformat(observed) > STALE_AFTER
    except ValueError:
        return True


def merge_current(live: dict | None, fetched: dict[str, dict], communities: list[dict], now: datetime) -> dict | None:
    """Combine this run's entries with the live file. None means: nothing safe to publish."""
    live_entries = (live or {}).get("communities", {}) if isinstance(live, dict) else {}
    if len(fetched) < MIN_FRESH:
        if live and len(live_entries) == len(communities):
            log.error("only %d of %d communities fetched; keeping the live file", len(fetched), len(communities))
            for entry in live_entries.values():
                entry["stale"] = is_stale(entry, now)
            return live
        log.error("only %d of %d communities fetched and no usable live file", len(fetched), len(communities))
        return None
    out = {}
    for c in communities:
        entry = fetched.get(c["slug"]) or live_entries.get(c["slug"])
        if entry is None:
            log.warning("%s: no entry this run and none live; publishing an empty entry", c["slug"])
            entry = parse_current(ET.fromstring(b"<siteData/>"), c)
        entry["stale"] = is_stale(entry, now)
        out[c["slug"]] = entry
    return {"generated_at": now_iso(), "communities": out}


def write_json(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")


# ---------------------------------------------------------------- main

def run(out_dir: Path, use_live: bool) -> int:
    communities = ca.load_communities()
    by_code = {c["site_code"]: c for c in communities}
    now = datetime.now(timezone.utc)
    live_current = load_live("data/current.json") if use_live else None

    urls = newest_files(set(by_code), now)
    missing = [by_code[c]["slug"] for c in by_code if c not in urls]
    if missing:
        log.warning("no XML in the last %d hours for: %s", LOOKBACK_HOURS, ", ".join(missing))

    def fetch_and_parse(code: str):
        return parse_citypage(eccc_http.get_bytes(urls[code]), by_code[code])

    results = eccc_http.fetch_many(sorted(urls), fetch_and_parse)
    fetched_current: dict[str, dict] = {}
    fetched_forecast: dict[str, dict] = {}
    for code, result in results.items():
        slug = by_code[code]["slug"]
        if isinstance(result, Exception):
            log.warning("%s: fetch or parse failed: %s", slug, result)
            continue
        fetched_current[slug], fetched_forecast[slug] = result

    doc = merge_current(live_current, fetched_current, communities, now)
    if doc is None:
        return 1
    write_json(out_dir / "current.json", doc)
    stale = sorted(s for s, e in doc["communities"].items() if e["stale"])
    log.info("current.json: %d of %d fetched this run, %d stale (%s)", len(fetched_current), len(communities), len(stale), ", ".join(stale) or "none")

    kept = []
    for c in communities:
        slug = c["slug"]
        path = out_dir / "forecast" / f"{slug}.json"
        if slug in fetched_forecast:
            write_json(path, fetched_forecast[slug])
        elif use_live:
            live_forecast = load_live(f"data/forecast/{slug}.json")
            if live_forecast:
                write_json(path, live_forecast)
                kept.append(slug)
            else:
                log.warning("%s: no forecast this run and none live", slug)
    log.info("forecasts: %d written fresh, %d kept from live", len(fetched_forecast), len(kept))
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-live", action="store_true", help="do not merge with the live files (local testing)")
    parser.add_argument("--out", type=Path, default=DATA_DIR)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    return run(args.out, not args.no_live)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
