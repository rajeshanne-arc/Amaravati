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

/* ---------------- language (English / Telugu) ---------------- */
const I18N = {
  en: {
    subtitle: "Returnable plot register · unofficial viewer on APCRDA GIS",
    searchPh: "Plot code, number or allottee name…  ( / )",
    allVillages: "All villages",
    famAll: "All", famResidential: "Residential", famCommercial: "Commercial", famIndustry: "Industry",
    famParks: "Parks", famInstitutional: "Institutional", famReserve: "Reserve",
    plotsWord: "plots", totalExtent: "total extent (as recorded)",
    colPlot: "Plot", colVillage: "Village", colZone: "Zone", colExtent: "Extent",
    noMatch: "No plots match. Clear a filter or shorten the search to widen the register.",
    loadingReg: "Loading register…",
    returnable: "RETURNABLE PLOT",
    lVillage: "Village", lPlotNo: "Plot number", lTSB: "Township / Sector / Block",
    lExtent: "Extent (as recorded)", lDims: "Dimensions", lCategory: "Category",
    lRegCode: "Registration code", lRegDate: "Registration date", lAllottee: "Allottee",
    needsLive: "needs live connection",
    boundaries: "BOUNDARIES — TAP TO WALK",
    zoom: "Zoom to plot", share: "Share", copy: "Copy code", copied: "Copied", linkCopied: "Link copied ✓",
    ownerHolds: "This owner holds <b>{n}</b> plots", viewAll: "View all →",
    eAllottee: "ALLOTTEE", plotsHeld: "Plots held", lVillages: "Villages", shownOnMap: "Shown on map",
    allPlots: "ALL PLOTS — TAP TO OPEN", shareList: "Share this list",
    history: "HISTORY — PERMANENT RECORD", noHistory: "No changes recorded since tracking began on",
    hFarmer: "Allottee", hZone: "Zone", hExtent: "Extent", hRegDate: "Registration date", hRegCode: "Registration code",
    nothingLocal: 'Nothing in the register matches "{q}".',
    searchSrv: "Search allottee names & plot codes on APCRDA server ↵",
    needsGreen: "Allottee name search asks the APCRDA server live — it needs the connection to be green (or a proxy in CONFIG.PROXY).",
    searching: "Searching the APCRDA server…",
    srvFail: "Server search failed: {d}",
    srvNone: 'No plot or allottee matched "{q}" on the server. Names are usually recorded as SURNAME FIRSTNAME — try just the surname, and if that fails, try Telugu script.',
    fromSrv: "FROM APCRDA SERVER",
    register: "REGISTER", hideRegister: "HIDE REGISTER",
    livehint: "Live details resume when APCRDA is reachable; the plot outline above is from the saved snapshot.",
    snapshotLbl: "Snapshot", refreshed: "(refreshed nightly).",
    footer: 'Unofficial viewer. Not a land record — verify every plot at <a href="https://gis.apcrda.org/lps/index.html" target="_blank" rel="noopener">gis.apcrda.org/lps</a> · Plot data © APCRDA · Basemap © OpenStreetMap contributors · <a href="about.html">About & data policy</a>.',
    welcomeTitle: "Find your plot", welcomeBody: "Search by your name, plot code or number — or tap the GPS button while standing on your land.", welcomeBtn: "Start searching",
    satellite: "Satellite view", mapViewT: "Map view",
    gpsTitle: "Which plot am I standing on?", gpsLocating: "Finding your location…", gpsNoFix: "Couldn't get your location — allow location access and try again.", gpsOutside: "You don't appear to be inside the LPS plotted area.", gpsNoPlot: "You're inside the LPS area, but not on a recorded plot.", gpsNeedData: "GPS lookup needs the latest data — run the Update LPS snapshot action once.",
    myPlots: "My plots", myPlotsEmpty: "No saved plots yet — open a plot and tap ☆ to save it.", saveT: "Save this plot", savedT: "Saved — tap to remove",
    printRec: "Print record",
    recentChanges: "Recent changes", feedTitle: "RECENT CHANGES — ALL PLOTS", feedEmpty: "No changes recorded yet. The nightly comparison will list ownership, zone and registration changes here, permanently.",
    errToast: "Something went wrong — please refresh the page.",
  },
  te: {
    subtitle: "రిటర్నబుల్ ప్లాట్ రిజిస్టర్ · APCRDA GIS ఆధారిత అనధికారిక వ్యూయర్",
    searchPh: "ప్లాట్ కోడ్, నంబర్ లేదా కేటాయింపుదారు పేరు…",
    allVillages: "అన్ని గ్రామాలు",
    famAll: "అన్నీ", famResidential: "నివాస", famCommercial: "వాణిజ్య", famIndustry: "పరిశ్రమ",
    famParks: "పార్కులు", famInstitutional: "సంస్థాగత", famReserve: "రిజర్వ్",
    plotsWord: "ప్లాట్లు", totalExtent: "మొత్తం విస్తీర్ణం (నమోదైనది)",
    colPlot: "ప్లాట్", colVillage: "గ్రామం", colZone: "జోన్", colExtent: "విస్తీర్ణం",
    noMatch: "ఏ ప్లాట్లూ సరిపోలలేదు. ఫిల్టర్ తీసేయండి లేదా శోధనను చిన్నదిగా చేయండి.",
    loadingReg: "రిజిస్టర్ లోడ్ అవుతోంది…",
    returnable: "రిటర్నబుల్ ప్లాట్",
    lVillage: "గ్రామం", lPlotNo: "ప్లాట్ నంబర్", lTSB: "టౌన్‌షిప్ / సెక్టార్ / బ్లాక్",
    lExtent: "విస్తీర్ణం (నమోదైనది)", lDims: "కొలతలు", lCategory: "వర్గం",
    lRegCode: "రిజిస్ట్రేషన్ కోడ్", lRegDate: "రిజిస్ట్రేషన్ తేదీ", lAllottee: "కేటాయింపుదారు",
    needsLive: "లైవ్ కనెక్షన్ అవసరం",
    boundaries: "సరిహద్దులు — తెరవడానికి నొక్కండి",
    zoom: "ప్లాట్‌కు జూమ్", share: "షేర్", copy: "కోడ్ కాపీ", copied: "కాపీ అయింది", linkCopied: "లింక్ కాపీ అయింది ✓",
    ownerHolds: "ఈ యజమానికి <b>{n}</b> ప్లాట్లు ఉన్నాయి", viewAll: "అన్నీ చూడండి →",
    eAllottee: "కేటాయింపుదారు", plotsHeld: "ప్లాట్ల సంఖ్య", lVillages: "గ్రామాలు", shownOnMap: "మ్యాప్‌లో చూపినవి",
    allPlots: "అన్ని ప్లాట్లు — తెరవడానికి నొక్కండి", shareList: "ఈ జాబితాను షేర్ చేయండి",
    history: "చరిత్ర — శాశ్వత రికార్డు", noHistory: "ట్రాకింగ్ ప్రారంభమైనప్పటి నుండి మార్పులు నమోదు కాలేదు —",
    hFarmer: "కేటాయింపుదారు", hZone: "జోన్", hExtent: "విస్తీర్ణం", hRegDate: "రిజిస్ట్రేషన్ తేదీ", hRegCode: "రిజిస్ట్రేషన్ కోడ్",
    nothingLocal: 'రిజిస్టర్‌లో "{q}" కు సరిపోలినవి లేవు.',
    searchSrv: "APCRDA సర్వర్‌లో పేర్లు & ప్లాట్ కోడ్‌లు వెతకండి ↵",
    needsGreen: "పేరు శోధనకు లైవ్ కనెక్షన్ (పచ్చ గుర్తు) అవసరం.",
    searching: "APCRDA సర్వర్‌లో వెతుకుతోంది…",
    srvFail: "సర్వర్ శోధన విఫలమైంది: {d}",
    srvNone: 'సర్వర్‌లో "{q}" కు సరిపోలిన ప్లాట్ లేదా కేటాయింపుదారు లేరు. పేర్లు సాధారణంగా ఇంటిపేరుతో మొదలవుతాయి — ఇంటిపేరుతో ప్రయత్నించండి.',
    fromSrv: "APCRDA సర్వర్ నుండి",
    register: "రిజిస్టర్", hideRegister: "రిజిస్టర్ దాచు",
    livehint: "APCRDA అందుబాటులోకి వచ్చాక తాజా వివరాలు వస్తాయి; పై అవుట్‌లైన్ సేవ్ చేసిన స్నాప్‌షాట్ నుండి.",
    snapshotLbl: "స్నాప్‌షాట్", refreshed: "(ప్రతి రాత్రి రిఫ్రెష్).",
    footer: 'అనధికారిక వ్యూయర్. ఇది భూమి రికార్డు కాదు — ప్రతి ప్లాట్‌ను <a href="https://gis.apcrda.org/lps/index.html" target="_blank" rel="noopener">gis.apcrda.org/lps</a> లో ధృవీకరించండి · డేటా © APCRDA · బేస్‌మ్యాప్ © OpenStreetMap · <a href="about.html">వివరాలు & డేటా విధానం</a>.',
    welcomeTitle: "మీ ప్లాట్ కనుగొనండి", welcomeBody: "మీ పేరు, ప్లాట్ కోడ్ లేదా నంబర్‌తో వెతకండి — లేదా మీ భూమిపై నిలబడి GPS బటన్ నొక్కండి.", welcomeBtn: "వెతకడం ప్రారంభించండి",
    satellite: "శాటిలైట్ వ్యూ", mapViewT: "మ్యాప్ వ్యూ",
    gpsTitle: "నేను ఏ ప్లాట్‌పై నిలబడి ఉన్నాను?", gpsLocating: "మీ స్థానం కనుగొంటోంది…", gpsNoFix: "స్థానం లభించలేదు — లొకేషన్ అనుమతి ఇచ్చి మళ్లీ ప్రయత్నించండి.", gpsOutside: "మీరు LPS ప్లాట్ ప్రాంతంలో లేనట్లు కనిపిస్తోంది.", gpsNoPlot: "మీరు LPS ప్రాంతంలో ఉన్నారు, కానీ నమోదైన ప్లాట్‌పై లేరు.", gpsNeedData: "GPS శోధనకు తాజా డేటా అవసరం — Update LPS snapshot ఒకసారి రన్ చేయండి.",
    myPlots: "నా ప్లాట్లు", myPlotsEmpty: "సేవ్ చేసిన ప్లాట్లు లేవు — ప్లాట్ తెరిచి ☆ నొక్కండి.", saveT: "ఈ ప్లాట్ సేవ్ చేయండి", savedT: "సేవ్ అయింది — తీసేయడానికి నొక్కండి",
    printRec: "రికార్డు ప్రింట్",
    recentChanges: "ఇటీవలి మార్పులు", feedTitle: "ఇటీవలి మార్పులు — అన్ని ప్లాట్లు", feedEmpty: "ఇంకా మార్పులు నమోదు కాలేదు. రాత్రి పోలిక ద్వారా యాజమాన్య, జోన్, రిజిస్ట్రేషన్ మార్పులు ఇక్కడ శాశ్వతంగా కనిపిస్తాయి.",
    errToast: "ఏదో తప్పు జరిగింది — దయచేసి పేజీని రిఫ్రెష్ చేయండి.",
  },
};
let LANG = "en";
try { const s = localStorage.getItem("lps-lang"); if (s === "te" || s === "en") LANG = s; } catch (_) {}
const t = (k) => (I18N[LANG] && I18N[LANG][k]) || I18N.en[k] || k;
const tf = (k, vars) => t(k).replace(/\{(\w+)\}/g, (_, v) => (vars && vars[v] != null ? vars[v] : ""));

