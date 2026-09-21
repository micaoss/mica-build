#!/usr/bin/env python3
"""The mirror, for tests/mirror-hook-test.sh: a static tree plus one redirect.

    python3 tests/mirror-hook-server.py <directory>
    -> prints the port it is listening on, then serves:

       /<path>     the file, as any static host would
       /r/<path>   a 302 to /<path>

The /r/ prefix is how the test reaches the shape mica-res moved to on
2026-09-19: a base that answers a readable path or a digest lookup with a
redirect to the download host. A consumer that did not follow it would read
every object as a miss while its URLs still looked correct.
"""
import http.server
import os
import sys
import threading

ROOT = sys.argv[1]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path.startswith("/r/"):
            self.send_response(302)
            self.send_header("Location", self.path[2:])
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, *args):
        pass


def main() -> None:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(server.server_address[1], flush=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Event().wait()


main()
