/* SGF (Smart Game Format) read/write — the standard Go record format.
 * Pure logic on the GT namespace. Supports the subset this app needs:
 *   GM, FF, SZ, KM, HA, AB, AW, RE, B, W (pass = empty value).
 *
 * SGF point coords: column then row, each a letter a..s (0..18). Pass = "".
 */
(function (GT) {
  "use strict";
  var E = GT.engine;
  var LETTERS = "abcdefghijklmnopqrs";

  function pointToSgf(p, size) {
    if (p === E.PASS || p == null || p < 0) return "";
    var r = Math.floor(p / size), c = p % size;
    return LETTERS[c] + LETTERS[r];
  }
  function sgfToPoint(s, size) {
    if (!s || s.length < 2) return E.PASS;
    var c = LETTERS.indexOf(s[0]), r = LETTERS.indexOf(s[1]);
    if (c < 0 || r < 0 || c >= size || r >= size) return E.PASS;
    return r * size + c;
  }

  /* record = {
   *   size, komi, handicap, ab:[points], aw:[points],
   *   moves:[{color, point}], result:string|null, meta:{}
   * } */
  function toSGF(record) {
    var size = record.size, komi = record.komi;
    var s = "(;GM[1]FF[4]CA[UTF-8]AP[GoTutor:1]";
    s += "SZ[" + size + "]";
    if (komi != null) s += "KM[" + komi + "]";
    if (record.handicap && record.handicap >= 2) s += "HA[" + record.handicap + "]";
    if (record.result) s += "RE[" + record.result + "]";
    if (record.meta && record.meta.date) s += "DT[" + record.meta.date + "]";
    if (record.ab && record.ab.length) {
      s += "AB"; record.ab.forEach(function (p) { s += "[" + pointToSgf(p, size) + "]"; });
    }
    if (record.aw && record.aw.length) {
      s += "AW"; record.aw.forEach(function (p) { s += "[" + pointToSgf(p, size) + "]"; });
    }
    (record.moves || []).forEach(function (m) {
      var c = m.color === E.BLACK ? "B" : "W";
      s += ";" + c + "[" + pointToSgf(m.point, size) + "]";
    });
    s += ")";
    return s;
  }

  /* Parse the main line of an SGF string into a record. Ignores variations
   * (only follows the first branch) and unsupported properties. */
  function fromSGF(text) {
    if (!text || text.indexOf(";") < 0) throw new Error("Not an SGF file");
    // Strip everything after the first top-level close isn't trivial with
    // variations; we just scan property tokens in order and follow the main
    // line by taking B/W nodes as we encounter them (good enough for our files
    // and most single-line records).
    var size = 19, komi = null, handicap = 0, result = null;
    var ab = [], aw = [], moves = [];

    // Tokenise into property blocks: NAME[v][v]...
    var re = /([A-Z]{1,2})((?:\[[^\]]*\])+)/g, m;
    // We need size before decoding points; do a first pass for SZ.
    var szMatch = /\bSZ\[([0-9]+)\]/.exec(text);
    if (szMatch) size = parseInt(szMatch[1], 10);

    while ((m = re.exec(text)) !== null) {
      var name = m[1];
      var rawVals = m[2];
      var vals = [];
      var vre = /\[([^\]]*)\]/g, vm;
      while ((vm = vre.exec(rawVals)) !== null) vals.push(vm[1]);
      switch (name) {
        case "SZ": size = parseInt(vals[0], 10) || size; break;
        case "KM": komi = parseFloat(vals[0]); break;
        case "HA": handicap = parseInt(vals[0], 10) || 0; break;
        case "RE": result = vals[0]; break;
        case "AB": vals.forEach(function (v) { ab.push(sgfToPoint(v, size)); }); break;
        case "AW": vals.forEach(function (v) { aw.push(sgfToPoint(v, size)); }); break;
        case "B": moves.push({ color: E.BLACK, point: sgfToPoint(vals[0], size) }); break;
        case "W": moves.push({ color: E.WHITE, point: sgfToPoint(vals[0], size) }); break;
        default: break; // ignore others
      }
    }
    return {
      size: size, komi: (komi == null ? E.defaultKomi(size) : komi),
      handicap: handicap, ab: ab, aw: aw, moves: moves, result: result
    };
  }

  /* Build a playable GoGame from a parsed record (replaying the moves). */
  function recordToGame(record) {
    var g = new E.GoGame(record.size, record.komi);
    (record.ab || []).forEach(function (p) { if (p >= 0) g.board[p] = E.BLACK; });
    (record.aw || []).forEach(function (p) { if (p >= 0) g.board[p] = E.WHITE; });
    if ((record.ab && record.ab.length) || (record.aw && record.aw.length)) {
      g._rememberPosition();
      g.toMove = record.moves.length ? record.moves[0].color : E.WHITE;
    }
    var bad = 0;
    (record.moves || []).forEach(function (mv) {
      g.toMove = mv.color;            // trust the record's move order
      var res = g.play(mv.point, mv.color);
      if (!res.ok) bad++;
    });
    return { game: g, illegal: bad };
  }

  GT.sgf = {
    toSGF: toSGF, fromSGF: fromSGF, recordToGame: recordToGame,
    pointToSgf: pointToSgf, sgfToPoint: sgfToPoint
  };
})(window.GT = window.GT || {});
