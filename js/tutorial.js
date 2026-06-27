/* Interactive tutorial lessons.
 *
 * Each lesson runs on a small board and is a sequence of steps. A step either
 * just shows text ("info") or asks the player to make a specific kind of move
 * ("task") that is validated against the engine. Setup places stones directly
 * on the board (no rules applied) so positions can be constructed freely.
 *
 * Coordinates in setups are [row, col] on the lesson's board size.
 *
 * Validators receive (game, point, ctx) BEFORE the move is played and return
 * { ok:bool, msg:string }. If ok, app plays the move (rules enforced) and
 * advances. `expect` is a convenience: list of acceptable points.
 */
(function (GT) {
  "use strict";

  var E = GT.engine;
  var B = E.BLACK, W = E.WHITE;

  function rc(size, r, c) { return r * size + c; }

  function lessonsList() {
    return [
      {
        id: "basics",
        title: "1. The board & placing stones",
        size: 9,
        intro: "Go is played by placing stones on the line intersections — not the squares. Black plays first, then players alternate. Stones don't move once placed; they can only be captured.",
        steps: [
          { type: "info", text: "This is a 9×9 board. Lines cross at intersections. Click an empty intersection to place a black stone." },
          { type: "task", color: B, text: "Place a black stone anywhere on the board.",
            validate: function () { return { ok: true, msg: "Nice — that stone now sits on the intersection." }; } },
          { type: "info", text: "The four points directly up/down/left/right of a stone are its 'liberties' — its breathing room. Capturing is all about removing liberties." }
        ]
      },
      {
        id: "liberties",
        title: "2. Liberties",
        size: 7,
        intro: "A stone or connected group of stones is captured when ALL of its liberties (adjacent empty points) are filled by the opponent.",
        setup: function (s) { return { stones: [ [B, 3, 3] ] }; },
        steps: [
          { type: "info", text: "The black stone in the center has 4 liberties (up, down, left, right). Diagonals do NOT count." },
          { type: "task", color: W, text: "Play a WHITE stone on one of the black stone's liberties (directly adjacent to it).",
            expectKind: "adjacentTo", target: [3, 3],
            validate: adjacentValidator([3, 3], "That removes one of Black's liberties. Three to go.") },
          { type: "info", text: "Surround all 4 and the black stone is captured. On the edge a stone has 3 liberties; in the corner only 2 — so edges and corners are easier to capture." }
        ]
      },
      {
        id: "capture",
        title: "3. Your first capture (atari)",
        size: 7,
        intro: "'Atari' means a stone/group has exactly ONE liberty left — one more move captures it.",
        setup: function () {
          // White stone at center with 3 black stones around it -> 1 liberty.
          return { stones: [ [W, 3, 3], [B, 2, 3], [B, 4, 3], [B, 3, 2] ] };
        },
        steps: [
          { type: "info", text: "The white stone has just ONE liberty left, at its right side. White is 'in atari'." },
          { type: "task", color: B, text: "Capture the white stone by filling its last liberty.",
            validate: function (game, p) {
              var t = game.trial(p, B);
              if (!t.legal) return { ok: false, msg: "That's not legal here. Find White's single empty liberty." };
              if (t.captured.length > 0) return { ok: true, msg: "Captured! The white stone is lifted off the board. That's the heart of Go." };
              return { ok: false, msg: "Close — you must play on White's last liberty (the empty point touching the white stone)." };
            } }
        ]
      },
      {
        id: "extend",
        title: "4. Escaping atari",
        size: 7,
        intro: "When YOUR stone is in atari, you can often save it by extending — adding a connected stone to gain new liberties.",
        setup: function () {
          return { stones: [ [B, 3, 3], [W, 3, 2], [W, 2, 3] ] };
        },
        steps: [
          { type: "info", text: "Your black stone has 2 liberties (right and down). It's not captured yet, but White is pressing. Extend DOWN or RIGHT to make a stronger, harder-to-capture group." },
          { type: "task", color: B, text: "Extend your black stone: play on an empty point directly next to it (down or right).",
            validate: function (game, p) {
              var ok = adjacentTo(game, p, [3, 3]) && game.board[p] === E.EMPTY;
              if (!ok) return { ok: false, msg: "Play directly next to your stone to connect and gain liberties." };
              var t = game.trial(p, B);
              if (!t.legal) return { ok: false, msg: "Not legal there — pick an empty adjacent point." };
              return { ok: true, msg: "Good. Connected stones share liberties, so the group is sturdier than a lone stone." };
            } }
        ]
      },
      {
        id: "ko",
        title: "5. The ko rule",
        size: 7,
        intro: "Ko prevents endless recapture. After a single-stone capture that would repeat the position, the opponent must play elsewhere before recapturing.",
        setup: function () {
          // Classic ko shape.
          return { stones: [
            [B, 3, 2], [B, 2, 3], [B, 4, 3],
            [W, 3, 4], [W, 2, 4], [W, 4, 4], [W, 3, 3]
          ] };
        },
        steps: [
          { type: "info", text: "The white stone in the middle (next to your black stones) can be captured. Capture it." },
          { type: "task", color: B, text: "Capture the single white stone touching your group.",
            validate: function (game, p) {
              var t = game.trial(p, B);
              if (t.legal && t.captured.length === 1) return { ok: true, msg: "Captured! Now it's a ko: White is NOT allowed to immediately recapture — that would repeat the board. White must play elsewhere first." };
              return { ok: false, msg: "Aim for the white stone's last liberty so exactly one stone is captured." };
            } },
          { type: "info", text: "Ko fights are a deep part of Go strategy. For now, just remember: no immediate recapture that repeats the position." }
        ]
      },
      {
        id: "eyes",
        title: "6. Eyes & life",
        size: 7,
        intro: "A group with TWO separate 'eyes' (enclosed empty points) can never be captured — the opponent can't fill both. Two eyes = unconditional life. This is the most important concept in Go.",
        setup: function () {
          // Black group with one eye; player adds shape toward two eyes (conceptual).
          return { stones: [
            [B,1,1],[B,1,2],[B,1,3],[B,2,1],[B,2,3],[B,3,1],[B,3,2],[B,3,3]
          ] };
        },
        steps: [
          { type: "info", text: "This black group surrounds a single empty point in the middle — that's one eye. One eye is not enough: White could eventually fill it. A living group needs TWO eyes." },
          { type: "info", text: "Remember the principle: make two eyes to live, or prevent the opponent from making two eyes to kill. We'll practice this in real games." }
        ]
      },
      {
        id: "territory",
        title: "7. Territory & winning",
        size: 9,
        intro: "The goal: control more of the board than your opponent. Your score = your stones + the empty points you surround. White also gets 'komi' (compensation points) for going second.",
        setup: function () {
          // A finished-ish split position.
          var stones = [];
          for (var c = 0; c < 9; c++) { stones.push([B, 3, c]); stones.push([W, 5, c]); }
          return { stones: stones };
        },
        steps: [
          { type: "info", text: "Black walls off the top, White the bottom. Everything above the black wall is Black's territory; below the white wall is White's. The middle row is contested ('dame')." },
          { type: "info", text: "At the end, both players pass. We count area for each side, add komi to White, and whoever has more wins. You don't have to count by hand — the app does it for you." }
        ]
      }
    ];
  }

  /* ---- validator helpers ---- */
  function adjacentTo(game, p, targetRC) {
    var t = rc(game.size, targetRC[0], targetRC[1]);
    var nb = game.neighbors(t);
    return nb.indexOf(p) !== -1;
  }
  function adjacentValidator(targetRC, successMsg) {
    return function (game, p) {
      if (!adjacentTo(game, p, targetRC)) {
        return { ok: false, msg: "Play directly next to the target stone (up/down/left/right), not diagonally." };
      }
      var color = game.toMove;
      if (!game.trial(p, color).legal) return { ok: false, msg: "Not legal there — pick an empty adjacent point." };
      return { ok: true, msg: successMsg };
    };
  }

  /* Build a fresh game positioned for a lesson. */
  function buildLessonGame(lesson) {
    var g = new E.GoGame(lesson.size, 0);
    if (lesson.setup) {
      var setup = lesson.setup(lesson.size);
      var stones = setup.stones || [];
      for (var i = 0; i < stones.length; i++) {
        var st = stones[i];
        g.board[rc(lesson.size, st[1], st[2])] = st[0];
      }
      g._rememberPosition();
    }
    g.toMove = E.BLACK;
    return g;
  }

  GT.tutorial = {
    lessons: lessonsList(),
    buildLessonGame: buildLessonGame
  };
})(window.GT = window.GT || {});
