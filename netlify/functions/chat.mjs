// POST /api/chat
// { message, lang: "en"|"hi"|"ta", excerpts: [{text, cite}], history: [{role, text}] }
// → { reply, lang, citations, grounded, notInBook, model }
//
// Same prompts and grounding rules as the offline build (config.py): short,
// speakable answers; when textbook excerpts are supplied the model may only use
// them, and must emit [NOTINBOOK] when they do not answer the question. The
// marker is stripped here and the citations dropped, so an ungrounded answer can
// never be displayed as if it were sourced.
import { json, fail, readJson, HttpError } from "../lib/gemini.mjs";
import { chatComplete } from "../lib/providers.mjs";

const LANGS = ["en", "hi", "ta"];
const MARKER = "[NOTINBOOK]";

const BASE_RULES =
  "You are EduBuddy, a friendly school tutor for students aged 10-15. " +
  "Your answer will be READ ALOUD, so: use short plain sentences, no markdown, " +
  "no bullet points, no asterisks, no emoji, no code blocks. " +
  "Answer in AT MOST 2 or 3 short sentences, under 40 words total. " +
  "State the answer first, then at most one short line of explanation. " +
  "Never repeat yourself and never pad the answer.";

const SYSTEM = {
  en: BASE_RULES + " Always answer in English.",
  hi: BASE_RULES + " हमेशा सरल हिंदी में उत्तर दें। देवनागरी लिपि का प्रयोग करें।" +
      " हर वाक्य हिंदी में होना चाहिए। अंग्रेज़ी में कुछ भी न लिखें।",
  ta: BASE_RULES + " எப்போதும் எளிய தமிழில் பதில் அளிக்கவும். தமிழ் எழுத்துகளைப்" +
      " பயன்படுத்தவும். ஒவ்வொரு வாக்கியமும் தமிழில் இருக்க வேண்டும்." +
      " ஆங்கிலத்தில் எதையும் எழுத வேண்டாம்.",
};

const GROUNDING = {
  en:
    "Textbook excerpts are provided below. The textbook is the ONLY source you " +
    "may use, and it overrides anything you believe. Do not add facts, dates, " +
    "names or numbers that are not written in the excerpts.\n" +
    "When the answer is a specific word, number or name, copy it EXACTLY as " +
    "written in the excerpts. If the excerpts give a list of pairs, pick the " +
    "one item the question asks about and state it plainly first.\n" +
    "Textbook chapters are often narrated in the first person by their " +
    "subject. Do not answer as \"I\" or \"me\". If the excerpts state the " +
    "narrator's name (for example \"I am Godavari\"), use that name. If they " +
    "do NOT name the narrator, say that the excerpts do not say who is " +
    "speaking — never substitute another name that merely appears nearby.\n" +
    `If the excerpts do not actually answer the question, start your reply ` +
    `with ${MARKER} and then say briefly what the excerpts do cover. ` +
    "Being honest that the book does not say is always better than guessing.",
  hi:
    "नीचे पाठ्यपुस्तक के अंश दिए गए हैं। केवल इन्हीं का प्रयोग करें। " +
    "अंशों में जो नहीं लिखा है, ऐसे तथ्य, तारीख, नाम या संख्या मत जोड़ें।\n" +
    "पाठ अक्सर उत्तम पुरुष में लिखे होते हैं। उत्तर में कभी \"मैं\" न लिखें — " +
    "अंशों से पहचानें कि कहने वाला कौन है और उसका नाम लिखें।\n" +
    `यदि अंशों में उत्तर नहीं है, तो उत्तर के आरंभ में ${MARKER} लिखें ` +
    "और संक्षेप में बताएं कि अंशों में क्या है। अनुमान लगाने से अच्छा है सच बताना।",
  ta:
    "கீழே பாடநூல் பகுதிகள் உள்ளன. அவற்றை மட்டுமே பயன்படுத்தவும். " +
    "பகுதிகளில் இல்லாத தகவல், தேதி, பெயர் அல்லது எண்களை சேர்க்கக் கூடாது.\n" +
    "பதில் ஒரு குறிப்பிட்ட சொல், எண் அல்லது பெயராக இருந்தால், பகுதிகளில் " +
    "எழுதியுள்ளபடியே அதை அப்படியே எழுதவும்.\n" +
    "பாடங்கள் பெரும்பாலும் தன்மையில் எழுதப்படுகின்றன. பதிலில் ஒருபோதும் " +
    "\"நான்\" என்று எழுத கூடாது — கூறுபவர் யார் என்பதைப் பகுதிகளிலிருந்து " +
    "அறிந்து அவரது பெயரைக் குறிப்பிடவும்.\n" +
    `பகுதிகளில் பதில் இல்லையெனில், பதிலின் தொடக்கத்தில் ${MARKER} ` +
    "என எழுதி, பகுதிகளில் என்ன உள்ளது என்பதைச் சுருக்கமாகக் கூறவும். " +
    "ஊகிப்பதைவிட உண்மையைச் சொல்வது சிறந்தது.",
};

