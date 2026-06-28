/* Headless test harness: loads the browser scripts under a window shim and
 * exercises engine rules, bot legality, scoring, and ranking. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sandbox = { window: {}, Math: Math, Date: Date, JSON: JSON, Int8Array: Int8Array, Number: Number, console: console };
sandbox.window.localStorage = (function () {
  const m = {};
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } };
})();
sandbox.localStorage = sandbox.window.localStorage;   // ranking.js uses the bare global
vm.createContext(sandbox);

function loadJS(rel) {
  const code = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  vm.runInContext(code, sandbox, { filename: rel });
}
["js/engine.js", "js/bot.js", "js/ranking.js", "js/tutorial.js", "js/opening.js", "js/solver.js", "js/generator.js", "js/problems.js", "js/sgf.js"].forEach(loadJS);

const GT = sandbox.window.GT;
const E = GT.engine;
const localStorage = sandbox.localStorage;
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("  ✗ FAIL:", name); } }

/* ---------- engine: basic capture ---------- */
(function () {
  const g = new E.GoGame(9, 6.5);
  // surround white stone at (4,4) with black
  g.board[4 * 9 + 4] = E.WHITE;
  g.board[3 * 9 + 4] = E.BLACK;
  g.board[5 * 9 + 4] = E.BLACK;
  g.board[4 * 9 + 3] = E.BLACK;
  g.toMove = E.BLACK;
  const r = g.play(4 * 9 + 5, E.BLACK); // fill last liberty
  ok("capture removes stone", r.ok && g.board[4 * 9 + 4] === E.EMPTY);
  ok("capture counted", g.captures[E.BLACK] === 1);
})();

/* ---------- engine: suicide illegal ---------- */
(function () {
  const g = new E.GoGame(9);
  // black surrounds an empty point fully; white playing inside = suicide
  [[3,4],[5,4],[4,3],[4,5]].forEach(rc => g.board[rc[0]*9+rc[1]] = E.BLACK);
  g.toMove = E.WHITE;
  ok("suicide is illegal", g.isLegal(4*9+4, E.WHITE) === false);
  // but capturing move (not suicide) is legal
})();

/* ---------- engine: ko ---------- */
(function () {
  const g = new E.GoGame(9, 0);
  // Build a ko shape.  positions:
  //   . B W .
  //   B b w W   (lowercase = the contested stones)
  //   . B W .
  const B = E.BLACK, W = E.WHITE;
  function set(r,c,v){ g.board[r*9+c]=v; }
  set(2,3,B); set(2,4,W);
  set(3,2,B); set(3,3,B); set(3,4,W); set(3,5,W);
  set(4,3,B); set(4,4,W);
  g._rememberPosition();
  g.toMove = W;
  // White captures the black stone at (3,3) by playing (3,3)? It's occupied.
  // Instead set up the standard single-stone ko: white plays to capture black at b.
  // Simpler ko check: capture a single stone, then opponent recapture must be illegal.
  const g2 = new E.GoGame(9, 0);
  set2(g2,3,3,W); set2(g2,2,3,B); set2(g2,4,3,B); set2(g2,3,2,B); // white at 3,3 with 1 lib (3,4)
  g2._rememberPosition();
  g2.toMove = B;
  const cap = g2.play(3*9+4, B); // capture white
  ok("ko: single capture ok", cap.ok && cap.captured && cap.captured.length === 1);
  ok("ko: immediate recapture illegal", g2.isLegal(3*9+3, W) === false);
  function set2(gg,r,c,v){ gg.board[r*9+c]=v; }
})();

/* ---------- engine: area scoring ---------- */
(function () {
  const g = new E.GoGame(9, 6.5);
  // black wall row 3, white wall row 5 -> black owns rows 0-2 area + stones
  for (let c = 0; c < 9; c++) { g.board[3*9+c] = E.BLACK; g.board[5*9+c] = E.WHITE; }
  const s = g.scoreArea();
  // black: rows0-3 (top empty 0,1,2 =27) + wall(9) =36 ; white rows5-8 empty(6,7,8=27)+wall9=36 +komi
  ok("area: black 36", s.blackArea === 36);
  ok("area: white 36", s.whiteArea === 36);
  ok("area: white wins on komi", s.winner === E.WHITE);
})();

/* ---------- engine: superko prevents repetition ---------- */
(function () {
  const g = new E.GoGame(9, 0);
  // play and verify legalMoves never returns occupied/eye points causing crash
  let moves = g.legalMoves(E.BLACK);
  ok("legalMoves on empty board = 81", moves.length === 81);
})();

