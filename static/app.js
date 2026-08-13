/* Car Costs SPA — two screens: car list, car detail with add-entry dialogs. */
const $ = (s, el) => (el || document).querySelector(s);
const app = $("#app");
const eur = n => "€" + Number(n).toLocaleString("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const dmy = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;
const dm = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const CAT_LABELS = { fuel: "Fuel", charge: "Charge", insurance: "Insurance", tax: "Tax", nct: "NCT", service: "Service", odo: "Mileage", belt: "Timing belt", tyres: "Tyres", tyre_check: "Tyre check", check: "Check", repair: "Repair", toll: "Toll", parking: "Parking", misc: "Misc" };
const PERIODIC = ["toll", "parking"];   // also take a monthly total, not just one charge
const CHOOSER_LABELS = { renewals: "Renewals", running: "Running costs" };
const CHOOSER_CATS = { renewals: ["insurance", "tax", "nct"], running: ["service", "tyres", "misc"] };
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

// One /healthz call, used twice: the version line on the home screen and the
// no-password warning at the bottom of this file.
const health = fetch("/healthz").then(r => r.json()).catch(() => ({}));

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
        <span>${c.fuel.eur_per_100km ? "fuel " + eur(c.fuel.eur_per_100km) + "/100km" : ""}</span>
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
  const h = await health;
  if (h.version) app.insertAdjacentHTML("beforeend",
    `<div class="ver"><a href="https://github.com/colfin22/car-costs/releases/tag/v${encodeURIComponent(h.version)}"
      target="_blank" rel="noopener">v${esc(h.version)}</a>` +
    // Only worth offering where there is a password to be a second factor to.
    (h.password_set ? ` · <a href="#" id="security">Security</a>` : "") + `</div>`);
  if ($("#security")) $("#security").addEventListener("click", ev => {
    ev.preventDefault(); securityDialog();
  });
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
  const addBtns = ["fuel", ...(c.ev_enabled ? ["charge"] : []), "toll", "parking"]
    .map(k => `<button data-cat="${k}">+ ${CAT_LABELS[k]}</button>`).join("");
  // Mileage is a reading rather than a cost, so it gets its own button instead
  // of sitting under a heading about money.
  const smallBtns = `<button class="small ghost" data-cat="odo">+ ${CAT_LABELS.odo}</button>`
    + ["renewals", "running"]
      .map(k => `<button class="small ghost" data-cat="${k}">+ ${CHOOSER_LABELS[k]}…</button>`).join("");
  // Fuel gets its own row under the year row. The row above follows the year
  // selector; these two span every fill ever, so they are not the same scope and
  // must not share it. Four figures on one line only fit on a 360px phone if the
  // words saying which is which are cut, and then the numbers mean nothing.
  const fuelRow = (d.fuel.eur_per_100km || d.fuel.l_per_100km)
    ? `<div class="row muted" style="margin-top:2px;white-space:nowrap">
         <span>${d.fuel.eur_per_100km ? "fuel " + eur(d.fuel.eur_per_100km) + "/100km" : ""}</span>
         <span>${d.fuel.l_per_100km ? d.fuel.l_per_100km + " L/100km" : ""}</span></div>`
    : "";
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
      <div class="row muted" style="margin-top:6px;white-space:nowrap">
        <span>${s.km_driven ? s.km_driven.toLocaleString() + " km logged" : ""}</span>
        <span>${s.cost_per_km ? eur(s.cost_per_km) + "/km" : ""}</span></div>
      ${fuelRow}
    </div>
    <div class="card"><div class="muted" style="margin-bottom:4px">Recent</div>
      <div class="recent-scroll">
      ${d.entries.map(e => `
        <div class="entry entry-tap" data-entry="${e.id}"><span>${dmy(e.date)} <span class="cat">${CAT_LABELS[e.category]}${e.period === "month" ? " (monthly)" : ""}</span>
          ${e.litres ? e.litres + "L @" + (e.price_per_litre || 0).toFixed(3) : ""}
          ${e.kwh ? e.kwh + "kWh" : ""} ${esc(e.note || "")}</span>
        <span>${e.category === "odo" ? Math.round(e.odometer).toLocaleString() + " km" : eur(e.cost)} <button class="ghost clip${e.attachments.length ? "" : " clip-empty"}" data-att="${e.id}" title="Attachments">📎${e.attachments.length || ""}</button><button class="danger" data-del="${e.id}">✕</button></span></div>`).join("") ||
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
        return `<div class="entry-tap" data-corner="${k}"><b>${k}</b> <span class="muted">${dmy(t.date)}${km !== null ? " · " + km.toLocaleString() + " km" : ""}</span><br>
          <span class="muted">${esc([t.brand, t.size].filter(Boolean).join(" · ") || "—")}</span>${chkLine}</div>`;
      }).join("")}
      </div>
    </div>` : ""}
    ${d.service_log && d.service_log.length ? `
    <div class="card"><div class="muted" style="margin-bottom:4px">Service &amp; repairs</div>
      <div class="recent-scroll">
      ${d.service_log.map(s => `
        <div class="entry"><span>${dmy(s.date)}${s.category === "tyres" ? ` <span class="cat">Tyres · ${esc(s.corners || "")}</span>` : s.category === "repair" ? ` <span class="cat">Repair</span>` : ""}${s.odometer ? " · " + Math.round(s.odometer).toLocaleString() + " km" : ""}<br>
          <span class="muted">${esc(s.category === "tyres" ? [s.tyre_brand, s.tyre_size, s.note].filter(Boolean).join(" · ") || "—" : s.note || "—")}</span></span>
        <span>${eur(s.cost)}</span></div>`).join("")}
      </div>
    </div>` : ""}
    <div class="card"><div class="muted" style="margin-bottom:4px">Docs and pics</div>
      <div id="doc-list">${(d.attachments || []).map(a => `
        <div class="entry"><span class="doc-open" data-open="${a.id}" title="${esc(a.filename)}">${docThumb(a)}<span>${docLabel(a)} <span class="muted">${dmy(a.created)}</span></span></span>
        <span class="doc-btns">${rotBtn(a)}<button class="danger" data-adel="${a.id}">✕</button></span></div>`).join("") ||
        '<div class="muted" id="doc-empty">Nothing here yet — certs, receipts and reports live here, and so do pictures of the car.</div>'}</div>
      <div class="row" style="gap:10px;margin-top:8px">
        <button class="ghost" id="photo-doc" style="flex:1">📷 Pic</button>
        <button class="ghost" id="scan-doc" style="flex:1">📄 Scan</button>
        <button class="ghost" id="add-doc" style="flex:1">📁 File</button></div>
      <input type="file" id="doc-scan" accept="image/*" capture="environment" hidden>
      <input type="file" id="doc-photo" accept="image/*" capture="environment" hidden>
      <input type="file" id="doc-file" accept="image/*,application/pdf" hidden>
    </div>`;
  c._entries = d.entries;   // an edit needs its tyre fitting's companion baseline check
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
      b.dataset.cat === "tyres" ? tyreChooser(c)
        : b.dataset.cat === "service" ? serviceChooser(c)
        : b.dataset.cat === "renewals" ? catChooser(c, "renewals")
        : b.dataset.cat === "running" ? catChooser(c, "running")
        : entryDialog(c, b.dataset.cat)));
  wireBanners(c);
  app.querySelectorAll("[data-del]").forEach(b =>
    b.addEventListener("click", async () => {
      if (confirm("Delete this entry?" + (d.entries.find(e => e.id === +b.dataset.del)?.attachments.length ? " Its attachments go too." : ""))) { await api(`/api/entries/${b.dataset.del}`, { method: "DELETE" }); showCar(id); }
    }));
  app.querySelectorAll("[data-att]").forEach(b =>
    b.addEventListener("click", () => {
      const e = d.entries.find(en => en.id === +b.dataset.att);
      attachmentsDialog(c, e);
    }));
  app.querySelectorAll("[data-corner]").forEach(cell =>
    cell.addEventListener("click", () =>
      tyreHistoryDialog(c, cell.dataset.corner, (d.tyre_history || {})[cell.dataset.corner])));
  app.querySelectorAll("[data-entry]").forEach(row =>
    row.addEventListener("click", ev => {
      if (ev.target.closest("button")) return;   // 📎 and ✕ keep their own handlers
      entryDetailDialog(c, d.entries.find(en => en.id === +row.dataset.entry));
    }));
  app.querySelectorAll("[data-open]").forEach(el =>
    el.addEventListener("click", () => window.open(docUrl(el.dataset.open))));
  app.querySelectorAll("[data-adel]").forEach(b =>
    b.addEventListener("click", async () => {
      if (confirm("Delete this document?")) { await api(`/api/attachments/${b.dataset.adel}`, { method: "DELETE" }); showCar(id); }
    }));
  app.querySelectorAll("[data-rot]").forEach(b =>
    b.addEventListener("click", () =>
      imageDialog((d.attachments || []).find(a => a.id === +b.dataset.rot), () => showCar(id))));
  // Scan runs the crop step. Pic is the same camera with none of it, because a
  // wheel or a paint defect is a whole photo with no document in it to find, and
  // it only lives here: an expense wants a receipt, not a picture of the car.
  $("#scan-doc").addEventListener("click", () => $("#doc-scan").click());
  $("#photo-doc").addEventListener("click", () => $("#doc-photo").click());
  $("#add-doc").addEventListener("click", () => $("#doc-file").click());

  // Several in a row: each camera attachment offers another go. The reopen has
  // to happen inside a real tap, which is why this is a button and not something
  // you set beforehand — a `change` event grants no user activation on a phone,
  // so a camera opened from one is silently refused. Uploads are chained rather
  // than fired in parallel, and rows are appended as they land: a full re-render
  // mid-run would destroy the very input the camera is attached to.
  let queue = Promise.resolve(), shot = 0;
  const addRow = att => {
    const empty = $("#doc-empty");
    if (empty) empty.remove();
    const row = document.createElement("div");
    row.className = "entry";
    row.innerHTML = `<span class="doc-open" data-open="${att.id}" title="${esc(att.filename)}">${docThumb(att)}<span>${docLabel(att)} <span class="muted">${dmy(att.created)}</span></span></span>
      <span class="doc-btns">${rotBtn(att)}<button class="danger" data-adel="${att.id}">✕</button></span>`;
    $("[data-open]", row).addEventListener("click", () => window.open(docUrl(att.id)));
    if ($("[data-rot]", row))
      $("[data-rot]", row).addEventListener("click", () => imageDialog(att, () => showCar(id)));
    $("[data-adel]", row).addEventListener("click", async () => {
      if (confirm("Delete this document?")) { await api(`/api/attachments/${att.id}`, { method: "DELETE" }); showCar(id); }
    });
    $("#doc-list").append(row);
  };
  // Asked while the upload runs, so the camera comes back without waiting on it.
  const askAnother = (el, what) => new Promise(resolve => {
    const dlg = document.createElement("dialog");
    dlg.innerHTML = `<h1>${what} attached</h1>
      <p class="hint" style="margin:0">Take another, or you are done.</p>
      <div class="dlg-actions"><button type="button" class="ghost" id="ta-done">Done</button>
      <button type="button" id="ta-more">Take another</button></div>`;
    document.body.append(dlg);
    const end = more => { dlg.close(); dlg.remove(); resolve(more); };
    $("#ta-more", dlg).addEventListener("click", () => {
      el.value = ""; el.click();   // inside the tap, which is the whole point
      end(true);
    });
    $("#ta-done", dlg).addEventListener("click", () => end(false));
    dlg.addEventListener("cancel", ev => { ev.preventDefault(); end(false); });
    dlg.showModal();
  });

  for (const inp of ["#doc-scan", "#doc-photo", "#doc-file"])
    $(inp).addEventListener("change", async ev => {
      const el = ev.target, file = el.files[0];
      if (!file) return;
      let doc = file;
      if (inp === "#doc-scan") {
        doc = await scanCrop(file, el);
        if (doc === SCAN_RETAKE) return;   // scanCrop already reopened the camera
        if (!doc) { el.value = ""; return; }
      }
      // Scans share one name, so a second in a row would collide.
      const name = doc === file ? undefined : (++shot > 1 ? `scan-${shot}.jpg` : "scan.jpg");
      const upload = queue = queue.then(async () => {
        try { return await uploadDoc(`/api/cars/${id}/attachments`, doc, name); }
        catch (e) { alert(e.message); }
      });
      if (inp === "#doc-file") { await upload; showCar(id); return; }
      const more = await askAnother(el, inp === "#doc-scan" ? "Scan" : "Photo");
      const att = await upload;
      if (!more) showCar(id);
      else if (att) addRow(att);
    });
}

