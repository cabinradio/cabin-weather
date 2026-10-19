"""derive.py on a synthetic archive with known answers."""

from datetime import date, timedelta

import derive
import validate


def make_rows(first: date, last: date, max_fn, min_fn, precip=0.0, gust=None, snow=None, sog=None):
    rows = {}
    d = first
    while d <= last:
        rows[d.isoformat()] = {
            "date": d.isoformat(), "source_station": "T", "max": max_fn(d), "min": min_fn(d),
            "mean": None, "precip": precip, "rain": None, "snow": snow(d) if callable(snow) else snow,
            "snow_on_ground": sog(d) if callable(sog) else sog, "gust": gust(d) if callable(gust) else gust,
            "gust_dir": None, "max_flag": "", "min_flag": "", "precip_flag": "",
        }
        d += timedelta(days=1)
    return rows


# Normals: 1991–2020 smoothed; null with fewer than 20 years in the window.
def test_normals_are_the_thirty_year_mean_and_null_when_thin():
    rows = make_rows(date(1991, 1, 1), date(2020, 12, 31), lambda d: 10.0 + (d.year - 1991) % 2, lambda d: -5.0)
    clim = derive.Climatology(rows)
    n = clim.normal(10, 15)
    assert abs(n["max"] - 10.5) < 1e-9 and n["min"] == -5.0 and n["precip"] == 0.0
    thin = derive.Climatology(make_rows(date(2001, 1, 1), date(2019, 12, 31), lambda d: 10.0, lambda d: -5.0))
    assert thin.normal(10, 15) == {"max": None, "min": None, "precip": None}


# Range: exact calendar day over 2006–2025; null unless all 20 years present.
def test_range_needs_all_twenty_years():
    rows = make_rows(date(2006, 1, 1), date(2025, 12, 31), lambda d: float(d.year - 2000), lambda d: float(d.year - 2030))
    clim = derive.Climatology(rows)
    assert clim.range(7, 1) == {"max_hi": 25.0, "max_lo": 6.0, "min_hi": -5.0, "min_lo": -24.0}
    del rows["2013-07-01"]
    clim = derive.Climatology(rows)
    assert clim.range(7, 1) == {"max_hi": None, "max_lo": None, "min_hi": None, "min_lo": None}
    assert clim.range(7, 2)["max_hi"] == 25.0


# Record flags compare against the LTCE top five, ignoring this year's own entry.
def test_compare_record_top3_and_tie():
    ranked = [[14.4, 1963], [13.9, 1988], [12.0, 2001], [11.5, 1950], [11.0, 1999]]
    assert derive.compare(15.0, ranked, True, 2026) == ("record", [14.4, 1963])
    assert derive.compare(14.4, ranked, True, 2026) == ("record", [14.4, 1963])      # a tie counts
    assert derive.compare(12.5, ranked, True, 2026) == ("top3", [14.4, 1963])
    assert derive.compare(11.9, ranked, True, 2026) == (None, [14.4, 1963])
    assert derive.compare(None, ranked, True, 2026) == (None, None)
    # LTCE already lists this year's record: compare against the previous holder instead.
    updated = [[15.0, 2026], [14.4, 1963], [13.9, 1988], [12.0, 2001], [11.5, 1950]]
    assert derive.compare(15.0, updated, True, 2026) == ("record", [14.4, 1963])
    lows = [[-20.6, 1959], [-16.1, 1961], [-15.6, 1951]]
    assert derive.compare(-21.0, lows, False, 2026) == ("record", [-20.6, 1959])
    assert derive.compare(-15.6, lows, False, 2026) == ("top3", [-20.6, 1959])


def test_flags_and_sentences_use_house_style():
    ltce_day = {"high": [[14.4, 1963]], "low": [[-20.6, 1959]], "warm_low": [[3.3, 2023]], "cold_high": [[-9.7, 2004]]}
    row = {"max": 14.4, "min": 3.5}
    flags, sentences = derive.flags_and_sentences(date(2026, 10, 12), row, ltce_day)
    assert flags == ["record_high", "record_warm_low"]
    assert sentences[0] == "The high of 14.4C on October 12 was a record for the date, matching 14.4C from 1963."
    assert sentences[1].startswith("The overnight low of 3.5C on October 12 was the warmest overnight low recorded for the date, passing 3.3C from 2023")
    assert derive.flags_and_sentences(date(2026, 10, 12), None, ltce_day) == ([], [])


# Month so far: mean, normal, rank among years with enough data, coldest/warmest on record.
def test_month_period_rank_and_records():
    # 1991–2025: October mean = year - 2000 (so 2025 is warmest at 25, 1991 coldest at -9); 2026 so far = 20.
    rows = make_rows(date(1991, 1, 1), date(2025, 12, 31), lambda d: float(d.year - 2000) + 1, lambda d: float(d.year - 2000) - 1, precip=1.0)
    rows.update(make_rows(date(2026, 1, 1), date(2026, 10, 18), lambda d: 21.0, lambda d: 19.0, precip=0.5))
    clim = derive.Climatology(rows)
    m = derive.month_period(rows, clim, date(2026, 10, 18), 1991)
    assert m["name"] == "October" and m["label"] == "October 1–18" and m["days"] == 18
    assert m["mean"] == 20.0
    assert m["normal"] == 5.5            # mean of 1991..2020 means (-9..20)
    assert m["anomaly"] == 14.5
    assert m["rank"] == 6 and m["of"] == 36   # 2021..2025 are warmer
    assert m["rank_text"] == "6th warmest October 1–18 in 36 years"
    assert m["record_warm"] == {"value": 25.0, "year": 2025}
    assert m["record_cold"] == {"value": -9.0, "year": 1991}
    assert m["precip"] == 9.0 and m["precip_normal"] == 18.0 and m["wettest_rank"] == 36
    assert m["record_wet"] == {"value": 18.0, "year": 2025}


