"""Parsing a real City Page file, the icon map, and the never-publish-worse merge."""

import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import climate_archive as ca
import fetch_citypage as fc
import validate
from icons import glyph

FIXTURE = (Path(__file__).parent / "fixtures" / "citypage_yellowknife.xml").read_bytes()
YK = next(c for c in ca.load_communities() if c["slug"] == "yellowknife")


@pytest.fixture
def parsed():
    return fc.parse_citypage(FIXTURE, YK)


def test_current_conditions_from_fixture(parsed):
    cur, _ = parsed
    assert cur["name"] == "Yellowknife" and cur["tier"] == "plus" and cur["site_code"] == "s0000366"
    assert cur["station"] == "Yellowknife Airport"
    assert cur["observed_at"] == "2026-10-19T09:00-06:00"
    assert cur["temp"] == -3.6 and cur["condition"] == "Mostly cloudy" and cur["icon"] == "cloud"
    assert cur["wind_kmh"] == 18 and cur["wind_gust_kmh"] is None and cur["wind_dir"] == "NW"
    assert cur["wind_chill"] == -9 and cur["humidex"] is None and cur["humidity"] == 76 and cur["dewpoint"] == -7.3
    assert cur["pressure_kpa"] == 101.5 and cur["pressure_tendency"] == "rising"
    assert cur["sunrise"] == "08:34" and cur["sunset"] == "18:10"
    assert cur["today_high"] == -1 and cur["today_low"] == -4
    assert cur["normal_high"] == -1 and cur["normal_low"] == -6
    assert cur["warnings"] == [] and cur["stale"] is False
    assert cur["eccc_url"] == "https://weather.gc.ca/en/location/index.html?coords=62.45,-114.37"


def test_forecast_from_fixture(parsed):
    _, fcst = parsed
    assert fcst["slug"] == "yellowknife" and fcst["issued_at"] == "2026-10-19T05:00-06:00"
    assert len(fcst["hourly"]) == 24
    first = fcst["hourly"][0]
    assert first["time"] == "2026-10-19T10:00-06:00" and first["temp"] == -5 and first["icon"] == "part-cloud-day"
    assert first["pop"] == 0 and first["wind_kmh"] == 15 and first["wind_dir"] == "NW" and first["wind_chill"] == -11
    daily = fcst["daily"]
    assert [r["day"] for r in daily] == ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    assert daily[0]["date"] == "2026-10-19" and daily[0]["high"] == -1 and daily[0]["low"] == -4
    assert daily[0]["day_summary"] == "Chance of flurries" and daily[0]["pop"] == 30
    assert daily[0]["night_text"].startswith("Partly cloudy.") and "minus" not in daily[0]["night_text"]
    assert daily[-1]["night_text"] is None and daily[-1]["low"] is None     # ECCC's seventh day has no night period
    assert validate.validate(fcst, validate.load_schema("forecast")) == []


def test_fixture_current_validates_inside_a_full_file(parsed):
    cur, _ = parsed
    doc = {"generated_at": "2026-10-19T16:00:00Z", "communities": {c["slug"]: dict(cur, name=c["name"], region=c["region"], tier=c["tier"], site_code=c["site_code"]) for c in ca.load_communities()}}
    assert validate.validate(doc, validate.load_schema("current")) == []


def test_empty_condition_and_icon_show_temperature_only():
    xml = FIXTURE.replace(b"<condition>Mostly Cloudy</condition>", b"<condition/>").replace(b'<iconCode format="gif">03</iconCode>', b"<iconCode/>", 1)
    cur, _ = fc.parse_citypage(xml, YK)
    assert cur["temp"] == -3.6 and cur["condition"] is None and cur["icon"] == "na"


def test_forecast_only_site_gives_nulls_not_a_crash():
    xml = FIXTURE.replace(FIXTURE[FIXTURE.index(b"<currentConditions>"):FIXTURE.index(b"</currentConditions>") + len(b"</currentConditions>")], b"<currentConditions/>")
    cur, fcst = fc.parse_citypage(xml, YK)
    assert cur["temp"] is None and cur["station"] is None and cur["observed_at"] is None and cur["icon"] == "na"
    assert len(fcst["daily"]) == 7


