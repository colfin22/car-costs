"""Car Costs — a small self-hosted running-costs tracker for the household cars.

FastAPI + SQLite, no ORM. The UI is a single mobile-first page (static/).
Categories: fuel, insurance, tax, nct, service, toll, parking, misc — plus charge
(kWh), which the UI only shows for cars with the electric toggle on, so an
EV/PHEV can be enabled later with no schema change.

Toll and parking entries carry a `period`: '' for a single charge, 'month' for
a monthly total off a tag account or a parking permit. Monthly entries are
stored dated to the 1st of their month.
"""
import hashlib
import hmac
import ipaddress
import json
import os
import secrets as pysecrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import date

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from PIL import Image, ImageOps

DB_PATH = os.environ.get("CARCOSTS_DB", os.path.join(os.path.dirname(__file__), "data", "carcosts.db"))
PHOTO_DIR = os.path.join(os.path.dirname(DB_PATH), "photos")
DOCS_DIR = os.path.join(os.path.dirname(DB_PATH), "docs")
MAX_DOC_BYTES = int(os.environ.get("CARCOSTS_MAX_DOC_MB", "10")) * 1024 * 1024

CATEGORIES = ("fuel", "charge", "insurance", "tax", "nct", "service", "odo", "belt", "tyres", "tyre_check", "check", "repair", "toll", "parking", "misc")
PERIODIC = ("toll", "parking")   # categories that also accept a monthly total
TYRE_CORNERS = ("FL", "FR", "RL", "RR")
BASELINE_NOTE = "Full tread when fitted"   # marks the check a tyre fitting writes for itself
FUEL_TYPES = ("petrol", "diesel", "hybrid", "phev", "ev")

APP_VERSION = "1.17.0"   # bump on release; shown on the home screen

app = FastAPI(title="Car Costs", version=APP_VERSION)


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


def get_setting(con, key: str, default: str = "") -> str:
    row = con.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(con, key: str, value: str) -> None:
    con.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, str(value)))


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


# ---- optional TOTP second factor (checked at /login, before the cookie) ----
# Off unless you turn it on from the app. It is a second factor on top of the
# password, so it needs one: with no CARCOSTS_PASSWORD there is nothing to be
# second to. The session cookie is unchanged — a valid cookie still means "both
# factors passed" — so 2FA only ever adds a step at login. Secret + backup-code
# hashes live in the settings table.
BACKUP_CODE_COUNT = 8
STAGE_SECONDS = 300   # how long the password step stays good for while you fetch a code


def _pyotp():
    """pyotp/qrcode are imported lazily so an install without them still runs;
    TOTP simply reports itself unavailable and the rest of the app is untouched."""
    try:
        import pyotp
        return pyotp
    except ImportError:
        return None


def totp_available() -> bool:
    """Both halves have to be there: pyotp to verify, qrcode to enrol."""
    try:
        import qrcode.image.svg   # noqa: F401
    except ImportError:
        return False
    return _pyotp() is not None


def totp_secret() -> str:
    with db() as con:
        return get_setting(con, "totp_secret")


def totp_is_enabled() -> bool:
    with db() as con:
        return get_setting(con, "totp_enabled") == "1" and bool(get_setting(con, "totp_secret"))


def new_totp_secret() -> str:
    """Mint a fresh secret. It is NOT active until a code from the app confirms
    it, so a mistyped scan can never lock you out."""
    sec = _pyotp().random_base32()
    with db() as con:
        set_setting(con, "totp_secret", sec)
        set_setting(con, "totp_enabled", "0")
        set_setting(con, "totp_backup_codes", "[]")
    return sec


def totp_uri(secret: str | None = None) -> str:
    sec = secret or totp_secret()
    return _pyotp().TOTP(sec).provisioning_uri(name="Car Costs", issuer_name="Car Costs")


def check_totp(code: str) -> bool:
    sec = totp_secret()
    code = str(code or "").strip().replace(" ", "")
    if not sec or not code.isdigit() or not _pyotp():
        return False
    return _pyotp().TOTP(sec).verify(code, valid_window=1)   # ±30s clock tolerance


def enable_totp(code: str) -> bool:
    if not check_totp(code):
        return False
    with db() as con:
        set_setting(con, "totp_enabled", "1")
    return True


def disable_totp() -> None:
    with db() as con:
        set_setting(con, "totp_enabled", "0")
        set_setting(con, "totp_secret", "")
        set_setting(con, "totp_backup_codes", "[]")


# Single-use recovery codes, accepted anywhere a 6-digit code is. Stored as
# HMACs of the server secret; the plaintext is shown once and never again.
def _hash_backup_code(code: str) -> str:
    norm = str(code or "").strip().lower().replace("-", "").replace(" ", "")
    return hmac.new(_secret().encode(), norm.encode(), hashlib.sha256).hexdigest()


def generate_backup_codes() -> list[str]:
    """Mint a fresh set, invalidating any old one, and return the plaintext once."""
    codes = [pysecrets.token_hex(4) for _ in range(BACKUP_CODE_COUNT)]
    pretty = [c[:4] + "-" + c[4:] for c in codes]
    with db() as con:
        set_setting(con, "totp_backup_codes", json.dumps([_hash_backup_code(c) for c in pretty]))
    return pretty


def _backup_hashes() -> list[str]:
    with db() as con:
        try:
            return json.loads(get_setting(con, "totp_backup_codes", "[]") or "[]")
        except ValueError:
            return []


def backup_codes_remaining() -> int:
    return len(_backup_hashes())


def consume_backup_code(code: str) -> bool:
    """Verify and burn a recovery code. A 6-digit TOTP never matches one."""
    norm = str(code or "").strip().lower().replace("-", "").replace(" ", "")
    if not norm:
        return False
    target = _hash_backup_code(norm)
    hashes = _backup_hashes()
    match = next((h for h in hashes if hmac.compare_digest(h, target)), None)
    if match is None:
        return False
    hashes.remove(match)
    with db() as con:
        set_setting(con, "totp_backup_codes", json.dumps(hashes))
    return True


def second_factor_ok(code: str) -> bool:
    return check_totp(code) or consume_backup_code(code)


def totp_qr_svg(uri: str) -> str:
    """Inline SVG QR — pure python, no external request, so it renders inside the
    app's own page with nothing loaded from off-site."""
    import io

    import qrcode
    import qrcode.image.svg
    buf = io.BytesIO()
    qrcode.make(uri, image_factory=qrcode.image.svg.SvgPathImage, border=2).save(buf)
    return buf.getvalue().decode()


# The password step hands out a short-lived signed token so step two cannot be
# reached without it. Signed with the server secret, so it cannot be forged;
# holding one still means the password was entered within the last few minutes.
def _stage_token(exp: int) -> str:
    return hmac.new(_secret().encode(), f"stage:{exp}".encode(), hashlib.sha256).hexdigest()


