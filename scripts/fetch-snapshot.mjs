// scripts/fetch-snapshot.mjs
// Pulls all plot data from the APCRDA LPS_Plot service and writes:
//   data/plots.json          — compact register index (search, sort, details)
//   data/geo/<village>.json  — plot outlines per village, loaded on demand
//
// Splitting the heavy geometry out of the main file cuts the site's first
// load from ~65 MB to a few MB; outlines stream in per village only when
// a plot is opened or an owner view needs them.
//
// Runs on Node 18+ (global fetch). No dependencies.
//   node scripts/fetch-snapshot.mjs

import { writeFile, readFile, mkdir } from "node:fs/promises";

const SERVICE =
  "https://gis.apcrda.org/server/rest/services/APCRDAGIS/LPS_Plot/MapServer";
const LAYER = 0; // confirm at SERVICE/layers if plots move to another id
const PAGE = 1000; // service MaxRecordCount

// Fields kept in the register index. plotcoord is deliberately NOT here —
// it goes into the per-village geometry shards instead.
const INDEX_FIELDS = [
  "plot_code",
  "plot_no",
  "symbology",
  "lpsvillage",
  "township",
  "sector",
  "colony",
  "block",
  "alloted_ex",
  "polylength",
  "polywidth",
  "plot_categ",
  "regcode",
  "regcode_n",
  "regcode_s",
  "regcode_e",
  "regcode_w",
  "reg_date_1",
  "farmer_n", // allottee name — delete this line to keep names out of the repo
  "ESRI_OID", // needed so plots with blank codes still get a stable id
];

// Must match the app's id derivation exactly (app.js normalize()).
const deriveId = (a) => {
  const c = (a.plot_code || "").trim();
  const r = (a.regcode || "").trim();
  return c || r || (a.ESRI_OID != null ? "oid-" + a.ESRI_OID : "");
};
// Must match the app's villageSlug() exactly.
const slug = (v) =>
  String(v || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keyset pagination on ESRI_OID. Plain resultOffset paging on ArcGIS has no
// guaranteed order, so records get skipped or duplicated between pages —
// especially while the source data is being edited. Ordering by object id
// and asking for "everything after the last id I saw" is stable.
async function getPage(afterOid, attempt = 1) {
  const params = new URLSearchParams({
    where: afterOid == null ? "1=1" : `ESRI_OID > ${Number(afterOid)}`,
    outFields: "*",
    orderByFields: "ESRI_OID ASC",
    returnGeometry: "false",
    f: "json",
    resultRecordCount: String(PAGE),
  });
  const url = `${SERVICE}/${LAYER}/query?${params}`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(JSON.stringify(json.error));
    return json;
  } catch (err) {
    if (attempt >= 4) throw err;
    const wait = attempt * 1500;
    console.warn(`  page @${offset} failed (${err.message}) — retry in ${wait}ms`);
    await sleep(wait);
    return getPage(offset, attempt + 1);
  }
}

