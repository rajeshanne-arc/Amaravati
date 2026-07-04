// Amaravati LPS Atlas — RAG assistant endpoint (Cloudflare Worker)
//
// The browser does the RETRIEVAL (it already holds the full plot register)
// and sends only the matching records here; this Worker does the GENERATION
// by calling the Anthropic API with your key, which never leaves Cloudflare.
//
// One-time setup:
//   1. Cloudflare dashboard -> Workers & Pages -> Create Worker -> paste this file.
//   2. Worker -> Settings -> Variables -> Add SECRET named ANTHROPIC_API_KEY
//      with your key from console.anthropic.com (starts sk-ant-...).
//   3. Deploy, copy the worker URL (https://<name>.<acct>.workers.dev),
//      set CONFIG.ASK_ENDPOINT in app.js to that URL, push.
//
// Costs: default model is Haiku. A typical question (~25 records of context)
// costs a fraction of a paisa; even thousands of questions a month stay in
// the low dollars. Keep an eye on console.anthropic.com usage.

const MODEL = "claude-haiku-4-5-20251001"; // fast + cheap; "claude-sonnet-4-6" for richer answers
const ALLOWED_ORIGIN = "https://rajeshanne-arc.github.io";
const MAX_QUESTION = 500;    // chars
const MAX_CONTEXT = 9000;    // chars of serialized records

const SYSTEM = `You are the assistant for the Amaravati LPS Atlas, an unofficial
viewer of APCRDA Land Pooling Scheme plot data. Answer ONLY from the records
provided in the user message. Rules:
- If the answer is not in the provided records, say so plainly; never guess.
- Quote plot codes exactly as given so the app can link them.
- Amounts are "extent (as recorded)" with no unit conversion.
- This is not a land record; for legal purposes people must verify at
  gis.apcrda.org/lps. Mention this only when the question is about ownership
  or disputes, not on every answer.
- If lang is "te", answer in simple Telugu; otherwise answer in English.
- Be concise: a short paragraph, or a short list of plots when listing.`;

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return new Response("POST only", { status: 405, headers: cors });

    let body;
    try { body = await request.json(); } catch (_) {
      return json({ error: "bad json" }, 400, cors);
    }
    const question = String(body.question || "").slice(0, MAX_QUESTION).trim();
    const context = String(body.context || "").slice(0, MAX_CONTEXT);
    const lang = body.lang === "te" ? "te" : "en";
    if (!question) return json({ error: "empty question" }, 400, cors);

    const userMsg =
      `lang: ${lang}\n\nMatching records from the register (pipe-separated: ` +
      `code | village | plot no | zone | extent | allottee | reg date):\n` +
      `${context || "(no records matched the question's filters)"}\n\n` +
      `Question: ${question}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system: SYSTEM,
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      return json({ error: "upstream " + r.status, detail: detail.slice(0, 200) }, 502, cors);
    }
    const data = await r.json();
    const answer = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return json({ answer }, 200, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ "content-type": "application/json" }, cors),
  });
}
