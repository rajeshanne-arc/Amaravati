/* ============================================================
   Amaravati LPS Atlas — app.js
   Snapshot-powered register + live APCRDA queries for details.
   ============================================================ */

/* ---------------- CONFIG (edit here) ---------------- */
const CONFIG = {
  SERVICE: "https://gis.apcrda.org/server/rest/services/APCRDAGIS/LPS_Plot/MapServer",
  PLOT_LAYER: 0,        // confirm at SERVICE/layers
  SNAPSHOT: "data/plots.json",
  PROXY: "",            // e.g. "https://your-worker.workers.dev" if status shows BLOCKED
  MAP_CENTER: [16.53, 80.51],
  MAP_ZOOM: 13,
  // plotcoord field is in UTM Zone 44N (WGS84). If plots draw offset on the map,
  // this is the one thing to change (e.g. zone 43 or 44). Bounds sanity-check
  // rejects mis-projected points so a wrong guess degrades gracefully.
  UTM_PROJ: "+proj=utm +zone=44 +datum=WGS84 +units=m +no_defs",
  LAT_RANGE: [15.5, 17.5],
  LNG_RANGE: [79.0, 82.0],
};

/* ---------------- zoning palette (official RGB, keyed by code prefix) ---- */
const ZONE_COLORS = {
  R1: "#5f5b52", R2: "rgb(255,255,127)", R3: "rgb(255,216,104)", R4: "rgb(230,152,0)",
  C1: "rgb(104,172,255)", C2: "rgb(78,198,241)", C3: "rgb(83,181,255)",
  C4: "rgb(5,148,255)", C5: "rgb(0,125,218)", C6: "rgb(0,112,192)",
  I1: "rgb(254,168,255)", I2: "rgb(255,115,223)", I3: "rgb(169,0,230)",
  P1: "rgb(1,127,63)", P2: "rgb(0,205,52)", P3: "rgb(151,219,242)",
  S1: "rgb(230,0,0)", S2: "rgb(255,127,127)", S3: "rgb(215,176,158)",
  U1: "rgb(178,178,178)", U2: "rgb(220,218,210)",
};
const FAMILY_OF = { R: "Residential", C: "Commercial", I: "Industry", P: "Parks", S: "Institutional", U: "Reserve" };
const FAMILIES = ["All", "Residential", "Commercial", "Industry", "Parks", "Institutional", "Reserve"];
const FAMILY_DOT = {
  Residential: ZONE_COLORS.R3, Commercial: ZONE_COLORS.C4, Industry: ZONE_COLORS.I1,
  Parks: ZONE_COLORS.P2, Institutional: ZONE_COLORS.S1, Reserve: ZONE_COLORS.U1,
};

function zoneCode(sym) {
  if (!sym) return "";
  const m = String(sym).trim().match(/^([A-Za-z]+\d*)/);
  return m ? m[1].toUpperCase() : "";
}
function zoneColor(sym) { return ZONE_COLORS[zoneCode(sym)] || "#CFCABB"; }
function zoneFamily(sym) {
  const c = zoneCode(sym);
  if (/vacant/i.test(sym || "")) return /res/i.test(sym) ? "Residential" : "Commercial";
  return FAMILY_OF[c.charAt(0)] || "Reserve";
}

/* ---------------- geometry (offline, from the plotcoord field) ---------------- */
// plotcoord looks like "E,N;E,N;E,N;..." in UTM Zone 44N. We reproject to
// lat/lng with proj4 (loaded from CDN) so map highlighting works with no live
// connection. If proj4 is missing or points fall outside Amaravati, we return
// null and the caller falls back to the live service.
let _projReady = false;
function ensureProj() {
  if (_projReady) return true;
  if (typeof proj4 === "undefined") return false;
  try { proj4.defs("APCRDA_UTM", CONFIG.UTM_PROJ); _projReady = true; return true; }
  catch (_) { return false; }
}
function parsePlotCoord(str) {
  if (!str) return null;
  const pts = [];
  for (const pair of String(str).split(";")) {
    const c = pair.split(",");
    if (c.length < 2) continue;
    const e = parseFloat(c[0]), n = parseFloat(c[1]);
    if (Number.isFinite(e) && Number.isFinite(n)) pts.push([e, n]);
  }
  return pts.length ? pts : null;
}
function plotLatLngs(rec) {
  if (!rec || !ensureProj()) return null;
  // geometry lives inline (old-style snapshot) or in a per-village shard (new)
  const src = rec.coord || state.geoCache.get(rec.id) || "";
  if (!src) return null;
  const pts = parsePlotCoord(src);
  if (!pts || pts.length < 3) return null;
  const [latLo, latHi] = CONFIG.LAT_RANGE, [lngLo, lngHi] = CONFIG.LNG_RANGE;
  const out = [];
  for (const [e, n] of pts) {
    let lon, lat;
    try { [lon, lat] = proj4("APCRDA_UTM", "WGS84", [e, n]); } catch (_) { return null; }
    if (lat < latLo || lat > latHi || lon < lngLo || lon > lngHi) return null; // wrong projection / bad point
    out.push([lat, lon]);
  }
  return out.length >= 3 ? out : null;
}