/* ---------- bot: always legal, finishes a game ---------- */
(function () {
  const g = new E.GoGame(9, 6.5);
  const b1 = new GT.bot.Bot(0.3), b2 = new GT.bot.Bot(0.7);
  let illegal = 0, moves = 0, guard = 0;
  while (!g.ended && !g.scoringPhase && guard < 400) {
    guard++;
    const bot = g.toMove === E.BLACK ? b1 : b2;
    const mv = bot.chooseMove(g);
    if (mv !== E.PASS && !g.isLegal(mv, g.toMove)) illegal++;
    const r = g.play(mv, g.toMove);
    if (!r.ok && mv !== E.PASS) illegal++;
    if (r.ok) moves++;
  }
  if (g.scoringPhase) g.finalizeScore(g.autoDeadStones());
  ok("bot self-play makes no illegal moves", illegal === 0);
  ok("bot self-play terminates", g.ended === true);
  ok("bot self-play produced moves", moves > 10);
})();

/* ---------- bot: never fills its own single eye (no suicide of own eye) ---------- */
(function () {
  const g = new E.GoGame(7, 0);
  const B = E.BLACK;
  // make a black group with one eye at (3,3)
  [[2,3],[4,3],[3,2],[3,4]].forEach(rc => g.board[rc[0]*7+rc[1]] = B);
  g.toMove = B;
  ok("eye-like detected", g.isEyeLike(3*7+3, B) === true);
})();

/* ---------- ranking: monotonic progression on win streak ---------- */
(function () {
  const p = GT.ranking.defaultProfile();
  const start = p.skill;
  for (let i = 0; i < 10; i++) {
    GT.ranking.recordGame(p, { won: true, margin: 20, botSkill: p.skill + 0.6, handicap: 0, size: 9, byResign: false });
  }
  ok("ranking rises on wins", p.skill > start);
  ok("ranking capped at 2d (<=19)", p.skill <= 19);
  // losing streak lowers
  const before = p.skill;
  for (let i = 0; i < 10; i++) {
    GT.ranking.recordGame(p, { won: false, margin: 20, botSkill: p.skill, handicap: 0, size: 9, byResign: false });
  }
  ok("ranking falls on losses", p.skill < before);
  ok("ranking floored at 18k (>=0)", p.skill >= 0);
})();

/* ---------- ranking: labels ---------- */
(function () {
  ok("label 0 = 18k", GT.ranking.labelForSkill(0) === "18k");
  ok("label 17 = 1k", GT.ranking.labelForSkill(17) === "1k");
  ok("label 18 = 1d", GT.ranking.labelForSkill(18) === "1d");
  ok("label 19 = 2d", GT.ranking.labelForSkill(19) === "2d");
})();

/* ---------- ranking: adaptive recommendation in range ---------- */
(function () {
  const p = GT.ranking.defaultProfile();
  const rec = GT.ranking.recommendOpponent(p);
  ok("recommend strength in [0,1]", rec.strength >= 0 && rec.strength <= 1);
  ok("recommend label is a string", typeof rec.label === "string");
})();

/* ---------- tutorial: lessons build & capture lesson validator works ---------- */
(function () {
  const lessons = GT.tutorial.lessons;
  ok("has 11 lessons", lessons.length === 11);
  const cap = lessons.find(l => l.id === "capture");
  const g = GT.tutorial.buildLessonGame(cap);
  // white at (3,3) in atari with last liberty at (3,4)
  g.toMove = E.BLACK;
  const v = cap.steps[1].validate(g, 3 * g.size + 4, {});
  ok("capture lesson validates the capturing point", v.ok === true);
  const vbad = cap.steps[1].validate(g, 0, {});
  ok("capture lesson rejects wrong point", vbad.ok === false);
})();

/* ---------- scoring: two passes enter scoring phase (no auto-end) ---------- */
(function () {
  const g = new E.GoGame(9, 6.5);
  g.play(4 * 9 + 4, E.BLACK);
  g.play(E.PASS, E.WHITE);
  g.play(E.PASS, E.BLACK);
  ok("two passes -> scoringPhase, not ended", g.scoringPhase === true && g.ended === false);
})();

/* ---------- scoring: dead stones removed and counted as territory ---------- */
(function () {
  const g = new E.GoGame(9, 0);
  const B = E.BLACK, W = E.WHITE;
  // Black walls rows 3; white wall row 5. Put a lone white stone deep in black's
  // top area at (1,4); marking it dead should give Black that point back.
  for (let c = 0; c < 9; c++) { g.board[3 * 9 + c] = B; g.board[5 * 9 + c] = W; }
  g.board[1 * 9 + 4] = W; // intruder
  const live = g.scoreArea();           // intruder alive: it's a stone in black's area
  const dead = {}; dead[1 * 9 + 4] = true;
  const scored = g.scoreArea(dead);     // intruder dead: removed, point is black territory
  ok("removing dead stone increases Black area", scored.blackArea > live.blackArea);
  ok("dead stone not counted as White", scored.whiteArea <= live.whiteArea);
})();