/* ---------- rotating a stored image (#43) ----------
   A photo taken over a receipt often lands sideways, and until now it stayed
   that way: every other path here only reads an attachment. The rotate is a
   real rewrite on the server, so once it is saved the file itself is upright
   and anything that opens it later — this app, a download, a thumbnail — sees
   the same picture.

   `docV` is a cache buster, not decoration. The browser has already cached
   /api/attachments/{id}; without a changing query the rotation looks like it
   did nothing at all, which is the same trap as the ?v= rule on app.js. */
const docV = {};
const docUrl = id => `/api/attachments/${id}${docV[id] ? `?v=${docV[id]}` : ""}`;
const canRotate = att => (att.media_type || "").startsWith("image/");
// A pencil, not an arrow: the dialog behind this button names a picture as well
// as turning it, and naming is the part you reach for most.
const rotBtn = att => canRotate(att) ? `<button class="ghost rot" data-rot="${att.id}" title="Name or rotate this picture">✎</button>` : "";

/* A row of file names never says which scan is which receipt (#44). Images get
   a small picture, drawn and cached by the server on first request; a PDF keeps
   an icon in the same slot so the rows still line up. The cache buster is the
   one from the rotate above, so straightening a photo refreshes its picture. */
/* A phone names the file, so a row reads `scan.jpg` unless you say otherwise
   (#47). The note stands in for the name in every list; the real file name is
   still on the row as a tooltip, and in full in the image dialog. */
