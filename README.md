# EduBuddy Online

The web version of EduBuddy Elite: a multilingual voice tutor for **English / Hindi / Tamil**,
deployable on Netlify. It has the same **Ask / Library / Study** tabs as the offline build,
plus a **Books** tab, and a light/dark theme switch. The heavy offline models are swapped for Gemini, called from Netlify Functions.

| Offline (Raspberry Pi)             | Online (this repo)                                             |
|------------------------------------|----------------------------------------------------------------|
| Whisper STT                        | `/api/transcribe` → Gemini (audio in, transcript + language out) |
| Gemma 4 via llama.cpp              | `/api/chat` → Gemini, with the same prompts and `[NOTINBOOK]` grounding |
| MMS-TTS                            | Browser voice first; `/api/speak` (Gemini TTS) when the browser has no voice for that language |
| Hybrid retrieval over indexed PDFs | In-browser PDF reading (pdf.js) + IDF-weighted character-trigram search |
| `library.py` marking               | The same keyword marking, in the browser (pass at 60%)         |

The textbooks never leave the device. Only the question and the 4–5 best passages go to the server.

## Project layout

```
edubuddy-online/
├── netlify.toml
├── package.json
├── netlify/
│   ├── lib/gemini.mjs            shared Gemini client (model fallback, errors)
│   └── functions/
│       ├── chat.mjs              POST /api/chat
│       ├── transcribe.mjs        POST /api/transcribe
│       └── speak.mjs             POST /api/speak
└── public/                       the static site
    ├── index.html
    ├── styles.css
    ├── app.js                    UI, mic + silence detection, Library/Study
    ├── rag.js                    PDF reading, chunking, retrieval, IndexedDB cache
    ├── library_questions.json    hand-written Q&A (copied from edubuddy-elite)
    └── books/manifest.json       optional textbooks bundled with the site
```

## Deploy (about 5 minutes)

1. **Get a Gemini API key** at https://aistudio.google.com/apikey.
2. **Push this folder to GitHub** (a new repo, or an `online/` folder in edubuddy-elite).
3. On **Netlify**: *Add new project → Import from Git* → choose the repo.
   The settings come from `netlify.toml`, so you can leave the build fields as they are.
   (If the project is in a subfolder, set **Base directory** to that folder.)
4. **Site configuration → Environment variables** → add `GEMINI_API_KEY` = your key.
5. **Deploys → Trigger deploy**. Then open the site, allow the microphone, and ask a question.

To deploy without Git: `npm i -g netlify-cli`, then `netlify login`, then `netlify deploy --prod` from this folder.
Set the key with `netlify env:set GEMINI_API_KEY <key>`.

### Optional environment variables

| Variable                     | Default                    |
|------------------------------|----------------------------|
| `GEMINI_MODEL`               | `gemini-3.8-flash`         |
| `GEMINI_FALLBACK_MODEL`      | `gemini-3.5-flash-lite` (used on 404, 429, 5xx or a slow reply) |
| `GEMINI_FALLBACK_MODEL_2`    | `gemini-3.1-flash-lite`    |
| `GEMINI_FIRST_TIMEOUT_MS`    | `5500`: how long to wait before moving to the next model |
| `GEMINI_TTS_MODEL`           | `gemini-3.8-flash-lite-tts`|
| `GEMINI_TTS_FALLBACK_MODEL`  | `gemini-3.8-flash-tts`     |

On a free key, `gemini-3.8-flash` allows only about 20 requests a day. After it answers 429, EduBuddy skips it for
10 minutes and uses the lite models, which are fast (1–2 s).

Google renames models often. If you see `HTTP 404` in an answer, set `GEMINI_MODEL` to a current id
from https://ai.google.dev/gemini-api/docs/models. You don't need to change any code.

## Run locally

```bash
npm i -g netlify-cli
echo "GEMINI_API_KEY=your-key" > .env
netlify dev            # http://localhost:8888
```

The microphone works on `localhost` and on the HTTPS Netlify URL. It does not work over plain `http://` on a LAN IP.

## Textbooks

- **Per user:** open the **Books** tab and drop in a PDF. It is read in the browser and cached in
  IndexedDB, so it stays after a refresh on that device.
- **Bundled for everyone:** copy PDFs into `public/books/` and list them:
  ```json
  { "books": [ { "file": "beyond_earth.pdf", "title": "Beyond Earth" } ] }
  ```
  Each visitor's browser reads them once on the first visit.

A PDF needs a real text layer. Scanned pages, or the broken-font Hindi/Tamil PDFs noted in
`library_questions.json`, will extract badly. For those, use the Library Q&A instead.

## What's in the tabs

- **Ask** searches your PDFs *and* every Q&A guide in the Library. Answers show which book and chapter
  they came from.
- **Library** is grouped by book and then chapter. You can filter by language, book, chapter or a
  search word. Open any question to read it and hear it.
- **Study** starts with a setup screen: language, book, chapter, how many questions, and shuffle.
  Then it quizzes you with a progress bar. At the end you get a score and a list of the questions to
  review, with a *Retry missed* button.
- **Books** holds your PDFs and lists the Q&A guides that ship with the site.
- **🌙 / ☀️** in the header switches between the light and dark theme. The page remembers your choice.

## Library and Study

Edit `public/library_questions.json` (same format as the offline build) and redeploy.
It now also holds the three Class 10 guides: Science (English, 134 Q), Hindi 'B' (177 Q) and Tamil
Science (67 Q). For these, `page` is the chapter number and `chapter` is its name. Their keywords
were picked automatically from each answer, so look through them and edit any that seem off.
A keyword can be a list of alternatives, and an answer passes when it has 60% of the keywords.
Run `python library.py --validate` from the offline repo before you deploy.

## Notes

- The API key is only used inside the functions. It is never sent to the browser.
- Anyone who has the URL can use your key's quota. For a public demo, add a spending cap in
  Google AI Studio. You can also protect the site with Netlify's password feature.
- Tamil speech output: Chrome on Android and desktop Chrome usually have Hindi voices, and
  Tamil depends on the OS. When there is no Tamil voice, the page falls back to `/api/speak`
  on its own.
