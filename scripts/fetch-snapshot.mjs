// scripts/fetch-snapshot.mjs
// Pulls all plot ATTRIBUTES from the APCRDA LPS_Plot service into data/plots.json.
// Runs on Node 18+ (uses global fetch). No dependencies.
//
//   node scripts/fetch-snapshot.mjs
//
// Notes:
// - Attributes only (returnGeometry=false) so the file stays small and the
//   repo stays under GitHub limits. The live map layer supplies the visuals.
// - farmer_n (allottee name) is EXCLUDED by default. The site looks names up
//   live, per plot, like the official viewer — instead of republishing a bulk
//   list of people's names in a public repo. Add it below only if you've
//   decided that's appropriate for your site.

import { writeFile, mkdir } from "node:fs/promises";

const SERVICE =
  "https://gis.apcrda.org/server/rest/services/APCRDAGIS/LPS_Plot/MapServer";
const LAYER = 0; // confirm at SERVICE/layers if plots move to another id
const PAGE = 1000; // service MaxRecordCount

const FIELDS = [
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
  // "farmer_n",  // intentionally off — see note above
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPage(offset, attempt = 1) {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "*",
    returnGeometry: "false",
    f: "json",
    resultOffset: String(offset),
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
  console.log("Fetching LPS plot attributes from APCRDA…");
  const plots = [];
  let offset = 0;

  for (;;) {
    const json = await getPage(offset);
    const feats = json.features || [];
    for (const f of feats) plots.push(f.attributes);
    console.log(`  ${offset + feats.length} records…`);
    const more = json.exceededTransferLimit === true || feats.length === PAGE;
    if (!feats.length || !more) break;
    offset += feats.length;
    await sleep(300); // be polite to a government server
  }

  if (!plots.length) {
    console.error("No records returned — leaving existing snapshot untouched.");
    process.exit(1);
  }

  const out = {
    generated: new Date().toISOString(),
    source: `${SERVICE}/${LAYER}`,
    count: plots.length,
    plots,
  };

  await mkdir("data", { recursive: true });
  await writeFile("data/plots.json", JSON.stringify(out));
  const mb = (JSON.stringify(out).length / 1048576).toFixed(1);
  console.log(`Wrote data/plots.json — ${plots.length} plots, ~${mb} MB`);
}

main().catch((e) => {
  console.error("Snapshot failed:", e.message);
  process.exit(1);
});