def _stage_ok(token: str, exp: str) -> bool:
    try:
        expiry = int(exp)
    except (TypeError, ValueError):
        return False
    return expiry > time.time() and hmac.compare_digest(str(token or ""), _stage_token(expiry))


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
.err{color:#b3261e;font-size:.85rem;margin-top:8px}
.hint{color:#6b7280;font-size:.85rem;margin:10px 0 0}</style></head><body>
<form method="post" action="/login"><h1>Car Costs</h1>
{fields}{err}
<button>Sign in</button></form></body></html>"""

PASSWORD_FIELD = ('<input type="password" name="password" placeholder="Password" '
                  'autocomplete="current-password" autofocus required>')

CODE_FIELD = ('<input type="text" name="code" placeholder="6-digit code" inputmode="numeric" '
              'autocomplete="one-time-code" autofocus required>'
              '<input type="hidden" name="stage" value="{stage}">'
              '<input type="hidden" name="exp" value="{exp}">'
              '<p class="hint">From your authenticator app. A recovery code works too.</p>')


def _login_html(fields: str, err: str = "") -> str:
    return LOGIN_PAGE.replace("{fields}", fields).replace(
        "{err}", f'<div class="err">{err}</div>' if err else "")


def _code_step_html(err: str = "") -> str:
    exp = int(time.time()) + STAGE_SECONDS
    return _login_html(CODE_FIELD.replace("{stage}", _stage_token(exp)).replace("{exp}", str(exp)), err)


def _signed_in_response():
    from fastapi.responses import RedirectResponse
    resp = RedirectResponse("/", status_code=302)
    resp.set_cookie(AUTH_COOKIE, _token(), max_age=SESSION_DAYS * 86400,
                    httponly=True, secure=True, samesite="none")
    return resp


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
    return HTMLResponse(_login_html(PASSWORD_FIELD))


@app.post("/login")
async def login_submit(request: Request):
    """Two steps when 2FA is on: password, then a code. The cookie is only set
    once both have passed, so nothing downstream needs to know about either."""
    from fastapi.responses import HTMLResponse
    form = await request.form()

    if form.get("stage"):   # step two: the code, carrying the signed password step
        if not _stage_ok(str(form.get("stage")), str(form.get("exp"))):
            return HTMLResponse(_login_html(PASSWORD_FIELD, "That took too long. Start again"),
                                status_code=401)
        if second_factor_ok(str(form.get("code") or "")):
            return _signed_in_response()
        time.sleep(1.5)   # blunt brute-force damper
        return HTMLResponse(_code_step_html("Wrong code"), status_code=401)

    attempt = str(form.get("password") or "")
    if _password() and hmac.compare_digest(attempt, _password()):
        if totp_is_enabled():
            return HTMLResponse(_code_step_html())
        return _signed_in_response()
    time.sleep(1.5)
    return HTMLResponse(_login_html(PASSWORD_FIELD, "Wrong password"), status_code=401)


# Enrolment lives behind the same gate as everything else, so a tunnel request
# needs a session first. Internal callers are exempt here exactly as they are
# for the rest of the API — on the LAN this app has never held anything back.
@app.get("/api/totp")
def totp_status():
    return {"available": totp_available(), "enabled": totp_is_enabled(),
            "password_set": _password() is not None,
            "pending": bool(totp_secret()) and not totp_is_enabled(),
            "backup_codes_remaining": backup_codes_remaining()}


@app.post("/api/totp/setup")
def totp_setup():
    """Mint a secret and hand back the QR. Nothing changes about logging in
    until a code confirms it."""
    if not totp_available():
        raise HTTPException(503, "This install is missing pyotp. Add it and restart")
    if not _password():
        raise HTTPException(422, "Set CARCOSTS_PASSWORD first. A second factor needs a first one")
    if totp_is_enabled():
        raise HTTPException(422, "Already on. Turn it off before setting up again")
    secret = new_totp_secret()
    return {"secret": secret, "uri": totp_uri(secret), "qr_svg": totp_qr_svg(totp_uri(secret))}


class CodeIn(BaseModel):
    code: str = ""


@app.post("/api/totp/enable")
def totp_enable(body: CodeIn):
    if not totp_secret():
        raise HTTPException(422, "Nothing to confirm. Start the setup first")
    if not enable_totp(body.code):
        raise HTTPException(422, "That code did not match. Check the clock on your phone and try again")
    return {"enabled": True, "backup_codes": generate_backup_codes()}


@app.post("/api/totp/disable")
def totp_disable(body: CodeIn):
    if not totp_is_enabled():
        disable_totp()   # clears a half-finished setup
        return {"enabled": False}
    if not second_factor_ok(body.code):
        raise HTTPException(422, "Wrong code")
    disable_totp()
    return {"enabled": False}


@app.post("/api/totp/backup-codes")
def totp_new_backup_codes(body: CodeIn):
    if not totp_is_enabled():
        raise HTTPException(422, "Two-factor login is off")
    if not second_factor_ok(body.code):
        raise HTTPException(422, "Wrong code")
    return {"backup_codes": generate_backup_codes()}
# ---------------------------------------------------------------------------


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
        CREATE TABLE IF NOT EXISTS attachments (
          id INTEGER PRIMARY KEY,
          car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
          entry_id INTEGER REFERENCES entries(id) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          created TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_attachments_entry ON attachments(entry_id);
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL DEFAULT ''
        );
        """)
        have = {r["name"] for r in con.execute("PRAGMA table_info(cars)")}
        for col, typ in (("make", "TEXT DEFAULT ''"), ("model", "TEXT DEFAULT ''"),
                         ("year", "INTEGER"), ("vin", "TEXT DEFAULT ''"),
                         ("nct_due", "TEXT"), ("nct_booked", "TEXT"), ("tax_due", "TEXT"), ("insurance_due", "TEXT"),
                         ("photo_ver", "INTEGER NOT NULL DEFAULT 0"),
                         ("archived", "INTEGER NOT NULL DEFAULT 0"),
                         ("service_interval_km", "INTEGER"),
                         ("service_interval_months", "INTEGER"),
                         ("belt_interval_km", "INTEGER"),
                         ("belt_interval_years", "INTEGER")):
            if col not in have:
                con.execute(f"ALTER TABLE cars ADD COLUMN {col} {typ}")
        have_e = {r["name"] for r in con.execute("PRAGMA table_info(entries)")}
        for col in ("corners", "tyre_size", "tyre_brand", "tread_mm", "period"):
            if col not in have_e:
                con.execute(f"ALTER TABLE entries ADD COLUMN {col} TEXT DEFAULT ''")
        have_a = {r["name"] for r in con.execute("PRAGMA table_info(attachments)")}
        for col in ("note",):   # issue #47; the first column this table has gained
            if col not in have_a:
                con.execute(f"ALTER TABLE attachments ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
        if con.execute("SELECT COUNT(*) c FROM cars").fetchone()["c"] == 0:
            con.execute("INSERT INTO cars (name) VALUES ('My Car')")


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
    belt_interval_years: int | None = None
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
    corners: str = ""            # tyres/tyre_check: CSV of FL/FR/RL/RR
    tyre_size: str = ""          # tyres: e.g. 205/55 R16
    tyre_brand: str = ""         # tyres: e.g. Michelin CrossClimate 2
    tread_mm: str = ""           # tyre_check: e.g. FL=4.0,FR=3.5
    period: str = ""             # toll/parking: "" one charge, "month" a monthly total


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
    """Dual deadline like servicing — km and years from the last belt change,
    whichever comes first (e.g. 160,000 km or 8 years)."""
    if not car["belt_interval_km"] and not car["belt_interval_years"]:
        return None
    last = con.execute(
        "SELECT date, odometer FROM entries WHERE car_id=? AND category='belt' "
        "AND odometer IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1", (car["id"],)).fetchone()
    if not last:
        return None
    next_km = km_left = due_date = days = None
    if car["belt_interval_km"]:
        next_km = round(last["odometer"] + car["belt_interval_km"])
        if current_odo is not None:
            km_left = round(next_km - current_odo)
    if car["belt_interval_years"]:
        due_date = add_months(date.fromisoformat(last["date"]), car["belt_interval_years"] * 12)
        days = (due_date - date.today()).days
    binding = "time" if days is not None else "km"
    if days is not None and km_left is not None:
        ratio_time = days / (car["belt_interval_years"] * 365.25)
        ratio_km = km_left / car["belt_interval_km"]
        binding = "km" if ratio_km < ratio_time else "time"
    return {"binding": binding, "next_km": next_km, "km_left": km_left,
            "date": due_date.isoformat() if due_date else None, "days": days,
            "last_change": last["date"], "last_odo": round(last["odometer"])}


def tyres_current(con, car_id: int):
    """Latest tyre fitted per corner — each corner's record comes from the most
    recent tyres entry whose corner list covers it."""
    rows = con.execute(
        "SELECT date, odometer, corners, tyre_size, tyre_brand FROM entries "
        "WHERE car_id=? AND category='tyres' ORDER BY date DESC, id DESC", (car_id,)).fetchall()
    out = {}
    for r in rows:
        for corner in (r["corners"] or "").split(","):
            if corner in TYRE_CORNERS and corner not in out:
                out[corner] = {"date": r["date"], "odometer": r["odometer"],
                               "size": r["tyre_size"] or "", "brand": r["tyre_brand"] or ""}
    return out


def tyre_checks_current(con, car_id: int):
    """Latest inspection per corner. A check newer than a corner's fitting is
    superseded by the fitting itself (new tyre = old reading meaningless)."""
    fitted = tyres_current(con, car_id)
    rows = con.execute(
        "SELECT date, corners, tread_mm, note FROM entries "
        "WHERE car_id=? AND category='tyre_check' ORDER BY date DESC, id DESC", (car_id,)).fetchall()
    out = {}
    for r in rows:
        mm = dict(p.split("=", 1) for p in (r["tread_mm"] or "").split(",") if "=" in p)
        for corner in (r["corners"] or "").split(","):
            if corner not in TYRE_CORNERS or corner in out:
                continue
            f = fitted.get(corner)
            if f and r["date"] < f["date"]:
                continue
            val = mm.get(corner)
            out[corner] = {"date": r["date"],
                           "mm": float(val) if val else None, "note": r["note"] or ""}
    return out


LEGAL_TREAD_MM = 1.6


def tyre_history(con, car_id: int):
    """Per corner: every tread reading since that corner's current tyres were
    fitted, newest first, with the wear between consecutive readings and — once
    there are two readings to work from — an estimated wear rate and how far
    off the legal minimum is. Readings from before the fitting are dropped, so
    a new tyre starts a fresh history (same rule as tyre_checks_current)."""
    fitted = tyres_current(con, car_id)
    rows = con.execute(
        "SELECT id, date, corners, tread_mm, odometer FROM entries "
        "WHERE car_id=? AND category='tyre_check' ORDER BY date DESC, id DESC",
        (car_id,)).fetchall()
    odo_cache = {}
    out = {}
    for r in rows:
        mm = dict(p.split("=", 1) for p in (r["tread_mm"] or "").split(",") if "=" in p)
        for corner in (r["corners"] or "").split(","):
            if corner not in TYRE_CORNERS or corner not in mm:
                continue
            f = fitted.get(corner)
            if f and r["date"] < f["date"]:
                continue
            # A check rarely carries its own odometer; fall back to the reading
            # that stood on that date so older entries still yield km figures.
            if r["odometer"] is not None:
                odo, inferred = r["odometer"], False
            else:
                if r["date"] not in odo_cache:
                    odo_cache[r["date"]] = current_odo_of(con, car_id, r["date"])
                odo, inferred = odo_cache[r["date"]], True
            out.setdefault(corner, []).append(
                {"entry_id": r["id"], "date": r["date"], "mm": float(mm[corner]),
                 "odometer": odo, "odo_inferred": inferred and odo is not None})

    result = {}
    for corner, readings in out.items():
        for i, cur in enumerate(readings):            # newest first
            prev = readings[i + 1] if i + 1 < len(readings) else None
            cur["delta_mm"] = round(cur["mm"] - prev["mm"], 2) if prev else None
            cur["km"] = (round(cur["odometer"] - prev["odometer"])
                         if prev and None not in (cur["odometer"], prev["odometer"]) else None)
        latest, oldest = readings[0], readings[-1]
        rate = km_left = None
        if len(readings) > 1 and None not in (latest["odometer"], oldest["odometer"]):
            worn = oldest["mm"] - latest["mm"]
            km = latest["odometer"] - oldest["odometer"]
            if worn > 0 and km > 0:                   # a deeper reading than before proves nothing
                rate = round(worn / km * 10000, 2)    # mm per 10,000 km
                if latest["mm"] > LEGAL_TREAD_MM:
                    km_left = round((latest["mm"] - LEGAL_TREAD_MM) / rate * 10000)
        result[corner] = {"readings": readings, "rate_mm_per_10k": rate, "km_to_legal": km_left,
                          "fitted": fitted.get(corner)}
    return result


def normalise_tread(tread_mm: str, corners: str) -> str:
    """'FL=8,RR=2.75' -> canonical corner order, depths validated as numbers."""
    pairs = {}
    for p in (t for t in (tread_mm or "").split(",") if t):
        k, _, v = p.partition("=")
        if k not in corners.split(","):
            raise HTTPException(422, f"tread reading for {k} but that corner isn't selected")
        try:
            pairs[k] = float(v)
        except ValueError:
            raise HTTPException(422, f"tread depth for {k} must be a number (mm)")
    return ",".join(f"{k}={pairs[k]:g}" for k in TYRE_CORNERS if k in pairs)


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
    by_cat = {r["category"]: round(r["total"], 2) for r in rows if r["category"] not in ("odo", "tyre_check", "check")}
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
    """Consumption and fuel cost per 100 km, pooled over the whole span of fills.

    EVERY fill counts, including the first, over the distance from the first
    odometer to the last. The usual convention excludes the first fill, on the
    grounds that its fuel was already in the tank when measuring started. That
    only holds when the tank sits at the same level at both ends, and it is
    catastrophic over a short history: with two fills it discards most of the
    fuel bought while still counting all of the distance, which is how this once
    reported 1.5 L/100km for a diesel Focus.

    Counting everything has the opposite bias, overstating by whatever is still
    in the tank unburned, but that is bounded by tank size and shrinks as the
    distance grows. The two conventions converge after enough fills.

    Litres were optional until 2026-08-13, so an older fill may have none. Such a
    fill breaks the consumption run: the longest run of consecutive fills that
    ALL carry litres wins. The cost figure needs only the amount and the
    odometer, both mandatory, so it always spans every fill.
    """
    fills = con.execute(
        "SELECT date, odometer, litres, cost FROM entries "
        "WHERE car_id=? AND category='fuel' AND odometer IS NOT NULL "
        "ORDER BY odometer", (car_id,)).fetchall()
    spend = sum(f["cost"] for f in fills)
    spend_dist = fills[-1]["odometer"] - fills[0]["odometer"] if len(fills) > 1 else 0.0

    best_litres = best_dist = 0.0                 # longest run of fills that all have litres
    run = []
    for f in list(fills) + [None]:
        if f is not None and f["litres"] is not None:
            run.append(f)
            continue
        if len(run) > 1:
            dist = run[-1]["odometer"] - run[0]["odometer"]
            if dist > best_dist:
                best_litres = sum(r["litres"] for r in run)
                best_dist = dist
        run = []
    last = con.execute(
        "SELECT price_per_litre FROM entries WHERE car_id=? AND category='fuel' "
        "AND price_per_litre IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1",
        (car_id,)).fetchone()
    return {
        "l_per_100km": round(100.0 * best_litres / best_dist, 1) if best_dist else None,
        "eur_per_100km": round(100.0 * spend / spend_dist, 2) if spend_dist > 0 else None,
        "last_price_per_litre": last["price_per_litre"] if last else None,
    }


DUE_LABELS = {"nct_due": "NCT", "nct_booked": "NCT test",
              "tax_due": "Tax", "insurance_due": "Insurance"}


def current_odo_of(con, car_id: int, on_date: str = None):
    """Latest odometer reading, optionally as it stood on a given date."""
    r = con.execute(
        "SELECT odometer FROM entries WHERE car_id=? AND odometer IS NOT NULL "
        + ("AND date <= ? " if on_date else "")
        + "ORDER BY date DESC, id DESC LIMIT 1",
        (car_id, on_date) if on_date else (car_id,)).fetchone()
    return r["odometer"] if r else None


def car_due_items(con, car, current_odo):
    """The car's upcoming date-based dues (renewals + service/belt), soonest first."""
    today_d = date.today()
    items = [{"item": lbl, "date": car[f], "days": (date.fromisoformat(car[f]) - today_d).days}
             for f, lbl in DUE_LABELS.items() if car[f]]
    svc = service_due(con, car, current_odo)
    if svc:
        items.append({"item": "Service", "date": svc["date"], "days": svc["days"]})
    bd = belt_due(con, car, current_odo)
    if bd and bd["date"]:
        items.append({"item": "Timing belt", "date": bd["date"], "days": bd["days"]})
    items.sort(key=lambda i: i["days"])
    return items


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
                    "service_interval_km", "service_interval_months",
                    "belt_interval_km", "belt_interval_years", "year", "vin"}
        for field in ("name", "reg", "fuel_type", "make", "model", "year", "vin",
                      "nct_due", "nct_booked", "tax_due", "insurance_due",
                      "service_interval_km", "service_interval_months",
                      "belt_interval_km", "belt_interval_years"):
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
        bd = belt_due(con, car, cur_val)
        if bd and bd["date"]:
            car_dues.append({"item": "Timing belt", "date": bd["date"], "days": bd["days"]})
        car_dues.sort(key=lambda i: i["days"])
        service_log = [dict(r) for r in con.execute(
            "SELECT id, date, category, odometer, cost, note, corners, tyre_size, tyre_brand "
            "FROM entries WHERE car_id=? AND category IN ('service','tyres','repair') "
            "ORDER BY date DESC, id DESC", (car_id,))]
        atts = con.execute(
            "SELECT id, entry_id, filename, media_type, size, created, note FROM attachments "
            "WHERE car_id=? ORDER BY created DESC, id DESC", (car_id,)).fetchall()
        by_entry = {}
        for a in atts:
            if a["entry_id"] is not None:
                # media_type rides along: the 📎 dialog decides from it whether a
                # row gets a thumbnail and a rotate button, and without it every
                # attachment there looked like a PDF.
                by_entry.setdefault(a["entry_id"], []).append(
                    {"id": a["id"], "filename": a["filename"], "media_type": a["media_type"],
                     "note": a["note"]})
        return {"car": dict(car),
                "attachments": [dict(a) for a in atts if a["entry_id"] is None],
                "next_due": car_dues[0] if car_dues else None,
                "service_due": svc,
                "belt_due": bd,
                "tyres": tyres_current(con, car_id),
                "tyre_checks": tyre_checks_current(con, car_id),
                "tyre_history": tyre_history(con, car_id),
                "service_log": service_log,
                "current_odo": cur_val,
                "summary": year_summary(con, car_id, y),
                "fuel": fuel_stats(con, car_id),
                "entries": [dict(e) | {"attachments": by_entry.get(e["id"], [])} for e in entries],
                "years": years}


def validate_entry(e: EntryNew):
    """The rules an entry must satisfy, shared by the add and edit paths so an
    edit can never be validated more loosely than a create.

    Normalises `e` in place (corners into canonical order, tread parsed, fuel
    price derived) and returns the stored date, the stored cost, and the tread
    that belongs on a tyre fitting's companion baseline check.
    """
    if e.category not in CATEGORIES:
        raise HTTPException(422, f"category must be one of {CATEGORIES}")
    d = e.date or date.today().isoformat()
    if e.period not in ("", "month"):
        raise HTTPException(422, "period must be '' or 'month'")
    if e.period and e.category not in PERIODIC:
        raise HTTPException(422, f"a monthly total is only allowed for {PERIODIC}")
    if e.period == "month":
        # Two monthly totals for the same month must not land on different days.
        d = d[:8] + "01"
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
    if e.category in ("tyres", "tyre_check"):
        picked = [c for c in e.corners.split(",") if c]
        if not picked or any(c not in TYRE_CORNERS for c in picked):
            raise HTTPException(422, f"corners must name at least one of {TYRE_CORNERS}")
        e.corners = ",".join(c for c in TYRE_CORNERS if c in picked)
    baseline_tread = ""
    if e.category == "tyres":
        if cost is None:
            raise HTTPException(422, "amount is required for a tyre entry")
        if e.odometer is None:
            raise HTTPException(422, "odometer reading is required for a tyre entry")
        # The full-tread baseline lives on a companion check, not here — tyres_current()
        # never reads tread_mm, so a value left on the fitting row would be invisible.
        baseline_tread = normalise_tread(e.tread_mm, e.corners)
        e.tread_mm = ""
    if e.category == "tyre_check":
        cost = 0
        e.tread_mm = normalise_tread(e.tread_mm, e.corners)
    if e.category == "check":
        cost = 0
        if not (e.note or "").strip():
            raise HTTPException(422, "a note is required for a check (what did you check?)")
    if e.category in PERIODIC and cost is None:
        raise HTTPException(422, f"amount is required for a {e.category} entry")
    if e.category == "misc":
        if cost is None:
            raise HTTPException(422, "amount is required for a misc entry")
        # The note is the only record of what it actually was.
        if not (e.note or "").strip():
            raise HTTPException(422, "a note is required for a misc entry (what was it?)")
    if e.category == "fuel":
        if cost is None:
            raise HTTPException(422, "amount is required for a fuel entry")
        if e.odometer is None:
            raise HTTPException(422, "odometer reading is required for a fuel entry")
        # Compulsory since 2026-08-13. Older fills may have none; those stay as they are
        # and break the L/100km run rather than being guessed at.
        if e.litres is None:
            raise HTTPException(422, "litres are required for a fuel entry")
    if cost is None:
        raise HTTPException(422, "cost is required (or litres+price / kwh+price for fuel/charge)")
    return d, cost, baseline_tread


def check_odometer(con, car_id: int, d: str, odometer, exclude_id: int = None):
    """A reading must sit between the ones either side of it in time. On an edit,
    exclude_id keeps the row being edited out of the comparison — without it an
    unchanged reading would fail against itself."""
    if odometer is None:
        return
    skip = " AND id != ?" if exclude_id else ""
    args = (car_id, d) + ((exclude_id,) if exclude_id else ())
    prev = con.execute(
        "SELECT odometer, date FROM entries WHERE car_id=? AND odometer IS NOT NULL "
        "AND date <= ?" + skip + " ORDER BY date DESC, id DESC LIMIT 1", args).fetchone()
    if prev and odometer < prev["odometer"]:
        raise HTTPException(422,
            f"odometer can't go backwards: the reading on {prev['date']} was "
            f"{prev['odometer']:g} km")
    nxt = con.execute(
        "SELECT odometer, date FROM entries WHERE car_id=? AND odometer IS NOT NULL "
        "AND date > ?" + skip + " ORDER BY date ASC, id ASC LIMIT 1", args).fetchone()
    if nxt and odometer > nxt["odometer"]:
        raise HTTPException(422,
            f"odometer too high for {d}: the reading on {nxt['date']} was "
            f"{nxt['odometer']:g} km")


def due_snapshot(con, car):
    """The state of everything an entry's date or odometer can move."""
    cur = current_odo_of(con, car["id"])
    return {"service": service_due(con, car, cur), "belt": belt_due(con, car, cur),
            "tyres": tyres_current(con, car["id"]),
            "tyre_checks": tyre_checks_current(con, car["id"])}


ANCHOR_KEYS = {"service": ("last_service", "date", "next_km", "binding"),
               "belt": ("last_change", "date", "next_km", "binding")}


def clock_changes(before: dict, after: dict) -> dict:
    """Only the clocks whose anchor actually moved. km_left legitimately shifts
    whenever any odometer changes, so it is deliberately not compared."""
    out = {}
    for key, fields in ANCHOR_KEYS.items():
        b, a = before[key], after[key]
        if (b is None) != (a is None):
            out[key] = {"before": b, "after": a}
        elif b and any(b.get(f) != a.get(f) for f in fields):
            out[key] = {"before": b, "after": a}
    for key in ("tyres", "tyre_checks"):
        if before[key] != after[key]:
            out[key] = {"before": before[key], "after": after[key]}
    return out


@app.post("/api/cars/{car_id}/entries", status_code=201)
def add_entry(car_id: int, e: EntryNew):
    d, cost, baseline_tread = validate_entry(e)
    with db() as con:
        car_or_404(con, car_id)
        check_odometer(con, car_id, d, e.odometer)
        cur = con.execute(
            "INSERT INTO entries (car_id, date, category, odometer, litres, price_per_litre, "
            "kwh, price_per_kwh, cost, note, corners, tyre_size, tyre_brand, tread_mm, period) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (car_id, d, e.category, e.odometer, e.litres, e.price_per_litre,
             e.kwh, e.price_per_kwh, cost, e.note, e.corners, e.tyre_size, e.tyre_brand,
             e.tread_mm, e.period))
        made = dict(con.execute("SELECT * FROM entries WHERE id=?", (cur.lastrowid,)).fetchone())
        if baseline_tread:
            # Same date as the fitting: tyre_checks_current() keeps a same-date check and
            # drops only ones that pre-date the fitting. Carries the fitting's odometer so
            # wear per km has both ends of the measurement.
            chk = con.execute(
                "INSERT INTO entries (car_id, date, category, odometer, cost, note, "
                "corners, tread_mm) VALUES (?,?,'tyre_check',?,0,?,?,?)",
                (car_id, d, e.odometer, BASELINE_NOTE, e.corners, baseline_tread))
            made["baseline_check_id"] = chk.lastrowid
        return made


