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
   *   moves:[{color, point, comment?}], result:string|null, meta:{},
   *   rootComment?:string, lines?:[{base:int, moves:[{color,point}]}]
   * }
   * Saved variation `lines` are emitted as standard SGF `(...)` branch subtrees,
   * each diverging after main move index (base-1) (or the root when base==0). */
  function toSGF(record) {
    var size = record.size, komi = record.komi, B = E.BLACK;
    var setup = "GM[1]FF[4]CA[UTF-8]AP[GoTutor:1]SZ[" + size + "]";
    if (komi != null) setup += "KM[" + komi + "]";
    if (record.handicap && record.handicap >= 2) setup += "HA[" + record.handicap + "]";
    if (record.result) setup += "RE[" + record.result + "]";
    if (record.meta && record.meta.date) setup += "DT[" + record.meta.date + "]";
    if (record.ab && record.ab.length) {
      setup += "AB"; record.ab.forEach(function (p) { setup += "[" + pointToSgf(p, size) + "]"; });
    }
    if (record.aw && record.aw.length) {
      setup += "AW"; record.aw.forEach(function (p) { setup += "[" + pointToSgf(p, size) + "]"; });
    }
    if (record.rootComment) setup += "C[" + escapeSgf(record.rootComment) + "]";
    // Lossless saved-lines blob (ignored by other SGF tools; we read it back exactly).
    // Standard (...) branches are still emitted below for interoperability.
    if (record.lines && record.lines.length) {
      var gtl = record.lines.map(function (ln) {
        return { b: ln.base, n: ln.name || "", m: ln.moves.map(function (m) { return [m.color, m.point]; }) };
      });
      setup += "GL[" + escapeSgf(JSON.stringify(gtl)) + "]";
    }

    function moveProps(m) {
      return (m.color === B ? "B" : "W") + "[" + pointToSgf(m.point, size) + "]" +
        (m.comment ? "C[" + escapeSgf(m.comment) + "]" : "");
    }

    // Build a node tree: root (setup) -> main move chain, with saved lines as branches.
    var root = { props: setup, children: [] };
    var mainMoves = record.moves || [];
    var mainNodes = mainMoves.map(function (m) { return { props: moveProps(m), children: [] }; });
    for (var i = 0; i < mainNodes.length; i++) {
      (i === 0 ? root : mainNodes[i - 1]).children.push(mainNodes[i]);
    }
    (record.lines || []).forEach(function (ln) {
      if (!ln.moves || !ln.moves.length) return;
      // Tail continuations (base == mainLen) would linearise into the main line and
      // pollute it; those round-trip via the GTL blob instead. Only emit standard
      // branches for genuine mid-game divergences (which serialize as real siblings).
      if (ln.base >= mainNodes.length) return;
      var parent = (ln.base <= 0) ? root : (mainNodes[ln.base - 1] || mainNodes[mainNodes.length - 1] || root);
      var chain = ln.moves.map(function (m) { return { props: moveProps(m), children: [] }; });
      if (ln.name) chain[0].props += "C[" + escapeSgf(ln.name) + "]";
      for (var j = 1; j < chain.length; j++) chain[j - 1].children.push(chain[j]);
      parent.children.push(chain[0]);
    });

    function ser(node) {
      var s = ";" + node.props;
      var ch = node.children;
      if (ch.length === 0) return s;
      if (ch.length === 1) return s + ser(ch[0]);
      return s + ch.map(function (c) { return "(" + ser(c) + ")"; }).join("");
    }
    return "(" + ser(root) + ")";
  }

  function escapeSgf(str) { return String(str).replace(/\\/g, "\\\\").replace(/\]/g, "\\]"); }

  /* Tokenise SGF into '(' , ')' and node objects {props:[{name,vals}]}.
   * Bracketed values are read char-by-char so ()/; inside comments are safe. */
  function tokenize(text) {
    var toks = [], i = 0, n = text.length;
    while (i < n) {
      var ch = text[i];
      if (ch === "(" || ch === ")") { toks.push(ch); i++; continue; }
      if (ch === ";") {
        i++;
        var props = [];
        while (i < n) {
          while (i < n && /\s/.test(text[i])) i++;
          var mm = /^[A-Z]{1,2}/.exec(text.slice(i));
          if (!mm) break;
          var name = mm[0]; i += name.length;
          var vals = [];
          while (i < n) {
            while (i < n && /\s/.test(text[i])) i++;
            if (text[i] !== "[") break;
            i++; var v = "";
            while (i < n && text[i] !== "]") {
              if (text[i] === "\\") { v += (text[i + 1] || ""); i += 2; }
              else { v += text[i]; i++; }
            }
            i++; // closing ]
            vals.push(v);
          }
          props.push({ name: name, vals: vals });
        }
        toks.push({ props: props });
        continue;
      }
      i++; // skip stray characters
    }
    return toks;
  }

  // Recursive descent: GameTree = '(' Node+ GameTree* ')'.
  function parseTree(toks) {
    var pos = 0;
    function parseGT() {
      pos++; // consume '('
      var nodes = [];
      while (pos < toks.length && typeof toks[pos] === "object") { nodes.push(toks[pos]); pos++; }
      var children = [];
      while (pos < toks.length && toks[pos] === "(") children.push(parseGT());
      if (toks[pos] === ")") pos++;
      return { nodes: nodes, children: children };
    }
    while (pos < toks.length && toks[pos] !== "(") pos++;
    if (pos >= toks.length) throw new Error("No SGF game tree");
    return parseGT();
  }

  /* Parse an SGF string into a record, including saved variation `lines`.
   * Falls back to a flat token scan if structured parsing fails. */
  function fromSGF(text) {
    if (!text || text.indexOf(";") < 0) throw new Error("Not an SGF file");
    try { return fromSGFTree(text); }
    catch (e) { return fromSGFFlat(text); }
  }

  function fromSGFTree(text) {
    var szMatch = /\bSZ\[([0-9]+)\]/.exec(text);
    var size = szMatch ? parseInt(szMatch[1], 10) : 19;
    var rec = { size: size, komi: null, handicap: 0, result: null, ab: [], aw: [], moves: [], lines: [] };

    function applyProps(node) {
      var mv = null;
      node.props.forEach(function (pr) {
        var v = pr.vals[0];
        switch (pr.name) {
          case "SZ": rec.size = parseInt(v, 10) || rec.size; break;
          case "KM": rec.komi = parseFloat(v); break;
          case "HA": rec.handicap = parseInt(v, 10) || 0; break;
          case "RE": rec.result = v; break;
          case "AB": pr.vals.forEach(function (x) { rec.ab.push(sgfToPoint(x, rec.size)); }); break;
          case "AW": pr.vals.forEach(function (x) { rec.aw.push(sgfToPoint(x, rec.size)); }); break;
          case "B": mv = { color: E.BLACK, point: sgfToPoint(v, rec.size) }; break;
          case "W": mv = { color: E.WHITE, point: sgfToPoint(v, rec.size) }; break;
          case "GL": rec._gtl = v; break;
          default: break;
        }
      });
      return mv;
    }

    function flattenFirstChild(gt, out) {
      gt.nodes.forEach(function (node) { var m = applyMoveOnly(node); if (m) out.push(m); });
      if (gt.children[0]) flattenFirstChild(gt.children[0], out);
    }
    function applyMoveOnly(node) {
      var mv = null;
      node.props.forEach(function (pr) {
        if (pr.name === "B") mv = { color: E.BLACK, point: sgfToPoint(pr.vals[0], rec.size) };
        else if (pr.name === "W") mv = { color: E.WHITE, point: sgfToPoint(pr.vals[0], rec.size) };
      });
      return mv;
    }

    // Walk the main path; collect non-first child GameTrees as saved lines.
    function walk(gt, baseCount, onMain) {
      var moves = [];
      gt.nodes.forEach(function (node) {
        var m = onMain ? applyProps(node) : applyMoveOnly(node);
        if (m) moves.push(m);
      });
      if (onMain) for (var k = 0; k < moves.length; k++) rec.moves.push(moves[k]);
      var newBase = baseCount + moves.length;
      gt.children.forEach(function (child, ci) {
        if (onMain && ci === 0) {
          walk(child, newBase, true);
        } else {
          var bm = [];
          flattenFirstChild(child, bm);
          if (bm.length) {
            var nm = null;
            if (child.nodes[0]) child.nodes[0].props.forEach(function (pr) { if (pr.name === "C") nm = pr.vals[0]; });
            rec.lines.push({ base: newBase, moves: bm, name: nm });
          }
        }
      });
    }

    var tree = parseTree(tokenize(text));
    walk(tree, 0, true);
    // Prefer the lossless GTL blob when present (exact round-trip of saved lines).
    if (rec._gtl) {
      try {
        var arr = JSON.parse(rec._gtl);
        rec.lines = arr.map(function (o) {
          return { base: o.b, name: o.n, moves: (o.m || []).map(function (pr) { return { color: pr[0], point: pr[1] }; }) };
        });
      } catch (e) { /* keep branch-derived lines */ }
      delete rec._gtl;
    }
    if (rec.komi == null) rec.komi = E.defaultKomi(rec.size);
    return rec;
  }

  /* Legacy flat scan: follows every B/W in document order, ignoring branches. */
  function fromSGFFlat(text) {
    var size = 19, komi = null, handicap = 0, result = null;
    var ab = [], aw = [], moves = [];
    var re = /([A-Z]{1,2})((?:\[[^\]]*\])+)/g, m;
    var szMatch = /\bSZ\[([0-9]+)\]/.exec(text);
    if (szMatch) size = parseInt(szMatch[1], 10);
    while ((m = re.exec(text)) !== null) {
      var name = m[1], rawVals = m[2], vals = [];
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
        default: break;
      }
    }
    return {
      size: size, komi: (komi == null ? E.defaultKomi(size) : komi),
      handicap: handicap, ab: ab, aw: aw, moves: moves, result: result, lines: []
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
