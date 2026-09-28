// POST /api/speak   { text, lang } → audio/wav
//
// Used only when the browser has no voice for the language (Tamil is missing on
// many Windows and Android setups). Where a browser voice exists the page speaks
// locally and this function is never called, which keeps API usage low.
import { generate, fail, readJson, TTS_MODELS, HttpError } from "../lib/gemini.mjs";

const NAMES = { en: "English", hi: "Hindi", ta: "Tamil" };

/** Wrap raw 16-bit mono PCM in a WAV header. */
function pcmToWav(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export default async (req) => {
  try {
    const body = await readJson(req, 20_000);
    const text = String(body.text || "").trim().slice(0, 600);
    if (!text) return new Response(null, { status: 204 });
    const lang = NAMES[body.lang] ? body.lang : "en";

    const { data } = await generate(TTS_MODELS, {
      contents: [{
        role: "user",
        parts: [{ text }],   // TTS speaks every word it is sent, so send only the answer
      }],
      generationConfig: { responseModalities: ["AUDIO"] },
    });

    const part = (data?.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);
    if (!part) throw new HttpError(502, "No audio returned.");

    let audio = Buffer.from(part.inlineData.data, "base64");
    const mime = part.inlineData.mimeType || "";
    // Newer models return a full WAV; older ones return headerless L16 PCM.
    if (audio.subarray(0, 4).toString() !== "RIFF") {
      const rate = Number((mime.match(/rate=(\d+)/) || [])[1]) || 24000;
      audio = pcmToWav(audio, rate);
    }
    return new Response(audio, {
      status: 200,
      headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
    });
  } catch (err) {
    return fail(err);
  }
};

export const config = { path: "/api/speak" };
