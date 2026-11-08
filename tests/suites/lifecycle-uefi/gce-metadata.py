#!/usr/bin/env python3
"""A Compute Engine metadata server for the gce-like suite (gce.sh): the paths a guest agent reads, from a directory.

    gce-metadata.py <directory> <address> [<port>]

Serves http://<address>:<port>/computeMetadata/v1/<path> as Compute Engine does: the Metadata-Flavor: Google
request header is required (403 without it), the answer carries Metadata-Flavor: Google and an ETag, a path
ending in / lists its entries, ?recursive=true answers a directory as JSON, and ?wait_for_change=true holds the
request until the value's ETag differs from ?last_etag= (or ?timeout_sec= passes). <directory>/<path> is the
value of <path>: instance/hostname, instance/attributes/ssh-keys, project/attributes/ssh-keys, ... The suite
writes those files while the guest runs, which is how keys appear after boot. Every request is logged to stdout.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from urllib.parse import parse_qs, urlsplit

ROOT = Path(sys.argv[1]).resolve()
PREFIX = "/computeMetadata/v1/"


def value(path):
    """(status, body, content type) of a metadata path."""
    target = (ROOT / path).resolve()
    if target != ROOT and ROOT not in target.parents:
        return 404, b"", "text/plain"
    if target.is_dir():
        return 200, "".join(f"{e.name}/\n" if e.is_dir() else f"{e.name}\n" for e in sorted(target.iterdir())).encode(), "text/plain"
    if target.is_file():
        return 200, target.read_bytes(), "application/text"
    return 404, b"", "text/plain"


def tree(path):
    target = ROOT / path
    if target.is_dir():
        return {e.name: tree(f"{path}/{e.name}".lstrip("/")) for e in sorted(target.iterdir())}
    return target.read_text()


def etag(body):
    return hashlib.sha256(body).hexdigest()[:16]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query)
        print(f"metadata: GET {self.path} flavor={self.headers.get('Metadata-Flavor')}", flush=True)
        if self.headers.get("Metadata-Flavor") != "Google":
            return self.answer(403, b"Missing Metadata-Flavor:Google header.\n", "text/plain")
        if not url.path.startswith(PREFIX):
            return self.answer(404, b"", "text/plain")
        path = url.path[len(PREFIX):].strip("/")

        def read():
            if query.get("recursive") == ["true"] and (ROOT / path).is_dir():
                return 200, json.dumps(tree(path)).encode(), "application/json"
            return value(path)

        status, body, kind = read()
        if query.get("wait_for_change") == ["true"]:
            last = query.get("last_etag", [""])[0]
            deadline = time.monotonic() + float(query.get("timeout_sec", ["60"])[0])
            while etag(body) == last and time.monotonic() < deadline:
                time.sleep(0.5)
                status, body, kind = read()
        self.answer(status, body, kind)

    def answer(self, status, body, kind):
        self.send_response(status)
        self.send_header("Metadata-Flavor", "Google")
        self.send_header("Content-Type", kind)
        self.send_header("ETag", etag(body))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    os.chdir(ROOT)
    ThreadingHTTPServer((sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 80), Handler).serve_forever()
