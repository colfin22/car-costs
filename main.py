"""Car Costs — a small self-hosted running-costs tracker for the household cars.

FastAPI + SQLite, no ORM. The UI is a single mobile-first page (static/).
Categories: fuel, insurance, tax, nct, service — plus charge (kWh), which the
UI only shows for cars with the electric toggle on, so an EV/PHEV can be
enabled later with no schema change.
"""
import hashlib
import hmac
import ipaddress
import os
import secrets as pysecrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import date

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from PIL import Image, ImageOps

DB_PATH = os.environ.get("CARCOSTS_DB", os.path.join(os.path.dirname(__file__), "data", "carcosts.db"))
PHOTO_DIR = os.path.join(os.path.dirname(DB_PATH), "photos")

CATEGORIES = ("fuel", "charge", "insurance", "tax", "nct", "service", "odo", "belt")
FUEL_TYPES = ("petrol", "diesel", "hybrid", "phev", "ev")

app = FastAPI(title="Car Costs")

# ---- auth: magpie-pattern gate for tunnel-facing traffic -------------------
# Auth is ON only when CARCOSTS_PASSWORD is set (env / systemd EnvironmentFile).
# Only requests that arrived via Cloudflare (Cf-Connecting-Ip header) or from a
# non-private peer need the session cookie; internal direct-IP callers (the HA
# REST sensor, the uptime monitor, the LAN reverse-proxy path) are exempt — the
# only internet route is the tunnel, and Cloudflare always stamps its header.
AUTH_COOKIE = "carcosts_auth"
SESSION_DAYS = 30
PUBLIC_PATHS = {"/login", "/healthz", "/favicon.ico", "/static/icon.svg",
                "/static/icon-192.png", "/static/icon-512.png", "/static/manifest.json"}


