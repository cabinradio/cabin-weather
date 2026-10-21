#!/usr/bin/env python3
"""Serve the front end the way GitHub Pages lays it out: site/ at / and data/ at /data/.

Used by .claude/launch.json for previews and by playwright.config.js. Stdlib only.

    python3 e2e/serve.py [port]        # default 8765
"""

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        parts = [p for p in unquote(urlparse(path).path).split("/") if p and p not in (".", "..")]
        if parts and parts[0] == "data":
            target = ROOT.joinpath("data", *parts[1:])
        else:
            target = ROOT.joinpath("site", *parts)
        if target.is_dir():
            target = target / "index.html"
        return str(target)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, fmt, *args):
        if args and str(args[1:2]) not in ("('200',)", "('304',)"):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"Serving {ROOT / 'site'} and {ROOT / 'data'} at http://127.0.0.1:{port}/", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