// Must match the fetch script's slug() exactly.
function villageSlug(v) {
  return String(v || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}
// Fetch a village's geometry shard once; concurrent callers share the promise.
function loadGeo(village) {
  const s = villageSlug(village);
  if (state.geoLoads.has(s)) return state.geoLoads.get(s);
  const pr = fetch("data/geo/" + s + ".json" + (state.snapVersion ? "?v=" + encodeURIComponent(state.snapVersion) : ""))
    .then((r) => { if (!r.ok) throw new Error("no shard"); return r.json(); })
    .then((j) => {
      const m = (j && j.plots) || {};
      for (const k in m) if (!state.geoCache.has(k)) state.geoCache.set(k, m[k]);
      return true;
    })
    .catch(() => false); // shard absent (old snapshot) — inline coords cover it
  state.geoLoads.set(s, pr);
  return pr;
}
function highlightLocal(rec, fit) {
  const ll = plotLatLngs(rec);
  if (!ll) return false;
  highlight.clearLayers();
  const poly = L.polygon(ll, HL_STYLE).addTo(highlight);
  if (fit) { try { map.fitBounds(poly.getBounds().pad(0.6), { maxZoom: 19 }); } catch (_) {} }
  return true;
}

/* ---------------- owner-name helpers ---------------- */
function ownerKey(name) { return String(name || "").trim().toUpperCase().replace(/\s+/g, " "); }
// a plot's allottee field may list several co-owners separated by commas
function ownerNames(rec) {
  if (!rec || !rec.farmer) return [];
  return [...new Set(rec.farmer.split(",").map(ownerKey).filter(Boolean))];
}
function primaryOwner(rec) { const ns = ownerNames(rec); return ns.length ? ns[0] : ""; }
function ownerPlots(name) { return state.byOwner.get(ownerKey(name)) || []; }
// APCRDA, government and similar hold thousands of reserve/road parcels and
// aren't real allottees to browse — don't offer an owner view for them.
function isInstitutionalOwner(name) {
  return /\b(APCRDA|CRDA|GOVT|GOVERNMENT|AUTHORITY|MUNICIPAL|CORPORATION|PANCHAYAT|NARL|VACANT|RESERVE|ROAD)\b/i.test(name || "");
}

/* ---------------- tiny helpers ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "—").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (n) => (typeof n === "number" ? n.toLocaleString("en-IN") : esc(n));
const proxied = (u) => (CONFIG.PROXY ? CONFIG.PROXY.replace(/\/$/, "") + "/?" + u : u);
const esriOpts = (o) => Object.assign({}, o, CONFIG.PROXY ? { proxy: CONFIG.PROXY.replace(/\/$/, "") + "/", useCors: false } : {});

/* ---------------- state ---------------- */
const state = {
  plots: [],            // normalized snapshot records
  byCode: new Map(),
  byReg: new Map(),     // regcode -> record (for boundary walking)
  byOwner: new Map(),   // normalized allottee name -> [records]
  filtered: [],
  filters: { q: "", village: "All villages", family: "All" },
  sort: { key: "no", dir: 1 },
  live: false,
  snapshotDate: null,
  selectedCode: null,
  mode: "plot",         // "plot" | "owner"
  owner: null,
  dupCount: 0,
  geoCache: new Map(),  // plot id -> outline string, filled per village on demand
  geoLoads: new Map(),  // village slug -> in-flight/settled fetch promise
  snapVersion: "",      // snapshot timestamp, used to version shard requests
};

/* ---------------- map ---------------- */
const map = L.map("map", { zoomControl: true }).setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);
L.control.scale({ imperial: false }).addTo(map);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 21, maxNativeZoom: 19,
  attribution: "© OpenStreetMap contributors",
}).addTo(map);

const lpsLayer = L.esri.dynamicMapLayer(esriOpts({ url: CONFIG.SERVICE, opacity: 0.85 })).addTo(map);
const highlight = L.layerGroup().addTo(map);
const HL_STYLE = { color: "#17110C", weight: 2.5, dashArray: "7 5", fillColor: "#ffffff", fillOpacity: 0.25 };

// UI elements that sit on top of the map must not pass events through to it
L.DomEvent.disableClickPropagation($("card"));
L.DomEvent.disableScrollPropagation($("card"));
L.DomEvent.disableClickPropagation($("regtoggle"));

