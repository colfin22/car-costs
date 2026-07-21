# Car Costs

A small self-hosted running-costs tracker for the household cars. Open it, tap a
car, add the entry — that's the whole workflow, designed to be done at the pump.

## Features

- **Fuel fills** the way people actually buy fuel: amount (€) + odometer, litres
  optional — €/L is derived when litres are given, and the app computes fuel
  efficiency (L/100km from consecutive fills) and cost per km. Odometer readings
  are validated against the timeline (no backwards or impossible values, with
  backdating fully supported).
- **Insurance, motor tax, NCT and servicing/repairs** as dated amounts, freely
  backdatable, with per-year totals by category.
- **Standalone mileage entries** — log the current odometer any time; the newest
  reading (from any entry) shows on the car's page and feeds the stats.
- **Car status page** per car: tap-to-upload photo (resized server-side; doubles
  as the car's thumbnail on the home screen), make/model/year/VIN, and due-date
  badges for NCT, a booked NCT test (with days-away countdown), tax and insurance
  — amber inside 30 days, red when overdue.
- **Renewal banners**: from 14 days before a due date the car page prompts
  "renewed?" with a one-tap dialog (new date + optional amount, logged as a cost
  entry). Renewing early through any route means the banner never appears.
- **NCT lifecycle**: booking a test offers to log the test fee (dated the booking
  day); the day after the test a banner asks the result — pass sets the new
  expiry, fail offers a paid rebooking or a free visual-only retest, and the
  cycle repeats.
- **EV-ready:** flip a car's "electric charging entries" toggle and it gains a
  kWh + price-per-kWh entry form — the schema supports it from day one, so a
  future EV or PHEV needs no migration.
- **Add and retire cars**: retiring keeps all history (greyed "Retired" section,
  restorable) — replacing a car never loses its costs.
- **Optional password gate** for internet-facing use: set `CARCOSTS_PASSWORD` in
  the environment and any request arriving via a reverse proxy/tunnel (detected
  by the `Cf-Connecting-Ip` header or a non-private peer address) must log in —
  a 30-day HMAC session cookie (`SameSite=None; Secure` so it survives being
  iframed), while internal direct-IP callers (monitoring, Home Assistant
  sensors) stay exempt. Rotating the password invalidates all sessions.
- Installable as a home-screen PWA (icon + manifest included). Dates display
  day-first (DD/MM/YY). Mobile-first single page, light/dark, no build step.

## Stack

FastAPI + SQLite (stdlib `sqlite3`, no ORM) + a vanilla-JS static page. The
database and photos live in `data/` (gitignored).

## Run

```bash
python3 -m venv venv && venv/bin/pip install fastapi "uvicorn[standard]" pillow python-multipart
venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
```

Two placeholder cars are seeded on first run — rename them via the Edit button.

## Home Assistant integration

**Renewal reminders:** the `/api/dues` endpoint returns every upcoming
NCT/test/tax/insurance date with a day count, shaped for a REST sensor. One
sensor plus one automation gives 30-day and 7-day phone nudges — all wording
and routing stays in Home Assistant:

```yaml
rest:
  - resource: http://<app-host>:8000/api/dues
    scan_interval: 3600
    sensor:
      - name: Car costs next due
        unique_id: car_costs_next_due
        value_template: "{{ value_json.next_days }}"
        unit_of_measurement: d
        json_attributes:
          - items

automation:
  - id: car_costs_due_reminders
    alias: Car costs - renewal reminders (30d/7d)
    triggers:
      - trigger: time
        at: "09:00:00"
    actions:
      - repeat:
          for_each: >-
            {{ state_attr('sensor.car_costs_next_due', 'items')
               | selectattr('days', 'in', [30, 7]) | list }}
          sequence:
            - variables:
                msg: >-
                  {{ repeat.item.car }}: {{ repeat.item.item }} due
                  {{ repeat.item.date }} ({{ repeat.item.days }} days)
            - action: notify.mobile_app_your_phone
              data:
                title: Car reminder
                message: "{{ msg }}"
```

**Per-car stats sensors:** each car's detail endpoint (`/api/cars/<id>`,
including a `next_due` object) feeds a second REST resource per car exposing
year cost (category breakdown as attributes), current mileage, fuel efficiency,
cost per km and days-to-next-due. Templates use `availability` for the empty
cases (a numeric-unit REST sensor must never render a placeholder string — the
entity fails to register). A charge-cost sensor gated on
`{{ value_json.car.ev_enabled == 1 }}` comes alive by itself when a car goes
electric. Note the resources reference car ids, so a replacement car means
repointing one resource.

For a sidebar tab, add a dashboard with a full-page `iframe` card pointing at
the app (https required if your Home Assistant is served over https). A
home-screen PWA install is the better phone experience.

## API

`GET /api/cars[?include_archived=true]` · `POST /api/cars` ·
`PATCH /api/cars/{id}` (details, due dates, `ev_enabled`, `archived`) ·
`GET /api/cars/{id}?year=` · `POST /api/cars/{id}/entries` ·
`DELETE /api/entries/{id}` · `POST /api/cars/{id}/photo` ·
`GET /api/dues` · `GET /healthz`