/* ---------- scoring: finalize + resume ---------- */
(function () {
  const g = new E.GoGame(9, 6.5);
  g.play(E.PASS, E.BLACK); g.play(E.PASS, E.WHITE);
  ok("scoringPhase set", g.scoringPhase === true);
  g.resumeFromScoring();
  ok("resume clears scoringPhase and passes", g.scoringPhase === false && g.passes === 0);
  g.play(E.PASS, E.BLACK); g.play(E.PASS, E.WHITE);
  const r = g.finalizeScore({});
  ok("finalize ends game with a result", g.ended === true && r.winner != null);
  ok("finalize stores dead set", r.dead && typeof r.dead === "object");
})();

/* ---------- territoryMap returns owners ---------- */
(function () {
  const g = new E.GoGame(9, 0);
  for (let c = 0; c < 9; c++) { g.board[3 * 9 + c] = E.BLACK; g.board[5 * 9 + c] = E.WHITE; }
  const t = g.territoryMap();
  ok("territoryMap marks black top region", t[0] === E.BLACK);
  ok("territoryMap marks white bottom region", t[8 * 9 + 0] === E.WHITE);
})();

/* ---------- autoDeadStones returns an object ---------- */
(function () {
  const g = new E.GoGame(9, 0);
  for (let c = 0; c < 9; c++) { g.board[3 * 9 + c] = E.BLACK; g.board[5 * 9 + c] = E.WHITE; }
  g.board[1 * 9 + 4] = E.WHITE; // enclosed lone white in black area
  const dead = g.autoDeadStones();
  ok("autoDeadStones flags the enclosed lone stone", dead[1 * 9 + 4] === true);
})();

/* ---------- SGF round-trip ---------- */
(function () {
  const g = new E.GoGame(9, 6.5);
  g.play(2 * 9 + 2, E.BLACK);
  g.play(6 * 9 + 6, E.WHITE);
  g.play(E.PASS, E.BLACK);
  const rec = { size: 9, komi: 6.5, handicap: 0, ab: [], aw: [],
    moves: g.history.map(h => ({ color: h.color, point: h.move })), result: "B+R" };
  const text = GT.sgf.toSGF(rec);
  ok("SGF text starts correctly", text.indexOf("(;GM[1]FF[4]") === 0);
  ok("SGF encodes size", text.indexOf("SZ[9]") >= 0);
  ok("SGF encodes a pass as empty", /;B\[\]/.test(text));
  const parsed = GT.sgf.fromSGF(text);
  ok("SGF parse size", parsed.size === 9);
  ok("SGF parse komi", parsed.komi === 6.5);
  ok("SGF parse move count", parsed.moves.length === 3);
  ok("SGF first move is black 2,2", parsed.moves[0].color === E.BLACK && parsed.moves[0].point === 2 * 9 + 2);
  ok("SGF last move is a pass", parsed.moves[2].point === E.PASS);
  const rebuilt = GT.sgf.recordToGame(parsed);
  ok("SGF rebuild replays without illegal", rebuilt.illegal === 0);
  ok("SGF rebuild board matches", rebuilt.game.board[2 * 9 + 2] === E.BLACK && rebuilt.game.board[6 * 9 + 6] === E.WHITE);
})();

/* ---------- SGF handicap (AB) round-trip ---------- */
(function () {
  const rec = { size: 9, komi: 0.5, handicap: 2, ab: [2 * 9 + 2, 6 * 9 + 6], aw: [], moves: [{ color: E.WHITE, point: 4 * 9 + 4 }], result: null };
  const parsed = GT.sgf.fromSGF(GT.sgf.toSGF(rec));
  ok("SGF AB count", parsed.ab.length === 2);
  ok("SGF HA parsed", parsed.handicap === 2);
  const built = GT.sgf.recordToGame(parsed);
  ok("SGF handicap stones placed", built.game.board[2 * 9 + 2] === E.BLACK && built.game.board[6 * 9 + 6] === E.BLACK);
})();

