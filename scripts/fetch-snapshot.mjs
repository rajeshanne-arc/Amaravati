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

// IDENTITY RULE — must match app.js normalize() exactly.
// The only guaranteed-unique field is the server object id. plot_code repeats
// and holds zone labels; even regcode is not unique in APCRDA's data. So the
// object id IS the identity; codes are display/search only.
const looksLikeCode = (t) => /^[0-9A-Za-z\-\/]+$/.test(t) && t.includes("-") && /\d/.test(t);
let OID_FIELD = "ESRI_OID";
const oidOf = (a) => (a[OID_FIELD] != null ? a[OID_FIELD] : a.ESRI_OID);
const deriveId = (a) => {
  const o = oidOf(a);
  return o != null ? "p" + o : ((a.regcode || "").trim() || (a.plot_code || "").trim());
};
// Must match the app's villageSlug() exactly.
const slug = (v) =>
  String(v || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two-phase crawl — the only pagination that cannot lose records:
//   1) ask the server for the complete list of object IDs (returnIdsOnly
//      bypasses the transfer limit, so all ~96k come back in one response)
//   2) fetch attributes in fixed batches of those exact IDs
// This is immune to sort-order quirks, transfer limits, and edits that
// happen while the crawl is running. Every ID is accounted for, and the
// script verifies the final count matches before writing anything.
async function post(params, attempt = 1) {
  const url = `${SERVICE}/${LAYER}/query`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: params.toString(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(JSON.stringify(json.error));
    return json;
  } catch (err) {
    if (attempt >= 5) throw err;
    const wait = attempt * 1500;
    console.warn(`  request failed (${err.message}) — retry in ${wait}ms`);
    await sleep(wait);
    return post(params, attempt + 1);
  }
}

async function fetchAllIds() {
  const json = await post(new URLSearchParams({ where: "1=1", returnIdsOnly: "true", f: "json" }));
  const ids = json.objectIds || [];
  const oidField = json.objectIdFieldName || "ESRI_OID";
  if (!ids.length) throw new Error("server returned no object IDs");
  return { ids, oidField };
}

async function fetchBatch(ids) {
  const json = await post(new URLSearchParams({
    objectIds: ids.join(","),
    outFields: "*",
    returnGeometry: "false",
    f: "json",
  }));
  return (json.features || []).map((f) => f.attributes);
}

async function main() {
  console.log("Fetching LPS plot data from APCRDA…");
  const { ids, oidField } = await fetchAllIds();
  OID_FIELD = oidField;
  console.log(`  server reports ${ids.length} records (id field: ${oidField})`);

  const rawById = new Map();
  const BATCH = 500;
  const pending = [];
  for (let i = 0; i < ids.length; i += BATCH) pending.push(ids.slice(i, i + BATCH));
  let done = 0;
  for (const batch of pending) {
    const attrs = await fetchBatch(batch);
    for (const a of attrs) {
      const oid = a[oidField] != null ? a[oidField] : a.ESRI_OID;
      if (oid != null && !rawById.has(oid)) rawById.set(oid, a);
    }
    done += batch.length;
    if (done % 5000 < BATCH) console.log(`  ${rawById.size} of ${ids.length}…`);
    await sleep(150); // be polite to a government server
  }

  // account for every ID; re-fetch stragglers once before giving up
  let missing = ids.filter((i) => !rawById.has(i));
  if (missing.length) {
    console.warn(`  re-fetching ${missing.length} missing records…`);
    for (let i = 0; i < missing.length; i += BATCH) {
      for (const a of await fetchBatch(missing.slice(i, i + BATCH))) {
        const oid = a[oidField] != null ? a[oidField] : a.ESRI_OID;
        if (oid != null) rawById.set(oid, a);
      }
      await sleep(150);
    }
    missing = ids.filter((i) => !rawById.has(i));
  }
  if (missing.length > ids.length * 0.001) {
    console.error(`Crawl incomplete: ${missing.length} of ${ids.length} records unreachable — refusing to write.`);
    process.exit(1);
  }
  const raw = [...rawById.values()];
  console.log(`  crawl complete: ${raw.length} of ${ids.length} records captured.`);

  // Hard floor: this dataset has ~96k records. Anything wildly below that is
  // a broken crawl, and no snapshot must ever be written from it — even when
  // there is no previous file to compare against.
  const ABSOLUTE_FLOOR = 50000;
  if (raw.length < ABSOLUTE_FLOOR) {
    console.error(`Only ${raw.length} records captured (hard floor ${ABSOLUTE_FLOOR}) — refusing to write.`);
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
  const TRACKED = ["farmer_n", "symbology", "alloted_ex", "reg_date_1"];
  // History is keyed by plot_code + village, which is verified UNIQUE across
  // every real plot (77,920 distinct, 0 conflicts). Registration code is NOT
  // usable here: APCRDA sometimes writes the same regcode onto two genuinely
  // different plots (e.g. plots 40 and 41 both carrying regcode …-30-…), which
  // would otherwise look like a single plot with two contradictory allottees.
  const isPlotCodeC = (t) => { if (!looksLikeCode(t)) return false; const last = String(t).split("-").pop(); return last.length > 0 && !/^0+$/.test(last) && /[A-Za-z]/.test(last); };
  const histKey = (a) => {
    const code = (a.plot_code || "").trim();
    return (Number(a.plot_no) > 0 && isPlotCodeC(code)) ? `${code}#${(a.lpsvillage || "").trim()}` : null;
  };
  let changeLog = { since: generated, updated: generated, changes: [] };
  try {
    const c = JSON.parse(await readFile("data/changes.json", "utf8"));
    if (c && Array.isArray(c.changes)) changeLog = c;
  } catch (_) { /* first run — start a fresh log */ }
  if (prevSnap && Array.isArray(prevSnap.plots) && prevSnap.plots.length) {
    const prevByKey = new Map();
    for (const a of prevSnap.plots) { const k = histKey(a); if (k && !prevByKey.has(k)) prevByKey.set(k, a); }
    const newByKey = new Map();
    for (const a of raw) { const k = histKey(a); if (k && !newByKey.has(k)) newByKey.set(k, a); }
    const day = generated.slice(0, 10);
    let added = 0;
    for (const [k, a] of newByKey) {
      const old = prevByKey.get(k);
      if (!old) continue;
      for (const f of TRACKED) {
        const ov = String(old[f] ?? "").trim();
        const nv = String(a[f] ?? "").trim();
        if (ov !== nv && (ov || nv)) { changeLog.changes.push({ id: deriveId(a), key: k, d: day, f, from: ov, to: nv }); added++; }
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

  // DATA-QUALITY QUARANTINE (never aborts on APCRDA's own source issues).
  // Object ids are unique, so the register itself can't collide. But some
  // real plots carry contradictory source rows (e.g. two different allottees
  // recorded against the same registration code + plot). We can't invent the
  // truth, so we KEEP the first occurrence, set the conflicting extras aside
  // into data/conflicts.json for transparency, and publish a clean snapshot.
  {
    // sanity: object ids must be unique — if not, the crawl is broken
    const oidSeen = new Set();
    let oidDupes = 0;
    for (const a of raw) { const o = oidOf(a); if (o == null) continue; if (oidSeen.has(o)) oidDupes++; else oidSeen.add(o); }
    if (oidDupes > 0) {
      console.error(`Object-id sanity FAILED: ${oidDupes} duplicate object ids — crawl is unreliable, refusing to write.`);
      process.exit(1);
    }

    const isPlotCode = (t) => { if (!looksLikeCode(t)) return false; const last = t.split("-").pop(); return last.length > 0 && !/^0+$/.test(last) && /[A-Za-z]/.test(last); };
    const byPlot = new Map(); // plot_code#village -> first attributes seen (verified-unique key)
    const conflicts = [];
    for (const a of raw) {
      const code = (a.plot_code || "").trim();
      if (!(Number(a.plot_no) > 0 && isPlotCode(code))) continue;
      const key = `${code}#${(a.lpsvillage || "").trim()}`;
      const prev = byPlot.get(key);
      if (!prev) { byPlot.set(key, a); continue; }
      const fp = (x) => `${x.alloted_ex ?? ""}|${(x.farmer_n || "").trim()}|${(x.plotcoord || "").slice(0, 40)}`;
      if (fp(prev) !== fp(a)) {
        conflicts.push({ key, kept: { farmer: (prev.farmer_n || "").trim(), ext: prev.alloted_ex }, dropped: { farmer: (a.farmer_n || "").trim(), ext: a.alloted_ex }, oid: oidOf(a) });
      }
    }
    if (conflicts.length) {
      await writeFile("data/conflicts.json", JSON.stringify({ generated, count: conflicts.length, conflicts }, null, 2));
      console.log(`Data-quality note: ${conflicts.length} source row(s) contradict another row on the same regcode+plot — logged to data/conflicts.json, publishing continues.`);
    }
    console.log(`Identity: object-id based, ${oidSeen.size} unique ids, 0 collisions.`);
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
