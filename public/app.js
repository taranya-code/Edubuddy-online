/* EduBuddy online — page logic.
 *
 * Same three tabs as the offline build (Ask / Library / Study) plus Books.
 *   Ask      question → textbook retrieval in the browser → /api/chat (Gemini)
 *   Library  hand-written Q&A from library_questions.json, read aloud
 *   Study    one question at a time, marked by keyword match in the browser
 *   Books    add / remove the PDFs that Ask answers from
 *
 * Speech in:  MediaRecorder + silence detection → /api/transcribe
 * Speech out: the browser's own voice when it has one for the language,
 *             otherwise /api/speak (Gemini TTS).
 */
const $ = id => document.getElementById(id);
const chat = $("chat");

const LANG_NAMES = { en: "English", hi: "हिंदी", ta: "தமிழ்" };
const BCP47 = { en: "en-IN", hi: "hi-IN", ta: "ta-IN" };
const PASS_RATIO = 0.6;          // share of keywords needed in Study (config.LIBRARY_PASS_RATIO)
const HISTORY_TURNS = 6;

let ready = false, recording = false, busy = false;
let mediaRecorder = null, chunks = [], stream = null, recMime = "";
let audioCtx = null, analyser = null, levelTimer = null;
let speechSeen = false, silenceStart = 0, hardStop = null;
let history = [];                // [{role:"user"|"model", text}]

const SILENCE_LEVEL = 8;
const SILENCE_MS = 1200;
const MAX_MS = 20000;

/* ================================================================== UI */
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function bubble(role, text, opts = {}) {
  const el = document.createElement("div");
  el.className = "msg " + role;
  if (role === "sys") { el.textContent = text; }
  else {
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = role === "user" ? "You" : (opts.source === "textbook" ? "From the textbook" : "EduBuddy");
    el.appendChild(who);
    el.appendChild(document.createTextNode(text));
    if (opts.citations && opts.citations.length) {
      const c = document.createElement("div");
      c.className = "cite";
      c.appendChild(document.createTextNode("📖"));
      opts.citations.forEach(t => { const s = document.createElement("span"); s.textContent = t; c.appendChild(s); });
      el.appendChild(c);
    }
    if (opts.notInBook) {
      const n = document.createElement("div");
      n.className = "nib";
      n.textContent = "⚠ " + opts.notInBook;
      el.appendChild(n);
    }
  }
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function setStatus(text, cls) {
  $("statusText").textContent = text;
  $("dot").className = "dot" + (cls ? " " + cls : "");
}

function citeOf(q) {
  if (!q.book) return "";
  return q.chapter ? `${q.book} · ${q.chapter}` : (q.page ? `${q.book} p.${q.page}` : q.book);
}

/* =============================================================== theme */
function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function paintThemeButton() {
  const light = currentTheme() === "light";
  $("themeBtn").textContent = light ? "🌙" : "☀️";
  $("themeBtn").title = light ? "Switch to dark theme" : "Switch to light theme";
}
function toggleTheme() {
  const next = currentTheme() === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("edubuddy-theme", next); } catch {}
  paintThemeButton();
}

function readyStatus() {
  const n = RAG.count();
  setStatus(n ? `ready · ${n} book${n > 1 ? "s" : ""}` : "ready", "ok");
}

