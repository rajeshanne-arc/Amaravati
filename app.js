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
  // RAG assistant endpoint (Cloudflare Worker from worker/rag-assistant.js).
  // Leave "" until the worker is deployed; the Ask button then explains how.
  ASK_ENDPOINT: "https://amaravati.arc-lps.workers.dev",
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
  if (!pts.length) return null;
  return fixRing(pts);
}
// Some APCRDA records list a plot's corners in scan order (top-left,
// top-right, bottom-left, bottom-right) instead of walking the perimeter.
// Drawn as-is that crosses itself into an hourglass and breaks the
// point-in-polygon test. If the ring self-intersects, re-order the
// vertices by angle around the centroid; rings that are already simple
// (including genuine L-shapes) pass through untouched.
function ringSelfIntersects(pts) {
  const ring = (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1])
    ? pts.slice(0, -1) : pts;
  const n = ring.length;
  if (n < 4) return false;
  const ccw = (p, q, r) => (r[1] - p[1]) * (q[0] - p[0]) - (q[1] - p[1]) * (r[0] - p[0]);
  const cross = (a, b, c, d) => ccw(a, c, d) * ccw(b, c, d) < 0 && ccw(a, b, c) * ccw(a, b, d) < 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent via wrap-around
      if (cross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}
function fixRing(pts) {
  if (!ringSelfIntersects(pts)) return pts;
  const ring = (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1])
    ? pts.slice(0, -1) : pts.slice();
  let ce = 0, cn = 0;
  for (const [e, n] of ring) { ce += e; cn += n; }
  ce /= ring.length; cn /= ring.length;
  ring.sort((a, b) => Math.atan2(a[1] - cn, a[0] - ce) - Math.atan2(b[1] - cn, b[0] - ce));
  return ring;
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
  if (!state.geoOk) return Promise.resolve(false); // schema mismatch — live fallbacks handle geometry
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
// Centroid [lat, lng] of a plot's outline, for map links and directions.
function plotCentroid(rec) {
  const ll = plotLatLngs(rec);
  if (!ll || !ll.length) return null;
  let la = 0, lo = 0;
  for (const [a, b] of ll) { la += a; lo += b; }
  return [la / ll.length, lo / ll.length];
}
// Universal Google Maps links (work on Android, iPhone, and desktop).
function mapsDirTo(lat, lng) {
  return "https://www.google.com/maps/dir/?api=1&destination=" + lat.toFixed(6) + "," + lng.toFixed(6);
}
function mapsRoute(points) {
  // ordered waypoints: origin -> ... -> destination, capped for URL limits
  const CAP = 9; // Google Maps supports ~10 stops per URL
  const pts = points.slice(0, CAP);
  const dest = pts[pts.length - 1];
  const url = "https://www.google.com/maps/dir/?api=1&destination=" + dest[0].toFixed(6) + "," + dest[1].toFixed(6);
  const mids = pts.slice(0, -1).map((p) => p[0].toFixed(6) + "," + p[1].toFixed(6));
  return mids.length ? url + "&waypoints=" + mids.join("|") : url;
}

