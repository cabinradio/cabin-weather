"""HTTP access to ECCC, with the reliability rules from the plan baked in.

Every call: 20-second timeout, three retries with backoff, a User-Agent that
names Cabin Radio, and never more than four concurrent requests to any one
host. Nothing else in the pipeline should call `requests` directly.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Iterable
from urllib.parse import urlsplit

import requests

log = logging.getLogger(__name__)

CONTACT = os.environ.get("CABIN_WEATHER_CONTACT", "https://cabinradio.ca")
USER_AGENT = f"CabinWeather/1.0 (Cabin Radio, Yellowknife; +{CONTACT})"
TIMEOUT = 20
RETRIES = 3
BACKOFF = (1, 2, 4)
MAX_PER_HOST = 4

_semaphores: dict[str, threading.BoundedSemaphore] = defaultdict(lambda: threading.BoundedSemaphore(MAX_PER_HOST))
_semaphores_lock = threading.Lock()
_session = requests.Session()
_session.headers["User-Agent"] = USER_AGENT


class FetchError(Exception):
    """Raised when a URL could not be fetched after all retries."""


def _semaphore(url: str) -> threading.BoundedSemaphore:
    host = urlsplit(url).netloc
    with _semaphores_lock:
        return _semaphores[host]


def get(url: str, params: dict[str, Any] | None = None, *, timeout: int = TIMEOUT, retries: int = RETRIES) -> requests.Response:
    """GET a URL. Retries on connection errors, timeouts, 429 and 5xx. A 4xx other than 429 is returned as-is."""
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with _semaphore(url):
                resp = _session.get(url, params=params, timeout=timeout)
            if resp.status_code == 429 or resp.status_code >= 500:
                last = FetchError(f"HTTP {resp.status_code} for {resp.url}")
            else:
                return resp
        except requests.RequestException as exc:
            last = exc
        if attempt < retries - 1:
            wait = BACKOFF[min(attempt, len(BACKOFF) - 1)]
            log.warning("retrying %s in %ss after %s", url, wait, last)
            time.sleep(wait)
    raise FetchError(f"gave up on {url}: {last}")


def get_ok(url: str, params: dict[str, Any] | None = None, **kw) -> requests.Response:
    """GET and raise FetchError on any non-200 status."""
    resp = get(url, params, **kw)
    if resp.status_code != 200:
        raise FetchError(f"HTTP {resp.status_code} for {resp.url}")
    return resp


def get_json(url: str, params: dict[str, Any] | None = None, **kw) -> Any:
    return get_ok(url, params, **kw).json()


def get_text(url: str, params: dict[str, Any] | None = None, **kw) -> str:
    resp = get_ok(url, params, **kw)
    resp.encoding = resp.encoding or "utf-8"
    return resp.text


def get_bytes(url: str, params: dict[str, Any] | None = None, **kw) -> bytes:
    return get_ok(url, params, **kw).content


def fetch_many(items: Iterable[Any], fn: Callable[[Any], Any], workers: int = MAX_PER_HOST) -> dict[Any, Any]:
    """Run fn(item) for each item in a small thread pool.

    Returns {item: result_or_exception}. Exceptions are captured, not raised, so
    one bad community never stops the others.
    """
    items = list(items)
    results: dict[Any, Any] = {}

    def run(item):
        try:
            return item, fn(item)
        except Exception as exc:  # noqa: BLE001 - captured on purpose
            return item, exc

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for item, result in pool.map(run, items):
            results[item] = result
    return results
