"""Incremental daily archive update (plan section 4, rule 5).

Re-pulls the last DAYS days for the current station of every history
community, because ECCC back-fills and corrects, and merges by date into the
committed CSV. If the API returns nothing, falls back to the bulk CSV
download; if both fail, the existing archive is kept and the run continues.
Never deletes a row.

    .venv/bin/python pipeline/fetch_climate.py [--days 10] [slug ...]
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import date, timedelta

import climate_archive as ca
import eccc_http

log = logging.getLogger("fetch_climate")


def update(slug: str, days: int, today: date | None = None) -> str:
    """Returns 'api', 'bulk' or 'kept' to say where the fresh rows came from."""
    today = today or date.today()
    thread = ca.thread_for(slug)
    station, first, _ = ca.station_windows(thread, today)[-1]
    start = max(first, today - timedelta(days=days))
    cid = station["climate_id"]
    path = ca.archive_path(slug)
    rows = ca.read_archive(path)

    fetched: list[dict] = []
    source = "kept"
    try:
        fetched = ca.clip(ca.fetch_api_rows(cid, start, today), start, today)
        if fetched:
            source = "api"
        else:
            log.warning("%s: climate-daily returned no rows for %s since %s", slug, cid, start)
    except eccc_http.FetchError as exc:
        log.warning("%s: climate-daily failed (%s)", slug, exc)

    if not fetched:
        try:
            bulk: list[dict] = []
            for year in sorted({start.year, today.year}):
                bulk.extend(ca.fetch_bulk_rows(station["stn_id"], cid, year))
            fetched = ca.clip(bulk, start, today)
            if fetched:
                source = "bulk"
            else:
                log.warning("%s: bulk CSV had no rows for %s since %s", slug, cid, start)
        except eccc_http.FetchError as exc:
            log.warning("%s: bulk CSV failed (%s)", slug, exc)

    if fetched:
        changed = ca.merge(rows, fetched)
        ca.write_archive(path, rows)
        latest = max(r["date"] for r in fetched)
        log.info("%s: %d rows from %s, %d new or changed, latest %s", slug, len(fetched), source, changed, latest)
    else:
        log.error("%s: no fresh rows from either source; archive kept as is", slug)
    return source


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=10)
    parser.add_argument("slugs", nargs="*")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    results = {slug: update(slug, args.days) for slug in (args.slugs or ca.history_slugs())}
    kept = [s for s, r in results.items() if r == "kept"]
    log.info("done: %s", ", ".join(f"{s}={r}" for s, r in results.items()))
    if len(kept) == len(results):
        log.error("every community kept its old archive; ECCC may be down")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