// Convert a live feature's GeoJSON geometry to Leaflet latlngs (outer ring).
function geojsonLatLngs(g) {
  if (!g) return null;
  let ring = null;
  if (g.type === "Polygon") ring = g.coordinates && g.coordinates[0];
  else if (g.type === "MultiPolygon") ring = g.coordinates && g.coordinates[0] && g.coordinates[0][0];
  if (!ring || ring.length < 3) return null;
  return ring.map((c) => [c[1], c[0]]);
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
    colPlot: "Plot", colVillage: "Village", colZone: "Zone", colExtent: "Extent", colEntity: "Entity",
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
    swipeT: "Compare with satellite", swipeOffT: "Turn off compare",
    collapseT: "Hide list", expandT: "Show list", legendTitle: "Zone legend", legend: "Legend",
    legendFilterHint: "Tap a zone to show only those plots. Pick a village to narrow further.", legendClear: "Show all zones",
    directions: "Directions", routeAll: "Route through all plots",
    routeNeedTwo: "Need at least two locatable plots for a route.",
    routeCapped: "Route for the first {n} of {m} plots (map app limit).",
    noLocation: "This plot has no mapped location.",
    measureT: "Measure distance", measureOffT: "Close measure", measureHint: "Tap points on the map to measure",
    measureDist: "Distance", measureArea: "Area", measureClear: "Clear", measureDone: "Done",
    modePlots: "Returnable plots", modeAlloc: "Allocated lands",
    allocParcels: "parcels", allocEntities: "entities",
    allocLoading: "Loading allocated lands\u2026",
    allocSearchPh: "Search company, institution, village\u2026",
    lyrTitle: "Map layers", lyrHint: "APCRDA reference layers \u00b7 tap to overlay", lyrLoadingOne: "loading\u2026", lyrFail: "couldn't load",
    areaEyebrow: "LAND-USE AREA — NOT A RETURNABLE PLOT", areaTitle: "Area", areaNote: "Zone coverage, roads, unallocated and institutional lands are viewable here but are not individual returnable plots, so they have no boundaries walk or change history.", zoomArea: "Zoom to this area",
    askBtn: "Ask AI", askPh: "Ask about plots, owners, villages\u2026", askSend: "Ask", askThinking: "Thinking\u2026",
    askOffline: "The AI assistant isn't set up yet. Deploy worker/rag-assistant.js to Cloudflare (instructions inside the file) and set CONFIG.ASK_ENDPOINT in app.js.",
    askFail: "The assistant couldn't answer just now \u2014 try again.",
    askHint: "Answers come only from this site's data. Not legal advice \u2014 verify at gis.apcrda.org/lps.",
    errToast: "Something went wrong — please refresh the page.",
  },
  te: {
    subtitle: "రిటర్నబుల్ ప్లాట్ రిజిస్టర్ · APCRDA GIS ఆధారిత అనధికారిక వ్యూయర్",
    searchPh: "ప్లాట్ కోడ్, నంబర్ లేదా కేటాయింపుదారు పేరు…",
    allVillages: "అన్ని గ్రామాలు",
    famAll: "అన్నీ", famResidential: "నివాస", famCommercial: "వాణిజ్య", famIndustry: "పరిశ్రమ",
    famParks: "పార్కులు", famInstitutional: "సంస్థాగత", famReserve: "రిజర్వ్",
    plotsWord: "ప్లాట్లు", totalExtent: "మొత్తం విస్తీర్ణం (నమోదైనది)",
    colPlot: "ప్లాట్", colVillage: "గ్రామం", colZone: "జోన్", colExtent: "విస్తీర్ణం", colEntity: "సంస్థ",
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
    swipeT: "\u0c36\u0c3e\u0c1f\u0c3f\u0c32\u0c48\u0c1f\u0c4d\u200c\u0c24\u0c4b \u0c2a\u0c4b\u0c32\u0c4d\u0c1a\u0c02\u0c21\u0c3f", swipeOffT: "\u0c2a\u0c4b\u0c32\u0c3f\u0c15 \u0c06\u0c2a\u0c02\u0c21\u0c3f",
    collapseT: "\u0c1c\u0c3e\u0c2c\u0c3f\u0c24\u0c3e \u0c26\u0c3e\u0c1a\u0c41", expandT: "\u0c1c\u0c3e\u0c2c\u0c3f\u0c24\u0c3e \u0c1a\u0c42\u0c2a\u0c41", legendTitle: "\u0c1c\u0c4b\u0c28\u0c4d \u0c32\u0c46\u0c1c\u0c46\u0c02\u0c21\u0c4d", legend: "\u0c32\u0c46\u0c1c\u0c46\u0c02\u0c21\u0c4d",
    legendFilterHint: "\u0c06 \u0c2a\u0c4d\u0c32\u0c3e\u0c1f\u0c4d\u0c32\u0c28\u0c47 \u0c1a\u0c42\u0c2a\u0c21\u0c3e\u0c28\u0c3f\u0c15\u0c3f \u0c1c\u0c4b\u0c28\u0c4d \u0c28\u0c4a\u0c15\u0c4d\u0c15\u0c02\u0c21\u0c3f. \u0c17\u0c4d\u0c30\u0c3e\u0c2e\u0c02 \u0c0e\u0c02\u0c1a\u0c41\u0c15\u0c4b\u0c02\u0c21\u0c3f.", legendClear: "\u0c05\u0c28\u0c4d\u0c28\u0c3f \u0c1c\u0c4b\u0c28\u0c4d\u0c32\u0c41 \u0c1a\u0c42\u0c2a\u0c41",
    directions: "\u0c26\u0c3e\u0c30\u0c3f", routeAll: "\u0c05\u0c28\u0c4d\u0c28\u0c3f \u0c2a\u0c4d\u0c32\u0c3e\u0c1f\u0c4d\u0c32 \u0c2e\u0c3e\u0c30\u0c4d\u0c17\u0c02",
    routeNeedTwo: "\u0c2e\u0c3e\u0c30\u0c4d\u0c17\u0c02 \u0c15\u0c4b\u0c38\u0c02 \u0c15\u0c28\u0c40\u0c38\u0c02 \u0c30\u0c46\u0c02\u0c21\u0c41 \u0c2a\u0c4d\u0c32\u0c3e\u0c1f\u0c4d\u0c32\u0c41 \u0c15\u0c3e\u0c35\u0c3e\u0c32\u0c3f.",
    routeCapped: "{m}\u0c32\u0c4b \u0c2e\u0c4a\u0c26\u0c1f\u0c3f {n} \u0c2a\u0c4d\u0c32\u0c3e\u0c1f\u0c4d\u0c32\u0c15\u0c41 \u0c2e\u0c3e\u0c30\u0c4d\u0c17\u0c02.",
    noLocation: "\u0c08 \u0c2a\u0c4d\u0c32\u0c3e\u0c1f\u0c4d\u200c\u0c15\u0c41 \u0c2e\u0c4d\u0c2f\u0c3e\u0c2a\u0c4d \u0c32\u0c4b\u0c15\u0c47\u0c37\u0c28\u0c4d \u0c32\u0c47\u0c26\u0c41.",
    measureT: "\u0c26\u0c42\u0c30\u0c02 \u0c15\u0c4a\u0c32\u0c35\u0c02\u0c21\u0c3f", measureOffT: "\u0c2e\u0c42\u0c38\u0c3f\u0c35\u0c47\u0c2f\u0c3f", measureHint: "\u0c15\u0c4a\u0c32\u0c35\u0c21\u0c3e\u0c28\u0c3f\u0c15\u0c3f \u0c2e\u0c4d\u0c2f\u0c3e\u0c2a\u0c4d\u200c\u0c2a\u0c48 \u0c2a\u0c3e\u0c2f\u0c3f\u0c02\u0c1f\u0c4d\u0c32\u0c41 \u0c28\u0c4a\u0c15\u0c4d\u0c15\u0c02\u0c21\u0c3f",
    measureDist: "\u0c26\u0c42\u0c30\u0c02", measureArea: "\u0c35\u0c3f\u0c38\u0c4d\u0c24\u0c40\u0c30\u0c4d\u0c23\u0c02", measureClear: "\u0c15\u0c4d\u0c32\u0c3f\u0c2f\u0c30\u0c4d", measureDone: "\u0c2a\u0c42\u0c30\u0c4d\u0c24\u0c2f\u0c3f\u0c02\u0c26\u0c3f",
    modePlots: "\u0c30\u0c3f\u0c1f\u0c30\u0c4d\u0c28\u0c2c\u0c41\u0c32\u0c4d \u0c2a\u0c4d\u0c32\u0c3e\u0c1f\u0c4d\u0c32\u0c41", modeAlloc: "\u0c15\u0c47\u0c1f\u0c3e\u0c2f\u0c3f\u0c02\u0c1a\u0c3f\u0c28 \u0c2d\u0c42\u0c2e\u0c41\u0c32\u0c41",
    allocParcels: "\u0c2a\u0c4d\u0c32\u0c3e\u0c1f\u0c4d\u0c32\u0c41", allocEntities: "\u0c38\u0c02\u0c38\u0c4d\u0c25\u0c32\u0c41",
    allocLoading: "\u0c15\u0c47\u0c1f\u0c3e\u0c2f\u0c3f\u0c02\u0c1a\u0c3f\u0c28 \u0c2d\u0c42\u0c2e\u0c41\u0c32\u0c41 \u0c32\u0c4b\u0c21\u0c35\u0c41\u0c24\u0c4b\u0c02\u0c26\u0c3f\u2026",
    allocSearchPh: "\u0c15\u0c02\u0c2a\u0c46\u0c28\u0c40, \u0c38\u0c02\u0c38\u0c4d\u0c25, \u0c17\u0c4d\u0c30\u0c3e\u0c2e\u0c02 \u0c35\u0c46\u0c24\u0c15\u0c02\u0c21\u0c3f\u2026",
    lyrTitle: "\u0c2e\u0c4d\u0c2f\u0c3e\u0c2a\u0c4d \u0c32\u0c47\u0c2f\u0c30\u0c4d\u0c32\u0c41", lyrHint: "APCRDA \u0c30\u0c3f\u0c2b\u0c30\u0c46\u0c28\u0c4d\u0c38\u0c4d \u0c32\u0c47\u0c2f\u0c30\u0c4d\u0c32\u0c41", lyrLoadingOne: "\u0c32\u0c4b\u0c21\u0c4d \u0c05\u0c35\u0c41\u0c24\u0c4b\u0c02\u0c26\u0c3f\u2026", lyrFail: "\u0c32\u0c4b\u0c21\u0c4d \u0c15\u0c3e\u0c32\u0c47\u0c26\u0c41",
    areaEyebrow: "\u0c2d\u0c42\u0c35\u0c3f\u0c28\u0c3f\u0c2f\u0c4b\u0c17 \u0c2a\u0c4d\u0c30\u0c3e\u0c02\u0c24\u0c02 \u2014 \u0c30\u0c3f\u0c1f\u0c30\u0c4d\u0c28\u0c2c\u0c41\u0c32\u0c4d \u0c2a\u0c4d\u0c32\u0c3e\u0c1f\u0c4d \u0c15\u0c3e\u0c26\u0c41", areaTitle: "\u0c2a\u0c4d\u0c30\u0c3e\u0c02\u0c24\u0c02", areaNote: "\u0c1c\u0c4b\u0c28\u0c4d \u0c15\u0c35\u0c30\u0c47\u0c1c\u0c4d, \u0c30\u0c4b\u0c21\u0c4d\u0c32\u0c41, \u0c15\u0c47\u0c1f\u0c3e\u0c2f\u0c3f\u0c02\u0c1a\u0c28\u0c3f \u0c2d\u0c42\u0c2e\u0c41\u0c32\u0c41 \u0c07\u0c15\u0c4d\u0c15\u0c21 \u0c1a\u0c42\u0c21\u0c35\u0c1a\u0c4d\u0c1a\u0c41, \u0c15\u0c3e\u0c28\u0c40 \u0c05\u0c35\u0c3f \u0c35\u0c4d\u0c2f\u0c15\u0c4d\u0c24\u0c3f\u0c17\u0c24 \u0c2a\u0c4d\u0c32\u0c3e\u0c1f\u0c4d\u0c32\u0c41 \u0c15\u0c3e\u0c35\u0c41.", zoomArea: "\u0c08 \u0c2a\u0c4d\u0c30\u0c3e\u0c02\u0c24\u0c3e\u0c28\u0c3f\u0c15\u0c3f \u0c1c\u0c42\u0c2e\u0c4d",
    askBtn: "AI \u0c28\u0c3f \u0c05\u0c21\u0c17\u0c02\u0c21\u0c3f", askPh: "\u0c2a\u0c4d\u0c32\u0c3e\u0c1f\u0c4d\u0c32\u0c41, \u0c2f\u0c1c\u0c2e\u0c3e\u0c28\u0c41\u0c32\u0c41, \u0c17\u0c4d\u0c30\u0c3e\u0c2e\u0c3e\u0c32 \u0c17\u0c41\u0c30\u0c3f\u0c02\u0c1a\u0c3f \u0c05\u0c21\u0c17\u0c02\u0c21\u0c3f\u2026", askSend: "\u0c05\u0c21\u0c17\u0c02\u0c21\u0c3f", askThinking: "\u0c06\u0c32\u0c4b\u0c1a\u0c3f\u0c38\u0c4d\u0c24\u0c4b\u0c02\u0c26\u0c3f\u2026",
    askOffline: "AI \u0c05\u0c38\u0c3f\u0c38\u0c4d\u0c1f\u0c46\u0c02\u0c1f\u0c4d \u0c07\u0c02\u0c15\u0c3e \u0c38\u0c3f\u0c26\u0c4d\u0c27\u0c02 \u0c15\u0c3e\u0c32\u0c47\u0c26\u0c41.",
    askFail: "\u0c38\u0c2e\u0c3e\u0c27\u0c3e\u0c28\u0c02 \u0c30\u0c3e\u0c32\u0c47\u0c26\u0c41 \u2014 \u0c2e\u0c33\u0c4d\u0c32\u0c40 \u0c2a\u0c4d\u0c30\u0c2f\u0c24\u0c4d\u0c28\u0c3f\u0c02\u0c1a\u0c02\u0c21\u0c3f.",
    askHint: "\u0c38\u0c2e\u0c3e\u0c27\u0c3e\u0c28\u0c3e\u0c32\u0c41 \u0c08 \u0c38\u0c48\u0c1f\u0c4d \u0c21\u0c47\u0c1f\u0c3e \u0c28\u0c41\u0c02\u0c21\u0c47. \u0c1a\u0c1f\u0c4d\u0c1f\u0c2a\u0c30\u0c2e\u0c48\u0c28 \u0c05\u0c35\u0c38\u0c30\u0c3e\u0c32\u0c15\u0c41 gis.apcrda.org/lps \u0c32\u0c4b \u0c27\u0c43\u0c35\u0c40\u0c15\u0c30\u0c3f\u0c02\u0c1a\u0c02\u0c21\u0c3f.",
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
  geoOk: false,         // snapshot id scheme matches this app -> shards usable
  regMode: "plots",     // "plots" (returnable) or "alloc" (allocated lands)
  allocSort: { key: "ext", dir: -1 }, // allocated view sort (default: largest first)
};

