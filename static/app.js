/* Car Costs SPA — two screens: car list, car detail with add-entry dialogs. */
const $ = (s, el) => (el || document).querySelector(s);
const app = $("#app");
const eur = n => "€" + Number(n).toLocaleString("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const dmy = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;
const dm = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const CAT_LABELS = { fuel: "Fuel", charge: "Charge", insurance: "Insurance", tax: "Tax", nct: "NCT", service: "Service", odo: "Mileage", belt: "Timing belt", tyres: "Tyres", tyre_check: "Tyre check" };
const CORNERS = ["FL", "FR", "RL", "RR"];
const photoUrl = (c, thumb) => c.photo_ver ? `/photos/${c.id}${thumb ? ".thumb" : ""}.jpg?v=${c.photo_ver}` : null;
function svcBadge(sd) {
  if (!sd) return "";
  const kmSide = sd.binding === "km";
  const overdue = kmSide ? sd.km_left < 0 : sd.days < 0;
  const soon = kmSide ? sd.km_left <= 1000 : sd.days <= 30;
  const cls = overdue ? "due-red" : soon ? "due-amber" : "due-ok";
  const txt = kmSide
    ? (overdue ? Math.abs(sd.km_left).toLocaleString() + " km overdue" : "in " + sd.km_left.toLocaleString() + " km")
    : dmy(sd.date) + " · " + (overdue ? Math.abs(sd.days) + "d overdue" : sd.days + "d");
  return `<span class="due ${cls}">Service ${txt}</span>`;
}

function quietBadge(bd, label) {
  // Belts and tyres are usually years away — surface only when it matters:
  // within 2000 km / 60 days of whichever deadline is binding, or overdue.
  if (!bd) return "";
  const kmSide = bd.binding === "km";
  const left = kmSide ? bd.km_left : bd.days;
  if (left === null || left === undefined || (kmSide ? left > 2000 : left > 60)) return "";
  const overdue = left < 0;
  const txt = kmSide
    ? (overdue ? Math.abs(left).toLocaleString() + " km overdue" : "in " + left.toLocaleString() + " km")
    : (overdue ? Math.abs(left) + "d overdue" : dmy(bd.date) + " · " + left + "d");
  return `<span class="due ${overdue ? "due-red" : "due-amber"}">${label} ${txt}</span>`;
}

function dueBadge(label, iso) {
  if (!iso) return "";
  const days = Math.ceil((new Date(iso) - new Date()) / 86400000);
  const cls = days < 0 ? "due-red" : days <= 30 ? "due-amber" : "due-ok";
  const txt = days < 0 ? Math.abs(days) + "d overdue" : days + "d";
  return `<span class="due ${cls}">${label} ${dmy(iso)} · ${txt}</span>`;
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.status === 204 ? null : r.json();
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- car list ---------- */
async function showList() {
  if (location.hash.startsWith("#car-")) history.replaceState(null, "", location.pathname);
  const cars = await api("/api/cars");
  app.innerHTML = `<h1>Car Costs <small>${new Date().getFullYear()}</small></h1>` +
    cars.map(c => `
      <div class="card car-card" data-id="${c.id}">
        <div class="row" style="align-items:center">
          ${photoUrl(c, 1) ? `<img class="thumb" src="${photoUrl(c, 1)}" alt="">` : `<span class="thumb ph">🚗</span>`}
          <span style="flex:1"><span class="nm">${esc(c.name)}</span>` +
          (c.reg ? `<span class="reg">${esc(c.reg)}</span>` : "") +
        `</span><span class="big">${eur(c.summary.total)}</span></div>
        <div class="row muted"><span>${c.fuel.last_price_per_litre ? "last fill " + c.fuel.last_price_per_litre.toFixed(3) + " €/L" : "no fills yet"}</span>
        <span>${c.fuel.l_per_100km ? c.fuel.l_per_100km + " L/100km" : ""}</span></div>
      </div>`).join("");
  const all = await api("/api/cars?include_archived=true");
  const retired = all.filter(c => c.archived);
  app.insertAdjacentHTML("beforeend",
    `<button class="ghost" id="add-car" style="width:100%">+ Add car</button>` +
    (retired.length ? `<div class="muted" style="margin-top:12px">Retired</div>` +
      retired.map(c => `
        <div class="card car-card retired" data-id="${c.id}">
          <div class="row"><span class="nm">${esc(c.name)}</span>
          <span class="muted">retired · ${eur(c.summary.total)} this year</span></div>
        </div>`).join("") : ""));
  $("#add-car").addEventListener("click", () => dialog(`
    <h1>Add car</h1>
    <label>Name</label><input name="name" required>
    <label>Registration</label><input name="reg" placeholder="optional">
    <label>Fuel type</label><select name="fuel_type">
      ${["petrol", "diesel", "hybrid", "phev", "ev"].map(t => `<option>${t}</option>`).join("")}</select>`,
    async d => {
      const f = new FormData($("form", d));
      await api("/api/cars", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: f.get("name"), reg: f.get("reg") || "", fuel_type: f.get("fuel_type") }) });
      const deepLink = location.hash.match(/^#car-(\d+)$/);
if (deepLink) showCar(+deepLink[1]); else showList();
    }));
  app.querySelectorAll(".car-card").forEach(el =>
    el.addEventListener("click", () => showCar(+el.dataset.id)));
}