def test_icon_map_never_breaks():
    assert glyph("03") == "cloud" and glyph("00") == "sun" and glyph("30") == "moon" and glyph("14") == "freezing-rain"
    assert glyph("") == "na" and glyph(None) == "na" and glyph("99") == "na" and glyph("xx") == "na"


def test_station_spelling_and_prose_follow_the_style_guide():
    assert fc.station_name("Łutselk'e Airport") == "Łútsël K'é Airport"
    assert fc.station_name("Whatı̀") == "Whatì"
    assert fc.station_name("Deline Airport") == "Délı̨nę Airport"
    assert fc.station_name("Yellowknife Airport") == "Yellowknife Airport"
    assert fc.house_prose("Low minus 4. High plus 1. Wind chill near minus 12.") == "Low -4. High 1. Wind chill near -12."
    assert fc.house_prose(None) is None


def test_warnings_parse():
    xml = FIXTURE.replace(b"<warnings/>", b'<warnings url="https://weather.gc.ca/warnings/report_e.html?nt24"><event type="warning" priority="high" description="WIND WARNING" expiryTime="202610200000"/></warnings>')
    cur, _ = fc.parse_citypage(xml, YK)
    assert cur["warnings"] == [{"type": "warning", "title": "Wind warning", "url": "https://weather.gc.ca/warnings/report_e.html?nt24"}]


# Never publish a worse file than the one live.
def make_live(now):
    cur, _ = fc.parse_citypage(FIXTURE, YK)
    cur["observed_at"] = (now - timedelta(hours=1)).isoformat(timespec="minutes")
    return {"generated_at": "x", "communities": {c["slug"]: dict(cur, name=c["name"], region=c["region"], tier=c["tier"], site_code=c["site_code"]) for c in ca.load_communities()}}


def test_merge_keeps_live_entries_for_failed_communities():
    now = datetime.now(timezone.utc)
    live = make_live(now)
    communities = ca.load_communities()
    fetched = {}
    for c in communities[:22]:
        entry = copy.deepcopy(live["communities"][c["slug"]])
        entry["temp"] = 99.0
        entry["observed_at"] = now.isoformat(timespec="minutes")
        fetched[c["slug"]] = entry
    doc = fc.merge_current(live, fetched, communities, now)
    assert len(doc["communities"]) == 28
    assert doc["communities"][communities[0]["slug"]]["temp"] == 99.0
    assert doc["communities"][communities[27]["slug"]]["temp"] == -3.6        # kept from live
    assert not doc["communities"][communities[27]["slug"]]["stale"]           # observed an hour ago


def test_merge_refuses_with_too_few_fresh_and_no_live():
    now = datetime.now(timezone.utc)
    communities = ca.load_communities()
    live = make_live(now)
    fetched = {c["slug"]: copy.deepcopy(live["communities"][c["slug"]]) for c in communities[:19]}
    assert fc.merge_current(None, fetched, communities, now) is None
    kept = fc.merge_current(live, fetched, communities, now)
    assert kept is live                                                      # the live file, untouched apart from stale flags


def test_stale_stamping():
    now = datetime.now(timezone.utc)
    live = make_live(now)
    old = (now - timedelta(hours=4)).isoformat(timespec="minutes")
    for e in live["communities"].values():
        e["observed_at"] = old
    communities = ca.load_communities()
    fetched = {c["slug"]: copy.deepcopy(live["communities"][c["slug"]]) for c in communities}
    doc = fc.merge_current(live, fetched, communities, now)
    assert all(e["stale"] for e in doc["communities"].values())
    assert fc.is_stale({"observed_at": None}, now) is True


def test_hour_folders_walk_back_six_hours():
    assert fc.hour_folders(datetime(2026, 10, 19, 2, 10, tzinfo=timezone.utc)) == ["02", "01", "00", "23", "22", "21", "20"]
    listing = '<a href="20261019T150127.857Z_MSC_CitypageWeather_s0000366_en.xml">x</a> <a href="20261019T153000.000Z_MSC_CitypageWeather_s0000366_en.xml">y</a> <a href="20261019T150127.944Z_MSC_CitypageWeather_s0000366_fr.xml">z</a>'
    found = fc.FILE_RE.findall(listing)
    assert [f[2] for f in found] == ["s0000366", "s0000366"] and max(f[1] for f in found).startswith("20261019T153000")