/* ---------------- state ---------------- */
const state = {
  plots: [],            // normalized snapshot records
  byCode: new Map(),
  byReg: new Map(),     // regcode -> record (for boundary walking)
  byOwner: new Map(),   // normalized allottee name -> [records]
  filtered: [],
  filters: { q: "", village: "__ALL__", family: "All", minExt: null },
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
  changes: null,        // permanent change log: { map: id -> [entries], since }
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
const OWNER_STYLE = { color: "#C0392B", weight: 3, fillColor: "#C0392B", fillOpacity: 0.35 };

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
  const all = list.map(normalize).filter((p) => p.id)
    // zone-coverage records (village planning areas, reserves, roads — blank
    // code, plot number 0 or below) aren't plots; keep them out of the
    // register, stats, search and owner index entirely
    .filter((p) => p.code || (p.reg && Number(p.no) > 0));
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
  $("snapinfo").textContent = generated ? " " + t("snapshotLbl") + ": " + generated.slice(0, 10) + " " + t("refreshed") : "";
  state.villageNames = [...new Set(state.plots.map((p) => p.village).filter((v) => v && v !== "\u2014"))];
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
    state.villageBounds = j.villageBounds || null;
    ingest(j.plots, j.generated);
    loadChanges();
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
  const keep = state.filters.village;
  const villages = [...new Set(state.plots.map((p) => p.village).filter(Boolean))].sort();
  sel.innerHTML = `<option value="__ALL__">${esc(t("allVillages"))}</option>` +
    villages.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  sel.value = villages.includes(keep) ? keep : "__ALL__";
  state.filters.village = sel.value;
}

