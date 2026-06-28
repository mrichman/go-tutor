#!/usr/bin/env node
/* Local proxy that lets the browser app play against KataGo (or any GTP engine).
 *
 * Why: a browser can't spawn native processes. This tiny zero-dependency Node
 * server launches a GTP engine once, keeps it running, and exposes:
 *   GET  /health   -> { ready: bool, engine, ... }
 *   POST /genmove  -> { move: "D4" | "pass" | "resign", winrate? }
 *                     body: { size, komi, toMove:"b"|"w",
 *                             moves:[{color:"b"|"w", coord:"D4"|"pass"}],
 *                             maxVisits?, rank? }
 *
 * Per request it replays the whole move list (stateless / desync-proof), then
 * asks the engine to generate a move. Requests are queued (GTP is one stream).
 *
 * Run with KataGo:
 *   export KATAGO_PATH=katago
 *   export KATAGO_MODEL=/path/to/model.bin.gz
 *   export KATAGO_CONFIG=/path/to/gtp.cfg          # e.g. KataGo's gtp_example.cfg
 *   # optional, for human-like / rank-matched play:
 *   export KATAGO_HUMAN_MODEL=/path/to/b18c384nbt-humanv0.bin.gz
 *   node server/katago-server.js                   # http://localhost:8788
 *
 * Test without KataGo (mock engine):
 *   KATAGO_PATH="node" KATAGO_ARGS="server/mock-gtp.js" node server/katago-server.js
 *
 * Difficulty: `maxVisits` (sent per request) is applied via `kata-set-param`
 * (ignored by engines that don't support it). If a human model is configured,
 * `rank` (e.g. "8k", "2d") sets the humanSL profile so play matches that level.
 */
"use strict";

const http = require("http");
const { spawn } = require("child_process");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8788;
const KATAGO_PATH = process.env.KATAGO_PATH || "katago";
const MODEL = process.env.KATAGO_MODEL || "";
const CONFIG = process.env.KATAGO_CONFIG || "";
const HUMAN_MODEL = process.env.KATAGO_HUMAN_MODEL || "";
// Optional `-override-config` value, e.g. "numSearchThreads=8,logDir=,logToStderr=false".
const OVERRIDE = process.env.KATAGO_OVERRIDE || "";
// Allow a custom arg vector (used by the mock engine and for flexibility).
const CUSTOM_ARGS = process.env.KATAGO_ARGS ? process.env.KATAGO_ARGS.split(" ") : null;

function engineArgs() {
  if (CUSTOM_ARGS) return CUSTOM_ARGS;
  const a = ["gtp"];
  if (MODEL) a.push("-model", MODEL);
  if (CONFIG) a.push("-config", CONFIG);
  if (HUMAN_MODEL) a.push("-human-model", HUMAN_MODEL);
  if (OVERRIDE) a.push("-override-config", OVERRIDE);
  return a;
}

/* ---------------- GTP client over a persistent child process ---------------- */
class Gtp {
  constructor(cmd, args) {
    this.ready = false;
    this.buf = "";
    this.pending = [];            // queue of {resolve, reject}
    this.proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", (d) => { /* KataGo logs to stderr; ignore */ });
    this.proc.on("error", (e) => { this.ready = false; this.spawnError = String(e.message || e); });
    this.proc.on("exit", (code) => { this.ready = false; this.exited = code; });
    // a successful response to the first command marks us ready
    this.send("protocol_version").then(() => { this.ready = true; }).catch(() => {});
  }

  _onData(d) {
    this.buf += d.toString();
    // GTP responses are terminated by a blank line.
    let idx;
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const chunk = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const p = this.pending.shift();
      if (!p) continue;
      const trimmed = chunk.trim();
      if (trimmed[0] === "=") p.resolve(trimmed.slice(1).trim());
      else p.reject(new Error(trimmed.replace(/^\?\s*/, "")));
    }
  }

  send(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.exited != null) return reject(new Error("engine not running"));
      this.pending.push({ resolve, reject });
      this.proc.stdin.write(cmd + "\n");
    });
  }

  async sendQuiet(cmd) { try { return await this.send(cmd); } catch (e) { return null; } }
}

