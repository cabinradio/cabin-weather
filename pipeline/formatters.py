"""House-style formatting for everything the pipeline writes as text.

Rules come from the Cabin Radio Style Guide (plan section 7). Numbers that the
front end will format itself stay numbers in the JSON; this module is for the
generated sentences and labels, and for the tests that pin the rules down.

    temperatures  20C, -20C (hyphen-minus, no degree sign, no "minus")
    measurements  25 km/h, 0.4 mm, 12 cm
    wind chill    bare number: -31
    dates         October 5; Monday, October 5; October 5, 2025
    times         4pm, 8:30am, noon, midnight, 4pm MT; never 24-hour
    day names     never "today", "yesterday", "tomorrow"
    dashes        en dash with spaces for a break – like this – and without
                  for ranges: 1991–2020. Never an em dash.
    numbers       one to nine in words, 10 and up in digits with commas;
                  "percent" not "%"; "more than" not "over"
    NWT           never NT where a reader can see it
"""

from __future__ import annotations

import re
from datetime import date, datetime, time
from decimal import ROUND_HALF_UP, Decimal

EN_DASH = "–"
EM_DASH = "—"

MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
SMALL_NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]


# ---------------------------------------------------------------- numbers

def round_half_up(value: float, decimals: int = 0) -> float:
    """Round the way a reader expects (2.5 -> 3), not banker's rounding."""
    q = Decimal(1).scaleb(-decimals)
    return float(Decimal(str(value)).quantize(q, rounding=ROUND_HALF_UP))


def fmt_number(value: float | None, decimals: int = 0) -> str | None:
    """A plain number with the given decimals and no negative zero."""
    if value is None:
        return None
    rounded = round_half_up(value, decimals)
    if rounded == 0:
        rounded = 0.0
    text = f"{rounded:.{decimals}f}"
    if decimals == 0:
        text = f"{int(rounded):,}"
    return text


def fmt_temp(value: float | None, decimals: int = 0) -> str | None:
    """20C, -20C, 3.2C. None stays None so callers can omit it."""
    text = fmt_number(value, decimals)
    return None if text is None else f"{text}C"


def fmt_measure(value: float | None, unit: str, decimals: int = 0) -> str | None:
    """25 km/h, 0.4 mm, 12 cm."""
    text = fmt_number(value, decimals)
    return None if text is None else f"{text} {unit}"


def fmt_windchill(value: float | None) -> str | None:
    """Wind chill is a bare number, as ECCC gives it."""
    return fmt_number(value, 0)


def num_words(n: int) -> str:
    """One to nine in words, 10 and up in digits with thousands commas."""
    if 0 <= n <= 9:
        return SMALL_NUMBERS[n]
    return f"{n:,}"


def fmt_percent(n: float) -> str:
    return f"{fmt_number(n)} percent"


def ordinal(n: int) -> str:
    if 10 <= n % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def fmt_range(a, b) -> str:
    """A range uses an en dash with no spaces: 1991–2020."""
    return f"{a}{EN_DASH}{b}"


# ---------------------------------------------------------------- dates and times

def fmt_date(d: date, weekday: bool = False, year: bool = False) -> str:
    """October 5; Monday, October 5; October 5, 2025."""
    text = f"{MONTHS[d.month - 1]} {d.day}"
    if year:
        text = f"{text}, {d.year}"
    if weekday:
        text = f"{DAYS[d.weekday()]}, {text}"
    return text


def day_name(d: date) -> str:
    """Always the day name. Never "today", "yesterday" or "tomorrow"."""
    return DAYS[d.weekday()]


def fmt_time(t: time | datetime, tz: bool = False) -> str:
    """4pm, 8:30am, noon, midnight. With tz=True: 4pm MT."""
    if isinstance(t, datetime):
        t = t.time()
    if t.hour == 12 and t.minute == 0:
        text = "noon"
    elif t.hour == 0 and t.minute == 0:
        text = "midnight"
    else:
        hour12 = t.hour % 12 or 12
        suffix = "am" if t.hour < 12 else "pm"
        text = f"{hour12}{suffix}" if t.minute == 0 else f"{hour12}:{t.minute:02d}{suffix}"
    return f"{text} MT" if tz else text