function applyFilters() {
  const { q, village, family, minExt } = state.filters;
  const ql = q.trim().toLowerCase();
  state.filtered = state.plots.filter((p) => {
    if (village !== "__ALL__" && p.village !== village) return false;
    if (family !== "All" && zoneFamily(p.sym) !== family) return false;
    if (minExt != null && !(typeof p.ext === "number" && p.ext >= minExt)) return false;
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
    `<b>${inr(state.filtered.length)}</b> ${t("plotsWord")}` +
    (totalExt ? ` · <b>${inr(Math.round(totalExt))}</b> ${t("totalExtent")}` : "");
  renderTable();
}

/* family chips (rebuilt on language change) */
function buildChips() {
  const box = $("fFamily");
  box.innerHTML = "";
  FAMILIES.forEach((f) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (state.filters.family === f ? " on" : "");
    b.innerHTML = (f !== "All" ? `<span class="dot" style="background:${FAMILY_DOT[f]}"></span>` : "") + esc(t("fam" + f));
    b.addEventListener("click", () => {
      state.filters.family = f;
      [...box.children].forEach((c) => c.classList.remove("on"));
      b.classList.add("on");
      applyFilters();
    });
    box.appendChild(b);
  });
}
buildChips();

$("fVillage").addEventListener("change", (e) => { state.filters.village = e.target.value; applyFilters(); });

/* sortable header (labels resolved through t() so language switches apply) */
const COLS = [
  { key: "no", labelKey: "colPlot", w: "104px" },
  { key: "village", labelKey: "colVillage", w: "" },
  { key: "sym", labelKey: "colZone", w: "46px" },
  { key: "ext", labelKey: "colExtent", w: "66px", right: true },
];
function buildHead() {
  const h = $("thead");
  h.innerHTML = "";
  COLS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.style.width = c.w || "auto";
    if (!c.w) b.style.flex = "1";
    if (c.right) b.style.justifyContent = "flex-end";
    b.dataset.key = c.key;
    b.textContent = t(c.labelKey);
    b.addEventListener("click", () => {
      state.sort = { key: c.key, dir: state.sort.key === c.key ? -state.sort.dir : 1 };
      applyFilters();
    });
    h.appendChild(b);
  });
}
buildHead();
function paintHead() {
  [...$("thead").children].forEach((b) => {
    const on = b.dataset.key === state.sort.key;
    b.classList.toggle("on", on);
    b.textContent = t(COLS.find((c) => c.key === b.dataset.key).labelKey) + (on ? (state.sort.dir === 1 ? " ↑" : " ↓") : "");
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
    tlist.innerHTML = `<div class="empty">${esc(t("noMatch"))}</div>`;
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
    html += `<div class="s-note">${tf("nothingLocal", { q: esc(ql) })}</div>`;
  }
  // Allottee names live on APCRDA's server, not in the local register —
  // offer a live server search for any non-numeric query.
  if (ql.length >= 3 && !/^\d+$/.test(ql)) {
    html += state.live
      ? `<button type="button" class="s-live" id="srvBtn">${esc(t("searchSrv"))}</button>`
      : `<div class="s-note">${esc(t("needsGreen"))}</div>`;
  }
  suggest.innerHTML = html;
  suggest.style.display = "block";
  const b = $("srvBtn");
  if (b) b.addEventListener("mousedown", (e) => { e.preventDefault(); liveSearch(ql); });
}

/* smart search: turn natural phrasing into filters — the honest, free
   cousin of a RAG chatbot for structured records */
const ZONE_WORDS = {
  residential: "Residential", "\u0c28\u0c3f\u0c35\u0c3e\u0c38": "Residential",
  commercial: "Commercial", "\u0c35\u0c3e\u0c23\u0c3f\u0c1c\u0c4d\u0c2f": "Commercial",
  industry: "Industry", industrial: "Industry",
  park: "Parks", parks: "Parks",
  government: "Institutional", school: "Institutional", education: "Institutional",
  reserve: "Reserve",
};
function smartParse(raw) {
  let rest = " " + raw.toLowerCase() + " ";
  const out = { village: null, family: null, minExt: null };
  // village names from the loaded data
  for (const v of state.villageNames || []) {
    const needle = " " + v.toLowerCase() + " ";
    if (rest.includes(needle)) { out.village = v; rest = rest.replace(needle, " "); break; }
  }
  for (const w in ZONE_WORDS) {
    if (rest.includes(" " + w)) { out.family = ZONE_WORDS[w]; rest = rest.replace(w, " "); break; }
  }
  const m = rest.match(/(?:above|over|more than|>|\u0c15\u0c02\u0c1f\u0c47 \u0c0e\u0c15\u0c4d\u0c15\u0c41\u0c35)\s*(\d+)/);
  if (m) { out.minExt = parseInt(m[1], 10); rest = rest.replace(m[0], " "); }
  out.rest = rest.replace(/\b(in|plots?|of|the)\b/g, " ").replace(/\s+/g, " ").trim();
  out.structured = !!(out.village || out.family || out.minExt != null);
  return out;
}

let srvTimer = null;
let searchSeq = 0;

qInput.addEventListener("input", () => {
  const sp = smartParse(qInput.value);
  if (sp.structured) {
    state.filters.village = sp.village || "__ALL__";
    state.filters.family = sp.family || "All";
    state.filters.minExt = sp.minExt;
    state.filters.q = sp.rest;
    $("fVillage").value = state.filters.village;
    buildChips(); // repaint active family chip
  } else {
    state.filters.minExt = null;
    state.filters.q = qInput.value;
  }
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
  suggest.innerHTML = `<div class="s-note">${esc(t("searching"))}</div>`;
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
        suggest.innerHTML = `<div class="s-note">${tf("srvFail", { d: esc(detail) })}</div>`;
        return;
      }
      const feats = (fc && fc.features) || [];
      if (!feats.length) {
        suggest.innerHTML = `<div class="s-note">${tf("srvNone", { q: esc(raw) })}</div>`;
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
      const head = `<div class="s-head">${esc(t("fromSrv"))} · ${uniq.length}${feats.length === 30 ? "+" : ""}</div>`;
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
  // final safety net: zone-coverage records (blank code, plot_no 0) hijack
  // the view with village-sized polygons — refuse to display them
  if (!rec.code && !(rec.reg && Number(rec.no) > 0)) return;
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

/* ---------------- permanent change history ---------------- */
// data/changes.json is an append-only log the nightly job writes: every
// ownership / zone / extent / registration change, kept forever (and doubly
// preserved by git history). Loaded lazily; the card shows a plot's entries.
function loadChanges() {
  fetch("data/changes.json" + (state.snapVersion ? "?v=" + encodeURIComponent(state.snapVersion) : ""))
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j || !Array.isArray(j.changes)) return;
      const m = new Map();
      for (const c of j.changes) {
        let a = m.get(c.id);
        if (!a) { a = []; m.set(c.id, a); }
        a.push(c);
      }
      state.changes = { map: m, since: (j.since || "").slice(0, 10), raw: j.changes };
      const fb = $("feedbtn");
      if (fb) { fb.style.display = "inline-block"; fb.textContent = t("recentChanges") + " (" + j.changes.length + ") \u2192"; }
      // refresh an open plot card so its history appears
      if (state.mode === "plot" && state.selectedCode) {
        const r = state.byCode.get(state.selectedCode);
        if (r) renderCard(r, null);
      }
    })
    .catch(() => {});
}