/* ---------------- status pill ---------------- */
function setStatus(cls, text) { const el = $("status"); el.className = cls; el.textContent = text; }
function statusLine() {
  const snap = state.snapshotDate ? " · SNAPSHOT " + state.snapshotDate.slice(0, 10) : "";
  if (state.live) setStatus("live", "LIVE" + snap);
  else if (state.plots.length) setStatus("error", "OFFLINE" + snap);
  else setStatus("error", "NO CONNECTION");
}

fetch(proxied(CONFIG.SERVICE + "?f=json"))
  .then((r) => r.json())
  .then((j) => { state.live = !!(j && (j.mapName !== undefined || j.layers)); statusLine(); if (!state.live) showLiveHelp(); })
  .catch(() => { state.live = false; statusLine(); showLiveHelp(); });

function showLiveHelp() {
  const n = $("notice");
  n.style.display = "block";
  n.innerHTML =
    "<b>Live queries are blocked from this page.</b> The register below still works from the " +
    "snapshot, but map highlighting, allottee lookup and search-by-server need a proxy: deploy " +
    "<span class='mono'>worker/cors-proxy.js</span> to Cloudflare and set <span class='mono'>CONFIG.PROXY</span> in app.js." +
    (n.textContent.includes("snapshot") ? "" : "");
}

/* ---------------- snapshot ---------------- */
function normalize(a) {
  const rawCode = (a.plot_code || "").trim();
  const rawReg = (a.regcode || "").trim();
  // plot_code is blank on ~16k plots; fall back to regcode, then a synthetic id,
  // so every plot has a stable, unique key and none get dropped from the register.
  const id = rawCode || rawReg || (a.ESRI_OID != null ? "oid-" + a.ESRI_OID : "");
  return {
    id, code: rawCode, no: a.plot_no ?? null, sym: a.symbology || "",
    village: a.lpsvillage || "—", twp: a.township, sec: a.sector, col: a.colony, blk: a.block,
    ext: a.alloted_ex ?? null, len: a.polylength, wid: a.polywidth,
    categ: a.plot_categ, reg: rawReg, regdate: a.reg_date_1 || null,
    nb: { N: (a.regcode_n || "").trim(), S: (a.regcode_s || "").trim(), E: (a.regcode_e || "").trim(), W: (a.regcode_w || "").trim() },
    farmer: (a.farmer_n || "").trim() || null,
    coord: a.plotcoord || "", // UTM polygon vertices for offline highlighting
  };
}

function ingest(list, generated) {
  const all = list.map(normalize).filter((p) => p.id);
  // APCRDA's layer stores some plots as several identical overlapping records.
  // Collapse rows that match on everything the user sees, so each real plot
  // appears once. Rows sharing a code but differing (e.g. different allottee)
  // are kept separate.
  const seen = new Map();
  let dupes = 0;
  for (const p of all) {
    const key = p.id + "|" + (p.farmer || "") + "|" + p.village + "|" + (p.no ?? "") + "|" + (p.ext ?? "");
    if (seen.has(key)) { dupes++; continue; }
    seen.set(key, p);
  }
  state.plots = [...seen.values()];
  state.dupCount = dupes;
  state.byCode = new Map();
  for (const p of state.plots) {
    if (p.code && !state.byCode.has(p.code)) state.byCode.set(p.code, p);
    state.byCode.set(p.id, p); // id is always present and unique
  }
  state.byReg = new Map();
  for (const p of state.plots) if (p.reg) state.byReg.set(p.reg, p);
  // index plots by each allottee (co-owners split on comma) for the owner view
  state.byOwner = new Map();
  for (const p of state.plots) {
    for (const nm of ownerNames(p)) {
      let arr = state.byOwner.get(nm);
      if (!arr) { arr = []; state.byOwner.set(nm, arr); }
      arr.push(p);
    }
  }
  state.snapshotDate = generated || null;
  state.snapVersion = generated || "";
  $("snapinfo").textContent = generated ? " Snapshot: " + generated.slice(0, 10) + " (refreshed nightly)." : "";
  buildVillageSelect();
  applyFilters();
  statusLine();
  applyDeepLink();
}

// Cache-friendly fetch: nightly data doesn't need a per-visit cache-bust, and
// letting the CDN cache it makes repeat visits near-instant.
fetch(CONFIG.SNAPSHOT)
  .then((r) => { if (!r.ok) throw new Error("no snapshot"); return r.json(); })
  .then((j) => {
    if (!j.plots || !j.plots.length) throw new Error("empty snapshot");
    ingest(j.plots, j.generated);
  })
  .catch(() => {
    const n = $("notice");
    n.style.display = "block";
    n.innerHTML =
      "No snapshot yet. Run the <b>Update LPS snapshot</b> workflow once from your repo's Actions tab " +
      "(it also runs nightly). <button id='sampleBtn' type='button'>Load a live sample now</button>";
    const b = $("sampleBtn");
    if (b) b.addEventListener("click", loadLiveSample);
    $("stats").textContent = "Register empty — waiting for data.";
    renderTable();
  });