def baseline_check_of(con, row):
    """A tyre fitting's baseline check: the check sharing its date and corners.

    Matching on date and corners rather than on the note is deliberate — baselines
    entered by hand before add_entry wrote them carry their own wording, and they
    are just as much the fitting's baseline. The one add_entry wrote wins if both
    somehow exist.
    """
    return con.execute(
        "SELECT * FROM entries WHERE car_id=? AND category='tyre_check' AND date=? "
        "AND corners=? ORDER BY (note=?) DESC, id LIMIT 1",
        (row["car_id"], row["date"], row["corners"], BASELINE_NOTE)).fetchone()


@app.patch("/api/entries/{entry_id}")
def edit_entry(entry_id: int, e: EntryNew, dry_run: bool = False):
    """Correct an entry in place. The category is fixed — the required fields
    differ per category and stale columns would need clearing, so that is left
    out of this first version.

    Because a date or an odometer can move a due clock, the caller is expected
    to run this once with dry_run=true, show the caller what would move, and
    only then save. The preview runs the real write and rolls it back, so what
    it reports is what saving actually does rather than a second guess at it.
    """
    with db() as con:
        row = con.execute("SELECT * FROM entries WHERE id=?", (entry_id,)).fetchone()
        if not row:
            raise HTTPException(404, "no such entry")
        if e.category != row["category"]:
            raise HTTPException(422,
                f"an entry's category can't be changed (this one is a {row['category']}) — "
                "delete it and add it again under the right category")
        car = car_or_404(con, row["car_id"])
        d, cost, baseline_tread = validate_entry(e)
        check_odometer(con, row["car_id"], d, e.odometer, exclude_id=entry_id)
        before = due_snapshot(con, car)
        # Found before the write, while it still matches the entry's old date and corners.
        companion = baseline_check_of(con, row) if row["category"] == "tyres" else None
        con.execute(
            "UPDATE entries SET date=?, odometer=?, litres=?, price_per_litre=?, kwh=?, "
            "price_per_kwh=?, cost=?, note=?, corners=?, tyre_size=?, tyre_brand=?, "
            "tread_mm=?, period=? WHERE id=?",
            (d, e.odometer, e.litres, e.price_per_litre, e.kwh, e.price_per_kwh, cost,
             e.note, e.corners, e.tyre_size, e.tyre_brand, e.tread_mm, e.period, entry_id))
        if companion:
            # The baseline is only visible because it shares the fitting's date, so it
            # has to move with it. A cleared tread means there is no baseline any more.
            if baseline_tread:
                con.execute(
                    "UPDATE entries SET date=?, odometer=?, corners=?, tread_mm=? WHERE id=?",
                    (d, e.odometer, e.corners, baseline_tread, companion["id"]))
            elif companion["note"] == BASELINE_NOTE:
                con.execute("DELETE FROM entries WHERE id=?", (companion["id"],))
            else:
                # A check written by hand is somebody's own record, not this fitting's
                # to throw away — move it with the fitting and leave its reading alone.
                con.execute("UPDATE entries SET date=?, corners=? WHERE id=?",
                            (d, e.corners, companion["id"]))
        elif baseline_tread and row["category"] == "tyres":
            chk = con.execute(
                "INSERT INTO entries (car_id, date, category, odometer, cost, note, "
                "corners, tread_mm) VALUES (?,?,'tyre_check',?,0,?,?,?)",
                (row["car_id"], d, e.odometer, BASELINE_NOTE, e.corners, baseline_tread))
            companion = con.execute("SELECT * FROM entries WHERE id=?", (chk.lastrowid,)).fetchone()
        after = due_snapshot(con, car)
        out = {"entry": dict(con.execute("SELECT * FROM entries WHERE id=?", (entry_id,)).fetchone()),
               "clock_change": clock_changes(before, after),
               "dry_run": dry_run}
        if dry_run:
            con.rollback()   # db() commits on the way out; this is what keeps a preview a preview
        return out