const HIST_LABEL_KEYS = { farmer_n: "hFarmer", symbology: "hZone", alloted_ex: "hExtent", reg_date_1: "hRegDate", regcode: "hRegCode" };
function historyHtml(rec) {
  if (!state.changes) return ""; // log not loaded yet
  const list = state.changes.map.get(rec.id) || [];
  const rows = list.slice().reverse().slice(0, 25).map((c) =>
    `<div class="hist"><span class="hd">${esc(c.d)}</span> ${esc(t(HIST_LABEL_KEYS[c.f] || c.f))}: ` +
    `<s>${esc(c.from || "—")}</s> → <b>${esc(c.to || "—")}</b></div>`).join("");
  return `<div class="sect"><div class="eyebrow">${esc(t("history"))}</div>` +
    (rows || `<div class="hist none">${esc(t("noHistory"))} ${esc(state.changes.since || "—")}.</div>`) +
    `</div>`;
}

function plotShapeSvg(rec) {
  const src = rec.coord || state.geoCache.get(rec.id) || "";
  const pts = parsePlotCoord(src);
  if (!pts || pts.length < 3) return "";
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (const [e, n] of pts) { if (e < minE) minE = e; if (e > maxE) maxE = e; if (n < minN) minN = n; if (n > maxN) maxN = n; }
  const w = maxE - minE || 1, h = maxN - minN || 1, S = 84, k = (S - 8) / Math.max(w, h);
  const ox = (S - w * k) / 2, oy = (S - h * k) / 2;
  const poly = pts.map(([e, n]) => (ox + (e - minE) * k).toFixed(1) + "," + (oy + (maxN - n) * k).toFixed(1)).join(" ");
  return `<svg class="shapebox" viewBox="0 0 ${S} ${S}" aria-hidden="true"><polygon points="${poly}" fill="${zoneColor(rec.sym)}" stroke="#182420" stroke-width="1.5"/></svg>`;
}

