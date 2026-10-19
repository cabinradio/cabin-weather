"""One-off full archive pull for every history community (plan section 4, rule 9).

    .venv/bin/python pipeline/backfill.py              # all six
    .venv/bin/python pipeline/backfill.py fort-smith   # one

Walks each station thread segment by segment, pulls climate-daily in five-year
chunks, clips each segment to its configured window so overlaps never leak,
and writes archive/{slug}.csv. Safe to re-run: it merges into what is there.
"""

from __future__ import annotations

import logging
import sys
import time

import climate_archive as ca
import eccc_http

log = logging.getLogger("backfill")


def backfill(slug: str) -> None:
    thread = ca.thread_for(slug)
    path = ca.archive_path(slug)
    rows = ca.read_archive(path)
    log.info("%s: %d rows already in %s", slug, len(rows), path.name)
    for station, first, last in ca.station_windows(thread):
        cid = station["climate_id"]
        t0 = time.time()
        # Fetch the chunks of this segment in parallel (the HTTP helper caps concurrency per host).
        chunks = []
        start = first
        while start <= last:
            end = min(ca.date(start.year + ca.CHUNK_YEARS - 1, 12, 31), last)
            chunks.append((start, end))
            start = end + ca.timedelta(days=1)
        results = eccc_http.fetch_many(chunks, lambda c: ca.fetch_api_rows(cid, c[0], c[1]))
        fetched: list[dict] = []
        failed = []
        for chunk, result in results.items():
            if isinstance(result, Exception):
                failed.append((chunk, result))
            else:
                fetched.extend(result)
        if failed:
            for chunk, exc in failed:
                log.error("%s: %s %s..%s failed: %s", slug, cid, chunk[0], chunk[1], exc)
        fetched = ca.clip(fetched, first, last)
        changed = ca.merge(rows, fetched)
        log.info("%s: %s %s..%s -> %d rows (%d new or changed) in %.1fs", slug, cid, first, last, len(fetched), changed, time.time() - t0)
    ca.write_archive(path, rows)
    dates = sorted(rows)
    log.info("%s: wrote %d rows, %s to %s", slug, len(rows), dates[0] if dates else "-", dates[-1] if dates else "-")


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    slugs = argv or ca.history_slugs()
    for slug in slugs:
        backfill(slug)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
