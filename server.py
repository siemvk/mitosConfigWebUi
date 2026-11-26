#!/usr/bin/env python3
"""Minimal local server for Mitos Config WebUI with auto-load/save of ~/.config/mitos/config.toml."""
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CONFIG_PATH = Path(os.environ.get("MITOS_CONFIG", "~/.config/mitos/config.toml")).expanduser()
PORT = int(os.environ.get("PORT", "8000"))


class Handler(SimpleHTTPRequestHandler):
    def _send_json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/config":
            try:
                exists = CONFIG_PATH.exists()
                text = CONFIG_PATH.read_text(encoding="utf-8") if exists else ""
                self._send_json(200, {"path": str(CONFIG_PATH), "exists": exists, "text": text})
            except OSError as exc:
                self._send_json(500, {"error": str(exc), "path": str(CONFIG_PATH)})
            return
        super().do_GET()

    def do_PUT(self):
        if self.path.split("?", 1)[0] == "/api/config":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                text = self.rfile.read(length).decode("utf-8")
                CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
                tmp = CONFIG_PATH.with_suffix(".toml.tmp")
                tmp.write_text(text, encoding="utf-8")
                os.replace(tmp, CONFIG_PATH)
                self._send_json(200, {"ok": True, "path": str(CONFIG_PATH)})
            except OSError as exc:
                self._send_json(500, {"error": str(exc), "path": str(CONFIG_PATH)})
            return
        self.send_error(404)


if __name__ == "__main__":
    print(f"Serving Mitos Config WebUI at http://127.0.0.1:{PORT}/ (config: {CONFIG_PATH})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