async function api(path, body) {
  const r = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/* ============================================================ language */
function detectLang(text) {
  let dev = 0, tam = 0;
  for (const ch of String(text || "")) {
    const c = ch.codePointAt(0);
    if (c >= 0x0900 && c <= 0x097F) dev++;
    else if (c >= 0x0B80 && c <= 0x0BFF) tam++;
  }
  if (tam > dev && tam > 0) return "ta";
  if (dev > 0) return "hi";
  return "en";
}
function resolveLang(text) {
  const sel = $("lang").value;
  return sel === "auto" ? detectLang(text) : sel;
}

/* ================================================================= ask */
async function ask(message, lang) {
  busy = true;
  $("send").disabled = true;
  const thinking = bubble("sys", "searching the textbooks…");
  let excerpts = [];
  try {
    excerpts = RAG.search(message);
    if (excerpts.length) {
      const cites = [...new Set(excerpts.filter(e => !e.context).map(e => e.cite))];
      thinking.textContent = "found " + cites.slice(0, 3).join(" · ") + " — writing the answer…";
    } else {
      thinking.textContent = RAG.count() ? "nothing matching in the textbooks — thinking…" : "thinking…";
    }

    const data = await api("/api/chat", {
      message, lang,
      excerpts: excerpts.map(e => ({ text: e.text, cite: e.cite, context: !!e.context })),
      history: history.slice(-HISTORY_TURNS * 2),
    });
    thinking.remove();

    bubble("bot", data.reply, {
      citations: data.citations,
      notInBook: data.notInBook ? data.notInBookMessage : "",
    });
    history.push({ role: "user", text: message }, { role: "model", text: data.reply });
    history = history.slice(-HISTORY_TURNS * 2);

    if ($("speakBack").checked) await speak(data.reply, data.lang || lang);
  } catch (e) {
    thinking.remove();
    console.warn("AI answer failed:", e.message);
    /* Safety net: if every AI service is down, still answer from the book.
       The best-matching passage is shown as the textbook's own words, with its
       citation — the same honest labelling as the offline "question packs". */
    const best = excerpts.find(x => !x.context);
    if (best) {
      const m = best.text.match(/\nA:\s*([\s\S]+)$/);
      const text = (m ? m[1] : best.text).trim();
      bubble("bot", text, {
        source: "textbook",
        citations: [best.cite],
        notInBook: "The AI service is busy, so this is the closest passage from the textbook.",
      });
      if ($("speakBack").checked) await speak(text, lang);
    } else {
      bubble("sys", "The AI service is busy right now. Please try again in a moment. (" + e.message.slice(0, 140) + ")");
    }
  } finally {
    busy = false;
    $("send").disabled = false;
    if ($("continuous").checked && ready && currentSection === "ask") setTimeout(startRecording, 350);
  }
}

function sendTyped() {
  const t = $("text").value.trim();
  if (!t || busy) return;
  $("text").value = "";
  bubble("user", t);
  ask(t, resolveLang(t));
}

/* ============================================================== speech */
let speakToken = 0, currentAudio = null, pendingAudio = null, readingAll = false;
let voices = [];

function loadVoices() {
  if (!("speechSynthesis" in window)) return;
  voices = speechSynthesis.getVoices();
}
if ("speechSynthesis" in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

function pickVoice(lang) {
  const tag = BCP47[lang].toLowerCase();
  const base = lang;
  const byTag = voices.filter(v => v.lang.toLowerCase().replace("_", "-") === tag);
  const byBase = voices.filter(v => v.lang.toLowerCase().startsWith(base));
  const list = byTag.length ? byTag : byBase;
  // Prefer higher-quality network voices (e.g. "Google हिन्दी") when present.
  return list.find(v => /google|natural|online/i.test(v.name)) || list[0] || null;
}

function sentences(text) {
  return String(text).match(/[^.!?।]+[.!?।]*\s*/g)?.map(s => s.trim()).filter(Boolean) || [text];
}

function speakBrowser(text, lang, voice, token) {
  return new Promise(resolve => {
    speechSynthesis.cancel();
    const parts = sentences(text);
    let i = 0;
    const next = () => {
      if (token !== speakToken || i >= parts.length) return resolve();
      const u = new SpeechSynthesisUtterance(parts[i++]);
      u.voice = voice; u.lang = voice.lang; u.rate = 0.95;
      u.onend = next;
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    };
    next();
  });
}

async function speakServer(text, lang, token) {
  const r = await fetch("/api/speak", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, lang }),
  });
  if (token !== speakToken) return;
  if (r.status === 204) return;
  if (!r.ok) {
    let msg = "HTTP " + r.status;
    try { msg = (await r.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  const blob = await r.blob();
  if (token !== speakToken || !blob.size) return;
  await new Promise(resolve => {
    const audio = new Audio(URL.createObjectURL(blob));
    currentAudio = audio;
    audio.onended = audio.onerror = () => { currentAudio = null; resolve(); };
    audio.play().catch(() => {
      currentAudio = null;
      pendingAudio = audio;
      $("soundFix").hidden = false;
      setStatus("browser blocked the audio — click “Enable sound”", "err");
      resolve();
    });
  });
}

async function speak(text, lang) {
  const token = ++speakToken;
  if (!text) return;
  lang = BCP47[lang] ? lang : detectLang(text);
  try {
    const voice = ("speechSynthesis" in window) ? pickVoice(lang) : null;
    if (voice) await speakBrowser(text, lang, voice, token);
    else await speakServer(text, lang, token);
  } catch (e) {
    setStatus("speech failed: " + e.message, "err");
  }
}

function stopSpeaking() {
  speakToken++;
  readingAll = false;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (currentAudio) { try { currentAudio.pause(); } catch {} currentAudio = null; }
}

let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    const a = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQQAAAAAAAAA");
    a.volume = 0; a.play().catch(() => {});
    if ("speechSynthesis" in window) { const u = new SpeechSynthesisUtterance(""); speechSynthesis.speak(u); }
  } catch {}
}

