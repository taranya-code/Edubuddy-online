// Local server for EduBuddy Online — no installs needed, just Node 18+.
//   node server.mjs          → http://localhost:8888
// Serves public/ and routes /api/* to the same Netlify Function files,
// so what you test here is exactly what runs on Netlify.
// Put your key in a file named .env next to this one:  GEMINI_API_KEY=your-key
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT) || 8888;

// Minimal .env loader
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const ROUTES = {
  "/api/chat": "chat.mjs",
  "/api/transcribe": "transcribe.mjs",
  "/api/speak": "speak.mjs",
};
const handlers = {};
for (const [route, file] of Object.entries(ROUTES)) {
  handlers[route] = (await import(pathToFileURL(path.join(ROOT, "netlify", "functions", file)).href)).default;
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (handlers[url.pathname]) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const response = await handlers[url.pathname](request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      console.log(`${req.method} ${url.pathname} → ${response.status}`);
      return;
    }
    let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`\n  EduBuddy running at  http://localhost:${PORT}\n`);
  if (!process.env.GEMINI_API_KEY) {
    console.log("  ⚠ GEMINI_API_KEY not set — Library and Study work, but Ask and voice input need it.");
    console.log("    Create a file named .env here containing:  GEMINI_API_KEY=your-key\n");
  }
});