/* ---------------- map ---------------- */
const map = L.map("map", { zoomControl: true }).setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);
L.control.scale({ imperial: false }).addTo(map);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 21, maxNativeZoom: 19,
  attribution: "© OpenStreetMap contributors",
}).addTo(map);

const lpsLayer = L.esri.dynamicMapLayer(esriOpts({ url: CONFIG.SERVICE, opacity: 0.85 })).addTo(map);
map.createPane("swipe"); // satellite lives here in compare mode so we can clip it
map.getPane("swipe").style.zIndex = 350;
map.createPane("apcrda"); // APCRDA context overlays: above the plot layer, below highlights
map.getPane("apcrda").style.zIndex = 300;
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
  // IDENTITY RULE: the ONLY guaranteed-unique field is the server's object id.
  // plot_code repeats and sometimes holds zone labels; even regcode is not
  // unique in APCRDA's data (the same code can appear on two different plots).
  // So identity is always the object id. Codes are for display and search.
  // (Must stay in lockstep with deriveId() in scripts/fetch-snapshot.mjs.)
  const oid = a.ESRI_OID != null ? a.ESRI_OID : (a.esri_oid != null ? a.esri_oid : null);
  const id = oid != null ? "p" + oid : (looksLikeCode(rawReg) ? rawReg : rawCode);
  return {
    id, oid, code: rawCode, no: a.plot_no ?? null, sym: a.symbology || "",
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
    // Only genuine plots enter the register: a positive plot number AND a
    // code-shaped code or registration code. This excludes zone-coverage
    // records and the label-coded slivers ("Residential Vacant",
    // "15.6 mtr Road") that APCRDA stores in the same layer.
    .filter((p) => Number(p.no) > 0 && (looksLikeCode(p.code) || looksLikeCode(p.reg)));
  // APCRDA's layer stores some plots as several identical overlapping rows,
  // each with its own object id. Collapse rows identical in every meaningful
  // field so each real plot shows once. Rows that share a registration code
  // but genuinely differ (e.g. two recorded allottees — a source data issue)
  // are kept separate and shown honestly rather than silently merged.
  const seen = new Map();
  let dupes = 0;
  for (const p of all) {
    const key = [p.reg, p.code, p.village, p.no ?? "", p.ext ?? "", p.farmer || "", (p.coord || "").slice(0, 60)].join("|");
    if (seen.has(key)) { dupes++; continue; }
    seen.set(key, p);
  }
  state.plots = [...seen.values()];
  state.dupCount = dupes;
  state.byCode = new Map();
  for (const p of state.plots) {
    if (p.code && looksLikeCode(p.code) && !state.byCode.has(p.code)) state.byCode.set(p.code, p);
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
    // Geometry shards are only trusted when the snapshot declares the same
    // id scheme this app uses. On mismatch (e.g. app updated before the data
    // job reran) offline geometry is disabled and the live fallbacks take
    // over — mismatched lookups can then never draw the wrong plot.
    state.geoOk = j.idScheme === "p-oid";
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
  if (state.regMode === "alloc") { applyAllocFilters(); return; }
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

/* ---------------- allocated lands (named entity allotments) ---------------- */
// A parcel is an "allocated land" when its allottee is a company, institution,
// university, trust or similar entity — not a farmer. Matched on distinctive
// tokens in the allottee name.
const ENTITY_RE = /\b(ltd|limited|pvt|private|univ|university|institute|institution|college|trust|foundation|society|corporation|company|enterprises?|industries|hotels?|resorts?|estates?|constructions?|infra|technolog|L&T|NID|LVPEI|SRM|BITS|academy)\b/i;
function isEntityOwner(name) { return !!name && ENTITY_RE.test(name); }
const alloc = { loaded: false, loading: false, plots: [] };

async function loadAllocated() {
  if (alloc.loaded || alloc.loading) return;
  alloc.loading = true;
  // Dedup on PLOT identity (registration code, else plot_code+village), so an
  // entity's several distinct parcels are each kept once, while APCRDA's
  // repeated rows of the same parcel collapse. Owner+plot_no is NOT a valid
  // key — different sectors reuse plot numbers.
  const seen = new Map();
  const keyOf = (r) => (looksLikeCode(r.reg) ? r.reg : ((r.code || "") + "#" + r.village)) || (r.id);
  const add = (r) => { const k = keyOf(r); if (!seen.has(k)) seen.set(k, r); };
  for (const p of state.plots) {
    if (isEntityOwner(p.farmer)) add({ id: p.id, oid: p.oid, farmer: p.farmer, sym: p.sym, ext: p.ext, village: p.village, no: p.no, code: p.code, reg: p.reg });
  }
  // also fetch entity parcels straight from APCRDA in case any aren't in the snapshot
  try {
    const clause = "(" + ["LTD","Limited","Pvt","Universit","Institute","INSTITUTE","Trust",
      "Foundation","Society","L&T","Corporation","Company","Enterprises","Industries","Hotels"]
      .map((w) => "farmer_n LIKE '%" + w + "%'").join(" OR ") + ")";
    await new Promise((res) => {
      L.esri.query({ url: CONFIG.SERVICE + "/" + CONFIG.PLOT_LAYER })
        .where(clause).returnGeometry(false).limit(600)
        .run((err, fc) => {
          if (!err && fc) {
            for (const f of fc.features) {
              const rec = normalize(f.properties || {});
              if (!isEntityOwner(rec.farmer)) continue;
              add({ id: rec.id, oid: rec.oid, farmer: rec.farmer, sym: rec.sym, ext: rec.ext, village: rec.village, no: rec.no, code: rec.code, reg: rec.reg });
            }
          }
          res();
        });
    });
  } catch (_) { /* offline: fall back to in-memory matches only */ }
  alloc.plots = [...seen.values()];
  // make allocated parcels resolvable by openPlot (they aren't in the main
  // register's byCode index, so without this a click finds no record)
  for (const p of alloc.plots) {
    if (!state.byCode.has(p.id)) state.byCode.set(p.id, p);
    if (p.code && looksLikeCode(p.code) && !state.byCode.has(p.code)) state.byCode.set(p.code, p);
  }
  alloc.loaded = true;
  alloc.loading = false;
}

function applyAllocFilters() {
  const { q, village } = state.filters;
  const ql = q.trim().toLowerCase();
  let list = alloc.plots.filter((p) => {
    if (village !== "__ALL__" && p.village !== village) return false;
    if (ql) {
      const hay = ((p.farmer || "") + " " + p.village + " " + (p.sym || "") + " " + (p.code || "") + " " + (p.no ?? "")).toLowerCase();
      if (!hay.includes(ql)) return false;
    }
    return true;
  });
  const { key, dir } = state.allocSort;
  list.sort((a, b) => {
    let av, bv;
    if (key === "ext") { av = typeof a.ext === "number" ? a.ext : -Infinity; bv = typeof b.ext === "number" ? b.ext : -Infinity; return (av - bv) * dir; }
    av = String((key === "village" ? a.village : entityShort(a.farmer)) || "");
    bv = String((key === "village" ? b.village : entityShort(b.farmer)) || "");
    return av.localeCompare(bv) * dir;
  });
  state.filtered = list;
  const totalExt = list.reduce((s, p) => s + (typeof p.ext === "number" ? p.ext : 0), 0);
  const entities = new Set(list.map((p) => ownerKey(p.farmer))).size;
  $("stats").innerHTML =
    `<b>${inr(list.length)}</b> ${t("allocParcels")}` +
    ` · <b>${inr(entities)}</b> ${t("allocEntities")}` +
    (totalExt ? ` · <b>${inr(Math.round(totalExt))}</b> ${t("totalExtent")}` : "");
  renderAllocTable();
}

const ALLOC_COLS = [
  { key: "farmer", labelKey: "colEntity", w: "" },
  { key: "village", labelKey: "colVillage", w: "96px" },
  { key: "ext", labelKey: "colExtent", w: "66px", right: true },
];
function renderAllocTable() {
  // sortable header
  const h = $("thead");
  h.innerHTML = "";
  ALLOC_COLS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.style.width = c.w || "auto";
    if (!c.w) b.style.flex = "1";
    if (c.right) b.style.justifyContent = "flex-end";
    const on = state.allocSort.key === c.key;
    b.className = on ? "on" : "";
    b.textContent = t(c.labelKey) + (on ? (state.allocSort.dir === 1 ? " ↑" : " ↓") : "");
    b.addEventListener("click", () => {
      state.allocSort = { key: c.key, dir: state.allocSort.key === c.key ? -state.allocSort.dir : (c.key === "ext" ? -1 : 1) };
      applyAllocFilters();
    });
    h.appendChild(b);
  });
  const rows = state.filtered;
  if (!rows.length) {
    $("tlist").innerHTML = `<div class="empty">${esc(alloc.loading ? t("allocLoading") : t("noMatch"))}</div>`;
    return;
  }
  $("tlist").innerHTML = rows.slice(0, 400).map((p) =>
    `<button type="button" class="ownerplot allocrow" data-code="${esc(p.id)}">` +
      `<span class="dot" style="background:${zoneColor(p.sym)}"></span>` +
      `<span class="op-owner">${esc(entityShort(p.farmer))}</span>` +
      `<span class="op-vil">${esc(p.village)}</span>` +
      `<span class="op-ext">${p.ext != null ? inr(Math.round(p.ext)) : "—"}</span>` +
    `</button>`
  ).join("") + (rows.length > 400 ? `<div class="s-note">+ ${inr(rows.length - 400)} …</div>` : "");
  $("tlist").querySelectorAll(".ownerplot").forEach((b) => b.addEventListener("click", () => openPlot(b.dataset.code)));
}
function entityShort(name) {
  // trim the "Rep by …/Phase-…" tails APCRDA appends, for a clean list
  return String(name || "").replace(/\s+(rep\b|represented|phase\b|director\b|managing\b).*$/i, "").trim() || name;
}