@app.delete("/api/entries/{entry_id}", status_code=204)
def delete_entry(entry_id: int):
    with db() as con:
        atts = con.execute("SELECT * FROM attachments WHERE entry_id=?", (entry_id,)).fetchall()
        if con.execute("DELETE FROM entries WHERE id=?", (entry_id,)).rowcount == 0:
            raise HTTPException(404, "no such entry")
    for att in atts:   # rows went with the FK cascade; files are ours to remove
        if os.path.isfile(doc_path(att)):
            os.remove(doc_path(att))
        drop_thumb(att)


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


# ---- document attachments (issue #15) --------------------------------------
# Receipts, certs and reports attach to an entry, or to the car itself when a
# document has no cost entry to hang on (insurance cert after a date-only
# renewal). Files are stored exactly as uploaded — no resizing, documents must
# stay legible — under data/docs/, named by attachment id with an extension
# derived from the sniffed type (never from the client's filename). Rotating one
# (issue #43) is the single exception, and it keeps the format and the name.
DOC_EXT = {"application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png",
           "image/webp": "webp", "image/heic": "heic"}
PIL_TYPES = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "HEIF": "image/heic"}


def doc_path(att) -> str:
    return os.path.join(DOCS_DIR, f"{att['id']}.{DOC_EXT[att['media_type']]}")