def fmt_date_range(start: date, end: date) -> str:
    """October 1–18, or September 28 – October 11 across a month boundary."""
    if start.month == end.month:
        return f"{MONTHS[start.month - 1]} {start.day}{EN_DASH}{end.day}"
    return f"{fmt_date(start)} {EN_DASH} {fmt_date(end)}"


# ---------------------------------------------------------------- phrases

def anomaly_phrase(anomaly: float | None) -> str | None:
    """about 1.5C above normal / about 2C below normal / close to normal."""
    if anomaly is None:
        return None
    if abs(anomaly) < 0.5:
        return "close to normal"
    size = round_half_up(abs(anomaly), 1)
    text = f"{size:.1f}".removesuffix(".0")
    return f"about {text}C {'above' if anomaly > 0 else 'below'} normal"


def rank_phrase(rank: int, of: int, kind: str, period: str) -> str:
    """23rd warmest October 1–18 in 84 years; warmest October in 84 years."""
    lead = kind if rank == 1 else f"{ordinal(rank)} {kind}"
    return f"{lead} {period} in {num_words(of)} years"


def fortnight_summary(name: str, mean: float | None, anomaly: float | None, records: list[str]) -> str | None:
    """The one-paragraph summary under the two-week chart.

    records: already-formatted record sentences, e.g.
    "The high of 14.4C on October 12 was a record for the date."
    """
    if mean is None:
        return None
    first = f"The past two weeks in {name} averaged {fmt_temp(mean, 1)}"
    anomaly_text = anomaly_phrase(anomaly)
    if anomaly_text:
        first = f"{first}, {anomaly_text}"
    first += "."
    if not records:
        return f"{first} No daily records were set."
    count = len(records)
    noun = "record was" if count == 1 else "records were"
    lead = f"{num_words(count).capitalize()} daily {noun} set."
    return " ".join([first, lead, *records])


def record_sentence(kind: str, value: float, d: date, previous: float | None, previous_year: int | None) -> str:
    """The high of 14.4C on October 12 was a record for the date, passing 13.9C from 1963."""
    label = {
        "high": "high",
        "low": "low",
        "warm_low": "overnight low",
        "cold_high": "daytime high",
    }[kind]
    what = {
        "high": "a record for the date",
        "low": "a record low for the date",
        "warm_low": "the warmest overnight low recorded for the date",
        "cold_high": "the coldest daytime high recorded for the date",
    }[kind]
    text = f"The {label} of {fmt_temp(value, 1)} on {fmt_date(d)} was {what}"
    if previous is not None and previous_year is not None:
        text = f"{text}, passing {fmt_temp(previous, 1)} from {previous_year}"
    return text + "."


# ---------------------------------------------------------------- style check

_STYLE_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("em dash", re.compile(EM_DASH)),
    ("degree sign", re.compile("[°℃]")),
    ("Unicode minus", re.compile("−")),
    ("today/yesterday/tomorrow", re.compile(r"\b(today|yesterday|tomorrow)\b", re.I)),
    ("NT for the territory", re.compile(r"\bNT\b")),
    ("percent sign", re.compile(r"%")),
    ("exclamation mark", re.compile(r"!")),
    ("'over' before a number", re.compile(r"\bover\s+-?\d", re.I)),
    ("abbreviation with periods", re.compile(r"\b(?:[A-Za-z]\.){2,}")),
    ("okay", re.compile(r"\bokay\b", re.I)),
    ("underway as one word", re.compile(r"\bunderway\b", re.I)),
    ("'minus' before a temperature", re.compile(r"\bminus\s+\d", re.I)),
    ("hyphen used as a range or break", re.compile(r"\d\s-\s\d|\s-\s")),
]


def style_problems(text: str) -> list[str]:
    """Return the house-style rules a piece of generated text breaks."""
    return [name for name, pattern in _STYLE_RULES if pattern.search(text)]