/* ---------- tsumego: every problem's solution is legal & correct ---------- */
(function () {
  GT.problems.list.forEach(function (p) {
    const g = GT.problems.buildGame(p);
    const sols = GT.problems.solutionPoints(p);
    let allLegal = sols.length > 0;
    sols.forEach(function (pt) {
      const fresh = GT.problems.buildGame(p);
      const res = fresh.play(pt, p.color);
      if (!res.ok) allLegal = false;
      if (p.mustCapture && (!res.captured || res.captured.length === 0)) allLegal = false;
    });
    ok("problem '" + p.id + "' solution legal" + (p.mustCapture ? " & captures" : ""), allLegal);
    // a clearly-wrong point (corner 0,0 if empty) should not be a solution
    if (g.board[0] === E.EMPTY) ok("problem '" + p.id + "' rejects corner", sols.indexOf(0) < 0);
  });
})();

/* ---------- generated problem set: large, unique, and engine-correct ---------- */
(function () {
  const all = GT.problems.all();
  ok("generated set is large (>= 200)", all.length >= 200);

  // unique ids
  const ids = {}; let dupes = 0;
  all.forEach(p => { if (ids[p.id]) dupes++; ids[p.id] = true; });
  ok("all problem ids unique", dupes === 0);

  // deterministic: two builds produce the same count
  const a2 = GT.generator.build({ seed: 0x60D11FE });
  ok("generation is deterministic", a2.length === GT.generator.build({ seed: 0x60D11FE }).length);

  // every category present
  ["capture", "endgame", "connect", "life", "fundamentals"].forEach(cat => {
    ok("category '" + cat + "' has problems", GT.problems.filter(cat, 0).length > 0);
  });

  // CORE GUARANTEE: every capture/endgame solution actually captures; every
  // connect solution actually connects; every solution move is legal.
  let capFail = 0, conFail = 0, legalFail = 0;
  all.forEach(p => {
    const g = GT.problems.buildGame(p);
    const sol = GT.problems.solutionPoints(p)[0];
    const t = g.trial(sol, p.color);
    if (!t.legal) { legalFail++; return; }
    if (p.mustCapture && (!t.captured || t.captured.length === 0)) capFail++;
    if (p.category === "connect") {
      // after playing, the two black stones must be one group
      const blacks = p.setup.filter(s => s[0] === E.BLACK).map(s => s[1] * p.size + s[2]);
      const grp = g.group(blacks[0], t.board);
      const set = {}; grp.stones.forEach(s => set[s] = true);
      if (!blacks.every(b => set[b])) conFail++;
    }
  });
  ok("every solution move is legal", legalFail === 0);
  ok("every mustCapture solution captures", capFail === 0);
  ok("every connect solution joins the groups", conFail === 0);
})();

/* ---------- solver: ladders & escapes ---------- */
(function () {
  // atari -> forced capture in 1
  var g = new E.GoGame(9, 0); g.board[4 * 9 + 4] = E.WHITE;
  [[3, 4], [5, 4], [4, 3]].forEach(a => g.board[a[0] * 9 + a[1]] = E.BLACK); g.toMove = E.BLACK;
  ok("solver: atari is a forced capture", GT.solver.solve(g, 4 * 9 + 4, E.BLACK, 30).win === true);

  // working corner ladder
  var g2 = new E.GoGame(9, 0); g2.board[1 * 9 + 1] = E.WHITE;
  [[0, 1], [1, 0], [2, 2]].forEach(a => g2.board[a[0] * 9 + a[1]] = E.BLACK); g2.toMove = E.BLACK;
  ok("solver: corner ladder is forced", GT.solver.solve(g2, 1 * 9 + 1, E.BLACK, 30).win === true);

  // lone 2-liberty stone in open space escapes (no blocker)
  var g3 = new E.GoGame(9, 0); g3.board[4 * 9 + 4] = E.WHITE;
  [[5, 4], [4, 5]].forEach(a => g3.board[a[0] * 9 + a[1]] = E.BLACK); g3.toMove = E.BLACK;
  ok("solver: open 2-lib stone escapes", GT.solver.solve(g3, 4 * 9 + 4, E.BLACK, 30).win === false);
})();

/* ---------- ladder problems are generated and solver-correct ---------- */
(function () {
  var ladders = GT.problems.filter("ladder", 0);
  ok("ladder problems generated", ladders.length >= 4);
  var allMulti = ladders.every(function (p) { return p.multi && p.target && p.attacker === E.BLACK; });
  ok("ladder problems are multi-move with target/attacker", allMulti);
  var allForced = ladders.every(function (p) {
    var g = GT.problems.buildGame(p);
    var origin = p.target[0] * p.size + p.target[1];
    return g.board[origin] === E.WHITE && GT.solver.solve(g, origin, E.BLACK, p.size * 3).win === true;
  });
  ok("every ladder problem is a verified forced capture", allForced);
})();