const docLabel = att => esc(att.note || att.filename);
const docThumb = att => canRotate(att)
  ? `<img class="doc-thumb" loading="lazy" alt="" src="/api/attachments/${att.id}/thumb${docV[att.id] ? `?v=${docV[att.id]}` : ""}">`
  : `<span class="doc-thumb doc-thumb-pdf">📄</span>`;

function imageDialog(att, done) {
  let deg = 0;
  const dlg = document.createElement("dialog");
  dlg.className = "rot-dlg";
  dlg.innerHTML = `<h1>Picture</h1>
    <p class="hint" style="margin:0 0 8px">${esc(att.filename)}</p>
    <div class="rot-stage"><img alt="" src="/api/attachments/${att.id}?v=${Date.now()}"></div>
    <label class="rot-note">Note<input id="rot-note" type="text" maxlength="80"
      placeholder="Shown instead of the file name" value="${esc(att.note || "")}"></label>
    <div class="dlg-actions">
      <button type="button" class="ghost" id="rot-l" title="Turn left">↺</button>
      <button type="button" class="ghost" id="rot-r" title="Turn right">↻</button>
      <button type="button" class="ghost" id="rot-x">Cancel</button>
      <button type="button" id="rot-ok">Save</button></div>`;
  document.body.append(dlg);
  const img = $("img", dlg);
  const noteBox = $("#rot-note", dlg);
  const was = att.note || "";
  const turn = by => { deg = (deg + by + 360) % 360; img.style.transform = `rotate(${deg}deg)`; };
  const end = () => { dlg.close(); dlg.remove(); };
  $("#rot-l", dlg).addEventListener("click", () => turn(-90));
  $("#rot-r", dlg).addEventListener("click", () => turn(90));
  $("#rot-x", dlg).addEventListener("click", end);
  dlg.addEventListener("cancel", ev => { ev.preventDefault(); end(); });
  $("#rot-ok", dlg).addEventListener("click", async () => {
    const note = noteBox.value.trim();
    if (!deg && note === was) return end();   // nothing changed, nothing to write
    try {
      if (deg) await api(`/api/attachments/${att.id}/rotate?degrees=${deg}`, { method: "POST" });
      if (note !== was)
        await api(`/api/attachments/${att.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note }) });
    } catch (e) { alert(e.message); return; }
    if (deg) docV[att.id] = Date.now();
    end();
    if (done) done();
  });
  dlg.showModal();
}

async function uploadDoc(path, file, name) {
  const fd = new FormData();
  if (name) fd.append("file", file, name); else fd.append("file", file);
  return api(path, { method: "POST", body: fd });
}

/* ---------- scan cropping (#19) ----------
   The server finds the document in a camera photo and flattens it; this side
   just asks and shows the answer. The first attempt did the detection here in
   the browser with a 9 MB OpenCV build and never once worked on a phone, which
   is the whole reason it moved. Picker-chosen files skip all of this.

   Returns a cropped JPEG Blob, the original file, SCAN_RETAKE (#36, take the
   photo again) or null (cancelled). Anything that goes wrong returns the
   original — a scan is never lost to this step.

   The dialog also opens when the server found nothing to crop, so that a bad
   photo can be taken again instead of attaching silently. Nothing to crop is
   not a failure though — a car part, a paint defect or crash damage is a whole
   photo by design, so that path keeps "Attach as taken" as the main action. */
const SCAN_RETAKE = Symbol("retake");
async function scanCrop(file, input) {
  let crop = null;
  try {
    const fd = new FormData();
    fd.append("file", file, file.name || "scan.jpg");
    const r = await fetch("/api/scan/preview", { method: "POST", body: fd });
    if (!r.ok) return file;
    if ((r.headers.get("content-type") || "").startsWith("image/")) crop = await r.blob();
    // Only "no document found" is worth asking about. An instance without the
    // scanning dependency would otherwise pop this dialog on every single scan.
    else if ((await r.json()).reason !== "no document found") return file;
  } catch (e) { return file; }

  const cropUrl = crop ? URL.createObjectURL(crop) : null, fullUrl = URL.createObjectURL(file);
  return new Promise(resolve => {
    const dlg = document.createElement("dialog");
    dlg.className = "scan-dlg";
    dlg.innerHTML = `<h1>${crop ? "Crop scan" : "Scan"}</h1>
      <p class="hint" style="margin:0 0 8px">${crop
        ? "Cropped to the document. Keep it, or attach the photo as taken."
        : "Nothing to crop here, so the whole photo goes up. Take it again if it did not come out."}</p>
      <div class="scan-pair">
        ${crop ? `<figure><img src="${cropUrl}" alt="Cropped scan"><figcaption>Cropped</figcaption></figure>` : ""}
        <figure><img src="${fullUrl}" alt="Photo as taken"><figcaption>As taken</figcaption></figure>
      </div>
      <div class="dlg-actions"><button type="button" class="ghost" id="sc-retake">Retake</button>
      <button type="button" ${crop ? `class="ghost"` : ""} id="sc-full">${crop ? "Full photo" : "Attach as taken"}</button>
      ${crop ? `<button type="button" id="sc-crop">Use crop</button>` : ""}</div>`;
    document.body.append(dlg);
    const finish = val => {
      if (cropUrl) URL.revokeObjectURL(cropUrl);
      URL.revokeObjectURL(fullUrl);
      dlg.close(); dlg.remove(); resolve(val);
    };
    $("#sc-retake", dlg).addEventListener("click", () => {
      // Reopen from inside the click itself — a mobile browser refuses a file
      // input opened any later. Clearing the value first is what lets the same
      // photo fire `change` a second time.
      if (input) { input.value = ""; input.click(); }
      finish(SCAN_RETAKE);
    });
    $("#sc-full", dlg).addEventListener("click", () => finish(file));
    if (crop) $("#sc-crop", dlg).addEventListener("click", () => finish(crop));
    dlg.addEventListener("cancel", ev => { ev.preventDefault(); finish(null); });   // Esc abandons the scan
    dlg.showModal();
  });
}

/* One corner's tread readings since its tyres were fitted. Wear rate and the
   distance left are estimates from two points — labelled as such, and never a
   badge or a due date: tyre wear isn't a calendar. */
function tyreHistoryDialog(car, corner, h) {
  const km = n => Math.round(n).toLocaleString("en-IE");
  const fitted = h && h.fitted;
  const rows = (h && h.readings || []).map((r, i, all) => {
    const last = i === all.length - 1;
    let sub = "";
    if (r.delta_mm !== null && r.delta_mm !== undefined)
      sub = `${r.delta_mm > 0 ? "+" : "−"}${Math.abs(r.delta_mm)} mm`
        + (r.km ? ` over ${km(r.km)} km` : " (no mileage recorded)");
    else if (last && fitted && r.date === fitted.date) sub = "fitted new";
    return `<div class="entry"><span>${dmy(r.date)}${sub ? `<br><span class="muted">${sub}</span>` : ""}</span>
      <span>${treadCell(r.mm)}</span></div>`;
  }).join("");

  let est = "";
  if (h && h.rate_mm_per_10k)
    est = `<p class="hint" style="margin:10px 0 0">Estimate from ${h.readings.length} readings:
      <b>${h.rate_mm_per_10k} mm per 10,000 km</b>${h.km_to_legal
        ? `<br>roughly <b>${km(h.km_to_legal)} km</b> before this corner reaches the 1.6 mm legal minimum`
        : ""}.</p>`;
  else if (h && h.readings && h.readings.length < 2)
    est = `<p class="hint" style="margin:10px 0 0">No wear figure yet — that needs a second check.</p>`;

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `<form method="dialog">
    <h1>${corner}${fitted && fitted.brand ? " — " + esc(fitted.brand) : ""}</h1>
    ${fitted ? `<p class="hint" style="margin:0 0 10px">Fitted ${dmy(fitted.date)}${fitted.size ? " · " + esc(fitted.size) : ""}</p>` : ""}
    ${rows || '<div class="muted">No tread readings for this corner yet.</div>'}
    ${est}
    <div class="dlg-actions"><button class="ghost" value="cancel" formnovalidate>Close</button></div></form>`;
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
}

/* Read-only detail of one entry — everything logged at entry time, which the
   Recent line has no room for. Editing lives in its own issue. */
function treadCell(mm) {
  const cls = mm < 1.6 ? "due-red" : mm <= 3 ? "due-amber" : null;
  return cls ? `<span class="due ${cls}">${mm} mm</span>` : `${mm} mm`;
}

function entryDetailDialog(car, entry) {
  if (!entry) return;
  const rows = [];
  const add = (label, value) => { if (value !== null && value !== undefined && value !== "") rows.push([label, value]); };
  const num = n => Number(n).toLocaleString("en-IE");

  add("Date", dmy(entry.date));
  add("Category", CAT_LABELS[entry.category]);
  if (PERIODIC.includes(entry.category))
    add("Covers", entry.period === "month" ? "A whole month" : "One " + (entry.category === "toll" ? "journey" : "stay"));
  if (entry.category === "fuel") {
    add("Litres", entry.litres ? entry.litres + " L" : null);
    add("Price", entry.price_per_litre ? "€" + entry.price_per_litre.toFixed(3) + "/L" : null);
  }
  if (entry.category === "charge") {
    add("Energy", entry.kwh ? entry.kwh + " kWh" : null);
    add("Price", entry.price_per_kwh ? "€" + entry.price_per_kwh.toFixed(3) + "/kWh" : null);
  }
  if (entry.category === "tyres") {
    add("Corners fitted", (entry.corners || "").split(",").filter(Boolean).join(", "));
    add("Brand", entry.tyre_brand ? esc(entry.tyre_brand) : null);
    add("Size", entry.tyre_size ? esc(entry.tyre_size) : null);
  }
  if (entry.category === "tyre_check") {
    const checked = (entry.corners || "").split(",").filter(Boolean);
    add("Corners checked", checked.join(", "));
    const mm = {};
    for (const p of (entry.tread_mm || "").split(",").filter(Boolean)) {
      const [k, v] = p.split("=");
      if (!isNaN(parseFloat(v))) mm[k] = parseFloat(v);
    }
    const depths = CORNERS.filter(k => mm[k] !== undefined)
      .map(k => `<b>${k}</b> ${treadCell(mm[k])}`).join(" &nbsp; ");
    add("Tread", depths || null);
  }
  add("Odometer", entry.odometer != null ? num(Math.round(entry.odometer)) + " km" : null);
  if (entry.category !== "odo") add("Amount", eur(entry.cost));
  add("Note", entry.note ? esc(entry.note).replace(/\n/g, "<br>") : null);

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `<form method="dialog"><h1>${CAT_LABELS[entry.category]} — ${dmy(entry.date)}</h1>
    <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    <div class="dlg-actions"><button type="button" id="det-edit">Edit</button>
    <button type="button" id="det-att" class="ghost">📎 Attachments${entry.attachments.length ? " (" + entry.attachments.length + ")" : ""}</button>
    <button type="button" class="danger" id="det-del">Delete</button>
    <button class="ghost" value="cancel" formnovalidate>Close</button></div></form>`;
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  $("#det-edit", dlg).addEventListener("click", () => { dlg.close("cancel"); entryDialog(car, entry.category, entry); });
  $("#det-att", dlg).addEventListener("click", () => { dlg.close("cancel"); attachmentsDialog(car, entry); });
  $("#det-del", dlg).addEventListener("click", async () => {
    if (!confirm("Delete this entry?" + (entry.attachments.length ? " Its attachments go too." : ""))) return;
    try { await api(`/api/entries/${entry.id}`, { method: "DELETE" }); }
    catch (e) { alert(e.message); return; }
    dlg.close("cancel"); showCar(car.id);
  });
  dlg.showModal();
}

function attachmentsDialog(car, entry) {
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `<form method="dialog"><h1>${CAT_LABELS[entry.category]} ${dmy(entry.date)} — attachments</h1>
    ${entry.attachments.map(a => `
      <div class="entry"><span class="doc-open" data-open="${a.id}" title="${esc(a.filename)}">${docThumb(a)}<span>${docLabel(a)}</span></span>
      <span class="doc-btns">${rotBtn(a)}<button type="button" class="danger" data-adel="${a.id}">✕</button></span></div>`).join("") ||
      '<div class="muted">Nothing attached yet.</div>'}
    <input type="file" class="att-scan" accept="image/*" capture="environment" hidden>
    <input type="file" class="att-file" accept="image/*,application/pdf" hidden>
    <div class="dlg-actions"><button type="button" id="att-scan">📄 Scan</button>
    <button type="button" class="ghost" id="att-add">Attach file…</button>
    <button class="ghost" value="cancel" formnovalidate>Close</button></div></form>`;
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.querySelectorAll("[data-open]").forEach(el =>
    el.addEventListener("click", () => window.open(docUrl(el.dataset.open))));
  dlg.querySelectorAll("[data-rot]").forEach(b =>
    b.addEventListener("click", () =>
      imageDialog(entry.attachments.find(a => a.id === +b.dataset.rot),
                   () => { dlg.close("cancel"); showCar(car.id); })));
  dlg.querySelectorAll("[data-adel]").forEach(b =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this document?")) return;
      try { await api(`/api/attachments/${b.dataset.adel}`, { method: "DELETE" }); }
      catch (e) { alert(e.message); return; }
      dlg.close("cancel"); showCar(car.id);
    }));
  $("#att-scan", dlg).addEventListener("click", () => $(".att-scan", dlg).click());
  $("#att-add", dlg).addEventListener("click", () => $(".att-file", dlg).click());
  dlg.querySelectorAll("input[type=file]").forEach(inp =>
    inp.addEventListener("change", async ev => {
      const file = ev.target.files[0];
      if (!file) return;
      const doc = inp.classList.contains("att-scan") ? await scanCrop(file, ev.target) : file;
      if (doc === SCAN_RETAKE) return;   // scanCrop already reopened the camera
      if (!doc) { ev.target.value = ""; return; }
      try { await uploadDoc(`/api/entries/${entry.id}/attachments`, doc, doc === file ? undefined : "scan.jpg"); }
      catch (e) { alert(e.message); return; }
      dlg.close("cancel"); showCar(car.id);
    }));
  dlg.showModal();
}

/* ---------- dialogs ---------- */
function dialog(html, onSubmit) {
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `<form method="dialog">${html}
    <div class="dlg-actions"><button class="ghost" value="cancel" formnovalidate>Cancel</button>
    <button value="save">Save</button></div></form>`;
  document.body.append(dlg);
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue === "save" && onSubmit) { try { await onSubmit(dlg); } catch (e) { alert(e.message); } }
    dlg.remove();
  });
  dlg.showModal();
  return dlg;
}

/* ---------- security: optional second factor at login ---------- */
/* The session cookie is unchanged by any of this — 2FA only adds a step at
   /login, so once you are in, nothing else in the app behaves differently. */
async function securityDialog() {
  const st = await api("/api/totp");
  if (!st.available) return void dialog(`<h1>Two-factor login</h1>
    <p class="muted">This install is missing the <code>pyotp</code> package. Add it and restart to use a second factor.</p>`);

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `<form method="dialog"><h1>Two-factor login</h1>
    <p class="muted">${st.enabled
      ? `On. Your password alone is not enough to sign in.<br>Recovery codes left: <b>${st.backup_codes_remaining}</b>.`
      : "Off. Add a 6-digit code from an authenticator app on top of your password."}</p>
    <div class="dlg-actions" style="flex-direction:column;align-items:stretch;gap:8px">
    ${st.enabled
      ? `<button value="codes">New recovery codes…</button><button value="off">Turn off…</button>`
      : `<button value="on">Set it up…</button>`}
    <button class="ghost" value="cancel" formnovalidate>Close</button></div></form>`;
  document.body.append(dlg);
  dlg.addEventListener("close", () => {
    const v = dlg.returnValue;
    dlg.remove();
    if (v === "on") totpSetupDialog();
    else if (v === "off") codePrompt("Turn off two-factor login",
      "Enter a current code to confirm.", "/api/totp/disable",
      () => alert("Two-factor login is off."));
    else if (v === "codes") codePrompt("New recovery codes",
      "Enter a current code. This replaces any codes you already have.",
      "/api/totp/backup-codes", r => showBackupCodes(r.backup_codes));
  });
  dlg.showModal();
}

/* Enrolment: the secret is minted server-side but stays inactive until a code
   confirms it, so a bad scan cannot lock you out. */
async function totpSetupDialog() {
  const s = await api("/api/totp/setup", { method: "POST" });
  enableStep(`<h1>Scan this</h1>
    <div class="qr">${s.qr_svg}</div>
    <p class="muted">Can't scan? Enter this key by hand:<br><code class="secret">${esc(s.secret)}</code></p>`);
}

function enableStep(header) {
  dialog(header + `<label>Code from the app</label>
    <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6 digits" required>`,
    async d => {
      try {
        const r = await api("/api/totp/enable", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: new FormData($("form", d)).get("code") }) });
        showBackupCodes(r.backup_codes);
      } catch (e) {
        // Ask again against the SAME pending secret, so a mistyped code does
        // not mean scanning the QR a second time.
        enableStep(`<h1>Try again</h1><p class="muted">${esc(e.message)}</p>`);
      }
    });
}

function codePrompt(title, msg, url, onDone) {
  dialog(`<h1>${title}</h1><p class="muted">${msg}</p>
    <label>Code</label>
    <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6 digits or a recovery code" required>`,
    async d => onDone(await api(url, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: new FormData($("form", d)).get("code") }) })));
}

