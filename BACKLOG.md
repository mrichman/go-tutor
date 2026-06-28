# Go Tutor — Feature Backlog

Canonical, prioritized list of proposed work. Effort is rough (Low / Medium / High).
Move items to **Shipped** as they land. Keep newest shipped items at the top of that list.

---

## Shipped

- Saved variation lines — name/replay/delete saved lines; persisted via SGF `(...)` branches + a lossless `GL[]` blob
- Multiple profiles — per-learner rank/history/progress with a top-bar switcher; legacy data migrated to "Default"
- Accessibility — keyboard board cursor (arrows + Enter), `aria-live` move/capture/result announcements, focus rings
- Opening (fuseki) principle trainer — corners-first, 3rd/4th line, approach, block 3-3, base extension; geometry-validated drills with "Show answers"
- PWA — manifest + SVG icon + service worker (network-first HTML, cache-first assets); installable, offline after first visit
- Influence overlay refinement — graded heatmap (size+opacity by ownership), Heatmap/Dots toggle, fuller win-rate/score readout
- Progress charts — rank-over-time line, win-rate by board size, problems solved by category (inline SVG/bars)
- Variations in review — branch from any reviewed/loaded position, auto-alternating, undo/exit (ephemeral, not saved to SGF)
- Live score estimate — offline area/territory readout toggle (`scoreArea` + `territoryMap`)
- Daily problem — deterministic date-seeded "Problem of the day"
- Import SGF collection — multi-file picker + clickable study library
- Volume slider + distinct sounds (pass / illegal / game-over) routed through a master gain
- Ask-the-coach — free-form question answered from the current position (live Claude or offline tip)
- Annotated SGF export — review key moments written as `C[]` comments + root summary
- Spaced repetition (SM-2-lite) for tsumego; per-move KataGo win-rate review; 11 tutorial lessons
- KataGo opponent via local GTP proxy + influence overlay (MCTS removed — benchmarked weaker)
- ~700 engine-verified tsumego; ladders (multi-move); category/difficulty filtering
- Post-game analysis (key moments); SGF save/load; move history & review
- Dead-stone removal & area scoring; board zoom; themes; keyboard shortcuts; stats; move-speed

---

## Tier 2 — next up, solid value

1. **Joseki dictionary** — a branching library of standard corner sequences with guided play
   (auto-opponent + expected move per step). The Opening tab currently teaches *principles* only.
   Needs a trustworthy joseki data source (hand-authoring coordinates is error-prone). _Medium._
2. **Full game-tree model** — replace the flat history with a node tree so variations can nest
   arbitrarily and edit in place (the current saved lines branch only off the main line). _Medium–High._

## Tier 3 — deferred / blocked

3. **Net (geta) puzzles** — currently **deferred**. The capture solver chases on liberties (great for
   ladders) so it can't *find* a net move, but it *can verify a given* net move: play the net move,
   then run the solver — if the trapped stone is force-captured against best resistance, the net is
   proven. Revisit with that approach + confined-geometry generation. _Medium._

## Tier 4 — out of scope for now

4. **Online / multiplayer** — requires a backend; breaks the static, offline-first model. _High, architectural._

---

## Recommendation

Next: **#1 joseki dictionary** is the highest-value remaining study feature (pending a reliable
joseki source); **#2 full game-tree model** is the deeper refactor that would let variations nest and
make a true SGF-tree editor.
