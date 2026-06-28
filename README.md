# Go Tutor — learn Baduk

A single-player app to teach you Go (Baduk) from absolute beginner up toward 2 dan.
It adapts the opponent's strength to your progress, includes a hands-on tutorial,
and tracks an estimated rank that climbs as you improve.

- **Plays offline, zero install.** Pure HTML/JS/CSS — just open `index.html`.
- **Installable PWA.** Served over http(s) it registers a service worker and caches the app shell,
  so it installs to your home screen / dock and runs fully offline after the first visit.
- **Built-in opponent** that always makes legal moves and scales in strength.
- **Adaptive difficulty + handicap** based on your running rank estimate.
- **Interactive tutorial**: liberties, atari, capturing, escaping, ko, eyes/life, territory.
- **Progress tracking** from ~18 kyu up to **2 dan**, saved in your browser.
- **Optional Claude (Opus) coaching** via a tiny local proxy — explanations and game reviews.

---

## Quick start (no setup)

Open the app directly:

```
open index.html        # macOS
```

Or serve it (recommended so `localStorage` and the coach proxy work cleanly in all browsers):

```
cd go-tutor
python3 -m http.server 5173
# then visit http://localhost:5173
```

That's it. The opponent, tutorial, ranking, and offline coaching tips all work with no further setup.

---

## How it works

| Part | File | What it does |
|------|------|--------------|
| Rules | `js/engine.js` | Liberties, captures, suicide, ko + positional superko, area scoring, pass/resign |
| Opponent | `js/bot.js` | Heuristic engine, one `strength` knob (0–1), always legal moves |
| Strong engine | `server/katago-server.js` | Optional local proxy to play against KataGo (GTP); app falls back to the heuristic when it's not running |
| Ranking | `js/ranking.js` | Elo-style skill estimate (18k → 2d), adaptive opponent + handicap selection |
| Tutorial | `js/tutorial.js` | Scripted, validated lessons on small boards |
| Problems | `js/problems.js` | Tsumego: curated fundamentals + the generated set, with filters |
| Generator | `js/generator.js` | Seeded, engine-verified problem generator (700+ puzzles) |
| Solver | `js/solver.js` | Depth-limited capture solver (ladders + multi-move validation) |
| SGF | `js/sgf.js` | Read/write standard SGF game records |
| Coach | `js/coach.js` | Talks to the local Claude proxy; falls back to offline tips |
| Board UI | `js/board.js` | SVG goban, hover ghost stone, last-move + hint markers |
| App | `js/app.js` | Glues it all together |

### About the opponent and "Claude as opponent"

Important and honest: **LLMs (including Claude) play Go poorly** — they make illegal
moves, miss captures, and can't reliably read life-and-death. So in this app the
**built-in engine makes the moves** (guaranteed legal, adjustable strength, instant,
offline) and **Claude is the coach** — it explains what's happening and reviews your
games in plain language. That split gives you both solid gameplay and great teaching.

The built-in engine is intentionally lightweight. It teaches fundamentals well and
provides a graded difficulty ladder, but it does **not** truly play at dan level.
The ranking therefore tracks **your** estimated strength against *calibrated* difficulty
levels rather than claiming the bot is a literal 2-dan.

---

## Enabling live Claude coaching (optional)

The browser can't safely hold an API key, so a tiny **zero-dependency** Node proxy holds
it and forwards coaching requests to Claude.

```
export ANTHROPIC_API_KEY=sk-ant-...                 # your Anthropic key
# optional: pick the exact Opus model id on your account
export COACH_MODEL=claude-opus-4-20250514
node server/coach-server.js                         # http://localhost:8787
```

Reload the app. The coach badge flips from **"offline tips"** to **"Claude live"** and
move commentary / post-game reviews come from Claude. Stop the server anytime — the app
silently reverts to built-in tips.

> Set `COACH_MODEL` to whatever Opus model id your account exposes (e.g. the latest
> `claude-opus-4-*`). The default is a placeholder and may need updating.

---

## Stronger opponent: KataGo (optional)

By default the opponent is the built-in heuristic (offline, always legal, adjustable). For a
genuinely strong, teaching-grade opponent, run **KataGo** behind a tiny local GTP proxy. When the
proxy is up the in-app engine badge flips from **"built-in"** to **"KataGo"**; if it's not
running, the app silently falls back to the heuristic — so it's always playable.

### Easiest (Homebrew KataGo)

If you installed KataGo via Homebrew (binary + bundled models under
`/opt/homebrew/share/katago/`), just run **one command**:

```
just play      # starts the static app + KataGo proxy together
```

Then open <http://localhost:5179/index.html> and play — the badge shows "KataGo". The first move
warms up the model (a few seconds); after that, moves are sub-second on CPU. `Ctrl-C` stops both.
(Just the engine: `just katago`.)

### Manual / custom setup

