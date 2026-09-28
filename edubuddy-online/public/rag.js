/* EduBuddy online — textbook retrieval, entirely in the browser.
 *
 * PDFs are read with pdf.js, split into overlapping chunks (400 chars / 120
 * overlap, as in config.py) and indexed with IDF-weighted character trigrams —
 * the lexical half of the offline hybrid search. Character n-grams rather than
 * words because extracted Indic text has spurious spaces inside words.
 *
 * Only the few best chunks for a question are sent to the server, so the books
 * themselves never leave the device. The index is cached in IndexedDB so a
 * refresh does not re-read every PDF.
 */
const RAG = (() => {
  const CHUNK_CHARS = 400;
  const CHUNK_OVERLAP = 120;
  const NGRAM = 3;
  const TOP_K = 4;
  const MIN_SCORE = 0.45;   // hybrid score: off-topic questions measured 0.30–0.36, real ones 0.75+

  // Question words that say nothing about the topic.
  const QSTOP = new Set(("what which when where who whom whose why how does did do the and are was were " +
    "can could would should will this that these those with from about into your you define explain describe " +
    "state give name list write mean means meaning difference between example examples tell please " +
    "क्या क्यों कैसे कौन कौनसा कौन-सा किसे किस किसको कब कहाँ कितने कितना है हैं था थी थे की का के को में से और " +
    "என்ன ஏன் எப்படி யார் எது எந்த எங்கே எப்போது என்றால் என்பது யாவை கூறுக விளக்குக").split(" "));

  let chunks = [];          // {book, page, text, grams:Set}
  let df = new Map();       // trigram → number of chunks containing it
  const books = new Map();  // title → {title, pages, chunks, source}

  /* ------------------------------------------------------------ text utils */
  function norm(s) {
    return String(s || "").normalize("NFC").toLowerCase()
      .replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/g, " ").trim();
  }
  function grams(s) {
    const t = norm(s).replace(/\s+/g, "");      // tight: immune to broken word spacing
    const out = new Set();
    for (let i = 0; i + NGRAM <= t.length; i++) out.add(t.slice(i, i + NGRAM));
    return out;
  }
  function splitChunks(text) {
    text = text.replace(/\s+/g, " ").trim();
    const out = [];
    if (!text) return out;
    let i = 0;
    while (i < text.length) {
      let end = Math.min(text.length, i + CHUNK_CHARS);
      // Prefer to end on a sentence or word boundary.
      if (end < text.length) {
        const slice = text.slice(i, end);
        const cut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("। "), slice.lastIndexOf("? "));
        if (cut > CHUNK_CHARS * 0.5) end = i + cut + 1;
        else { const sp = slice.lastIndexOf(" "); if (sp > CHUNK_CHARS * 0.5) end = i + sp; }
      }
      out.push(text.slice(i, end).trim());
      if (end >= text.length) break;
      i = Math.max(end - CHUNK_OVERLAP, i + 1);
    }
    return out;
  }

  /* --------------------------------------------------------------- index */
  function rebuild() {
    df = new Map();
    for (const c of chunks) {
      if (!c.grams) c.grams = grams(c.text);
      if (!c.tight) c.tight = norm(c.text).replace(/\s+/g, "");
      for (const g of c.grams) df.set(g, (df.get(g) || 0) + 1);
    }
  }
  function addBook(title, pages, source) {
    removeBook(title, false);
    let n = 0;
    pages.forEach((pageText, idx) => {
      for (const t of splitChunks(pageText)) {
        chunks.push({ book: title, page: idx + 1, text: t, order: n++ });
      }
    });
    books.set(title, { title, pages: pages.length, chunks: n, source });
    rebuild();
    return n;
  }
  function removeBook(title, reindex = true) {
    if (!books.has(title)) return;
    books.delete(title);
    chunks = chunks.filter(c => c.book !== title);
    if (reindex) rebuild();
  }

  /* -------------------------------------------------------------- search */
  function search(question) {
    if (!chunks.length) return [];
    const q = grams(question);
    if (!q.size) return [];
    const N = chunks.length;
    // Grams in more than 15% of passages ("wha", "the", "है") carry no topic;
    // with short Q&A passages they otherwise decide the ranking.
    const idf = g => { const d = df.get(g) || 0; return d / N > 0.15 ? 0 : Math.log(N / (1 + d)) + 0.1; };
    let total = 0;
    for (const g of q) total += idf(g);
    if (!total) return [];

    // Word half: whole query words found in the passage (substring, so
    // inflected forms still count), weighted by how rare each word is.
    const qwords = [...new Set(norm(question).split(" ").filter(w => w.length >= 3 && !QSTOP.has(w)))];
    const wdf = qwords.map(w => chunks.reduce((n, c) => n + (c.tight.includes(w) ? 1 : 0), 0));
    const widf = wdf.map(d => (d === 0 || d / N > 0.15) ? 0 : Math.log(N / d) + 0.1);
    const wtotal = widf.reduce((a, b) => a + b, 0);

    const scored = [];
    for (const c of chunks) {
      let s = 0;
      for (const g of q) if (c.grams.has(g)) s += idf(g);
      s /= total;
      let w = 0;
      if (wtotal) { qwords.forEach((word, i) => { if (widf[i] && c.tight.includes(word)) w += widf[i]; }); w /= wtotal; }
      const score = wtotal ? 0.5 * s + 0.5 * w : s;
      if (score >= MIN_SCORE) scored.push({ c, s: score });
    }
    scored.sort((a, b) => b.s - a.s);
    const top = scored.slice(0, TOP_K).map(x => x.c);
    if (!top.length) return [];

    // Always include the opening chunk of the best-matching book: chapters name
    // their narrator in the first lines, which rarely ranks well on its own.
    const best = top[0].book;
    const opening = chunks.find(c => c.book === best && c.order === 0);
    const cite = c => c.cite || `${c.book} p.${c.page}`;
    const out = top.map(c => ({ text: c.text, cite: cite(c), book: c.book, page: c.page }));
    // Context only: not shown as a citation unless it also ranked on its own.
    if (opening && !opening.cite && !top.includes(opening)) {
      out.push({ text: opening.text, cite: `${opening.book} p.${opening.page}`, book: opening.book, page: opening.page, context: true });
    }
    return out;
  }

  /* -------------------------------------------------------------- pdf.js */
  async function pdfPages(data) {
    if (!window.pdfjsLib) throw new Error("PDF reader failed to load (check your connection).");
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      pages.push(tc.items.map(i => i.str + (i.hasEOL ? "\n" : " ")).join(""));
    }
    return pages;
  }

  /* ----------------------------------------------------- IndexedDB cache */
  const DB = "edubuddy", STORE = "books";
  function db() {
    return new Promise((res, rej) => {
      try {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "title" });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
  }
  async function saveBook(title, pages, source) {
    try {
      const d = await db();
      await new Promise((res, rej) => {
        const tx = d.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put({ title, pages, source });
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch (e) { console.warn("Could not cache book", e); }
  }
  async function deleteSaved(title) {
    try {
      const d = await db();
      d.transaction(STORE, "readwrite").objectStore(STORE).delete(title);
    } catch (e) {}
  }
  async function loadSaved() {
    try {
      const d = await db();
      const all = await new Promise((res, rej) => {
        const r = d.transaction(STORE).objectStore(STORE).getAll();
        r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
      });
      for (const b of all) addBook(b.title, b.pages, b.source);
      return all.length;
    } catch (e) { return 0; }
  }

  /* ------------------------------------------------------------- public */
  async function addPdfFile(file) {
    const title = file.name.replace(/\.pdf$/i, "");
    const pages = await pdfPages(new Uint8Array(await file.arrayBuffer()));
    const text = pages.join(" ").trim();
    if (!text) throw new Error(`"${title}" has no text layer (it is a scanned image). Use a text PDF.`);
    const n = addBook(title, pages, "upload");
    await saveBook(title, pages, "upload");
    return { title, pages: pages.length, chunks: n };
  }

  /** Books bundled with the site: public/books/manifest.json lists them. */
  async function loadBundled(onProgress) {
    let manifest;
    try { manifest = await (await fetch("books/manifest.json", { cache: "no-cache" })).json(); }
    catch { return 0; }
    let n = 0;
    for (const entry of manifest.books || []) {
      const file = typeof entry === "string" ? entry : entry.file;
      const title = (typeof entry === "object" && entry.title) || file.replace(/\.pdf$/i, "");
      if (books.has(title)) continue;
      try {
        onProgress && onProgress(title);
        const buf = await (await fetch("books/" + encodeURIComponent(file))).arrayBuffer();
        const pages = await pdfPages(new Uint8Array(buf));
        addBook(title, pages, "bundled");
        await saveBook(title, pages, "bundled");
        n++;
      } catch (e) { console.warn("Bundled book failed:", file, e); }
    }
    return n;
  }

  /** Hand-written Q&A (library_questions.json) — searchable in Ask too.
   *  Each pair is its own passage, cited by book and chapter. Not cached:
   *  it is re-read from the site on every load, so edits show up on redeploy. */
  function addQA(entries) {
    const byBook = new Map();
    for (const q of entries) {
      const book = q.book || "Library";
      if (!byBook.has(book)) byBook.set(book, []);
      byBook.get(book).push(q);
    }
    for (const [book, qs] of byBook) {
      removeBook(book, false);
      qs.forEach((q, i) => chunks.push({
        book, page: q.page || 0, order: i + 1,
        text: `Q: ${q.question}\nA: ${q.answer}`,
        cite: q.chapter ? `${book} · ${q.chapter}` : (q.page ? `${book} p.${q.page}` : book),
      }));
      books.set(book, { title: book, pages: new Set(qs.map(q => q.page)).size, chunks: qs.length, source: "library" });
    }
    rebuild();
  }

  async function remove(title) { removeBook(title); await deleteSaved(title); }

  return {
    search, addPdfFile, loadBundled, loadSaved, remove, addQA,
    list: () => [...books.values()],
    count: () => books.size,
    // exposed for testing
    _addBook: addBook, _splitChunks: splitChunks,
  };
})();
if (typeof module !== "undefined") module.exports = RAG;
