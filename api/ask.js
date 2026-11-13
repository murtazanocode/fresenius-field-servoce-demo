// Claude step for the hosted Field Service Assistant demo.
// GET  -> { enabled } so the page knows whether to offer Claude.
// POST -> { action, ... } with header x-access-code. Actions:
//   read_image: what does the photo of the machine show?
//   diagnose:   ranked causes + a guided fix, from manual passages, past cases and team memory
//   verify:     does the technician's reading / photo satisfy a fix step?
// Manual passages and past cases are looked up here by id, so the prompt is always built
// from this deployment's own library.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

const corpus = JSON.parse(readFileSync(new URL("../corpus.json", import.meta.url), "utf8"));
const pastCases = JSON.parse(readFileSync(new URL("../past_cases.json", import.meta.url), "utf8")).cases;
const chunks = new Map(corpus.chunks.map((c) => [c.id, c]));
const docs = new Map(corpus.documents.map((d) => [d.id, d]));
const cases = new Map(pastCases.map((c) => [c.id, c]));
const MODELS = new Set(corpus.documents.flatMap((d) => d.models));
const client = new Anthropic(); // reads ANTHROPIC_API_KEY
const MODEL = "claude-opus-5-5";

const str = { type: "string" };
const obj = (props) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });
const SCHEMAS = {
  read_image: obj({
    shows_machine: { type: "boolean" },
    description: str, // what is visible, in a technician's words
    alarm_or_code: str, // exact code/message on screen, "" if none
    search_text: str, // a short symptom description to search the manuals with
  }),
  diagnose: obj({
    reply: str,
    declined: { type: "boolean" },
    decline_reason: str,
    causes: {
      type: "array",
      items: obj({
        cause: str,
        likelihood: { type: "string", enum: ["high", "medium", "low"] },
        reasoning: str,
        source: str,
        quote: str,
        history: { type: "array", items: str },
        history_note: str,
      }),
    },
    steps: { type: "array", items: obj({ instruction: str, source: str, quote: str, check: str }) },
    follow_up_question: str,
  }),
  verify: obj({
    verdict: { type: "string", enum: ["pass", "fail", "needs_more"] },
    explanation: str,
    source: str,
    quote: str,
  }),
};

const SYSTEM = `You are a field service assistant for technicians repairing Fresenius 2008-series hemodialysis machines.
You only use the evidence you are given: manual passages labelled [P1], [P2]..., past service cases labelled [C1]..., and the team's own closed cases labelled [M1]....
Quotes must be copied exactly, character for character, from a [P] passage. Never invent part numbers, values, limits or steps.
Past cases and memory show what usually fixed the problem in the field; use them to re-rank causes and say so, but the manual is the authority for procedures and limits.
This is a technical support tool for qualified service personnel; you do not give clinical advice about patients.`;

function passagesBlock(list) {
  return list.map((c, i) => {
    const d = docs.get(c.doc);
    return `[P${i + 1}] file ${d.file}, ${d.title}, P/N ${d.part_number} Rev ${d.rev}, ${d.page_numbers === "printed" ? "page" : "PDF page"} ${c.page}\n${c.text}`;
  }).join("\n\n---\n\n");
}
function casesBlock(list) {
  return list.map((c, i) => `[C${i + 1}] ${c.id} (${c.date}, ${c.machine}): symptom "${c.symptom}"; root cause "${c.root_cause}"; fix "${c.fix}"; first-time fix ${c.first_time_fix ? "yes" : "no"}`).join("\n");
}
function memoryBlock(list) {
  return list.map((m, i) => `[M${i + 1}] ${m.id} (${m.machine}): question "${m.question}"; fixed by "${m.fixed_by}"; note "${m.note}"`).join("\n");
}

const clip = (s, n) => String(s || "").slice(0, n);
function imageBlock(img) {
  if (!img) return null;
  if (!["image/jpeg", "image/png", "image/webp"].includes(img.media_type) || typeof img.data !== "string" || img.data.length > 3_500_000) throw new Error("bad_image");
  return { type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } };
}

