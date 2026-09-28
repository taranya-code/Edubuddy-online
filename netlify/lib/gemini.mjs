// Shared Gemini helpers for the Netlify Functions.
// The API key lives only here, on the server side (Netlify env var GEMINI_API_KEY);
// it is never sent to the browser.

const API = "https://generativelanguage.googleapis.com/v1beta/models";

// Per-attempt time limits (ms). Raise them if you run locally with no 10 s cap.
const FIRST_TIMEOUT_MS = Number(process.env.GEMINI_FIRST_TIMEOUT_MS) || 5500;
const LAST_TIMEOUT_MS = Number(process.env.GEMINI_LAST_TIMEOUT_MS) || 25000;

// Model ids change often. Override any of these in Netlify → Site configuration →
// Environment variables without touching code.
export const TEXT_MODELS = [
  process.env.GEMINI_MODEL || "gemini-3.8-flash",
  process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite",
  process.env.GEMINI_FALLBACK_MODEL_2 || "gemini-3.1-flash-lite",
];
export const TTS_MODELS = [
  process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-lite-tts",
  process.env.GEMINI_TTS_FALLBACK_MODEL || "gemini-3.8-flash-tts",
];

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** POST generateContent, trying each model in turn on 404 / 429 / 5xx. */
// A model that answered 429 (free-tier quota; 3.8-flash allows only ~20 a day)
// is skipped for a while instead of costing a round trip on every question.
const cooldown = new Map();   // model → time it may be tried again
const COOLDOWN_MS = 10 * 60 * 1000;

export async function generate(models, body, opts = {}) {
  const firstTimeout = opts.firstTimeoutMs || FIRST_TIMEOUT_MS;
  const now = Date.now();
  const usable = models.filter(m => !(cooldown.get(m) > now));
  if (usable.length) models = usable;          // if every model is cooling down, try them all anyway
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new HttpError(500, "GEMINI_API_KEY is not set (add it to .env locally, or to Netlify environment variables).");

  let lastErr;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const last = i === models.length - 1;
    // A busy model can hang for 10-20 s before answering 503. Give every model
    // but the last a short leash so the fallback still fits in Netlify's 10 s.
    const timeoutMs = last ? LAST_TIMEOUT_MS : firstTimeout;
    let res;
    try {
      res = await fetch(`${API}/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
      lastErr = new HttpError(timedOut ? 504 : 502,
        timedOut ? `Gemini ${model} took longer than ${timeoutMs / 1000}s.` : `Could not reach Gemini: ${e.message}`);
      continue;
    }
    if (res.ok) return { model, data: await res.json() };

    const text = await res.text();
    lastErr = new HttpError(res.status, `Gemini ${model} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    if (res.status === 429) cooldown.set(model, Date.now() + COOLDOWN_MS);
    // Only fall through to the next model when a different model could plausibly work.
    if (![404, 429, 500, 503].includes(res.status)) break;
  }
  throw lastErr;
}

/** Concatenated text of the first candidate. */
export function textOf(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || "").join("").trim();
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function fail(err) {
  const status = err instanceof HttpError ? err.status : 500;
  console.error(err);
  return json({ error: err.message || String(err) }, status >= 400 ? status : 500);
}

export async function readJson(req, maxBytes = 5_000_000) {
  if (req.method !== "POST") throw new HttpError(405, "Use POST.");
  const raw = await req.text();
  if (raw.length > maxBytes) throw new HttpError(413, "Request too large.");
  try { return JSON.parse(raw); } catch { throw new HttpError(400, "Body must be JSON."); }
}
