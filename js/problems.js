/* Tsumego (life-and-death) problems.
 *
 * Each problem sets up a small board and asks the player to find the key move.
 * Validation is by curated solution point(s); for capture problems we also
 * verify a stone is actually taken. Coordinates are [row, col].
 *
 *   { id, title, size, color (to play), setup:[[color,r,c]...],
 *     solution:[[r,c]...], mustCapture?:bool, hint, explain }
 */
(function (GT) {
  "use strict";
  var E = GT.engine;
  var B = E.BLACK, W = E.WHITE;

  function list() {
    return [
      {
        id: "p_atari1", title: "1. Capture the stone", size: 5, color: B,
        setup: [[W,2,2],[B,1,2],[B,3,2],[B,2,1]],
        solution: [[2,3]], mustCapture: true,
        hint: "The white stone has a single liberty left. Take it.",
        explain: "Filling the last liberty removes the stone from the board — your first capture."
      },
      {
        id: "p_capture2", title: "2. Capture two stones", size: 5, color: B,
        setup: [[W,2,2],[W,2,3],[B,1,2],[B,1,3],[B,3,2],[B,3,3],[B,2,1]],
        solution: [[2,4]], mustCapture: true,
        hint: "Both white stones share one last liberty on the right edge.",
        explain: "Connected stones share liberties — fill the last shared one and the whole group falls."
      },
      {
        id: "p_capture3", title: "3. Capture the group", size: 5, color: B,
        setup: [[W,2,2],[W,2,3],[W,3,3],
                [B,1,2],[B,3,2],[B,2,1],[B,1,3],[B,2,4],[B,4,3]],
        solution: [[3,4]], mustCapture: true,
        hint: "The three white stones have exactly one liberty remaining.",
        explain: "Even an L-shaped group dies the moment its final liberty is filled."
      },
      {
        id: "p_live", title: "4. Make two eyes (live)", size: 5, color: B,
        setup: [[B,1,1],[B,1,2],[B,1,3],[B,3,1],[B,3,2],[B,3,3],[B,2,0],[B,2,4]],
        solution: [[2,2]],
        hint: "You surround a row of three empty points. Where do you play to split it into two eyes?",
        explain: "Playing the middle leaves two separate one-point eyes at the sides. Two eyes = unconditional life."
      },
      {
        id: "p_kill", title: "5. Kill the group (vital point)", size: 5, color: B,
        setup: [[W,1,1],[W,1,2],[W,1,3],[W,3,1],[W,3,2],[W,3,3],[W,2,0],[W,2,4]],
        solution: [[2,2]],
        hint: "White has a three-point eye space. Take the key point so it can't make two eyes.",
        explain: "The center is the vital point of a straight-three. Occupying it leaves White only one eye — dead."
      },
      {
        id: "p_escape", title: "6. Save your stone", size: 5, color: B,
        setup: [[B,2,2],[W,1,2],[W,2,1],[W,2,3]],
        solution: [[3,2]],
        hint: "Your stone is in atari with one liberty. Don't lose it — grow.",
        explain: "Extending downward gives the group three fresh liberties, far harder for White to chase."
      }
    ];
  }

  // Build a fresh game positioned for a problem.
  function buildGame(prob) {
    var g = new E.GoGame(prob.size, 0);
    prob.setup.forEach(function (s) { g.board[s[1] * prob.size + s[2]] = s[0]; });
    g._rememberPosition();
    g.toMove = prob.color;
    return g;
  }

  // Acceptable solution points as board indices.
  function solutionPoints(prob) {
    return prob.solution.map(function (rc) { return rc[0] * prob.size + rc[1]; });
  }

  // Curated, hand-made fundamentals (always first).
  function curated() {
    var c = list();
    c.forEach(function (p) { p.category = "fundamentals"; p.difficulty = p.difficulty || 1; });
    return c;
  }

  // Full set = curated + a large engine-verified generated set.
  var ALL = null;
  function all() {
    if (ALL) return ALL;
    var gen = (GT.generator ? GT.generator.build({ seed: 0x60D11FE }) : []);
    ALL = curated().concat(gen);
    return ALL;
  }

  var CATEGORIES = [
    { id: "all", label: "All" },
    { id: "fundamentals", label: "Fundamentals" },
    { id: "capture", label: "Capture & atari" },
    { id: "ladder", label: "Ladders" },
    { id: "life", label: "Life & death" },
    { id: "connect", label: "Connect & cut" },
    { id: "endgame", label: "Endgame" }
  ];

  function filter(category, difficulty) {
    return all().filter(function (p) {
      if (category && category !== "all" && p.category !== category) return false;
      if (difficulty && +difficulty !== 0 && p.difficulty !== +difficulty) return false;
      return true;
    });
  }

  function byId(id) {
    var a = all();
    for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i];
    return null;
  }

  GT.problems = {
    list: list(),                 // legacy: the curated 6
    all: all, filter: filter, byId: byId, categories: CATEGORIES,
    buildGame: buildGame, solutionPoints: solutionPoints
  };
})(window.GT = window.GT || {});