function build(action, b) {
  const model = b.model;
  if (!MODELS.has(model)) throw new Error("bad_model");
  const img = imageBlock(b.image);
  if (action === "read_image") {
    if (!img) throw new Error("no_image");
    return [img, { type: "text", text: `A technician working on a ${model} hemodialysis machine sent this photo${b.note ? ` with the note "${clip(b.note, 300)}"` : ""}. Describe what it shows that matters for troubleshooting, copy any alarm text or code exactly as shown, and write a short symptom description to search the service manuals with. If it is not a photo of the machine or its display, set shows_machine to false.` }];
  }
  const ids = Array.isArray(b.ids) ? b.ids.slice(0, 8) : [];
  const passages = ids.map((id) => chunks.get(id));
  if (!passages.length || passages.some((c) => !c || !docs.get(c.doc).models.includes(model))) throw new Error("bad_passages");

  if (action === "diagnose") {
    const query = clip(b.query, 600).trim();
    if (!query) throw new Error("no_query");
    const past = (Array.isArray(b.case_ids) ? b.case_ids.slice(0, 4) : []).map((id) => cases.get(id)).filter(Boolean);
    const memory = (Array.isArray(b.memory) ? b.memory.slice(0, 3) : []).map((m) => ({ id: clip(m.id, 40), machine: clip(m.machine, 20), question: clip(m.question, 300), fixed_by: clip(m.fixed_by, 200), note: clip(m.note, 300) }));
    const history = (Array.isArray(b.history) ? b.history.slice(-6) : []).map((h) => `${h.role === "assistant" ? "Assistant" : "Technician"}: ${clip(h.text, 600)}`).join("\n");
    const text = `${history ? `Conversation so far:\n${history}\n\n` : ""}The technician (machine ${model}) now says:\n"${query}"\n${b.observation ? `\nFrom their photo: ${clip(b.observation, 500)}\n` : ""}
Manual passages (current revisions only):\n\n${passagesBlock(passages)}\n\n` +
      (past.length ? `Past service cases from the field:\n${casesBlock(past)}\n\n` : "") +
      (memory.length ? `This team's closed cases:\n${memoryBlock(memory)}\n\n` : "") +
      `Answer as a helpful senior colleague.
- reply: 1-3 short sentences for the chat, naming the most likely cause and, if past cases or memory changed the ranking, saying so.
- causes: 2-4 probable causes, most likely first. Each has a [P] passage label in source and an exact 1-3 line quote from that passage. In history list the [C]/[M] labels that support or change this cause (empty if none) and summarise them in history_note.
- steps: 3-6 concrete steps to confirm and fix the top cause, each taken from a [P] passage with an exact quote; check says what reading or observation confirms the step was done right.
- follow_up_question: one question that would narrow it down, or "".
If the evidence does not cover the problem, set declined to true and explain in decline_reason.`;
    return img ? [img, { type: "text", text }] : [{ type: "text", text }];
  }

  if (action === "verify") {
    const step = b.step || {};
    const text = `A technician working on a ${model} is doing this fix step:\n"${clip(step.instruction, 500)}"\nExpected check: "${clip(step.check, 300)}"\n\nThey report: "${clip(b.note, 600) || "(no note)"}"${img ? " and attached the photo above." : "."}\n\nManual passages:\n\n${passagesBlock(passages)}\n\n` +
      `Decide whether what they report shows the step was done correctly and the result is within the manual's limits. verdict pass if it clearly is, fail if it clearly is not (say what to do next), needs_more if you cannot tell (say exactly what reading or photo you need). source is the [P] label and quote an exact line from it that sets the limit or procedure.`;
    return img ? [img, { type: "text", text }] : [{ type: "text", text }];
  }
  throw new Error("bad_action");
}

// Light per-instance limit; the Anthropic Console spend limit is the real cap.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), w = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  w.push(now); hits.set(ip, w);
  return w.length > 30;
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

  const b = req.body || {};
  const action = b.action || "diagnose";
  let content;
  try { content = build(action, b); } catch (e) { return res.status(400).json({ error: e.message || "bad_request" }); }

  try {
    const msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 6000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMAS[action] } },
      messages: [{ role: "user", content }],
    });
    if (msg.stop_reason === "refusal") return res.status(200).json({ refused: true });
    const text = msg.content.filter((x) => x.type === "text").map((x) => x.text).join("");
    return res.status(200).json(JSON.parse(text));
  } catch (err) {
    console.error("ask failed", action, err && err.status, err && err.message);
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "rate_limited" });
    return res.status(502).json({ error: "upstream" });
  }
}