function loadLiveSample() {
  $("stats").textContent = "Pulling a live sample from APCRDA…";
  L.esri.query(esriOpts({ url: CONFIG.SERVICE + "/" + CONFIG.PLOT_LAYER }))
    .where("1=1")
    .limit(1000)
    .returnGeometry(false)
    .run((err, fc) => {
      if (err || !fc || !fc.features.length) {
        $("stats").textContent = "Live sample failed — check the status pill and CONFIG.PROXY.";
        return;
      }
      $("notice").style.display = "none";
      ingest(fc.features.map((f) => f.properties), null);
    });
}

/* ---------------- filters / sort / stats ---------------- */
function buildVillageSelect() {
  const sel = $("fVillage");
  const villages = [...new Set(state.plots.map((p) => p.village).filter(Boolean))].sort();
  sel.innerHTML = "<option>All villages</option>" + villages.map((v) => `<option>${esc(v)}</option>`).join("");
  sel.value = "All villages";
}

function applyFilters() {
  const { q, village, family } = state.filters;
  const ql = q.trim().toLowerCase();
  state.filtered = state.plots.filter((p) => {
    if (village !== "All villages" && p.village !== village) return false;
    if (family !== "All" && zoneFamily(p.sym) !== family) return false;
    if (ql) {
      const hay = (p.id + " " + p.code + " " + (p.no ?? "") + " " + p.village + " " + p.sym + " " + p.reg + " " + (p.farmer || "")).toLowerCase();
      if (!hay.includes(ql)) return false;
    }
    return true;
  });
  const { key, dir } = state.sort;
  state.filtered.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });

  const totalExt = state.filtered.reduce((s, p) => s + (typeof p.ext === "number" ? p.ext : 0), 0);
  $("stats").innerHTML =
    `<b>${inr(state.filtered.length)}</b> plots` +
    (totalExt ? ` · <b>${inr(Math.round(totalExt))}</b> total extent (as recorded)` : "");
  renderTable();
}

/* family chips */
(function buildChips() {
  const box = $("fFamily");
  box.innerHTML = "";
  FAMILIES.forEach((f) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (f === "All" ? " on" : "");
    b.innerHTML = (f !== "All" ? `<span class="dot" style="background:${FAMILY_DOT[f]}"></span>` : "") + f;
    b.addEventListener("click", () => {
      state.filters.family = f;
      [...box.children].forEach((c) => c.classList.remove("on"));
      b.classList.add("on");
      applyFilters();
    });
    box.appendChild(b);
  });
})();

$("fVillage").addEventListener("change", (e) => { state.filters.village = e.target.value; applyFilters(); });

/* sortable header */
const COLS = [
  { key: "no", label: "Plot", w: "104px" },
  { key: "village", label: "Village", w: "" },
  { key: "sym", label: "Zone", w: "46px" },
  { key: "ext", label: "Extent", w: "66px", right: true },
];
(function buildHead() {
  const h = $("thead");
  h.innerHTML = "";
  COLS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.style.width = c.w || "auto";
    if (!c.w) b.style.flex = "1";
    if (c.right) b.style.justifyContent = "flex-end";
    b.dataset.key = c.key;
    b.textContent = c.label;
    b.addEventListener("click", () => {
      state.sort = { key: c.key, dir: state.sort.key === c.key ? -state.sort.dir : 1 };
      applyFilters();
    });
    h.appendChild(b);
  });
})();
function paintHead() {
  [...$("thead").children].forEach((b) => {
    const on = b.dataset.key === state.sort.key;
    b.classList.toggle("on", on);
    b.textContent = COLS.find((c) => c.key === b.dataset.key).label + (on ? (state.sort.dir === 1 ? " ↑" : " ↓") : "");
  });
}

/* ---------------- windowed table ---------------- */
const ROW_H = 46;
const tlist = $("tlist");
tlist.addEventListener("scroll", () => requestAnimationFrame(renderTable));

function renderTable() {
  paintHead();
  const rows = state.filtered;
  if (!rows.length) {
    tlist.innerHTML = `<div class="empty">No plots match. Clear a filter or shorten the search to widen the register.</div>`;
    return;
  }
  const top = tlist.scrollTop;
  const h = tlist.clientHeight || 400;
  const start = Math.max(0, Math.floor(top / ROW_H) - 6);
  const count = Math.ceil(h / ROW_H) + 12;
  const slice = rows.slice(start, start + count);

  const parts = [`<div style="height:${start * ROW_H}px"></div>`];
  for (const p of slice) {
    const sel = p.id === state.selectedCode ? " sel" : "";
    parts.push(
      `<button type="button" class="trow${sel}" data-code="${esc(p.id)}">` +
        `<span class="c-code">${esc(p.code || p.reg || "#" + p.no)}</span>` +
        `<span class="c-vil"><span class="v1">${esc(p.village)}</span>${p.farmer ? `<span class="c-name">${esc(p.farmer)}</span>` : ""}</span>` +
        `<span class="c-zone"><span class="dot" style="background:${zoneColor(p.sym)}"></span>${esc(zoneCode(p.sym) || "—")}</span>` +
        `<span class="c-ext">${p.ext != null ? inr(Math.round(p.ext)) : "—"}</span>` +
      `</button>`
    );
  }
  parts.push(`<div style="height:${Math.max(0, (rows.length - start - slice.length) * ROW_H)}px"></div>`);
  tlist.innerHTML = parts.join("");
}
tlist.addEventListener("click", (e) => {
  const b = e.target.closest(".trow");
  if (b) openPlot(b.dataset.code);
});

