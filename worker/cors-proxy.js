// worker/cors-proxy.js
// Deploy ONLY if the site's status pill shows BLOCKED (the APCRDA server
// didn't allow direct browser access from your domain).
//
// Deploy: dash.cloudflare.com → Workers & Pages → Create Worker → paste this
// → Deploy. Copy the worker URL (https://something.workers.dev) into
// CONFIG.PROXY at the top of app.js.
//
// Request format (esri-leaflet "classic proxy" style):
//   https://your-worker.workers.dev/?https://gis.apcrda.org/server/rest/...
//
// It only forwards to gis.apcrda.org — never turn it into an open proxy.

const ALLOW_PREFIX = "https://gis.apcrda.org/";

export default {
  async fetch(request) {
    if (request.method !== "GET") {
      return new Response("GET only", { status: 405 });
    }

    const i = request.url.indexOf("?");
    if (i === -1) {
      return new Response("Usage: /?<target-url>", { status: 400 });
    }

    const target = request.url.slice(i + 1);
    if (!target.startsWith(ALLOW_PREFIX)) {
      return new Response("Target not allowed", { status: 403 });
    }

    const upstream = await fetch(target, {
      headers: { accept: request.headers.get("accept") || "*/*" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });

    const headers = new Headers(upstream.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.delete("set-cookie");

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};
