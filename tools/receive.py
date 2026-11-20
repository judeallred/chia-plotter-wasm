"""Dev helper: accepts plot files PUT from the browser page and saves them, so plots made in
a browser without a usable downloads folder can be checked with `chia plots check`.

Usage: python -I tools/receive.py <out_dir> [port] [allowed_origin]
In the page console: fetch(`http://127.0.0.1:8765/${name}`, {method: "PUT", body: file})

Only the dev server's origin (http://localhost:4321 unless given) may write, so other web
pages open in the browser cannot drop files into out_dir.
"""

import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

out = Path(sys.argv[1])
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
allowed_origin = sys.argv[3] if len(sys.argv) > 3 else "http://localhost:4321"


class Handler(BaseHTTPRequestHandler):
    def cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", allowed_origin)
        self.send_header("Access-Control-Allow-Methods", "PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def reply(self, status: int) -> None:
        self.send_response(status)
        self.cors()
        self.end_headers()

    def do_OPTIONS(self) -> None:
        self.reply(204)

    def do_PUT(self) -> None:
        name = Path(self.path).name
        if self.headers.get("Origin", allowed_origin) != allowed_origin:
            self.reply(403)
            return
        length = self.headers.get("Content-Length")
        if not name.endswith(".gplot") or length is None or not length.isdigit():
            self.reply(400)
            return
        remaining = int(length)
        partial = out / f"{name}.partial"
        with open(partial, "wb") as f:
            while remaining:
                chunk = self.rfile.read(min(remaining, 1 << 20))
                if not chunk:
                    break  # The client went away.
                f.write(chunk)
                remaining -= len(chunk)
        if remaining:
            partial.unlink(missing_ok=True)
            self.reply(400)
            return
        partial.replace(out / name)
        self.reply(201)
        print(f"saved {name}", flush=True)


ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