/* ---------------- search + suggestions ---------------- */
const qInput = $("q");
const suggest = $("suggest");

function suggestRow(p, extraMeta) {
  const meta = extraMeta || p.sym || "";
  return `<button type="button" data-code="${esc(p.id)}">` +
    `<span class="dot" style="background:${zoneColor(p.sym)}"></span>` +
    `<span class="code">${esc(p.code || p.reg || "#" + p.no)}</span>` +
    `<span class="meta">${esc(p.village)}${meta ? " · " + esc(meta) : ""}</span>` +
  `</button>`;
}

function renderLocalSuggest() {
  const ql = qInput.value.trim();
  if (!ql) { suggest.style.display = "none"; return; }
  const hits = state.filtered.slice(0, 8);
  let html = hits.map((p) => suggestRow(p, p.farmer || "")).join("");
  if (!hits.length) {
    html += `<div class="s-note">Nothing in the register matches "${esc(ql)}".</div>`;
  }
  // Allottee names live on APCRDA's server, not in the local register —
  // offer a live server search for any non-numeric query.
  if (ql.length >= 3 && !/^\d+$/.test(ql)) {
    html += state.live
      ? `<button type="button" class="s-live" id="srvBtn">Search allottee names &amp; plot codes on APCRDA server ↵</button>`
      : `<div class="s-note">Allottee name search asks the APCRDA server live — it needs the connection to be green (or a proxy in CONFIG.PROXY).</div>`;
  }
  suggest.innerHTML = html;
  suggest.style.display = "block";
  const b = $("srvBtn");
  if (b) b.addEventListener("mousedown", (e) => { e.preventDefault(); liveSearch(ql); });
}

let srvTimer = null;
let searchSeq = 0;

qInput.addEventListener("input", () => {
  state.filters.q = qInput.value;
  applyFilters();
  renderLocalSuggest();
  // Auto-search the server for names: fires after a short pause when the
  // local register (which holds no allottee names) comes up empty.
  clearTimeout(srvTimer);
  const ql = qInput.value.trim();
  if (state.live && ql.length >= 4 && !/^\d+$/.test(ql) && state.filtered.length === 0) {
    srvTimer = setTimeout(() => liveSearch(ql), 650);
  }
});
suggest.addEventListener("mousedown", (e) => {
  const b = e.target.closest("button[data-code]");
  if (b) { e.preventDefault(); suggest.style.display = "none"; openPlot(b.dataset.code); }
});
qInput.addEventListener("blur", () => setTimeout(() => (suggest.style.display = "none"), 160));
qInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const raw = qInput.value.trim();
    const exact = state.byCode.get(raw) || state.byCode.get(raw.toUpperCase());
    if (exact) { suggest.style.display = "none"; openPlot(exact.id); }
    else if (state.filtered.length) { suggest.style.display = "none"; openPlot(state.filtered[0].id); }
    else if (state.live) liveSearch(raw); // nothing local — likely a name; ask the server
  }
  if (e.key === "Escape") { qInput.blur(); suggest.style.display = "none"; }
});
window.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== qInput) { e.preventDefault(); qInput.focus(); }
  if (e.key === "Escape") closeCard();
});

/* Live server search across plot codes AND allottee names (farmer_n).
   Names are fetched per query from APCRDA's own service and never stored. */
