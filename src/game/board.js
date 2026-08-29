/**
 * board.js
 * Internal representation of the Soccer 5 scene, built entirely from the user's
 * visual annotations (this is a Unity/canvas game — there are NO DOM objects for
 * ball/players/goals). Everything is stored in NORMALIZED field coordinates
 * (0..1 on each axis) derived from the selected field rectangle.
 *
 *  GameBoard
 *  ├── field rectangle  → coordinate system (screen <-> normalized)
 *  ├── ball             { center, radius }
 *  ├── players[]        { id, center, radius, team:'mine'|'opp' }
 *  ├── goals            { left, right } each { center,width,orientation,segment,depth }
 *  ├── target           'left' | 'right'  (which goal we're shooting at)
 *  └── walls[]/obstacles[]  OPTIONAL advanced geometry (not part of core flow)
 *
 * The field boundary and goal boundaries are DERIVED, not hand-drawn. Players are
 * physical circular colliders, not decorations.
 */
(function (PS) {
  "use strict";
  const { V } = PS.geom;

  let _pid = 1;

  class GameBoard {
    constructor(screenRect) {
      this.screenRect = screenRect || { x: 0, y: 0, width: 1, height: 1 };

      this.ball = null;                 // { center, radius, confidence }
      this.players = [];                // [{ id, center, radius, team, confidence }]
      this.goals = { left: null, right: null };
      this.target = null;               // 'left' | 'right'

      // Optional advanced geometry (kept for edge cases; never required).
      this.walls = [];
      this.obstacles = [];

      this.reflectiveBoundary = true;
      this.defaultPlayerRadius = 0.03;
    }

    // ---- Coordinate conversions -------------------------------------------
    toNorm(p) {
      return {
        x: (p.x - this.screenRect.x) / this.screenRect.width,
        y: (p.y - this.screenRect.y) / this.screenRect.height,
      };
    }
    toScreen(p) {
      return {
        x: this.screenRect.x + p.x * this.screenRect.width,
        y: this.screenRect.y + p.y * this.screenRect.height,
      };
    }
    lenToScreen(n) { return n * (this.screenRect.width + this.screenRect.height) / 2; }
    lenToNorm(s) { return s / ((this.screenRect.width + this.screenRect.height) / 2); }

    // ---- Elements ----------------------------------------------------------
    setBall(center, radius, confidence = "manual") {
      this.ball = { center, radius: radius || 0.018, confidence };
    }
    addPlayer(center, team, radius, confidence = "manual") {
      const p = { id: _pid++, center, team, radius: radius || this.defaultPlayerRadius, confidence };
      this.players.push(p);
      return p;
    }
    removePlayer(id) { this.players = this.players.filter((p) => p.id !== id); }
    playerById(id) { return this.players.find((p) => p.id === id); }
    myPlayers() { return this.players.filter((p) => p.team === "mine"); }
    oppPlayers() { return this.players.filter((p) => p.team === "opp"); }

    /**
     * Define a goal on a given side ('left' or 'right') from a mouth-span. The
     * center's cross-axis position sets where the mouth sits along that edge.
     */
    setGoalSide(side, centerNorm, widthNorm, confidence = "manual") {
      const half = Math.max(0.03, widthNorm / 2);
      const x = side === "left" ? 0 : 1;
      const seg = { a: { x, y: centerNorm.y - half }, b: { x, y: centerNorm.y + half } };
      this.goals[side] = {
        side,
        center: { x, y: centerNorm.y },
        width: half * 2,
        orientation: side,
        segment: seg,
        depth: 0.06,
        confidence,
      };
      if (!this.target) this.target = side;
    }
    setTarget(side) { if (this.goals[side]) this.target = side; }
    targetGoal() { return this.target ? this.goals[this.target] : null; }

    // ---- Derived collision geometry ---------------------------------------
    boundarySegments() {
      const c = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
      const segs = [];
      for (let i = 0; i < 4; i++) {
        segs.push({ a: c[i], b: c[(i + 1) % 4], kind: "boundary", index: i });
      }
      return segs;
    }

    /** Reflective segments = outer boundary (both goal mouths carved open) + walls. */
    collisionSegments() {
      let segs = this.boundarySegments();
      for (const side of ["left", "right"]) {
        if (this.goals[side]) segs = this._carveGoal(segs, this.goals[side]);
      }
      for (const w of this.walls) segs.push({ a: w.a, b: w.b, kind: "wall", thickness: w.thickness || 0 });
      return segs;
    }

    _carveGoal(segs, goal) {
      const edgeIndex = goal.side === "left" ? 3 : 1; // left edge=3, right edge=1
      const out = [];
      const ay = Math.min(goal.segment.a.y, goal.segment.b.y);
      const by = Math.max(goal.segment.a.y, goal.segment.b.y);
      for (const s of segs) {
        if (s.kind === "boundary" && s.index === edgeIndex) {
          const x = s.a.x;
          out.push({ a: { x, y: 0 }, b: { x, y: ay }, kind: "boundary", index: s.index });
          out.push({ a: { x, y: by }, b: { x, y: 1 }, kind: "boundary", index: s.index });
        } else out.push(s);
      }
      return out.filter((p) => V.dist(p.a, p.b) > 1e-4);
    }

    /**
     * Static circular colliders (players act as bumpers). Optionally exclude the
     * shooter that is currently in motion.
     */
    staticColliders(excludeId) {
      const circles = [];
      for (const p of this.players) {
        if (p.id === excludeId) continue;
        circles.push({ center: p.center, radius: p.radius, kind: "player", team: p.team, ref: p, bounce: true });
      }
      for (const o of this.obstacles) {
        if (o.kind === "circle") circles.push({ center: o.center, radius: o.radius, kind: "obstacle", bounce: o.bounce !== false, ref: o });
      }
      return circles;
    }

    // ---- Optional advanced geometry ---------------------------------------
    addWall(a, b, thickness = 0.012) { this.walls.push({ a, b, thickness }); }
    clearWalls() { this.walls = []; }

    // ---- Readiness ---------------------------------------------------------
    isSolvable() {
      return !!(this.ball && this.myPlayers().length > 0 && this.targetGoal());
    }
    missingElements() {
      const m = [];
      if (!this.ball) m.push("ball");
      if (this.myPlayers().length === 0) m.push("your players");
      if (!this.targetGoal()) m.push("target goal");
      return m;
    }

    signature() {
      const r = (v) => (v == null ? "-" : v.toFixed(4));
      const p = (pt) => (pt ? `${r(pt.x)},${r(pt.y)}` : "-");
      let s = "";
      s += this.ball ? `B${p(this.ball.center)}:${r(this.ball.radius)}` : "B-";
      s += "P" + this.players.map((pl) => `${pl.team[0]}${p(pl.center)}:${r(pl.radius)}`).join(",");
      for (const side of ["left", "right"]) {
        const g = this.goals[side];
        s += side[0].toUpperCase() + (g ? `${p(g.segment.a)}${p(g.segment.b)}` : "-");
      }
      s += "T" + (this.target || "-");
      s += "W" + this.walls.map((w) => `${p(w.a)}${p(w.b)}`).join("|");
      return s;
    }
  }

  PS.GameBoard = GameBoard;
})(window.PokiSoccer = window.PokiSoccer || {});
