// Claude step for the hosted Field Service Assistant demo.
// GET  -> { enabled } so the page knows whether to offer Claude reasoning.
// POST -> { query, model, ids } with header x-access-code. The prompt is rebuilt here from
//         this deployment's own corpus, so the endpoint cannot be used as a general Claude proxy.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

const corpus = JSON.parse(readFileSync(new URL("../corpus.json", import.meta.url), "utf8"));
const chunks = new Map(corpus.chunks.map((c) => [c.id, c]));
const docs = new Map(corpus.documents.map((d) => [d.id, d]));
const client = new Anthropic(); // reads ANTHROPIC_API_KEY

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["declined", "decline_reason", "causes"],
  properties: {
    declined: { type: "boolean" },
    decline_reason: { type: "string" },
    causes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["cause", "reasoning", "passage", "quote"],
        properties: { cause: { type: "string" }, reasoning: { type: "string" }, passage: { type: "string" }, quote: { type: "string" } },
      },
    },
  },
};

// Same wording as promptFor() in index.html, so hosted answers match the in-Claude demo.
function promptFor(query, model, hits) {
  const passages = hits.map((c, i) => {
    const d = docs.get(c.doc);
    return `[P${i + 1}] ${d.title} (P/N ${d.part_number} Rev ${d.rev}, ${d.page_numbers === "printed" ? "page" : "PDF page"} ${c.page})\n${c.text}`;
  }).join("\n\n---\n\n");
  return `You support a field service technician repairing a ${model} hemodialysis machine. The technician reports:\n"${query}"\n\n` +
    `Below are passages from the current revision of the manufacturer's documentation. Use ONLY these passages.\n\n${passages}\n\n` +
    `Return 2 to 5 probable root causes, most likely first. For each: a short cause title, one or two sentences of reasoning that connects the symptom to the passage, ` +
    `the passage label, and a quote copied EXACTLY (character for character, 1-3 lines) from that passage that supports it. ` +
    `If the passages do not support any cause, decline instead. Never invent part numbers, values or steps that are not in the passages.`;
}

// Light per-instance limit; the Anthropic Console spend limit is the real cap.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), w = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  w.push(now); hits.set(ip, w);
  return w.length > 20;
}

function codeOk(given) {
  const want = process.env.DEMO_ACCESS_CODE || "";
  const a = Buffer.from(String(given || "")), b = Buffer.from(want);
  return want.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method === "GET") return res.status(200).json({ enabled: !!process.env.ANTHROPIC_API_KEY && !!process.env.DEMO_ACCESS_CODE });
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  if (!codeOk(req.headers["x-access-code"])) return res.status(401).json({ error: "access_code" });
  if (limited(String(req.headers["x-forwarded-for"] || "").split(",")[0])) return res.status(429).json({ error: "rate_limited" });

  const { query, model, ids } = req.body || {};
  const models = new Set(corpus.documents.flatMap((d) => d.models));
  if (typeof query !== "string" || !query.trim() || query.length > 500 || !models.has(model) || !Array.isArray(ids) || !ids.length || ids.length > 8)
    return res.status(400).json({ error: "bad_request" });
  const passages = ids.map((id) => chunks.get(id));
  if (passages.some((c) => !c || !docs.get(c.doc).models.includes(model))) return res.status(400).json({ error: "bad_passages" });

  try {
    const msg = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: promptFor(query.trim(), model, passages) }],
    });
    if (msg.stop_reason === "refusal") return res.status(200).json({ declined: true, decline_reason: "Claude declined to answer this request.", causes: [] });
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return res.status(200).json(JSON.parse(text));
  } catch (err) {
    console.error("ask failed", err && err.status, err && err.message);
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "rate_limited" });
    return res.status(502).json({ error: "upstream" });
  }
}
