// Several AI providers behind one call, so one outage never stops the demo.
//
//   Groq    — very fast (Llama / GPT-OSS), free key at console.groq.com,
//             and Whisper for speech-to-text.
//   Gemini  — best at Hindi and Tamil text; also the fallback for speech.
//
// Every call tries the providers in order and moves on after an error,
// a quota limit or a slow reply. Providers without a key are skipped.
import { generate, textOf, apiKey as geminiKey, TEXT_MODELS, HttpError } from "./gemini.mjs";

const GROQ = "https://api.groq.com/openai/v1";
export const groqKey = () => String(process.env.GROQ_API_KEY || "").trim().replace(/^["']+|["']+$/g, "").trim();

const GROQ_CHAT_MODELS = [
  process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  process.env.GROQ_FALLBACK_MODEL || "openai/gpt-oss-120b",
];
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3";

const TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 5000;

// Groq is fastest; Gemini writes better Tamil. PROVIDER_ORDER overrides both,
// e.g. "gemini,groq".
function order(lang) {
  const set = String(process.env.PROVIDER_ORDER || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  const base = set.length ? set : (lang === "ta" ? ["gemini", "groq"] : ["groq", "gemini"]);
  return base.filter(p => (p === "groq" ? groqKey() : p === "gemini" ? geminiKey() : false));
}

export function configured() {
  return { groq: !!groqKey(), gemini: !!geminiKey() };
}

/* ------------------------------------------------------------------ Groq */
const groqCooldown = new Map();

async function groqChat({ system, history, user, temperature, maxTokens }) {
  const messages = [
    { role: "system", content: system },
    ...history.map(h => ({ role: h.role === "model" ? "assistant" : "user", content: h.text })),
    { role: "user", content: user },
  ];
  let lastErr;
  for (const model of GROQ_CHAT_MODELS) {
    if (groqCooldown.get(model) > Date.now()) continue;
    try {
      const body = { model, messages, temperature, max_tokens: maxTokens };
      if (model.startsWith("openai/gpt-oss")) { body.reasoning_effort = "low"; body.max_tokens = maxTokens + 600; }
      const r = await fetch(`${GROQ}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) {
        const t = await r.text();
        if (r.status === 429) groqCooldown.set(model, Date.now() + 60_000);
        if (r.status === 401) throw new HttpError(401, "The Groq API key is not valid.");
        lastErr = new HttpError(r.status, `Groq ${model} → HTTP ${r.status}: ${t.slice(0, 160)}`);
        continue;
      }
      const j = await r.json();
      const text = String(j.choices?.[0]?.message?.content || "").trim();
      if (text) return { text, model, provider: "groq" };
      lastErr = new HttpError(502, `Groq ${model} returned no text.`);
    } catch (e) {
      if (e.status === 401) throw e;
      // A timeout means Groq itself is struggling: go straight to the next
      // provider rather than spend another 5 s on a second Groq model.
      if (e.name === "TimeoutError" || e.name === "AbortError") throw new HttpError(504, `Groq ${model}: too slow`);
      lastErr = e.status ? e : new HttpError(504, `Groq ${model}: ${e.name === "TimeoutError" ? "too slow" : e.message}`);
    }
  }
  throw lastErr || new HttpError(503, "Groq unavailable.");
}

async function groqTranscribe({ audioB64, mimeType, lang }) {
  const ext = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : mimeType.includes("wav") ? "wav" : "webm";
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from(audioB64, "base64")], { type: mimeType }), `clip.${ext}`);
  fd.append("model", GROQ_STT_MODEL);
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");
  if (lang) fd.append("language", lang);
  const r = await fetch(`${GROQ}/audio/transcriptions`, {
    method: "POST", headers: { Authorization: `Bearer ${groqKey()}` }, body: fd,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new HttpError(r.status, `Groq Whisper → HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  const names = { english: "en", hindi: "hi", tamil: "ta", urdu: "ur", marathi: "mr", nepali: "ne", malayalam: "ml", telugu: "te", kannada: "kn" };
  const l = String(j.language || "").toLowerCase();
  return { text: String(j.text || "").trim(), lang: names[l] || l.slice(0, 2), provider: "groq" };
}

/* ---------------------------------------------------------------- Gemini */
async function geminiChat({ system, history, user, temperature, maxTokens }) {
  const { model, data } = await generate(TEXT_MODELS, {
    systemInstruction: { parts: [{ text: system }] },
    contents: [
      ...history.map(h => ({ role: h.role === "model" ? "model" : "user", parts: [{ text: h.text }] })),
      { role: "user", parts: [{ text: user }] },
    ],
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  });
  const text = textOf(data);
  if (!text) throw new HttpError(502, "Gemini returned no text (it may have been blocked by safety filters).");
  return { text, model, provider: "gemini" };
}

async function geminiTranscribe({ audioB64, mimeType, instruction }) {
  const { data } = await generate(TEXT_MODELS, {
    contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: audioB64 } }, { text: instruction }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 400 },
  });
  const raw = textOf(data);
  let out;
  try { out = JSON.parse(raw); } catch { out = { text: raw.replace(/^[{"\s]+|["}\s]+$/g, ""), lang: "" }; }
  return { text: String(out.text || "").trim(), lang: String(out.lang || ""), provider: "gemini" };
}

/* ---------------------------------------------------------------- public */
async function tryInOrder(list, fns, args) {
  if (!list.length) throw new HttpError(500, "No AI key is set. Add GROQ_API_KEY and/or GEMINI_API_KEY (Netlify → Site configuration → Environment variables, or .env locally).");
  const errors = [];
  for (const p of list) {
    try { return await fns[p](args); }
    catch (e) { errors.push(`${p}: ${e.message}`); console.warn(`[${p}] failed →`, String(e.message).slice(0, 160)); }
  }
  throw new HttpError(503, "All AI services failed. " + errors.join(" | "));
}

export function chatComplete(args) {
  return tryInOrder(order(args.lang), { groq: groqChat, gemini: geminiChat }, args);
}

/** Speech-to-text: Whisper (Groq) first — it is built for this — then Gemini. */
export function transcribe(args) {
  const list = ["groq", "gemini"].filter(p => (p === "groq" ? groqKey() : geminiKey()));
  return tryInOrder(list, { groq: groqTranscribe, gemini: geminiTranscribe }, args);
}
