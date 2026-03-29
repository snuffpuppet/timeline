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

DATA_DIR.mkdir(parents=True, exist_ok=True)

EXAMPLE_DATA = {
    "projects": [
        {
            "id": "example",
            "name": "Example Project",
            "startDate": "2026-04-01",
            "teams": [
                {"id": "t1", "name": "Design",      "color": "#7c3aed"},
                {"id": "t2", "name": "Engineering", "color": "#2563eb"},
                {"id": "t3", "name": "QA",          "color": "#d97706"}
            ],
            "deliverables": [
                {"id": "d1", "name": "Discovery",   "color": "#0d9488"},
                {"id": "d2", "name": "Build",       "color": "#2563eb"},
                {"id": "d3", "name": "Release",     "color": "#dc2626"}
            ],
            "taskGroups": [],
            "tasks": [
                {
                    "id": "t1a", "name": "Requirements gathering",
                    "deliverableId": "d1", "groupId": None, "activityType": "discovery",
                    "duration": 5, "dependencies": [],
                    "teams": ["t1", "t2"], "assignee": "Alice", "notes": "",
                    "color": "#0d9488"
                },
                {
                    "id": "t1b", "name": "Technical design",
                    "deliverableId": "d1", "groupId": None, "activityType": "design",
                    "duration": 4, "dependencies": ["t1a"],
                    "teams": ["t1"], "assignee": "Bob", "notes": "",
                    "color": "#7c3aed"
                },
                {
                    "id": "t2a", "name": "Backend development",
                    "deliverableId": "d2", "groupId": None, "activityType": "build",
                    "duration": 10, "dependencies": ["t1b"],
                    "teams": ["t2"], "assignee": "Carol", "notes": "",
                    "color": "#2563eb"
                },
                {
                    "id": "t2b", "name": "Frontend development",
                    "deliverableId": "d2", "groupId": None, "activityType": "build",
                    "duration": 8, "dependencies": ["t1b"],
                    "teams": ["t2"], "assignee": "Dave", "notes": "",
                    "color": "#2563eb"
                },
                {
                    "id": "t2c", "name": "Integration testing",
                    "deliverableId": "d2", "groupId": None, "activityType": "int-test",
                    "duration": 4, "dependencies": ["t2a", "t2b"],
                    "teams": ["t2", "t3"], "assignee": "", "notes": "",
                    "color": "#d97706"
                },
                {
                    "id": "t3a", "name": "UAT",
                    "deliverableId": "d3", "groupId": None, "activityType": "uat",
                    "duration": 3, "dependencies": ["t2c"],
                    "teams": ["t3"], "assignee": "", "notes": "Stakeholder sign-off required",
                    "color": "#ea580c"
                },
                {
                    "id": "t3b", "name": "Production release",
                    "deliverableId": "d3", "groupId": None, "activityType": "release",
                    "duration": 1, "dependencies": ["t3a"],
                    "teams": ["t2"], "assignee": "Carol", "notes": "",
                    "color": "#dc2626"
                }
            ]
        }
    ]
}


def init_data_file():
    if not DATA_FILE.exists():
        DATA_FILE.write_text(json.dumps(EXAMPLE_DATA, indent=2))
        print('Created example data file at', DATA_FILE)


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
    init_data_file()
    server = HTTPServer(('', PORT), GanttHandler)
    print(f'\nGantt Planner  →  http://localhost:{PORT}\n')
    print('Press Ctrl+C to stop.\n')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.')