function liveSearch(raw) {
  if (!raw || !state.live) return;
  const seq = ++searchSeq;
  const safe = raw.replace(/'/g, "''");
  const where = /^\d+$/.test(raw)
    ? `plot_no = ${parseInt(raw, 10)}`
    : `UPPER(plot_code) LIKE UPPER('%${safe}%') OR UPPER(farmer_n) LIKE UPPER('%${safe}%')`;
  suggest.innerHTML = `<div class="s-note">Searching the APCRDA server…</div>`;
  suggest.style.display = "block";
  setStatus("wait", "SEARCHING SERVER…");
  L.esri.query(esriOpts({ url: CONFIG.SERVICE + "/" + CONFIG.PLOT_LAYER }))
    .where(where)
    .fields(["plot_code", "plot_no", "symbology", "lpsvillage", "farmer_n"])
    .limit(30)
    .returnGeometry(false)
    .run((err, fc) => {
      if (seq !== searchSeq) return; // a newer search superseded this one
      statusLine();
      if (err) {
        const detail = err.message || err.code || "unknown error";
        suggest.innerHTML = `<div class="s-note">Server search failed: ${esc(detail)}</div>`;
        return;
      }
      const feats = (fc && fc.features) || [];
      if (!feats.length) {
        suggest.innerHTML = `<div class="s-note">No plot or allottee matched "${esc(raw)}" on the server. Names are usually recorded as SURNAME FIRSTNAME — try just the surname, and if that fails, try Telugu script.</div>`;
        return;
      }
      // collapse identical duplicate records the server may return
      const seen = new Set();
      const uniq = [];
      for (const f of feats) {
        const p = normalize(f.properties || {});
        const key = p.id + "|" + (p.farmer || "") + "|" + p.village;
        if (seen.has(key)) continue;
        seen.add(key);
        uniq.push(p);
      }
      const head = `<div class="s-head">FROM APCRDA SERVER · ${uniq.length}${feats.length === 30 ? "+" : ""} MATCH${uniq.length === 1 ? "" : "ES"}</div>`;
      suggest.innerHTML = head + uniq.map((p) => suggestRow(p, p.farmer || "(no name recorded)")).join("");
      suggest.style.display = "block";
    });
}

/* ---------------- live plot lookup + card ---------------- */
function openPlot(key) {
  if (!key) return;
  state.mode = "plot";
  state.owner = null;
  state.selectedCode = key;
  renderTable();
  const rec = state.byCode.get(key) || null;
  if (rec) {
    updateURL({ plot: rec.code || rec.id });
    // instant offline outline; if this village's shard isn't loaded yet,
    // fetch it in the background and draw when it arrives
    if (!highlightLocal(rec, true) && rec.village) {
      loadGeo(rec.village).then((ok) => {
        if (ok && state.mode === "plot" && state.selectedCode === key) highlightLocal(rec, true);
      });
    }
  }
  const liveCode = rec ? rec.code : key; // blank-code plots can't be queried by plot_code
  const liveReg = rec ? rec.reg : "";
  if (state.live && (liveCode || liveReg)) {
    const clause = liveCode
      ? `plot_code = '${liveCode.replace(/'/g, "''")}'`
      : `regcode = '${liveReg.replace(/'/g, "''")}'`;
    L.esri.query(esriOpts({ url: CONFIG.SERVICE + "/" + CONFIG.PLOT_LAYER }))
      .where(clause).limit(1).returnGeometry(true)
      .run((err, fc) => {
        if (state.mode !== "plot" || state.selectedCode !== key) return; // user moved on
        if (!err && fc && fc.features.length) showFeature(fc.features[0]);
        else renderCard(rec, null); // fall back to snapshot record
      });
  } else {
    renderCard(rec, null);
  }
}

function showFeature(f) {
  const rec = normalize(f.properties || {});
  const known = state.byCode.get(rec.id);
  if (known) rec.nbFromSnap = known.nb; // keep snapshot boundaries if live omits them
  state.selectedCode = rec.id;
  renderTable();
  let geom = null;
  if (f.geometry) {
    highlight.clearLayers();
    geom = L.geoJSON(f, { style: HL_STYLE }).addTo(highlight);
    try { map.fitBounds(geom.getBounds().pad(1.2), { maxZoom: 19 }); } catch (_) {}
  }
  renderCard(rec, geom);
}

function kv(k, v) { return `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`; }

// Boundary fields sometimes hold a real neighbouring plot code
// (e.g. "25-182-778-4644-31-C29") and sometimes a descriptive label
// (e.g. "U1-Reserve zone", "17.0 mtr Road", "Residential Vacant").
// Only real codes — dash-separated, a digit present, and no spaces —
// become clickable; labels render as plain text.
function looksLikeCode(t) {
  return /^[0-9A-Za-z\-\/]+$/.test(t) && t.includes("-") && /\d/.test(t);
}
function nbCell(val) {
  const t = String(val || "").trim();
  if (!t) return `<button type="button" class="nb" disabled>—</button>`;
  if (looksLikeCode(t)) {
    const target = state.byReg.get(t) || state.byCode.get(t);
    if (target) return `<button type="button" class="nb" data-goto="${esc(target.id)}" title="Open boundary plot">${esc(t)}</button>`;
  }
  return `<button type="button" class="nb nb-label" disabled>${esc(t)}</button>`;
}

function renderCard(rec, geom) {
  const card = $("card");
  if (!rec) { card.style.display = "none"; return; }
  const nb = rec.nb && (rec.nb.N || rec.nb.S || rec.nb.E || rec.nb.W) ? rec.nb : (rec.nbFromSnap || rec.nb || {});
  const zc = zoneColor(rec.sym);
  card.innerHTML =
    `<button type="button" class="close" aria-label="Close">✕</button>` +
    `<div class="eyebrow">RETURNABLE PLOT</div>` +
    `<h2>${esc(rec.code || rec.reg || "#" + rec.no)}</h2>` +
    (rec.sym ? `<span class="zonechip" style="background:${zc}">${esc(rec.sym)}</span>` : "") +
    `<div class="sect">` +
      kv("Village", esc(rec.village)) +
      (rec.no != null ? kv("Plot number", esc(rec.no)) : "") +
      kv("Township / Sector / Block", `${esc(rec.twp ?? "—")} / ${esc(rec.sec ?? "—")} / ${esc(rec.blk ?? "—")}`) +
      (rec.ext != null ? kv("Extent (as recorded)", inr(rec.ext)) : "") +
      (rec.len || rec.wid ? kv("Dimensions", `${esc(rec.wid ?? "?")} × ${esc(rec.len ?? "?")}`) : "") +
      (rec.categ ? kv("Category", esc(rec.categ)) : "") +
      (rec.reg ? kv("Registration code", `<span class="mono">${esc(rec.reg)}</span>`) : "") +
      (rec.regdate ? kv("Registration date", esc(rec.regdate)) : "") +
      kv("Allottee", rec.farmer ? esc(rec.farmer) : (state.live ? "—" : "<i>needs live connection</i>")) +
    `</div>` +
    ownerLineHtml(rec) +
    `<div class="sect">` +
      `<div class="eyebrow">BOUNDARIES — TAP TO WALK</div>` +
      `<div class="compass">` +
        `<div></div>${nbCell(nb.N)}<div></div>` +
        `${nbCell(nb.W)}<div class="mid" style="background:${zc}">№ ${esc(rec.no ?? "")}</div>${nbCell(nb.E)}` +
        `<div></div>${nbCell(nb.S)}<div></div>` +
      `</div>` +
    `</div>` +
    `<div class="actions">` +
      `<button type="button" class="primary" id="actZoom">Zoom to plot</button>` +
      `<button type="button" class="ghost" id="actShare">Share</button>` +
      `<button type="button" class="ghost" id="actCopy">Copy code</button>` +
    `</div>` +
    (state.live ? "" : `<div id="livehint">Live details resume when APCRDA is reachable; the plot outline above is from the saved snapshot.</div>`);
  card.style.display = "block";

  card.querySelector(".close").addEventListener("click", closeCard);
  card.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => openPlot(b.dataset.goto)));
  const ownerBtn = card.querySelector("#ownerLink");
  if (ownerBtn) ownerBtn.addEventListener("click", () => openOwner(ownerBtn.dataset.owner));
  $("actZoom").addEventListener("click", () => {
    if (geom) { try { map.fitBounds(geom.getBounds().pad(0.8), { maxZoom: 20 }); } catch (_) {} }
    else if (!highlightLocal(rec, true) && state.live && rec.id) openPlot(rec.id);
  });
  $("actShare").addEventListener("click", () => copyShare($("actShare"), { plot: rec.code || rec.id }));
  $("actCopy").addEventListener("click", async () => {
    const text = rec.code || rec.reg || String(rec.no ?? "");
    try { await navigator.clipboard.writeText(text); } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (_) {}
      document.body.removeChild(ta);
    }
    $("actCopy").textContent = "Copied";
    setTimeout(() => { const b = $("actCopy"); if (b) b.textContent = "Copy code"; }, 1400);
  });
}

