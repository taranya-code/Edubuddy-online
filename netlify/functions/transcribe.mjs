// POST /api/transcribe
// { audio: <base64>, mimeType: "audio/webm" | "audio/mp4" | ..., lang: "auto"|"en"|"hi"|"ta" }
// → { text, lang }
//
// Replaces the offline Whisper step. Whisper (Groq) or Gemini hears the clip and returns the
// transcript in its native script plus the language, which is folded onto
// en/hi/ta exactly as config.normalise_lang() does offline.
import { json, fail, readJson, HttpError } from "../lib/gemini.mjs";
import { transcribe } from "../lib/providers.mjs";

const NEIGHBOURS = {
  ur: "hi", mr: "hi", ne: "hi", sa: "hi", bh: "hi", pa: "hi",
  ml: "ta", te: "ta", kn: "ta", si: "ta",
};
function normaliseLang(code) {
  code = String(code || "").toLowerCase().trim().slice(0, 2);
  if (["en", "hi", "ta"].includes(code)) return code;
  return NEIGHBOURS[code] || "en";
}

function scriptLang(text) {
  let dev = 0, tam = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c >= 0x0900 && c <= 0x097f) dev++;
    else if (c >= 0x0b80 && c <= 0x0bff) tam++;
  }
  if (tam > dev && tam > 0) return "ta";
  if (dev > 0) return "hi";
  return "en";
}

const NAMES = { en: "English", hi: "Hindi", ta: "Tamil" };

export default async (req) => {
  try {
    // ~20 s of Opus is well under 200 KB; the cap guards the 6 MB function limit.
    const body = await readJson(req, 4_500_000);
    const audio = String(body.audio || "");
    if (!audio) throw new HttpError(400, "No audio.");
    const mimeType = String(body.mimeType || "audio/webm").split(";")[0];
    const forced = ["en", "hi", "ta"].includes(body.lang) ? body.lang : null;

    const instruction =
      "Transcribe this student's spoken question exactly. " +
      (forced
        ? `The speaker is using ${NAMES[forced]}. Write the transcript in ${NAMES[forced]}'s native script.`
        : "The speaker uses English, Hindi or Tamil. Write Hindi in Devanagari and Tamil in Tamil script, never romanised.") +
      ' Reply with JSON only: {"text": "<transcript>", "lang": "<ISO 639-1 code>"}.' +
      ' If there is no intelligible speech, reply {"text": "", "lang": ""}.';

    // Whisper on Groq first (made for speech), Gemini as the fallback.
    const out = await transcribe({ audioB64: audio, mimeType, lang: forced, instruction });

    const text = String(out.text || "").trim();
    const lang = forced || (text ? (scriptLang(text) !== "en" ? scriptLang(text) : normaliseLang(out.lang)) : "en");
    return json({ text, lang });
  } catch (err) {
    return fail(err);
  }
};

export const config = { path: "/api/transcribe" };
