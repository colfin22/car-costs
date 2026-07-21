/* Car Costs SPA — two screens: car list, car detail with add-entry dialogs. */
const $ = (s, el) => (el || document).querySelector(s);
const app = $("#app");
const eur = n => "€" + Number(n).toLocaleString("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const dmy = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;
const dm = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const CAT_LABELS = { fuel: "Fuel", charge: "Charge", insurance: "Insurance", tax: "Tax", nct: "NCT", service: "Service", odo: "Mileage" };
const photoUrl = (c, thumb) => c.photo_ver ? `/photos/${c.id}${thumb ? ".thumb" : ""}.jpg?v=${c.photo_ver}` : null;
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
  app.querySelectorAll(".car-card").forEach(el =>
    el.addEventListener("click", () => showCar(+el.dataset.id)));
}

/* ---------- due/result banners ---------- */
function daysTo(iso) { return Math.round((new Date(iso) - new Date(today())) / 86400000); }

function bannersHtml(c) {
  const out = [];
  if (c.nct_booked && c.nct_booked < today())
    out.push(`<div class="card banner" data-banner="nct-result">NCT test was ${dmy(c.nct_booked)} — result?
      <div class="banner-actions"><button class="small" data-act="nct-pass">Passed</button>
      <button class="small ghost" data-act="nct-fail">Failed</button></div></div>`);
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
  const d = await api(`/api/cars/${id}` + (year ? `?year=${year}` : ""));
  const c = d.car, s = d.summary;
  const cats = Object.entries(s.by_category).map(([k, v]) =>
    `<div class="total-line"><span class="cat">${CAT_LABELS[k] || k}</span><span>${eur(v)}</span></div>`).join("");
  const addBtns = ["fuel", ...(c.ev_enabled ? ["charge"] : []), "odo", "insurance", "tax", "nct", "service"]
    .map(k => `<button data-cat="${k}">+ ${CAT_LABELS[k]}</button>`).join("");
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
      ${d.current_odo ? `<div class="muted" style="margin-top:4px">Mileage: ${Math.round(d.current_odo).toLocaleString()} km</div>` : ""}
      <div class="dues">${dueBadge("NCT", c.nct_due)}${c.nct_booked ? `<span class="due due-booked">NCT test ${dmy(c.nct_booked)} · booked</span>` : ""}${dueBadge("Tax", c.tax_due)}${dueBadge("Ins", c.insurance_due)}</div>
    </div>
    ${bannersHtml(c)}
    <div class="card">
      <div class="row" style="margin:0 0 4px">
        <select id="year-sel" style="width:auto">${yearOpts}</select>
        <span class="big">${eur(s.total)}</span></div>
      ${cats || '<div class="muted">No entries yet — add the first below.</div>'}
      <div class="row muted" style="margin-top:6px">
        <span>${s.km_driven ? s.km_driven.toLocaleString() + " km logged" : ""}</span>
        <span>${s.cost_per_km ? (100 * s.cost_per_km).toFixed(1) + " c/km" : ""}</span></div>
    </div>
    <div class="btn-grid">${addBtns}</div>
    <div class="card"><div class="muted" style="margin-bottom:4px">Recent</div>
      ${d.entries.map(e => `
        <div class="entry"><span>${dmy(e.date)} <span class="cat">${CAT_LABELS[e.category]}</span>
          ${e.litres ? e.litres + "L @" + (e.price_per_litre || 0).toFixed(3) : ""}
          ${e.kwh ? e.kwh + "kWh" : ""} ${esc(e.note || "")}</span>
        <span>${e.category === "odo" ? Math.round(e.odometer).toLocaleString() + " km" : eur(e.cost)} <button class="danger" data-del="${e.id}">✕</button></span></div>`).join("") ||
        '<div class="muted">Nothing yet.</div>'}
    </div>`;
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
    b.addEventListener("click", () => entryDialog(c, b.dataset.cat)));
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

function entryDialog(car, cat) {
  const isFuel = cat === "fuel", isCharge = cat === "charge";
  const unitFields = isFuel ? `
      <label>Odometer (km)</label><input name="odometer" type="number" step="1" inputmode="numeric" required>
      <label>Litres</label><input name="litres" type="number" step="0.01" inputmode="decimal" required>
      <label>Price per litre (€)</label><input name="price_per_litre" type="number" step="0.001" inputmode="decimal" required>
      <div class="hint" id="calc"></div>`
    : isCharge ? `
      <label>Odometer (km)</label><input name="odometer" type="number" step="1" inputmode="numeric">
      <label>kWh</label><input name="kwh" type="number" step="0.01" inputmode="decimal" required>
      <label>Price per kWh (€)</label><input name="price_per_kwh" type="number" step="0.001" inputmode="decimal" required>
      <div class="hint" id="calc"></div>`
    : cat === "odo" ? `
      <label>Odometer (km)</label><input name="odometer" type="number" step="1" inputmode="numeric" required>`
    : cat === "service" ? `
      <label>Amount (€)</label><input name="cost" type="number" step="0.01" inputmode="decimal" required>
      <label>Note</label><input name="note" placeholder="e.g. tyres, 2 front">`
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
      await api(`/api/cars/${car.id}/entries`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }
    showCar(car.id);
  });
  if (isFuel || isCharge) {
    const upd = () => {
      const f = new FormData($("form", dlg));
      const q = parseFloat(f.get(isFuel ? "litres" : "kwh")), p = parseFloat(f.get(isFuel ? "price_per_litre" : "price_per_kwh"));
      $("#calc", dlg).textContent = q && p ? "Total: " + eur(q * p) : "";
    };
    dlg.addEventListener("input", upd);
  }
}

function editCarDialog(car) {
  dialog(`
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
    <label>Fuel type</label><select name="fuel_type">
      ${["petrol", "diesel", "hybrid", "phev", "ev"].map(t =>
        `<option ${car.fuel_type === t ? "selected" : ""}>${t}</option>`).join("")}</select>
    <div class="switch"><input type="checkbox" name="ev_enabled" id="evt" ${car.ev_enabled ? "checked" : ""}>
      <label for="evt" style="margin:0">Electric charging entries</label></div>`, async d => {
    const f = new FormData($("form", d));
    const newBooked = f.get("nct_booked") || null;
    await api(`/api/cars/${car.id}`, { method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: f.get("name"), reg: f.get("reg"),
        make: f.get("make") || "", model: f.get("model") || "", vin: f.get("vin") || "",
        year: f.get("year") ? +f.get("year") : null,
        nct_due: f.get("nct_due") || null, nct_booked: newBooked,
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
}

showList();