def test_month_too_thin_gives_null_mean_and_rank():
    rows = make_rows(date(1991, 1, 1), date(2025, 12, 31), lambda d: 5.0, lambda d: 0.0)
    rows.update(make_rows(date(2026, 10, 1), date(2026, 10, 5), lambda d: 5.0, lambda d: 0.0))  # 5 of 18 days
    m = derive.month_period(rows, derive.Climatology(rows), date(2026, 10, 18), 1991)
    assert m["mean"] is None and m["rank"] is None and m["of"] is None and m["rank_text"] is None


def test_cold_half_of_the_ranking_reads_as_coldest():
    rows = make_rows(date(1991, 1, 1), date(2025, 12, 31), lambda d: float(d.year - 2000) + 1, lambda d: float(d.year - 2000) - 1)
    rows.update(make_rows(date(2026, 1, 1), date(2026, 10, 18), lambda d: -7.0, lambda d: -9.0))
    m = derive.month_period(rows, derive.Climatology(rows), date(2026, 10, 18), 1991)
    assert m["rank"] == 34 and m["of"] == 36
    assert m["rank_text"] == "3rd coldest October 1–18 in 36 years"


# Seasons are meteorological; winter runs December to February across the year end.
def test_season_period_crosses_the_year_end():
    rows = make_rows(date(1991, 1, 1), date(2026, 1, 15), lambda d: 0.0, lambda d: -10.0)
    s = derive.season_period(rows, derive.Climatology(rows), date(2026, 1, 15), 1991)
    assert s["name"] == "winter" and s["label"] == "winter so far"
    assert s["from"] == "2025-12-01" and s["to_date"] == "2026-01-15" and s["days"] == 46
    a = derive.season_period(rows, derive.Climatology(rows), date(2025, 11, 30), 1991)
    assert a["name"] == "autumn" and a["label"] == "autumn" and a["from"] == "2025-09-01"


# Plus tier: days since -30C, first frost, first -10C, first snow, snow on ground, season snowfall.
def test_plus_block():
    rows = make_rows(date(2026, 1, 1), date(2026, 10, 18),
                     lambda d: 10.0, lambda d: -35.0 if d == date(2026, 3, 25) else (-12.0 if d == date(2026, 10, 10) else (-1.0 if d >= date(2026, 9, 16) else 5.0)),
                     snow=lambda d: 2.5 if d == date(2026, 10, 14) else 0.0,
                     sog=lambda d: 3.0 if d == date(2026, 10, 15) else None)
    p = derive.plus_block(rows, {}, date(2026, 10, 18), None)
    assert p["last_minus30"] == "2026-03-25" and p["days_since_minus30"] == 207
    assert p["first_frost"] == "2026-09-16" and p["first_minus10"] == "2026-10-10"
    assert p["first_snow"] == "2026-10-14" and p["season_snowfall"] == 2.5
    assert p["snow_on_ground"] == 3.0 and p["snow_on_ground_date"] == "2026-10-15"
    assert p["windchill_hourly"] == []


def test_local_iso_converts_utc_to_mountain_time():
    assert derive.local_iso("2026-10-19T06:00:00") == "2026-10-19T00:00-06:00"   # MDT
    assert derive.local_iso("2025-12-19T07:00:00") == "2025-12-19T00:00-07:00"   # MST


# End to end: a synthetic archive builds a document the schema accepts.
def test_build_validates_against_schema():
    rows = make_rows(date(1942, 7, 1), date(2026, 10, 18), lambda d: float(10 + (d.month - 6) * 2), lambda d: float(-5 + (d.month - 6) * 2),
                     precip=0.2, gust=lambda d: 40.0 if d.day == 1 else None)
    ltce = {"days": {f"{m:02d}-{dd:02d}": {"high": [[30.0, 1950]], "low": [[-40.0, 1951]], "warm_low": [[9.0, 1952]],
                                           "cold_high": [[-30.0, 1953]], "precip": [[20.0, 1954]]}
                     for m in range(1, 13) for dd in range(1, 32)}}
    thread = {"daily": [{"climate_id": "X", "stn_id": 1, "name": "Test A", "from": "1942-07-01", "to": None}]}
    doc = derive.build("yellowknife", "Yellowknife", thread, rows, ltce, date(2026, 10, 19), [], True)
    assert validate.validate(doc, validate.load_schema("history")) == []
    assert doc["record_start"] == 1942 and len(doc["days"]) == 14
    assert doc["days"][0]["date"] == "2026-10-05" and doc["days"][-1]["date"] == "2026-10-18"
    assert doc["calendar"][0]["date"] == "2026-10-19" and doc["calendar"][0]["record_high"] == 30.0
    assert doc["summary"].startswith("The past two weeks in Yellowknife averaged 10.5C, close to normal.")
    assert doc["plus"]["days_since_minus30"] is None
    doc2 = derive.build("fort-smith", "Fort Smith", thread, rows, ltce, date(2026, 10, 19), None, False)
    assert doc2["plus"] is None
    assert validate.validate(doc2, validate.load_schema("history")) == []
