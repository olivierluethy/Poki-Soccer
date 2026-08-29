# Soccer 5 Shot Analyzer (Chrome Extension)

A geometry + physics aim assistant for the Unity football game "Soccer 5". The
game is a **pure visual surface** (Unity/canvas — no DOM game objects), so you
quickly **annotate the scene** and the extension builds its own geometric model,
simulates the real flick physics (your player strikes the ball, which rebounds
off walls and other players), searches for shots that reach the goal, and shows
exactly **which player to move, in which direction, and how far to pull** — with
live guidance while you rehearse the drag. It never controls the game.

## Interaction model

The real mechanic is a slingshot flick: you drag one of *your* player pieces and
release; it slides, strikes the ball, and momentum carries the ball to the goal.
So the solver doesn't just say "aim 43°" — it says **"move THIS player, pull this
direction, this far, at this power."**

Fast workflow (a few seconds): **FIELD → GOALS → BALL → YOUR PLAYERS →
OPPONENTS → pick TARGET → SOLVE**. No manual wall marking is required — the field
boundary and goal openings are derived, and players are physical colliders.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Open the Soccer 5 game, click the extension icon, then **Open analyzer**.

## Use

1. **Open analyzer** – the overlay appears (it estimates the field from the game canvas).
2. **Field** – drag a rectangle around the pitch (becomes the 0..1 coordinate system).
3. **Goals** – drag across the left goal mouth, then the right (both are stored).
4. **Ball** – click the ball (drag to size it).
5. **Your players** / **Opponents** – click each piece; click one again to remove it.
6. **Target goal** – choose Left or Right.
7. **Solve** – ranked shots appear. Each says which player to move, the pull
   direction/distance, power %, bounces, and angular tolerance.
8. **🎯 Aim guide** – press your highlighted player and drag to rehearse: the
   overlay live-simulates your current drag, compares it to the recommendation
   (angle/power difference, "✓ Excellent alignment"), and you replicate that drag
   in the game. Red line = predicted ball path, orange dots = rebounds, green =
   goal entry.

**Auto-detect** (optional) locates the white ball and goal mouths to speed setup;
players are always marked by hand since team identity is yours to define.

## Architecture

Visual annotation → board model → physics → collision → solver → renderer →
real-time aim are kept separate. Content-script modules share one namespace,
`window.PokiSoccer`. The game is treated as pixels — **no DOM selectors** for
ball/players/goals/walls.

```
src/
├── game/
│   ├── geometry.js          # 2D vectors, swept-circle collision, mirror reflection
│   ├── board.js             # GameBoard: ball, players[], two goals, target, coord system
│   ├── physics.js           # PhysicsConfig (calibratable) + two-phase flick simulator
│   ├── collision.js         # generic swept collisions (segments+circles), goal capture
│   ├── boardDetector.js     # optional CV: ball + goal mouths (players stay manual)
│   └── trajectorySolver.js  # per-player direct+bank search over direction AND power
├── overlay/
│   ├── overlay.js           # AnalysisOverlay: annotation workflow, real-time aim, orchestration
│   ├── trajectoryRenderer.js# canvas rendering of scene + red trajectory + drag vectors
│   └── overlay.css
├── calibration/
│   └── physicsCalibration.js# persist/tune PhysicsConfig to match the real game
├── content/content.js       # entry: messaging, screenshot capture, field-region estimate
└── background/background.js  # service worker: captureVisibleTab + injection fallback
popup/                       # toolbar popup UI
```

### How the solver works

- **Two-phase physics** (`simulateShot`): the flicked player travels to the ball
  (may bank off a wall; rejected if another player blocks it), momentum transfers
  (elastic collision, configurable masses/restitution), then the ball is
  integrated to a result, bouncing off boundaries and player pieces.
- **Candidates**: for each of your players and each ball direction (aim at the
  goal directly, and at the goal **mirrored across each wall** for banks), the
  required contact point gives the player's drag direction. Both **direction and
  power** are searched.
- **Robustness & difficulty**: successful shots are probed for their angular
  success window; a real **difficulty** score (bounces, power, tolerance,
  proximity to opponents, path length) ranks the **easiest reliable shot first**.
- Everything runs in **normalized field coordinates** (resolution-independent).
- **Real-time aim** (`evaluateDrag`) uses the *same* physics as the solver, so the
  rehearsal guide and the recommendation always agree.

### Calibration

Physics constants (friction, restitution, ball radius, shooter power, …) live in
`PhysicsConfig` and are persisted via `chrome.storage`. `physicsCalibration.js`
can nudge them from observed shots, so the model can be tuned to the real game
without touching the solver.
```