/* ==================================================== mic + silence VAD */
let micTarget = "ask";

function pickMime() {
  if (!window.MediaRecorder) return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

async function startRecording() {
  if (recording || busy || !ready) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    bubble("sys", "This browser cannot record audio. Please type instead.");
    return;
  }
  try {
    if (!stream) stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    bubble("sys", "Microphone blocked. Allow mic access for this site, then try again.");
    return;
  }
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
  }
  if (audioCtx.state === "suspended") await audioCtx.resume();

  stopSpeaking();
  chunks = []; speechSeen = false; silenceStart = 0;
  recMime = pickMime();
  mediaRecorder = recMime ? new MediaRecorder(stream, { mimeType: recMime }) : new MediaRecorder(stream);
  mediaRecorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  mediaRecorder.onstop = handleRecordingStop;
  mediaRecorder.start();

  recording = true;
  (micTarget === "study" ? $("studyMic") : $("mic")).classList.add("recording");
  setStatus("listening…", "rec");

  const buf = new Uint8Array(analyser.frequencyBinCount);
  levelTimer = setInterval(() => {
    analyser.getByteFrequencyData(buf);
    let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i];
    const avg = sum / buf.length;
    $("levelbar").style.width = Math.min(100, avg * 3) + "%";
    if (avg >= SILENCE_LEVEL) { speechSeen = true; silenceStart = 0; }
    else if (speechSeen) {
      if (!silenceStart) silenceStart = Date.now();
      else if (Date.now() - silenceStart > SILENCE_MS) stopRecording();
    }
  }, 100);
  hardStop = setTimeout(stopRecording, MAX_MS);
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  clearInterval(levelTimer); levelTimer = null;
  clearTimeout(hardStop); hardStop = null;
  $("levelbar").style.width = "0";
  $("mic").classList.remove("recording");
  $("studyMic").classList.remove("recording");
  try { mediaRecorder.stop(); } catch {}
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

async function handleRecordingStop() {
  const target = micTarget;
  micTarget = "ask";
  if (!speechSeen || !chunks.length) {
    readyStatus();
    if (target === "ask" && $("continuous").checked && ready) setTimeout(startRecording, 400);
    return;
  }
  setStatus("transcribing…");
  const type = (mediaRecorder.mimeType || recMime || "audio/webm").split(";")[0];
  const blob = new Blob(chunks, { type });
  try {
    const lang = target === "study" ? currentStudyLang() : $("lang").value;
    const data = await api("/api/transcribe", {
      audio: await blobToBase64(blob), mimeType: type, lang,
    });
    readyStatus();

    /* Study: the transcript goes into the answer box rather than being marked
       straight away, so the student can fix a mis-hearing first. */
    if (target === "study") {
      if (!data.text) { setStatus("did not catch that", "ok"); return; }
      $("studyInput").value = data.text;
      $("studyInput").focus();
      return;
    }
    if (!data.text) {
      bubble("sys", "I did not catch that — try again.");
      if ($("continuous").checked) setTimeout(startRecording, 500);
      return;
    }
    bubble("user", data.text);
    ask(data.text, data.lang || detectLang(data.text));
  } catch (e) {
    readyStatus();
    bubble("sys", "Transcription failed: " + e.message);
  }
}

