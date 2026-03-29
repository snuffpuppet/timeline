#!/usr/bin/env python3
"""Gantt Planner server — no dependencies required, Python 3 only."""

import json
import os
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

PORT = int(os.environ.get('PORT', 3000))
BASE_DIR = Path(__file__).parent
PUBLIC_DIR = BASE_DIR / 'public'
DATA_DIR = BASE_DIR / 'data'
DATA_FILE = DATA_DIR / 'gantt.json'

DATA_DIR.mkdir(exist_ok=True)


class GanttHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def do_GET(self):
        if self.path == '/api/data':
            data = DATA_FILE.read_bytes() if DATA_FILE.exists() else b'{"projects":[]}'
            self._json(200, data)
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == '/api/data':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            DATA_FILE.write_bytes(body)
            self._json(200, b'{"ok":true}')
        else:
            self.send_error(404)

    def _json(self, code, body: bytes):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # suppress per-request noise


if __name__ == '__main__':
    server = HTTPServer(('', PORT), GanttHandler)
    print(f'\nGantt Planner  →  http://localhost:{PORT}\n')
    print('Press Ctrl+C to stop.\n')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.')
