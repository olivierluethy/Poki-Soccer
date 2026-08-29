/**
 * geometry.js
 * Pure 2D vector + geometric primitives used across the analyzer.
 * All solver math operates in NORMALIZED board coordinates (0..1 on each axis)
 * so the physics/solver are independent of screen resolution.
 *
 * Registers onto the shared content-script namespace `window.PokiSoccer.geom`.
 * (Content scripts loaded via manifest share one isolated-world scope; we use an
 *  explicit namespace object to keep cross-file references robust and modular.)
 */
(function (PS) {
  "use strict";

  const EPS = 1e-9;

  const V = {
    make: (x, y) => ({ x, y }),
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, s) => ({ x: a.x * s, y: a.y * s }),
    dot: (a, b) => a.x * b.x + a.y * b.y,
    // 2D cross product (scalar z-component)
    cross: (a, b) => a.x * b.y - a.y * b.x,
    len: (a) => Math.hypot(a.x, a.y),
    lenSq: (a) => a.x * a.x + a.y * a.y,
    dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
    distSq: (a, b) => {
      const dx = a.x - b.x, dy = a.y - b.y;
      return dx * dx + dy * dy;
    },
    normalize: (a) => {
      const l = Math.hypot(a.x, a.y);
      return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
    },
    // Left-hand normal of a direction vector
    perp: (a) => ({ x: -a.y, y: a.x }),
    negate: (a) => ({ x: -a.x, y: -a.y }),
    lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
    clone: (a) => ({ x: a.x, y: a.y }),
    angle: (a) => Math.atan2(a.y, a.x), // radians
    fromAngle: (rad, mag = 1) => ({ x: Math.cos(rad) * mag, y: Math.sin(rad) * mag }),
    rotate: (a, rad) => {
      const c = Math.cos(rad), s = Math.sin(rad);
      return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
    },
  };

  /** Reflect an incoming vector `v` about a unit normal `n`. */
  function reflect(v, n) {
    const d = 2 * V.dot(v, n);
    return { x: v.x - d * n.x, y: v.y - d * n.y };
  }

  /**
   * Closest point on segment [a,b] to point p, plus the parametric t in [0,1].
   */
  function closestPointOnSegment(p, a, b) {
    const ab = V.sub(b, a);
    const lenSq = V.lenSq(ab);
    if (lenSq < EPS) return { point: V.clone(a), t: 0 };
    let t = V.dot(V.sub(p, a), ab) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return { point: { x: a.x + ab.x * t, y: a.y + ab.y * t }, t };
  }

  function distPointToSegment(p, a, b) {
    return V.dist(p, closestPointOnSegment(p, a, b).point);
  }

  /**
   * Ray/segment intersection for a moving point (ray from `origin` along unit `dir`)
   * against segment [a,b]. Returns { t, point, u } where t is distance along ray
   * (>0), u is param on segment [0,1], or null if no forward hit.
   */
  function raySegment(origin, dir, a, b) {
    const seg = V.sub(b, a);
    const denom = V.cross(dir, seg);
    if (Math.abs(denom) < EPS) return null; // parallel
    const diff = V.sub(a, origin);
    const t = V.cross(diff, seg) / denom;
    const u = V.cross(diff, dir) / denom;
    if (t <= EPS || u < -EPS || u > 1 + EPS) return null;
    return { t, u, point: { x: origin.x + dir.x * t, y: origin.y + dir.y * t } };
  }

  /**
   * Continuous-collision: moving circle (center `origin`, radius `r`, direction
   * `dir`, travel length `maxT`) vs. a static segment [a,b]. Returns the first
   * contact { t, point (center at contact), normal } or null.
   * The circle's swept center stays at distance r from the segment at contact.
   */
  function sweptCircleSegment(origin, dir, r, maxT, a, b) {
    // Segment direction + outward normals (two candidate sides).
    const seg = V.sub(b, a);
    const segLen = V.len(seg);
    if (segLen < EPS) return null;
    const segDir = V.scale(seg, 1 / segLen);
    let normal = V.normalize(V.perp(segDir)); // one of the two normals

    // Ensure normal points toward the moving circle's side.
    if (V.dot(V.sub(origin, a), normal) < 0) normal = V.negate(normal);

    const denom = V.dot(dir, normal);
    // Offset the infinite line outward by r toward the circle side.
    const aOff = V.add(a, V.scale(normal, r));
    let tPlane;
    if (Math.abs(denom) < EPS) {
      tPlane = null; // moving parallel to the line
    } else {
      tPlane = V.dot(V.sub(aOff, origin), normal) / denom;
    }

    let best = null;

    if (tPlane !== null && tPlane > EPS && tPlane <= maxT + EPS) {
      // Contact point on the line; verify it projects within the segment span.
      const center = V.add(origin, V.scale(dir, tPlane));
      const proj = V.dot(V.sub(center, a), segDir);
      if (proj >= -EPS && proj <= segLen + EPS) {
        best = { t: tPlane, point: center, normal, contact: V.sub(center, V.scale(normal, r)) };
      }
    }

    // Endpoint (rounded corner) collisions: moving circle vs. point endpoints.
    for (const endpoint of [a, b]) {
      const hit = movingCirclePoint(origin, dir, r, maxT, endpoint);
      if (hit && (!best || hit.t < best.t)) {
        const n = V.normalize(V.sub(hit.point, endpoint));
        best = { t: hit.t, point: hit.point, normal: n, contact: V.clone(endpoint) };
      }
    }
    return best;
  }

  /** Moving circle vs. a single point. Solves |origin + dir*t - P| = r. */
  function movingCirclePoint(origin, dir, r, maxT, P) {
    const m = V.sub(origin, P);
    const bq = V.dot(m, dir);
    const cq = V.lenSq(m) - r * r;
    if (cq < 0) {
      // Already overlapping — treat as immediate contact.
      return { t: 0, point: V.clone(origin) };
    }
    const disc = bq * bq - cq;
    if (disc < 0) return null;
    const t = -bq - Math.sqrt(disc);
    if (t < -EPS || t > maxT + EPS) return null;
    return { t: Math.max(0, t), point: V.add(origin, V.scale(dir, Math.max(0, t))) };
  }

  /**
   * Reflect a point across an infinite line defined by segment [a,b].
   * Used for mirror-image (bank shot) target generation.
   */
  function mirrorPointAcrossLine(p, a, b) {
    const seg = V.sub(b, a);
    const lenSq = V.lenSq(seg);
    if (lenSq < EPS) return V.clone(p);
    const t = V.dot(V.sub(p, a), seg) / lenSq;
    const foot = { x: a.x + seg.x * t, y: a.y + seg.y * t };
    return { x: 2 * foot.x - p.x, y: 2 * foot.y - p.y };
  }

  function radToDeg(rad) { return (rad * 180) / Math.PI; }
  function degToRad(deg) { return (deg * Math.PI) / 180; }

  /** Normalize an angle in degrees to [0, 360). */
  function normDeg(deg) { return ((deg % 360) + 360) % 360; }

  /** Point-in-polygon (ray casting). poly = array of {x,y}. */
  function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const pi = poly[i], pj = poly[j];
      const intersect =
        pi.y > p.y !== pj.y > p.y &&
        p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  PS.geom = {
    EPS,
    V,
    reflect,
    closestPointOnSegment,
    distPointToSegment,
    raySegment,
    sweptCircleSegment,
    movingCirclePoint,
    mirrorPointAcrossLine,
    radToDeg,
    degToRad,
    normDeg,
    pointInPolygon,
  };
})(window.PokiSoccer = window.PokiSoccer || {});