/* ===================================================== Library + Study */
let libData = null;
let currentSection = "ask";

function switchSection(which) {
  currentSection = which;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.section === which));
  $("chat").hidden = which !== "ask";
  $("librarypane").hidden = which !== "library";
  $("studypane").hidden = which !== "study";
  $("bookspane").hidden = which !== "books";
  document.querySelector("footer").style.display = which === "ask" ? "" : "none";
  stopSpeaking();
  if (recording) stopRecording();
  if (which === "books") renderBooks();
  if ((which === "library" || which === "study") && libData === null) loadLibrary();
}

/* Chapter label and sort key. The Class 10 guides store the chapter name; the
   older guides only have a page number. */
function chapterOf(q) { return q.chapter || (q.page ? `Page ${q.page}` : "General"); }

async function loadLibrary() {
  try {
    const raw = await (await fetch("library_questions.json")).json();
    const qs = (raw.questions || []).filter(q => q.id && q.question && q.answer);
    libData = { questions: qs, total: qs.length };
  } catch (e) {
    libData = { questions: [], total: 0 };
  }
  // Number each question within its chapter, for "Q3" badges.
  const seen = new Map();
  for (const q of libData.questions) {
    const k = q.book + "\u0000" + chapterOf(q);
    seen.set(k, (seen.get(k) || 0) + 1);
    q._n = seen.get(k);
  }
  setupFilters("lib");
  setupFilters("study");
  renderLibrary();
  renderStudySetup();
}

/* ---------------------------------------------- shared filter controls ---
   Library and Study each have Language → Book → Chapter selects; picking a
   language narrows the books, picking a book narrows the chapters.          */
const LANG_LABEL = { all: "All", en: "English", hi: "हिंदी", ta: "தமிழ்" };

function setupFilters(prefix) {
  const langs = ["all", ...new Set(libData.questions.map(q => q.lang))];
  const seg = $(prefix + "Lang");
  seg.innerHTML = langs.map(l =>
    `<button data-v="${l}" class="${l === "all" ? "on" : ""}">${LANG_LABEL[l] || l}</button>`).join("");
  seg.dataset.v = "all";
  seg.querySelectorAll("button").forEach(b => b.onclick = () => {
    seg.dataset.v = b.dataset.v;
    seg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    fillBooks(prefix); fillChapters(prefix); onFilter(prefix);
  });
  $(prefix + "Book").onchange = () => { fillChapters(prefix); onFilter(prefix); };
  $(prefix + "Chapter").onchange = () => onFilter(prefix);
  fillBooks(prefix); fillChapters(prefix);
}

function onFilter(prefix) { prefix === "lib" ? renderLibrary() : renderStudySetup(); }

function fillBooks(prefix) {
  const lang = $(prefix + "Lang").dataset.v;
  const books = [...new Set(libData.questions.filter(q => lang === "all" || q.lang === lang).map(q => q.book))];
  const sel = $(prefix + "Book"), keep = sel.value;
  sel.innerHTML = '<option value="all">All books</option>' +
    books.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
  if (books.includes(keep)) sel.value = keep;
}