async function setRegMode(mode) {
  state.regMode = mode;
  $("modePlots").classList.toggle("on", mode === "plots");
  $("modeAlloc").classList.toggle("on", mode === "alloc");
  $("fFamily").style.display = mode === "alloc" ? "none" : "";
  $("q").placeholder = mode === "alloc" ? t("allocSearchPh") : t("searchPh");
  if (mode === "alloc") {
    if (!alloc.loaded) {
      $("stats").innerHTML = esc(t("allocLoading"));
      $("tlist").innerHTML = `<div class="empty">${esc(t("allocLoading"))}</div>`;
      await loadAllocated();
    }
    applyAllocFilters();
  } else {
    buildChips();
    applyFilters();
  }
}
$("modePlots").addEventListener("click", () => setRegMode("plots"));
$("modeAlloc").addEventListener("click", () => setRegMode("alloc"));

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

$("fVillage").addEventListener("change", (e) => { state.filters.village = e.target.value; applyFilters(); if (typeof applyMapFilter === "function") applyMapFilter(); });

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
    updateURL({ plot: rec.id });
    // instant offline outline; if this village's shard isn't loaded yet,
    // fetch it in the background and draw when it arrives
    if (!highlightLocal(rec, true) && rec.village) {
      loadGeo(rec.village).then((ok) => {
        if (ok && state.mode === "plot" && state.selectedCode === key) highlightLocal(rec, true);
      });
    }
  }
  // LIVE LOOKUP — by object id, the only truly unique key. APCRDA sometimes
  // stamps one registration code onto two different plots, so a code query
  // can return the wrong twin. And regardless of what the server returns,
  // the VERIFICATION below refuses to display any feature that isn't the
  // exact plot that was asked for — a wrong plot can never render.
  const sameAsRec = (live) => {
    if (!rec) return true;
    if (rec.oid != null && live.oid != null) return String(live.oid) === String(rec.oid);
    return live.code === rec.code && live.village === rec.village && String(live.no) === String(rec.no);
  };
  if (state.live && rec && rec.oid != null) {
    L.esri.query(esriOpts({ url: CONFIG.SERVICE + "/" + CONFIG.PLOT_LAYER }))
      .where("ESRI_OID = " + Number(rec.oid)).limit(1).returnGeometry(true)
      .run((err, fc) => {
        if (state.mode !== "plot" || state.selectedCode !== key) return; // user moved on
        if (err || !fc || !fc.features.length) { renderCard(rec, null); return; }
        const f = fc.features[0];
        if (!sameAsRec(normalize(f.properties || {}))) { renderCard(rec, null); return; } // wrong plot — refuse
        showFeature(f);
      });
  } else if (state.live && (rec ? (rec.reg || rec.code) : key)) {
    const liveReg = rec ? rec.reg : "";
    const liveCode = rec ? rec.code : key;
    const clause = looksLikeCode(liveReg)
      ? `regcode = '${liveReg.replace(/'/g, "''")}'`
      : `plot_code = '${String(liveCode).replace(/'/g, "''")}'`;
    L.esri.query(esriOpts({ url: CONFIG.SERVICE + "/" + CONFIG.PLOT_LAYER }))
      .where(clause).limit(1).returnGeometry(true)
      .run((err, fc) => {
        if (state.mode !== "plot" || state.selectedCode !== key) return;
        if (err || !fc || !fc.features.length) { renderCard(rec, null); return; }
        const f = fc.features[0];
        if (!sameAsRec(normalize(f.properties || {}))) { renderCard(rec, null); return; } // wrong plot — refuse
        showFeature(f);
      });
  } else {
    renderCard(rec, null);
  }
}

