"""One test per house-style rule in plan section 7."""

from datetime import date, datetime, time

import pytest

import formatters as f

EN = "–"


# Temperatures: figure then C, no space, no degree sign, hyphen-minus, no "minus".
def test_temperature_format():
    assert f.fmt_temp(20) == "20C"
    assert f.fmt_temp(-20) == "-20C"
    assert f.fmt_temp(-20.4) == "-20C"
    assert f.fmt_temp(-0.4) == "0C"          # never "-0C"
    assert f.fmt_temp(2.5) == "3C"           # half rounds up, not to even
    assert f.fmt_temp(3.25, 1) == "3.3C"
    assert f.fmt_temp(None) is None
    assert "°" not in f.fmt_temp(-31.2)
    assert "−" not in f.fmt_temp(-31.2)


# Measurements: number, space, unit.
def test_measurements():
    assert f.fmt_measure(25, "km/h") == "25 km/h"
    assert f.fmt_measure(0.4, "mm", 1) == "0.4 mm"
    assert f.fmt_measure(12, "cm") == "12 cm"
    assert f.fmt_measure(None, "mm") is None


# Wind chill is a bare number.
def test_windchill():
    assert f.fmt_windchill(-31) == "-31"
    assert f.fmt_windchill(-30.6) == "-31"


# Dates: October 5, Monday, October 5, October 5, 2025.
def test_dates():
    d = date(2025, 10, 5)
    assert f.fmt_date(d) == "October 5"
    assert f.fmt_date(d, weekday=True) == "Sunday, October 5"
    assert f.fmt_date(d, year=True) == "October 5, 2025"
    assert "th" not in f.fmt_date(date(2025, 10, 4))
    assert f.fmt_date_range(date(2026, 10, 1), date(2026, 10, 18)) == f"October 1{EN}18"
    assert f.fmt_date_range(date(2026, 9, 28), date(2026, 10, 11)) == f"September 28 {EN} October 11"


# Times: 4pm, 8:30am, noon, midnight, MT. Never 24-hour.
def test_times():
    assert f.fmt_time(time(16, 0)) == "4pm"
    assert f.fmt_time(time(8, 30)) == "8:30am"
    assert f.fmt_time(time(12, 0)) == "noon"
    assert f.fmt_time(time(0, 0)) == "midnight"
    assert f.fmt_time(time(12, 5)) == "12:05pm"
    assert f.fmt_time(time(0, 30)) == "12:30am"
    assert f.fmt_time(time(21, 40), tz=True) == "9:40pm MT"
    assert f.fmt_time(datetime(2026, 10, 19, 16, 0)) == "4pm"


# Never "today", "yesterday" or "tomorrow": always the day name.
def test_day_names_never_relative():
    today = date.today()
    assert f.day_name(today) in f.DAYS
    assert f.style_problems("Today will be sunny") == ["today/yesterday/tomorrow"]
    assert f.style_problems("Monday will be sunny") == []


# Dashes: en dash without spaces for ranges, never an em dash.
def test_dashes():
    assert f.fmt_range(1991, 2020) == f"1991{EN}2020"
    assert "em dash" in f.style_problems("The high — a record — came at 4pm")
    assert "hyphen used as a range or break" in f.style_problems("1991 - 2020")
    assert f.style_problems(f"1991{EN}2020") == []


# Numbers: one to nine in words, 10 and up in digits, comma in thousands, percent not %.
def test_numbers_in_sentences():
    assert f.num_words(1) == "one"
    assert f.num_words(9) == "nine"
    assert f.num_words(10) == "10"
    assert f.num_words(1000) == "1,000"
    assert f.fmt_percent(30) == "30 percent"
    assert "percent sign" in f.style_problems("30% chance")
    assert "'over' before a number" in f.style_problems("over 20 records")
    assert f.style_problems("more than 20 records") == []


def test_ordinals():
    assert [f.ordinal(n) for n in (1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112)] == [
        "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th", "112th",
    ]


# NWT never NT; abbreviations without periods; OK not okay; "under way" two words.
def test_territory_and_abbreviations():
    assert "NT for the territory" in f.style_problems("Snow across NT")
    assert f.style_problems("Snow across the NWT") == []
    assert "abbreviation with periods" in f.style_problems("at 4pm M.T.")
    assert "okay" in f.style_problems("That is okay")
    assert "underway as one word" in f.style_problems("Winter is underway")
    assert f.style_problems("Winter is under way") == []


# Generated sentences: plain, past tense for observations, no exclamation marks, no "minus".
def test_anomaly_phrase():
    assert f.anomaly_phrase(1.5) == "about 1.5C above normal"
    assert f.anomaly_phrase(-2.0) == "about 2C below normal"
    assert f.anomaly_phrase(0.3) == "close to normal"
    assert f.anomaly_phrase(-0.49) == "close to normal"
    assert f.anomaly_phrase(None) is None


def test_rank_phrase():
    assert f.rank_phrase(23, 84, "warmest", f"October 1{EN}18") == f"23rd warmest October 1{EN}18 in 84 years"
    assert f.rank_phrase(1, 84, "warmest", "October") == "warmest October in 84 years"
    assert f.rank_phrase(2, 9, "coldest", "autumn so far") == "2nd coldest autumn so far in nine years"


def test_fortnight_summary():
    text = f.fortnight_summary("Fort Smith", 3.2, 1.5, [])
    assert text == "The past two weeks in Fort Smith averaged 3.2C, about 1.5C above normal. No daily records were set."
    assert f.style_problems(text) == []
    rec = f.record_sentence("high", 14.4, date(2026, 10, 12), 13.9, 1963)
    assert rec == "The high of 14.4C on October 12 was a record for the date, passing 13.9C from 1963."
    two = f.fortnight_summary("Yellowknife", -1.0, -0.2, [rec, f.record_sentence("warm_low", 3.3, date(2026, 10, 19), 2.6, 1980)])
    assert two.startswith("The past two weeks in Yellowknife averaged -1.0C, close to normal. Two daily records were set. The high")
    assert f.style_problems(two) == []
    assert f.fortnight_summary("Inuvik", None, None, []) is None


def test_style_check_catches_minus_and_degrees():
    assert "'minus' before a temperature" in f.style_problems("Low minus 6")
    assert "degree sign" in f.style_problems("5°C")
    assert "exclamation mark" in f.style_problems("A record!")