let engine = null;
function startEngine() {
  try {
    engine = new Gtp(KATAGO_PATH, engineArgs());
  } catch (e) {
    engine = null;
    console.error("Failed to start engine:", e.message);
  }
}

/* ---------------- request serialization (one genmove at a time) ---------------- */
let chain = Promise.resolve();
function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

const RANK_TO_PROFILE = (rank) => {
  // KataGo human model profiles look like "rank_8k" / "rank_2d".
  if (!rank) return null;
  return "rank_" + String(rank).toLowerCase();
};

async function genmove(req) {
  if (!engine || !engine.ready) throw new Error("engine not ready");
  const size = req.size || 19;
  const komi = (req.komi == null) ? 7.5 : req.komi;
  const color = (req.toMove === "w") ? "white" : "black";

  await engine.send("boardsize " + size);
  await engine.send("clear_board");
  await engine.send("komi " + komi);
  if (req.maxVisits) await engine.sendQuiet("kata-set-param maxVisits " + req.maxVisits);
  if (HUMAN_MODEL && req.rank) {
    const prof = RANK_TO_PROFILE(req.rank);
    if (prof) await engine.sendQuiet("kata-set-param humanSLProfile " + prof);
  }
  for (const m of (req.moves || [])) {
    const c = m.color === "w" ? "white" : "black";
    await engine.send("play " + c + " " + m.coord);
  }
  const mv = await engine.send("genmove " + color);
  return { move: (mv || "pass").trim() };
}

// Evaluate a position: win-rate, score lead, and per-point ownership (territory)
// from KataGo's raw NN — a single fast eval, ideal for a teaching overlay.
async function analyze(req) {
  if (!engine || !engine.ready) throw new Error("engine not ready");
  const size = req.size || 19;
  const komi = (req.komi == null) ? 7.5 : req.komi;
  await engine.send("boardsize " + size);
  await engine.send("clear_board");
  await engine.send("komi " + komi);
  for (const m of (req.moves || [])) {
    const c = m.color === "w" ? "white" : "black";
    await engine.send("play " + c + " " + m.coord);
  }
  const raw = await engine.send("kata-raw-nn 0");
  const winWhite = parseFloat((raw.match(/whiteWin\s+([0-9.eE-]+)/) || [])[1]);
  const leadWhite = parseFloat((raw.match(/whiteLead\s+(-?[0-9.eE]+)/) || [])[1]);
  let ownership = [];
  const oi = raw.indexOf("whiteOwnership");
  if (oi >= 0) {
    ownership = (raw.slice(oi + "whiteOwnership".length).match(/-?\d+(?:\.\d+)?(?:[eE]-?\d+)?/g) || [])
      .slice(0, size * size).map(Number);
  }
  return {
    winrateWhite: isNaN(winWhite) ? null : winWhite,
    leadWhite: isNaN(leadWhite) ? null : leadWhite,
    ownership: ownership, size: size
  };
}

/* ---------------- HTTP ---------------- */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function sendJson(res, status, obj) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, {
      ready: Boolean(engine && engine.ready),
      engine: KATAGO_PATH, hasModel: Boolean(MODEL || CUSTOM_ARGS),
      humanModel: Boolean(HUMAN_MODEL),
      error: engine && engine.spawnError || null
    });
  }

  if (req.method === "POST" && req.url === "/genmove") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); }
      catch (e) { return sendJson(res, 400, { error: "bad json" }); }
      enqueue(() => genmove(payload))
        .then((out) => sendJson(res, 200, out))
        .catch((err) => sendJson(res, 502, { error: String(err && err.message || err) }));
    });
    return;
  }

  if (req.method === "POST" && req.url === "/analyze") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); }
      catch (e) { return sendJson(res, 400, { error: "bad json" }); }
      enqueue(() => analyze(payload))
        .then((out) => sendJson(res, 200, out))
        .catch((err) => sendJson(res, 502, { error: String(err && err.message || err) }));
    });
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

startEngine();
server.listen(PORT, () => {
  console.log("Go-Tutor KataGo proxy on http://localhost:" + PORT);
  console.log("  engine: " + KATAGO_PATH + " " + engineArgs().join(" "));
  if (!MODEL && !CUSTOM_ARGS) {
    console.log("  WARNING: KATAGO_MODEL not set. Set it (and KATAGO_CONFIG), or use the mock for testing.");
  }
});
