/* Car Costs SPA — two screens: car list, car detail with add-entry dialogs. */
const $ = (s, el) => (el || document).querySelector(s);
const app = $("#app");
const eur = n => "€" + Number(n).toLocaleString("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const CAT_LABELS = { fuel: "Fuel", charge: "Charge", insurance: "Insurance", tax: "Tax", nct: "NCT", service: "Service" };

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
        <div class="row"><span><span class="nm">${esc(c.name)}</span>` +
          (c.reg ? `<span class="reg">${esc(c.reg)}</span>` : "") +
        `</span><span class="big">${eur(c.summary.total)}</span></div>
        <div class="row muted"><span>${c.fuel.last_price_per_litre ? "last fill " + c.fuel.last_price_per_litre.toFixed(3) + " €/L" : "no fills yet"}</span>
        <span>${c.fuel.l_per_100km ? c.fuel.l_per_100km + " L/100km" : ""}</span></div>
      </div>`).join("");
  app.querySelectorAll(".car-card").forEach(el =>
    el.addEventListener("click", () => showCar(+el.dataset.id)));
}

/* ---------- car detail ---------- */
async function showCar(id, year) {
  const d = await api(`/api/cars/${id}` + (year ? `?year=${year}` : ""));
  const c = d.car, s = d.summary;
  const cats = Object.entries(s.by_category).map(([k, v]) =>
    `<div class="total-line"><span class="cat">${CAT_LABELS[k] || k}</span><span>${eur(v)}</span></div>`).join("");
  const addBtns = ["fuel", ...(c.ev_enabled ? ["charge"] : []), "insurance", "tax", "nct", "service"]
    .map(k => `<button data-cat="${k}">+ ${CAT_LABELS[k]}</button>`).join("");
  const yearOpts = (d.years.length ? d.years : [String(s.year)])
    .map(y => `<option ${+y === s.year ? "selected" : ""}>${y}</option>`).join("");
  app.innerHTML = `
    <button class="back">&larr; All cars</button>
    <div class="card">
      <div class="row"><span class="nm">${esc(c.name)}${c.reg ? `<span class="reg">${esc(c.reg)}</span>` : ""}</span>
        <button class="small ghost" id="edit-car">Edit</button></div>
      <div class="row" style="margin:8px 0 4px">
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
        <div class="entry"><span>${e.date.slice(5)} <span class="cat">${CAT_LABELS[e.category]}</span>
          ${e.litres ? e.litres + "L @" + (e.price_per_litre || 0).toFixed(3) : ""}
          ${e.kwh ? e.kwh + "kWh" : ""} ${esc(e.note || "")}</span>
        <span>${eur(e.cost)} <button class="danger" data-del="${e.id}">✕</button></span></div>`).join("") ||
        '<div class="muted">Nothing yet.</div>'}
    </div>`;
  $(".back").addEventListener("click", showList);
  $("#year-sel").addEventListener("change", ev => showCar(id, ev.target.value));
  $("#edit-car").addEventListener("click", () => editCarDialog(c));
  app.querySelectorAll("[data-cat]").forEach(b =>
    b.addEventListener("click", () => entryDialog(c, b.dataset.cat)));
  app.querySelectorAll("[data-del]").forEach(b =>
    b.addEventListener("click", async () => {
      if (confirm("Delete this entry?")) { await api(`/api/entries/${b.dataset.del}`, { method: "DELETE" }); showCar(id); }
    }));
}

/* ---------- dialogs ---------- */
function dialog(html, onSubmit) {
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `<form method="dialog">${html}
    <div class="dlg-actions"><button class="ghost" value="cancel">Cancel</button>
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
    : `<label>Amount (€)</label><input name="cost" type="number" step="0.01" inputmode="decimal" required>
       <label>Note</label><input name="note" placeholder="${cat === "service" ? "e.g. tyres, 2 front" : "optional"}">`;
  const dlg = dialog(`
    <h1>${CAT_LABELS[cat]} — ${esc(car.name)}</h1>
    <label>Date</label><input name="date" type="date" value="${today()}" required>
    ${unitFields}`, async d => {
    const f = new FormData($("form", d));
    const body = { category: cat, date: f.get("date"), note: f.get("note") || "" };
    for (const k of ["odometer", "litres", "price_per_litre", "kwh", "price_per_kwh", "cost"])
      if (f.get(k)) body[k] = parseFloat(f.get(k));
    await api(`/api/cars/${car.id}/entries`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
    <label>Fuel type</label><select name="fuel_type">
      ${["petrol", "diesel", "hybrid", "phev", "ev"].map(t =>
        `<option ${car.fuel_type === t ? "selected" : ""}>${t}</option>`).join("")}</select>
    <div class="switch"><input type="checkbox" name="ev_enabled" id="evt" ${car.ev_enabled ? "checked" : ""}>
      <label for="evt" style="margin:0">Electric charging entries</label></div>`, async d => {
    const f = new FormData($("form", d));
    await api(`/api/cars/${car.id}`, { method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: f.get("name"), reg: f.get("reg"),
        fuel_type: f.get("fuel_type"), ev_enabled: f.get("ev_enabled") === "on" }) });
    showCar(car.id);
  });
}

showList();
