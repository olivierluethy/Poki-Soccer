/**
 * physics.js
 * Physics model (PhysicsConfig) + the flick simulator.
 *
 * The real game mechanic is a slingshot flick: the player drags one of THEIR
 * pieces and releases; that piece slides, strikes the ball, and momentum is
 * transferred to the ball, which then rolls (bouncing off boundaries and other
 * player pieces) until it stops or enters a goal.
 *
 * simulateShot() models both phases:
 *   Phase A — the flicked player travels to the ball (may bank off a wall; is
 *             rejected if another player blocks it first).
 *   Phase B — momentum transfer, then the ball is integrated to a result.
 *
 * All tunables live here so the model is calibratable (game physics ≠ ideal).
 */
(function (PS) {
  "use strict";
  const { V, reflect, raySegment } = PS.geom;

  const DEFAULT_PHYSICS = Object.freeze({
    friction: 0.5,            // exponential speed decay / second (ball & player)
    restitution: 0.85,        // wall/boundary bounce energy kept
    wallBounceFactor: 0.9,
    playerBounceFactor: 0.8,  // ball bouncing off a player piece
    ballMass: 0.5,
    playerMass: 1.0,
    ballSpeedGain: 1.0,       // extra scale on transferred ball speed (calibratable)
    ballRadius: 0.018,
    playerRadius: 0.03,
    shotPowerScale: 10.0,     // launch speed per unit of normalized pull distance
    maxVelocity: 3.0,
    minVelocity: 0.04,
    collisionTolerance: 0.0015,
    goalTolerance: 0.0,
    dt: 1 / 240,
    maxSteps: 4000,
    maxBounces: 4,            // ball reflections
    shooterMaxBounces: 1,     // how many walls the flicked player may bank off
  });

  class PhysicsConfig {
    constructor(overrides = {}) { Object.assign(this, DEFAULT_PHYSICS, overrides); }
    clone(overrides = {}) { return new PhysicsConfig(Object.assign({}, this, overrides)); }
    static defaults() { return new PhysicsConfig(); }
  }

  /**
   * Integrate a free ball to its outcome.
   * @returns {{outcome:'goal'|'out'|'stopped', path, bounces, goalPoint?}}
   */
  function integrateBall(board, startPos, startVel, cfg, excludeShooterId) {
    const r = (board.ball && board.ball.radius) || cfg.ballRadius;
    const segments = board.collisionSegments();
    const circles = board.staticColliders(excludeShooterId);
    const target = board.targetGoal();
    const otherGoal = board.goals[board.target === "left" ? "right" : "left"];

    let pos = V.clone(startPos), vel = V.clone(startVel);
    const path = [V.clone(pos)];
    const bounces = [];
    let bc = 0;

    for (let step = 0; step < cfg.maxSteps; step++) {
      let speed = V.len(vel);
      if (speed < cfg.minVelocity) return fin("stopped");
      let remaining = speed * cfg.dt;
      let dir = V.scale(vel, 1 / speed);
      let guard = 0;
      while (remaining > PS.geom.EPS && guard++ < 8) {
        // Goal / own-goal crossing.
        if (target) {
          const gh = raySegment(pos, dir, target.segment.a, target.segment.b);
          if (gh && gh.t <= remaining + PS.geom.EPS && gh.u >= -1e-3 && gh.u <= 1 + 1e-3) {
            path.push(V.clone(gh.point));
            return { outcome: "goal", path, bounces, goalPoint: gh.point };
          }
        }
        if (otherGoal) {
          const oh = raySegment(pos, dir, otherGoal.segment.a, otherGoal.segment.b);
          if (oh && oh.t <= remaining + PS.geom.EPS && oh.u >= -1e-3 && oh.u <= 1 + 1e-3) {
            path.push(V.clone(oh.point));
            return fin("out");
          }
        }
        const hit = PS.collision.earliest(pos, dir, r, remaining, segments, circles);
        if (!hit) { pos = V.add(pos, V.scale(dir, remaining)); remaining = 0; }
        else {
          const travel = Math.max(0, hit.t - cfg.collisionTolerance);
          pos = V.add(pos, V.scale(dir, travel));
          remaining -= travel;
          const factor = hit.kind === "player" || hit.kind === "obstacle" ? cfg.playerBounceFactor : cfg.wallBounceFactor;
          vel = V.scale(reflect(vel, hit.normal), cfg.restitution * factor);
          speed = V.len(vel);
          dir = speed > PS.geom.EPS ? V.scale(vel, 1 / speed) : dir;
          remaining = Math.min(remaining, speed * cfg.dt);
          bounces.push({ point: V.clone(pos), kind: hit.kind });
          path.push(V.clone(pos));
          if (++bc > cfg.maxBounces) return fin("stopped");
          pos = V.add(pos, V.scale(hit.normal, cfg.collisionTolerance));
        }
        if (pos.x < -0.06 || pos.x > 1.06 || pos.y < -0.06 || pos.y > 1.06) { path.push(V.clone(pos)); return fin("out"); }
      }
      vel = V.scale(vel, Math.exp(-cfg.friction * cfg.dt));
      path.push(V.clone(pos));
    }
    return fin("stopped");
    function fin(outcome) { return { outcome, path, bounces }; }
  }

  /**
   * Simulate a full flick shot.
   * @param {GameBoard} board
   * @param {object} shooter  a player object { id, center, radius }
   * @param {{x,y}} launchVel  the shooter's launch velocity (dir * speed)
   * @returns {{
   *   outcome:'goal'|'out'|'stopped'|'short'|'blocked',
   *   shooterPath, ballPath, bounces, contact?, ballVel?, goalPoint?
   * }}
   */
  function simulateShot(board, shooter, launchVel, cfg) {
    cfg = cfg || PhysicsConfig.defaults();
    const Rp = shooter.radius || cfg.playerRadius;
    const Rb = (board.ball && board.ball.radius) || cfg.ballRadius;
    const ballCircle = { center: board.ball.center, radius: Rb };
    const segments = board.collisionSegments();
    // Other players block the flicked shooter.
    const blockers = board.staticColliders(shooter.id).filter((c) => c.kind === "player" || c.bounce !== false);

    let pos = V.clone(shooter.center), vel = V.clone(launchVel);
    const shooterPath = [V.clone(pos)];
    let shooterBounces = 0;

    for (let step = 0; step < cfg.maxSteps; step++) {
      let speed = V.len(vel);
      if (speed < cfg.minVelocity) return { outcome: "short", shooterPath, ballPath: [] };
      let remaining = speed * cfg.dt;
      let dir = V.scale(vel, 1 / speed);

      const ballHit = PS.collision.contactWithCircle(pos, dir, Rp, remaining, ballCircle);
      const otherHit = PS.collision.earliest(pos, dir, Rp, remaining, segments, blockers);

      // Ball reached first (or nothing else in the way): transfer momentum.
      if (ballHit && (!otherHit || ballHit.t <= otherHit.t)) {
        pos = V.add(pos, V.scale(dir, ballHit.t));
        shooterPath.push(V.clone(pos));
        const n = V.normalize(V.sub(ballCircle.center, pos)); // line of centers
        const v1n = V.dot(vel, n);
        if (v1n <= 0) return { outcome: "short", shooterPath, ballPath: [] };
        const m1 = cfg.playerMass, m2 = cfg.ballMass, e = cfg.restitution;
        const v2n = ((1 + e) * m1 / (m1 + m2)) * v1n * cfg.ballSpeedGain;
        let ballVel = V.scale(n, Math.min(v2n, cfg.maxVelocity * 1.4));
        // Ball starts a hair off the shooter to avoid immediate re-contact.
        const ballStart = V.add(ballCircle.center, V.scale(n, cfg.collisionTolerance));
        const ballSim = integrateBall(board, ballStart, ballVel, cfg, shooter.id);
        return {
          outcome: ballSim.outcome,
          shooterPath,
          ballPath: ballSim.path,
          bounces: ballSim.bounces,
          contact: V.clone(ballCircle.center),
          ballVel,
          goalPoint: ballSim.goalPoint,
        };
      }

      if (otherHit) {
        // Hitting another player before the ball = messy/blocked; reject.
        if (otherHit.kind === "player" || otherHit.kind === "obstacle") {
          return { outcome: "blocked", shooterPath, ballPath: [] };
        }
        // Bank the shooter off a wall (limited).
        const travel = Math.max(0, otherHit.t - cfg.collisionTolerance);
        pos = V.add(pos, V.scale(dir, travel));
        vel = V.scale(reflect(vel, otherHit.normal), cfg.restitution * cfg.wallBounceFactor);
        pos = V.add(pos, V.scale(otherHit.normal, cfg.collisionTolerance));
        shooterPath.push(V.clone(pos));
        if (++shooterBounces > cfg.shooterMaxBounces) return { outcome: "blocked", shooterPath, ballPath: [] };
      } else {
        pos = V.add(pos, V.scale(dir, remaining));
        vel = V.scale(vel, Math.exp(-cfg.friction * cfg.dt));
      }
      if (pos.x < -0.06 || pos.x > 1.06 || pos.y < -0.06 || pos.y > 1.06) {
        return { outcome: "blocked", shooterPath, ballPath: [] };
      }
    }
    return { outcome: "short", shooterPath, ballPath: [] };
  }

  PS.PhysicsConfig = PhysicsConfig;
  PS.DEFAULT_PHYSICS = DEFAULT_PHYSICS;
  PS.simulateShot = simulateShot;
  PS.integrateBall = integrateBall;
})(window.PokiSoccer = window.PokiSoccer || {});
