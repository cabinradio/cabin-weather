"""The front end's size budget and glyph sprite, checked with the pipeline tests so CI enforces them (plan section 5)."""

import re
from pathlib import Path

import icons

SITE = Path(__file__).resolve().parents[2] / "site"


def test_every_glyph_has_a_symbol_in_the_sprite():
    svg = (SITE / "icons.svg").read_text(encoding="utf-8")
    ids = set(re.findall(r'<symbol id="cw-([a-z0-9-]+)"', svg))
    assert set(icons.GLYPHS) <= ids
    assert "na" in ids


def test_front_end_size_budget():
    assert (SITE / "app.js").stat().st_size < 40_000
    assert (SITE / "app.css").stat().st_size < 12_000
    assert (SITE / "icons.svg").stat().st_size < 15_000


def test_no_third_party_scripts_only_google_fonts():
    html = (SITE / "index.html").read_text(encoding="utf-8")
    assert all(not src.startswith("http") for src in re.findall(r'<script[^>]*src="([^"]+)"', html))
    for href in re.findall(r'<link[^>]*href="([^"]+)"', html):
        assert not href.startswith("http") or href.startswith("https://fonts.g")
    assert "<main>" in html
