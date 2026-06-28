/* Ranking + adaptive difficulty.
 *
 * We model the player's strength on a continuous rank scale and convert it to a
 * kyu/dan label. Range covered: 18 kyu (beginner) up to 2 dan.
 *
 * Rank number convention (internal, monotonic "skill" value):
 *   18k -> 0, 17k -> 1, ... 1k -> 17, 1d -> 18, 2d -> 19.
 * So skill in [0..19]. Each step is one rank.
 *
 * After each rated game we update skill with an Elo-style adjustment based on
 * the result vs. the bot's calibrated rank, the score margin, and any handicap.
 * The bot's strength (0..1) for the NEXT game is chosen to sit slightly above
 * the player's current skill so the game stays challenging but winnable —
 * that's the adaptivity.
 */
(function (GT) {
  "use strict";

  var MIN_SKILL = 0;     // 18k
  var MAX_SKILL = 19;    // 2d
  var STORE_KEY = "gotutor.profile.v1";          // legacy / migration source
  var REG_KEY = "gotutor.profiles.v1";           // { active, names:[] }
  var activeName = null;                          // resolved on first load()

  function profileKey(name) { return STORE_KEY + "::" + encodeURIComponent(name); }

  function readJSON(key) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage may be unavailable */ }
  }

  // Build the registry on first run, migrating any legacy single profile to "Default".
  function ensureInit() {
    var reg = readJSON(REG_KEY);
    if (reg && reg.names && reg.names.length) { activeName = reg.active || reg.names[0]; return reg; }
    reg = { active: "Default", names: ["Default"] };
    var legacy = readJSON(STORE_KEY);
    if (legacy && !readJSON(profileKey("Default"))) writeJSON(profileKey("Default"), legacy);
    writeJSON(REG_KEY, reg);
    activeName = "Default";
    return reg;
  }


  function labelForSkill(skill) {
    var s = Math.max(MIN_SKILL, Math.min(MAX_SKILL, Math.round(skill)));
    // 0..17 => 18k..1k ; 18 => 1d ; 19 => 2d
    if (s <= 17) return (18 - s) + "k";
    return (s - 17) + "d";
  }

  function labelForSkillFine(skill) {
    // Whole-rank label + +/- hint.
    var base = labelForSkill(skill);
    var frac = skill - Math.round(skill);
    var hint = frac > 0.25 ? " (strong)" : frac < -0.25 ? " (weak)" : "";
    return base + hint;
  }

  /* Map a bot strength label to internal skill the bot "plays at".
   * strength 0..1 spans roughly 18k..2d. */
  function botSkillFromStrength(strength) {
    return MIN_SKILL + strength * (MAX_SKILL - MIN_SKILL);
  }
  function strengthFromBotSkill(skill) {
    return (skill - MIN_SKILL) / (MAX_SKILL - MIN_SKILL);
  }

  function defaultProfile() {
    return {
      skill: 2.0,            // start ~16k
      games: 0,
      wins: 0,
      losses: 0,
      streak: 0,             // signed: + win streak, - loss streak
      best: 2.0,
      history: [],           // [{when, size, won, margin, botSkill, handicap, skillAfter}]
      tutorialsDone: {},     // lessonId -> true
      problemsDone: {},      // problemId -> true
      openingsDone: {},      // opening-drill id -> true
      srs: {},               // problemId -> {due, interval(days), reps, ease} spaced-repetition
      lastSize: 19,
      boardZoom: null,       // play-board zoom percent (null = fit on first load)
      soundOn: true,         // sound effects
      soundVolume: 0.8,      // master volume 0..1
      theme: "classic",      // board/UI theme
      moveSpeed: "normal"    // bot move delay: instant | fast | normal
    };
  }

  function load() {
    var reg = ensureInit();
    var p = readJSON(profileKey(reg.active)) || readJSON(STORE_KEY) || defaultProfile();
    var d = defaultProfile();
    for (var k in d) if (!(k in p)) p[k] = d[k];
    return p;
  }

  function save(profile) {
    if (!activeName) ensureInit();
    writeJSON(profileKey(activeName), profile);
  }

  function reset() {
    var p = defaultProfile();
    save(p);
    return p;
  }

  /* ---- multiple profiles ---- */
  function listProfiles() { return ensureInit().names.slice(); }
  function getActiveName() { ensureInit(); return activeName; }

  function switchProfile(name) {
    var reg = ensureInit();
    if (reg.names.indexOf(name) < 0) return load();
    reg.active = name; activeName = name; writeJSON(REG_KEY, reg);
    return load();
  }

  // Create (and activate) a new profile. Returns the new profile.
  function createProfile(name) {
    name = String(name || "").trim();
    var reg = ensureInit();
    if (!name) return load();
    if (reg.names.indexOf(name) < 0) {
      reg.names.push(name);
      writeJSON(profileKey(name), defaultProfile());
    }
    reg.active = name; activeName = name; writeJSON(REG_KEY, reg);
    return load();
  }

  // Delete a profile (never the last one). Returns the resulting active profile.
  function deleteProfile(name) {
    var reg = ensureInit();
    if (reg.names.length <= 1 || reg.names.indexOf(name) < 0) return load();
    reg.names = reg.names.filter(function (n) { return n !== name; });
    try { localStorage.removeItem(profileKey(name)); } catch (e) {}
    if (reg.active === name) reg.active = reg.names[0];
    activeName = reg.active; writeJSON(REG_KEY, reg);
    return load();
  }

  /* Pick the bot's target skill + handicap for the next rated game.
   * Adaptive rule: aim a bit above the player so it stays challenging.
   * If the player is on a losing streak, ease off; on a win streak, push. */
  function recommendOpponent(profile) {
    var skill = profile.skill;
    var bump = 0.6;                       // default: bot ~0.6 ranks stronger
    if (profile.streak <= -2) bump = -0.4; // struggling -> easier
    else if (profile.streak >= 2) bump = 1.2; // crushing -> harder
    var botSkill = clamp(skill + bump, MIN_SKILL, MAX_SKILL);

    // Handicap stones: if the gap (player below bot) is large, give the player
    // handicap stones (player = Black). 1 stone ~ 1 rank on 19x19.
    var gap = botSkill - skill;
    var handicap = 0;
    if (gap >= 1.5) handicap = Math.min(9, Math.round(gap));
    return {
      botSkill: botSkill,
      strength: strengthFromBotSkill(botSkill),
      handicap: handicap,
      label: labelForSkill(botSkill)
    };
  }

  /* Expected score (0..1) for player vs bot given skill difference.
   * Logistic with ~1 rank = noticeable edge. */
  function expectedScore(playerSkill, botSkill) {
    var d = playerSkill - botSkill;
    return 1 / (1 + Math.pow(10, -d / 2.5));
  }

  /* Update skill after a rated game.
   * result: {won:bool, margin:number|null, botSkill, handicap, size, byResign}
   * Returns {skillBefore, skillAfter, delta, label}. */
  function recordGame(profile, result) {
    var before = profile.skill;
    // Effective bot skill is lowered by handicap the player received.
    var effBot = result.botSkill - (result.handicap || 0) * 0.8;
    var exp = expectedScore(before, effBot);
    var actual = result.won ? 1 : 0;

    // K-factor: larger when few games (faster calibration), smaller later.
    var K = profile.games < 8 ? 1.1 : profile.games < 20 ? 0.7 : 0.45;

    // Margin bonus: convincing wins/losses move you a touch more.
    var marginFactor = 1.0;
    if (result.margin != null) {
      var m = Math.min(40, Math.abs(result.margin));
      marginFactor = 0.8 + (m / 40) * 0.6; // 0.8..1.4
    } else if (result.byResign) {
      marginFactor = 1.2;
    }

    var delta = K * (actual - exp) * marginFactor;
    var after = clamp(before + delta, MIN_SKILL, MAX_SKILL);

    profile.skill = after;
    profile.games += 1;
    if (result.won) { profile.wins += 1; profile.streak = profile.streak >= 0 ? profile.streak + 1 : 1; }
    else { profile.losses += 1; profile.streak = profile.streak <= 0 ? profile.streak - 1 : -1; }
    profile.best = Math.max(profile.best, after);
    profile.lastSize = result.size || profile.lastSize;
    profile.history.push({
      when: Date.now(), size: result.size, won: result.won,
      margin: result.margin, botSkill: result.botSkill,
      handicap: result.handicap || 0, skillAfter: after
    });
    if (profile.history.length > 200) profile.history.shift();
    save(profile);

    return { skillBefore: before, skillAfter: after, delta: delta, label: labelForSkillFine(after) };
  }

  function progressPct(profile) {
    return clamp((profile.skill - MIN_SKILL) / (MAX_SKILL - MIN_SKILL) * 100, 0, 100);
  }

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  GT.ranking = {
    MIN_SKILL: MIN_SKILL, MAX_SKILL: MAX_SKILL,
    labelForSkill: labelForSkill,
    labelForSkillFine: labelForSkillFine,
    botSkillFromStrength: botSkillFromStrength,
    strengthFromBotSkill: strengthFromBotSkill,
    defaultProfile: defaultProfile,
    load: load, save: save, reset: reset,
    listProfiles: listProfiles, activeName: getActiveName,
    switchProfile: switchProfile, createProfile: createProfile, deleteProfile: deleteProfile,
    recommendOpponent: recommendOpponent,
    expectedScore: expectedScore,
    recordGame: recordGame,
    progressPct: progressPct
  };
})(window.GT = window.GT || {});