/* ---------------- owner view: all plots held by one allottee ---------------- */
function ownerLineHtml(rec) {
  const name = primaryOwner(rec);
  if (!name || isInstitutionalOwner(name)) return "";
  const n = ownerPlots(name).length;
  if (n <= 1) return "";
  return `<div class="ownerbar"><span>This owner holds <b>${n}</b> plots</span>` +
    `<button type="button" id="ownerLink" data-owner="${esc(name)}">View all →</button></div>`;
}

function openOwner(name) {
  const key = ownerKey(name);
  const plots = ownerPlots(key);
  if (!plots.length) return;
  state.mode = "owner";
  state.owner = key;
  state.selectedCode = null;
  if (window.matchMedia("(max-width: 880px)").matches) {
    $("aside").classList.add("hidden");
    $("regtoggle").textContent = "REGISTER";
    setTimeout(() => map.invalidateSize(), 60);
  }
  updateURL({ owner: key });
  renderTable();

  // make sure geometry for every involved village is available first
  const shardVillages = [...new Set(plots.map((p) => p.village))];
  Promise.all(shardVillages.map(loadGeo)).then(() => {
  if (state.mode !== "owner" || state.owner !== key) return; // user moved on

  // highlight every plot we can place offline; fit map to them
  highlight.clearLayers();
  const bounds = [];
  let placed = 0;
  const MAX_DRAW = 400; // keep the map responsive for very large holders
  for (const p of plots) {
    if (placed >= MAX_DRAW) break;
    const ll = plotLatLngs(p);
    if (!ll) continue;
    const poly = L.polygon(ll, HL_STYLE).addTo(highlight);
    poly.on("click", () => openPlot(p.id));
    bounds.push(poly.getBounds());
    placed++;
  }
  if (bounds.length) {
    let b = bounds[0];
    for (let i = 1; i < bounds.length; i++) b = b.extend(bounds[i]);
    try { map.fitBounds(b.pad(0.3), { maxZoom: 18 }); } catch (_) {}
  }

  const totalExt = plots.reduce((s, p) => s + (typeof p.ext === "number" ? p.ext : 0), 0);
  const villages = [...new Set(plots.map((p) => p.village).filter((v) => v && v !== "—"))];
  const rows = plots.map((p) =>
    `<button type="button" class="ownerplot" data-code="${esc(p.id)}">` +
      `<span class="dot" style="background:${zoneColor(p.sym)}"></span>` +
      `<span class="op-code">${esc(p.code || p.reg || "#" + p.no)}</span>` +
      `<span class="op-vil">${esc(p.village)}</span>` +
      `<span class="op-ext">${p.ext != null ? inr(Math.round(p.ext)) : "—"}</span>` +
    `</button>`).join("");

  const card = $("card");
  card.innerHTML =
    `<button type="button" class="close" aria-label="Close">✕</button>` +
    `<div class="eyebrow">ALLOTTEE</div>` +
    `<h2 style="font-family:'IBM Plex Sans',sans-serif;font-size:18px;">${esc(name)}</h2>` +
    `<div class="sect">` +
      kv("Plots held", `<b>${plots.length}</b>`) +
      (totalExt ? kv("Total extent (as recorded)", inr(Math.round(totalExt))) : "") +
      kv("Villages", esc(villages.join(", ") || "—")) +
      (placed < plots.length ? kv("Shown on map", `${placed} of ${plots.length}`) : "") +
    `</div>` +
    `<div class="sect">` +
      `<div class="eyebrow">ALL PLOTS — TAP TO OPEN</div>` +
      `<div class="ownerlist">${rows}</div>` +
    `</div>` +
    `<div class="actions">` +
      `<button type="button" class="primary" id="ownerShare">Share this list</button>` +
    `</div>`;
  card.style.display = "block";
  card.querySelector(".close").addEventListener("click", closeCard);
  card.querySelectorAll(".ownerplot").forEach((b) => b.addEventListener("click", () => openPlot(b.dataset.code)));
  $("ownerShare").addEventListener("click", () => copyShare($("ownerShare"), { owner: key }));
  }); // end shard-load wrapper
}

