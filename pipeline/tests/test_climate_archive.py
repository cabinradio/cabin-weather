"""Normalizing ECCC rows, the bulk-CSV fallback, and the merge into the committed archive."""

from datetime import date
from pathlib import Path

import climate_archive as ca

FIXTURES = Path(__file__).parent / "fixtures"


def api_props(d="2026-10-17", **over):
    props = {
        "LOCAL_DATE": f"{d} 00:00:00", "CLIMATE_IDENTIFIER": "2204101",
        "MAX_TEMPERATURE": 9.7, "MIN_TEMPERATURE": 0.2, "MEAN_TEMPERATURE": 5.0,
        "TOTAL_PRECIPITATION": 0.0, "TOTAL_RAIN": 0.0, "TOTAL_SNOW": 0.0, "SNOW_ON_GROUND": None,
        "SPEED_MAX_GUST": 39, "DIRECTION_MAX_GUST": 15,
        "MAX_TEMPERATURE_FLAG": None, "MIN_TEMPERATURE_FLAG": None, "TOTAL_PRECIPITATION_FLAG": "T",
    }
    props.update(over)
    return props


def test_row_from_api_normalizes_and_drops_empty_rows():
    row = ca.row_from_api(api_props())
    assert row["date"] == "2026-10-17" and row["source_station"] == "2204101"
    assert row["max"] == 9.7 and row["gust"] == 39.0 and row["snow_on_ground"] is None
    assert row["precip"] == 0.0 and row["precip_flag"] == "T"
    empty = api_props(MAX_TEMPERATURE=None, MIN_TEMPERATURE=None, MEAN_TEMPERATURE=None, TOTAL_PRECIPITATION=None,
                      TOTAL_RAIN=None, TOTAL_SNOW=None, SPEED_MAX_GUST=None, DIRECTION_MAX_GUST=None)
    assert ca.row_from_api(empty) is None


def test_gust_under_threshold_is_null():
    assert ca.num("<31") is None
    assert ca.num("") is None
    assert ca.num("42") == 42.0
    assert ca.num(7) == 7.0


def test_bulk_csv_fixture_matches_api_values():
    text = (FIXTURES / "bulk_daily_sample.csv").read_text("utf-8")
    rows = ca.rows_from_bulk_csv(text, "2204101")
    by_date = {r["date"]: r for r in rows}
    assert set(by_date) == {"2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"}
    r = by_date["2026-10-17"]
    assert r["max"] == 9.7 and r["min"] == 0.2 and r["mean"] == 5.0
    assert r["precip"] == 0.0 and r["precip_flag"] == "T"
    assert r["gust"] == 39.0 and r["gust_dir"] == 15.0
    assert r["source_station"] == "2204101"
    assert by_date["2026-10-18"]["gust"] == 55.0


def test_archive_roundtrip_and_merge(tmp_path):
    path = tmp_path / "yk.csv"
    rows = {}
    assert ca.merge(rows, [ca.row_from_api(api_props("2026-10-16", MAX_TEMPERATURE=8.3))]) == 1
    assert ca.merge(rows, [ca.row_from_api(api_props("2026-10-17"))]) == 1
    ca.write_archive(path, rows)
    back = ca.read_archive(path)
    assert back == rows
    header = path.read_text("utf-8").splitlines()[0]
    assert header == ",".join(ca.COLUMNS)
    # A corrected value replaces the old row; an identical row counts as unchanged.
    assert ca.merge(back, [ca.row_from_api(api_props("2026-10-17", MAX_TEMPERATURE=9.9))]) == 1
    assert back["2026-10-17"]["max"] == 9.9
    assert ca.merge(back, [ca.row_from_api(api_props("2026-10-16", MAX_TEMPERATURE=8.3))]) == 0
    assert len(back) == 2


def test_station_windows_clip_to_today_and_never_overlap():
    thread = {"daily": [
        {"climate_id": "A", "stn_id": 1, "from": "1942-07-01", "to": "2013-01-16"},
        {"climate_id": "B", "stn_id": 2, "from": "2013-01-17", "to": None},
    ]}
    windows = ca.station_windows(thread, today=date(2026, 10, 19))
    assert [(w[1], w[2]) for w in windows] == [(date(1942, 7, 1), date(2013, 1, 16)), (date(2013, 1, 17), date(2026, 10, 19))]
    rows = [{"date": "2013-01-16"}, {"date": "2013-01-17"}, {"date": "2013-01-18"}]
    assert [r["date"] for r in ca.clip(rows, date(2013, 1, 17), date(2026, 1, 1))] == ["2013-01-17", "2013-01-18"]
