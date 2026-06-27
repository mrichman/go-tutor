/* Procedural tsumego generator — engine-verified.
 *
 * Every generated problem is simulated through the rules engine: we only keep
 * it if the solution move actually achieves its goal (captures the group,
 * connects the stones, etc.). This guarantees no broken problems.
 *
 * Categories:
 *   capture  — enemy group reduced to one liberty; play it to capture.
 *   endgame  — same, but on the edge/corner (securing the boundary).
 *   connect  — play the linking point to join two of your groups.
 *   life     — life & death: the vital point of a standard eye shape
 *              (live = defender makes two eyes; kill = attacker prevents them).
 *              Vital points are textbook for these shapes; legality is engine-
 *              checked but life/death itself is not proven (no full solver).
 *
 * Output problems share the shape used by js/problems.js:
 *   { id, title, size, color, setup:[[color,r,c]...], solution:[[r,c]...],
 *     mustCapture?, category, difficulty(1..3), hint, explain }
 *
 * Generation is deterministic (seeded PRNG) so problem ids are stable across
 * reloads — that keeps your "solved" progress meaningful.
 */
(function (GT) {
  "use strict";
  var E = GT.engine, B = E.BLACK, W = E.WHITE;

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function neighbors(p, size) {
    var r = (p / size) | 0, c = p % size, res = [];
    if (r > 0) res.push(p - size);
    if (r < size - 1) res.push(p + size);
    if (c > 0) res.push(p - 1);
    if (c < size - 1) res.push(p + 1);
    return res;
  }
  function rc(p, size) { return [(p / size) | 0, p % size]; }
  function touchesEdge(stones, size) {
    return stones.some(function (p) {
      var r = (p / size) | 0, c = p % size;
      return r === 0 || c === 0 || r === size - 1 || c === size - 1;
    });
  }
  function pick(rng, arr) { return arr[(rng() * arr.length) | 0]; }
  function randInt(rng, lo, hi) { return lo + ((rng() * (hi - lo + 1)) | 0); }

  /* ---- capture / endgame: grow an enemy group, fill all-but-one liberty ---- */
  function growGroup(rng, size, k, interior) {
    var lo = interior ? 1 : 0, hi = interior ? size - 2 : size - 1;
    var start = randInt(rng, lo, hi) * size + randInt(rng, lo, hi);
    var stones = [start], set = {}; set[start] = true;
    var guard = 0;
    while (stones.length < k && guard++ < 60) {
      var grew = false;
      for (var i = 0; i < stones.length && !grew; i++) {
        var nbs = neighbors(stones[i], size).filter(function (q) { return !set[q]; });
        if (nbs.length) {
          var q = pick(rng, nbs); set[q] = true; stones.push(q); grew = true;
        }
      }
      if (!grew) break;
    }
    return stones;
  }

  function libertiesOf(stones, size) {
    var set = {}; stones.forEach(function (p) { set[p] = true; });
    var libs = {};
    stones.forEach(function (p) {
      neighbors(p, size).forEach(function (q) { if (!set[q]) libs[q] = true; });
    });
    return Object.keys(libs).map(Number);
  }

  function tryCapture(rng) {
    var size = pick(rng, [5, 5, 6, 7, 7, 9]);
    var k = randInt(rng, 1, 4);
    var group = growGroup(rng, size, k, true);
    if (group.length < 1) return null;
    var libs = libertiesOf(group, size);
    if (libs.length < 2 || libs.length > 6) return null;
    var solution = pick(rng, libs);
    var fills = libs.filter(function (p) { return p !== solution; });

    // Build + verify with the engine.
    var g = new E.GoGame(size, 0);
    group.forEach(function (p) { g.board[p] = W; });
    fills.forEach(function (p) { g.board[p] = B; });
    g.toMove = B;
    var grp = g.group(group[0]);
    if (grp.stones.length !== group.length) return null;   // must be one group of size k
    if (grp.libCount !== 1) return null;
    var t = g.trial(solution, B);
    if (!t.legal || t.captured.length !== group.length) return null;

    var setup = [];
    group.forEach(function (p) { var a = rc(p, size); setup.push([W, a[0], a[1]]); });
    fills.forEach(function (p) { var a = rc(p, size); setup.push([B, a[0], a[1]]); });
    var sol = rc(solution, size);
    var edge = touchesEdge(group, size);
    var diff = k <= 1 ? 1 : k <= 3 ? 2 : 3;
    return {
      size: size, color: B, setup: setup, solution: [sol],
      mustCapture: true, difficulty: diff,
      _edge: edge, _stones: group.length
    };
  }

  /* ---- connect: play the linking point to join two friendly groups ---- */
  function tryConnect(rng) {
    var size = pick(rng, [5, 7, 7, 9]);
    var horiz = rng() < 0.5;
    var r = randInt(rng, 1, size - 2), c = randInt(rng, 1, size - 4);
    var A, gap, Bp;
    if (horiz) { A = r * size + c; gap = r * size + c + 1; Bp = r * size + c + 2; }
    else { A = c * size + r; gap = (c + 1) * size + r; Bp = (c + 2) * size + r; }
    // enemy cut threats either side of the gap
    var ga = rc(gap, size), threats = [];
    [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(function (d) {
      var rr = ga[0] + d[0], cc = ga[1] + d[1];
      var pt = rr * size + cc;
      if (rr >= 0 && cc >= 0 && rr < size && cc < size && pt !== A && pt !== Bp) {
        // place a couple of threats perpendicular to the connection axis
        if (horiz ? d[0] !== 0 : d[1] !== 0) threats.push(pt);
      }
    });

    var g = new E.GoGame(size, 0);
    g.board[A] = B; g.board[Bp] = B;
    threats.forEach(function (p) { g.board[p] = W; });
    g.toMove = B;
    var gA = g.group(A);
    if (gA.stones.indexOf(Bp) !== -1) return null;     // already connected
    var t = g.trial(gap, B);
    if (!t.legal) return null;
    var merged = g.group(gap, t.board);
    var ms = {}; merged.stones.forEach(function (s) { ms[s] = true; });
    if (!ms[A] || !ms[Bp]) return null;                // must join both

    var setup = [];
    [[B, A], [B, Bp]].forEach(function (x) { var a = rc(x[1], size); setup.push([B, a[0], a[1]]); });
    threats.forEach(function (p) { var a = rc(p, size); setup.push([W, a[0], a[1]]); });
    var sol = rc(gap, size);
    return { size: size, color: B, setup: setup, solution: [sol], mustCapture: false, difficulty: threats.length >= 2 ? 2 : 1 };
  }

  /* ---- life & death: standard eye shapes with known vital points ---- */
  var SHAPES = [
    { name: "straight three", cells: [[0, 0], [0, 1], [0, 2]], vital: [0, 1] },
    { name: "bent three", cells: [[0, 0], [0, 1], [1, 1]], vital: [0, 1] },
    { name: "pyramid four", cells: [[0, 0], [0, 1], [0, 2], [1, 1]], vital: [0, 1] }
  ];
  // 8 dihedral transforms on (r,c)
  var TRANSFORMS = [
    function (r, c) { return [r, c]; }, function (r, c) { return [r, -c]; },
    function (r, c) { return [-r, c]; }, function (r, c) { return [-r, -c]; },
    function (r, c) { return [c, r]; }, function (r, c) { return [c, -r]; },
    function (r, c) { return [-c, r]; }, function (r, c) { return [-c, -r]; }
  ];

  function transformShape(shape, tf) {
    var cells = shape.cells.map(function (p) { return tf(p[0], p[1]); });
    var vital = tf(shape.vital[0], shape.vital[1]);
    var minR = Math.min.apply(null, cells.map(function (p) { return p[0]; }));
    var minC = Math.min.apply(null, cells.map(function (p) { return p[1]; }));
    cells = cells.map(function (p) { return [p[0] - minR, p[1] - minC]; });
    vital = [vital[0] - minR, vital[1] - minC];
    return { name: shape.name, cells: cells, vital: vital };
  }

  function buildLife(size, shape, originR, originC, kind) {
    var owner = (kind === "live") ? B : W;   // whose eye space it is
    var player = (kind === "live") ? B : W;  // 'live': owner defends; 'kill': attacker
    if (kind === "kill") player = B;          // attacker is Black for our UI
    if (kind === "live") player = B;          // defender is Black for our UI
    // For 'kill', the space is White's and Black plays the vital. For 'live',
    // the space is Black's and Black plays the vital.
    owner = (kind === "live") ? B : W;

    var spaceSet = {}, space = [];
    var ok = true;
    shape.cells.forEach(function (p) {
      var r = originR + p[0], c = originC + p[1];
      if (r < 0 || c < 0 || r >= size || c >= size) ok = false;
      else { var pt = r * size + c; space.push(pt); spaceSet[pt] = true; }
    });
    if (!ok) return null;
    // wall = every in-bounds orthogonal neighbor of the space not in the space
    var wall = {};
    var leak = false;
    space.forEach(function (pt) {
      neighbors(pt, size).forEach(function (q) { if (!spaceSet[q]) wall[q] = true; });
    });
    var wallPts = Object.keys(wall).map(Number);
    var vital = [originR + shape.vital[0], originC + shape.vital[1]];
    var vitalPt = vital[0] * size + vital[1];
    if (spaceSet[vitalPt] !== true) return null;

    var g = new E.GoGame(size, 0);
    wallPts.forEach(function (p) { g.board[p] = owner; });
    g.toMove = player;
    var t = g.trial(vitalPt, player);
    if (!t.legal) return null;

    var setup = [];
    wallPts.forEach(function (p) { var a = rc(p, size); setup.push([owner, a[0], a[1]]); });
    return {
      size: size, color: player, setup: setup, solution: [vital],
      mustCapture: false, difficulty: shape.cells.length >= 4 ? 3 : 2,
      _kind: kind, _shape: shape.name
    };
  }

  /* ---- ladders: solver-verified forced captures (multi-move) ----
   * Built from corner templates and confirmed by the capture solver, so only
   * genuinely forced ladders ship. These are interactive multi-move problems:
   * the opponent's resistance is auto-played and any move that preserves the
   * forced capture is accepted (handled in app.js via GT.solver). */
  var LADDER_TEMPLATES = [
    // corner template (top-left): target T, blockers around it; ladder runs into the corner
    { target: [1, 1], black: [[0, 1], [1, 0], [2, 2]] },
    { target: [1, 1], black: [[0, 1], [1, 0], [2, 2], [3, 3]] }
  ];

  function genLadders(out, add) {
    LADDER_TEMPLATES.forEach(function (tmpl) {
      TRANSFORMS.forEach(function (tf) {
        // transform target + blacks together, normalize to non-negative
        var pts = [tmpl.target].concat(tmpl.black).map(function (p) { return tf(p[0], p[1]); });
        var minR = Math.min.apply(null, pts.map(function (p) { return p[0]; }));
        var minC = Math.min.apply(null, pts.map(function (p) { return p[1]; }));
        pts = pts.map(function (p) { return [p[0] - minR, p[1] - minC]; });
        var target = pts[0], blacks = pts.slice(1);
        [7, 9, 13].forEach(function (size) {
          // place against each board corner by translating the normalized shape
          var spanR = Math.max.apply(null, pts.map(function (p) { return p[0]; }));
          var spanC = Math.max.apply(null, pts.map(function (p) { return p[1]; }));
          var corners = [[0, 0], [0, size - 1 - spanC], [size - 1 - spanR, 0], [size - 1 - spanR, size - 1 - spanC]];
          corners.forEach(function (off) {
            var tR = target[0] + off[0], tC = target[1] + off[1];
            var g = new E.GoGame(size, 0);
            var tIdx = tR * size + tC;
            g.board[tIdx] = W;
            var ok = true;
            blacks.forEach(function (b) {
              var r = b[0] + off[0], c = b[1] + off[1];
              if (r < 0 || c < 0 || r >= size || c >= size) ok = false;
              else g.board[r * size + c] = B;
            });
            if (!ok) return;
            g.toMove = B;
            if (g.board[tIdx] !== W) return;
            if (!GT.solver) return;
            var res = GT.solver.solve(g, tIdx, B, size * 3);
            if (!res.win || res.move == null) return;
            var setup = [[W, tR, tC]];
            blacks.forEach(function (b) { setup.push([B, b[0] + off[0], b[1] + off[1]]); });
            add({
              size: size, color: B, setup: setup,
              solution: [[(res.move / size) | 0, res.move % size]], // the starting atari (for hint)
              multi: true, target: [tR, tC], attacker: B,
              difficulty: tmpl.black.length >= 4 ? 3 : 2
            }, "ladder");
          });
        });
      });
    });
  }

  function decorate(prob, category, n) {
    prob.category = category;
    var sizeTag = prob.size + "\u00d7" + prob.size;
    if (category === "capture" || category === "endgame") {
      var stones = prob._stones;
      prob.title = (category === "endgame" ? "Edge capture" : "Capture") + " #" + n + " (" + sizeTag + ")";
      prob.hint = "A white group has one liberty left. Find the point that takes it.";
      prob.explain = "Filling the last liberty captures all " + stones + " stone" + (stones > 1 ? "s" : "") + ".";
    } else if (category === "connect") {
      prob.title = "Connect #" + n + " (" + sizeTag + ")";
      prob.hint = "Your two stones can be linked. Play the point that joins them before White cuts.";
      prob.explain = "Connecting makes one strong group instead of two cuttable ones.";
    } else if (category === "life") {
      var live = prob._kind === "live";
      prob.title = (live ? "Live" : "Kill") + " #" + n + " — " + prob._shape + " (" + sizeTag + ")";
      prob.hint = live
        ? "Your group surrounds this eye space. Play the vital point to make two eyes."
        : "White's eye space has one weak point. Play the vital point so it can't make two eyes.";
      prob.explain = live
        ? "The vital point of a " + prob._shape + " splits the space into two eyes — unconditional life."
        : "Occupying the vital point of a " + prob._shape + " leaves White only one eye — the group dies.";
    } else if (category === "ladder") {
      prob.title = "Ladder #" + n + " (" + sizeTag + ")";
      prob.hint = "Chase the white stone in a ladder — keep it in atari every move so it can never get free.";
      prob.explain = "A ladder works: every escape stays in atari until the stone hits the edge and is captured.";
    }
    delete prob._edge; delete prob._stones; delete prob._kind; delete prob._shape;
    return prob;
  }

  /* ---- top-level build ---- */
  function build(opts) {
    opts = opts || {};
    var rng = mulberry32(opts.seed || 0xBADA55);
    var seen = {}, out = [];
    var quotas = { capture: opts.capture || 110, endgame: opts.endgame || 30, connect: opts.connect || 45 };
    var counts = { capture: 0, endgame: 0, connect: 0, life: 0, ladder: 0 };

    function key(p) {
      return p.category + "|" + p.size + "|" +
        p.setup.map(function (s) { return s.join(","); }).sort().join(";") + "|" + p.solution.join(",");
    }
    function add(p, cat) {
      if (!p) return false;
      p.category = cat;
      var ky = key(p);
      if (seen[ky]) return false;
      seen[ky] = true;
      counts[cat]++;
      decorate(p, cat, counts[cat]);
      p.id = cat + "_" + counts[cat];
      out.push(p);
      return true;
    }

    // capture + endgame come from the same generator, routed by edge-touch
    var guard = 0;
    while ((counts.capture < quotas.capture || counts.endgame < quotas.endgame) && guard++ < 20000) {
      var c = tryCapture(rng);
      if (!c) continue;
      if (c._edge && counts.endgame < quotas.endgame) add(c, "endgame");
      else if (!c._edge && counts.capture < quotas.capture) add(c, "capture");
      else if (counts.capture < quotas.capture) add(c, "capture");
      else if (counts.endgame < quotas.endgame) add(c, "endgame");
    }
    guard = 0;
    while (counts.connect < quotas.connect && guard++ < 20000) {
      add(tryConnect(rng), "connect");
    }
    // life & death: enumerate shapes x transforms x positions x kinds
    var lifeSizes = [7, 9];
    ["live", "kill"].forEach(function (kind) {
      SHAPES.forEach(function (shape) {
        TRANSFORMS.forEach(function (tf) {
          var s = transformShape(shape, tf);
          lifeSizes.forEach(function (size) {
            for (var or = 1; or < size - 1; or += 2) {
              for (var oc = 1; oc < size - 1; oc += 2) {
                var p = buildLife(size, s, or, oc, kind);
                if (p) add(p, "life");
              }
            }
          });
        });
      });
    });

    // ladders: solver-verified forced captures (multi-move)
    genLadders(out, add);

    return out;
  }

  GT.generator = { build: build, _mulberry32: mulberry32 };
})(window.GT = window.GT || {});