/* ---------- due/result banners ---------- */
function daysTo(iso) { return Math.round((new Date(iso) - new Date(today())) / 86400000); }

function bannersHtml(c, sd, bd) {
  const out = [];
  if (c.nct_booked && c.nct_booked < today())
    out.push(`<div class="card banner" data-banner="nct-result">NCT test was ${dmy(c.nct_booked)} — result?
      <div class="banner-actions"><button class="small" data-act="nct-pass">Passed</button>
      <button class="small ghost" data-act="nct-fail">Failed</button></div></div>`);
  if (sd) {
    const kmSide = sd.binding === "km";
    const overdue = kmSide ? sd.km_left < 0 : sd.days < 0;
    const soon = kmSide ? sd.km_left <= 1000 : sd.days <= 14;
    if (overdue || soon) {
      const when = kmSide
        ? (overdue ? Math.abs(sd.km_left).toLocaleString() + " km overdue" : sd.km_left.toLocaleString() + " km left")
        : (overdue ? Math.abs(sd.days) + "d overdue" : "due " + dmy(sd.date));
      out.push(`<div class="card banner">Service due (${when}) — done?
        <div class="banner-actions"><button class="small" data-act="svc-done">Log service…</button></div></div>`);
    }
  }
  if (bd) {
    const kmSide = bd.binding === "km";
    const left = kmSide ? bd.km_left : bd.days;
    if (left !== null && left !== undefined && (kmSide ? left <= 1000 : left <= 30)) {
      const when = kmSide
        ? (left < 0 ? Math.abs(left).toLocaleString() + " km overdue" : left.toLocaleString() + " km left")
        : (left < 0 ? Math.abs(left) + "d overdue" : "due " + dmy(bd.date));
      out.push(`<div class="card banner">Timing belt due (${when}) — changed?
        <div class="banner-actions"><button class="small" data-act="belt-done">Log belt change…</button></div></div>`);
    }
  }
  const dues = [["nct_due", "NCT"], ["tax_due", "Tax"], ["insurance_due", "Insurance"]];
  for (const [field, label] of dues) {
    if (!c[field]) continue;
    if (field === "nct_due" && c.nct_booked && c.nct_booked >= today()) continue; // test path handles it
    const days = daysTo(c[field]);
    if (days > 14) continue;
    const when = days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "today" : `in ${days}d`;
    out.push(`<div class="card banner">${label} due ${dmy(c[field])} (${when}) — renewed?
      <div class="banner-actions"><button class="small" data-act="renew" data-field="${field}" data-label="${label}">Renewed…</button></div></div>`);
  }
  return out.join("");
}