// A clicked feature is either a returnable PLOT (full card, history, owner
// view) or a land-use AREA — zone coverage, roads, unallocated or company
// land. Areas are fully viewable, but on their own terms: their outline is
// drawn WITHOUT flying the map to their (often village-sized) bounds, so
// they can never hijack the view the way they used to.
function isReturnablePlot(rec) {
  return Number(rec.no) > 0 && (looksLikeCode(rec.code) || looksLikeCode(rec.reg));
}
function showFeature(f) {
  const rec = normalize(f.properties || {});
  if (!isReturnablePlot(rec)) { showArea(rec, f.geometry); return; }
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
function showArea(rec, geom) {
  state.mode = "plot";
  state.selectedCode = null;
  renderTable();
  highlight.clearLayers();
  const ll = geojsonLatLngs(geom) || plotLatLngs(rec);
  let poly = null;
  if (ll) poly = L.polygon(ll, { color: "#17110C", weight: 2, dashArray: "4 6", fillColor: zoneColor(rec.sym), fillOpacity: 0.12 }).addTo(highlight);
  // deliberately NO fitBounds here — the outline appears where the user
  // clicked; zooming to a village-sized polygon is opt-in via the button
  const zc = zoneColor(rec.sym);
  const card = $("card");
  card.innerHTML =
    `<div class="zoneband" style="background:${zc}"></div>` +
    `<button type="button" class="close" aria-label="Close">\u2715</button>` +
    `<div class="eyebrow">${esc(t("areaEyebrow"))}</div>` +
    `<h2>${esc(rec.sym || rec.code || t("areaTitle"))}</h2>` +
    `<span class="zonechip" style="background:${zc}">${esc(rec.sym || "\u2014")}</span>` +
    `<div class="sect">` +
      kv(esc(t("lVillage")), esc(rec.village)) +
      (rec.ext != null ? kv(esc(t("lExtent")), inr(Math.round(rec.ext))) : "") +
      (rec.farmer ? kv(esc(t("lAllottee")), esc(rec.farmer)) : "") +
      (rec.categ ? kv(esc(t("lCategory")), esc(rec.categ)) : "") +
    `</div>` +
    ownerLineHtml(rec) +
    `<div class="hist none" style="border:none">${esc(t("areaNote"))}</div>` +
    `<div class="actions">` +
      (poly ? `<button type="button" class="primary" id="areaZoom">${esc(t("zoomArea"))}</button>` : "") +
    `</div>`;
  card.style.display = "block";
  card.querySelector(".close").addEventListener("click", closeCard);
  const ob = card.querySelector("#ownerLink");
  if (ob) ob.addEventListener("click", () => openOwner(ob.dataset.owner));
  const zb = $("areaZoom");
  if (zb && poly) zb.addEventListener("click", () => { try { map.fitBounds(poly.getBounds().pad(0.1)); } catch (_) {} });
}

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
    `<div class="actions"><button type="button" class="ghost" id="actDir" style="flex:1">${esc(t("directions"))}</button></div>` +
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
  $("actShare").addEventListener("click", () => copyShare($("actShare"), { plot: rec.id }));
  const dirBtn = $("actDir");
  if (dirBtn) dirBtn.addEventListener("click", () => {
    const c = plotCentroid(rec);
    if (c) { window.open(mapsDirTo(c[0], c[1]), "_blank", "noopener"); return; }
    // geometry not offline (shards disabled) — resolve live, then open Maps
    if (geom && geom.getBounds) {
      const ctr = geom.getBounds().getCenter();
      window.open(mapsDirTo(ctr.lat, ctr.lng), "_blank", "noopener"); return;
    }
    if (state.live && rec.oid != null) {
      dirBtn.disabled = true;
      L.esri.query(esriOpts({ url: CONFIG.SERVICE + "/" + CONFIG.PLOT_LAYER }))
        .where("ESRI_OID = " + Number(rec.oid)).returnGeometry(true).limit(1)
        .run((err, fc) => {
          dirBtn.disabled = false;
          const ll = (!err && fc && fc.features[0]) ? geojsonLatLngs(fc.features[0].geometry) : null;
          if (!ll) { toast(t("noLocation")); return; }
          let la = 0, lo = 0; for (const [a, b] of ll) { la += a; lo += b; }
          window.open(mapsDirTo(la / ll.length, lo / ll.length), "_blank", "noopener");
        });
    } else toast(t("noLocation"));
  });
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
  if (!name) return "";
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

  // Resolve every plot's outline: offline shards first, then a single LIVE
  // query for anything unresolved (stale shards, schema changeover, missing
  // geometry) — so the pins are placed correctly no matter the data state.
  const resolved = new Map(); // plot id -> latlngs
  for (const p of plots) { const ll = plotLatLngs(p); if (ll) resolved.set(p.id, ll); }
  const missing = plots.filter((p) => !resolved.has(p.id) && p.oid != null).slice(0, 40);
  const drawAll = () => {
  if (state.mode !== "owner" || state.owner !== key) return; // re-check after async gap

  highlight.clearLayers();
  const placedPlots = []; // { p, poly, center, n }
  const MAX_DRAW = 400; // keep the map responsive for very large holders
  for (const p of plots) {
    if (placedPlots.length >= MAX_DRAW) break;
    const ll = resolved.get(p.id);
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
  const MAX_ROWS = 500; // keep huge institutional holders scrollable, not crashing
  const shown = plots.slice(0, MAX_ROWS);
  const rows = shown.map((p) => {
    const n = pinNo.get(p.id);
    return `<button type="button" class="ownerplot" data-code="${esc(p.id)}">` +
      (n ? `<span class="op-pin">${n}</span>` : `<span class="dot" style="background:${zoneColor(p.sym)}"></span>`) +
      `<span class="op-code">${esc(p.code || p.reg || "#" + p.no)}</span>` +
      `<span class="op-vil">${esc(p.village)}</span>` +
      `<span class="op-ext">${p.ext != null ? inr(Math.round(p.ext)) : "—"}</span>` +
    `</button>`;
  }).join("") + (plots.length > MAX_ROWS ? `<div class="s-note">+ ${inr(plots.length - MAX_ROWS)} \u2026</div>` : "");

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
    `</div>` +
    `<div class="actions"><button type="button" class="ghost" id="ownerRoute" style="flex:1">${esc(t("routeAll"))}</button></div>`;
  card.style.display = "block";
  card.querySelector(".close").addEventListener("click", closeCard);
  card.querySelectorAll(".ownerplot").forEach((b) => b.addEventListener("click", () => openPlot(b.dataset.code)));
  $("ownerShare").addEventListener("click", () => copyShare($("ownerShare"), { owner: key }));
  const routeBtn = $("ownerRoute");
  if (routeBtn) routeBtn.addEventListener("click", () => {
    // use the SAME centroids the numbered pins were drawn from (these are
    // resolved live when offline geometry is absent), in list order
    const cs = placedPlots
      .slice().sort((a, b) => a.n - b.n)
      .map((x) => x.center)
      .filter(Boolean)
      .slice(0, 9);
    if (cs.length < 2) { toast(t("routeNeedTwo")); return; }
    window.open(mapsRoute(cs), "_blank", "noopener");
    if (placedPlots.length > cs.length) toast(tf("routeCapped", { n: cs.length, m: placedPlots.length }));
  });
  }; // end drawAll

  if (missing.length && state.live) {
    const oids = missing.map((p) => Number(p.oid)).filter(Number.isFinite);
    L.esri.query(esriOpts({ url: CONFIG.SERVICE + "/" + CONFIG.PLOT_LAYER }))
      .where("ESRI_OID IN (" + oids.join(",") + ")")
      .limit(oids.length).returnGeometry(true)
      .run((err, fc) => {
        if (!err && fc && fc.features) {
          for (const f of fc.features) {
            const live = normalize(f.properties || {});
            const ll = geojsonLatLngs(f.geometry);
            if (live.id && ll && !resolved.has(live.id)) resolved.set(live.id, ll);
          }
        }
        drawAll();
      });
  } else {
    drawAll();
  }
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
      // prefer a returnable plot under the cursor; otherwise show the
      // land-use area / road / unallocated parcel that is there
      const f = fc.features.find((x) => isRealPlotProps(x.properties)) || fc.features[0];
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
    if (!vb || !state.geoOk) { gpsNote(t("gpsNeedData")); map.setView([lat, lon], 16); return; }
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

/* ---------------- satellite / basemap, swipe compare, overlay layers ---------------- */
const baseSat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19, attribution: "Imagery \u00a9 Esri & partners",
});
// A second satellite instance drawn into the clipped "swipe" pane, used only
// in compare mode so we can reveal it on one side of a draggable divider.
const swipeSat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19, pane: "swipe", attribution: "Imagery \u00a9 Esri & partners",
});
let satOn = false;
$("btnSat").addEventListener("click", () => {
  satOn = !satOn;
  if (satOn) { map.addLayer(baseSat); } else { map.removeLayer(baseSat); }
  $("btnSat").classList.toggle("on", satOn);
  $("btnSat").title = satOn ? t("mapViewT") : t("satellite");
});
L.DomEvent.disableClickPropagation($("btnSat"));

