#!/usr/bin/env node
/* Minimal mock GTP engine — speaks just enough GTP to test the proxy and the
 * app end-to-end WITHOUT installing KataGo. It tracks the board from play/
 * genmove commands and returns a random legal-ish move (avoids occupied points
 * and its own simple eyes). NOT a real engine — for plumbing tests only. */
"use strict";

let size = 19, board = null, toClear = true;
const LETTERS = "ABCDEFGHJKLMNOPQRST";

function reset() { board = new Int8Array(size * size); }
function idx(r, c) { return r * size + c; }
function parseCoord(s) {
  s = s.trim().toLowerCase();
  if (s === "pass" || s === "resign") return -1;
  const c = LETTERS.toLowerCase().indexOf(s[0]);
  const num = parseInt(s.slice(1), 10);
  const r = size - num;
  return (c < 0 || isNaN(num) || r < 0 || r >= size || c >= size) ? -1 : idx(r, c);
}
function coordOf(p) { const r = (p / size) | 0, c = p % size; return LETTERS[c] + (size - r); }

function neighbors(p) {
  const r = (p / size) | 0, c = p % size, out = [];
  if (r > 0) out.push(p - size); if (r < size - 1) out.push(p + size);
  if (c > 0) out.push(p - 1); if (c < size - 1) out.push(p + 1);
  return out;
}
function isEye(p, color) { return neighbors(p).every((q) => board[q] === color); }

function genmove(color) {
  const me = color === "white" ? 2 : 1;
  const empties = [];
  for (let p = 0; p < board.length; p++) if (board[p] === 0 && !isEye(p, me)) empties.push(p);
  if (!empties.length) return "pass";
  const p = empties[(Math.random() * empties.length) | 0];
  board[p] = me;
  return coordOf(p);
}

reset();
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(line);
  }
});

function ok(s) { process.stdout.write("= " + (s == null ? "" : s) + "\n\n"); }
function err(s) { process.stdout.write("? " + s + "\n\n"); }

function handle(line) {
  const parts = line.split(/\s+/);
  const cmd = parts[0];
  switch (cmd) {
    case "protocol_version": return ok("2");
    case "name": return ok("mock-gtp");
    case "version": return ok("0.1");
    case "list_commands": return ok("boardsize\nclear_board\nkomi\nplay\ngenmove\nkata-set-param\nquit");
    case "boardsize": size = parseInt(parts[1], 10) || 19; reset(); return ok();
    case "clear_board": reset(); return ok();
    case "komi": return ok();
    case "kata-set-param": return ok();           // accept & ignore (visits/profile)
    case "play": {
      const color = parts[1], p = parseCoord(parts[2] || "pass");
      if (p >= 0) board[p] = (color[0] === "w" || color[0] === "W") ? 2 : 1;
      return ok();
    }
    case "genmove": return ok(genmove((parts[1] || "black").toLowerCase()));
    case "quit": ok(); process.exit(0); break;
    default: return ok();                          // be permissive
  }
}