# A list of file names tells you nothing about which scan is which receipt
# (issue #44), so image rows carry a small picture. It is made on first request
# and cached beside the document, which keeps the upload path fast and means the
# attachments already on disk need no migration.
THUMB_PX = 200


def thumb_path(att) -> str:
    return os.path.join(DOCS_DIR, f"{att['id']}.thumb.jpg")


def drop_thumb(att) -> None:
    """Forget a cached thumbnail. Cheap: the next request draws it again."""
    if os.path.isfile(thumb_path(att)):
        os.remove(thumb_path(att))


# ---- scan auto-crop (issue #19) --------------------------------------------
# Finds the document in a camera photo and flattens it. This runs on the server
# on purpose: the first attempt did it in the browser with a 9 MB OpenCV build
# and never once worked on a phone, and a phone is the one machine here we can
# neither observe nor control. The phone now just uploads its photo.
#
# OpenCV is optional. Without it scan_available() is false, the preview endpoint
# says so, and the app quietly attaches photos as taken — the behaviour before
# this feature. Same shape as the optional pyotp/qrcode pair above.
DETECT_PX = 640          # detection runs on a downscale this wide; corners scale back up
CROP_MAX_PX = 2000       # cap the flattened output — one upload must not eat a 512 MB box
MIN_DOC_AREA = 0.15      # a quad smaller than this share of the frame is not the document
MAX_DOC_AREA = 0.99      # a quad this big is the frame itself, not a document in it