function renderCard(rec, geom) {
  const card = $("card");
  if (!rec) { card.style.display = "none"; return; }
  const nb = rec.nb && (rec.nb.N || rec.nb.S || rec.nb.E || rec.nb.W) ? rec.nb : (rec.nbFromSnap || rec.nb || {});
  const zc = zoneColor(rec.sym);
  card.innerHTML =
    `<div class="zoneband" style="background:${zc}"></div>` +
    `<button type="button" class="close" aria-label="Close">✕</button>` +
    plotShapeSvg(rec) +
    `<div class="eyebrow">${esc(t("returnable"))}</div>` +
    `<h2>${esc(rec.code || rec.reg || "#" + rec.no)}</h2>` +
    (rec.sym ? `<span class="zonechip" style="background:${zc}">${esc(rec.sym)}</span>` : "") +
    `<div class="sect">` +
      kv(esc(t("lVillage")), esc(rec.village)) +
      (rec.no != null ? kv(esc(t("lPlotNo")), esc(rec.no)) : "") +
      kv(esc(t("lTSB")), `${esc(rec.twp ?? "—")} / ${esc(rec.sec ?? "—")} / ${esc(rec.blk ?? "—")}`) +
      (rec.ext != null ? kv(esc(t("lExtent")), inr(rec.ext)) : "") +
      (rec.len || rec.wid ? kv(esc(t("lDims")), `${esc(rec.wid ?? "?")} × ${esc(rec.len ?? "?")}`) : "") +
      (rec.categ ? kv(esc(t("lCategory")), esc(rec.categ)) : "") +
      (rec.reg ? kv(esc(t("lRegCode")), `<span class="mono">${esc(rec.reg)}</span>`) : "") +
      (rec.regdate ? kv(esc(t("lRegDate")), esc(rec.regdate)) : "") +
      kv(esc(t("lAllottee")), rec.farmer ? esc(rec.farmer) : (state.live ? "—" : `<i>${esc(t("needsLive"))}</i>`)) +
    `</div>` +
    ownerLineHtml(rec) +
    `<div class="sect">` +
      `<div class="eyebrow">${esc(t("boundaries"))}</div>` +
      `<div class="compass">` +
        `<div></div>${nbCell(nb.N)}<div></div>` +
        `${nbCell(nb.W)}<div class="mid" style="background:${zc}">№ ${esc(rec.no ?? "")}</div>${nbCell(nb.E)}` +
        `<div></div>${nbCell(nb.S)}<div></div>` +
      `</div>` +
    `</div>` +
    historyHtml(rec) +
    `<div class="actions">` +
      `<button type="button" class="primary" id="actZoom">${esc(t("zoom"))}</button>` +
      `<button type="button" class="ghost" id="actShare">${esc(t("share"))}</button>` +
      `<button type="button" class="ghost" id="actCopy">${esc(t("copy"))}</button>` +
      `<button type="button" class="ghost star${isSaved(rec.id) ? " on" : ""}" id="actSave" title="${esc(isSaved(rec.id) ? t("savedT") : t("saveT"))}">${isSaved(rec.id) ? "★" : "☆"}</button>` +
    `</div>` +
    `<div class="actions"><button type="button" class="ghost" id="actPrint" style="flex:1">${esc(t("printRec"))}</button></div>` +
    (state.live ? "" : `<div id="livehint">${esc(t("livehint"))}</div>`);
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
  $("actSave").addEventListener("click", () => {
    toggleSaved(rec.id);
    const b = $("actSave");
    b.textContent = isSaved(rec.id) ? "★" : "☆";
    b.title = isSaved(rec.id) ? t("savedT") : t("saveT");
    b.classList.toggle("on", isSaved(rec.id));
  });
  $("actPrint").addEventListener("click", () => window.print());
  $("actCopy").addEventListener("click", async () => {
    const text = rec.code || rec.reg || String(rec.no ?? "");
    try { await navigator.clipboard.writeText(text); } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (_) {}
      document.body.removeChild(ta);
    }
    $("actCopy").textContent = t("copied");
    setTimeout(() => { const b = $("actCopy"); if (b) b.textContent = t("copy"); }, 1400);
  });
}

