/* Adaptive Go opponent.
 * Heuristic engine with a single `strength` knob (0..1). Always returns a legal
 * move (or PASS). Strength scales: randomness, search depth of capture/atari
 * reading, influence weighting, and willingness to pass/resign.
 *
 * This is deliberately lightweight (no neural net). It is strong enough to teach
 * fundamentals and to give a graded ladder of difficulty, but it does NOT truly
 * play at dan level. The ranking module treats levels as *calibrated* rather
 * than absolute.
 */
(function (GT) {
  "use strict";

  var E = GT.engine;
  var BLACK = E.BLACK, WHITE = E.WHITE, EMPTY = E.EMPTY, PASS = E.PASS;

  function Bot(strength) {
    this.strength = clamp01(strength == null ? 0.4 : strength);
  }

  Bot.prototype.setStrength = function (s) { this.strength = clamp01(s); };

  /* Choose a move for game.toMove. Returns a point or PASS. */
  Bot.prototype.chooseMove = function (game) {
    var color = game.toMove;
    var enemy = E.opp(color);
    var s = this.strength;
    var moves = candidateMoves(game, color);
    if (moves.length === 0) return PASS;

    // Score every candidate.
    var scored = [];
    for (var i = 0; i < moves.length; i++) {
      var p = moves[i];
      scored.push({ p: p, v: scoreMove(game, p, color, enemy, s) });
    }
    scored.sort(function (a, b) { return b.v - a.v; });

    // Decide whether to pass: only late, only if no move gains meaningfully,
    // and only if we're not losing badly (avoid passing away a winnable game).
    var best = scored[0];
    if (best.v <= 0.5 && game.moveNumber > game.size * game.size * 0.55) {
      var sc = game.scoreArea();
      var ahead = (color === BLACK) ? (sc.scoreBlack - sc.scoreWhite)
                                    : (sc.scoreWhite - sc.scoreBlack);
      if (ahead > 0.5) return PASS;
    }

    // Temperature: weaker bots pick more randomly among decent moves.
    var temp = 1.0 - s; // 1 (random) .. 0 (greedy)
    var topK = Math.max(1, Math.round(1 + temp * Math.min(12, scored.length)));
    var pool = scored.slice(0, topK);
    // Softmax-ish weighted pick.
    var pick = weightedPick(pool, 0.6 + s * 3.0);
    return pick.p;
  };

  /* Candidate move list: legal, non-eye-filling points, biased to interesting
   * regions to keep scoring cheap on 19x19. */
  function candidateMoves(game, color) {
    var n = game.size, b = game.board, res = [];
    // If almost-empty board, restrict to sensible opening points for speed/quality.
    if (game.moveNumber < 6 && n >= 13) {
      var pts = openingPoints(n);
      for (var k = 0; k < pts.length; k++) {
        if (b[pts[k]] === EMPTY && game.isLegal(pts[k], color)) res.push(pts[k]);
      }
      if (res.length) return res;
    }
    for (var p = 0; p < b.length; p++) {
      if (b[p] !== EMPTY) continue;
      if (game.isEyeLike(p, color)) continue; // never fill own eyes
      if (!game.isLegal(p, color)) continue;
      res.push(p);
    }
    return res;
  }

  function openingPoints(n) {
    // 3-3, 3-4, 4-4 style points + center, scaled to board.
    var lo = 2, hi = n - 3, mid = (n - 1) / 2 | 0;
    var set = {};
    [lo, mid, hi].forEach(function (r) {
      [lo, mid, hi].forEach(function (c) { set[r * n + c] = true; });
    });
    // also 3-4 points (komoku)
    [ [2,3],[3,2],[2,n-4],[3,n-3],[n-4,2],[n-3,3],[n-4,n-3],[n-3,n-4] ]
      .forEach(function (rc) {
        var r = rc[0], c = rc[1];
        if (r>=0&&c>=0&&r<n&&c<n) set[r*n+c] = true;
      });
    return Object.keys(set).map(Number);
  }

  /* Heuristic value of playing p. Higher = better. Combines:
   *  - capturing enemy groups (huge)
   *  - escaping atari / saving own groups in atari
   *  - putting enemy groups into atari
   *  - liberties of resulting own group (safety)
   *  - local contact / influence toward center & near enemies
   *  - small noise scaled by (1 - strength)
   */
  function scoreMove(game, p, color, enemy, s) {
    var t = game.trial(p, color);
    if (!t.legal) return -1e9;
    var b = t.board;
    var v = 0;

    // Captures are great.
    v += t.captured.length * 12;

    // Resulting safety of our group.
    var myLibs = libsAt(game, b, p);
    v += Math.min(myLibs, 6) * 0.8;
    if (myLibs === 1) v -= 4; // self-atari is bad

    // Does this move put an adjacent enemy group into atari / capture-threat?
    var nb = game.neighbors(p);
    var seenEnemy = {};
    for (var i = 0; i < nb.length; i++) {
      var q = nb[i];
      if (b[q] === enemy && !seenEnemy[q]) {
        var g = game.group(q, b);
        for (var z = 0; z < g.stones.length; z++) seenEnemy[g.stones[z]] = true;
        if (g.libCount === 1) v += 6;       // atari on enemy
        else if (g.libCount === 2) v += 1.5; // pressure
      }
    }

    // Save our own groups that are currently in atari by playing here.
    // (Check pre-move neighbors of p that are ours and in atari.)
    var preNb = game.neighbors(p);
    for (var j = 0; j < preNb.length; j++) {
      var m = preNb[j];
      if (game.board[m] === color) {
        var pg = game.group(m, game.board);
        if (pg.libCount === 1) {
          // playing p; did it help? recompute after.
          var ag = game.group(m, b);
          if (ag.libCount > 1 || b[m] === color && t.captured.length) v += 7;
        }
      }
    }

    // Strength-scaled capture reading: weaker bots overlook ataris.
    // (Handled implicitly via noise below; strong bots get full weight above.)

    // Positional shaping: prefer 3rd/4th line & near existing stones early.
    v += positional(game, p) * (0.6 + s * 0.8);

    // Contact / proximity to enemy stones (fighting spirit), light.
    v += proximityToEnemy(game, p, enemy) * 0.3;

    // Avoid first/second line in the opening (bad shape) for stronger bots.
    if (game.moveNumber < game.size && onLowLine(game, p)) v -= (1.5 + s * 2);

    // Noise: weaker => more noise.
    var noise = (Math.random() - 0.5) * 8 * (1 - s);
    v += noise;

    return v;
  }

  function libsAt(game, board, p) {
    return game.group(p, board).libCount;
  }

  function positional(game, p) {
    var n = game.size, r = (p / n) | 0, c = p % n;
    var dEdge = Math.min(r, c, n - 1 - r, n - 1 - c);
    // 3rd line (index 2) best, 4th good, edge bad, center neutral on big boards.
    var lineScore;
    if (dEdge === 0) lineScore = -2;
    else if (dEdge === 1) lineScore = -0.5;
    else if (dEdge === 2) lineScore = 2.2;
    else if (dEdge === 3) lineScore = 1.6;
    else lineScore = 0.4;
    return lineScore;
  }

  function onLowLine(game, p) {
    var n = game.size, r = (p / n) | 0, c = p % n;
    var dEdge = Math.min(r, c, n - 1 - r, n - 1 - c);
    return dEdge <= 1;
  }

  function proximityToEnemy(game, p, enemy) {
    var nb = game.neighbors(p), cnt = 0;
    for (var i = 0; i < nb.length; i++) if (game.board[nb[i]] === enemy) cnt++;
    return cnt;
  }

  function weightedPick(pool, beta) {
    if (pool.length === 1) return pool[0];
    var max = pool[0].v, sum = 0, ws = [];
    for (var i = 0; i < pool.length; i++) {
      var w = Math.exp((pool[i].v - max) * beta * 0.15);
      ws.push(w); sum += w;
    }
    var r = Math.random() * sum, acc = 0;
    for (var j = 0; j < pool.length; j++) {
      acc += ws[j];
      if (r <= acc) return pool[j];
    }
    return pool[pool.length - 1];
  }

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  GT.bot = { Bot: Bot };
})(window.GT = window.GT || {});