def _cv2():
    try:
        import cv2
        return cv2
    except ImportError:
        return None


def scan_available() -> bool:
    """OpenCV does the detection and the warp; numpy comes with it."""
    return _cv2() is not None


def _order_corners(pts):
    """Clockwise from the top left, so the warp target matches the source."""
    import numpy as np
    pts = np.array(pts, dtype="float32").reshape(4, 2)
    s, d = pts.sum(axis=1), np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)],
                     pts[np.argmax(s)], pts[np.argmax(d)]], dtype="float32")


def _upright_size(path) -> tuple[int, int]:
    """The photo's size the right way up, read from the header — nothing decoded."""
    with Image.open(path) as im:
        w, h = im.size
        try:
            orient = im.getexif().get(274, 1)
        except Exception:
            orient = 1
    return (h, w) if orient in (5, 6, 7, 8) else (w, h)


def _load_upright(path, target: int):
    """Decode at roughly `target` px, the right way up.

    🔴 Order matters: `draft()` only works on an undecoded JPEG, and
    `exif_transpose()` returns a decoded copy. Drafting *after* transposing is a
    no-op that silently decodes the whole photo — which is the difference between
    45 MB and 250 MB of resident memory on a 12 MP phone photo.
    """
    im = Image.open(path)
    im.draft("RGB", (target, target))
    return ImageOps.exif_transpose(im).convert("RGB")


def detect_document(path: str):
    """The document's four corners in full-image coordinates, or None.

    None is an ordinary answer — a photo of a dashboard has no document in it —
    and the caller keeps the original photo when it comes back.
    """
    cv2 = _cv2()
    if cv2 is None:
        return None
    import numpy as np
    full_w, full_h = _upright_size(path)
    if full_w < 50 or full_h < 50:
        return None
    small = _load_upright(path, DETECT_PX)
    small.thumbnail((DETECT_PX, DETECT_PX), Image.LANCZOS)
    arr = np.asarray(small)
    grey = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    grey = cv2.GaussianBlur(grey, (5, 5), 0)
    edges = cv2.Canny(grey, 60, 180)
    # Close small gaps in the outline; a receipt edge is rarely one clean line.
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    frame = arr.shape[0] * arr.shape[1]
    best = None
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:10]:
        peri = cv2.arcLength(c, True)
        quad = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(quad) != 4 or not cv2.isContourConvex(quad):
            continue
        share = abs(cv2.contourArea(quad)) / frame
        if MIN_DOC_AREA <= share <= MAX_DOC_AREA:
            best = quad
            break                      # contours are area-sorted, so the first fit is the biggest
    if best is None:
        return None
    sx, sy = full_w / arr.shape[1], full_h / arr.shape[0]
    return [(float(x) * sx, float(y) * sy) for x, y in best.reshape(4, 2)]