function fillChapters(prefix) {
  const lang = $(prefix + "Lang").dataset.v, book = $(prefix + "Book").value;
  const sel = $(prefix + "Chapter");
  if (book === "all") {
    sel.innerHTML = '<option value="all">All chapters</option>';
    sel.disabled = true;
    return;
  }
  const chs = [];
  for (const q of libData.questions) {
    if (q.book !== book || (lang !== "all" && q.lang !== lang)) continue;
    const c = chapterOf(q);
    if (!chs.includes(c)) chs.push(c);
  }
  sel.innerHTML = '<option value="all">All chapters</option>' +
    chs.map((c, i) => `<option value="${esc(c)}">${i + 1}. ${esc(c)}</option>`).join("");
  sel.disabled = false;
}

function selection(prefix, needle = "") {
  const lang = $(prefix + "Lang").dataset.v, book = $(prefix + "Book").value, ch = $(prefix + "Chapter").value;
  return (libData?.questions || []).filter(q =>
    (lang === "all" || q.lang === lang) &&
    (book === "all" || q.book === book) &&
    (ch === "all" || chapterOf(q) === ch) &&
    (!needle || (q.question + " " + q.answer).toLowerCase().includes(needle)));
}

/* Group into book → chapter, keeping file order. */
function grouped(list) {
  const books = new Map();
  for (const q of list) {
    if (!books.has(q.book)) books.set(q.book, new Map());
    const chs = books.get(q.book), c = chapterOf(q);
    if (!chs.has(c)) chs.set(c, []);
    chs.get(c).push(q);
  }
  return books;
}

const EMPTY_MSG = '<div class="empty">No questions yet. Add them to ' +
  "<code>public/library_questions.json</code> and redeploy.</div>";

/* ---------------------------------------------------------------- library */
let libShown = [];

function renderLibrary() {
  const list = $("liblist");
  if (!libData || !libData.total) { list.innerHTML = EMPTY_MSG; $("libSummary").textContent = ""; return; }
  const needle = $("libSearch").value.trim().toLowerCase();
  libShown = selection("lib", needle);
  const groups = grouped(libShown);
  const nCh = [...groups.values()].reduce((n, m) => n + m.size, 0);
  $("libSummary").textContent = libShown.length
    ? `${libShown.length} question${libShown.length > 1 ? "s" : ""} · ${nCh} chapter${nCh > 1 ? "s" : ""} · ${groups.size} book${groups.size > 1 ? "s" : ""}`
    : "";
  if (!libShown.length) { list.innerHTML = '<div class="empty">Nothing matches that filter.</div>'; return; }

  // Open chapter groups when the view is already narrow; otherwise start collapsed.
  const openAll = !!needle || $("libChapter").value !== "all" || nCh <= 2;
  let html = "", idx = 0;
  for (const [book, chs] of groups) {
    const count = [...chs.values()].reduce((n, a) => n + a.length, 0);
    html += `<div class="bookhead"><span>📘 ${esc(book)}</span><span class="count">${count} Q · ${chs.size} ch.</span></div>`;
    let chNo = 0;
    for (const [ch, qs] of chs) {
      chNo++;
      html += `<details class="chgroup"${openAll ? " open" : ""}>
        <summary><span class="chno">${chNo}</span><span class="chname">${esc(ch)}</span><span class="count">${qs.length}</span></summary>
        <div class="chbody">` +
        qs.map(q => {
          const i = idx++;
          return `<div class="qcard" data-i="${i}">
            <div class="qhead"><span class="qnum">Q${q._n}</span><div class="qtext">${esc(q.question)}</div><span class="chev">›</span></div>
            <div class="qbody">
              <div class="qans">${esc(q.answer)}</div>
              <div class="qfoot"><button class="btn-accent one" data-i="${i}">🔊 Listen</button></div>
            </div>
          </div>`;
        }).join("") + `</div></details>`;
    }
  }
  list.innerHTML = html;

  list.querySelectorAll(".qhead").forEach(h => h.onclick = () => {
    const card = h.parentElement;
    card.classList.toggle("open");
  });
  list.querySelectorAll(".one").forEach(b => b.onclick = async ev => {
    ev.stopPropagation();
    const q = libShown[+b.dataset.i];
    stopSpeaking();
    b.disabled = true;
    await speak(q.question + ". " + q.answer, q.lang);
    b.disabled = false;
  });
}

