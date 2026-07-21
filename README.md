# Car Costs

A small self-hosted running-costs tracker for the household cars. Open it, tap a
car, add the entry — that's the whole workflow, designed to be done at the pump.

- **Fuel fills** with odometer, litres and unit price — the app computes the total,
  fuel efficiency (L/100km from consecutive fills) and cost per km.
- **Insurance, motor tax, NCT and servicing/repairs** as dated amounts, freely
  backdatable, with per-year totals by category.
- **EV-ready:** flip a car's "electric charging entries" toggle and it gains a
  kWh + price-per-kWh entry form — the schema supports it from day one, so a
  future EV or PHEV needs no migration.
- Mobile-first single page, light/dark, no build step, no accounts — intended to
  sit behind your own network / dashboard (e.g. a Home Assistant sidebar panel).

## Stack

FastAPI + SQLite (stdlib `sqlite3`, no ORM) + a vanilla-JS static page. The
database lives in `data/` (gitignored).

## Run

```bash
python3 -m venv venv && venv/bin/pip install fastapi "uvicorn[standard]"
venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
```

Two placeholder cars are seeded on first run — rename them via the Edit button.

## API

`GET /api/cars` · `POST /api/cars` · `PATCH /api/cars/{id}` ·
`GET /api/cars/{id}?year=` · `POST /api/cars/{id}/entries` ·
`DELETE /api/entries/{id}` · `GET /healthz`