def crop_document(path: str) -> bytes | None:
    """The document flattened to a rectangle, as JPEG bytes. None if no document."""
    cv2 = _cv2()
    corners = detect_document(path) if cv2 else None
    if corners is None:
        return None
    import numpy as np
    full_w, full_h = _upright_size(path)
    # Decode only as much as the capped output actually needs. Detection has already
    # told us how much of the frame the document fills, so a receipt covering half
    # the photo needs twice CROP_MAX_PX decoded and no more. On a 512 MB box the
    # decode peak is the binding constraint, and a full 12 MP decode is most of it.
    xs = [p[0] for p in corners]
    ys = [p[1] for p in corners]
    doc_edge = max(max(xs) - min(xs), max(ys) - min(ys)) or 1
    im = _load_upright(path, int(CROP_MAX_PX * max(full_w, full_h) / doc_edge))
    src = np.asarray(im)
    shrink = im.size[0] / full_w if full_w else 1.0
    if shrink != 1.0:
        corners = [(x * shrink, y * shrink) for x, y in corners]
    quad = _order_corners(corners)
    tl, tr, br, bl = quad
    w = max(np.hypot(*(tr - tl)), np.hypot(*(br - bl)))
    h = max(np.hypot(*(bl - tl)), np.hypot(*(br - tr)))
    if w < 40 or h < 40:
        return None
    scale = min(1.0, CROP_MAX_PX / max(w, h))
    w, h = int(round(w * scale)), int(round(h * scale))
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype="float32")
    warped = cv2.warpPerspective(src, cv2.getPerspectiveTransform(quad, dst), (w, h))
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(warped, cv2.COLOR_RGB2BGR),
                           [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    return buf.tobytes() if ok else None


async def _receive_doc(file: UploadFile) -> tuple[str, str, int]:
    """Stream the upload to a temp file (capped), sniff its real type.
    Returns (tmp_path, media_type, size); raises 422/413 on bad input."""
    os.makedirs(DOCS_DIR, exist_ok=True)
    tmp = os.path.join(DOCS_DIR, f".upload-{pysecrets.token_hex(8)}")
    size = 0
    try:
        with open(tmp, "wb") as out:
            while chunk := await file.read(256 * 1024):
                size += len(chunk)
                if size > MAX_DOC_BYTES:
                    raise HTTPException(413, f"file too large (max {MAX_DOC_BYTES // (1024 * 1024)} MB)")
                out.write(chunk)
        if size == 0:
            raise HTTPException(422, "empty file")
        with open(tmp, "rb") as f:
            head = f.read(8)
        if head.startswith(b"%PDF"):
            return tmp, "application/pdf", size
        try:
            img = Image.open(tmp)
            fmt = img.format
            img.verify()
        except Exception:
            raise HTTPException(422, "only PDF and image files (JPEG/PNG/WebP) are accepted")
        media = PIL_TYPES.get(fmt)
        if not media:
            raise HTTPException(422, f"unsupported image format {fmt} — use JPEG/PNG/WebP or PDF")
        return tmp, media, size
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def _store_doc(con, car_id: int, entry_id: int | None, file: UploadFile,
               tmp: str, media: str, size: int) -> dict:
    name = os.path.basename(file.filename or "") or f"document.{DOC_EXT[media]}"
    cur = con.execute(
        "INSERT INTO attachments (car_id, entry_id, filename, media_type, size, created) "
        "VALUES (?,?,?,?,?,?)", (car_id, entry_id, name, media, size, date.today().isoformat()))
    att = dict(con.execute("SELECT * FROM attachments WHERE id=?", (cur.lastrowid,)).fetchone())
    os.replace(tmp, doc_path(att))
    return att


@app.post("/api/scan/preview")
async def scan_preview(file: UploadFile):
    """Crop a camera photo to the document in it and hand it straight back.

    Stores nothing — the caller decides between this and the original photo and
    uploads whichever it wants kept, so a bad detection is never destructive.
    Goes through _receive_doc so the size cap and the real-type sniff apply here
    exactly as they do on the storing path.
    """
    tmp, media, size = await _receive_doc(file)
    try:
        if not scan_available():
            return {"cropped": False, "reason": "unavailable"}
        if media == "application/pdf":
            return {"cropped": False, "reason": "not an image"}
        crop = crop_document(tmp)
        if crop is None:
            return {"cropped": False, "reason": "no document found"}
        return Response(content=crop, media_type="image/jpeg")
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


@app.post("/api/entries/{entry_id}/attachments", status_code=201)
async def attach_to_entry(entry_id: int, file: UploadFile):
    with db() as con:
        row = con.execute("SELECT car_id FROM entries WHERE id=?", (entry_id,)).fetchone()
    if not row:
        raise HTTPException(404, "no such entry")
    tmp, media, size = await _receive_doc(file)
    with db() as con:
        return _store_doc(con, row["car_id"], entry_id, file, tmp, media, size)


@app.post("/api/cars/{car_id}/attachments", status_code=201)
async def attach_to_car(car_id: int, file: UploadFile):
    with db() as con:
        car_or_404(con, car_id)
    tmp, media, size = await _receive_doc(file)
    with db() as con:
        return _store_doc(con, car_id, None, file, tmp, media, size)


@app.get("/api/attachments/{att_id}")
def get_attachment(att_id: int):
    with db() as con:
        att = con.execute("SELECT * FROM attachments WHERE id=?", (att_id,)).fetchone()
    if not att or not os.path.isfile(doc_path(att)):
        raise HTTPException(404, "no such attachment")
    safe = att["filename"].replace('"', "")
    return FileResponse(doc_path(att), media_type=att["media_type"],
                        headers={"Content-Disposition": f'inline; filename="{safe}"'})


class AttachmentPatch(BaseModel):
    note: str = ""


MAX_NOTE = 80


@app.patch("/api/attachments/{att_id}")
def patch_attachment(att_id: int, patch: AttachmentPatch):
    """Name an attachment (issue #47).

    A phone picks the file name, so a list of scans reads as `scan.jpg`,
    `scan-2.jpg` and nothing else. The note stands in for that name in the
    lists; the file name itself is never touched, because it is what a download
    is called and the only record of what the phone actually produced.
    """
    note = " ".join(patch.note.split())      # collapse whitespace; blank clears it
    if len(note) > MAX_NOTE:
        raise HTTPException(422, f"a note is at most {MAX_NOTE} characters")
    with db() as con:
        if not con.execute("SELECT 1 FROM attachments WHERE id=?", (att_id,)).fetchone():
            raise HTTPException(404, "no such attachment")
        con.execute("UPDATE attachments SET note=? WHERE id=?", (note, att_id))
        return dict(con.execute("SELECT * FROM attachments WHERE id=?", (att_id,)).fetchone())


@app.get("/api/attachments/{att_id}/thumb")
def get_attachment_thumb(att_id: int):
    """A small square picture of an image attachment, drawn once and cached.

    A PDF gets a 404 rather than a placeholder: drawing one would mean carrying
    a PDF rendering library, which this app deliberately does not, and the UI
    already knows from the media type not to ask.
    """
    with db() as con:
        att = con.execute("SELECT * FROM attachments WHERE id=?", (att_id,)).fetchone()
    if not att or not os.path.isfile(doc_path(att)):
        raise HTTPException(404, "no such attachment")
    if att["media_type"] == "application/pdf":
        raise HTTPException(404, "no thumbnail for a PDF")

    path = thumb_path(att)
    if not os.path.isfile(path):
        tmp = os.path.join(DOCS_DIR, f".thumb-{pysecrets.token_hex(8)}")
        try:
            # _load_upright drafts the decode down to roughly what is needed and
            # applies the orientation tag, which is the whole point of it here: a
            # 12 MP scan must never be decoded in full just to draw 200 px.
            im = _load_upright(doc_path(att), THUMB_PX)
            ImageOps.fit(im, (THUMB_PX, THUMB_PX), Image.LANCZOS).save(tmp, "JPEG", quality=80)
            os.replace(tmp, path)
        except Exception:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise HTTPException(404, "no thumbnail for this file")
    return FileResponse(path, media_type="image/jpeg")


ROTATIONS = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180,
             270: Image.Transpose.ROTATE_90}   # clockwise degrees -> Pillow's anticlockwise names


