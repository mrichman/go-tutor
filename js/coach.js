/* Claude coach client.
 *
 * The board moves are made by the built-in engine (bot.js). Claude's job is to
 * COACH: explain what just happened, suggest what to think about, and review
 * the finished game in plain language.
 *
 * Because browsers can't safely hold an Anthropic API key, this client talks to
 * a tiny local proxy (server/coach-server.js) at http://localhost:8787/coach.
 * If that proxy isn't running, we transparently fall back to built-in
 * heuristic tips so the app is fully usable offline with zero setup.
 */
(function (GT) {
  "use strict";

  var PROXY_URL = "http://localhost:8787/coach";
  var available = null; // null=unknown, true/false after first probe

  function coordName(size, p) {
    if (p === GT.engine.PASS || p == null || p < 0) return "pass";
    var letters = "ABCDEFGHJKLMNOPQRST"; // skip 'I' (Go convention)
    var r = Math.floor(p / size), c = p % size;
    return letters[c] + (size - r);
  }

  /* Compact, text description of the position for the model. */
  function describe(game, ctx) {
    var size = game.size;
    var lines = [];
    lines.push("Board: " + size + "x" + size + ", komi " + game.komi + ".");
    lines.push("Move #" + game.moveNumber + ", " + (game.toMove === GT.engine.BLACK ? "Black" : "White") + " to play.");
    lines.push("Captures so far — Black: " + game.captures[1] + ", White: " + game.captures[2] + ".");
    if (game.lastMove != null && game.lastMove >= 0) {
      lines.push("Last move: " + coordName(size, game.lastMove) + ".");
    }
    var sc = game.scoreArea();
    lines.push("Rough area estimate — Black " + sc.scoreBlack + ", White " + sc.scoreWhite + " (current stones+territory, assumes all alive).");
    if (ctx && ctx.playerColor) {
      lines.push("The human is playing " + (ctx.playerColor === GT.engine.BLACK ? "Black" : "White") + ".");
    }
    if (ctx && ctx.playerRank) lines.push("Human's estimated rank: " + ctx.playerRank + ".");
    if (ctx && ctx.extra) lines.push(ctx.extra);
    // ASCII board for spatial context (small boards only, to keep tokens low).
    if (size <= 13) lines.push("\n" + asciiBoard(game));
    return lines.join("\n");
  }

  function asciiBoard(game) {
    var size = game.size, rows = [];
    for (var r = 0; r < size; r++) {
      var row = "";
      for (var c = 0; c < size; c++) {
        var v = game.board[r * size + c];
        row += v === GT.engine.BLACK ? "X " : v === GT.engine.WHITE ? "O " : ". ";
      }
      rows.push(row.trimEnd());
    }
    return rows.join("\n");
  }

  function probe() {
    return fetch(PROXY_URL.replace("/coach", "/health"), { method: "GET" })
      .then(function (r) { available = r.ok; return available; })
      .catch(function () { available = false; return false; });
  }

  /* Public: get coaching text. kind = "move" | "review" | "hint".
   * Returns a Promise<string>. Always resolves (never rejects). */
  function coach(kind, game, ctx) {
    ctx = ctx || {};
    var payload = {
      kind: kind,
      prompt: buildPrompt(kind, game, ctx),
      context: describe(game, ctx)
    };
    var doFallback = function () { return Promise.resolve(localTip(kind, game, ctx)); };

    if (available === false) return doFallback();

    return fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) throw new Error("bad status " + r.status);
      available = true;
      return r.json();
    }).then(function (j) {
      return (j && j.text) ? j.text : localTip(kind, game, ctx);
    }).catch(function () {
      available = false;
      return localTip(kind, game, ctx);
    });
  }

  function buildPrompt(kind, game, ctx) {
    if (kind === "review") {
      return "You are a friendly Go (Baduk) teacher reviewing a finished game for a beginner-to-intermediate student. " +
        "In 4-6 short sentences, summarize how the game went, name ONE clear strength and ONE concrete thing to work on next, " +
        "and end with a single actionable tip. Avoid jargon unless you briefly define it. Be encouraging but honest.";
    }
    if (kind === "hint") {
      return "You are a Go coach. The student is about to move and asked for a hint. " +
        "Without naming exact coordinates, describe in 2-3 sentences what they should be looking for in THIS position " +
        "(e.g. a group in danger, a big open area, a capture, the need to make eyes). Keep it conceptual so they still decide the move.";
    }
    // move
    return "You are a Go coach giving quick live commentary. In 2-3 short sentences, explain what just happened " +
      "and what the student should be thinking about now. Plain language, encouraging, beginner-friendly.";
  }

  /* ---------- Offline fallback tips (no network) ---------- */
  function localTip(kind, game, ctx) {
    var E = GT.engine;
    if (kind === "review") {
      var sc = game.result && game.result.score;
      var won = game.result && ctx.playerColor && game.result.winner === ctx.playerColor;
      var head = won ? "Nice win! " : "Good game. ";
      var detail = sc ? ("Final area — Black " + sc.scoreBlack + ", White " + sc.scoreWhite + ". ")
                      : (game.result && game.result.byResign ? "The game ended by resignation. " : "");
      return head + detail +
        "Two things that pay off fastest at your level: (1) keep your weak groups connected and out of atari, and " +
        "(2) when a group is surrounded, ask 'can it make two eyes?' — if not, it will die. " +
        "Next game, try to notice every time a group drops to one or two liberties.";
    }
    if (kind === "hint") {
      // Look for any of the player's groups in atari, or an enemy group in atari.
      var atari = findAtari(game, ctx.playerColor);
      if (atari.mineInAtari) return "One of your groups is in atari (a single liberty left). Saving it — by extending or capturing the attacker — is usually urgent.";
      if (atari.enemyInAtari) return "An opponent group is in atari. Capturing it, or at least keeping it pinned, could be a big move.";
      if (game.moveNumber < 8) return "It's the opening. Favour the corners and the 3rd/4th lines — they make territory efficiently. Spread out rather than crowding one area.";
      return "Look for the biggest open area and for any group (yours or theirs) that is short on liberties. Strengthen weak groups before grabbing territory.";
    }
    // move commentary
    var last = game.lastMove;
    if (last === E.PASS) return "The opponent passed. If you also pass, the game ends and we count territory. Only pass when you can't gain by playing.";
    var libInfo = lastMoveContext(game);
    return libInfo;
  }

  function findAtari(game, color) {
    var E = GT.engine, res = { mineInAtari: false, enemyInAtari: false };
    var seen = {};
    for (var p = 0; p < game.board.length; p++) {
      if (game.board[p] === E.EMPTY || seen[p]) continue;
      var g = game.group(p);
      for (var i = 0; i < g.stones.length; i++) seen[g.stones[i]] = true;
      if (g.libCount === 1) {
        if (game.board[p] === color) res.mineInAtari = true;
        else res.enemyInAtari = true;
      }
    }
    return res;
  }

  function lastMoveContext(game) {
    var E = GT.engine, p = game.lastMove;
    if (p == null || p < 0) return "Think about where you can make the most secure territory or attack a weak group.";
    var g = game.group(p);
    var who = game.board[p] === E.BLACK ? "Black" : "White";
    if (g.libCount === 1) return who + " just played a stone now in atari (one liberty). There may be a capture available — look closely.";
    if (g.libCount === 2) return who + "'s last move left that group with only two liberties; it's a target. Consider attacking or defending around it.";
    return who + " reinforced/expanded there. Respond by taking a big point elsewhere or strengthening your own weakest group.";
  }

  GT.coach = {
    coach: coach,
    probe: probe,
    coordName: coordName,
    isAvailable: function () { return available; }
  };
})(window.GT = window.GT || {});