/* ---------------- owner view: all plots held by one allottee ---------------- */
function ownerLineHtml(rec) {
  const name = primaryOwner(rec);
  if (!name || isInstitutionalOwner(name)) return "";
  const n = ownerPlots(name).length;
  if (n <= 1) return "";
  return `<div class="ownerbar"><span>${tf("ownerHolds", { n })}</span>` +
    `<button type="button" id="ownerLink" data-owner="${esc(name)}">${esc(t("viewAll"))}</button></div>`;
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
    $("regtoggle").textContent = t("register");
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
  const placedPlots = []; // { p, poly, center, n }
  const MAX_DRAW = 400; // keep the map responsive for very large holders
  for (const p of plots) {
    if (placedPlots.length >= MAX_DRAW) break;
    const ll = plotLatLngs(p);
    if (!ll) continue;
    const poly = L.polygon(ll, OWNER_STYLE).addTo(highlight);
    poly.on("click", () => openPlot(p.id));
    let la = 0, lo = 0;
    for (const [a, b] of ll) { la += a; lo += b; }
    placedPlots.push({ p, poly, center: [la / ll.length, lo / ll.length] });
  }
  // number the plots and drop a big tappable pin on each — tiny plot outlines
  // are invisible when the view spans villages; the pins are what you see
  placedPlots.forEach((x, i) => {
    x.n = i + 1;
    const pin = L.marker(x.center, {
      icon: L.divIcon({ className: "", html: `<div class="plotpin">${x.n}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
    }).addTo(highlight);
    pin.on("click", () => openPlot(x.p.id));
  });
  const placed = placedPlots.length;
  // fit to the majority cluster: ignore plots >10 km from the median so one
  // bad-coordinate parcel can't fling the map somewhere meaningless
  if (placed) {
    const lats = placedPlots.map((x) => x.center[0]).sort((a, b) => a - b);
    const lons = placedPlots.map((x) => x.center[1]).sort((a, b) => a - b);
    const medC = [lats[Math.floor(lats.length / 2)], lons[Math.floor(lons.length / 2)]];
    const kmFrom = (c) => {
      const dLat = (c[0] - medC[0]) * 111, dLon = (c[1] - medC[1]) * 111 * Math.cos(medC[0] * Math.PI / 180);
      return Math.hypot(dLat, dLon);
    };
    const fitSet = placedPlots.filter((x) => kmFrom(x.center) <= 10);
    const use = fitSet.length ? fitSet : placedPlots;
    let b = use[0].poly.getBounds();
    for (let i = 1; i < use.length; i++) b = b.extend(use[i].poly.getBounds());
    try { map.fitBounds(b.pad(0.3), { maxZoom: 17 }); } catch (_) {}
  }

  const totalExt = plots.reduce((s, p) => s + (typeof p.ext === "number" ? p.ext : 0), 0);
  const villages = [...new Set(plots.map((p) => p.village).filter((v) => v && v !== "—"))];
  const pinNo = new Map(placedPlots.map((x) => [x.p.id, x.n]));
  const rows = plots.map((p) => {
    const n = pinNo.get(p.id);
    return `<button type="button" class="ownerplot" data-code="${esc(p.id)}">` +
      (n ? `<span class="op-pin">${n}</span>` : `<span class="dot" style="background:${zoneColor(p.sym)}"></span>`) +
      `<span class="op-code">${esc(p.code || p.reg || "#" + p.no)}</span>` +
      `<span class="op-vil">${esc(p.village)}</span>` +
      `<span class="op-ext">${p.ext != null ? inr(Math.round(p.ext)) : "—"}</span>` +
    `</button>`;
  }).join("");

  const card = $("card");
  card.innerHTML =
    `<button type="button" class="close" aria-label="Close">✕</button>` +
    `<div class="eyebrow">${esc(t("eAllottee"))}</div>` +
    `<h2 style="font-family:'IBM Plex Sans',sans-serif;font-size:18px;">${esc(name)}</h2>` +
    `<div class="sect">` +
      kv(esc(t("plotsHeld")), `<b>${plots.length}</b>`) +
      (totalExt ? kv(esc(t("totalExtent")), inr(Math.round(totalExt))) : "") +
      kv(esc(t("lVillages")), esc(villages.join(", ") || "—")) +
      (placed < plots.length ? kv(esc(t("shownOnMap")), `${placed} / ${plots.length}`) : "") +
    `</div>` +
    `<div class="sect">` +
      `<div class="eyebrow">${esc(t("allPlots"))}</div>` +
      `<div class="ownerlist">${rows}</div>` +
    `</div>` +
    `<div class="actions">` +
      `<button type="button" class="primary" id="ownerShare">${esc(t("shareList"))}</button>` +
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
  btn.textContent = t("linkCopied");
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
// A "real" plot has a plot code, or a regcode plus a positive plot number.
// APCRDA's layer also contains giant zone-coverage records (village planning
// areas, reserves, roads — plot_no 0, blank codes); those must never open.
function isRealPlotProps(pr) {
  if (!pr) return false;
  if (String(pr.plot_code || "").trim()) return true;
  return !!String(pr.regcode || "").trim() && Number(pr.plot_no) > 0;
}

map.on("click", (e) => {
  if (!state.live) return;
  L.esri.identifyFeatures(esriOpts({ url: CONFIG.SERVICE }))
    .on(map).at(e.latlng)
    .layers("all:" + CONFIG.PLOT_LAYER)
    .tolerance(3)
    .run((err, fc) => {
      if (err || !fc || !fc.features.length) return;
      const f = fc.features.find((x) => isRealPlotProps(x.properties));
      if (!f) return; // clicked open zone / village / road area — nothing to open
      showFeature(f);
    });
});

/* ---------------- GPS: which plot am I standing on? ---------------- */
const gpsLayer = L.layerGroup().addTo(map);
function pip(x, y, pts) { // ray-cast point-in-polygon in UTM metres
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function gpsNote(msg) {
  const n = $("notice");
  n.style.display = "block";
  n.textContent = msg;
  setTimeout(() => { if (n.textContent === msg) n.style.display = "none"; }, 7000);
}
function locateMe() {
  if (!navigator.geolocation || !ensureProj()) { gpsNote(t("gpsNoFix")); return; }
  setStatus("wait", t("gpsLocating").toUpperCase());
  navigator.geolocation.getCurrentPosition((pos) => {
    statusLine();
    const lat = pos.coords.latitude, lon = pos.coords.longitude;
    gpsLayer.clearLayers();
    L.circleMarker([lat, lon], { radius: 7, color: "#fff", weight: 2, fillColor: "#1D4E89", fillOpacity: 1 }).addTo(gpsLayer);
    let E, N;
    try { [E, N] = proj4("WGS84", "APCRDA_UTM", [lon, lat]); } catch (_) { gpsNote(t("gpsNoFix")); return; }
    const vb = state.villageBounds;
    if (!vb) { gpsNote(t("gpsNeedData")); map.setView([lat, lon], 16); return; }
    const PAD = 250; // metres of slack around village bounds
    const cands = Object.keys(vb).filter((sl) => {
      const b = vb[sl];
      return E >= b[0] - PAD && E <= b[2] + PAD && N >= b[1] - PAD && N <= b[3] + PAD;
    });
    if (!cands.length) { gpsNote(t("gpsOutside")); map.setView([lat, lon], 15); return; }
    const candSet = new Set(cands);
    const villagesToLoad = (state.villageNames || []).filter((v) => candSet.has(villageSlug(v)));
    Promise.all(villagesToLoad.map(loadGeo)).then(() => {
      for (const p of state.plots) {
        if (!candSet.has(villageSlug(p.village))) continue;
        const src = p.coord || state.geoCache.get(p.id);
        if (!src) continue;
        const pts = parsePlotCoord(src);
        if (!pts || pts.length < 3) continue;
        // cheap bbox reject before the exact test
        let inBox = false, minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
        for (const [e, n] of pts) { if (e < minE) minE = e; if (e > maxE) maxE = e; if (n < minN) minN = n; if (n > maxN) maxN = n; }
        inBox = E >= minE && E <= maxE && N >= minN && N <= maxN;
        if (inBox && pip(E, N, pts)) { openPlot(p.id); return; }
      }
      gpsNote(t("gpsNoPlot"));
      map.setView([lat, lon], 17);
    });
  }, () => { statusLine(); gpsNote(t("gpsNoFix")); }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
}
$("btnGps").addEventListener("click", locateMe);
L.DomEvent.disableClickPropagation($("btnGps"));

/* ---------------- satellite / map basemap toggle ---------------- */
const baseSat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19, attribution: "Imagery \u00a9 Esri & partners",
});
let satOn = false;
$("btnSat").addEventListener("click", () => {
  satOn = !satOn;
  if (satOn) { map.addLayer(baseSat); } else { map.removeLayer(baseSat); }
  $("btnSat").classList.toggle("on", satOn);
  $("btnSat").title = satOn ? t("mapViewT") : t("satellite");
});
L.DomEvent.disableClickPropagation($("btnSat"));

/* ---------------- bookmarks: my plots ---------------- */
function getSaved() { try { return JSON.parse(localStorage.getItem("lps-saved") || "[]"); } catch (_) { return []; } }
function setSaved(a) { try { localStorage.setItem("lps-saved", JSON.stringify(a)); } catch (_) {} paintMyCount(); }
function isSaved(id) { return getSaved().includes(id); }
function toggleSaved(id) { const a = getSaved(); const i = a.indexOf(id); if (i >= 0) a.splice(i, 1); else a.push(id); setSaved(a); }
function paintMyCount() {
  const n = getSaved().length;
  $("mybtn").textContent = "\u2605 " + t("myPlots") + (n ? " (" + n + ")" : "");
}
$("mybtn").addEventListener("click", () => {
  const saved = getSaved().map((id) => state.byCode.get(id)).filter(Boolean);
  suggest.innerHTML = saved.length
    ? saved.map((p) => suggestRow(p, p.farmer || "")).join("")
    : `<div class="s-note">${esc(t("myPlotsEmpty"))}</div>`;
  suggest.style.display = suggest.style.display === "block" ? "none" : "block";
});

/* ---------------- recent changes feed ---------------- */
function openFeed() {
  if (!state.changes) return;
  state.mode = "feed"; state.selectedCode = null; state.owner = null;
  highlight.clearLayers();
  const entries = (state.changes.raw || []).slice().reverse().slice(0, 80);
  const rows = entries.map((c) =>
    `<button type="button" class="ownerplot" data-code="${esc(c.id)}">` +
      `<span class="hd" style="font:600 10px 'IBM Plex Mono',monospace;color:#7d7768;">${esc(c.d)}</span>` +
      `<span class="op-vil">${esc(t(HIST_LABEL_KEYS[c.f] || c.f))}: <s>${esc(c.from || "\u2014")}</s> \u2192 <b>${esc(c.to || "\u2014")}</b></span>` +
      `<span class="op-code">${esc(c.id)}</span>` +
    `</button>`).join("");
  const card = $("card");
  card.innerHTML =
    `<button type="button" class="close" aria-label="Close">\u2715</button>` +
    `<div class="eyebrow">${esc(t("feedTitle"))}</div>` +
    `<div class="ownerlist" style="max-height:60vh;margin-top:10px;">${rows || `<div class="s-note">${esc(t("feedEmpty"))}</div>`}</div>`;
  card.style.display = "block";
  card.querySelector(".close").addEventListener("click", closeCard);
  card.querySelectorAll(".ownerplot").forEach((b) => b.addEventListener("click", () => openPlot(b.dataset.code)));
}
$("feedbtn").addEventListener("click", openFeed);

/* ---------------- welcome overlay (first visit) ---------------- */
(function welcome() {
  let seen = false;
  try { seen = localStorage.getItem("lps-welcomed") === "1"; } catch (_) {}
  if (seen) { $("welcome").remove(); return; }
  $("welcome").style.display = "flex";
  $("wgo").addEventListener("click", () => {
    try { localStorage.setItem("lps-welcomed", "1"); } catch (_) {}
    $("welcome").remove();
    qInput.focus();
  });
})();

/* ---------------- mobile register toggle ---------------- */
$("regtoggle").addEventListener("click", () => {
  const a = $("aside");
  a.classList.toggle("hidden");
  $("regtoggle").textContent = a.classList.contains("hidden") ? t("register") : t("hideRegister");
  setTimeout(() => map.invalidateSize(), 60);
});
if (window.matchMedia("(max-width: 880px)").matches) {
  $("aside").classList.add("hidden");
}
window.addEventListener("resize", () => map.invalidateSize());

/* ---------------- language switch + boot chrome ---------------- */
function applyLang() {
  document.documentElement.lang = LANG === "te" ? "te" : "en";
  $("q").placeholder = t("searchPh");
  $("q").setAttribute("aria-label", t("searchPh"));
  const lb = $("langbtn");
  if (lb) lb.textContent = LANG === "en" ? "\u0c24\u0c46\u0c32\u0c41\u0c17\u0c41" : "English";
  const sub = $("subtitle");
  if (sub) sub.textContent = t("subtitle");
  const foot = $("f_unofficial");
  if (foot) foot.innerHTML = t("footer"); // fixed strings from our own dictionary
  if (state.snapshotDate) {
    $("snapinfo").textContent = " " + t("snapshotLbl") + ": " + state.snapshotDate.slice(0, 10) + " " + t("refreshed");
  }
  const a = $("aside");
  $("regtoggle").textContent = a.classList.contains("hidden") ? t("register") : t("hideRegister");
  buildChips();
  buildHead();
  buildVillageSelect();
  paintMyCount();
  if (state.changes) { $("feedbtn").textContent = t("recentChanges") + " (" + (state.changes.raw || []).length + ") →"; }
  $("btnGps").title = t("gpsTitle");
  $("btnSat").title = t("satellite");
  const wt = $("wtitle"); if (wt) { wt.textContent = t("welcomeTitle"); $("wbody").textContent = t("welcomeBody"); $("wgo").textContent = t("welcomeBtn"); }
  applyFilters();
  // re-render whatever's open so its labels switch too
  if (state.mode === "owner" && state.owner) openOwner(state.owner);
  else if (state.selectedCode) {
    const r = state.byCode.get(state.selectedCode);
    if (r) renderCard(r, null);
  }
}
const langBtn = $("langbtn");
if (langBtn) langBtn.addEventListener("click", () => {
  LANG = LANG === "en" ? "te" : "en";
  try { localStorage.setItem("lps-lang", LANG); } catch (_) {}
  applyLang();
});
applyLang();

/* lightweight error surfacing — enterprise sites never fail silently */
let errShown = false;
window.addEventListener("error", () => {
  if (errShown) return;
  errShown = true;
  const d = document.createElement("div");
  d.id = "errtoast";
  d.setAttribute("role", "alert");
  d.textContent = t("errToast");
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 6000);
});
