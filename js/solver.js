/* Capture solver — depth-limited negamax that proves whether the ATTACKER can
 * force the capture of a target group (ladders, nets, capture races).
 *
 * "win" (from the attacker's standpoint) = the target group is captured with
 * best defence. A target is considered ESCAPED (attacker loss) once it reaches
 * 3+ liberties — a group with three liberties can't be laddered/netted.
 *
 * Candidate moves are tightly restricted (the target's liberties, plus the
 * liberties of adjacent attacker groups that are themselves in atari, so the
 * defender can try ladder-breaking counter-captures). That keeps the branching
 * tiny, so the search is fast and reliable on small boards.
 *
 * Used by:
 *   - generator.js to verify ladders/nets are truly forced captures.
 *   - app.js to drive multi-move tsumego (accept any move that preserves the
 *     forced win; auto-play the defender's resistance).
 */
(function (GT) {
  "use strict";
  var E = GT.engine;

  // Gather defender candidate moves: own group liberties + counter-capture points.
  function defenderMoves(game, grp, attacker) {
    var moves = {}, libs = grp.libs;
    for (var k in libs) moves[k] = true;
    // counter-captures: an attacker group adjacent to the target that is in atari
    var seen = {};
    grp.stones.forEach(function (s) {
      game.neighbors(s).forEach(function (q) {
        if (game.board[q] === attacker && !seen[q]) {
          var ag = game.group(q);
          ag.stones.forEach(function (x) { seen[x] = true; });
          if (ag.libCount === 1) {
            for (var lp in ag.libs) moves[lp] = true; // capturing point
          }
        }
      });
    });
    return Object.keys(moves).map(Number);
  }

  /* Returns { win:bool, move:int(best attacker move when it's attacker's turn) }.
   * origin = a point currently occupied by the target (defender) stone.
   * attacker = color trying to capture. */
  function solve(game, origin, attacker, depth) {
    var defender = E.opp(attacker);
    // captured?
    if (game.board[origin] !== defender) return { win: true };
    var grp = game.group(origin);
    if (grp.libCount >= 3) return { win: false };   // escaped
    if (depth <= 0) return { win: false };           // unresolved -> not forced

    var libs = Object.keys(grp.libs).map(Number);
    if (game.toMove === attacker) {
      // Attacker: play a liberty to keep pressing / capture.
      for (var i = 0; i < libs.length; i++) {
        var ng = game.clone();
        var r = ng.play(libs[i], attacker);
        if (!r.ok) continue;
        var sub = solve(ng, origin, attacker, depth - 1);
        if (sub.win) return { win: true, move: libs[i] };
      }
      return { win: false };
    } else {
      // Defender: try every escape; if ANY avoids capture, the attack fails.
      var cand = defenderMoves(game, grp, attacker);
      if (cand.length === 0) return { win: true };
      var bestResist = -1, bestDepthSeen = -1;
      for (var j = 0; j < cand.length; j++) {
        var dg = game.clone();
        var dr = dg.play(cand[j], defender);
        if (!dr.ok) continue;
        var s2 = solve(dg, origin, attacker, depth - 1);
        if (!s2.win) return { win: false };          // defender escapes
        bestResist = cand[j];
      }
      return { win: true, move: bestResist };          // all defences lose
    }
  }

  /* Pick the defender's most natural resisting move (a liberty extension) for
   * auto-play in the UI. All defences lose in a forced capture; we just want a
   * believable continuation. */
  function defenderReply(game, origin, attacker) {
    var defender = E.opp(attacker);
    if (game.board[origin] !== defender) return E.PASS;
    var grp = game.group(origin);
    var cand = defenderMoves(game, grp, attacker);
    // prefer a liberty that keeps the group at <=2 liberties (the run), else any legal
    var fallback = E.PASS;
    for (var i = 0; i < cand.length; i++) {
      var ng = game.clone();
      if (!ng.play(cand[i], defender).ok) continue;
      if (fallback === E.PASS) fallback = cand[i];
      var lib = ng.board[origin] === defender ? ng.group(origin).libCount : 99;
      if (lib <= 2) return cand[i];
    }
    return fallback;
  }

  GT.solver = { solve: solve, defenderReply: defenderReply, defenderMoves: defenderMoves };
})(window.GT = window.GT || {});