/* Shown once and never again — the server only keeps hashes. */
function showBackupCodes(codes) {
  dialog(`<h1>Recovery codes</h1>
    <p class="muted">Each works once, in place of a code from the app. Save them now. They are not shown again.</p>
    <pre class="codes">${codes.map(esc).join("\n")}</pre>`);
}

/* Renewals and running costs each sit behind one button, so the car page keeps a
   single short row and the primary buttons stay above the fold on a phone. */
function catChooser(car, group) {
  const cats = CHOOSER_CATS[group];
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `<form method="dialog"><h1>${CHOOSER_LABELS[group]} — ${esc(car.name)}</h1>
    <div class="dlg-actions" style="flex-direction:column;align-items:stretch;gap:8px">
    ${cats.map(k => `<button value="${k}">${CAT_LABELS[k]}…</button>`).join("")}
    <button class="ghost" value="cancel" formnovalidate>Cancel</button></div></form>`;
  document.body.append(dlg);
  dlg.addEventListener("close", () => {
    const v = dlg.returnValue;
    // Service and tyres have their own second step, so hand off rather than
    // going straight to an entry form.
    if (v === "service") serviceChooser(car);
    else if (v === "tyres") tyreChooser(car);
    else if (cats.includes(v)) entryDialog(car, v);
    dlg.remove();
  });
  dlg.showModal();
}