/* ---------------- share links ---------------- */
function shareURL(params) {
  const qs = new URLSearchParams(params).toString();
  return location.origin + location.pathname + (qs ? "?" + qs : "");
}
function updateURL(params) {
  try { history.replaceState(null, "", params ? "?" + new URLSearchParams(params).toString() : location.pathname); } catch (_) {}
}
async function copyShare(btn, params) {
  const url = shareURL(params);
  try { await navigator.clipboard.writeText(url); } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = url; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta);
  }
  const old = btn.textContent;
  btn.textContent = "Link copied ✓";
  setTimeout(() => { btn.textContent = old; }, 1500);
}
function applyDeepLink() {
  const sp = new URLSearchParams(location.search);
  const plot = sp.get("plot");
  const owner = sp.get("owner");
  if (plot) {
    const rec = state.byCode.get(plot) || state.byCode.get(plot.toUpperCase());
    if (rec) openPlot(rec.id);
  } else if (owner) {
    openOwner(owner);
  }
}

function closeCard() {
  $("card").style.display = "none";
  state.selectedCode = null;
  state.mode = "plot";
  state.owner = null;
  highlight.clearLayers();
  updateURL(null);
  renderTable();
}

/* ---------------- identify on map click ---------------- */
map.on("click", (e) => {
  if (!state.live) return;
  L.esri.identifyFeatures(esriOpts({ url: CONFIG.SERVICE }))
    .on(map).at(e.latlng)
    .layers("visible")
    .tolerance(3)
    .run((err, fc) => {
      if (err || !fc || !fc.features.length) return;
      const f = fc.features.find((x) => x.properties && x.properties.plot_code) || fc.features[0];
      showFeature(f);
    });
});

/* ---------------- mobile register toggle ---------------- */
$("regtoggle").addEventListener("click", () => {
  const a = $("aside");
  a.classList.toggle("hidden");
  $("regtoggle").textContent = a.classList.contains("hidden") ? "REGISTER" : "HIDE REGISTER";
  setTimeout(() => map.invalidateSize(), 60);
});
if (window.matchMedia("(max-width: 880px)").matches) {
  $("aside").classList.add("hidden");
}
window.addEventListener("resize", () => map.invalidateSize());