function wireBanners(car) {
  app.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", () => {
    const act = b.dataset.act;
    if (act === "svc-done") { entryDialog(car, "service"); return; }
    if (act === "belt-done") { entryDialog(car, "belt"); return; }
    if (act === "nct-pass") dialog(`
      <h1>NCT passed — ${esc(car.name)}</h1>
      <label>New NCT expiry</label><input name="due" type="date" required>`, async d => {
      const f = new FormData($("form", d));
      await api(`/api/cars/${car.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nct_due: f.get("due"), nct_booked: null }) });
      showCar(car.id);
    });
    else if (act === "nct-fail") {
      const dlg = dialog(`
        <h1>NCT failed — ${esc(car.name)}</h1>
        <label>Retest type</label><select name="rtype">
          <option value="rebook">Retest (rebooking, fee applies)</option>
          <option value="visual">Visual-only retest (free)</option></select>
        <label>New test date</label><input name="due" type="date" required>
        <div id="fee-row"><label>Rebooking fee (€)</label>
          <input name="fee" type="number" step="0.01" inputmode="decimal"></div>`, async d => {
        const f = new FormData($("form", d));
        await api(`/api/cars/${car.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nct_booked: f.get("due") }) });
        if (f.get("rtype") === "rebook" && f.get("fee"))
          await api(`/api/cars/${car.id}/entries`, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category: "nct", cost: parseFloat(f.get("fee")),
              note: "NCT retest booking — test " + dmy(f.get("due")) }) });
        showCar(car.id);
      });
      $("select[name=rtype]", dlg).addEventListener("change", ev =>
        $("#fee-row", dlg).style.display = ev.target.value === "rebook" ? "" : "none");
    }
    else if (act === "renew") {
      const field = b.dataset.field, label = b.dataset.label;
      dialog(`
        <h1>${label} renewed — ${esc(car.name)}</h1>
        <label>New ${label.toLowerCase()} expiry</label><input name="due" type="date" required>
        <label>Amount paid (€) — optional</label><input name="cost" type="number" step="0.01" inputmode="decimal">`, async d => {
        const f = new FormData($("form", d));
        await api(`/api/cars/${car.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [field]: f.get("due") }) });
        if (f.get("cost"))
          await api(`/api/cars/${car.id}/entries`, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category: field.replace("_due", ""), cost: parseFloat(f.get("cost")),
              note: label + " renewal" }) });
        showCar(car.id);
      });
    }
  }));
}

/* ---------- car detail ---------- */
async function showCar(id, year) {
  location.hash = "car-" + id;
  const d = await api(`/api/cars/${id}` + (year ? `?year=${year}` : ""));
  const c = d.car, s = d.summary;
  const cats = Object.entries(s.by_category).map(([k, v]) =>
    `<div class="total-line"><span class="cat">${CAT_LABELS[k] || k}</span><span>${eur(v)}</span></div>`).join("");
  const addBtns = ["fuel", ...(c.ev_enabled ? ["charge"] : []), "service", "tyres"]
    .map(k => `<button data-cat="${k}">+ ${CAT_LABELS[k]}</button>`).join("");
  const smallBtns = ["odo", "insurance", "tax", "nct"]
    .map(k => `<button class="small ghost" data-cat="${k}">+ ${CAT_LABELS[k]}</button>`).join("");
  const yearOpts = (d.years.length ? d.years : [String(s.year)])
    .map(y => `<option ${+y === s.year ? "selected" : ""}>${y}</option>`).join("");
  const detailBits = [c.year, c.make, c.model].filter(Boolean).join(" ");
  app.innerHTML = `
    <button class="back">&larr; All cars</button>
    <div class="card">
      <div class="photo-wrap" id="photo-wrap" title="Tap to change photo">
        ${photoUrl(c) ? `<img src="${photoUrl(c)}" alt="${esc(c.name)}">` : `<div class="ph-big">🚗<br><small>tap to add a photo</small></div>`}
      </div>
      <input type="file" id="photo-file" accept="image/*" hidden>
      <div class="row" style="margin-top:10px"><span class="nm">${esc(c.name)}${c.reg ? `<span class="reg">${esc(c.reg)}</span>` : ""}</span>
        <button class="small ghost" id="edit-car">Edit</button></div>
      ${detailBits ? `<div class="muted">${esc(detailBits)}${c.vin ? " · VIN " + esc(c.vin) : ""}</div>` : ""}
      ${d.current_odo ? `<div class="muted" style="margin-top:4px">Mileage: ${Math.round(d.current_odo).toLocaleString()} km${d.service_due && d.service_due.next_km ? " · next service " + d.service_due.next_km.toLocaleString() + " km or " + dmy(d.service_due.date) : d.service_due ? " · next service " + dmy(d.service_due.date) : ""}</div>` : ""}
      <div class="dues">${svcBadge(d.service_due)}${quietBadge(d.belt_due, "Belt")}${dueBadge("NCT", c.nct_due)}${c.nct_booked ? `<span class="due due-booked">NCT test ${dmy(c.nct_booked)} · ${daysTo(c.nct_booked) >= 0 ? daysTo(c.nct_booked) + "d" : "awaiting result"}</span>` : ""}${dueBadge("Tax", c.tax_due)}${dueBadge("Ins", c.insurance_due)}</div>
    </div>
    ${bannersHtml(c, d.service_due, d.belt_due)}
    <div class="btn-grid">${addBtns}</div>
    <div class="row" style="justify-content:center;gap:8px;flex-wrap:wrap;margin:8px 0">${smallBtns}</div>
    <div class="card">
      <div class="row" style="margin:0 0 4px">
        <select id="year-sel" style="width:auto">${yearOpts}</select>
        <span class="big">${eur(s.total)}</span></div>
      ${cats || '<div class="muted">No entries yet — add the first below.</div>'}
      <div class="row muted" style="margin-top:6px">
        <span>${s.km_driven ? s.km_driven.toLocaleString() + " km logged" : ""}</span>
        <span>${s.cost_per_km ? eur(s.cost_per_km) + "/km" : ""}</span></div>
    </div>
    <div class="card"><div class="muted" style="margin-bottom:4px">Recent</div>
      <div class="recent-scroll">
      ${d.entries.map(e => `
        <div class="entry"><span>${dmy(e.date)} <span class="cat">${CAT_LABELS[e.category]}</span>
          ${e.litres ? e.litres + "L @" + (e.price_per_litre || 0).toFixed(3) : ""}
          ${e.kwh ? e.kwh + "kWh" : ""} ${esc(e.note || "")}</span>
        <span>${e.category === "odo" ? Math.round(e.odometer).toLocaleString() + " km" : eur(e.cost)} <button class="danger" data-del="${e.id}">✕</button></span></div>`).join("") ||
        '<div class="muted">Nothing yet.</div>'}
      </div>
    </div>
    ${Object.keys(d.tyres || {}).length ? `
    <div class="card"><div class="muted" style="margin-bottom:4px">Tyres</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
      ${CORNERS.filter(k => d.tyres[k]).map(k => {
        const t = d.tyres[k], chk = (d.tyre_checks || {})[k];
        const km = t.odometer != null && d.current_odo != null ? Math.round(d.current_odo - t.odometer) : null;
        let chkLine = "";
        if (chk) {
          const mm = chk.mm != null
            ? (chk.mm < 1.6 ? `<span class="due due-red">${chk.mm} mm</span>`
              : chk.mm <= 3 ? `<span class="due due-amber">${chk.mm} mm</span>` : chk.mm + " mm")
            : "";
          chkLine = `<br><span class="muted">checked ${dmy(chk.date)}</span> ${mm}`;
        }
        return `<div><b>${k}</b> <span class="muted">${dmy(t.date)}${km !== null ? " · " + km.toLocaleString() + " km" : ""}</span><br>
          <span class="muted">${esc([t.brand, t.size].filter(Boolean).join(" · ") || "—")}</span>${chkLine}</div>`;
      }).join("")}
      </div>
    </div>` : ""}
    ${d.service_log && d.service_log.length ? `
    <div class="card"><div class="muted" style="margin-bottom:4px">Service history</div>
      <div class="recent-scroll">
      ${d.service_log.map(s => `
        <div class="entry"><span>${dmy(s.date)}${s.category === "tyres" ? ` <span class="cat">Tyres · ${esc(s.corners || "")}</span>` : ""}${s.odometer ? " · " + Math.round(s.odometer).toLocaleString() + " km" : ""}<br>
          <span class="muted">${esc(s.category === "tyres" ? [s.tyre_brand, s.tyre_size, s.note].filter(Boolean).join(" · ") || "—" : s.note || "—")}</span></span>
        <span>${eur(s.cost)}</span></div>`).join("")}
      </div>
    </div>` : ""}`;
  c._tyrePrefill = (() => {
    const latest = CORNERS.map(k => (d.tyres || {})[k]).filter(Boolean)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    return latest ? { size: latest.size, brand: latest.brand } : { size: "", brand: "" };
  })();
  $(".back").addEventListener("click", showList);
  $("#photo-wrap").addEventListener("click", () => $("#photo-file").click());
  $("#photo-file").addEventListener("change", async ev => {
    const file = ev.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try { await api(`/api/cars/${id}/photo`, { method: "POST", body: fd }); showCar(id); }
    catch (e) { alert(e.message); }
  });
  $("#year-sel").addEventListener("change", ev => showCar(id, ev.target.value));
  $("#edit-car").addEventListener("click", () => editCarDialog(c));
  app.querySelectorAll("[data-cat]").forEach(b =>
    b.addEventListener("click", () =>
      b.dataset.cat === "tyres" ? tyreChooser(c) : entryDialog(c, b.dataset.cat)));
  wireBanners(c);
  app.querySelectorAll("[data-del]").forEach(b =>
    b.addEventListener("click", async () => {
      if (confirm("Delete this entry?")) { await api(`/api/entries/${b.dataset.del}`, { method: "DELETE" }); showCar(id); }
    }));
}

/* ---------- dialogs ---------- */
function dialog(html, onSubmit) {
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `<form method="dialog">${html}
    <div class="dlg-actions"><button class="ghost" value="cancel" formnovalidate>Cancel</button>
    <button value="save">Save</button></div></form>`;
  document.body.append(dlg);
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue === "save") { try { await onSubmit(dlg); } catch (e) { alert(e.message); } }
    dlg.remove();
  });
  dlg.showModal();
  return dlg;
}

function tyreChooser(car) {
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `<form method="dialog"><h1>Tyres — ${esc(car.name)}</h1>
    <div class="dlg-actions" style="flex-direction:column;align-items:stretch;gap:8px">
    <button value="fit">New tyres fitted…</button>
    <button value="check">Tyre check…</button>
    <button class="ghost" value="cancel" formnovalidate>Cancel</button></div></form>`;
  document.body.append(dlg);
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "fit") entryDialog(car, "tyres");
    if (dlg.returnValue === "check") entryDialog(car, "tyre_check");
    dlg.remove();
  });
  dlg.showModal();
}

function picked_mm(f, corners) {
  return corners.map(k => f.get("mm_" + k) ? `${k}=${parseFloat(f.get("mm_" + k))}` : "")
    .filter(Boolean).join(",");
}

function entryDialog(car, cat) {
  const isFuel = cat === "fuel", isCharge = cat === "charge";
  const unitFields = isFuel ? `
      <label>Amount (€)</label><input name="cost" type="number" step="0.01" inputmode="decimal" required>
      <label>Odometer (km)</label><input name="odometer" type="number" step="1" inputmode="numeric" required>
      <label>Litres (optional)</label><input name="litres" type="number" step="0.01" inputmode="decimal">
      <div class="hint" id="calc"></div>`
    : isCharge ? `
      <label>Odometer (km)</label><input name="odometer" type="number" step="1" inputmode="numeric">
      <label>kWh</label><input name="kwh" type="number" step="0.01" inputmode="decimal" required>
      <label>Price per kWh (€)</label><input name="price_per_kwh" type="number" step="0.001" inputmode="decimal" required>
      <div class="hint" id="calc"></div>`
    : cat === "odo" ? `
      <label>Odometer (km)</label><input name="odometer" type="number" step="1" inputmode="numeric" required>`
    : cat === "belt" ? `
      <label>Odometer (km)</label><input name="odometer" type="number" step="1" inputmode="numeric" required>
      <label>Amount (€)</label><input name="cost" type="number" step="0.01" inputmode="decimal" required>
      <label>Note</label><input name="note" placeholder="e.g. belt + water pump">`
    : cat === "tyre_check" ? `
      <p class="hint" style="margin:0">Tick the corners you checked; tread depth optional.</p>
      ${CORNERS.map(k => `<div class="row" style="justify-content:flex-start;gap:10px;margin-top:6px">
        <label style="display:inline-flex;align-items:center;gap:4px;margin:0;min-width:52px"><input type="checkbox" name="corner" value="${k}" checked>${k}</label>
        <input name="mm_${k}" type="number" step="0.1" inputmode="decimal" placeholder="mm" style="width:80px">
      </div>`).join("")}
      <label>Note</label><input name="note" placeholder="e.g. all okay">`
    : cat === "tyres" ? `
      <label>Corners</label>
      <div class="row" style="justify-content:flex-start;gap:14px">
        ${CORNERS.map(k => `<label style="display:inline-flex;align-items:center;gap:4px;margin:0"><input type="checkbox" name="corner" value="${k}">${k}</label>`).join("")}
      </div>
      <label>Odometer (km)</label><input name="odometer" type="number" step="1" inputmode="numeric" required>
      <label>Amount (€)</label><input name="cost" type="number" step="0.01" inputmode="decimal" required>
      <label>Size</label><input name="tyre_size" value="${esc((car._tyrePrefill || {}).size || "")}" placeholder="e.g. 205/55 R16">
      <label>Brand / model</label><input name="tyre_brand" value="${esc((car._tyrePrefill || {}).brand || "")}" placeholder="e.g. Michelin CrossClimate 2">
      <label>Note</label><input name="note" placeholder="optional">`
    : cat === "service" ? `
      <label>Work done</label><textarea name="note" rows="3" required placeholder="e.g. full service — oil, filters, rear pads"></textarea>
      <label>Amount (€)</label><input name="cost" type="number" step="0.01" inputmode="decimal" required>
      <label>Odometer (km) — optional, anchors the service interval</label><input name="odometer" type="number" step="1" inputmode="numeric">`
    : `<label>Amount (€) — leave blank if only setting the date</label><input name="cost" type="number" step="0.01" inputmode="decimal">
       <label>${{ tax: "New tax expiry", nct: "New NCT due date", insurance: "New renewal date" }[cat]} (optional)</label><input name="due" type="date">
       <label>Note</label><input name="note" placeholder="optional">`;
  const dlg = dialog(`
    <h1>${CAT_LABELS[cat]} — ${esc(car.name)}</h1>
    <label>Date</label><input name="date" type="date" value="${today()}" required>
    ${unitFields}`, async d => {
    const f = new FormData($("form", d));
    const dueField = { tax: "tax_due", nct: "nct_due", insurance: "insurance_due" }[cat];
    const hasCost = !!f.get("cost"), hasDue = dueField && !!f.get("due");
    if (dueField && !hasCost && !hasDue) throw new Error("Enter an amount, a date, or both");
    if (hasDue)
      await api(`/api/cars/${car.id}`, { method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [dueField]: f.get("due") }) });
    if (hasCost || !dueField) {
      const body = { category: cat, date: f.get("date"), note: f.get("note") || "" };
      for (const k of ["odometer", "litres", "price_per_litre", "kwh", "price_per_kwh", "cost"])
        if (f.get(k)) body[k] = parseFloat(f.get(k));
      if (cat === "tyres" || cat === "tyre_check") {
        const picked = f.getAll("corner");
        if (!picked.length) throw new Error("Pick at least one corner");
        body.corners = picked.join(",");
      }
      if (cat === "tyres") {
        body.tyre_size = f.get("tyre_size") || "";
        body.tyre_brand = f.get("tyre_brand") || "";
      }
      if (cat === "tyre_check")
        body.tread_mm = picked_mm(f, f.getAll("corner"));
      await api(`/api/cars/${car.id}/entries`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }
    showCar(car.id);
  });
  if (isFuel || isCharge) {
    const upd = () => {
      const f = new FormData($("form", dlg));
      if (isFuel) {
        const cost = parseFloat(f.get("cost")), q = parseFloat(f.get("litres"));
        $("#calc", dlg).textContent = cost && q ? (cost / q).toFixed(3) + " €/L" : "";
      } else {
        const q = parseFloat(f.get("kwh")), p = parseFloat(f.get("price_per_kwh"));
        $("#calc", dlg).textContent = q && p ? "Total: " + eur(q * p) : "";
      }
    };
    dlg.addEventListener("input", upd);
  }
}

function editCarDialog(car) {
  const dlg = dialog(`
    <h1>Edit car</h1>
    <label>Name</label><input name="name" value="${esc(car.name)}" required>
    <label>Registration</label><input name="reg" value="${esc(car.reg || "")}" placeholder="optional">
    <label>Make</label><input name="make" value="${esc(car.make || "")}" placeholder="optional">
    <label>Model</label><input name="model" value="${esc(car.model || "")}" placeholder="optional">
    <label>Year</label><input name="year" type="number" min="1980" max="2100" value="${car.year || ""}" placeholder="optional">
    <label>VIN</label><input name="vin" value="${esc(car.vin || "")}" placeholder="optional">
    <label>NCT due</label><input name="nct_due" type="date" value="${car.nct_due || ""}">
    <label>NCT appointment (if booked)</label><input name="nct_booked" type="date" value="${car.nct_booked || ""}">
    <label>Tax due</label><input name="tax_due" type="date" value="${car.tax_due || ""}">
    <label>Insurance renewal</label><input name="insurance_due" type="date" value="${car.insurance_due || ""}">
    <label>Service interval (km)</label><input name="service_interval_km" type="number" step="500" inputmode="numeric" value="${car.service_interval_km || ""}" placeholder="e.g. 15000">
    <label>Service interval (months)</label><input name="service_interval_months" type="number" inputmode="numeric" value="${car.service_interval_months || ""}" placeholder="12 (default)">
    <label>Timing belt interval (km)</label><input name="belt_interval_km" type="number" step="1000" inputmode="numeric" value="${car.belt_interval_km || ""}" placeholder="e.g. 100000">
    <label>Timing belt interval (years)</label><input name="belt_interval_years" type="number" inputmode="numeric" value="${car.belt_interval_years || ""}" placeholder="e.g. 8">
    <button type="button" class="small ghost" id="log-belt" style="margin-top:8px">Log a timing belt change…</button>
    <label>Fuel type</label><select name="fuel_type">
      ${["petrol", "diesel", "hybrid", "phev", "ev"].map(t =>
        `<option ${car.fuel_type === t ? "selected" : ""}>${t}</option>`).join("")}</select>
    <div class="switch"><input type="checkbox" name="ev_enabled" id="evt" ${car.ev_enabled ? "checked" : ""}>
      <label for="evt" style="margin:0">Electric charging entries</label></div>
    <button type="button" class="danger" id="retire-car" style="margin-top:14px">${car.archived ? "Restore this car" : "Retire this car (history kept)"}</button>`, async d => {
    const f = new FormData($("form", d));
    const newBooked = f.get("nct_booked") || null;
    await api(`/api/cars/${car.id}`, { method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: f.get("name"), reg: f.get("reg"),
        make: f.get("make") || "", model: f.get("model") || "", vin: f.get("vin") || "",
        year: f.get("year") ? +f.get("year") : null,
        nct_due: f.get("nct_due") || null, nct_booked: newBooked,
        service_interval_km: f.get("service_interval_km") ? +f.get("service_interval_km") : null,
        belt_interval_km: f.get("belt_interval_km") ? +f.get("belt_interval_km") : null,
        belt_interval_years: f.get("belt_interval_years") ? +f.get("belt_interval_years") : null,
        service_interval_months: f.get("service_interval_months") ? +f.get("service_interval_months") : null,
        tax_due: f.get("tax_due") || null,
        insurance_due: f.get("insurance_due") || null,
        fuel_type: f.get("fuel_type"), ev_enabled: f.get("ev_enabled") === "on" }) });
    if (newBooked && newBooked !== car.nct_booked) {
      dialog(`
        <h1>Log the test fee?</h1>
        <p class="hint">The NCT fee applies on the day the test is booked (today). Cancel to skip.</p>
        <label>Fee (€)</label><input name="fee" type="number" step="0.01" inputmode="decimal" value="60">`, async d2 => {
        const f2 = new FormData($("form", d2));
        if (f2.get("fee"))
          await api(`/api/cars/${car.id}/entries`, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category: "nct", cost: parseFloat(f2.get("fee")),
              note: "NCT test fee — test booked " + dmy(newBooked) }) });
        showCar(car.id);
      });
    } else showCar(car.id);
  });
  $("#log-belt", dlg).addEventListener("click", () => { dlg.close("cancel"); entryDialog(car, "belt"); });
  $("#retire-car", dlg).addEventListener("click", async () => {
    const verb = car.archived ? "Restore" : "Retire";
    if (!confirm(verb + " " + car.name + "?" + (car.archived ? "" : " All history is kept; it moves to the Retired list."))) return;
    await api(`/api/cars/${car.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: !car.archived }) });
    dlg.close("cancel");
    const deepLink = location.hash.match(/^#car-(\d+)$/);
if (deepLink) showCar(+deepLink[1]); else showList();
  });
}

const deepLink = location.hash.match(/^#car-(\d+)$/);
if (deepLink) showCar(+deepLink[1]); else showList();
