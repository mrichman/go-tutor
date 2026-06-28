/* App controller: wires UI, board, engine, bot, ranking, tutorial, coach. */
(function (GT) {
  "use strict";
  var E = GT.engine, R = GT.ranking;
  var BLACK = E.BLACK, WHITE = E.WHITE, PASS = E.PASS;

  var state = {
    profile: R.load(),
    game: null,
    view: null,         // BoardView for play
    bot: new GT.bot.Bot(0.4),
    playerColor: BLACK,
    botColor: WHITE,
    diff: "adaptive",
    botSkill: null,
    handicap: 0,
    busy: false,
    rated: true,
    zoom: 100,
    scoring: null,        // {dead:{p:true}, active:bool} during the scoring phase
    reviewIndex: null,    // null = live; else number of moves applied for review
    loaded: false,        // true when viewing an imported SGF (no bot, unrated)
    influence: { on: false, ownership: null, size: 0, heat: true },  // KataGo territory overlay (heat = graded)
    variation: null,      // {base:int, game:GoGame} when exploring a hypothetical line
    estimate: false,      // offline score-estimate overlay toggle
    lines: []             // saved variation lines: [{base, name, moves:[{move,color}]}]
  };

  var lesson = { view: null, game: null, current: null, stepIdx: 0 };
  var prob = { view: null, game: null, current: null, solved: false, filtered: null };
  var open = { view: null, game: null, current: null, done: false };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    bindTabs();
    bindPlayControls();
    bindProgressControls();
    bindProblemControls();
    bindOpeningControls();
    bindSettings();
    bindProfileControls();
    bindGlobalKeys();
    probeKatago();
    buildLessonList();
    updateRankUI();
    updateAdaptiveInfo();

    // size default from profile
    $("#sizeSel").value = String(state.profile.lastSize || 19);

    // probe coach proxy
    GT.coach.probe().then(updateCoachStatus);

    // start an initial game so the board isn't empty
    startGame();
  }

  /* ---------------- tabs ---------------- */
  function bindTabs() {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () {
        document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); });
        document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("active"); });
        t.classList.add("active");
        var v = t.getAttribute("data-view");
        $("#view-" + v).classList.add("active");
        if (v === "progress") renderProgress();
        if (v === "learn") enterLearn();
        if (v === "opening") enterOpening();
        if (v === "problems") enterProblems();
        if (v === "play" && state.view) state.view._build && state.view.render(state.game.board, state.game.lastMove);
      });
    });
  }

  /* ---------------- play ---------------- */
  function bindPlayControls() {
    $("#newGameBtn").addEventListener("click", startGame);
    $("#diffSel").addEventListener("change", function (e) {
      state.diff = e.target.value; updateAdaptiveInfo();
    });
    $("#sizeSel").addEventListener("change", updateAdaptiveInfo);
    $("#passBtn").addEventListener("click", function () { humanMove(PASS); });
    $("#resignBtn").addEventListener("click", humanResign);
    $("#undoBtn").addEventListener("click", undo);
    $("#hintBtn").addEventListener("click", askHint);
    $("#influenceBtn").addEventListener("click", toggleInfluence);
    $("#heatBtn").addEventListener("click", toggleHeat);
    $("#estimateBtn").addEventListener("click", toggleEstimate);
    $("#coachAskBtn").addEventListener("click", askCoachQuestion);
    $("#coachAsk").addEventListener("keydown", function (e) { if (e.key === "Enter") askCoachQuestion(); });
    $("#zoomIn").addEventListener("click", function () { setZoom(state.zoom + 20); });
    $("#zoomOut").addEventListener("click", function () { setZoom(state.zoom - 20); });
    $("#zoomFit").addEventListener("click", fitZoom);
    $("#zoomRange").addEventListener("input", function (e) { setZoom(parseInt(e.target.value, 10)); });
    $("#acceptScoreBtn").addEventListener("click", acceptScore);
    $("#resumeBtn").addEventListener("click", resumePlay);
    $("#histFirst").addEventListener("click", function () { gotoMove(0); });
    $("#histPrev").addEventListener("click", function () { stepReview(-1); });
    $("#histNext").addEventListener("click", function () { stepReview(1); });
    $("#histLive").addEventListener("click", gotoLive);
    $("#varUndoBtn").addEventListener("click", variationUndo);
    $("#saveLineBtn").addEventListener("click", saveCurrentLine);
    $("#varExitBtn").addEventListener("click", exitVariation);
    $("#saveSgfBtn").addEventListener("click", saveSGF);
    $("#loadSgfBtn").addEventListener("click", function () { $("#sgfFile").click(); });
    $("#sgfFile").addEventListener("change", onSgfFileChosen);
    $("#importSgfBtn").addEventListener("click", function () { $("#sgfCollection").click(); });
    $("#sgfCollection").addEventListener("change", onSgfCollectionChosen);
    $("#analyzeBtn").addEventListener("click", analyzeGame);
    $("#exportReviewBtn").addEventListener("click", exportReviewSGF);
  }

  /* ---------------- zoom ---------------- */
  var ZOOM_BASE = 640, ZOOM_MIN = 60, ZOOM_MAX = 280;

  function applyZoom(pct) {
    var host = $("#boardHost");
    if (!host) return;
    host.style.width = Math.round(ZOOM_BASE * pct / 100) + "px";
    host.style.maxWidth = "none";
    $("#zoomRange").value = pct;
    $("#zoomPct").textContent = pct + "%";
  }

  function setZoom(pct) {
    pct = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(pct / 10) * 10));
    state.zoom = pct;
    state.profile.boardZoom = pct;
    R.save(state.profile);
    applyZoom(pct);
  }

  // Size the board to fill the available width of its scroll container.
  function fitZoom() {
    var scroll = document.querySelector(".board-scroll");
    if (!scroll || !scroll.clientWidth) { setZoom(100); return; }
    setZoom(Math.round(scroll.clientWidth / ZOOM_BASE * 100));
  }

  /* ---------------- settings: sound, theme, speed ---------------- */
  var SPEED_MS = { instant: 0, fast: 120, normal: 260 };
  var audioCtx = null, noiseBuf = null, clickBuffer = null, clickDecoding = false, masterGain = null;

  function ensureAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended" && audioCtx.resume) audioCtx.resume();
      if (!masterGain) {
        masterGain = audioCtx.createGain();
        masterGain.gain.value = volume();
        masterGain.connect(audioCtx.destination);
      }
      decodeClickSample();
      return audioCtx;
    } catch (e) { return null; }
  }
  function volume() { var v = state.profile.soundVolume; return v == null ? 0.8 : v; }
  function audioOut() { return masterGain || audioCtx.destination; }

  // Simple synthesized tone, routed through the master volume.
  function tone(freq, durMs, type, gain) {
    if (!state.profile.soundOn) return;
    var ctx = ensureAudio(); if (!ctx) return;
    var t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || "sine"; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.2, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + durMs / 1000);
    o.connect(g); g.connect(audioOut());
    o.start(t); o.stop(t + durMs / 1000 + 0.02);
  }
  function soundPass() { tone(300, 160, "sine", 0.18); }
  function soundIllegal() { tone(150, 110, "square", 0.16); }
  function soundGameOver() { tone(440, 160, "sine", 0.2); setTimeout(function () { tone(294, 240, "sine", 0.2); }, 150); }

  // Decode the embedded base64 stone-click WAV (js/sound-data.js) once.
  function decodeClickSample() {
    if (clickBuffer || clickDecoding || !audioCtx) return;
    var data = window.GT && GT.soundData && GT.soundData.click;
    if (!data) return;
    clickDecoding = true;
    try {
      var b64 = data.slice(data.indexOf(",") + 1);
      var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
      for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      audioCtx.decodeAudioData(bytes.buffer, function (buf) { clickBuffer = buf; },
        function () { clickDecoding = false; });
    } catch (e) { clickDecoding = false; }
  }

  // Play the decoded sample with slight pitch/volume variation. Returns false
  // if the sample isn't ready (caller then falls back to synthesis).
  function playSample(rate, gain) {
    if (!state.profile.soundOn) return true;       // sound off: treat as handled
    var ctx = ensureAudio();
    if (!ctx || !clickBuffer) return false;
    var src = ctx.createBufferSource(); src.buffer = clickBuffer;
    src.playbackRate.value = rate * (1 + (Math.random() - 0.5) * 0.12);
    var g = ctx.createGain(); g.gain.value = gain * (0.9 + Math.random() * 0.2);
    src.connect(g); g.connect(audioOut());
    src.start();
    return true;
  }

  // Cached short white-noise buffer for the percussive part of the clack.
  function getNoise(ctx) {
    if (noiseBuf) return noiseBuf;
    var len = Math.floor(ctx.sampleRate * 0.2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  /* A natural stone "clack": a sharp filtered-noise transient (stone-on-stone)
   * layered with a quick low-frequency "wood" body. Small random variation per
   * hit so repeated moves don't sound robotic. */
  function clack(opts) {
    if (!state.profile.soundOn) return;
    var ctx = ensureAudio();
    if (!ctx) return;
    var t = ctx.currentTime;
    var vary = 1 + (Math.random() - 0.5) * 0.18;

    // 1) noise transient through a bandpass = the "click"
    var src = ctx.createBufferSource(); src.buffer = getNoise(ctx);
    var bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = opts.click * vary; bp.Q.value = 0.9;
    var ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(opts.clickGain, t + 0.002);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + opts.clickDecay);
    src.connect(bp); bp.connect(ng); ng.connect(audioOut());
    src.start(t); src.stop(t + opts.clickDecay + 0.02);

    // 2) low "wood" body = a quick damped sine
    var o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = opts.body * vary;
    var og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(opts.bodyGain, t + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0001, t + opts.bodyDecay);
    o.connect(og); og.connect(audioOut());
    o.start(t); o.stop(t + opts.bodyDecay + 0.02);
  }

  function soundPlace() {
    // prefer the embedded recorded-style sample; fall back to live synthesis
    if (!playSample(1.0, 0.9)) clack({ click: 2400, clickGain: 0.35, clickDecay: 0.045, body: 190, bodyGain: 0.16, bodyDecay: 0.07 });
  }
  function soundCapture() {
    // lower-pitched, weightier version of the same sample for captures
    if (!playSample(0.6, 1.0)) clack({ click: 1700, clickGain: 0.4, clickDecay: 0.06, body: 130, bodyGain: 0.2, bodyDecay: 0.11 });
  }

  function botDelay() { return SPEED_MS[state.profile.moveSpeed] != null ? SPEED_MS[state.profile.moveSpeed] : 260; }

  function applyTheme(name) {
    document.body.className = "theme-" + (name || "classic");
  }

  function bindSettings() {
    // Unlock/resume audio on the first user gesture (autoplay policy).
    var unlock = function () {
      ensureAudio();
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);

    $("#soundToggle").addEventListener("click", function () {
      state.profile.soundOn = !state.profile.soundOn;
      R.save(state.profile); updateSoundIcon();
      if (state.profile.soundOn) soundPlace();
    });
    $("#themeSelect").addEventListener("change", function (e) {
      state.profile.theme = e.target.value; R.save(state.profile); applyTheme(e.target.value);
    });
    $("#speedSel").addEventListener("change", function (e) {
      state.profile.moveSpeed = e.target.value; R.save(state.profile);
    });
    $("#volRange").addEventListener("input", function (e) {
      state.profile.soundVolume = (+e.target.value) / 100;
      if (masterGain) masterGain.gain.value = volume();
      R.save(state.profile);
    });
    $("#themeSelect").value = state.profile.theme || "classic";
    $("#speedSel").value = state.profile.moveSpeed || "normal";
    $("#volRange").value = Math.round(volume() * 100);
    applyTheme(state.profile.theme);
    updateSoundIcon();
  }
  function updateSoundIcon() {
    $("#soundToggle").textContent = state.profile.soundOn ? "\uD83D\uDD0A" : "\uD83D\uDD07";
  }

  /* ---------------- profiles ---------------- */
  function bindProfileControls() {
    populateProfileSelect();
    $("#profileSel").addEventListener("change", function (e) {
      var v = e.target.value;
      if (v === "__new__") { newProfilePrompt(); populateProfileSelect(); return; }
      applyProfile(R.switchProfile(v));
    });
    $("#profileNew").addEventListener("click", newProfilePrompt);
    $("#profileDel").addEventListener("click", function () {
      var names = R.listProfiles();
      if (names.length <= 1) { setStatus("Can't delete your only profile."); return; }
      if (!window.confirm("Delete profile \u201C" + R.activeName() + "\u201D and its progress?")) return;
      applyProfile(R.deleteProfile(R.activeName()));
      populateProfileSelect();
    });
  }

  function populateProfileSelect() {
    var sel = $("#profileSel");
    sel.innerHTML = "";
    R.listProfiles().forEach(function (n) {
      var o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o);
    });
    var nw = document.createElement("option"); nw.value = "__new__"; nw.textContent = "New profile…"; sel.appendChild(nw);
    sel.value = R.activeName();
  }

  function newProfilePrompt() {
    var name = window.prompt("New profile name:", "Player " + (R.listProfiles().length + 1));
    if (name == null || !name.trim()) { populateProfileSelect(); return; }
    applyProfile(R.createProfile(name.trim()));
    populateProfileSelect();
  }

  // Make `profile` the active one and re-sync everything that reads it.
  function applyProfile(profile) {
    state.profile = profile;
    $("#volRange").value = Math.round(volume() * 100);
    if (masterGain) masterGain.gain.value = volume();
    $("#themeSelect").value = profile.theme || "classic";
    $("#speedSel").value = profile.moveSpeed || "normal";
    applyTheme(profile.theme);
    updateSoundIcon();
    updateRankUI();
    if ($("#view-progress").classList.contains("active")) renderProgress();
    if ($("#view-opening").classList.contains("active")) buildOpeningList();
    if ($("#view-problems").classList.contains("active")) { rebuildProblemList(); updateDueButton(); }
    setStatus("Switched to profile \u201C" + R.activeName() + "\u201D.");
  }

  // Flash captured stones briefly, then restore.
  function flashCaptures(points) {
    if (!points || !points.length) return;
    state.view.render(state.game.board, state.game.lastMove, null, { flash: points });
    setTimeout(function () { if (state.reviewIndex == null) redraw(); }, 280);
  }

  /* ---------------- keyboard + wheel ---------------- */
  function bindGlobalKeys() {
    document.addEventListener("keydown", function (e) {
      var tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      var view = document.querySelector(".tab.active").getAttribute("data-view");
      if (view === "play") {
        if (e.key === "ArrowLeft") { stepReview(-1); e.preventDefault(); }
        else if (e.key === "ArrowRight") { stepReview(1); e.preventDefault(); }
        else if (e.key === "p" || e.key === "P") { humanMove(PASS); }
      } else if (view === "problems") {
        if (e.key === "n" || e.key === "N") openNextInList();
        else if (e.key === "r" || e.key === "R") { if (prob.current) openProblem(prob.current); }
      }
    });
    // Ctrl/Cmd + wheel zooms the play board
    var scroll = document.querySelector(".board-scroll");
    if (scroll) scroll.addEventListener("wheel", function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(state.zoom + (e.deltaY < 0 ? 10 : -10));
    }, { passive: false });
  }

  function updateAdaptiveInfo() {
    var info = $("#adaptiveInfo");
    if (state.diff !== "adaptive") { info.textContent = ""; return; }
    var rec = R.recommendOpponent(state.profile);
    var txt = "Adaptive: opponent ~" + rec.label;
    if (rec.handicap > 0) txt += ", you get " + rec.handicap + " handicap stone" + (rec.handicap > 1 ? "s" : "");
    info.textContent = txt + ".";
  }

  function startGame() {
    var size = parseInt($("#sizeSel").value, 10);
    state.playerColor = parseInt($("#colorSel").value, 10);
    state.botColor = E.opp(state.playerColor);

    var komi = E.defaultKomi(size);
    var handicap = 0, botSkill, strength;

    if (state.diff === "adaptive") {
      var rec = R.recommendOpponent(state.profile);
      botSkill = rec.botSkill; strength = rec.strength;
      handicap = (state.playerColor === BLACK) ? rec.handicap : 0; // handicap only sensibly when player is Black
      state.rated = true;
    } else {
      strength = parseFloat(state.diff);
      botSkill = R.botSkillFromStrength(strength);
      state.rated = (state.playerColor === BLACK); // still rate manual games as black
    }

    state.botSkill = botSkill;
    state.handicap = handicap;
    state.bot.setStrength(strength);

    var g = new E.GoGame(size, komi);
    // Apply handicap: place black stones on star points, white moves first then.
    if (handicap >= 2) {
      placeHandicap(g, handicap);
      g.komi = 0.5; // reduce komi under handicap
      g.toMove = WHITE; // after handicap, White plays first
    }
    state.game = g;
    state.profile.lastSize = size;
    R.save(state.profile);

    // (re)build board view
    var host = $("#boardHost");
    state.view = new GT.BoardView(host, {
      size: size,
      hoverColor: state.playerColor,
      onPlay: function (p) { humanMove(p); }
    });
    state.busy = false;
    state.scoring = null;
    state.reviewIndex = null;
    state.loaded = false;
    state.variation = null; $("#variationBar").hidden = true;
    state.estimate = false;
    state.lines = []; renderLineList();
    state.influence.on = false; state.influence.ownership = null;
    $("#influenceBtn").textContent = "Show influence (KataGo)";
    $("#heatBtn").hidden = true;
    $("#winrateReadout").hidden = true;
    $("#scorePanel").hidden = true;
    $("#momentList").hidden = true;
    redraw();
    buildMoveList();
    updateAnalyzeBtn();
    // Restore saved zoom, or fit the board to the available space on first use.
    if (state.profile.boardZoom) setZoom(state.profile.boardZoom);
    else fitZoom();
    setStatus("");
    setCoach("New game: " + size + "×" + size + ", you are " +
      (state.playerColor === BLACK ? "Black" : "White") +
      ". Opponent ≈ " + R.labelForSkill(botSkill) +
      (handicap >= 2 ? (", handicap " + handicap) : "") + ". Good luck!");

    // If bot moves first, let it.
    if (state.game.toMove === state.botColor && !state.game.ended) {
      setTimeout(botMove, 250);
    }
  }

  function placeHandicap(g, h) {
    var n = g.size, pts = handicapPoints(n, h);
    for (var i = 0; i < pts.length; i++) g.board[pts[i]] = BLACK;
    g._rememberPosition();
  }

  function handicapPoints(n, h) {
    var e = n >= 13 ? 3 : 2, m = (n - 1) / 2, f = n - 1 - e;
    var corners = [[e,e],[f,f],[e,f],[f,e]];
    var sides = [[m,e],[m,f],[e,m],[f,m]];
    var center = [[m,m]];
    var order = [];
    order = order.concat(corners);
    if (h >= 5 && h % 2 === 1) order.push(center);
    order = order.concat(sides);
    if (h >= 7) order.push(center);
    // build unique list up to h
    var seen = {}, res = [];
    for (var i = 0; i < order.length && res.length < h; i++) {
      if (!Number.isInteger(order[i][0]) || !Number.isInteger(order[i][1])) continue;
      var p = order[i][0] * n + order[i][1];
      if (!seen[p]) { seen[p] = true; res.push(p); }
    }
    return res;
  }

  function humanMove(p) {
    if (state.scoring && state.scoring.active) { toggleDeadAt(p); return; }
    // Reviewing (or a loaded game): clicks explore a hypothetical "variation".
    if (state.variation || state.reviewIndex != null || state.loaded) { variationPlay(p); return; }
    if (state.busy || !state.game || state.game.ended) return;
    if (state.game.toMove !== state.playerColor) return;
    var res = state.game.play(p, state.playerColor);
    if (!res.ok) {
      setStatus(reasonText(res.reason));
      soundIllegal();
      announce("Illegal move: " + reasonText(res.reason));
      return;
    }
    redraw();
    buildMoveList();
    if (p === PASS) soundPass();
    else if (res.captured && res.captured.length) { soundCapture(); flashCaptures(res.captured); }
    else soundPlace();
    announceMove(state.playerColor, p, res.captured, state.game);
    if (state.game.scoringPhase) return enterScoring();
    setStatus("");
    state.busy = true;
    if (botDelay() > 0) setStatus("Opponent is thinking…");
    setTimeout(botMove, botDelay());
  }

  /* ---------------- variations (branch & explore in review) ---------------- */
  function variationPlay(p) {
    if (p === PASS) return;                       // passing isn't useful while exploring
    if (!state.variation) {
      var base = (state.reviewIndex != null) ? state.reviewIndex : state.game.history.length;
      state.variation = { base: base, game: buildPosition(base) };
    }
    var vg = state.variation.game;
    var res = vg.play(p, vg.toMove);
    if (!res.ok) { setStatus(reasonText(res.reason)); soundIllegal(); return; }
    if (res.captured && res.captured.length) soundCapture(); else soundPlace();
    renderVariation();
  }

  function renderVariation() {
    var v = state.variation, vg = v.game;
    var numbers = {};
    for (var i = v.base; i < vg.history.length; i++) {
      var m = vg.history[i];
      if (m.move !== PASS && vg.board[m.move] === m.color) numbers[m.move] = i - v.base + 1;
    }
    state.view.setInteractive(true);
    state.view.render(vg.board, vg.lastMove, null, { numbers: numbers });
    $("#capB").textContent = vg.captures[BLACK];
    $("#capW").textContent = vg.captures[WHITE];
    var n = vg.history.length - v.base;
    $("#turnIndicator").textContent = "Variation from move " + v.base + " · " + n + " move" + (n === 1 ? "" : "s") +
      " · " + (vg.toMove === BLACK ? "Black" : "White") + " to play";
    $("#reviewBadge").hidden = false;
    $("#variationBar").hidden = false;
    $("#varUndoBtn").disabled = n <= 0;
  }

  function variationUndo() {
    var v = state.variation;
    if (!v || v.game.history.length <= v.base) { exitVariation(); return; }
    var moves = v.game.history.slice(0, v.game.history.length - 1);
    var fresh = buildPosition(v.base);            // main line up to the branch point
    for (var i = v.base; i < moves.length; i++) fresh.play(moves[i].move, moves[i].color);
    v.game = fresh;
    if (v.game.history.length <= v.base) { exitVariation(); return; }
    renderVariation();
  }

  function exitVariation() {
    if (!state.variation) return;
    var back = state.variation.base;
    state.variation = null;
    $("#variationBar").hidden = true;
    if (state.reviewIndex != null || state.loaded) gotoMove(back);
    else gotoLive();
  }

  // Save the current variation as a named line (kept for the session; persisted via SGF).
  function saveCurrentLine() {
    var v = state.variation;
    if (!v || v.game.history.length <= v.base) { setStatus("Play a move in the variation first."); return; }
    var moves = v.game.history.slice(v.base).map(function (m) { return { move: m.move, color: m.color }; });
    var name = "From move " + v.base + " (#" + (state.lines.length + 1) + ")";
    state.lines.push({ base: v.base, name: name, moves: moves });
    renderLineList();
    setStatus("Saved variation \u201C" + name + "\u201D (" + moves.length + " move" + (moves.length === 1 ? "" : "s") + ").");
  }

  function renderLineList() {
    var wrap = $("#linesPanel"), ul = $("#lineList");
    ul.innerHTML = "";
    (state.lines || []).forEach(function (ln, i) {
      var li = document.createElement("li");
      var label = document.createElement("span");
      label.className = "line-name";
      label.textContent = ln.name + " · " + ln.moves.length + "mv";
      label.title = "Replay this line";
      label.addEventListener("click", function () { enterSavedLine(i); });
      var del = document.createElement("button");
      del.className = "line-del"; del.textContent = "\u00D7"; del.title = "Delete this line";
      del.addEventListener("click", function (e) { e.stopPropagation(); deleteLine(i); });
      var rn = document.createElement("button");
      rn.className = "line-rn"; rn.textContent = "\u270E"; rn.title = "Rename this line";
      rn.addEventListener("click", function (e) { e.stopPropagation(); renameLine(i); });
      li.appendChild(label); li.appendChild(rn); li.appendChild(del);
      ul.appendChild(li);
    });
    wrap.hidden = !(state.lines && state.lines.length);
  }

  function enterSavedLine(i) {
    var ln = state.lines[i];
    if (!ln) return;
    if (ln.base > state.game.history.length) { setStatus("That line doesn't fit the current game."); return; }
    var g = buildPosition(ln.base);
    for (var k = 0; k < ln.moves.length; k++) {
      var r = g.play(ln.moves[k].move, ln.moves[k].color);
      if (!r.ok) break;   // tolerate lines that don't replay against this position
    }
    state.variation = { base: ln.base, game: g };
    state.reviewIndex = ln.base;
    renderVariation();
    setStatus("Replaying \u201C" + ln.name + "\u201D — explore freely, or Return to game.");
  }

  function deleteLine(i) {
    state.lines.splice(i, 1);
    renderLineList();
  }

  function renameLine(i) {
    var ln = state.lines[i]; if (!ln) return;
    var name = window.prompt("Rename this line:", ln.name);
    if (name != null && name.trim()) { ln.name = name.trim(); renderLineList(); }
  }


  function botMove() {
    if (!state.game || state.game.ended || state.game.scoringPhase) { state.busy = false; return; }
    if (state.game.toMove !== state.botColor) { state.busy = false; return; }
    setStatus("Opponent is thinking…");
    var forGame = state.game;
    engineMove(forGame, function (mv) {
      // ignore stale replies (new game / not bot's turn anymore)
      if (state.game !== forGame || state.game.ended || state.game.scoringPhase ||
          state.game.toMove !== state.botColor) { state.busy = false; return; }
      if (mv === RESIGN) {                       // KataGo resigned → player wins
        state.busy = false;
        state.game.resign(state.botColor);
        if (state.reviewIndex == null) redraw();
        return finishGame();
      }
      var bres = state.game.play(mv, state.botColor);
      if (!bres.ok) { // safety net: play any legal move, else pass
        var lm = state.game.legalMoves(state.botColor);
        bres = state.game.play(lm.length ? lm[0] : PASS, state.botColor);
      }
      if (state.reviewIndex == null) redraw();
      buildMoveList();
      if (bres && bres.captured && bres.captured.length) { soundCapture(); if (state.reviewIndex == null) flashCaptures(bres.captured); }
      else if (mv === PASS) soundPass();
      else soundPlace();
      announceMove(state.botColor, mv, bres && bres.captured, state.game);
      state.busy = false;
      if (state.game.scoringPhase) return enterScoring();
      setStatus("");
      if (state.influence.on) refreshInfluence();
      if (state.game.moveNumber % 4 === 0) requestCoach("move");
      else setCoach(quickComment());
    });
  }

  /* ---------------- engine bridge: KataGo proxy + heuristic fallback ----------------
   * The opponent's moves come from KataGo running behind a tiny local proxy
   * (server/katago-server.js). If that proxy isn't running, engineMove falls
   * back to the built-in heuristic bot, so the app is always playable offline. */
  var KATAGO_URL = "http://localhost:8788";
  var katagoReady = null;            // null=unknown, true/false after probe
  var GTP_LETTERS = "ABCDEFGHJKLMNOPQRST";
  var RESIGN = -2;

  function pointToGtp(size, p) {
    if (p === PASS || p < 0) return "pass";
    var r = (p / size) | 0, c = p % size;
    return GTP_LETTERS[c] + (size - r);
  }
  function gtpToPoint(size, s) {
    if (!s) return PASS;
    s = String(s).trim().toLowerCase();
    if (s === "pass") return PASS;
    if (s === "resign") return RESIGN;
    var c = GTP_LETTERS.toLowerCase().indexOf(s[0]);
    var num = parseInt(s.slice(1), 10);
    if (c < 0 || isNaN(num)) return PASS;
    var r = size - num;
    if (r < 0 || r >= size || c >= size) return PASS;
    return r * size + c;
  }

  function probeKatago() {
    fetch(KATAGO_URL + "/health").then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { katagoReady = !!(j && j.ready); updateEngineBadge(); })
      .catch(function () { katagoReady = false; updateEngineBadge(); });
  }

  function updateEngineBadge() {
    var el = $("#engineBadge"); if (!el) return;
    if (katagoReady) { el.textContent = "KataGo"; el.classList.add("live"); el.title = "Opponent: KataGo (local proxy)"; }
    else { el.textContent = "built-in"; el.classList.remove("live"); el.title = "Opponent: built-in heuristic (start the KataGo proxy for stronger play)"; }
    var ib = $("#influenceBtn"); if (ib) ib.hidden = !katagoReady;
  }

  function fallbackMove(game) { return state.bot.chooseMove(game); }

  // Map difficulty/rank to KataGo strength knobs. Visit counts are kept modest
  // because KataGo on CPU is slow per visit — even ~10-60 visits is far stronger
  // than the heuristic and keeps moves responsive.
  function engineParams() {
    var s = state.bot.strength;
    var sp = state.profile.moveSpeed;
    var maxVisits = Math.round(4 + s * 56);                  // ~4 (easy) .. ~60 (hard)
    if (sp === "instant") maxVisits = Math.min(maxVisits, 6);
    else if (sp === "fast") maxVisits = Math.min(maxVisits, 24);
    return { maxVisits: maxVisits, rank: R.labelForSkill(state.botSkill != null ? state.botSkill : state.profile.skill) };
  }

  function engineMove(game, cb) {
    if (katagoReady === false) { cb(fallbackMove(game)); return; }
    var size = game.size;
    var moves = game.history.map(function (h) {
      return { color: h.color === BLACK ? "b" : "w", coord: pointToGtp(size, h.move) };
    });
    var params = engineParams();
    var ctrl = { aborted: false };
    var timer = setTimeout(function () { ctrl.aborted = true; cb(fallbackMove(game)); }, 12000);
    fetch(KATAGO_URL + "/genmove", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        size: size, komi: game.komi,
        toMove: game.toMove === BLACK ? "b" : "w",
        moves: moves, maxVisits: params.maxVisits, rank: params.rank
      })
    }).then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
      .then(function (j) {
        if (ctrl.aborted) return;
        clearTimeout(timer);
        katagoReady = true; updateEngineBadge();
        cb(gtpToPoint(size, j.move));
      }).catch(function () {
        if (ctrl.aborted) return;
        clearTimeout(timer);
        katagoReady = false; updateEngineBadge();
        cb(fallbackMove(game));
      });
  }

  /* ---------------- KataGo analysis: win-rate, score, territory overlay ---------------- */
  function analyzePosition(game, cb) {
    if (katagoReady === false) { cb(null); return; }
    var size = game.size;
    var moves = game.history.map(function (h) {
      return { color: h.color === BLACK ? "b" : "w", coord: pointToGtp(size, h.move) };
    });
    fetch(KATAGO_URL + "/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size: size, komi: game.komi, moves: moves })
    }).then(function (r) { if (!r.ok) throw new Error("bad"); return r.json(); })
      .then(function (j) { katagoReady = true; updateEngineBadge(); cb(j); })
      .catch(function () { katagoReady = false; updateEngineBadge(); cb(null); });
  }

  // whiteOwnership in [-1,1] (+ = white) -> {point: color} for fairly-settled points
  function ownershipTerritory(ownership, size, threshold) {
    var terr = {}, thr = (typeof threshold === "number") ? threshold : 0.30;
    if (!ownership) return terr;
    for (var p = 0; p < ownership.length && p < size * size; p++) {
      if (ownership[p] >= thr) terr[p] = WHITE;
      else if (ownership[p] <= -thr) terr[p] = BLACK;
    }
    return terr;
  }

  // |ownership| per point (0..1) for heatmap opacity/size.
  function ownershipIntensity(ownership, size) {
    var out = {};
    if (!ownership) return out;
    for (var p = 0; p < ownership.length && p < size * size; p++) out[p] = Math.abs(ownership[p]);
    return out;
  }

  function refreshInfluence() {
    if (!state.influence.on || !state.game) return;
    var g = state.game;
    analyzePosition(g, function (res) {
      if (!res) {
        $("#winrateReadout").textContent = "Influence unavailable (KataGo proxy not running).";
        state.influence.on = false; $("#influenceBtn").textContent = "Show influence (KataGo)";
        return;
      }
      state.influence.ownership = res.ownership;
      state.influence.size = res.size;
      // readout from the human player's perspective
      var winW = res.winrateWhite == null ? null : res.winrateWhite;
      var youWin = winW == null ? null : (state.playerColor === WHITE ? winW : 1 - winW);
      var lead = res.leadWhite;
      var leadStr = (lead == null) ? "" :
        (lead >= 0 ? "W+" + lead.toFixed(1) : "B+" + (-lead).toFixed(1));
      var bw = winW == null ? "" : "B " + Math.round((1 - winW) * 100) + "% / W " + Math.round(winW * 100) + "%";
      $("#winrateReadout").textContent =
        (youWin == null ? "" : "You " + Math.round(youWin * 100) + "%   ") +
        (bw ? "· " + bw + "   " : "") +
        (leadStr ? "· score " + leadStr : "");
      if (state.reviewIndex == null) redraw();
    });
  }

  function toggleInfluence() {
    state.influence.on = !state.influence.on;
    var btn = $("#influenceBtn"), out = $("#winrateReadout");
    btn.textContent = state.influence.on ? "Hide influence" : "Show influence (KataGo)";
    out.hidden = !state.influence.on;
    $("#heatBtn").hidden = !state.influence.on;
    if (state.influence.on) {
      state.estimate = false; $("#estimateBtn").textContent = "Estimate score";
      out.textContent = "Analyzing…"; refreshInfluence();
    } else { state.influence.ownership = null; if (state.reviewIndex == null) redraw(); }
  }

  // Switch the influence overlay between graded heatmap and crisp territory dots.
  function toggleHeat() {
    state.influence.heat = !state.influence.heat;
    $("#heatBtn").textContent = state.influence.heat ? "Heatmap" : "Dots";
    if (state.influence.on && state.reviewIndex == null) redraw();
  }

  // Offline rough score estimate: area scoring on the current board (no dead-stone
  // removal), with territory dots. Approximate — best once boundaries are settled.
  function toggleEstimate() {
    if (!state.game) return;
    state.estimate = !state.estimate;
    var btn = $("#estimateBtn"), out = $("#winrateReadout");
    btn.textContent = state.estimate ? "Hide estimate" : "Estimate score";
    if (state.estimate) {
      state.influence.on = false; state.influence.ownership = null;
      $("#influenceBtn").textContent = "Show influence (KataGo)";
      var s = state.game.scoreArea();
      var margin = Math.abs(s.scoreBlack - s.scoreWhite);
      var who = s.scoreBlack > s.scoreWhite ? "B+" : s.scoreWhite > s.scoreBlack ? "W+" : "even";
      out.hidden = false;
      out.textContent = "Estimate (rough): Black " + s.scoreBlack + " — White " + s.scoreWhite +
        "  " + (who === "even" ? "even" : who + margin.toFixed(1));
    } else {
      out.hidden = true;
    }
    if (state.reviewIndex == null) redraw();
  }

  function humanResign() {
    if (!state.game || state.game.ended || state.loaded) return;
    state.game.resign(state.playerColor);
    redraw();
    finishGame();
  }

  /* ---------------- SGF save / load ---------------- */
  function buildRecord() {
    var g = state.game;
    var ab = [], aw = [];
    var pos0 = buildPosition(0); // board before move 1 (captures handicap setup)
    for (var p = 0; p < pos0.board.length; p++) {
      if (pos0.board[p] === BLACK) ab.push(p);
      else if (pos0.board[p] === WHITE) aw.push(p);
    }
    var moves = g.history.map(function (h) { return { color: h.color, point: h.move }; });
    var result = null;
    if (g.result) {
      if (g.result.byResign) result = (g.result.winner === BLACK ? "B+R" : "W+R");
      else if (g.result.score) {
        var s = g.result.score;
        result = (s.winner === BLACK ? "B+" : "W+") + s.margin;
      }
    }
    var lines = (state.lines || []).map(function (ln) {
      return { base: ln.base, name: ln.name, moves: ln.moves.map(function (m) { return { color: m.color, point: m.move }; }) };
    });
    return {
      size: g.size, komi: g.komi, handicap: state.handicap,
      ab: ab, aw: aw, moves: moves, result: result, lines: lines,
      meta: { date: new Date().toISOString().slice(0, 10) }
    };
  }

  function saveSGF() {
    if (!state.game) return;
    var text = GT.sgf.toSGF(buildRecord());
    var blob = new Blob([text], { type: "application/x-go-sgf" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
    a.href = url; a.download = "gotutor-" + stamp + ".sgf";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    setStatus("Saved " + a.download + " (" + state.game.history.length + " moves).");
  }

  // Annotated SGF: same record as saveSGF, but with the review's per-move notes
  // attached as C[] comments and a summary on the root node.
  function exportReviewSGF() {
    if (!state.game) return;
    var rec = buildRecord();
    var notes = state.reviewNotes || {};
    rec.moves.forEach(function (m, i) {
      var n = notes[i + 1]; // notes keyed by 1-based ply
      if (n) m.comment = n;
    });
    var head = "Go Tutor review.";
    if (rec.result) head += " Result: " + rec.result + ".";
    var nNotes = Object.keys(notes).length;
    if (nNotes) head += " " + nNotes + " key moment" + (nNotes === 1 ? "" : "s") + " annotated.";
    rec.rootComment = head;
    var text = GT.sgf.toSGF(rec);
    var blob = new Blob([text], { type: "application/x-go-sgf" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
    a.href = url; a.download = "gotutor-review-" + stamp + ".sgf";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    setStatus("Exported " + a.download + " with " + nNotes + " note" + (nNotes === 1 ? "" : "s") + ".");
  }

  function onSgfFileChosen(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { loadSGFText(String(reader.result)); };
    reader.onerror = function () { setStatus("Could not read that file."); };
    reader.readAsText(file);
    ev.target.value = ""; // allow re-loading the same file
  }

  // Import several SGFs at once into a clickable study library.
  function onSgfCollectionChosen(ev) {
    var files = ev.target.files ? Array.prototype.slice.call(ev.target.files) : [];
    if (!files.length) return;
    var lib = [], pending = files.length;
    files.forEach(function (file) {
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result), label = file.name.replace(/\.sgf$/i, "");
        try {
          var rec = GT.sgf.fromSGF(text);
          var n = (rec.moves || []).length;
          label += " · " + rec.size + "×" + rec.size + ", " + n + " moves" + (rec.result ? " (" + rec.result + ")" : "");
          lib.push({ name: label, text: text });
        } catch (e) { /* skip unparseable files */ }
        if (--pending === 0) finishImport(lib);
      };
      reader.onerror = function () { if (--pending === 0) finishImport(lib); };
      reader.readAsText(file);
    });
    ev.target.value = "";
  }

  function finishImport(lib) {
    if (!lib.length) { setStatus("No readable SGF files in that selection."); return; }
    lib.sort(function (a, b) { return a.name.localeCompare(b.name); });
    state.library = lib;
    renderLibrary();
    setStatus("Imported " + lib.length + " game" + (lib.length === 1 ? "" : "s") + " — click one to load it.");
    loadSGFText(lib[0].text);
  }

  function renderLibrary() {
    var ul = $("#sgfLibrary");
    ul.innerHTML = "";
    (state.library || []).forEach(function (item, i) {
      var li = document.createElement("li");
      li.textContent = item.name;
      li.title = "Load this game";
      li.addEventListener("click", function () {
        loadSGFText(item.text);
        Array.prototype.forEach.call(ul.children, function (c, j) { c.classList.toggle("active", j === i); });
      });
      ul.appendChild(li);
    });
    ul.hidden = !ul.children.length;
  }

  function loadSGFText(text) {
    var rec;
    try { rec = GT.sgf.fromSGF(text); }
    catch (e) { setStatus("Could not parse SGF: " + e.message); return; }
    var built = GT.sgf.recordToGame(rec);
    state.game = built.game;
    state.handicap = rec.handicap || 0;
    state.playerColor = BLACK; state.botColor = WHITE;
    state.loaded = true; state.rated = false;
    state.scoring = null; state.reviewIndex = null;
    state.variation = null; $("#variationBar").hidden = true;
    state.lines = (rec.lines || []).map(function (ln, i) {
      return {
        base: ln.base,
        name: ln.name || ("Line from move " + ln.base + " (#" + (i + 1) + ")"),
        moves: ln.moves.map(function (m) { return { move: m.point, color: m.color }; })
      };
    });
    renderLineList();
    $("#scorePanel").hidden = true;
    $("#momentList").hidden = true;
    state.view = new GT.BoardView($("#boardHost"), {
      size: rec.size, hoverColor: BLACK, onPlay: function (p) { humanMove(p); }
    });
    if (state.profile.boardZoom) setZoom(state.profile.boardZoom); else fitZoom();
    redraw();
    buildMoveList();
    state.view.setInteractive(true);   // allow exploring variations on loaded games
    updateAnalyzeBtn();
    var note = built.illegal ? (" (" + built.illegal + " illegal move(s) skipped)") : "";
    setStatus("Loaded SGF — " + state.game.history.length + " moves" + note +
      ". Use \u25C0 \u25B6 to review; click the board to explore a variation.");
    setCoach("Loaded a game record. Step through it with the history controls. Press Analyze for a review.");
  }

  /* ---------------- scoring phase ---------------- */
  function enterScoring() {
    state.busy = false;
    state.scoring = { dead: state.game.autoDeadStones(), active: true };
    $("#scorePanel").hidden = false;
    state.view.setInteractive(true); // clicks now toggle dead stones
    setStatus("Both players passed — mark dead stones, then Accept.");
    setCoach("Scoring time. Click any stones that can't live (they'll be removed and counted as territory). I've made a first guess — adjust as needed, then Accept & finish.");
    renderScoring();
  }

  function toggleDeadAt(p) {
    var g = state.game;
    if (p == null || p < 0 || g.board[p] === E.EMPTY) return;
    var grp = g.group(p);
    var dead = state.scoring.dead;
    // If any stone of the group is marked dead, revive the whole group; else kill it.
    var anyDead = grp.stones.some(function (s) { return dead[s]; });
    grp.stones.forEach(function (s) { if (anyDead) delete dead[s]; else dead[s] = true; });
    renderScoring();
  }

  function renderScoring() {
    var g = state.game, dead = state.scoring.dead;
    var terr = g.territoryMap(dead);
    state.view.render(g.board, g.lastMove, null, { dead: dead, territory: terr });
    var s = g.scoreArea(dead);
    var lead = s.winner === BLACK ? "Black" : "White";
    $("#scoreReadout").textContent =
      "Black " + s.scoreBlack + "  ·  White " + s.scoreWhite +
      "  →  " + lead + " leads by " + s.margin.toFixed(1);
  }

  function acceptScore() {
    if (!state.scoring) return;
    state.game.finalizeScore(state.scoring.dead);
    state.scoring.active = false;
    $("#scorePanel").hidden = true;
    redraw();
    finishGame();
  }

  function resumePlay() {
    if (!state.game) return;
    state.game.resumeFromScoring();
    state.scoring = null;
    $("#scorePanel").hidden = true;
    setStatus("Play resumed. Keep going, then pass again when ready.");
    redraw();
    buildMoveList();
    if (state.game.toMove === state.botColor) { state.busy = true; setTimeout(botMove, botDelay()); }
  }

  /* ---------------- move history / review ---------------- */
  // Build a game position by replaying the first `count` history moves.
  function buildPosition(count) {
    var g = state.game;
    var fresh = new E.GoGame(g.size, g.komi);
    if (state.handicap >= 2 && state.playerColor === BLACK) {
      placeHandicap(fresh, state.handicap);
      fresh.komi = 0.5; fresh.toMove = WHITE;
    }
    var moves = g.history.slice(0, count);
    for (var i = 0; i < moves.length; i++) fresh.play(moves[i].move, moves[i].color);
    return fresh;
  }

  function buildMoveList() {
    var ol = $("#moveList");
    ol.innerHTML = "";
    var hist = state.game.history;
    var size = state.game.size;
    for (var i = 0; i < hist.length; i++) {
      var h = hist[i];
      var li = document.createElement("li");
      var glyph = h.color === BLACK ? "\u25CF" : "\u25CB";
      var cls = h.color === BLACK ? "b" : "w";
      var coord = (h.move === PASS) ? "pass" : GT.coach.coordName(size, h.move);
      li.innerHTML = "<span class='mv-no'>" + (i + 1) + "</span>" +
        "<span class='mv-stone " + cls + "'>" + glyph + "</span>" +
        "<span class='mv-coord'>" + coord + "</span>";
      (function (idx) { li.addEventListener("click", function () { gotoMove(idx + 1); }); })(i);
      ol.appendChild(li);
    }
    highlightMove();
    if (state.reviewIndex == null) ol.scrollTop = ol.scrollHeight;
  }

  function highlightMove() {
    var lis = $("#moveList").children;
    var cur = (state.reviewIndex == null) ? lis.length - 1 : state.reviewIndex - 1;
    for (var i = 0; i < lis.length; i++) lis[i].classList.toggle("current", i === cur);
  }

  function gotoMove(count) {
    if (state.variation) { state.variation = null; $("#variationBar").hidden = true; }
    var total = state.game.history.length;
    count = Math.max(0, Math.min(total, count));
    if (count >= total && state.game.history.length) return gotoLive();
    state.reviewIndex = count;
    var pos = buildPosition(count);
    // number the stones still on the board with their move order
    var numbers = {}, hist = state.game.history;
    for (var i = 0; i < count; i++) {
      var mvp = hist[i].move;
      if (mvp !== PASS && pos.board[mvp] === hist[i].color) numbers[mvp] = i + 1;
    }
    state.view.setInteractive(true);   // clicks here branch into a variation
    state.view.render(pos.board, pos.lastMove, null, { numbers: numbers });
    $("#capB").textContent = pos.captures[BLACK];
    $("#capW").textContent = pos.captures[WHITE];
    $("#turnIndicator").textContent = "Reviewing move " + count + " / " + total + " · click to explore a variation";
    $("#reviewBadge").hidden = false;
    highlightMove();
  }

  function stepReview(delta) {
    var total = state.game.history.length;
    var cur = (state.reviewIndex == null) ? total : state.reviewIndex;
    gotoMove(cur + delta);
  }

  function gotoLive() {
    state.variation = null; $("#variationBar").hidden = true;
    state.reviewIndex = null;
    $("#reviewBadge").hidden = true;
    if (state.scoring && state.scoring.active) renderScoring();
    else redraw();
    var playable = !state.game.ended && !state.game.scoringPhase &&
      state.game.toMove === state.playerColor;
    state.view.setInteractive(playable || !!(state.scoring && state.scoring.active));
    highlightMove();
  }

  function undo() {
    // Undo one full turn (player + bot) for casual learning. Disables rating.
    if (!state.game || state.busy) return;
    if (state.reviewIndex != null) { gotoLive(); return; }
    var hist = state.game.history;
    if (hist.length === 0) return;
    // rebuild from scratch minus last 1-2 moves
    var toRemove = 1;
    if (hist.length >= 2) toRemove = 2;
    rebuildMinus(toRemove);
    state.rated = false;
    state.scoring = null;
    $("#scorePanel").hidden = true;
    setStatus("Undo used — this game won't affect your rank.");
    redraw();
    buildMoveList();
  }

  function rebuildMinus(k) {
    var g = state.game;
    var moves = g.history.slice(0, g.history.length - k);
    var fresh = new E.GoGame(g.size, g.komi);
    // reapply handicap if any was set (detected by initial black stones count mismatch is complex;
    // simpler: we stored handicap in state)
    if (state.handicap >= 2 && state.playerColor === BLACK) {
      placeHandicap(fresh, state.handicap);
      fresh.komi = 0.5; fresh.toMove = WHITE;
    }
    for (var i = 0; i < moves.length; i++) {
      fresh.play(moves[i].move, moves[i].color);
    }
    state.game = fresh;
  }

  function finishGame() {
    var g = state.game, res = g.result;
    var playerWon = res.winner === state.playerColor;
    var margin = res.score ? res.score.margin : null;
    var msg;
    if (res.byResign) {
      msg = playerWon ? "Your opponent resigned — you win!" : "You resigned.";
    } else {
      var s = res.score;
      msg = "Game over. Black " + s.scoreBlack + " — White " + s.scoreWhite + ". " +
            (playerWon ? "You win by " + margin + "!" : "You lose by " + margin + ".");
    }
    setStatus(msg);
    state.view.setInteractive(false);
    soundGameOver();
    announce(msg);

    if (state.rated) {
      var rec = R.recordGame(state.profile, {
        won: playerWon, margin: margin, botSkill: state.botSkill,
        handicap: state.handicap, size: g.size, byResign: res.byResign
      });
      updateRankUI();
      updateAdaptiveInfo();
      var trend = rec.delta >= 0 ? "▲" : "▼";
      setStatus(msg + "  Rank: " + R.labelForSkill(rec.skillBefore) + " → " +
        rec.label + " " + trend);
    } else {
      setStatus(msg + "  (unrated — undo was used)");
    }
    updateAnalyzeBtn();
    requestCoach("review");
  }

  /* ---------------- coach ---------------- */
  function requestCoach(kind, extra, question) {
    var ctx = {
      playerColor: state.playerColor,
      playerRank: R.labelForSkill(state.profile.skill),
      extra: extra || "",
      question: question || ""
    };
    var box = $("#coachText");
    box.classList.add("thinking");
    box.textContent = kind === "review" ? "Reviewing the game…" : "Thinking…";
    GT.coach.coach(kind, state.game, ctx).then(function (txt) {
      box.classList.remove("thinking");
      box.textContent = txt;
      updateCoachStatus(GT.coach.isAvailable());
    });
  }

  function askCoachQuestion() {
    if (!state.game) return;
    var inp = $("#coachAsk"), q = (inp.value || "").trim();
    if (!q) return;
    requestCoach("ask", "", q);
  }

  function askHint() {
    if (!state.game || state.game.ended) return;
    if (state.game.toMove !== state.playerColor) return;
    requestCoach("hint");
    // also flash a heuristic marker for an atari opportunity if any
    var mk = suggestMarker();
    if (mk != null) state.view.render(state.game.board, state.game.lastMove, [{ p: mk, cls: "good" }]);
  }

  function suggestMarker() {
    // crude: find a legal move that captures or ataris an enemy group
    var g = state.game, color = state.playerColor;
    var moves = g.legalMoves(color);
    var best = null, bestVal = 0;
    for (var i = 0; i < moves.length && i < 400; i++) {
      var t = g.trial(moves[i], color);
      if (!t.legal) continue;
      var val = t.captured.length * 3;
      // atari detection
      var nb = g.neighbors(moves[i]);
      for (var j = 0; j < nb.length; j++) {
        if (t.board[nb[j]] === E.opp(color)) {
          var grp = g.group(nb[j], t.board);
          if (grp.libCount === 1) val += 1;
        }
      }
      if (val > bestVal) { bestVal = val; best = moves[i]; }
    }
    return bestVal > 0 ? best : null;
  }

  function quickComment() {
    var g = state.game;
    if (g.lastMove === PASS) return "Opponent passed. Pass too to end and count, or keep playing if points remain.";
    var who = g.board[g.lastMove] === BLACK ? "Black" : "White";
    var grp = g.group(g.lastMove);
    if (grp.libCount === 1) return who + " is in atari — capture chance!";
    if (grp.libCount === 2) return who + "'s group has only 2 liberties; it's attackable.";
    return "Your move. Think about weak groups and big open areas.";
  }

  function setCoach(t) { var b = $("#coachText"); b.classList.remove("thinking"); b.textContent = t; }  function updateCoachStatus(avail) {
    var el = $("#coachStatus");
    if (avail) { el.textContent = "Claude live"; el.classList.add("live"); }
    else { el.textContent = "offline tips"; el.classList.remove("live"); }
  }

  /* ---------------- rendering helpers ---------------- */
  function redraw() {
    var overlay = null;
    if (state.influence.on && state.influence.ownership) {
      var own = state.influence.ownership, sz = state.influence.size;
      if (state.influence.heat) {
        overlay = { territory: ownershipTerritory(own, sz, 0.12), intensity: ownershipIntensity(own, sz) };
      } else {
        overlay = { territory: ownershipTerritory(own, sz, 0.30) };
      }
    } else if (state.estimate) {
      overlay = { territory: state.game.territoryMap() };
    }
    state.view.render(state.game.board, state.game.lastMove, null, overlay);
    $("#capB").textContent = state.game.captures[BLACK];
    $("#capW").textContent = state.game.captures[WHITE];
    var tm = state.loaded ? "Loaded game — review with \u25C0 \u25B6" :
      state.game.ended ? "Game over" :
      (state.game.toMove === BLACK ? "Black to move" : "White to move") +
      (state.game.toMove === state.playerColor ? " (you)" : " (opponent)");
    $("#turnIndicator").textContent = tm;
  }

  /* ---------------- post-game analysis ---------------- */
  function updateAnalyzeBtn() {
    var show = state.game && (state.game.ended || state.loaded) && state.game.history.length >= 2;
    $("#analyzeBtn").hidden = !show;
    if (!show) { $("#exportReviewBtn").hidden = true; state.reviewNotes = null; }
  }

  // Player-perspective "material" margin after the first `count` moves:
  // stones on board (captures included) minus komi. Area/territory scoring is
  // meaningless on a sparse board, so we track material — which makes the big
  // swings exactly the captures and tactical losses worth reviewing.
  function marginAfter(count, playerColor) {
    var pos = buildPosition(count);
    var b = 0, w = 0;
    for (var p = 0; p < pos.board.length; p++) {
      if (pos.board[p] === BLACK) b++; else if (pos.board[p] === WHITE) w++;
    }
    var blackMargin = (b - w) - pos.komi;
    return playerColor === BLACK ? blackMargin : -blackMargin;
  }

  function analyzeGame() {
    var g = state.game, pc = state.playerColor, n = g.history.length;
    if (n < 2) return;
    if (katagoReady) { katagoReview(); return; }   // engine-grade review when available
    var prev = marginAfter(0, pc), moments = [];
    for (var k = 1; k <= n; k++) {
      var cur = marginAfter(k, pc);
      var mover = g.history[k - 1].color;
      var delta = cur - prev;          // change in player's lead
      // A "mistake" is a swing AGAINST the player caused by the mover.
      var againstPlayer = (mover === pc) ? (delta < 0) : (delta > 0);
      moments.push({ ply: k, mover: mover, delta: delta, margin: cur, against: againstPlayer, swing: Math.abs(delta) });
      prev = cur;
    }
    // Pick the biggest swings (most instructive), prefer those against the player.
    var top = moments.slice().sort(function (a, b) {
      return (b.swing + (b.against ? 1000 : 0)) - (a.swing + (a.against ? 1000 : 0));
    }).filter(function (m) { return m.swing >= 2; }).slice(0, 5)
      .sort(function (a, b) { return a.ply - b.ply; });

    renderMoments(top);
    // Feed the key moments to the coach for a sharper review.
    var summary = top.map(function (m) {
      var who = m.mover === BLACK ? "Black" : "White";
      var coord = g.history[m.ply - 1].move === PASS ? "pass" : GT.coach.coordName(g.size, g.history[m.ply - 1].move);
      return "move " + m.ply + " (" + who + " " + coord + "): material swing " + (m.delta > 0 ? "+" : "") + m.delta.toFixed(0);
    }).join("; ");
    requestCoach("review", summary ? ("Key tactical swings (by stones captured/lost): " + summary + ".") : "");
  }

  function renderMoments(moments) {
    var ol = $("#momentList");
    ol.innerHTML = "";
    if (!moments.length) {
      ol.hidden = false;
      ol.innerHTML = "<li class='moment'>No big swings — a steady game. Nice.</li>";
      return;
    }
    var g = state.game, pc = state.playerColor;
    state.reviewNotes = {};
    moments.forEach(function (m) {
      var li = document.createElement("li");
      li.className = "moment " + (m.against ? "bad" : "good");
      var who = m.mover === BLACK ? "\u25CF" : "\u25CB";
      var coord = g.history[m.ply - 1].move === PASS ? "pass" : GT.coach.coordName(g.size, g.history[m.ply - 1].move);
      var tag = m.against ? (m.mover === pc ? "your slip" : "tough for you") : (m.mover === pc ? "good move" : "they erred");
      state.reviewNotes[m.ply] = coord + " — " + tag + " (swing " + (m.delta > 0 ? "+" : "") + m.delta.toFixed(0) + ").";
      li.innerHTML = "<span class='mv-no'>" + m.ply + "</span>" +
        "<span class='mv-stone'>" + who + "</span>" +
        "<span class='m-coord'>" + coord + "</span>" +
        "<span class='m-swing " + (m.against ? "neg" : "pos") + "'>" + (m.delta > 0 ? "+" : "") + m.delta.toFixed(0) + "</span>" +
        "<span class='m-tag'>" + tag + "</span>";
      li.addEventListener("click", function () { gotoMove(m.ply); });
      ol.appendChild(li);
    });
    ol.hidden = false;
    $("#exportReviewBtn").hidden = false;
  }

  /* Engine-grade review: KataGo win-rate after every move; biggest drops on the
   * player's own moves are the instructive mistakes. */
  function katagoReview() {
    var g = state.game, pc = state.playerColor, n = g.history.length;
    var winr = [];                          // winr[k] = player win-rate after k moves
    var ol = $("#momentList"); ol.hidden = false;
    var k = 0;
    function setProgress() { ol.innerHTML = "<li class='moment'>KataGo reviewing… " + k + "/" + n + "</li>"; }
    setProgress();
    function step() {
      if (k > n) { finishKatagoReview(winr); return; }
      analyzePosition(buildPosition(k), function (res) {
        if (res && res.winrateWhite != null) {
          winr[k] = pc === WHITE ? res.winrateWhite : 1 - res.winrateWhite;
        } else if (!katagoReady) {           // proxy died mid-review
          ol.innerHTML = "<li class='moment bad'>KataGo became unavailable — falling back.</li>";
          return;
        } else {
          winr[k] = k > 0 ? winr[k - 1] : 0.5;
        }
        k++; setProgress(); step();
      });
    }
    step();
  }

  function finishKatagoReview(winr) {
    var g = state.game, pc = state.playerColor, n = g.history.length, moments = [];
    for (var k = 1; k <= n; k++) {
      if (winr[k] == null || winr[k - 1] == null) continue;
      var delta = (winr[k] - winr[k - 1]) * 100;     // player win-rate change, points
      var mover = g.history[k - 1].color;
      var against = (mover === pc) ? (delta < 0) : (delta > 0);
      moments.push({ ply: k, mover: mover, delta: delta, against: against, swing: Math.abs(delta) });
    }
    var top = moments.slice().sort(function (a, b) {
      return (b.swing + (b.against ? 1000 : 0)) - (a.swing + (a.against ? 1000 : 0));
    }).filter(function (m) { return m.swing >= 4; }).slice(0, 5)
      .sort(function (a, b) { return a.ply - b.ply; });
    renderMoments(top);
    var summary = top.map(function (m) {
      var who = m.mover === BLACK ? "Black" : "White";
      var coord = g.history[m.ply - 1].move === PASS ? "pass" : GT.coach.coordName(g.size, g.history[m.ply - 1].move);
      return "move " + m.ply + " (" + who + " " + coord + "): win-rate " + (m.delta > 0 ? "+" : "") + m.delta.toFixed(0) + "%";
    }).join("; ");
    requestCoach("review", summary ? ("KataGo win-rate swings: " + summary + "." +
      " The biggest drops on the student's own moves are the key mistakes.") : "");
  }


  function setStatus(t) { $("#statusMsg").textContent = t; }

  // Screen-reader announcement (aria-live). Toggle text so repeats are spoken.
  function announce(t) {
    var el = $("#srLive"); if (!el) return;
    el.textContent = "";
    setTimeout(function () { el.textContent = t; }, 30);
  }
  function announceMove(color, p, captured, game) {
    var who = color === BLACK ? "Black" : "White";
    var where = (p === PASS) ? "passes" : GT.coach.coordName(game.size, p);
    var cap = (captured && captured.length) ? ", captures " + captured.length : "";
    var next = game.ended ? "" : "; " + (game.toMove === BLACK ? "Black" : "White") + " to move";
    announce(who + " " + where + cap + next + ".");
  }

  function reasonText(r) {
    return ({ occupied: "That point is taken.", ko: "Ko: you can't recapture there yet — play elsewhere first.",
      suicide: "Illegal: that's self-capture (suicide).", superko: "Illegal: that repeats a previous board position.",
      "not-your-turn": "Not your turn.", ended: "The game is over." })[r] || "Illegal move.";
  }

  function updateRankUI() {
    var p = state.profile;
    $("#rankLabel").textContent = R.labelForSkill(p.skill);
    $("#rankSub").textContent = p.games === 0 ? "provisional" : (p.wins + "W / " + p.losses + "L");
  }

  /* ---------------- tutorial ---------------- */
  function buildLessonList() {
    var list = $("#lessonList");
    list.innerHTML = "";
    GT.tutorial.lessons.forEach(function (les, i) {
      var li = document.createElement("li");
      var done = state.profile.tutorialsDone[les.id];
      li.innerHTML = "<span>" + les.title + "</span>" + (done ? "<span class='done'>✓</span>" : "");
      li.addEventListener("click", function () { openLesson(i); });
      li.dataset.idx = i;
      list.appendChild(li);
    });
  }

  function enterLearn() {
    // Keep an in-progress lesson if one is genuinely open and not yet finished.
    if (lesson.current &&
        !state.profile.tutorialsDone[lesson.current.id] &&
        lesson.stepIdx < lesson.current.steps.length) {
      return;
    }
    // Otherwise open the first lesson the user hasn't completed (else lesson 1).
    var lessons = GT.tutorial.lessons;
    var idx = 0;
    for (var i = 0; i < lessons.length; i++) {
      if (!state.profile.tutorialsDone[lessons[i].id]) { idx = i; break; }
    }
    openLesson(idx);
  }

  function openLesson(i) {
    var les = GT.tutorial.lessons[i];
    lesson.current = les; lesson.stepIdx = 0;
    document.querySelectorAll("#lessonList li").forEach(function (li) {
      li.classList.toggle("active", parseInt(li.dataset.idx, 10) === i);
    });
    $("#lessonTitle").textContent = les.title;
    $("#lessonIntro").textContent = les.intro;
    lesson.game = GT.tutorial.buildLessonGame(les);
    lesson.view = new GT.BoardView($("#lessonBoardHost"), {
      size: les.size,
      hoverColor: BLACK,
      onPlay: onLessonPlay,
      showCoords: les.size <= 13
    });
    lesson.view.render(lesson.game.board, lesson.game.lastMove);
    renderLessonStep();
  }

  function renderLessonStep() {
    var les = lesson.current, step = les.steps[lesson.stepIdx];
    var box = $("#lessonStep");
    box.className = "lesson-step";
    if (!step) {
      box.textContent = "Lesson complete! ✓";
      state.profile.tutorialsDone[les.id] = true;
      R.save(state.profile);
      buildLessonList();
      $("#lessonStatus").textContent = "Nicely done.";
      lesson.view.setInteractive(false);
      return;
    }
    box.textContent = step.text;
    lesson.view.setHoverColor(step.color || BLACK);
    lesson.view.setInteractive(step.type === "task");
    $("#lessonStatus").textContent = step.type === "task" ? "Your move." : "";
  }

  function onLessonPlay(p) {
    var step = lesson.current.steps[lesson.stepIdx];
    if (!step || step.type !== "task") return;
    var color = step.color || BLACK;
    lesson.game.toMove = color;
    var verdict = step.validate ? step.validate(lesson.game, p, {}) : { ok: true, msg: "" };
    var box = $("#lessonStep");
    if (!verdict.ok) {
      box.className = "lesson-step error";
      box.textContent = step.text + "\n\n→ " + verdict.msg;
      return;
    }
    // play the move (rules enforced)
    var res = lesson.game.play(p, color);
    if (!res.ok) {
      box.className = "lesson-step error";
      box.textContent = step.text + "\n\n→ " + reasonText(res.reason);
      return;
    }
    lesson.view.render(lesson.game.board, lesson.game.lastMove);
    box.className = "lesson-step success";
    box.textContent = verdict.msg || "Correct!";
    setTimeout(function () { lesson.stepIdx++; renderLessonStep(); }, 900);
  }

  $("#lessonNext") && document.addEventListener("click", function (e) {
    if (e.target.id === "lessonNext") {
      if (!lesson.current) return;
      var step = lesson.current.steps[lesson.stepIdx];
      if (step && step.type === "info") { lesson.stepIdx++; renderLessonStep(); }
      else if (step && step.type === "task") { $("#lessonStatus").textContent = "Make the move on the board to continue."; }
      else { lesson.stepIdx++; renderLessonStep(); }
    }
    if (e.target.id === "lessonPrev") {
      if (!lesson.current || lesson.stepIdx === 0) return;
      lesson.stepIdx--; renderLessonStep();
    }
  });

  /* ---------------- tsumego problems ---------------- */
  function bindProblemControls() {
    $("#problemHint").addEventListener("click", function () {
      if (prob.current) { $("#problemFeedback").className = "lesson-step"; $("#problemFeedback").textContent = prob.current.hint; }
    });
    $("#problemReset").addEventListener("click", function () {
      if (prob.current) openProblem(prob.current);
    });
    $("#problemCategory").addEventListener("change", function () { rebuildProblemList(); openFirstUnsolved(); });
    $("#problemDifficulty").addEventListener("change", function () { rebuildProblemList(); openFirstUnsolved(); });
    $("#problemRandom").addEventListener("click", openRandomUnsolved);
    $("#problemDaily").addEventListener("click", openDailyProblem);
    $("#problemNext").addEventListener("click", openNextInList);
    $("#problemDue").addEventListener("click", openNextDue);
    populateCategorySelect();
    updateDueButton();
  }

  function populateCategorySelect() {
    var sel = $("#problemCategory");
    if (sel.options.length) return;
    GT.problems.categories.forEach(function (c) {
      var n = c.id === "all" ? GT.problems.all().length : GT.problems.filter(c.id, 0).length;
      var o = document.createElement("option");
      o.value = c.id; o.textContent = c.label + " (" + n + ")";
      sel.appendChild(o);
    });
  }

  function currentFilter() {
    return GT.problems.filter($("#problemCategory").value || "all", $("#problemDifficulty").value || 0);
  }

  function enterProblems() {
    rebuildProblemList();
    updateDueButton();
    if (prob.current && !prob.solved) return; // keep an in-progress problem
    openFirstUnsolved();
  }

  function openFirstUnsolved() {
    var f = prob.filtered || [];
    var target = null;
    for (var i = 0; i < f.length; i++) { if (!state.profile.problemsDone[f[i].id]) { target = f[i]; break; } }
    openProblem(target || f[0] || null);
  }

  function rebuildProblemList() {
    var ul = $("#problemList");
    ul.innerHTML = "";
    var f = currentFilter();
    prob.filtered = f;
    var stars = ["", "\u2605", "\u2605\u2605", "\u2605\u2605\u2605"];
    f.forEach(function (p) {
      var li = document.createElement("li");
      var done = state.profile.problemsDone[p.id];
      li.innerHTML = "<span>" + p.title + "</span>" +
        (done ? "<span class='done'>\u2713</span>" : "") +
        "<span class='pstars'>" + (stars[p.difficulty] || "") + "</span>";
      li.dataset.id = p.id;
      li.addEventListener("click", function () { openProblem(p); });
      ul.appendChild(li);
    });
    var allList = GT.problems.all();
    var solvedAll = allList.filter(function (p) { return state.profile.problemsDone[p.id]; }).length;
    $("#problemSolvedCount").textContent = solvedAll + " / " + allList.length + " solved";
    highlightProblem();
  }

  function highlightProblem() {
    var id = prob.current && prob.current.id;
    document.querySelectorAll("#problemList li").forEach(function (li) {
      li.classList.toggle("active", li.dataset.id === id);
    });
  }

  function openProblem(p) {
    if (!p) {
      $("#problemTitle").textContent = "No problems match";
      $("#problemPrompt").textContent = "Try a different category or difficulty.";
      $("#problemFeedback").textContent = "";
      return;
    }
    prob.current = p; prob.solved = false; prob.wrong = false;
    $("#problemTitle").textContent = p.title;
    $("#problemPrompt").textContent = (p.color === BLACK ? "Black" : "White") + " to play. " + p.hint;
    $("#problemFeedback").className = "lesson-step";
    $("#problemFeedback").textContent = "Find the key move on the board.";
    $("#problemStatus").textContent = state.profile.problemsDone[p.id] ? "Already solved \u2713 — try again to confirm." : "";
    prob.game = GT.problems.buildGame(p);
    prob.view = new GT.BoardView($("#problemBoardHost"), {
      size: p.size, hoverColor: p.color, onPlay: onProblemPlay, showCoords: true
    });
    prob.view.render(prob.game.board, prob.game.lastMove);
    highlightProblem();
    // ensure the active item is visible in the scroll list
    var active = document.querySelector("#problemList li.active");
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }

  function openRandomUnsolved() {
    var f = (prob.filtered || []).filter(function (p) { return !state.profile.problemsDone[p.id]; });
    if (!f.length) f = prob.filtered || [];
    if (f.length) openProblem(f[(Math.random() * f.length) | 0]);
  }

  function openNextInList() {
    var f = prob.filtered || [];
    if (!f.length) return;
    var idx = prob.current ? f.findIndex(function (p) { return p.id === prob.current.id; }) : -1;
    openProblem(f[(idx + 1) % f.length]);
  }

  // Deterministic "problem of the day": same pick for everyone, changes each date.
  function openDailyProblem() {
    var all = GT.problems.all();
    if (!all.length) return;
    var d = new Date();
    var key = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    var h = key % 2147483647;
    h = (h * 48271) % 2147483647;     // one Lehmer step so consecutive days differ a lot
    var pick = all[h % all.length];
    openProblem(pick);
    $("#problemStatus").textContent = "Problem of the day — " +
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      (state.profile.problemsDone[pick.id] ? " (already solved \u2713)" : "");
  }

  /* ---------------- opening trainer (fuseki principles) ---------------- */
  function bindOpeningControls() {
    $("#openingShow").addEventListener("click", showOpeningAnswers);
    $("#openingReset").addEventListener("click", function () { if (open.current) openDrill(open.current); });
    $("#openingNext").addEventListener("click", openNextDrill);
  }

  function enterOpening() {
    buildOpeningList();
    if (!open.current) openDrill(GT.opening.drills[0]);
  }

  function buildOpeningList() {
    var ul = $("#openingList");
    ul.innerHTML = "";
    var done = state.profile.openingsDone || {};
    GT.opening.drills.forEach(function (d) {
      var li = document.createElement("li");
      li.innerHTML = "<span>" + d.title + "</span>" + (done[d.id] ? "<span class='done'>\u2713</span>" : "");
      li.dataset.id = d.id;
      li.addEventListener("click", function () { openDrill(d); });
      ul.appendChild(li);
    });
    var total = GT.opening.drills.length;
    var n = GT.opening.drills.filter(function (d) { return done[d.id]; }).length;
    $("#openingSolvedCount").textContent = n + " / " + total + " done";
    highlightOpening();
  }

  function highlightOpening() {
    var id = open.current && open.current.id;
    document.querySelectorAll("#openingList li").forEach(function (li) {
      li.classList.toggle("active", li.dataset.id === id);
    });
  }

  function openDrill(d) {
    open.current = d; open.done = false;
    open.game = GT.opening.buildGame(d);
    $("#openingTitle").textContent = d.title;
    $("#openingIntro").textContent = d.intro;
    $("#openingPrompt").textContent = d.prompt;
    $("#openingFeedback").className = "lesson-step";
    $("#openingFeedback").textContent = "";
    $("#openingStatus").textContent = (state.profile.openingsDone || {})[d.id] ? "Done \u2713 — try it again to confirm." : "";
    open.view = new GT.BoardView($("#openingBoardHost"), {
      size: GT.opening.N, hoverColor: d.toMove, onPlay: onOpeningPlay, showCoords: true
    });
    open.view.render(open.game.board, null);
    highlightOpening();
  }

  function onOpeningPlay(p) {
    var d = open.current, g = open.game;
    if (!d || !g) return;
    if (g.board[p] === BLACK || g.board[p] === WHITE) return;   // occupied
    if (d.accept(p, g)) {
      g.board[p] = d.toMove;
      open.view.render(g.board, p, [{ p: p, cls: "good" }]);
      open.done = true;
      var fb = $("#openingFeedback"); fb.className = "lesson-step ok"; fb.textContent = d.ok;
      soundPlace();
      var done = state.profile.openingsDone || (state.profile.openingsDone = {});
      if (!done[d.id]) { done[d.id] = true; R.save(state.profile); }
      buildOpeningList();
    } else {
      var f = $("#openingFeedback"); f.className = "lesson-step bad"; f.textContent = d.bad;
      soundIllegal();
    }
  }

  function showOpeningAnswers() {
    var d = open.current, g = open.game;
    if (!d || !g) return;
    var pts = GT.opening.solutionPoints(d, g).map(function (p) { return { p: p, cls: "good" }; });
    open.view.render(g.board, null, pts);
    var f = $("#openingFeedback"); f.className = "lesson-step"; f.textContent =
      "Any highlighted point works. " + d.ok;
  }

  function openNextDrill() {
    var drills = GT.opening.drills;
    var idx = open.current ? drills.findIndex(function (d) { return d.id === open.current.id; }) : -1;
    openDrill(drills[(idx + 1) % drills.length]);
  }

  /* ---------------- spaced repetition (SM-2-lite) for tsumego ---------------- */
  var DAY = 86400000;
  function srsRecord(id, good) {
    var srs = state.profile.srs || (state.profile.srs = {});
    var e = srs[id] || { reps: 0, interval: 0, ease: 2.3, due: 0 };
    if (good) {
      e.reps += 1;
      e.interval = e.reps === 1 ? 1 : e.reps === 2 ? 3 : Math.round(e.interval * e.ease);
      e.ease = Math.min(2.8, e.ease + 0.05);
    } else {
      e.reps = 0;
      e.interval = 0;                       // due again very soon
      e.ease = Math.max(1.3, e.ease - 0.2);
    }
    e.due = Date.now() + e.interval * DAY;
    srs[id] = e;
    R.save(state.profile);
  }
  function dueList() {
    var srs = state.profile.srs || {}, now = Date.now(), out = [];
    GT.problems.all().forEach(function (p) {
      var e = srs[p.id];
      if (e && e.due <= now) out.push(p);
    });
    return out;
  }
  function updateDueButton() {
    var btn = $("#problemDue"); if (!btn) return;
    var n = dueList().length;
    btn.textContent = "Review due (" + n + ")";
    btn.disabled = n === 0;
  }
  function openNextDue() {
    var due = dueList();
    if (!due.length) return;
    openProblem(due[0]);
  }

  function onProblemPlay(point) {
    if (!prob.current || prob.solved) return;
    var p = prob.current;
    if (p.multi) return onMultiMovePlay(point);
    var sols = GT.problems.solutionPoints(p);
    var box = $("#problemFeedback");
    if (sols.indexOf(point) < 0) {
      prob.wrong = true;
      box.className = "lesson-step error";
      box.textContent = "Not the key point — try again. " + p.hint;
      return;
    }
    // Correct point: play it (rules enforced) and confirm any capture requirement.
    var res = prob.game.play(point, p.color);
    if (!res.ok || (p.mustCapture && (!res.captured || res.captured.length === 0))) {
      prob.wrong = true;
      box.className = "lesson-step error";
      box.textContent = "Hmm, that didn't work as expected — try again.";
      prob.game = GT.problems.buildGame(p);
      prob.view.render(prob.game.board, prob.game.lastMove);
      return;
    }
    prob.view.render(prob.game.board, prob.game.lastMove);
    prob.solved = true;
    box.className = "lesson-step success";
    box.textContent = "Correct! " + p.explain;
    $("#problemStatus").textContent = "Solved \u2713";
    state.profile.problemsDone[p.id] = true;
    R.save(state.profile);
    srsRecord(p.id, !prob.wrong);
    updateDueButton();
    rebuildProblemList();
  }

  // Multi-move (ladder / forced-capture) problems, driven by the solver.
  function onMultiMovePlay(point) {
    var p = prob.current, size = p.size;
    var origin = p.target[0] * size + p.target[1];
    var attacker = p.attacker, defender = E.opp(attacker);
    var box = $("#problemFeedback");
    if (prob.game.toMove !== attacker) return;
    var cg = prob.game.clone();
    var r = cg.play(point, attacker);
    if (!r.ok) { box.className = "lesson-step error"; box.textContent = "Can't play there. " + p.hint; return; }
    if (cg.board[origin] !== defender) { prob.game = cg; prob.view.render(cg.board, cg.lastMove); return markMultiSolved(); }
    var res = GT.solver.solve(cg, origin, attacker, size * 3);
    if (!res.win) {
      box.className = "lesson-step error";
      prob.wrong = true;
      box.textContent = "That lets the white stone escape — try again.";
      prob.view.render(prob.game.board, prob.game.lastMove);
      return;
    }
    prob.game = cg;
    var dm = GT.solver.defenderReply(prob.game, origin, attacker);
    if (dm !== E.PASS && dm != null) prob.game.play(dm, defender);
    prob.view.render(prob.game.board, prob.game.lastMove);
    if (prob.game.board[origin] !== defender) return markMultiSolved();
    box.className = "lesson-step";
    box.textContent = "Good — it's still trapped. Keep it in atari.";
  }

  function markMultiSolved() {
    var p = prob.current, box = $("#problemFeedback");
    prob.solved = true;
    box.className = "lesson-step success";
    box.textContent = "Captured! " + p.explain;
    $("#problemStatus").textContent = "Solved \u2713";
    state.profile.problemsDone[p.id] = true;
    R.save(state.profile);
    srsRecord(p.id, !prob.wrong);
    updateDueButton();
    rebuildProblemList();
  }

  /* ---------------- progress ---------------- */
  function bindProgressControls() {
    $("#resetBtn").addEventListener("click", function () {
      if (confirm("Reset all progress, rank, and lesson history?")) {
        state.profile = R.reset();
        updateRankUI(); renderProgress(); buildLessonList(); updateAdaptiveInfo();
      }
    });
  }

  function renderProgress() {
    var p = state.profile;
    var pct = R.progressPct(p);
    $("#ladderFill").style.width = pct + "%";
    $("#ladderMarker").style.left = pct + "%";
    $("#ladderTag").textContent = R.labelForSkill(p.skill);
    $("#statRank").textContent = R.labelForSkill(p.skill);
    $("#statGames").textContent = p.games;
    $("#statWins").textContent = p.wins;
    $("#statBest").textContent = R.labelForSkill(p.best);

    renderCharts(p);

    var tb = $("#histBody"); tb.innerHTML = "";
    var rows = p.history.slice().reverse().slice(0, 12);
    rows.forEach(function (h, i) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + (p.history.length - i) + "</td>" +
        "<td>" + h.size + "×" + h.size + "</td>" +
        "<td class='" + (h.won ? "win" : "loss") + "'>" + (h.won ? "Win" : "Loss") + "</td>" +
        "<td>" + (h.margin == null ? "resign" : h.margin) + "</td>" +
        "<td>" + R.labelForSkill(h.botSkill) + (h.handicap ? ("/H" + h.handicap) : "") + "</td>" +
        "<td>" + R.labelForSkill(h.skillAfter) + "</td>";
      tb.appendChild(tr);
    });
    if (rows.length === 0) tb.innerHTML = "<tr><td colspan='6' style='color:var(--muted)'>No games yet — play one!</td></tr>";

    var lp = $("#lessonProgress"); lp.innerHTML = "";
    GT.tutorial.lessons.forEach(function (les) {
      var chip = document.createElement("span");
      var done = p.tutorialsDone[les.id];
      chip.className = "chip" + (done ? " done" : "");
      chip.textContent = (done ? "✓ " : "") + les.title.replace(/^\d+\.\s*/, "");
      lp.appendChild(chip);
    });
  }

  function $(sel) { return document.querySelector(sel); }

  /* ---------------- stats charts (inline SVG, no libs) ---------------- */
  function svgEl(w, h, body) {
    return "<svg viewBox='0 0 " + w + " " + h + "' width='100%' height='" + h + "' class='chartsvg'>" + body + "</svg>";
  }
  function renderCharts(p) {
    // 1) rank over time
    var host = $("#chartRank");
    var pts = p.history.map(function (h) { return h.skillAfter; });
    if (pts.length < 2) host.innerHTML = "<div class='chart-empty'>Play a few games to see your trend.</div>";
    else {
      var w = 320, h = 90, pad = 8, max = R.MAX_SKILL, min = R.MIN_SKILL;
      var step = (w - pad * 2) / (pts.length - 1);
      var path = pts.map(function (v, i) {
        var x = pad + i * step, y = h - pad - ((v - min) / (max - min)) * (h - pad * 2);
        return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
      }).join(" ");
      host.innerHTML = svgEl(w, h, "<path d='" + path + "' class='line'/>" +
        "<text x='3' y='11' class='clabel'>2d</text><text x='3' y='" + (h - 3) + "' class='clabel'>18k</text>");
    }
    // 2) win rate by size
    var bySize = {};
    p.history.forEach(function (g) { var k = g.size; bySize[k] = bySize[k] || { w: 0, n: 0 }; bySize[k].n++; if (g.won) bySize[k].w++; });
    host = $("#chartWinRate");
    var sizes = Object.keys(bySize);
    host.innerHTML = sizes.length ? sizes.map(function (s) {
      var rate = Math.round(bySize[s].w / bySize[s].n * 100);
      return "<div class='bar-row'><span class='bar-lbl'>" + s + "×" + s + "</span>" +
        "<span class='bar'><span class='bar-fill' style='width:" + rate + "%'></span></span>" +
        "<span class='bar-val'>" + rate + "% (" + bySize[s].n + ")</span></div>";
    }).join("") : "<div class='chart-empty'>No games yet.</div>";
    // 3) problems solved by category
    host = $("#chartProblems");
    var cats = GT.problems.categories.filter(function (c) { return c.id !== "all"; });
    host.innerHTML = cats.map(function (c) {
      var list = GT.problems.filter(c.id, 0);
      var solved = list.filter(function (x) { return p.problemsDone[x.id]; }).length;
      var pct = list.length ? Math.round(solved / list.length * 100) : 0;
      return "<div class='bar-row'><span class='bar-lbl'>" + c.label + "</span>" +
        "<span class='bar'><span class='bar-fill' style='width:" + pct + "%'></span></span>" +
        "<span class='bar-val'>" + solved + "/" + list.length + "</span></div>";
    }).join("");
  }
})(window.GT = window.GT || {});