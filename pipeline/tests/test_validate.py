"""The validator accepts a correct file and rejects a hand-corrupted one."""

import copy
import json

import pytest

import validate


def community(name="Yellowknife", region="North Slave", tier="plus", site="s0000366"):
    return {
        "name": name, "region": region, "tier": tier, "site_code": site,
        "eccc_url": "https://weather.gc.ca/en/location/index.html?coords=62.45,-114.37",
        "observed_at": "2026-10-19T09:00:00-06:00", "station": "Yellowknife Airport",
        "temp": -3.6, "condition": "Mostly cloudy", "icon": "cloudy",
        "wind_kmh": 18, "wind_gust_kmh": None, "wind_dir": "NW",
        "wind_chill": -9, "humidex": None, "humidity": 76, "dewpoint": -7.3,
        "pressure_kpa": 101.5, "pressure_tendency": "rising",
        "warnings": [{"type": "warning", "title": "Wind warning", "url": "https://weather.gc.ca/warnings/report_e.html?nt24"}],
        "sunrise": "08:34", "sunset": "18:10",
        "today_high": -1, "today_low": -4, "normal_high": -1, "normal_low": -6,
        "stale": False,
    }


@pytest.fixture
def current():
    cfg = json.loads((validate.SCHEMAS.parent / "config" / "communities.json").read_text("utf-8"))
    return {
        "generated_at": "2026-10-19T15:40:00Z",
        "communities": {c["slug"]: community(c["name"], c["region"], c["tier"], c["site_code"]) for c in cfg["communities"]},
    }


def test_valid_current_passes(current):
    assert validate.validate(current, validate.load_schema("current")) == []


def test_corrupted_current_fails(current):
    bad = copy.deepcopy(current)
    bad["communities"]["yellowknife"]["temp"] = "-3.6"          # a string where a number belongs
    del bad["communities"]["inuvik"]["stale"]                   # a missing required key
    bad["communities"]["hay-river"]["pressure_tendency"] = "up"  # not in the enum
    bad["communities"]["fort-smith"]["extra"] = 1                # an unexpected key
    bad["communities"]["tulita"]["sunrise"] = "8:34am"           # wrong clock format
    del bad["generated_at"]
    problems = validate.validate(bad, validate.load_schema("current"))
    joined = "\n".join(problems)
    assert "yellowknife.temp" in joined and "expected number or null" in joined
    assert "inuvik: missing required key 'stale'" in joined
    assert "hay-river.pressure_tendency" in joined
    assert "fort-smith: unexpected key 'extra'" in joined
    assert "tulita.sunrise" in joined
    assert "missing required key 'generated_at'" in joined


def test_wrong_community_count_fails(current):
    bad = copy.deepcopy(current)
    del bad["communities"]["whati"]
    assert any("fewer than 28" in p for p in validate.validate(bad, validate.load_schema("current")))


def test_nan_is_rejected():
    schema = {"type": "object", "properties": {"x": {"type": ["number", "null"]}}}
    assert validate.validate({"x": float("nan")}, schema) != []
    assert validate.validate({"x": None}, schema) == []


def test_check_file_rejects_hand_corrupted_file(tmp_path, current, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(validate, "DATA", data)
    good = data / "current.json"
    good.write_text(json.dumps(current), "utf-8")
    assert validate.check_file(good) == []
    corrupted = json.dumps(current).replace('"stale": false', '"stale": "no"', 1)
    good.write_text(corrupted, "utf-8")
    assert any("stale" in p for p in validate.check_file(good))
    good.write_text("{not json", "utf-8")
    assert any("cannot read as JSON" in p for p in validate.check_file(good))


def test_history_schema_accepts_minimal_valid_file():
    day = {k: None for k in ["max", "min", "precip", "gust", "normal_max", "normal_min", "range_max_hi", "range_max_lo",
                             "range_min_hi", "range_min_lo", "record_high", "record_high_year", "record_low", "record_low_year"]}
    period = {"name": "October", "label": "October 1–18", "from": "2026-10-01", "to_date": "2026-10-18", "days": 18,
              "mean": 2.9, "normal": 1.2, "anomaly": 1.7, "rank": 23, "of": 84, "rank_text": "23rd warmest October 1–18 in 84 years",
              "precip": 1.0, "precip_normal": 12.0, "wettest_rank": 70,
              "record_warm": {"value": 6.5, "year": 2023}, "record_cold": {"value": -8.1, "year": 1959}, "record_wet": {"value": 40.2, "year": 1988}}
    instance = {
        "generated_at": "2026-10-19T09:10:00Z", "slug": "yellowknife", "name": "Yellowknife", "station": "Yellowknife A",
        "record_start": 1942, "normal_period": "1991–2020", "range_period": "2006–2025",
        "days": [dict(day, date=f"2026-10-{d:02d}", flags=[]) for d in range(5, 19)],
        "month": period, "season": period,
        "alltime": {k: {"value": None, "date": None} for k in ["high", "low", "wettest_day", "windiest_gust"]},
        "calendar": [{"date": "2026-10-19", "record_high": 8.3, "record_high_year": 1952, "record_low": -20.6, "record_low_year": 1959,
                      "record_precip": 12.7, "record_precip_year": 1964}],
        "summary": None, "plus": None,
    }
    assert validate.validate(instance, validate.load_schema("history")) == []
    instance["normal_period"] = "1981-2010"
    assert validate.validate(instance, validate.load_schema("history")) != []
