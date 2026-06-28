/* Opening / fuseki principles trainer.
 *
 * Rather than ship a hand-authored joseki dictionary (easy to get subtly wrong),
 * these drills teach robust, engine-verifiable opening *principles*. Each drill
 * pre-places a few stones and accepts any move that satisfies a geometric rule,
 * so feedback is always correct. A full branching joseki library is future work.
 */
(function (GT) {
  var E = GT.engine, B = E.BLACK, W = E.WHITE, EMPTY = E.EMPTY;
  var N = 13;                                  // all drills use a 13x13 board
  function rc(r, c) { return r * N + c; }
  function lineOf(i) { return Math.min(i, N - 1 - i) + 1; }  // 1-indexed line from nearest edge
  function cheb(a, b) {                          // Chebyshev distance between two points
    return Math.max(Math.abs((a / N | 0) - (b / N | 0)), Math.abs((a % N) - (b % N)));
  }

  var drills = [
    {
      id: "corners-first",
      title: "Corners first",
      intro: "The opening follows a simple priority: corners, then sides, then the center. Corners are easiest to enclose for territory.",
      toMove: B, setup: [],
      prompt: "Play your first move in a corner (a 3-3, 3-4 or 4-4 point).",
      accept: function (p) {
        var r = p / N | 0, c = p % N;
        return (r === 2 || r === 3 || r === 9 || r === 10) &&
               (c === 2 || c === 3 || c === 9 || c === 10);
      },
      ok: "Good — a corner point. Corners need the fewest stones to turn into territory, so they go first.",
      bad: "Not a corner point. Aim for a 3-3, 3-4 or 4-4 intersection near a corner."
    },
    {
      id: "third-fourth-line",
      title: "The 3rd & 4th lines",
      intro: "Stones on the 3rd line make territory; the 4th line builds influence/thickness. The 1st–2nd lines are too low early, and the center is inefficient.",
      toMove: B, setup: [],
      prompt: "Play any move on a 3rd or 4th line (not the 1st/2nd line, not the center).",
      accept: function (p) {
        var r = p / N | 0, c = p % N, ln = Math.min(lineOf(r), lineOf(c));
        return ln === 3 || ln === 4;
      },
      ok: "Yes — that's a 3rd/4th-line point: the balance of territory and influence the opening is built on.",
      bad: "Too low (1st/2nd line) or too central. Step out to the 3rd or 4th line."
    },
    {
      id: "approach-distance",
      title: "Approach, don't touch",
      intro: "When approaching an opponent's lone stone, keep a small gap (a knight's or one-space approach). Touching it usually just helps them get stronger.",
      toMove: B, setup: [{ p: rc(3, 3), color: W }],
      prompt: "Approach the white 4-4 stone — play near it but not next to it (about two lines away, on a 3rd/4th line).",
      accept: function (p) {
        var ln = Math.min(lineOf(p / N | 0), lineOf(p % N));
        return cheb(p, rc(3, 3)) === 2 && (ln === 3 || ln === 4);
      },
      ok: "Nicely judged — that's a proper approach, close enough to pressure the stone but not so close it gets stronger by contact.",
      bad: "Either touching the stone, too far away, or too low. Aim about two lines off, on the 3rd/4th line."
    },
    {
      id: "block-3-3",
      title: "Block the 3-3 invasion",
      intro: "When the opponent invades the 3-3 under your 4-4 stone, block on one side to wall them into the corner and take outside thickness.",
      toMove: B, setup: [{ p: rc(3, 3), color: B }, { p: rc(2, 2), color: W }],
      prompt: "Black already owns the 4-4 point and White just invaded at 3-3. Block on one side (either is fine).",
      accept: function (p) { return p === rc(2, 3) || p === rc(3, 2); },
      ok: "Correct block. White lives small in the corner while you build a wall facing the open board — usually block toward your bigger side.",
      bad: "That doesn't block the invasion. Play next to your 4-4 stone, on the side toward the edge, to wall White in."
    },
    {
      id: "extension-base",
      title: "Extend to make a base",
      intro: "A lone stone on the side needs a friend: a two- or three-space extension on the 3rd line gives the group room to make eyes (a 'base').",
      toMove: B, setup: [{ p: rc(6, 10), color: B }],
      prompt: "Extend from the black stone along the right side (same column) to make a base — about 2 to 4 lines away.",
      accept: function (p) {
        var r = p / N | 0, c = p % N, d = Math.abs(r - 6);
        return c === 10 && d >= 2 && d <= 4;
      },
      ok: "Good extension — that span is hard to attack and gives your stones room to make two eyes along the side.",
      bad: "Too close (cramped) or too far (invadable). Extend along the same side, roughly 2–4 lines from your stone."
    }
  ];

  GT.opening = {
    N: N,
    drills: drills,
    // Build a fresh board with the drill's setup stones placed.
    buildGame: function (drill) {
      var g = new E.GoGame(N);
      (drill.setup || []).forEach(function (s) { g.board[s.p] = s.color; });
      g.toMove = drill.toMove;
      if (g._rememberPosition) g._rememberPosition();
      return g;
    },
    // All empty points that satisfy the drill — used to reveal the answer.
    solutionPoints: function (drill, game) {
      var out = [];
      for (var p = 0; p < N * N; p++) {
        if (game.board[p] === EMPTY && drill.accept(p, game)) out.push(p);
      }
      return out;
    }
  };
})(window.GT = window.GT || {});