/* ---- swipe compare: satellite on the right of a draggable divider ---- */
let swipeOn = false, swipeX = 0.5; // fraction of map width
function clipSwipe() {
  const pane = map.getPane("swipe");
  if (!swipeOn) { pane.style.clipPath = ""; return; }
  const w = map.getSize().x;
  const px = Math.round(w * swipeX);
  // pane is transformed during pan; translate the clip into its local space
  const originX = -(L.DomUtil.getPosition(map.getPanes().mapPane).x);
  pane.style.clipPath = `inset(0 0 0 ${originX + px}px)`;
  const handle = $("swipehandle");
  if (handle) handle.style.left = px + "px";
}
map.on("move zoom moveend zoomend resize", clipSwipe);
function setSwipe(on) {
  swipeOn = on;
  $("btnSwipe").classList.toggle("on", on);
  $("btnSwipe").title = on ? t("swipeOffT") : t("swipeT");
  const handle = $("swipehandle");
  if (on) {
    map.addLayer(swipeSat);
    handle.style.display = "block";
    clipSwipe();
  } else {
    map.removeLayer(swipeSat);
    handle.style.display = "none";
    map.getPane("swipe").style.clipPath = "";
  }
}
$("btnSwipe").addEventListener("click", () => setSwipe(!swipeOn));
L.DomEvent.disableClickPropagation($("btnSwipe"));
(function initSwipeDrag() {
  const h = $("swipehandle");
  const move = (clientX) => {
    const r = map.getContainer().getBoundingClientRect();
    swipeX = Math.min(0.98, Math.max(0.02, (clientX - r.left) / r.width));
    clipSwipe();
  };
  const down = (e) => {
    e.preventDefault();
    const mv = (ev) => move((ev.touches ? ev.touches[0] : ev).clientX);
    const up = () => {
      window.removeEventListener("mousemove", mv); window.removeEventListener("touchmove", mv);
      window.removeEventListener("mouseup", up); window.removeEventListener("touchend", up);
    };
    window.addEventListener("mousemove", mv); window.addEventListener("touchmove", mv, { passive: false });
    window.addEventListener("mouseup", up); window.addEventListener("touchend", up);
  };
  h.addEventListener("mousedown", down);
  h.addEventListener("touchstart", down, { passive: false });
  L.DomEvent.disableClickPropagation(h);
})();

/* ---- APCRDA overlay layers (real, verified services on gis.apcrda.org) ---- */
// These are the same host and technique as the working plot layer, so they're
// known to load. Each toggle is one APCRDA MapServer, limited to the useful
// sub-layers, drawn semi-transparent over the base map. Display-only: overlays
// never touch plot identity, the register, or the map view, and any layer that
// fails to load simply flips its switch back — the core atlas is unaffected.
const OVROOT = "https://gis.apcrda.org/server/rest/services/";
const OVERLAY_DEFS = [
  { key: "roads", labelEn: "Roads", labelTe: "\u0c30\u0c4b\u0c21\u0c4d\u0c32\u0c41", svc: "DMPRoads/MapServer", layers: [0, 1, 2, 8] },
  { key: "transport", labelEn: "Transport", labelTe: "\u0c30\u0c35\u0c3e\u0c23\u0c3e", svc: "APCRDATransportation/MapServer", layers: [0, 1, 4, 5] },
  { key: "boundaries", labelEn: "Boundaries", labelTe: "\u0c39\u0c26\u0c4d\u0c26\u0c41\u0c32\u0c41", svc: "APCRDAPlanningBoundaries/MapServer", layers: [2, 4, 6] },
  { key: "forests", labelEn: "Forests", labelTe: "\u0c05\u0c21\u0c35\u0c41\u0c32\u0c41", svc: "APCRDAForests/MapServer", layers: [2, 3] },
];
const overlayLayers = {}; // key -> { layer, on }

function toggleOverlay(key, on, cb) {
  const def = OVERLAY_DEFS.find((d) => d.key === key);
  if (!def) { cb && cb(false); return; }
  let rec = overlayLayers[key];
  if (on) {
    try {
      if (!rec) {
        rec = overlayLayers[key] = { layer: null, on: false };
        rec.layer = L.esri.dynamicMapLayer(esriOpts({
          url: OVROOT + def.svc,
          opacity: 0.75,
          layers: def.layers,
          pane: "apcrda",
        }));
      }
      let settled = false;
      const done = (ok) => { if (settled) return; settled = true; rec.on = ok; cb && cb(ok); };
      rec.layer.once("load", () => done(true));
      rec.layer.on("requesterror", () => { try { map.removeLayer(rec.layer); } catch (_) {} done(false); });
      setTimeout(() => { if (!settled) done(true); }, 8000); // slow service: keep if drawing
      rec.layer.addTo(map);
    } catch (_) { cb && cb(false); }
  } else {
    if (rec && rec.layer) { try { map.removeLayer(rec.layer); } catch (_) {} rec.on = false; }
    cb && cb(true);
  }
}

function overlayRowsHtml() {
  return OVERLAY_DEFS.map((def) => {
    const label = LANG === "te" ? def.labelTe : def.labelEn;
    const on = overlayLayers[def.key] && overlayLayers[def.key].on;
    return `<label class="lyrrow"><span>${esc(label)}</span>` +
      `<input type="checkbox" data-key="${def.key}"${on ? " checked" : ""}></label>`;
  }).join("");
}

function openLayers() {
  const panel = $("lyrpanel");
  const isOpen = panel.style.display === "block";
  if (isOpen) { panel.style.display = "none"; return; }
  panel.style.display = "block";
  $("lyrtitle").textContent = t("lyrTitle");
  $("lyrhint").textContent = t("lyrHint");
  $("lyrbody").innerHTML = overlayRowsHtml();
  $("lyrbody").querySelectorAll("input[data-key]").forEach((box) => {
    box.addEventListener("change", () => {
      const key = box.dataset.key;
      const span = box.parentElement.querySelector("span");
      const label = LANG === "te" ? OVERLAY_DEFS.find((d) => d.key === key).labelTe : OVERLAY_DEFS.find((d) => d.key === key).labelEn;
      box.disabled = true;
      span.innerHTML = esc(label) + ` <em>${esc(t("lyrLoadingOne"))}</em>`;
      toggleOverlay(key, box.checked, (ok) => {
        box.disabled = false;
        span.innerHTML = esc(label) + (!ok && box.checked ? ` <em>${esc(t("lyrFail"))}</em>` : "");
        if (!ok && box.checked) box.checked = false;
      });
    });
  });
}
/* ---- measure tool: point-to-point distance + area ---- */
const measure = { on: false, pts: [], line: null, markers: [], poly: null };
function fmtDist(m) {
  return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m";
}
function fmtArea(sqm) {
  const sqyd = sqm * 1.19599;
  if (sqyd < 12100) return Math.round(sqyd).toLocaleString("en-IN") + " sq yd"; // ~2.5 acres
  return Math.round(sqyd).toLocaleString("en-IN") + " sq yd (" + (sqm / 4046.856).toFixed(2) + " ac)";
}
function measureRedraw() {
  const pts = measure.pts;
  if (measure.line) { map.removeLayer(measure.line); measure.line = null; }
  if (measure.poly) { map.removeLayer(measure.poly); measure.poly = null; }
  if (pts.length >= 2) measure.line = L.polyline(pts, { color: "#B5361F", weight: 3, dashArray: "6 4" }).addTo(map);
  if (pts.length >= 3) measure.poly = L.polygon(pts, { color: "#B5361F", weight: 1, fillColor: "#B5361F", fillOpacity: 0.08, interactive: false }).addTo(map);
  let dist = 0;
  for (let i = 1; i < pts.length; i++) dist += map.distance(pts[i - 1], pts[i]);
  let txt = "";
  if (pts.length < 2) txt = t("measureHint");
  else {
    txt = t("measureDist") + ": " + fmtDist(dist);
    if (pts.length >= 3) {
      // shoelace area on projected metres via Leaflet's CRS
      let a = 0;
      const proj = pts.map((p) => map.options.crs.project(L.latLng(p)));
      for (let i = 0; i < proj.length; i++) {
        const j = (i + 1) % proj.length;
        a += proj[i].x * proj[j].y - proj[j].x * proj[i].y;
      }
      txt += " · " + t("measureArea") + ": " + fmtArea(Math.abs(a) / 2);
    }
  }
  $("measuretxt").textContent = txt;
}
function measureAdd(latlng) {
  measure.pts.push([latlng.lat, latlng.lng]);
  const m = L.circleMarker(latlng, { radius: 5, color: "#B5361F", fillColor: "#fff", fillOpacity: 1, weight: 2, pane: "markerPane" }).addTo(map);
  measure.markers.push(m);
  measureRedraw();
}
function measureClear() {
  measure.pts = [];
  measure.markers.forEach((m) => map.removeLayer(m)); measure.markers = [];
  if (measure.line) { map.removeLayer(measure.line); measure.line = null; }
  if (measure.poly) { map.removeLayer(measure.poly); measure.poly = null; }
  measureRedraw();
}
function setMeasure(on) {
  measure.on = on;
  $("btnMeasure").classList.toggle("on", on);
  $("btnMeasure").title = on ? t("measureOffT") : t("measureT");
  $("measurebar").style.display = on ? "flex" : "none";
  const c = map.getContainer();
  c.style.cursor = on ? "crosshair" : "";
  if (on) {
    $("measureclear").textContent = t("measureClear");
    $("measuredone").textContent = t("measureDone");
    measureRedraw();
  } else {
    measureClear();
  }
}
map.on("click", (e) => { if (measure.on) measureAdd(e.latlng); });
$("btnMeasure").addEventListener("click", () => setMeasure(!measure.on));
$("measureclear").addEventListener("click", measureClear);
$("measuredone").addEventListener("click", () => setMeasure(false));
L.DomEvent.disableClickPropagation($("btnMeasure"));
L.DomEvent.disableClickPropagation($("measurebar"));