def _secret() -> str:
    path = os.path.join(os.path.dirname(DB_PATH), "secret")
    if not os.path.isfile(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(pysecrets.token_hex(32))
        os.chmod(path, 0o600)
    return open(path).read().strip()


def _password() -> str | None:
    return os.environ.get("CARCOSTS_PASSWORD") or None


def _token() -> str:
    return hmac.new(_secret().encode(), _password().encode(), hashlib.sha256).hexdigest()


def _is_internal(request) -> bool:
    if request.headers.get("cf-connecting-ip"):
        return False
    try:
        return ipaddress.ip_address(request.client.host).is_private
    except (ValueError, AttributeError):
        return False


def _is_authed(request) -> bool:
    cookie = request.cookies.get(AUTH_COOKIE, "")
    return bool(cookie) and hmac.compare_digest(cookie, _token())


LOGIN_PAGE = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Car Costs — login</title>
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/icon-192.png">
<link rel="manifest" href="/static/manifest.json">
<meta name="theme-color" content="#2563eb">
<style>body{font:16px system-ui;background:#f4f5f7;color:#1c1e21;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
@media (prefers-color-scheme:dark){body{background:#111417;color:#e8eaed}}
form{background:rgba(128,128,128,.08);border:1px solid rgba(128,128,128,.25);border-radius:14px;padding:24px;width:min(88vw,320px)}
h1{font-size:1.1rem;margin:0 0 14px}input,button{width:100%;font:inherit;padding:11px;border-radius:10px;border:1px solid rgba(128,128,128,.35);box-sizing:border-box}
button{margin-top:12px;background:#2563eb;color:#fff;border:0;font-weight:600;cursor:pointer}
.err{color:#b3261e;font-size:.85rem;margin-top:8px}</style></head><body>
<form method="post" action="/login"><h1>Car Costs</h1>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>{err}
<button>Sign in</button></form></body></html>"""


@app.middleware("http")
async def auth_gate(request, call_next):
    if (_password() and request.url.path not in PUBLIC_PATHS
            and not _is_internal(request) and not _is_authed(request)):
        from fastapi.responses import JSONResponse, RedirectResponse
        if request.url.path.startswith("/api/"):
            return JSONResponse({"detail": "auth required"}, status_code=401)
        return RedirectResponse("/login", status_code=302)
    return await call_next(request)


@app.get("/favicon.ico")
def favicon():
    return FileResponse(os.path.join(os.path.dirname(__file__), "static", "icon.svg"), media_type="image/svg+xml")


@app.get("/login")
def login_page():
    from fastapi.responses import HTMLResponse
    return HTMLResponse(LOGIN_PAGE.replace("{err}", ""))


@app.post("/login")
async def login_submit(request: Request):
    from fastapi.responses import HTMLResponse, RedirectResponse
    form = await request.form()
    attempt = str(form.get("password") or "")
    if _password() and hmac.compare_digest(attempt, _password()):
        resp = RedirectResponse("/", status_code=302)
        resp.set_cookie(AUTH_COOKIE, _token(), max_age=SESSION_DAYS * 86400,
                        httponly=True, secure=True, samesite="none")
        return resp
    time.sleep(1.5)   # blunt brute-force damper
    return HTMLResponse(LOGIN_PAGE.replace("{err}", '<div class="err">Wrong password</div>'),
                        status_code=401)
# ---------------------------------------------------------------------------


@contextmanager
def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with db() as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS cars (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          reg TEXT DEFAULT '',
          fuel_type TEXT NOT NULL DEFAULT 'petrol',
          ev_enabled INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS entries (
          id INTEGER PRIMARY KEY,
          car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          category TEXT NOT NULL,
          odometer REAL,
          litres REAL,
          price_per_litre REAL,
          kwh REAL,
          price_per_kwh REAL,
          cost REAL NOT NULL,
          note TEXT DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_entries_car_date ON entries(car_id, date);
        """)
        have = {r["name"] for r in con.execute("PRAGMA table_info(cars)")}
        for col, typ in (("make", "TEXT DEFAULT ''"), ("model", "TEXT DEFAULT ''"),
                         ("year", "INTEGER"), ("vin", "TEXT DEFAULT ''"),
                         ("nct_due", "TEXT"), ("nct_booked", "TEXT"), ("tax_due", "TEXT"), ("insurance_due", "TEXT"),
                         ("photo_ver", "INTEGER NOT NULL DEFAULT 0"),
                         ("archived", "INTEGER NOT NULL DEFAULT 0"),
                         ("service_interval_km", "INTEGER"),
                         ("service_interval_months", "INTEGER"),
                         ("belt_interval_km", "INTEGER")):
            if col not in have:
                con.execute(f"ALTER TABLE cars ADD COLUMN {col} {typ}")
        if con.execute("SELECT COUNT(*) c FROM cars").fetchone()["c"] == 0:
            con.execute("INSERT INTO cars (name) VALUES ('Car 1')")
            con.execute("INSERT INTO cars (name) VALUES ('Car 2')")


class CarPatch(BaseModel):
    name: str | None = None
    reg: str | None = None
    fuel_type: str | None = None
    ev_enabled: bool | None = None
    make: str | None = None
    model: str | None = None
    year: int | None = None
    vin: str | None = None
    archived: bool | None = None
    service_interval_km: int | None = None
    service_interval_months: int | None = None
    belt_interval_km: int | None = None
    nct_due: str | None = None       # YYYY-MM-DD
    nct_booked: str | None = None    # NCT appointment date, if one is booked
    tax_due: str | None = None
    insurance_due: str | None = None


class CarNew(BaseModel):
    name: str
    reg: str = ""
    fuel_type: str = "petrol"


class EntryNew(BaseModel):
    date: str | None = None      # YYYY-MM-DD, defaults to today
    category: str
    odometer: float | None = None
    litres: float | None = None
    price_per_litre: float | None = None
    kwh: float | None = None
    price_per_kwh: float | None = None
    cost: float | None = None    # derived for fuel/charge when omitted
    note: str = ""


def add_months(d: date, months: int) -> date:
    y, mo = d.year + (d.month - 1 + months) // 12, (d.month - 1 + months) % 12 + 1
    from calendar import monthrange
    return date(y, mo, min(d.day, monthrange(y, mo)[1]))


def service_due(con, car, current_odo):
    """Two deadlines from the last service — time (default 12 months) and km —
    whichever comes first is binding. None until a first service is logged."""
    last = con.execute(
        "SELECT date, odometer FROM entries WHERE car_id=? AND category='service' "
        "ORDER BY date DESC, id DESC LIMIT 1", (car["id"],)).fetchone()
    if not last:
        return None
    months = car["service_interval_months"] or 12
    due_date = add_months(date.fromisoformat(last["date"]), months)
    days = (due_date - date.today()).days
    km_left = None
    if car["service_interval_km"] and last["odometer"] is not None and current_odo is not None:
        km_left = round(last["odometer"] + car["service_interval_km"] - current_odo)
    binding = "time"
    if km_left is not None:
        ratio_time = days / (months * 30.4)
        ratio_km = km_left / car["service_interval_km"]
        if ratio_km < ratio_time:
            binding = "km"
    next_km = None
    if car["service_interval_km"] and last["odometer"] is not None:
        next_km = round(last["odometer"] + car["service_interval_km"])
    return {"binding": binding, "date": due_date.isoformat(), "days": days,
            "km_left": km_left, "next_km": next_km, "last_service": last["date"]}


def belt_due(con, car, current_odo):
    """Mileage-only: last belt change's odometer + the car's belt interval."""
    if not car["belt_interval_km"]:
        return None
    last = con.execute(
        "SELECT date, odometer FROM entries WHERE car_id=? AND category='belt' "
        "AND odometer IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1", (car["id"],)).fetchone()
    if not last:
        return None
    next_km = round(last["odometer"] + car["belt_interval_km"])
    return {"next_km": next_km,
            "km_left": round(next_km - current_odo) if current_odo is not None else None,
            "last_change": last["date"], "last_odo": round(last["odometer"])}


def car_or_404(con, car_id: int):
    row = con.execute("SELECT * FROM cars WHERE id=?", (car_id,)).fetchone()
    if not row:
        raise HTTPException(404, "no such car")
    return row


def year_summary(con, car_id: int, year: int):
    rows = con.execute(
        "SELECT category, SUM(cost) total FROM entries "
        "WHERE car_id=? AND date LIKE ? GROUP BY category",
        (car_id, f"{year}-%")).fetchall()
    by_cat = {r["category"]: round(r["total"], 2) for r in rows if r["category"] != "odo"}
    odo = con.execute(
        "SELECT MIN(odometer) lo, MAX(odometer) hi FROM entries "
        "WHERE car_id=? AND date LIKE ? AND odometer IS NOT NULL",
        (car_id, f"{year}-%")).fetchone()
    km = (odo["hi"] - odo["lo"]) if odo["lo"] is not None and odo["hi"] is not None else 0
    total = round(sum(by_cat.values()), 2)
    return {
        "year": year,
        "total": total,
        "by_category": by_cat,
        "km_driven": round(km, 1),
        "cost_per_km": round(total / km, 3) if km else None,
    }


def fuel_stats(con, car_id: int):
    """L/100km from consecutive fuel fills with odometer readings."""
    fills = con.execute(
        "SELECT date, odometer, litres, price_per_litre FROM entries "
        "WHERE car_id=? AND category='fuel' AND odometer IS NOT NULL AND litres IS NOT NULL "
        "ORDER BY odometer", (car_id,)).fetchall()
    legs = []
    for prev, cur in zip(fills, fills[1:]):
        dist = cur["odometer"] - prev["odometer"]
        if dist > 0:
            legs.append(100.0 * cur["litres"] / dist)
    last = con.execute(
        "SELECT price_per_litre FROM entries WHERE car_id=? AND category='fuel' "
        "AND price_per_litre IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1",
        (car_id,)).fetchone()
    return {
        "l_per_100km": round(sum(legs) / len(legs), 1) if legs else None,
        "last_price_per_litre": last["price_per_litre"] if last else None,
    }


@app.get("/api/cars")
def list_cars(include_archived: bool = False):
    year = date.today().year
    where = "" if include_archived else "WHERE archived = 0"
    with db() as con:
        return [dict(c) | {"summary": year_summary(con, c["id"], year),
                           "fuel": fuel_stats(con, c["id"])}
                for c in con.execute(f"SELECT * FROM cars {where} ORDER BY id")]


@app.post("/api/cars", status_code=201)
def add_car(car: CarNew):
    if car.fuel_type not in FUEL_TYPES:
        raise HTTPException(422, f"fuel_type must be one of {FUEL_TYPES}")
    with db() as con:
        cur = con.execute("INSERT INTO cars (name, reg, fuel_type, ev_enabled) VALUES (?,?,?,?)",
                          (car.name, car.reg, car.fuel_type, int(car.fuel_type in ("ev", "phev"))))
        return dict(car_or_404(con, cur.lastrowid))


@app.patch("/api/cars/{car_id}")
def edit_car(car_id: int, patch: CarPatch):
    if patch.fuel_type is not None and patch.fuel_type not in FUEL_TYPES:
        raise HTTPException(422, f"fuel_type must be one of {FUEL_TYPES}")
    with db() as con:
        car_or_404(con, car_id)
        sets, vals = [], []
        # nullable fields clear when the client sends an explicit null; fields
        # simply absent from the payload are left untouched (model_fields_set).
        NULLABLE = {"nct_due", "nct_booked", "tax_due", "insurance_due",
                    "service_interval_km", "service_interval_months", "belt_interval_km", "year", "vin"}
        for field in ("name", "reg", "fuel_type", "make", "model", "year", "vin",
                      "nct_due", "nct_booked", "tax_due", "insurance_due",
                      "service_interval_km", "service_interval_months", "belt_interval_km"):
            v = getattr(patch, field)
            if v is not None or (field in NULLABLE and field in patch.model_fields_set):
                sets.append(f"{field}=?"); vals.append(v)
        if patch.ev_enabled is not None:
            sets.append("ev_enabled=?"); vals.append(int(patch.ev_enabled))
        if patch.archived is not None:
            sets.append("archived=?"); vals.append(int(patch.archived))
        if sets:
            con.execute(f"UPDATE cars SET {', '.join(sets)} WHERE id=?", (*vals, car_id))
        return dict(car_or_404(con, car_id))


@app.get("/api/cars/{car_id}")
def car_detail(car_id: int, year: int | None = None):
    y = year or date.today().year
    with db() as con:
        car = car_or_404(con, car_id)
        entries = con.execute(
            "SELECT * FROM entries WHERE car_id=? ORDER BY date DESC, id DESC LIMIT 50",
            (car_id,)).fetchall()
        cur_odo = con.execute(
            "SELECT odometer FROM entries WHERE car_id=? AND odometer IS NOT NULL "
            "ORDER BY date DESC, id DESC LIMIT 1", (car_id,)).fetchone()
        years = [r["y"] for r in con.execute(
            "SELECT DISTINCT substr(date,1,4) y FROM entries WHERE car_id=? ORDER BY y DESC",
            (car_id,))]
        labels = {"nct_due": "NCT", "nct_booked": "NCT test", "tax_due": "Tax", "insurance_due": "Insurance"}
        car_dues = [
            {"item": lbl, "date": car[f], "days": (date.fromisoformat(car[f]) - date.today()).days}
            for f, lbl in labels.items() if car[f]]
        cur_val = cur_odo["odometer"] if cur_odo else None
        svc = service_due(con, car, cur_val)
        if svc:
            car_dues.append({"item": "Service", "date": svc["date"], "days": svc["days"]})
        car_dues.sort(key=lambda i: i["days"])
        service_log = [dict(r) for r in con.execute(
            "SELECT id, date, odometer, cost, note FROM entries "
            "WHERE car_id=? AND category='service' ORDER BY date DESC, id DESC", (car_id,))]
        return {"car": dict(car),
                "next_due": car_dues[0] if car_dues else None,
                "service_due": svc,
                "belt_due": belt_due(con, car, cur_val),
                "service_log": service_log,
                "current_odo": cur_val,
                "summary": year_summary(con, car_id, y),
                "fuel": fuel_stats(con, car_id),
                "entries": [dict(e) for e in entries],
                "years": years}


@app.post("/api/cars/{car_id}/entries", status_code=201)
def add_entry(car_id: int, e: EntryNew):
    if e.category not in CATEGORIES:
        raise HTTPException(422, f"category must be one of {CATEGORIES}")
    d = e.date or date.today().isoformat()
    cost = e.cost
    if cost is None and e.category == "fuel" and e.litres and e.price_per_litre:
        cost = round(e.litres * e.price_per_litre, 2)
    if (e.category == "fuel" and e.price_per_litre is None and cost and e.litres):
        e.price_per_litre = round(cost / e.litres, 3)
    if cost is None and e.category == "charge" and e.kwh and e.price_per_kwh:
        cost = round(e.kwh * e.price_per_kwh, 2)
    if e.category == "odo":
        if e.odometer is None:
            raise HTTPException(422, "odometer reading is required for a mileage entry")
        cost = 0
    if e.category == "belt":
        if cost is None:
            raise HTTPException(422, "amount is required for a timing belt entry")
        if e.odometer is None:
            raise HTTPException(422, "odometer reading is required for a timing belt entry")
    if e.category == "fuel":
        if cost is None:
            raise HTTPException(422, "amount is required for a fuel entry")
        if e.odometer is None:
            raise HTTPException(422, "odometer reading is required for a fuel entry")
    if cost is None:
        raise HTTPException(422, "cost is required (or litres+price / kwh+price for fuel/charge)")
    with db() as con:
        car_or_404(con, car_id)
        if e.odometer is not None:
            prev = con.execute(
                "SELECT odometer, date FROM entries WHERE car_id=? AND odometer IS NOT NULL "
                "AND date <= ? ORDER BY date DESC, id DESC LIMIT 1", (car_id, d)).fetchone()
            if prev and e.odometer < prev["odometer"]:
                raise HTTPException(422,
                    f"odometer can't go backwards: the reading on {prev['date']} was "
                    f"{prev['odometer']:g} km")
            nxt = con.execute(
                "SELECT odometer, date FROM entries WHERE car_id=? AND odometer IS NOT NULL "
                "AND date > ? ORDER BY date ASC, id ASC LIMIT 1", (car_id, d)).fetchone()
            if nxt and e.odometer > nxt["odometer"]:
                raise HTTPException(422,
                    f"odometer too high for {d}: the reading on {nxt['date']} was "
                    f"{nxt['odometer']:g} km")
        cur = con.execute(
            "INSERT INTO entries (car_id, date, category, odometer, litres, price_per_litre, "
            "kwh, price_per_kwh, cost, note) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (car_id, d, e.category, e.odometer, e.litres, e.price_per_litre,
             e.kwh, e.price_per_kwh, cost, e.note))
        return dict(con.execute("SELECT * FROM entries WHERE id=?", (cur.lastrowid,)).fetchone())


@app.delete("/api/entries/{entry_id}", status_code=204)
def delete_entry(entry_id: int):
    with db() as con:
        if con.execute("DELETE FROM entries WHERE id=?", (entry_id,)).rowcount == 0:
            raise HTTPException(404, "no such entry")


@app.post("/api/cars/{car_id}/photo")
async def upload_photo(car_id: int, file: UploadFile):
    """Store the car's photo (resized); it becomes the card thumbnail and page image."""
    with db() as con:
        car_or_404(con, car_id)
    os.makedirs(PHOTO_DIR, exist_ok=True)
    try:
        img = Image.open(file.file)
        img = ImageOps.exif_transpose(img).convert("RGB")
    except Exception:
        raise HTTPException(422, "not a readable image")
    img.thumbnail((1200, 1200))
    img.save(os.path.join(PHOTO_DIR, f"{car_id}.jpg"), "JPEG", quality=82)
    thumb = ImageOps.fit(img, (320, 320))
    thumb.save(os.path.join(PHOTO_DIR, f"{car_id}.thumb.jpg"), "JPEG", quality=80)
    with db() as con:
        con.execute("UPDATE cars SET photo_ver = photo_ver + 1 WHERE id=?", (car_id,))
        return dict(car_or_404(con, car_id))


@app.get("/photos/{name}")
def photo(name: str):
    path = os.path.join(PHOTO_DIR, os.path.basename(name))
    if not os.path.isfile(path):
        raise HTTPException(404, "no photo")
    return FileResponse(path)


@app.get("/api/dues")
def dues():
    """Upcoming renewals in a dict shape suited to a Home Assistant REST sensor."""
    labels = {"nct_due": "NCT", "nct_booked": "NCT test", "tax_due": "Tax", "insurance_due": "Insurance"}
    items = []
    today_d = date.today()
    with db() as con:
        for car in con.execute("SELECT * FROM cars WHERE archived = 0 ORDER BY id"):
            for field, label in labels.items():
                v = car[field]
                if v:
                    days = (date.fromisoformat(v) - today_d).days
                    items.append({"car": car["name"], "item": label, "date": v, "days": days})
            cur = con.execute(
                "SELECT odometer FROM entries WHERE car_id=? AND odometer IS NOT NULL "
                "ORDER BY date DESC, id DESC LIMIT 1", (car["id"],)).fetchone()
            svc = service_due(con, car, cur["odometer"] if cur else None)
            if svc:
                items.append({"car": car["name"], "item": "Service", "date": svc["date"], "days": svc["days"]})
    items.sort(key=lambda i: i["days"])
    return {"items": items, "next_days": items[0]["days"] if items else None}


@app.get("/healthz")
def healthz():
    with db() as con:
        con.execute("SELECT 1")
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(os.path.join(os.path.dirname(__file__), "static", "index.html"))


app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")

init_db()
