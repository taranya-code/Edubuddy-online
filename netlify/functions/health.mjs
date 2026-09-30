// GET /api/health — checks every AI key WITHOUT revealing it.
// Open https://<your-site>.netlify.app/api/health before a demo.
import { apiKey as geminiKey, json } from "../lib/gemini.mjs";
import { groqKey } from "../lib/providers.mjs";

async function check(url, headers) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
    if (r.ok) return { ok: true };
    const e = await r.json().catch(() => ({}));
    return { ok: false, status: r.status, message: (e.error?.message || JSON.stringify(e)).slice(0, 200) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

export default async () => {
  const g = geminiKey(), q = groqKey();
  const [gemini, groq] = await Promise.all([
    g ? check("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { "x-goog-api-key": g })
      : { ok: false, message: "GEMINI_API_KEY not set" },
    q ? check("https://api.groq.com/openai/v1/models", { Authorization: `Bearer ${q}` })
      : { ok: false, message: "GROQ_API_KEY not set" },
  ]);
  const working = [gemini.ok && "gemini", groq.ok && "groq"].filter(Boolean);
  return json({
    ready: working.length > 0,
    backupReady: working.length > 1,
    working,
    gemini,
    groq,
    advice: working.length > 1 ? "Both AI services work — a failure in one is covered by the other."
      : working.length === 1 ? `Only ${working[0]} works. Add the other key for a backup.`
      : "No AI key works. Set GEMINI_API_KEY and/or GROQ_API_KEY, then redeploy.",
  });
};

export const config = { path: "/api/health" };