function setAllGroups(open) {
  $("liblist").querySelectorAll("details.chgroup").forEach(d => d.open = open);
}

async function readAll() {
  const shown = libShown.slice();
  if (!shown.length) return;
  stopSpeaking();
  readingAll = true;
  $("playAll").hidden = true; $("stopAll").hidden = false;
  const cards = $("liblist").querySelectorAll(".qcard");
  for (let i = 0; i < shown.length; i++) {
    if (!readingAll) break;
    const card = cards[i];
    if (card) {
      card.closest("details").open = true;
      card.classList.add("open", "playing");
      card.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    await speak(shown[i].question + ". " + shown[i].answer, shown[i].lang);
    if (card) card.classList.remove("playing");
  }
  readingAll = false;
  $("playAll").hidden = false; $("stopAll").hidden = true;
}

/* ---- marking: a port of library.mark() ---- */
function normalise(text) {
  return String(text || "").normalize("NFC").toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/g, " ").trim();
}
function contains(spaced, tight, needle) {
  const n = normalise(needle);
  if (!n) return false;
  if (spaced.includes(n)) return true;
  return tight.includes(n.replace(/\s+/g, ""));   // tolerate broken word spacing
}
function mark(answer, q) {
  const keywords = q.keywords || [];
  const spaced = normalise(answer);
  const tight = spaced.replace(/\s+/g, "");
  const matched = [], missed = [];
  for (const kw of keywords) {
    const alts = Array.isArray(kw) ? kw : [kw];
    (alts.some(a => contains(spaced, tight, String(a))) ? matched : missed).push(String(alts[0]));
  }
  const ratio = keywords.length ? matched.length / keywords.length : 0;
  return {
    correct: !!spaced && keywords.length > 0 && ratio >= PASS_RATIO,
    matched, missed,
    answer: q.answer,
    citation: citeOf(q),
    lang: q.lang || "en",
  };
}

/* ------------------------------------------------------------------ study
   Three screens: setup (choose what to practise) → quiz → results.       */
let study = { list: [], at: 0, score: 0, missed: [], done: false };

function studyScreen(name) {
  $("studySetup").hidden = name !== "setup";
  $("studyQuiz").hidden = name !== "quiz";
  $("studyResult").hidden = name !== "result";
}