const NOT_IN_BOOK = {
  en: "The textbook does not cover this.",
  hi: "पाठ्यपुस्तक में यह नहीं है।",
  ta: "இது பாடநூலில் இல்லை.",
};

/** Remove markdown the TTS would read out literally. */
function clean(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#`>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drop sentences written in the wrong script (the model sometimes appends an
 *  English line to a Tamil/Hindi answer — see llm.py in the offline build). */
function keepScript(text, lang) {
  if (lang === "en") return text;
  const range = lang === "hi" ? /[ऀ-ॿ]/ : /[஀-௿]/;
  const sentences = text.split(/(?<=[.!?।])\s+/);
  const kept = sentences.filter(s => range.test(s));
  return kept.length ? kept.join(" ") : text;
}

export default async (req) => {
  try {
    const body = await readJson(req, 200_000);
    const message = String(body.message || "").trim().slice(0, 2000);
    if (!message) throw new HttpError(400, "Empty question.");
    const lang = LANGS.includes(body.lang) ? body.lang : "en";

    const excerpts = (Array.isArray(body.excerpts) ? body.excerpts : [])
      .slice(0, 6)
      .map(e => ({ text: String(e.text || "").slice(0, 1500), cite: String(e.cite || "").slice(0, 120), context: !!e.context }))
      .filter(e => e.text);

    const history = (Array.isArray(body.history) ? body.history : [])
      .slice(-12)
      .map(h => ({ role: h.role === "model" ? "model" : "user", text: String(h.text || "").slice(0, 1000) }))
      .filter(h => h.text);

    let system = SYSTEM[lang];
    let userText = message;
    if (excerpts.length) {
      system += "\n\n" + GROUNDING[lang];
      userText =
        "Textbook excerpts:\n" +
        excerpts.map((e, i) => `[${i + 1}] (${e.cite})\n${e.text}`).join("\n\n") +
        `\n\nQuestion: ${message}`;
    }

    // Groq first (fast) then Gemini, or the other way round for Tamil —
    // whichever answers first wins. See lib/providers.mjs.
    const result = await chatComplete({ system, history, user: userText, temperature: 0.2, maxTokens: 400, lang });
    const model = `${result.provider}:${result.model}`;
    let reply = result.text;

    let notInBook = false;
    if (reply.includes(MARKER)) {
      notInBook = true;
      reply = reply.replaceAll(MARKER, "").trim();
    }
    reply = keepScript(clean(reply), lang);
    if (notInBook && !reply) reply = NOT_IN_BOOK[lang];

    const grounded = excerpts.length > 0 && !notInBook;
    const citations = grounded ? [...new Set(excerpts.filter(e => !e.context).map(e => e.cite).filter(Boolean))] : [];

    return json({
      reply,
      lang,
      citations,
      grounded,
      notInBook,
      notInBookMessage: notInBook ? NOT_IN_BOOK[lang] : "",
      model,
    });
  } catch (err) {
    return fail(err);
  }
};

export const config = { path: "/api/chat" };
