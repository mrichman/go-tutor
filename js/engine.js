/* Go (Baduk) rules engine.
 * Pure logic, no DOM. Exposed on the global GT namespace so the app works
 * directly from file:// with classic <script> tags (no build, no modules).
 *
 * Board cells: 0 = empty, 1 = black, 2 = white.
 * Points are integers 0..n*n-1 (row-major). null/-1 = pass.
 */
(function (GT) {
  "use strict";

  var EMPTY = 0, BLACK = 1, WHITE = 2;
  var PASS = -1;

  function opp(color) { return color === BLACK ? WHITE : BLACK; }

  function GoGame(size, komi) {
    this.size = size || 19;
    this.komi = (komi == null) ? defaultKomi(this.size) : komi;
    this.reset();
  }

  function defaultKomi(size) {
    if (size >= 19) return 7.5;
    if (size >= 13) return 6.5;
    return 5.5;
  }

  GoGame.prototype.reset = function () {
    var n = this.size;
    this.board = new Int8Array(n * n);
    this.toMove = BLACK;
    this.koPoint = -1;            // simple ko: forbidden single recapture point
    this.captures = { 1: 0, 2: 0 }; // stones captured BY black / white
    this.history = [];            // list of {move, color, board(hash), koPoint, captures}
    this.prevPositions = {};      // positional superko guard (board hash -> true)
    this.passes = 0;
    this.moveNumber = 0;
    this.lastMove = -1;
    this.ended = false;
    this.result = null;           // {winner, score, byResign}
    this.scoringPhase = false;    // true after two passes, before dead stones agreed
    this._rememberPosition();
  };

  GoGame.prototype.idx = function (r, c) { return r * this.size + c; };
  GoGame.prototype.rc = function (p) { return [Math.floor(p / this.size), p % this.size]; };
  GoGame.prototype.inBounds = function (r, c) {
    return r >= 0 && c >= 0 && r < this.size && c < this.size;
  };

  GoGame.prototype.neighbors = function (p) {
    var n = this.size, r = Math.floor(p / n), c = p % n, res = [];
    if (r > 0) res.push(p - n);
    if (r < n - 1) res.push(p + n);
    if (c > 0) res.push(p - 1);
    if (c < n - 1) res.push(p + 1);
    return res;
  };

  /* Flood fill the connected group of same-color stones at p.
   * Returns {stones:[...], liberties:Set-like object, libCount:int}. */
  GoGame.prototype.group = function (p, board) {
    board = board || this.board;
    var color = board[p];
    if (color === EMPTY) return { stones: [], libs: {}, libCount: 0 };
    var stack = [p], seen = {}, stones = [], libs = {}, libCount = 0;
    seen[p] = true;
    while (stack.length) {
      var cur = stack.pop();
      stones.push(cur);
      var nb = this.neighbors(cur);
      for (var i = 0; i < nb.length; i++) {
        var q = nb[i];
        if (board[q] === EMPTY) {
          if (!libs[q]) { libs[q] = true; libCount++; }
        } else if (board[q] === color && !seen[q]) {
          seen[q] = true; stack.push(q);
        }
      }
    }
    return { stones: stones, libs: libs, libCount: libCount };
  };

  GoGame.prototype.libertyCount = function (p, board) {
    return this.group(p, board).libCount;
  };

  /* Simulate placing `color` at p on a copy; returns
   * {legal, reason, board, captured:[points], ko:point}. Does NOT mutate. */
  GoGame.prototype.trial = function (p, color) {
    if (p === PASS) return { legal: true, board: this.board, captured: [], ko: -1, pass: true };
    if (this.board[p] !== EMPTY) return { legal: false, reason: "occupied" };
    if (this.koPoint === p) return { legal: false, reason: "ko" };

    var b = Int8Array.from(this.board);
    b[p] = color;
    var enemy = opp(color);
    var captured = [];
    var nb = this.neighbors(p);
    for (var i = 0; i < nb.length; i++) {
      var q = nb[i];
      if (b[q] === enemy) {
        var g = this.group(q, b);
        if (g.libCount === 0) {
          for (var s = 0; s < g.stones.length; s++) {
            b[g.stones[s]] = EMPTY;
            captured.push(g.stones[s]);
          }
        }
      }
    }
    // Suicide check: the played group must have liberties (after captures).
    if (captured.length === 0) {
      var mine = this.group(p, b);
      if (mine.libCount === 0) return { legal: false, reason: "suicide" };
    }
    // Positional superko: disallow recreating any prior whole-board position.
    var h = hashBoard(b);
    if (this.prevPositions[h]) return { legal: false, reason: "superko" };

    // Determine ko point (single-stone recapture).
    var ko = -1;
    if (captured.length === 1) {
      var mineG = this.group(p, b);
      if (mineG.stones.length === 1 && mineG.libCount === 1) ko = captured[0];
    }
    return { legal: true, board: b, captured: captured, ko: ko, hash: h };
  };

  GoGame.prototype.isLegal = function (p, color) {
    return this.trial(p, color == null ? this.toMove : color).legal;
  };

  /* Play a move for the side to move (or pass with PASS). Mutates state. */
  GoGame.prototype.play = function (p, color) {
    if (this.ended) return { ok: false, reason: "ended" };
    color = color == null ? this.toMove : color;
    if (color !== this.toMove) return { ok: false, reason: "not-your-turn" };

    if (p === PASS) {
      this.history.push({ move: PASS, color: color, ko: this.koPoint });
      this.passes++;
      this.koPoint = -1;
      this.lastMove = PASS;
      this.moveNumber++;
      this.toMove = opp(color);
      if (this.passes >= 2) this.scoringPhase = true;
      return { ok: true, pass: true, scoring: this.passes >= 2 };
    }

    var t = this.trial(p, color);
    if (!t.legal) return { ok: false, reason: t.reason };

    this.board = t.board;
    this.captures[color] += t.captured.length;
    this.history.push({ move: p, color: color, captured: t.captured, ko: this.koPoint });
    this.koPoint = t.ko;
    this.passes = 0;
    this.lastMove = p;
    this.moveNumber++;
    this.toMove = opp(color);
    this._rememberPosition();
    return { ok: true, captured: t.captured };
  };

  GoGame.prototype.resign = function (color) {
    color = color == null ? this.toMove : color;
    this.ended = true;
    this.result = { winner: opp(color), byResign: true, score: null };
    return this.result;
  };

  GoGame.prototype._rememberPosition = function () {
    this.prevPositions[hashBoard(this.board)] = true;
  };

  /* All legal non-pass moves for a color. */
  GoGame.prototype.legalMoves = function (color) {
    color = color == null ? this.toMove : color;
    var res = [];
    for (var p = 0; p < this.board.length; p++) {
      if (this.board[p] === EMPTY && this.trial(p, color).legal) res.push(p);
    }
    return res;
  };

  /* A move "fills your own eye" heuristic: empty point surrounded by your
   * stones and not adjacent to an enemy. Used so the bot won't fill eyes and
   * so we can detect end-of-game. */
  GoGame.prototype.isEyeLike = function (p, color) {
    if (this.board[p] !== EMPTY) return false;
    var nb = this.neighbors(p), n = this.size, r = Math.floor(p / n), c = p % n;
    for (var i = 0; i < nb.length; i++) {
      if (this.board[nb[i]] !== color) return false; // orthogonal must be ours
    }
    // Diagonals: most must be ours (corner/edge relaxed).
    var diags = [];
    if (r > 0 && c > 0) diags.push(p - n - 1);
    if (r > 0 && c < n - 1) diags.push(p - n + 1);
    if (r < n - 1 && c > 0) diags.push(p + n - 1);
    if (r < n - 1 && c < n - 1) diags.push(p + n + 1);
    var enemyDiag = 0, edge = diags.length < 4;
    for (var d = 0; d < diags.length; d++) {
      if (this.board[diags[d]] === opp(color)) enemyDiag++;
    }
    return edge ? enemyDiag === 0 : enemyDiag <= 1;
  };

  /* Chinese (area) scoring of the CURRENT position, assuming all stones on the
   * board are alive. Returns {black, white, scoreBlack, scoreWhite, winner,
   * margin}. Territory = empty regions bordered by only one color. */
  GoGame.prototype.scoreArea = function (deadSet) {
    var n = this.size, src = this.board, b = src;
    if (deadSet) {
      // Work on a copy with dead stones lifted off the board.
      b = Int8Array.from(src);
      for (var d = 0; d < b.length; d++) {
        if (isDead(deadSet, d)) b[d] = EMPTY;
      }
    }
    var blackArea = 0, whiteArea = 0;
    var seen = new Int8Array(b.length);
    for (var p = 0; p < b.length; p++) {
      if (b[p] === BLACK) blackArea++;
      else if (b[p] === WHITE) whiteArea++;
    }
    // territory
    for (var q = 0; q < b.length; q++) {
      if (b[q] !== EMPTY || seen[q]) continue;
      var stack = [q], region = [], border = {}, sawBlack = false, sawWhite = false;
      seen[q] = 1;
      while (stack.length) {
        var cur = stack.pop();
        region.push(cur);
        var nb = this.neighbors(cur);
        for (var i = 0; i < nb.length; i++) {
          var x = nb[i];
          if (b[x] === EMPTY) { if (!seen[x]) { seen[x] = 1; stack.push(x); } }
          else if (b[x] === BLACK) sawBlack = true;
          else if (b[x] === WHITE) sawWhite = true;
        }
      }
      if (sawBlack && !sawWhite) blackArea += region.length;
      else if (sawWhite && !sawBlack) whiteArea += region.length;
      // dame (bordered by both or neither) -> nobody
    }
    var sb = blackArea;
    var sw = whiteArea + this.komi;
    return {
      blackArea: blackArea, whiteArea: whiteArea,
      scoreBlack: sb, scoreWhite: sw,
      winner: sb > sw ? BLACK : WHITE,
      margin: Math.abs(sb - sw)
    };
  };

  /* Per-point territory owner for the current board minus dead stones.
   * Returns {p: color} for points that are territory (not dame, not stones). */
  GoGame.prototype.territoryMap = function (deadSet) {
    var n = this.size, b = Int8Array.from(this.board);
    if (deadSet) for (var d = 0; d < b.length; d++) if (isDead(deadSet, d)) b[d] = EMPTY;
    var seen = new Int8Array(b.length), owner = {};
    for (var q = 0; q < b.length; q++) {
      if (b[q] !== EMPTY || seen[q]) continue;
      var stack = [q], region = [], sawBlack = false, sawWhite = false;
      seen[q] = 1;
      while (stack.length) {
        var cur = stack.pop(); region.push(cur);
        var nb = this.neighbors(cur);
        for (var i = 0; i < nb.length; i++) {
          var x = nb[i];
          if (b[x] === EMPTY) { if (!seen[x]) { seen[x] = 1; stack.push(x); } }
          else if (b[x] === BLACK) sawBlack = true;
          else if (b[x] === WHITE) sawWhite = true;
        }
      }
      var who = (sawBlack && !sawWhite) ? BLACK : (sawWhite && !sawBlack) ? WHITE : 0;
      if (who) for (var r = 0; r < region.length; r++) owner[region[r]] = who;
    }
    return owner;
  };

  /* Heuristic auto-guess of dead stones for the scoring UI: a group is likely
   * dead if removing it turns its points into the opponent's territory (i.e. it
   * sits inside enemy area) and it is small enough that it almost certainly
   * can't make two eyes. Conservative on purpose — the user confirms/adjusts.
   * Returns an object {point:true}. */
  GoGame.prototype.autoDeadStones = function () {
    var dead = {}, seen = {};
    for (var p = 0; p < this.board.length; p++) {
      if (this.board[p] === EMPTY || seen[p]) continue;
      var g = this.group(p);
      for (var i = 0; i < g.stones.length; i++) seen[g.stones[i]] = true;
      var color = this.board[p], enemy = opp(color);
      // Only consider small groups: large groups very likely have two eyes.
      if (g.stones.length > 6) continue;
      // Tentatively lift this group and see what its points become.
      var test = {};
      for (var s = 0; s < g.stones.length; s++) test[g.stones[s]] = true;
      var terr = this.territoryMap(test);
      var allEnemy = g.stones.every(function (st) { return terr[st] === enemy; });
      if (allEnemy) {
        for (var z = 0; z < g.stones.length; z++) dead[g.stones[z]] = true;
      }
    }
    return dead;
  };

  /* Finalize the game using an agreed set of dead stones. */
  GoGame.prototype.finalizeScore = function (deadSet) {
    var s = this.scoreArea(deadSet);
    this.scoringPhase = false;
    this.ended = true;
    this.result = { winner: s.winner, score: s, byResign: false, dead: deadSet || {} };
    return this.result;
  };

  /* Back out of scoring to keep playing (players disagree on life/death). */
  GoGame.prototype.resumeFromScoring = function () {
    this.scoringPhase = false;
    this.passes = 0;
    return true;
  };

  function isDead(deadSet, p) {
    return deadSet instanceof Set ? deadSet.has(p) : !!deadSet[p];
  }

  GoGame.prototype._scoreAndEnd = function () {
    var s = this.scoreArea();
    this.ended = true;
    this.result = { winner: s.winner, score: s, byResign: false };
  };

  GoGame.prototype.clone = function () {
    var g = new GoGame(this.size, this.komi);
    g.board = Int8Array.from(this.board);
    g.toMove = this.toMove;
    g.koPoint = this.koPoint;
    g.captures = { 1: this.captures[1], 2: this.captures[2] };
    g.passes = this.passes;
    g.moveNumber = this.moveNumber;
    g.lastMove = this.lastMove;
    g.ended = this.ended;
    g.result = this.result;
    g.scoringPhase = this.scoringPhase;
    // prevPositions copy (shallow is fine; keys are strings)
    g.prevPositions = {};
    for (var k in this.prevPositions) g.prevPositions[k] = true;
    return g;
  };

  /* Cheap board hash (string). Sufficient for ko/superko within a session. */
  function hashBoard(b) {
    // Pack into base-3-ish string; fast and unique enough.
    var s = "";
    for (var i = 0; i < b.length; i++) s += b[i];
    return s;
  }

  GT.engine = {
    GoGame: GoGame,
    EMPTY: EMPTY, BLACK: BLACK, WHITE: WHITE, PASS: PASS,
    opp: opp, defaultKomi: defaultKomi
  };
})(window.GT = window.GT || {});