@app.post("/api/attachments/{att_id}/rotate")
def rotate_attachment(att_id: int, degrees: int = 90):
    """Turn a stored image clockwise and write it back (issue #43).

    A photo taken over a receipt often lands sideways, and every other path here
    is read-only, so the file would stay that way for good. This is the one place
    the app rewrites an attachment; it keeps the format, the filename and the id,
    because `doc_path()` is derived from the media type and the row must keep
    pointing at its own file.

    The transpose comes BEFORE the rotate: a phone JPEG carries its orientation
    in EXIF, and the saved copy carries no EXIF at all, so anything that reads
    the file afterwards sees the same picture the person just approved.
    """
    if degrees not in ROTATIONS:
        raise HTTPException(422, "degrees must be 90, 180 or 270")
    with db() as con:
        att = con.execute("SELECT * FROM attachments WHERE id=?", (att_id,)).fetchone()
    if not att or not os.path.isfile(doc_path(att)):
        raise HTTPException(404, "no such attachment")
    if att["media_type"] == "application/pdf":
        raise HTTPException(422, "only images can be rotated")

    path = doc_path(att)
    tmp = os.path.join(DOCS_DIR, f".rotate-{pysecrets.token_hex(8)}")
    try:
        # Full resolution on purpose — _load_upright() drafts to a target size,
        # which would quietly shrink the document every time it was turned.
        with Image.open(path) as im:
            fmt = im.format
            out = ImageOps.exif_transpose(im).transpose(ROTATIONS[degrees])
        opts = {"quality": 92} if fmt == "JPEG" else {}
        out.save(tmp, format=fmt, **opts)
        size = os.path.getsize(tmp)
        os.replace(tmp, path)
        drop_thumb(att)        # or the list keeps showing the old way up (#44)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(422, "this image could not be rotated")
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    with db() as con:
        con.execute("UPDATE attachments SET size=? WHERE id=?", (size, att_id))
        return dict(con.execute("SELECT * FROM attachments WHERE id=?", (att_id,)).fetchone())


@app.delete("/api/attachments/{att_id}", status_code=204)
def delete_attachment(att_id: int):
    with db() as con:
        att = con.execute("SELECT * FROM attachments WHERE id=?", (att_id,)).fetchone()
        if not att:
            raise HTTPException(404, "no such attachment")
        con.execute("DELETE FROM attachments WHERE id=?", (att_id,))
    if os.path.isfile(doc_path(att)):
        os.remove(doc_path(att))
    drop_thumb(att)


@app.get("/api/dues")
def dues():
    """Upcoming renewals in a dict shape suited to a Home Assistant REST sensor."""
    items = []
    with db() as con:
        for car in con.execute("SELECT * FROM cars WHERE archived = 0 ORDER BY id"):
            for it in car_due_items(con, car, current_odo_of(con, car["id"])):
                items.append({"car": car["name"], **it})
    items.sort(key=lambda i: i["days"])
    return {"items": items, "next_days": items[0]["days"] if items else None}


@app.get("/api/summary")
def summary(year: int | None = None, include_archived: bool = False):
    """One payload covering every car — lets Home Assistant poll once and derive
    many template sensors, instead of a REST resource per car (issue #17)."""
    y = year or date.today().year
    where = "" if include_archived else "WHERE archived = 0"
    cars_out, all_dues = [], []
    with db() as con:
        for car in con.execute(f"SELECT * FROM cars {where} ORDER BY id"):
            cur = current_odo_of(con, car["id"])
            s = year_summary(con, car["id"], y)
            f = fuel_stats(con, car["id"])
            due_items = car_due_items(con, car, cur)
            cars_out.append({
                "id": car["id"], "name": car["name"], "reg": car["reg"],
                "ev_enabled": car["ev_enabled"],
                "total": s["total"], "by_category": s["by_category"],
                "km_driven": s["km_driven"], "cost_per_km": s["cost_per_km"],
                "l_per_100km": f["l_per_100km"], "eur_per_100km": f["eur_per_100km"],
                "last_price_per_litre": f["last_price_per_litre"],
                "current_odo": cur, "next_due": due_items[0] if due_items else None,
            })
            for it in due_items:
                all_dues.append({"car": car["name"], **it})
    all_dues.sort(key=lambda i: i["days"])
    return {"year": y, "cars": cars_out, "dues": all_dues,
            "next_days": all_dues[0]["days"] if all_dues else None}


@app.get("/healthz")
def healthz():
    with db() as con:
        con.execute("SELECT 1")
    # password_set feeds the UI's running-open warning; harmless to expose —
    # an instance without a password answers every API call anyway.
    return {"ok": True, "version": APP_VERSION, "password_set": _password() is not None,
            "scan_available": scan_available()}


@app.get("/")
def index():
    # no-cache = always revalidate the HTML shell, so ?v= bumps in it are seen
    # immediately; the static assets it names stay normally cacheable.
    return FileResponse(os.path.join(os.path.dirname(__file__), "static", "index.html"),
                        headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")


# ---- backups ---------------------------------------------------------------
# VACUUM INTO is SQLite's own online-backup path: the snapshot is guaranteed to
# open even if the app is writing at the time, unlike a plain copy of the live
# file. Host-level backups should pick up data/backups/, not the live DB.
BACKUP_DIR = os.path.join(os.path.dirname(DB_PATH), "backups")
BACKUP_KEEP = int(os.environ.get("CARCOSTS_BACKUP_KEEP", "7"))


def backup_db() -> dict:
    import glob
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(BACKUP_DIR, f"carcosts-{stamp}.db")
    n = 1
    while os.path.exists(dest):    # VACUUM INTO refuses to overwrite
        dest = os.path.join(BACKUP_DIR, f"carcosts-{stamp}-{n}.db")
        n += 1
    with db() as con:
        con.execute("VACUUM INTO ?", (dest,))
    size = os.path.getsize(dest)
    kept = sorted(glob.glob(os.path.join(BACKUP_DIR, "carcosts-*.db")))
    pruned = 0
    while len(kept) > BACKUP_KEEP:
        os.remove(kept.pop(0))
        pruned += 1
    return {"file": os.path.basename(dest), "bytes": size,
            "kept": len(kept), "pruned": pruned}


@app.on_event("startup")
async def _backup_daily():
    import asyncio

    async def loop():
        while True:
            try:
                backup_db()
            except Exception as e:
                print(f"backup failed: {e}", flush=True)
            await asyncio.sleep(24 * 3600)

    asyncio.get_event_loop().create_task(loop())


init_db()


def _totp_setup_cli():
    """Terminal enrolment, for a headless box or if you are locked out of the UI:
    `python main.py --totp-setup` (same CARCOSTS_DB the app uses)."""
    import qrcode
    if not totp_available():
        raise SystemExit("pyotp is not installed. Run: pip install -r requirements.txt")
    if totp_is_enabled() and input("Two-factor login is already on. Replace it? [y/N] ").lower() != "y":
        raise SystemExit("Left alone.")
    uri = totp_uri(new_totp_secret())
    qr = qrcode.QRCode(border=1)
    qr.add_data(uri)
    qr.print_ascii(invert=True)
    print(f"\nSecret (if you cannot scan): {totp_secret()}\n{uri}\n")
    if not enable_totp(input("Enter the 6-digit code to confirm: ")):
        disable_totp()
        raise SystemExit("That code did not match. Nothing was turned on. Run it again.")
    print("\nTwo-factor login is ON. Recovery codes (each works once, keep them safe):\n")
    for code in generate_backup_codes():
        print("   " + code)


if __name__ == "__main__":
    import sys
    if "--totp-setup" in sys.argv:
        _totp_setup_cli()
    else:
        raise SystemExit("Run the app with: uvicorn main:app --host 0.0.0.0 --port 8000\n"
                         "Or enrol a second factor with: python main.py --totp-setup")