```
# 1. Install KataGo + a model + a GTP config (see KataGo's docs / releases)
export KATAGO_PATH=katago
export KATAGO_MODEL=/path/to/model.bin.gz
export KATAGO_CONFIG=/path/to/gtp.cfg            # KataGo ships gtp_example.cfg
# optional: human-like, rank-matched play (downloads the human model)
export KATAGO_HUMAN_MODEL=/path/to/b18c384nbt-humanv0.bin.gz

# 2. Start the proxy
node server/katago-server.js                     # http://localhost:8788
```

Reload the app and play — moves now come from KataGo. Difficulty maps to KataGo's search:
the app sends `maxVisits` per move (low = weak, high = strong), and when a human model is
configured it sets the `humanSLProfile` from your current rank (e.g. `rank_8k`) so the
opponent plays at roughly your level.

When the proxy is running, a **Show influence (KataGo)** button appears in the Game panel: it
overlays KataGo's estimated **territory** (per-point ownership dots) and shows a **win-rate +
score** readout for the current position, refreshing as you play. This is a fast raw-NN estimate
(`kata-raw-nn`), so the win-rate and score are quick approximations, not a deep search.
A **Heatmap / Dots** toggle switches the overlay between a graded heatmap (dot size + opacity scale
with how strongly each point is owned) and crisp binary territory dots; the readout shows your
win-%, both sides' win-%, and the score lead.

### Human-like play (rank-matched)

KataGo throttled by visits still plays "inhumanly". For natural, rank-matched games, download
KataGo's **human model** (e.g. `b18c384nbt-humanv0.bin.gz`) and run:

```
export KATAGO_HUMAN_MODEL=/path/to/b18c384nbt-humanv0.bin.gz
just play-human
```

The proxy then sets `humanSLProfile` from your current estimated rank (e.g. `rank_8k`, `rank_2d`),
so the opponent plays roughly at your level. (The human model is a separate download, not part of
the Homebrew install.)

**Tip — KataGo recommendations:** use the **CPU/Eigen** build with a smaller (e.g. ~15-block)
network if you don't have a GPU; add the **human model** for the most natural beginner-friendly
games.

### Testing the proxy without KataGo

A mock GTP engine is included so you can verify the proxy/app wiring with no install:

```
KATAGO_PATH="node" KATAGO_ARGS="server/mock-gtp.js" node server/katago-server.js
```

The mock returns random legal moves — it proves the pipeline works (the badge shows "KataGo"),
but it does **not** play well. Use a real KataGo for actual strength.

---

## Using the app

**Play tab**
- Choose board size (9×9 is best for learning; 19×19 for real games / accurate ranking).
- Difficulty **Adaptive** picks an opponent slightly above your level and grants handicap
  stones when there's a big gap. Or pick a fixed difficulty.