function serviceChooser(car) {
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `<form method="dialog"><h1>Service — ${esc(car.name)}</h1>
    <div class="dlg-actions" style="flex-direction:column;align-items:stretch;gap:8px">
    <button value="service">Full service…</button>
    <button value="check">Quick check…</button>
    <button value="repair">Repair…</button>
    <button class="ghost" value="cancel" formnovalidate>Cancel</button></div></form>`;
  document.body.append(dlg);
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "service") entryDialog(car, "service");
    if (dlg.returnValue === "check") entryDialog(car, "check");
    if (dlg.returnValue === "repair") entryDialog(car, "repair");
    dlg.remove();
  });
  dlg.showModal();
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

function baselineCheckFor(car, entry) {
  // Mirrors the server's rule: the fitting's baseline is the check sharing its
  // date and corners, whoever wrote it.
  const same = (car._entries || []).filter(e => e.category === "tyre_check"
    && e.date === entry.date && e.corners === entry.corners);
  return same.find(e => e.note === "Full tread when fitted") || same[0];
}

function prefillEntry(dlg, cat, entry, car) {
  const form = $("form", dlg);
  const set = (name, value) => {
    const el = form.elements[name];
    if (el && value !== null && value !== undefined) el.value = value;
  };
  const drop = name => {
    const el = form.elements[name];
    if (!el) return;
    if (el.previousElementSibling && el.previousElementSibling.tagName === "LABEL")
      el.previousElementSibling.remove();
    el.remove();
  };
  // A scan belongs to the 📎 dialog, and a renewal date belongs to the car, not the entry.
  const picker = dlg.querySelector("#doc-pick");   // label, both cameras and the status line
  if (picker) picker.remove();
  drop("due");
  if (PERIODIC.includes(cat)) {
    // The type has to change before the value: a month string assigned to a
    // date input is rejected and leaves the field blank.
    form.querySelectorAll("input[name=period]").forEach(r => { r.checked = (r.value === entry.period); });
    if (entry.period === "month") {
      $("label", dlg).textContent = "Month";
      form.elements.date.type = "month";
    }
  }
  set("date", entry.period === "month" ? entry.date.slice(0, 7) : entry.date);
  for (const k of ["odometer", "litres", "price_per_litre", "kwh", "price_per_kwh", "cost",
                   "note", "tyre_size", "tyre_brand"])
    if (entry[k] !== null && entry[k] !== undefined) set(k, entry[k]);
  if (cat === "odo") set("cost", null);
  const corners = (entry.corners || "").split(",").filter(Boolean);
  form.querySelectorAll("input[name=corner]").forEach(b => { b.checked = corners.includes(b.value); });
  if (cat === "tyre_check")
    for (const p of (entry.tread_mm || "").split(",").filter(Boolean)) {
      const [k, v] = p.split("=");
      set("mm_" + k, v);
    }
  if (cat === "tyres") {
    const base = baselineCheckFor(car, entry);
    const mm = base ? (base.tread_mm || "").split(",")[0] : "";
    set("tread_new", mm ? mm.split("=")[1] : "");
  }
}

