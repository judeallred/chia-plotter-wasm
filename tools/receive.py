"""Dev helper: accepts plot files PUT from the browser page and saves them, so plots made in
a browser without a usable downloads folder can be checked with `chia plots check`.

Usage: python -I tools/receive.py <out_dir> [port]
In the page console: fetch(`http://127.0.0.1:8765/${name}`, {method: "PUT", body: file})
"""

import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

out = Path(sys.argv[1])
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8765


class Handler(BaseHTTPRequestHandler):
    def cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_PUT(self) -> None:
        name = Path(self.path).name
        if not name.endswith(".plot2"):
            self.send_response(400)
            self.cors()
            self.end_headers()
            return
        remaining = int(self.headers["Content-Length"])
        with open(out / name, "wb") as f:
            while remaining:
                chunk = self.rfile.read(min(remaining, 1 << 20))
                f.write(chunk)
                remaining -= len(chunk)
        self.send_response(201)
        self.cors()
        self.end_headers()
        print(f"saved {name}", flush=True)


ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
