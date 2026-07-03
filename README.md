# Amaravati LPS Atlas — unofficial live viewer

A static website that shows Amaravati Land Pooling Scheme returnable plots using
the public APCRDA GIS service. No build step, no server of your own — just
static files plus a free GitHub Action that refreshes the data nightly.

How data flows:

- The map layer is rendered live by APCRDA's own server on every pan/zoom.
- The register (search / filter / sort sidebar) reads `data/plots.json`, a
  snapshot refreshed every night by the included GitHub Action.
- Clicking a plot (on the map or in the register) queries APCRDA live for that
  one plot — geometry, current record, allottee — so details are always fresh.

## Deploy in 4 steps

1. **Create a GitHub repository** and upload everything in this folder
   (keep the folder structure, including `.github/`).

2. **Turn on hosting.** Easiest: repo Settings → Pages → "Deploy from a
   branch" → `main` / root. Your site appears at
   `https://<username>.github.io/<repo>/` in a minute or two.
   (Cloudflare Pages connected to the repo works the same and is faster.)

3. **Generate the first snapshot.** Repo → Actions tab → "Update LPS
   snapshot" → Run workflow. It pulls all plot attributes from APCRDA and
   commits `data/plots.json`; hosting redeploys automatically. After this it
   runs by itself every night at 03:00 IST.

4. **Check the status pill** on your live site.
   - **Green LIVE** — done. Everything works, no backend needed, ever.
   - **Red / BLOCKED** — APCRDA's server doesn't allow browsers on other
     domains to query it. Fix in ~5 minutes: deploy `worker/cors-proxy.js` as a
     free Cloudflare Worker (dash.cloudflare.com → Workers & Pages → Create →
     paste → Deploy), then put the worker URL into `CONFIG.PROXY` at the top of
     `app.js` and push. The register works from the snapshot either way.

Run locally any time with `npx serve` in this folder (don't open `index.html`
via `file://` — browsers block its network requests, which fakes a red pill).

## Things worth knowing

- **Layer id.** The code assumes plots are layer `0` of the `LPS_Plot`
  service. If APCRDA reorganises, check
  `https://gis.apcrda.org/server/rest/services/APCRDAGIS/LPS_Plot/MapServer/layers`
  and update `PLOT_LAYER` in `app.js` and `LAYER` in `scripts/fetch-snapshot.mjs`.
- **Allottee names** are deliberately NOT included in the snapshot, so your
  public repo doesn't become a bulk list of people's names. The site shows the
  allottee only when someone looks up a specific plot — same behaviour as the
  official viewer. The field list is at the top of `scripts/fetch-snapshot.mjs`.
- **Extent units** aren't stated by the service (`alloted_ex`). The UI labels
  it "as recorded"; once you've compared a few plots against official
  documents you can add a unit label confidently.
- **Basemap.** OpenStreetMap's public tiles are fine while you test. Before
  promoting the site, switch the tile URL in `app.js` to a keyed provider
  (MapTiler, Carto, etc. — free tiers are generous).
- **Be a good citizen.** Keep the unofficial disclaimer visible, keep the
  nightly (not hourly) refresh, and check crda.ap.gov.in for any data-use
  terms before attaching a custom domain and promoting it.

## Files

    index.html                     the site (UI shell + styles)
    app.js                         all behaviour; CONFIG block at the top
    data/plots.json                nightly snapshot (generated)
    scripts/fetch-snapshot.mjs     the fetcher the Action runs
    .github/workflows/update-data.yml   nightly refresh schedule
    worker/cors-proxy.js           only needed if the pill is red