/* ---- zone filter: server-side layerDefs so only matching plots draw ---- */
// The plot layer is a server-rendered image, so we can't grey out individual
// shapes client-side. Instead we ask the server to render ONLY the plots
// matching the chosen zone (+ village); everything else renders transparent,
// letting the base map show through — the "greyed out" effect.
const zoneFilter = { zone: null }; // e.g. "R4", "C", or null for all
function currentVillageClause() {
  const v = state.filters.village;
  return (v && v !== "__ALL__") ? " AND lpsvillage = '" + String(v).replace(/'/g, "''") + "'" : "";
}
function buildPlotDef() {
  const parts = [];
  if (zoneFilter.zone) {
    // family codes (single letter) match a whole family; specific like "R4" match exactly
    const z = zoneFilter.zone;
    parts.push(/^[A-Z]$/.test(z) ? "symbology LIKE '" + z + "%'" : "symbology LIKE '" + z + "%'");
  }
  const v = state.filters.village;
  if (v && v !== "__ALL__") parts.push("lpsvillage = '" + String(v).replace(/'/g, "''") + "'");
  return parts.length ? parts.join(" AND ") : null;
}
function applyMapFilter() {
  const def = buildPlotDef();
  try {
    if (def) lpsLayer.setLayerDefs({ 0: def });
    else if (lpsLayer.setLayerDefs) lpsLayer.setLayerDefs({});
  } catch (_) {}
  // reflect active state on legend rows + village-driven overlays
  document.querySelectorAll(".leg-row").forEach((r) => r.classList.toggle("active", r.dataset.zone === zoneFilter.zone));
  const clearBtn = $("legendclear");
  if (clearBtn) clearBtn.style.display = zoneFilter.zone ? "block" : "none";
  // keep enabled overlay layers filtered to the same village
  for (const key in overlayLayers) {
    const rec = overlayLayers[key];
    if (rec && rec.on && rec.layer && rec.layer.setLayerDefs) {
      const v = state.filters.village;
      // overlays have their own layer ids; village filtering is best-effort
      try { rec.layer.setLayerDefs(v && v !== "__ALL__" ? { } : {}); } catch (_) {}
    }
  }
}
function setZoneFilter(zone) {
  zoneFilter.zone = (zoneFilter.zone === zone) ? null : zone; // toggle off if same
  applyMapFilter();
}

/* ---- zone legend (built from the app's own ZONE_COLORS) ---- */
const LEGEND_ROWS = [
  { fam: "Residential", en: "Residential", te: "\u0c28\u0c3f\u0c35\u0c3e\u0c38", zones: [
    ["R1", "Village planning", "\u0c17\u0c4d\u0c30\u0c3e\u0c2e \u0c2a\u0c4d\u0c32\u0c3e\u0c28\u0c3f\u0c02\u0c17\u0c4d"],
    ["R2", "Low density", "\u0c24\u0c15\u0c4d\u0c15\u0c41\u0c35 \u0c38\u0c3e\u0c02\u0c26\u0c4d\u0c30\u0c24"],
    ["R3", "Medium\u2013high density", "\u0c2e\u0c27\u0c4d\u0c2f\u0c2e-\u0c05\u0c27\u0c3f\u0c15 \u0c38\u0c3e\u0c02\u0c26\u0c4d\u0c30\u0c24"],
    ["R4", "High density", "\u0c05\u0c27\u0c3f\u0c15 \u0c38\u0c3e\u0c02\u0c26\u0c4d\u0c30\u0c24"],
  ]},
  { fam: "Commercial", en: "Commercial", te: "\u0c35\u0c3e\u0c23\u0c3f\u0c1c\u0c4d\u0c2f", zones: [
    ["C1", "Convenience", "\u0c38\u0c46\u0c2c\u0c4d"],
    ["C2", "General commercial", "\u0c38\u0c3e\u0c27\u0c3e\u0c30\u0c23 \u0c35\u0c3e\u0c23\u0c3f\u0c1c\u0c4d\u0c2f"],
    ["C3", "Neighbourhood centre", "\u0c2a\u0c4a\u0c30\u0c41\u0c17\u0c41 \u0c15\u0c47\u0c02\u0c26\u0c4d\u0c30\u0c02"],
    ["C4", "Town centre", "\u0c1f\u0c4c\u0c28\u0c4d \u0c15\u0c47\u0c02\u0c26\u0c4d\u0c30\u0c02"],
    ["C5", "Regional centre", "\u0c2a\u0c4d\u0c30\u0c3e\u0c02\u0c24\u0c40\u0c2f \u0c15\u0c47\u0c02\u0c26\u0c4d\u0c30\u0c02"],
    ["C6", "Central business district", "\u0c38\u0c46\u0c02\u0c1f\u0c4d\u0c30\u0c32\u0c4d \u0c2c\u0c3f\u0c1c\u0c3f\u0c28\u0c46\u0c38\u0c4d"],
  ]},
  { fam: "Industry", en: "Industry", te: "\u0c2a\u0c30\u0c3f\u0c36\u0c4d\u0c30\u0c2e", zones: [
    ["I1", "Business park", "\u0c2c\u0c3f\u0c1c\u0c3f\u0c28\u0c46\u0c38\u0c4d \u0c2a\u0c3e\u0c30\u0c4d\u0c15\u0c4d"],
    ["I2", "Logistics", "\u0c32\u0c3e\u0c1c\u0c3f\u0c38\u0c4d\u0c1f\u0c3f\u0c15\u0c4d\u0c38\u0c4d"],
    ["I3", "Non-polluting industry", "\u0c15\u0c3e\u0c32\u0c41\u0c37\u0c4d\u0c2f\u0c30\u0c39\u0c3f\u0c24 \u0c2a\u0c30\u0c3f\u0c36\u0c4d\u0c30\u0c2e"],
  ]},
  { fam: "Parks", en: "Parks & open space", te: "\u0c2a\u0c3e\u0c30\u0c4d\u0c15\u0c41\u0c32\u0c41", zones: [
    ["P1", "Passive zone", "\u0c2a\u0c3e\u0c38\u0c3f\u0c35\u0c4d"],
    ["P2", "Active zone", "\u0c2f\u0c3e\u0c15\u0c4d\u0c1f\u0c3f\u0c35\u0c4d"],
    ["P3", "Protected zone", "\u0c38\u0c02\u0c30\u0c15\u0c4d\u0c37\u0c3f\u0c24"],
  ]},
  { fam: "Institutional", en: "Institutional", te: "\u0c38\u0c02\u0c38\u0c4d\u0c25\u0c3e\u0c17\u0c24", zones: [
    ["S1", "Government", "\u0c2a\u0c4d\u0c30\u0c2d\u0c41\u0c24\u0c4d\u0c35"],
    ["S2", "Education", "\u0c35\u0c3f\u0c26\u0c4d\u0c2f"],
    ["S3", "Special zone", "\u0c2a\u0c4d\u0c30\u0c24\u0c4d\u0c2f\u0c47\u0c15"],
  ]},
  { fam: "Reserve", en: "Reserve & roads", te: "\u0c30\u0c3f\u0c1c\u0c30\u0c4d\u0c35\u0c4d, \u0c30\u0c4b\u0c21\u0c4d\u0c32\u0c41", zones: [
    ["U1", "Utilities / reserve", "\u0c2f\u0c42\u0c1f\u0c3f\u0c32\u0c3f\u0c1f\u0c40\u0c38\u0c4d"],
    ["U2", "Road network", "\u0c30\u0c4b\u0c21\u0c4d \u0c28\u0c46\u0c1f\u0c4d\u0c35\u0c30\u0c4d\u0c15\u0c4d"],
  ]},
];
function openLegend() {
  const panel = $("legendpanel");
  const isOpen = panel.style.display === "flex";
  if (isOpen) { panel.style.display = "none"; return; }
  panel.style.display = "flex";
  $("legendtitle").textContent = t("legendTitle");
  let html = `<div class="leg-hint">${esc(t("legendFilterHint"))}</div>`;
  for (const g of LEGEND_ROWS) {
    html += `<div class="leg-group">${esc(LANG === "te" ? g.te : g.en)}</div>`;
    for (const [code, en, te] of g.zones) {
      const col = ZONE_COLORS[code] || "#CFCABB";
      html += `<div class="leg-row${zoneFilter.zone === code ? " active" : ""}" data-zone="${code}" role="button" tabindex="0">` +
        `<span class="leg-sw" style="background:${col}"></span>` +
        `<span class="leg-code">${code}</span><span class="leg-name">${esc(LANG === "te" ? te : en)}</span></div>`;
    }
  }
  $("legendbody").innerHTML = html;
  $("legendbody").querySelectorAll(".leg-row").forEach((r) => {
    const pick = () => setZoneFilter(r.dataset.zone);
    r.addEventListener("click", pick);
    r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
  });
  $("legendclear").textContent = t("legendClear");
  $("legendclear").style.display = zoneFilter.zone ? "block" : "none";
}
$("btnLegend").addEventListener("click", openLegend);
$("legendclose").addEventListener("click", () => { $("legendpanel").style.display = "none"; });
$("legendclear").addEventListener("click", () => { zoneFilter.zone = null; applyMapFilter(); });
L.DomEvent.disableClickPropagation($("legendpanel"));
L.DomEvent.disableScrollPropagation($("legendpanel"));
L.DomEvent.disableScrollPropagation($("legendbody"));
L.DomEvent.disableClickPropagation($("btnLegend"));

/* ---- collapse the register panel (desktop) ---- */
function setCollapsed(on) {
  document.body.classList.toggle("collapsed", on);
  $("collapseBtn").title = on ? t("expandT") : t("collapseT");
  setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 280);
}
$("collapseBtn").addEventListener("click", () => setCollapsed(true));
$("reopenBtn").addEventListener("click", () => setCollapsed(false));

$("btnLayers").addEventListener("click", openLayers);
$("lyrclose").addEventListener("click", () => { $("lyrpanel").style.display = "none"; });
L.DomEvent.disableClickPropagation($("lyrpanel"));
L.DomEvent.disableScrollPropagation($("lyrpanel"));
L.DomEvent.disableClickPropagation($("btnLayers"));

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

/* ---------------- Ask AI (RAG assistant) ----------------
   Retrieval happens HERE in the browser over the full register; only the
   matching records travel to the Cloudflare Worker, which holds the API key
   and generates the answer. Grounded, cheap, and the key never touches the
   client. */
function buildAskContext(question) {
  const sp = smartParse(question);
  const ql = (sp.rest || "").toLowerCase();
  let cand = state.plots;
  if (sp.village) cand = cand.filter((p) => p.village === sp.village);
  if (sp.family) cand = cand.filter((p) => zoneFamily(p.sym) === sp.family);
  if (sp.minExt != null) cand = cand.filter((p) => typeof p.ext === "number" && p.ext >= sp.minExt);
  let scored = cand;
  if (ql) {
    scored = cand.filter((p) =>
      (p.farmer && p.farmer.toLowerCase().includes(ql)) ||
      (p.code && p.code.toLowerCase().includes(ql)) ||
      (p.reg && p.reg.toLowerCase().includes(ql)));
  }
  const top = scored.slice(0, 25);
  const lines = top.map((p) =>
    [p.code || p.reg, p.village, p.no, zoneCode(p.sym), p.ext != null ? p.ext : "", p.farmer || "", p.regdate || ""].join(" | "));
  const totalExt = scored.reduce((a, p) => a + (typeof p.ext === "number" ? p.ext : 0), 0);
  lines.push(`TOTALS for this filter: ${scored.length} plots, ${Math.round(totalExt)} total extent` +
    (sp.village ? `, village=${sp.village}` : "") + (sp.family ? `, zone=${sp.family}` : ""));
  return lines.join("\n");
}
function linkifyCodes(text) {
  return esc(text).replace(/\b(\d{1,2}-[\d-]{3,24}[A-Z]\d{0,3})\b/g, (m) =>
    state.byCode.has(m) ? `<button type="button" class="asklink" data-code="${m}">${m}</button>` : m);
}
function askAppend(role, html) {
  const box = $("askmsgs");
  const d = document.createElement("div");
  d.className = "askmsg " + role;
  d.innerHTML = html;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  d.querySelectorAll(".asklink").forEach((b) => b.addEventListener("click", () => { openPlot(b.dataset.code); }));
  return d;
}
async function askSubmit() {
  const q = $("askinput").value.trim();
  if (!q) return;
  if (!CONFIG.ASK_ENDPOINT) { askAppend("bot", esc(t("askOffline"))); return; }
  $("askinput").value = "";
  askAppend("me", esc(q));
  const wait = askAppend("bot", esc(t("askThinking")));
  try {
    const r = await fetch(CONFIG.ASK_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: q, context: buildAskContext(q), lang: LANG }),
    });
    const j = await r.json();
    if (!r.ok || !j.answer) throw new Error(j.error || "no answer");
    wait.innerHTML = linkifyCodes(j.answer).replace(/\n/g, "<br>");
    wait.querySelectorAll(".asklink").forEach((b) => b.addEventListener("click", () => openPlot(b.dataset.code)));
  } catch (_) {
    wait.innerHTML = esc(t("askFail"));
  }
}
$("askbtn").addEventListener("click", () => {
  const p = $("askpanel");
  const open = p.style.display === "flex";
  p.style.display = open ? "none" : "flex";
  if (!open) { $("askhint").textContent = t("askHint"); $("askinput").placeholder = t("askPh"); $("asksend").textContent = t("askSend"); $("askinput").focus(); }
});
$("asksend").addEventListener("click", askSubmit);
$("askinput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askSubmit(); } });
L.DomEvent.disableClickPropagation($("askpanel"));
L.DomEvent.disableScrollPropagation($("askpanel"));
L.DomEvent.disableClickPropagation($("askbtn"));

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
  $("askbtn").textContent = "\u2726 " + t("askBtn");
  $("btnSwipe").title = swipeOn ? t("swipeOffT") : t("swipeT");
  $("btnLayers").title = t("lyrTitle");
  $("btnLegend").title = t("legendTitle");
  $("btnMeasure").title = measure.on ? t("measureOffT") : t("measureT");
  $("modePlots").textContent = t("modePlots");
  $("modeAlloc").textContent = t("modeAlloc");
  $("collapseBtn").title = document.body.classList.contains("collapsed") ? t("expandT") : t("collapseT");
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
function toast(msg) {
  const d = document.createElement("div");
  d.className = "toastmsg";
  d.setAttribute("role", "status");
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 3200);
}
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
