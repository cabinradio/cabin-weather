"""ECCC icon codes (0–48, shared by current conditions and forecasts) -> our glyph names.

The glyph names are the ids in site/icons.svg. Unknown or empty codes map to
"na", a neutral glyph, never to a broken image (plan section 4, rule 4).
"""

GLYPHS = [
    "sun", "moon", "part-cloud-day", "part-cloud-night", "cloud", "rain", "showers", "snow", "flurries",
    "freezing-rain", "rain-snow", "thunder", "fog", "blowing-snow", "wind", "ice-crystals", "haze", "hail",
    "drizzle", "na",
]

ICON_BY_CODE = {
    0: "sun", 1: "part-cloud-day", 2: "part-cloud-day", 3: "cloud", 4: "part-cloud-day", 5: "part-cloud-day",
    6: "showers", 7: "rain-snow", 8: "flurries", 9: "thunder",
    10: "cloud", 11: "rain", 12: "showers", 13: "rain", 14: "freezing-rain", 15: "rain-snow",
    16: "flurries", 17: "snow", 18: "snow", 19: "thunder",
    20: "fog", 21: "fog", 22: "part-cloud-day", 23: "haze", 24: "fog", 25: "blowing-snow", 26: "ice-crystals",
    27: "hail", 28: "drizzle", 29: "na",
    30: "moon", 31: "part-cloud-night", 32: "part-cloud-night", 33: "cloud", 34: "part-cloud-night", 35: "part-cloud-night",
    36: "showers", 37: "rain-snow", 38: "flurries", 39: "thunder",
    40: "blowing-snow", 41: "thunder", 42: "thunder", 43: "wind", 44: "haze", 45: "haze", 46: "thunder", 47: "thunder", 48: "thunder",
}


def glyph(code) -> str:
    """'03' -> 'cloud'; '' / None / 'xx' / 99 -> 'na'."""
    try:
        return ICON_BY_CODE.get(int(str(code).strip()), "na")
    except (TypeError, ValueError):
        return "na"