- Buttons: **Pass**, **Resign**, **Hint** (conceptual coaching + a highlighted capture/atari
  if one exists), **Undo** (rewinds a turn for practice; that game won't count toward rank).
- **Zoom** the board with the −/+ buttons, the slider, or **Fit** (auto-size to the window).
  Useful on 19×19. Your zoom level is remembered; the board scrolls when larger than the view.
- **Move history**: every move is listed with its coordinate. Click any move, or use ⏮ ◀ ▶,
  to review that position (read-only); press **Live** to jump back to the current position and
  keep playing. Review is non-branching — you can't play from the past.
- Two passes start the **scoring phase** instead of ending immediately: dead stones are
  auto-guessed and shown with a red ✕; click any stone/group to toggle it dead or alive while
  the score and territory dots update live. **Accept & finish** finalizes (and updates your
  rank); **Resume play** backs out if you and the engine disagree on life/death.
- Scoring is area-based (Chinese-style) with komi; dead stones are removed and counted as the
  surrounding color's territory.
- **Save SGF / Load SGF**: export the current game to a standard `.sgf` file, or load one to
  replay it. A loaded game opens in review mode (history controls work; the bot is off and it's
  unrated) — ideal for studying saved or downloaded games.
- **Import collection**: pick several `.sgf` files at once to build a clickable study library;
  each entry shows board size, move count and result. Click one to load it into review.
- **Analyze** (appears once a game ends or after loading an SGF): lists the biggest mistakes as
  clickable **key moments** that jump to that position, and feeds them to the coach.
  - **With the KataGo proxy running**, this is an *engine-grade* review: it computes your
    **win-rate after every move** and flags the moves where it dropped most (the real mistakes).
  - **Without KataGo**, it falls back to a *material* swing scan (captures / stones lost), which
    surfaces tactical blunders but not subtle positional loss.
- **Export SGF + notes** (appears after Analyze): saves the game as an SGF with the review's key
  moments attached as `C[]` move comments, plus a summary on the root node — readable in any SGF
  viewer.
- **Ask the coach**: type a free-form question in the coach panel and press Enter (or **Ask**) to
  get an answer grounded in the current position. Uses live Claude when the proxy is running;
  otherwise an offline position-aware tip.
- **Explore variations**: while reviewing (or in a loaded game), click the board to branch into a
  hypothetical line. Stones auto-alternate colour; **↶ Undo** takes back a variation move and
  **Return to game** discards it.
- **Save lines**: in a variation, press **Save line** to keep it as a named line (rename/delete in
  the **Saved lines** panel; click one to replay it). Saved lines are written into **SGF** — exported
  as standard `(...)` branches for other viewers, plus a lossless blob so they re-import exactly here.
- **Estimate score**: a rough *offline* area/territory readout for the current position (the
  KataGo influence overlay is the accurate version when the proxy runs). Best once boundaries
  settle — early on it just counts stones + komi.

**Tutorial tab**
- Eleven bite-size lessons (board basics → liberties, capture, atari, ko, eyes, territory,
  ladders, nets, cutting/connecting, endgame & counting). "Info" steps explain; "task" steps ask
  you to make a specific move that's validated live. Completed lessons get a ✓.

**Opening tab**
- Hands-on **opening (fuseki) principle drills**: corners first, the 3rd/4th lines, approaching a
  lone stone, blocking the 3-3 invasion, and extending to make a base. Each drill accepts *any*
  move that satisfies the principle (geometry-checked, so feedback is always correct), with a
  **Show answers** button that highlights every valid point. Completed drills get a ✓.
- Note: these teach principles, not a hand-authored joseki dictionary — a full branching joseki
  library is tracked in `BACKLOG.md`.

**Problems tab**
- **600+ tsumego (life-and-death) puzzles**, almost all procedurally generated and **verified by
  the rules engine** (each solution is simulated — a capture problem is only kept if the move
  actually captures, a connect problem only if it actually links the groups). Categories: capture
  & atari, life & death (eye shapes), connect & cut, endgame, plus hand-made fundamentals.
- Filter by **category** and **difficulty (★/★★/★★★)**, grab the **★ Problem of the day** (a
  deterministic date-seeded pick — the same for everyone, changes daily), jump to a **Random
  unsolved** problem, step through with **Next**, or hit **Review due** for **spaced repetition** —
  solved problems are scheduled (SM-2-style) and resurface over time, with ones you missed coming
  back sooner.
  Wrong moves are rejected with a hint; the correct move shows an explanation and marks it solved
  (tracked per problem; the set is deterministic so your progress stays stable across reloads).
- Honest caveat: capture/connect/endgame/ladder solutions are *proven* by simulation (ladders
  via a depth-limited capture solver). Life-and-death problems use the **textbook vital points**
  of standard eye shapes (straight-three, bent-three, pyramid-four); legality is engine-checked,
  but full life/death isn't solver-proven. **Nets (geta) are not yet included** — they need a
  wider solver than the current ladder solver to verify reliably.
- **Ladders** are multi-move: the opponent's resistance is auto-played and any move that keeps the
  capture forced is accepted, so the whole sequence reads out. Solved when the group is captured.

**Progress tab**
- A ladder from 18k to 2d showing your current estimate, win/loss stats, recent games,
  and lesson completion. **Charts**: rank over time, win rate by board size, and problems solved
  by category. **Reset** wipes everything.

**Settings & shortcuts**
- Top bar: **sound** toggle, a **volume slider** (persisted), and **board theme** (Classic / Dark /
  High-contrast), all persisted.
- **Multiple profiles**: a profile selector in the top bar (with **＋** new / **🗑** delete) keeps
  separate rank, history, and progress per learner on one device. Your existing data migrates to a
  **Default** profile automatically.
- New-game panel: **Move speed** (Normal / Fast / Instant) controls the opponent's reply delay.
- **Accessibility**: the board is keyboard-operable — **Tab** to focus it, **arrow keys** move a
  cursor, **Enter/Space** plays. Moves, captures, passes, illegal attempts, and game-end are
  announced via an `aria-live` region for screen readers; controls show visible focus rings.
- Keyboard: **←/→** step through move history (Play), **p** passes, **n** next problem and **r**
  reset problem (Problems). **Ctrl/⌘ + scroll** zooms the play board.
- Stone placement/captures play a **pre-rendered stone-click sample** (embedded as a base64 WAV
  data-URI in `js/sound-data.js`, generated by `scripts/gen-click.js`; swap that constant for your
  own recording to change it). Captured stones flash; reviewing shows move numbers. Passes, illegal
  clicks, and game-over each play a distinct synthesized tone; the volume slider scales everything.
---

## Ranking model (brief)

Internal skill is a continuous value `0..19`: `0 = 18k … 17 = 1k … 18 = 1d … 19 = 2d`.
After each rated game, skill updates with an Elo-style step based on result, score margin,
handicap, and how many games you've played (faster early calibration). The opponent for the
next game is chosen just above your current skill to stay challenging but winnable.

Ranks are **estimates for learning/motivation**, not official certifications.

---

## Notes & limits

- Dead-stone removal at game end is **interactive**: the app auto-guesses dead groups and you
  confirm/adjust them in the scoring phase. The auto-guess is a heuristic (it flags small groups
  sitting inside enemy territory) — it can miss or over-flag, so always glance at the marks
  before accepting. Final scoring is correct for whatever dead set you confirm.
- Progress is stored in `localStorage` for the origin you load from. Loading via `file://`
  vs `http://localhost` are different origins, so use one consistently to keep your history.
