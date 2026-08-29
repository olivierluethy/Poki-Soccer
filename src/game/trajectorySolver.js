/**
 * trajectorySolver.js
 * Searches for flick shots that put the ball in the TARGET goal, using the real
 * two-phase physics (player strikes ball → ball rolls to goal).
 *
 * For every one of the user's players it asks: "which drag makes THIS player hit
 * the ball so the ball reaches the goal?" Candidate ball directions come from
 * geometry (aim at the goal directly, and at the goal mirrored across each wall
 * for bank shots); from each ball direction we derive the required contact point
 * and therefore the player's launch/drag direction. Direction AND power are both
 * searched. Successful shots are scored for robustness and ranked by practical
 * difficulty — the easiest reliable shot first.
 */
(function (PS) {
  "use strict";
  const G = PS.geom;
  const V = PS.geom.V;

  const DEFAULT_SOLVER = Object.freeze({
    powerSamples: [0.45, 0.6, 0.75, 0.9, 1.0], // × maxVelocity
    fanCount: 30,             // per-shooter coarse fan safety net (every 12°)
    dirFan: [0, 4, -4],       // small spread around each geometric aim (deg)
    robustnessMaxDeg: 12,
    robustnessStepDeg: 1,
    maxSearchIterations: 12000,
    maxSolutions: 6,
    dedupAngleDeg: 7,
    minAlign: 0.3,            // dot(launchDir, ballDir) must exceed this
  });

  class TrajectorySolver {
    constructor(board, physics, options = {}) {
      this.board = board;
      this.physics = physics || PS.PhysicsConfig.defaults();
      this.opts = Object.assign({}, DEFAULT_SOLVER, options);
      this.searchPhysics = this.physics.clone({ dt: 1 / 120, maxSteps: 1500 });
      this._iters = 0;
    }

    solve() {
      const board = this.board;
      if (!board.isSolvable()) return { solutions: [], missing: board.missingElements() };
      this._iters = 0;

      const raw = [];
      for (const shooter of board.myPlayers()) {
        if (this._iters > this.opts.maxSearchIterations) break;
        this._searchShooter(shooter, raw);
      }
      const scored = raw.map((r) => this._scoreSolution(r)).filter(Boolean);
      const ranked = this._dedupeAndRank(scored);
      return { solutions: ranked.slice(0, this.opts.maxSolutions), missing: [] };
    }

    _searchShooter(shooter, out) {
      const board = this.board;
      const ball = board.ball.center;
      const Rb = board.ball.radius, Rp = shooter.radius;
      const combined = Rb + Rp;
      const target = board.targetGoal();

      // Ball-direction candidates: direct aim points + mirror-image bank targets.
      const ballDirs = new Set();
      const addDir = (vec) => {
        if (V.lenSq(vec) < 1e-9) return;
        ballDirs.add(Math.round(G.normDeg(G.radToDeg(V.angle(vec))) * 2) / 2);
      };
      const aimPts = [
        target.center, target.segment.a, target.segment.b,
        V.lerp(target.segment.a, target.center, 0.5), V.lerp(target.segment.b, target.center, 0.5),
      ];
      for (const p of aimPts) addDir(V.sub(p, ball));
      const segs = board.collisionSegments();
      const mirrors = [];
      for (const s of segs) {
        const m = G.mirrorPointAcrossLine(target.center, s.a, s.b);
        mirrors.push({ m, s });
        addDir(V.sub(m, ball));
      }
      for (const mt of mirrors) {           // limited 2-bank
        for (const s2 of segs) {
          if (s2 === mt.s) continue;
          const m2 = G.mirrorPointAcrossLine(mt.m, s2.a, s2.b);
          addDir(V.sub(m2, ball));
        }
      }

      // For each ball direction, derive the shooter's launch direction and search power.
      for (const ballDeg of ballDirs) {
        if (this._iters > this.opts.maxSearchIterations) return;
        const Dball = V.fromAngle(G.degToRad(ballDeg));
        const contact = V.sub(ball, V.scale(Dball, combined));
        if (contact.x < 0.015 || contact.x > 0.985 || contact.y < 0.015 || contact.y > 0.985) continue;
        const Dp = V.normalize(V.sub(contact, shooter.center));
        if (V.dot(Dp, Dball) < this.opts.minAlign) continue;
        const baseDeg = G.normDeg(G.radToDeg(V.angle(Dp)));
        for (const spread of this.opts.dirFan) {
          this._tryDirection(shooter, baseDeg + spread, ballDeg, out);
        }
      }

      // Coarse fan safety net (aim the shooter around the ball).
      const toBall = G.normDeg(G.radToDeg(V.angle(V.sub(ball, shooter.center))));
      for (let i = 0; i < this.opts.fanCount; i++) {
        if (this._iters > this.opts.maxSearchIterations) return;
        this._tryDirection(shooter, toBall - 60 + (120 * i) / this.opts.fanCount, null, out);
      }
    }

    _tryDirection(shooter, launchDeg, ballDeg, out) {
      let best = null;
      for (const frac of this.opts.powerSamples) {
        if (this._iters > this.opts.maxSearchIterations) break;
        const speed = frac * this.physics.maxVelocity;
        const sim = this._sim(shooter, launchDeg, speed);
        if (sim.outcome === "goal") {
          const nb = sim.bounces.length;
          if (!best || nb < best.nb || (nb === best.nb && frac < best.frac)) {
            best = { shooter, launchDeg: G.normDeg(launchDeg), speed, frac, sim, nb, ballDeg };
          }
        }
      }
      if (best) out.push(best);
    }

    _sim(shooter, launchDeg, speed, physics) {
      this._iters++;
      const vel = V.fromAngle(G.degToRad(launchDeg), speed);
      return PS.simulateShot(this.board, shooter, vel, physics || this.searchPhysics);
    }

    // ---- Robustness, difficulty, scoring ----------------------------------
    _scoreSolution(s) {
      const step = this.opts.robustnessStepDeg, maxP = this.opts.robustnessMaxDeg;
      let low = 0, high = 0;
      for (let d = step; d <= maxP; d += step) {
        const r = this._sim(s.shooter, s.launchDeg + d, s.speed);
        if (r.outcome === "goal" && r.bounces.length <= s.nb + 1) high = d; else break;
      }
      for (let d = step; d <= maxP; d += step) {
        const r = this._sim(s.shooter, s.launchDeg - d, s.speed);
        if (r.outcome === "goal" && r.bounces.length <= s.nb + 1) low = d; else break;
      }
      const windowWidth = low + high;
      const centerDeg = G.normDeg(s.launchDeg + (high - low) / 2);

      const finalSim = this._sim(s.shooter, centerDeg, s.speed, this.physics);
      const sim = finalSim.outcome === "goal" ? finalSim : s.sim;
      const bounces = sim.bounces.length;

      const power = s.speed / this.physics.maxVelocity;
      const pathLen = polyLength(sim.ballPath);
      const oppGap = minGapToOpponents(this.board, sim.ballPath);

      // Practical difficulty (higher = harder to execute reliably).
      let d = bounces * 2;
      d += power > 0.92 ? 1.5 : power < 0.35 ? 0.6 : 0;
      d += windowWidth < 3 ? 2 : windowWidth < 6 ? 1 : 0;
      d += oppGap < 0.02 ? 1.6 : oppGap < 0.05 ? 0.7 : 0;
      d += pathLen * 0.5;
      const label = d <= 1.3 ? "Easy" : d <= 3.2 ? "Medium" : "Hard";

      const confidence = this._confidence(windowWidth, bounces);
      const launchDeg = G.normDeg(centerDeg);
      return {
        shooterId: s.shooter.id,
        shooterCenter: s.shooter.center,
        launchDeg,
        pullDirectionDeg: G.normDeg(launchDeg + 180),
        launchSpeed: s.speed,
        pullDistanceNorm: s.speed / this.physics.shotPowerScale,
        power,
        ballDeg: s.ballDeg,
        bounces,
        window: { lowDeg: G.normDeg(centerDeg - low), highDeg: G.normDeg(centerDeg + high), widthDeg: windowWidth },
        difficulty: { score: d, label },
        confidence,
        rankScore: -d + windowWidth * 0.05,
        ballPath: sim.ballPath,
        shooterPath: sim.shooterPath,
        bouncePoints: sim.bounces,
        contact: sim.contact,
        goalPoint: sim.goalPoint,
        goalSide: this.board.target,
        outcome: sim.outcome,
      };
    }

    _confidence(windowWidth, bounces) {
      let level = windowWidth >= 6 && bounces <= 1 ? "high" : windowWidth >= 3 ? "medium" : "low";
      const objs = [this.board.ball, ...this.board.myPlayers(), this.board.targetGoal()];
      const confs = objs.map((o) => (o && o.confidence) || "low");
      if (confs.includes("low") && level === "high") level = "medium";
      return level;
    }

    _dedupeAndRank(scored) {
      const sorted = scored.slice().sort((a, b) => b.rankScore - a.rankScore);
      const kept = [];
      for (const s of sorted) {
        const dup = kept.find((k) => k.shooterId === s.shooterId && k.bounces === s.bounces && angDist(k.launchDeg, s.launchDeg) < this.opts.dedupAngleDeg);
        if (!dup) kept.push(s);
      }
      return kept;
    }

    /** Evaluate a single manual drag (for real-time aim guidance). */
    evaluateDrag(shooter, pullVecNorm) {
      const pullLen = V.len(pullVecNorm);
      if (pullLen < 1e-4) return { outcome: "short", ballPath: [], power: 0 };
      const launchDir = V.scale(pullVecNorm, -1 / pullLen);
      const speed = Math.min(pullLen * this.physics.shotPowerScale, this.physics.maxVelocity);
      const vel = V.scale(launchDir, speed);
      const sim = PS.simulateShot(this.board, shooter, vel, this.physics);
      return {
        outcome: sim.outcome,
        ballPath: sim.ballPath,
        shooterPath: sim.shooterPath,
        bounces: sim.bounces || [],
        goalPoint: sim.goalPoint,
        launchDeg: G.normDeg(G.radToDeg(V.angle(launchDir))),
        power: speed / this.physics.maxVelocity,
      };
    }
  }

  function angDist(a, b) { const d = Math.abs(G.normDeg(a) - G.normDeg(b)); return Math.min(d, 360 - d); }
  function polyLength(path) {
    if (!path || path.length < 2) return 0;
    let L = 0;
    for (let i = 1; i < path.length; i++) L += V.dist(path[i - 1], path[i]);
    return L;
  }
  function minGapToOpponents(board, path) {
    if (!path || !path.length) return 1;
    let min = Infinity;
    for (const p of board.oppPlayers()) {
      for (const pt of path) {
        const g = V.dist(pt, p.center) - p.radius - board.ball.radius;
        if (g < min) min = g;
      }
    }
    return isFinite(min) ? min : 1;
  }

  PS.TrajectorySolver = TrajectorySolver;
  PS.DEFAULT_SOLVER = DEFAULT_SOLVER;
})(window.PokiSoccer = window.PokiSoccer || {});