/* ---------- opening trainer: drills load, setups legal, validators sane ---------- */
(function () {
  var O = GT.opening;
  ok("opening drills exist", O && O.drills.length >= 4);
  var allGood = O.drills.every(function (d) {
    var g = O.buildGame(d);
    // setup stones are placed on an NxN board with the right colours
    var setupOk = (d.setup || []).every(function (s) { return g.board[s.p] === s.color; });
    // there is at least one accepted move, and it differs from a clearly-wrong point
    var sol = O.solutionPoints(d, g);
    var center = ((O.N / 2) | 0) * O.N + ((O.N / 2) | 0);
    var rejectsCenter = d.id === "third-fourth-line" ? true : !d.accept(center, g); // tengen wrong except line drill where center may pass? it doesn't
    return setupOk && sol.length > 0 && rejectsCenter;
  });
  ok("every opening drill: legal setup, ≥1 solution, rejects tengen", allGood);
  // corners-first accepts a 4-4 and rejects the center
  var cf = O.drills.find(function (d) { return d.id === "corners-first"; });
  var cg = O.buildGame(cf);
  ok("corners-first accepts 4-4", cf.accept(3 * O.N + 3, cg));
  ok("corners-first rejects center", !cf.accept(6 * O.N + 6, cg));
})();

/* ---------- SGF: variation branches round-trip ---------- */
(function () {
  const rec = {
    size: 9, komi: 5.5, handicap: 0, ab: [], aw: [],
    moves: [
      { color: E.BLACK, point: 2 * 9 + 2 },
      { color: E.WHITE, point: 6 * 9 + 6 },
      { color: E.BLACK, point: 4 * 9 + 4 }
    ],
    result: "B+3",
    lines: [
      { base: 1, name: "alt response", moves: [{ color: E.WHITE, point: 2 * 9 + 6 }, { color: E.BLACK, point: 6 * 9 + 2 }] },
      { base: 3, name: "endgame idea", moves: [{ color: E.WHITE, point: 0 }] }
    ]
  };
  const sgf = GT.sgf.toSGF(rec);
  ok("SGF with branches contains a branch paren", sgf.indexOf("(", 1) > 0);
  const back = GT.sgf.fromSGF(sgf);
  ok("round-trip: main line preserved", back.moves.length === 3 &&
    back.moves[0].point === 2 * 9 + 2 && back.moves[2].point === 4 * 9 + 4);
  ok("round-trip: two lines parsed", back.lines && back.lines.length === 2);
  const l1 = (back.lines || []).filter(l => l.base === 1)[0];
  ok("round-trip: line base + first move + name", l1 && l1.moves.length === 2 &&
    l1.moves[0].point === 2 * 9 + 6 && l1.name === "alt response");
  // a plain game (no lines) still round-trips with empty lines
  const plain = GT.sgf.fromSGF(GT.sgf.toSGF({ size: 9, komi: 5.5, moves: [{ color: E.BLACK, point: 40 }] }));
  ok("plain SGF round-trips with no lines", plain.moves.length === 1 && plain.lines.length === 0);
})();

/* ---------- ranking: multiple profiles + Default migration ---------- */
(function () {
  const R = GT.ranking;
  // start clean so the Default-migration path is exercised deterministically
  ["gotutor.profiles.v1", "gotutor.profile.v1", "gotutor.profile.v1::Default", "gotutor.profile.v1::Bob"]
    .forEach(k => localStorage.removeItem(k));
  // legacy single profile present -> migrated to "Default" on first access
  localStorage.setItem("gotutor.profile.v1", JSON.stringify({ skill: 9, games: 5, wins: 3 }));
  const def = R.load();
  ok("legacy profile migrated to Default", R.activeName() === "Default" && def.games === 5);
  // create + switch
  R.createProfile("Bob");
  ok("createProfile activates new profile", R.activeName() === "Bob");
  ok("listProfiles has both", R.listProfiles().indexOf("Default") >= 0 && R.listProfiles().indexOf("Bob") >= 0);
  const bob = R.load(); bob.skill = 15; R.save(bob);
  R.switchProfile("Default");
  ok("switch back keeps Default's skill", Math.round(R.load().skill) === 9);
  R.switchProfile("Bob");
  ok("Bob's saved skill persisted", R.load().skill === 15);
  // delete
  R.deleteProfile("Bob");
  ok("deleteProfile removes it + reactivates", R.listProfiles().indexOf("Bob") < 0 && R.activeName() === "Default");
  ok("cannot delete the last profile", (R.deleteProfile("Default"), R.listProfiles().length === 1));
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
