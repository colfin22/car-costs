"""Car Costs — a small self-hosted running-costs tracker for the household cars.

FastAPI + SQLite, no ORM. The UI is a single mobile-first page (static/).
Categories: fuel, insurance, tax, nct, service — plus charge (kWh), which the
UI only shows for cars with the electric toggle on, so an EV/PHEV can be
enabled later with no schema change.
"""
import os
import sqlite3
from contextlib import contextmanager
from datetime import date

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DB_PATH = os.environ.get("CARCOSTS_DB", os.path.join(os.path.dirname(__file__), "data", "carcosts.db"))

CATEGORIES = ("fuel", "charge", "insurance", "tax", "nct", "service")
FUEL_TYPES = ("petrol", "diesel", "hybrid", "phev", "ev")

app = FastAPI(title="Car Costs")


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
        if con.execute("SELECT COUNT(*) c FROM cars").fetchone()["c"] == 0:
            con.execute("INSERT INTO cars (name) VALUES ('Car 1')")
            con.execute("INSERT INTO cars (name) VALUES ('Car 2')")


class CarPatch(BaseModel):
    name: str | None = None
    reg: str | None = None
    fuel_type: str | None = None
    ev_enabled: bool | None = None


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
    by_cat = {r["category"]: round(r["total"], 2) for r in rows}
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
def list_cars():
    year = date.today().year
    with db() as con:
        return [dict(c) | {"summary": year_summary(con, c["id"], year),
                           "fuel": fuel_stats(con, c["id"])}
                for c in con.execute("SELECT * FROM cars ORDER BY id")]


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
        for field in ("name", "reg", "fuel_type"):
            v = getattr(patch, field)
            if v is not None:
                sets.append(f"{field}=?"); vals.append(v)
        if patch.ev_enabled is not None:
            sets.append("ev_enabled=?"); vals.append(int(patch.ev_enabled))
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
        years = [r["y"] for r in con.execute(
            "SELECT DISTINCT substr(date,1,4) y FROM entries WHERE car_id=? ORDER BY y DESC",
            (car_id,))]
        return {"car": dict(car),
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
    if cost is None and e.category == "charge" and e.kwh and e.price_per_kwh:
        cost = round(e.kwh * e.price_per_kwh, 2)
    if cost is None:
        raise HTTPException(422, "cost is required (or litres+price / kwh+price for fuel/charge)")
    with db() as con:
        car_or_404(con, car_id)
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
