"""The community list must match the Style Guide exactly, with no duplicates."""

import json
from pathlib import Path

CONFIG = Path(__file__).resolve().parents[1] / "config"

STYLE_GUIDE_NAMES = [
    "Aklavik", "Colville Lake", "Délı̨nę", "Dettah", "Enterprise", "Fort Good Hope", "Fort Liard",
    "Fort McPherson", "Fort Providence", "Fort Resolution", "Fort Simpson", "Fort Smith", "Gamètì",
    "Hay River", "Inuvik", "Łútsël K'é", "Nahanni Butte", "Norman Wells", "Paulatuk", "Sachs Harbour",
    "Sambaa K'e", "Tuktoyaktuk", "Tulita", "Ulukhaktok", "Wekweètì", "Whatì", "Wrigley", "Yellowknife",
]
REGIONS = {"North Slave", "South Slave", "Beaufort Delta", "Sahtu", "Dehcho", "Tłı̨chǫ"}


def load(name):
    return json.loads((CONFIG / name).read_text("utf-8"))


def test_twenty_eight_communities_spelled_as_the_guide():
    names = [c["name"] for c in load("communities.json")["communities"]]
    assert names == STYLE_GUIDE_NAMES


def test_slugs_and_site_codes_unique_and_well_formed():
    cs = load("communities.json")["communities"]
    slugs = [c["slug"] for c in cs]
    codes = [c["site_code"] for c in cs]
    assert len(set(slugs)) == 28 and len(set(codes)) == 28
    assert all(s == s.lower() and " " not in s for s in slugs)
    assert all(code.startswith("s") and len(code) == 8 for code in codes)


def test_regions_and_tiers():
    cfg = load("communities.json")
    assert {c["region"] for c in cfg["communities"]} == REGIONS
    assert set(cfg["regions_order"]) == REGIONS
    tiers = {c["slug"]: c["tier"] for c in cfg["communities"]}
    assert tiers["yellowknife"] == "plus"
    assert {s for s, t in tiers.items() if t == "comparison"} == {"inuvik", "norman-wells", "fort-simpson", "hay-river", "fort-smith"}
    assert sum(1 for t in tiers.values() if t == "forecast") == 22


def test_every_history_community_has_a_station_thread():
    cfg = load("communities.json")
    stations = load("stations.json")["stations"]
    for c in cfg["communities"]:
        if c["tier"] in ("comparison", "plus"):
            assert c["climate"] in stations, c["slug"]
            thread = stations[c["climate"]]["daily"]
            assert thread[-1]["to"] is None, "current station must be open-ended"
            assert all(a["to"] < b["from"] for a, b in zip(thread, thread[1:])), "thread segments must not overlap"
    assert "hourly" in stations["yellowknife"]