async function main() {
  console.log("Fetching LPS plot data from APCRDA…");
  const rawById = new Map(); // ESRI_OID -> attributes (dedupes any page overlap)
  let afterOid = null;

  for (;;) {
    const json = await getPage(afterOid);
    const feats = json.features || [];
    if (!feats.length) break;
    for (const f of feats) {
      const a = f.attributes;
      if (a && a.ESRI_OID != null && !rawById.has(a.ESRI_OID)) rawById.set(a.ESRI_OID, a);
    }
    afterOid = feats[feats.length - 1].attributes.ESRI_OID;
    console.log(`  ${rawById.size} records… (oid ≤ ${afterOid})`);
    if (feats.length < PAGE && json.exceededTransferLimit !== true) break;
    await sleep(300); // be polite to a government server
  }
  const raw = [...rawById.values()];

  if (!raw.length) {
    console.error("No records returned — leaving existing files untouched.");
    process.exit(1);
  }

  const generated = new Date().toISOString();

  // Refuse to overwrite a good snapshot with a suspiciously smaller one —
  // a short crawl (network trouble, server restart) must not eat records.
  let prevSnap = null;
  try { prevSnap = JSON.parse(await readFile("data/plots.json", "utf8")); } catch (_) {}
  if (prevSnap && Array.isArray(prevSnap.plots) && prevSnap.plots.length) {
    const floor = Math.floor(prevSnap.plots.length * 0.97);
    if (raw.length < floor) {
      console.error(`Fetched ${raw.length} records but the previous snapshot has ${prevSnap.plots.length} (allowed floor ${floor}).`);
      console.error("Refusing to overwrite — likely an incomplete crawl. Delete data/plots.json to force a rebuild.");
      process.exit(1);
    }
  }

  // ---- permanent change log -------------------------------------------
  // Compare this run against the previous snapshot and append any changes
  // (ownership, zone, extent, registration) to data/changes.json. The log
  // is append-only — entries are never removed — and git history preserves
  // every snapshot as a second permanent record.
  const TRACKED = ["farmer_n", "symbology", "alloted_ex", "reg_date_1", "regcode"];
  let changeLog = { since: generated, updated: generated, changes: [] };
  try {
    const c = JSON.parse(await readFile("data/changes.json", "utf8"));
    if (c && Array.isArray(c.changes)) changeLog = c;
  } catch (_) { /* first run — start a fresh log */ }
  if (prevSnap && Array.isArray(prevSnap.plots) && prevSnap.plots.length) {
    const prevById = new Map();
    for (const a of prevSnap.plots) { const id = deriveId(a); if (id && !prevById.has(id)) prevById.set(id, a); }
    const newById = new Map();
    for (const a of raw) { const id = deriveId(a); if (id && !newById.has(id)) newById.set(id, a); }
    const day = generated.slice(0, 10);
    let added = 0;
    for (const [id, a] of newById) {
      const old = prevById.get(id);
      if (!old) continue;
      for (const f of TRACKED) {
        const ov = String(old[f] ?? "").trim();
        const nv = String(a[f] ?? "").trim();
        if (ov !== nv && (ov || nv)) { changeLog.changes.push({ id, d: day, f, from: ov, to: nv }); added++; }
      }
    }
    changeLog.updated = generated;
    console.log(`Change log: ${added} new change(s) recorded — ${changeLog.changes.length} total since ${changeLog.since.slice(0, 10)}`);
  } else {
    console.log("Change log: no previous snapshot to compare — baseline established.");
  }

  // Split: compact index + per-village geometry shards
  const index = [];
  const shards = new Map(); // slug -> { id: coordString }
  const villageBounds = {}; // slug -> [minE, minN, maxE, maxN] for GPS lookup
  for (const a of raw) {
    const rec = {};
    for (const f of INDEX_FIELDS) {
      if (a[f] !== undefined && a[f] !== null) rec[f] = a[f];
    }
    index.push(rec);

    const id = deriveId(a);
    const coord = a.plotcoord;
    if (id && coord && String(coord).trim()) {
      const s = slug(a.lpsvillage);
      let m = shards.get(s);
      if (!m) { m = {}; shards.set(s, m); }
      if (!m[id]) m[id] = coord;
      // grow the village bbox from this plot's vertices
      for (const pair of String(coord).split(";")) {
        const c = pair.split(",");
        if (c.length < 2) continue;
        const e = parseFloat(c[0]), n = parseFloat(c[1]);
        if (!Number.isFinite(e) || !Number.isFinite(n)) continue;
        const b = villageBounds[s] || (villageBounds[s] = [e, n, e, n]);
        if (e < b[0]) b[0] = e; if (n < b[1]) b[1] = n;
        if (e > b[2]) b[2] = e; if (n > b[3]) b[3] = n;
      }
    }
  }

  await mkdir("data/geo", { recursive: true });

  await writeFile("data/changes.json", JSON.stringify(changeLog));

  const indexOut = { generated, source: `${SERVICE}/${LAYER}`, count: index.length, villageBounds, plots: index };
  const indexStr = JSON.stringify(indexOut);
  await writeFile("data/plots.json", indexStr);
  console.log(`Wrote data/plots.json — ${index.length} plots, ~${(indexStr.length / 1048576).toFixed(1)} MB`);

  let shardBytes = 0;
  for (const [s, m] of shards) {
    const str = JSON.stringify({ generated, plots: m });
    shardBytes += str.length;
    await writeFile(`data/geo/${s}.json`, str);
  }
  console.log(`Wrote ${shards.size} geometry shards under data/geo/ — ~${(shardBytes / 1048576).toFixed(1)} MB total (loaded per village on demand)`);
}

main().catch((e) => {
  console.error("Snapshot failed:", e.message);
  process.exit(1);
});