function clockChangeText(changes) {
  const label = { service: "Next service", belt: "Timing belt",
                  tyres: "The tyres on record", tyre_checks: "The tread readings on record" };
  const lines = Object.entries(changes).map(([k, ch]) => {
    if (k === "tyres" || k === "tyre_checks") return label[k] + " change.";
    const b = ch.before && ch.before.date ? dmy(ch.before.date) : "nothing";
    const a = ch.after && ch.after.date ? dmy(ch.after.date) : "nothing";
    return `${label[k]} moves from ${b} to ${a}.`;
  });
  return lines.join("\n") + "\n\nSave anyway?";
}

function entryDialog(car, cat, entry) {
  const isFuel = cat === "fuel", isCharge = cat === "charge";
  const unitFields = isFuel ? `
      <label>Amount (€)</label><input name="cost" type="number" step="0.01" inputmode="decimal" required>
      <label>Odometer (km)</label><input name="odometer" type="number" step="1" inputmode="numeric" required>
      <label>Litres</label><input name="litres" type="number" step="0.01" inputmode="decimal" required>
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
      <label>Odometer (km) — optional, sharpens the wear estimate</label><input name="odometer" type="number" step="1" inputmode="numeric">
      <label>Note</label><input name="note" placeholder="e.g. all okay">`
    : cat === "tyres" ? `
      <label>Corners</label>
      <div class="row" style="justify-content:flex-start;gap:14px">
        ${CORNERS.map(k => `<label style="display:inline-flex;align-items:center;gap:4px;margin:0"><input type="checkbox" name="corner" value="${k}">${k}</label>`).join("")}
      </div>
      <label>Odometer (km)</label><input name="odometer" type="number" step="1" inputmode="numeric" required>
      <label>Amount (€)</label><input name="cost" type="number" step="0.01" inputmode="decimal" required>
      <label>Tread when new (mm) — blank for none</label>
      <input name="tread_new" type="number" step="0.1" inputmode="decimal" value="8.0">
      <label>Size</label><input name="tyre_size" value="${esc((car._tyrePrefill || {}).size || "")}" placeholder="e.g. 205/55 R16">
      <label>Brand / model</label><input name="tyre_brand" value="${esc((car._tyrePrefill || {}).brand || "")}" placeholder="e.g. Michelin CrossClimate 2">
      <label>Note</label><input name="note" placeholder="optional">`
    : cat === "service" ? `
      <label>Work done</label><textarea name="note" rows="3" required placeholder="e.g. full service — oil, filters, rear pads"></textarea>
      <label>Amount (€)</label><input name="cost" type="number" step="0.01" inputmode="decimal" required>
      <label>Odometer (km) — optional, anchors the service interval</label><input name="odometer" type="number" step="1" inputmode="numeric">`
    : cat === "repair" ? `
      <label>Work done</label><textarea name="note" rows="3" required placeholder="e.g. front brake discs and pads"></textarea>
      <label>Amount (€)</label><input name="cost" type="number" step="0.01" inputmode="decimal" required>
      <label>Odometer (km) — optional</label><input name="odometer" type="number" step="1" inputmode="numeric">`
    : cat === "check" ? `
      <label>What did you check?</label><textarea name="note" rows="3" required placeholder="e.g. checked coolant & oil, topped up washer fluid, tyre pressures"></textarea>
      <label>Odometer (km) — optional</label><input name="odometer" type="number" step="1" inputmode="numeric">`
    : cat === "misc" ? `
      <label>What was it?</label><input name="note" required placeholder="e.g. car wash, air pump">
      <label>Amount (€)</label><input name="cost" type="number" step="0.01" inputmode="decimal" required>`
    : PERIODIC.includes(cat) ? `
      <div class="row" style="justify-content:flex-start;gap:14px">
        <label style="display:inline-flex;align-items:center;gap:4px;margin:0"><input type="radio" name="period" value="" checked>One ${cat === "toll" ? "journey" : "stay"}</label>
        <label style="display:inline-flex;align-items:center;gap:4px;margin:0"><input type="radio" name="period" value="month">Monthly total</label>
      </div>
      <label>Amount (€)</label><input name="cost" type="number" step="0.01" inputmode="decimal" required>
      <label>${cat === "toll" ? "Road or plaza" : "Location"}</label>
      <input name="note" placeholder="${cat === "toll" ? "e.g. M50 eFlow" : "e.g. Q-Park Cork"}">`
    : `<label>Amount (€) — leave blank if only setting the date</label><input name="cost" type="number" step="0.01" inputmode="decimal">
       <label>${{ tax: "New tax expiry", nct: "New NCT due date", insurance: "New renewal date" }[cat]} (optional)</label><input name="due" type="date">
       <label>Note</label><input name="note" placeholder="optional">`;
  let scanBlob = null;
  const docField = cat === "odo" ? "" : `
      <div id="doc-pick">
        <label>Scan receipt or report (optional)</label>
        <button type="button" class="ghost" id="ent-scan" style="width:100%">📄 Scan</button>
        <div class="hint" id="ent-doc-status"></div>
        <input type="file" class="ent-scan" accept="image/*" capture="environment" hidden>
      </div>`;
  const dlg = dialog(`
    <h1>${entry ? "Edit" : CAT_LABELS[cat]} — ${entry ? CAT_LABELS[cat] : esc(car.name)}</h1>
    <label>Date</label><input name="date" type="date" value="${today()}" required>
    ${unitFields}${docField}`, async d => {
    const f = new FormData($("form", d));
    const doc = scanBlob;   // set at pick time, after the crop step
    const buildBody = () => {
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
        if (f.get("tread_new"))   // becomes a same-date baseline check, server-side
          body.tread_mm = f.getAll("corner").map(k => `${k}=${parseFloat(f.get("tread_new"))}`).join(",");
      }
      if (cat === "tyre_check")
        body.tread_mm = picked_mm(f, f.getAll("corner"));
      if (PERIODIC.includes(cat) && f.get("period") === "month") {
        body.period = "month";
        body.date = f.get("date") + "-01";   // the field is a month picker
      }
      return body;
    };
    if (entry) {
      // Preview first: a date or an odometer edit can move a due clock, and the
      // preview is the real write rolled back, so it cannot disagree with the save.
      const body = JSON.stringify(buildBody());
      const opts = { method: "PATCH", headers: { "Content-Type": "application/json" }, body };
      const preview = await api(`/api/entries/${entry.id}?dry_run=true`, opts);
      if (Object.keys(preview.clock_change).length && !confirm(clockChangeText(preview.clock_change)))
        return;
      await api(`/api/entries/${entry.id}`, opts);
      showCar(car.id);
      return;
    }
    const dueField = { tax: "tax_due", nct: "nct_due", insurance: "insurance_due" }[cat];
    const hasCost = !!f.get("cost"), hasDue = dueField && !!f.get("due");
    if (dueField && !hasCost && !hasDue) throw new Error("Enter an amount, a date, or both");
    if (hasDue)
      await api(`/api/cars/${car.id}`, { method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [dueField]: f.get("due") }) });
    if (hasCost || !dueField) {
      const made = await api(`/api/cars/${car.id}/entries`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildBody()) });
      if (doc && doc.size)
        await uploadDoc(`/api/entries/${made.id}/attachments`, doc, doc instanceof File ? undefined : "scan.jpg");
    } else if (doc && doc.size)
      // date-only renewal creates no entry — keep the scan as a car document
      await uploadDoc(`/api/cars/${car.id}/attachments`, doc, doc instanceof File ? undefined : "scan.jpg");
    showCar(car.id);
  });
  if (entry) prefillEntry(dlg, cat, entry, car);
  if (PERIODIC.includes(cat)) {
    // A monthly total belongs to a month, not a day — swap the picker to match.
    const dateInput = $("input[name=date]", dlg), label = $("label", dlg);
    dlg.querySelectorAll("input[name=period]").forEach(r => r.addEventListener("change", () => {
      const monthly = r.value === "month" && r.checked;
      label.textContent = monthly ? "Month" : "Date";
      dateInput.type = monthly ? "month" : "date";
      dateInput.value = monthly ? today().slice(0, 7) : today();
    }));
  }
  // An expense wants its receipt, so this is the scan path only. Pictures of the
  // car itself belong in the car's own Docs and pics card.
  const status = $("#ent-doc-status", dlg);
  if (status) {
    const setStatus = () => {
      status.textContent = !scanBlob ? ""
        : scanBlob instanceof File ? `Attached: ${scanBlob.name}` : "Cropped scan attached";
    };
    $("#ent-scan", dlg).addEventListener("click", () => $(".ent-scan", dlg).click());
    $(".ent-scan", dlg).addEventListener("change", async ev => {
      const file = ev.target.files[0];
      if (!file) { scanBlob = null; setStatus(); return; }
      const doc = await scanCrop(file, ev.target);
      // A retake replaces the held photo rather than adding a second one.
      if (doc === SCAN_RETAKE) { scanBlob = null; setStatus(); return; }
      scanBlob = doc;
      if (!scanBlob) ev.target.value = "";
      setStatus();
    });
  }
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

// Running-open warning: the docs treat CARCOSTS_PASSWORD as required; if this
// instance has none set, say so where it can't be missed.
health.then(h => {
  if (h.password_set === false && !$("#nopw")) {
    const b = document.createElement("div");
    b.id = "nopw";
    b.innerHTML = '⚠️ No password set — anyone who can reach this page can see your cars and documents. <a href="https://github.com/colfin22/car-costs/blob/main/docs/setup.md#5-set-a-password--do-not-skip-this" target="_blank" rel="noopener">Set one (takes a minute)</a>.';
    document.body.insertBefore(b, app);
  }
}).catch(() => {});
