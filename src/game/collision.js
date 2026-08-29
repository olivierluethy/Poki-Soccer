/**
 * collision.js
 * Generic swept-collision queries. Works on a plain collider set
 * ({ segments, circles }) so it is independent of the board object and can be
 * reused for both the flicked player and the ball.
 */
(function (PS) {
  "use strict";
  const { V, sweptCircleSegment, movingCirclePoint } = PS.geom;

  /**
   * Earliest collision of a moving circle (center `pos`, radius `r`, unit `dir`,
   * up to `maxT`) against segments[] and circles[].
   * @param {{a,b,kind}[]} segments
   * @param {{center,radius,kind,bounce,ref}[]} circles
   * @returns {null | { t, contactPos, normal, kind, ref?, bounce? }}
   */
  function earliest(pos, dir, r, maxT, segments, circles) {
    let best = null;
    const take = (t, point, normal, kind, extra) => {
      if (t <= maxT + PS.geom.EPS && (!best || t < best.t)) {
        best = { t, contactPos: point, normal, kind, ...extra };
      }
    };
    for (const s of segments || []) {
      const hit = sweptCircleSegment(pos, dir, r, maxT, s.a, s.b);
      if (hit) take(hit.t, hit.point, hit.normal, s.kind === "wall" ? "wall" : "boundary");
    }
    for (const c of circles || []) {
      const hit = movingCirclePoint(pos, dir, r + c.radius, maxT, c.center);
      if (hit) {
        const normal = V.normalize(V.sub(hit.point, c.center));
        take(hit.t, hit.point, normal, c.kind || "circle", { ref: c.ref, bounce: c.bounce, collider: c });
      }
    }
    return best;
  }

  /** Continuous test: does the swept circle reach/contact a specific target circle? */
  function contactWithCircle(pos, dir, r, maxT, target) {
    const hit = movingCirclePoint(pos, dir, r + target.radius, maxT, target.center);
    if (!hit) return null;
    const normal = V.normalize(V.sub(target.center, hit.point)); // from mover toward target
    return { t: hit.t, contactPos: hit.point, normal };
  }

  /** Goal capture zone for a single goal object. */
  function goalContains(goal, point) {
    if (!goal) return false;
    const depth = goal.depth || 0.06;
    const a = goal.segment.a, b = goal.segment.b;
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    if (point.y < minY - 1e-3 || point.y > maxY + 1e-3) return false;
    return goal.side === "left" ? point.x <= depth : point.x >= 1 - depth;
  }

  PS.collision = { earliest, contactWithCircle, goalContains };
})(window.PokiSoccer = window.PokiSoccer || {});