function renderStudySetup() {
  studyScreen("setup");
  if (!libData || !libData.total) { $("studyAvail").innerHTML = EMPTY_MSG; $("studyStart").disabled = true; return; }
  const n = selection("study").length;
  const want = $("studyCount").value === "all" ? n : Math.min(n, +$("studyCount").value);
  $("studyAvail").textContent = n
    ? `${n} question${n > 1 ? "s" : ""} available · this session: ${want}`
    : "No questions match this choice.";
  $("studyStart").disabled = !n;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function startStudy(list) {
  let qs = list || selection("study");
  if (!list) {
    if ($("studyShuffle").checked) qs = shuffle(qs.slice());
    if ($("studyCount").value !== "all") qs = qs.slice(0, +$("studyCount").value);
  }
  if (!qs.length) return;
  study = { list: qs, at: 0, score: 0, missed: [], done: false };
  studyScreen("quiz");
  showStudy();
}

function showStudy() {
  $("studyVerdict").innerHTML = "";
  $("studyInput").value = "";
  $("studyNext").hidden = true;
  $("studyCheck").hidden = false;
  $("studyReveal").hidden = false;
  if (study.at >= study.list.length) return showResult();

  const q = study.list[study.at], total = study.list.length;
  $("studyBar").style.width = (study.at / total * 100) + "%";
  $("studyProgress").textContent = `Question ${study.at + 1} of ${total}`;
  $("studyScoreNow").textContent = `${study.score} correct`;
  $("studyTag").textContent = citeOf(q);
  $("studyQ").textContent = q.question;
  $("studyInput").disabled = $("studyCheck").disabled = $("studyMic").disabled = false;
  $("studyInput").focus();
}

function checkStudy(giveUp = false) {
  if (study.done || !study.list.length || study.at >= study.list.length) return;
  const q = study.list[study.at];
  const given = $("studyInput").value.trim();
  if (!given && !giveUp) return;
  const r = giveUp ? { ...mark("", q), correct: false } : mark(given, q);
  if (r.correct) study.score++; else study.missed.push(q);

  const kw = giveUp ? "" : `<div class="kw">matched <b>${r.matched.map(esc).join(", ") || "—"}</b>` +
    (r.missed.length ? ` · missed <b>${r.missed.map(esc).join(", ")}</b>` : "") + "</div>";
  $("studyVerdict").innerHTML = `
    <div class="verdict ${r.correct ? "right" : "wrong"}">
      <div class="vtitle">${r.correct ? "✓ Correct" : giveUp ? "Here is the answer" : "✗ Not quite"}</div>
      <div>${esc(r.answer)}</div>
      ${r.citation ? `<div class="cite" style="margin-top:9px"><span>📖 ${esc(r.citation)}</span></div>` : ""}
      ${kw}
    </div>`;
  $("studyScoreNow").textContent = `${study.score} correct`;
  $("studyBar").style.width = ((study.at + 1) / study.list.length * 100) + "%";
  $("studyCheck").hidden = true;
  $("studyReveal").hidden = true;
  $("studyNext").hidden = false;
  $("studyNext").textContent = study.at + 1 >= study.list.length ? "See results →" : "Next →";
  $("studyNext").focus();
  if ($("speakBack").checked) { stopSpeaking(); speak(r.answer, r.lang); }
}

function currentStudyLang() {
  const q = study.list[study.at];
  return q ? q.lang : "auto";
}

function nextStudy() { stopSpeaking(); study.at++; showStudy(); }

function showResult() {
  study.done = true;
  studyScreen("result");
  const total = study.list.length, pct = Math.round(study.score / total * 100);
  $("resultScore").textContent = `${study.score} / ${total}`;
  $("resultPct").textContent = `${pct}%`;
  $("resultMsg").textContent = pct >= 80 ? "Excellent work!" : pct >= 50 ? "Good effort — review the ones you missed." : "Keep practising — go through the missed ones below.";
  $("resultRing").style.setProperty("--p", pct);
  $("retryMissed").hidden = !study.missed.length;
  $("missedList").innerHTML = study.missed.length
    ? `<div class="mhead">To review (${study.missed.length})</div>` + study.missed.map(q => `
        <div class="mitem"><div class="mq">${esc(q.question)}</div><div class="ma">${esc(q.answer)}</div>
        <div class="mc">📖 ${esc(citeOf(q))}</div></div>`).join("")
    : '<div class="empty">Nothing to review — every answer was correct.</div>';
}

/* =============================================================== books */
function renderBooks() {
  const all = RAG.list();
  const mine = all.filter(b => b.source !== "library");
  const guides = all.filter(b => b.source === "library");
  const row = b => `
    <div class="bookrow">
      <div class="t">${b.source === "library" ? "📗" : "📘"} ${esc(b.title)}
        <div class="m">${b.source === "library" ? `${b.pages} chapters · ${b.chunks} Q&A` : `${b.pages} pages · ${b.chunks} passages · ${b.source === "bundled" ? "bundled with site" : "added by you"}`}</div></div>
      ${b.source === "library" ? "" : `<button class="rm" data-t="${esc(b.title)}">Remove</button>`}
    </div>`;
  $("booklist").innerHTML =
    `<div class="sechead">Your textbooks (PDF)</div>` +
    (mine.length ? mine.map(row).join("") : '<div class="empty">None yet — add a PDF above.</div>') +
    `<div class="sechead">Q&amp;A guides <span class="count">also searched by Ask</span></div>` +
    (guides.length ? guides.map(row).join("") : '<div class="empty">Loading…</div>');
  $("booklist").querySelectorAll(".rm").forEach(btn => btn.onclick = async () => {
    await RAG.remove(btn.dataset.t);
    renderBooks(); readyStatus();
  });
}

async function addFiles(files) {
  for (const f of files) {
    if (!/\.pdf$/i.test(f.name)) continue;
    setStatus(`reading ${f.name}…`);
    try {
      const r = await RAG.addPdfFile(f);
      bubble("sys", `Added “${r.title}” — ${r.pages} pages, ${r.chunks} passages.`);
    } catch (e) {
      bubble("sys", "Could not read " + f.name + ": " + e.message);
    }
  }
  renderBooks(); readyStatus();
}

/* ============================================================== wiring */
$("mic").addEventListener("click", () => {
  if (recording) return stopRecording();
  micTarget = "ask"; startRecording();
});
$("send").addEventListener("click", sendTyped);
$("text").addEventListener("keydown", e => { if (e.key === "Enter") sendTyped(); });
$("clear").addEventListener("click", () => {
  stopSpeaking(); history = []; chat.innerHTML = "";
  bubble("sys", "Conversation cleared.");
});
$("continuous").addEventListener("change", e => {
  if (e.target.checked && ready && !recording && !busy) { micTarget = "ask"; startRecording(); }
  else if (!e.target.checked && recording) stopRecording();
});
$("speakBack").addEventListener("change", e => { if (!e.target.checked) stopSpeaking(); });
$("themeBtn").addEventListener("click", toggleTheme);
paintThemeButton();
if (window.matchMedia) matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", paintThemeButton);

document.addEventListener("pointerdown", unlockAudio, { once: true });
document.addEventListener("keydown", unlockAudio, { once: true });
$("soundFix").addEventListener("click", async () => {
  $("soundFix").hidden = true;
  if (!pendingAudio) { readyStatus(); return; }
  const a = pendingAudio; pendingAudio = null; currentAudio = a;
  a.onended = a.onerror = () => { currentAudio = null; };
  try { await a.play(); readyStatus(); }
  catch { setStatus("still blocked — allow sound for this site", "err"); }
});

document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => switchSection(t.dataset.section)));
$("libSearch").addEventListener("input", renderLibrary);
$("expandAll").addEventListener("click", () => setAllGroups(true));
$("collapseAll").addEventListener("click", () => setAllGroups(false));
$("playAll").addEventListener("click", readAll);
$("stopAll").addEventListener("click", () => { stopSpeaking(); $("playAll").hidden = false; $("stopAll").hidden = true; });
$("studyCount").addEventListener("change", renderStudySetup);
$("studyStart").addEventListener("click", () => startStudy());
$("studyQuit").addEventListener("click", () => { stopSpeaking(); renderStudySetup(); });
$("studyCheck").addEventListener("click", () => checkStudy());
$("studyReveal").addEventListener("click", () => checkStudy(true));
$("studyNext").addEventListener("click", nextStudy);
$("retryMissed").addEventListener("click", () => startStudy(study.missed.slice()));
$("newSession").addEventListener("click", renderStudySetup);
$("studyInput").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  if ($("studyNext").hidden) checkStudy(); else nextStudy();
});
$("studyMic").addEventListener("click", () => {
  if (recording) { stopRecording(); return; }
  micTarget = "study"; startRecording();
});

$("pdfInput").addEventListener("change", e => { addFiles([...e.target.files]); e.target.value = ""; });
const drop = $("drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => addFiles([...e.dataTransfer.files]));

/* =============================================================== start */
(async function init() {
  bubble("sys", "Ask a question in English, Hindi or Tamil — type it or tap the mic.");
  setStatus("loading textbooks…");
  await RAG.loadSaved();
  await RAG.loadBundled(title => setStatus(`reading ${title}…`));
  await loadLibrary();
  RAG.addQA(libData.questions);
  ready = true;
  readyStatus();
})();
