#!/usr/bin/env node
/* Optional local proxy that lets the browser app get coaching from Claude.
 *
 * Why this exists: a browser must not embed your Anthropic API key, and the
 * Anthropic API doesn't allow direct browser calls (CORS + key exposure). This
 * tiny server holds the key, adds CORS headers for the local app, and forwards
 * coaching requests to Claude. It has ZERO npm dependencies (uses Node's
 * built-in fetch + http), so there's nothing to install.
 *
 * Run:
 *   export ANTHROPIC_API_KEY=sk-ant-...      # your key
 *   node server/coach-server.js              # starts on http://localhost:8787
 *
 * Then open the app; it will auto-detect the proxy and use Claude. If the proxy
 * isn't running, the app falls back to built-in offline tips automatically.
 *
 * Config via env:
 *   ANTHROPIC_API_KEY   (required to actually call Claude)
 *   COACH_MODEL         (default: claude-opus-4-20250514 — change to the exact
 *                        Opus model id available on your account)
 *   PORT                (default 8787)
 */
"use strict";

const http = require("http");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.COACH_MODEL || "claude-opus-4-8";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, obj) {
  setCors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function callClaude(prompt, context) {
  if (!API_KEY) {
    return { text: "", note: "no-api-key" };
  }
  const system =
    "You are a warm, concise Go (Baduk) coach for a single-player learning app. " +
    "The student plays against a built-in engine; you provide teaching commentary only. " +
    "Keep replies short and free of unexplained jargon. Never invent board coordinates " +
    "that contradict the provided position. If unsure, speak in general principles.";

  const body = {
    model: MODEL,
    max_tokens: 350,
    system,
    messages: [
      { role: "user", content: prompt + "\n\nPosition:\n" + context }
    ]
  };

  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error("Anthropic " + resp.status + ": " + txt.slice(0, 300));
  }
  const json = await resp.json();
  const text = (json.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { text };
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { setCors(res); res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, { ok: true, model: MODEL, hasKey: Boolean(API_KEY) });
  }

  if (req.method === "POST" && req.url === "/coach") {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(data || "{}"); }
      catch (e) { return sendJson(res, 400, { error: "bad json" }); }
      try {
        const out = await callClaude(payload.prompt || "", payload.context || "");
        if (!out.text) {
          // Signal the client to use its offline fallback.
          return sendJson(res, 200, { text: "", note: out.note || "empty" });
        }
        return sendJson(res, 200, { text: out.text, model: MODEL });
      } catch (err) {
        return sendJson(res, 502, { error: String(err && err.message || err) });
      }
    });
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  const keyMsg = API_KEY ? "API key detected" : "NO API key (set ANTHROPIC_API_KEY) — coach will return empty and the app will use offline tips";
  console.log("Go-Tutor coach proxy listening on http://localhost:" + PORT);
  console.log("  Model: " + MODEL);
  console.log("  " + keyMsg);
});
