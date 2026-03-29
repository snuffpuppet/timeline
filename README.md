# Timeline — Gantt Planner

A locally-hosted Gantt chart planner. No accounts, no cloud, no external dependencies. Data lives in a JSON file on your machine.

## Features

- **Multiple projects** — sidebar project list with instant switching
- **Auto-scheduling** — task start dates computed automatically from dependencies (topological sort)
- **Critical path** highlighting — longest path shown in amber
- **Three views:**
  - **Table** — editable task list with inline fields
  - **Gantt** — SVG chart with zoom levels (Day / Week / Month), dependency arrows, today marker, and collapsible deliverable sections
  - **Canvas** — freeform card layout with drag-to-connect linking
- **Deliverables & task groups** — organise tasks into named deliverables, each with sub-groups
- **Teams** — define colour-coded teams, assign multiple teams per task, filter in Gantt view
- **Activity types** — Discovery, Design, Build, Int. Test, UAT, Data Cleanse, Migration, Release, Milestone
- **Quick-add bar** — add tasks in one line: `Task name, 5d, deps: 1 2, teams: Backend, assign: Alice`
- **Auto-save** — changes saved automatically after 1 second of inactivity
- **Print to PDF** — browser print renders the Gantt chart only, landscape

## Running with Docker (recommended)

```bash
docker compose up -d
```

App is available at **http://localhost:8080**

To stop:

```bash
docker compose down
```

To rebuild after code changes:

```bash
docker compose up -d --build
```

Data is stored in `./data/gantt.json` on your host machine via a volume mount — it persists across container restarts and rebuilds.

## Running directly (Python, no Docker)

Requires Python 3, no other dependencies.

```bash
python3 server.py
```

App is available at **http://localhost:3000**

## Data

All project data is stored in `data/gantt.json`. Back this file up to preserve your work. The format is plain JSON and human-readable.

## File structure

```
timeline/
├── Dockerfile
├── docker-compose.yml
├── server.py          # Python HTTP server, no dependencies
├── data/
│   └── gantt.json     # All project data (auto-created)
└── public/
    ├── index.html
    ├── style.css
    └── app.js         # All application logic
```
