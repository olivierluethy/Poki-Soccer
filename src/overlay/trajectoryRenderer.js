/**
 * trajectoryRenderer.js
 * Draws the annotated scene + solutions over the Unity game. Distinct visual
 * language per element; the recommended drag vector and predicted red ball path
 * are the headline visuals. During real-time aiming it also draws the user's
 * current drag vs. the recommendation.
 */
(function (PS) {
  "use strict";
  const { V } = PS.geom;

  const C = {
    field: "rgba(56,189,248,0.85)",
    goal: "#22c55e",
    goalTarget: "#22c55e",
    goalOther: "rgba(148,163,184,0.7)",
    ball: "#ffffff",
    ballStroke: "#0b1020",
    mine: "#3b82f6",
    opp: "#f59e0b",
    path: "#ef4444",        // predicted ball path = red
    pathAlt: "rgba(239,68,68,0.25)",
    bounce: "#fbbf24",
    goalHit: "#22c55e",
    pullRec: "#22d3ee",     // recommended drag (cyan)
    pullCur: "#ffffff",     // current drag (white)
    wall: "#f97316",
  };

  class TrajectoryRenderer {
    constructor(ctx) { this.ctx = ctx; }
    clear(w, h) { this.ctx.clearRect(0, 0, w, h); }

    render(board, st) {
      if (st.selectionRect) this._selRect(st.selectionRect);
      if (!board) return;
      this._field(board);
      this._goals(board);
      for (const w of board.walls) this._wall(board, w);
      if (st.previewGoal) this._goalSeg(board, st.previewGoal, true);

      // Alternative solution paths (faint).
      if (st.showAlternatives && st.solutions) {
        st.solutions.forEach((s, i) => { if (i !== st.selectedIndex) this._path(board, s.ballPath, C.pathAlt, 2, false); });
      }
      const sel = st.solutions && st.solutions[st.selectedIndex];

      // Live drag prediction (during aim) shown beneath markers.
      if (st.live && st.live.ballPath && st.live.ballPath.length > 1) {
        const col = st.live.outcome === "goal" ? "rgba(34,197,94,0.9)" : "rgba(255,255,255,0.7)";
        this._path(board, st.live.ballPath, col, 3, st.live.outcome === "goal");
      }

      if (sel) {
        this._path(board, sel.ballPath, C.path, 3.5, true);
        this._bounces(board, sel.bouncePoints);
        if (sel.goalPoint) this._goalHit(board, sel.goalPoint);
      }

      // Players + ball on top.
      for (const p of board.oppPlayers()) this._player(board, p, C.opp);
      for (const p of board.myPlayers()) this._player(board, p, C.mine, sel && sel.shooterId === p.id);
      if (board.ball) this._ball(board, board.ball);

      // Recommended + current drag vectors.
      if (sel) {
        const shooter = board.playerById(sel.shooterId);
        if (shooter) this._pull(board, shooter.center, sel.pullDirectionDeg, sel.pullDistanceNorm, C.pullRec, false);
      }
      if (st.live && st.live.shooterCenter) {
        this._pull(board, st.live.shooterCenter, st.live.pullDeg, st.live.pullDist, C.pullCur, true);
      }
    }

    _selRect(r) {
      const x = this.ctx; x.save();
      x.strokeStyle = C.field; x.lineWidth = 2; x.setLineDash([7, 5]);
      x.fillStyle = "rgba(56,189,248,0.08)"; x.fillRect(r.x, r.y, r.width, r.height);
      x.strokeRect(r.x, r.y, r.width, r.height); x.restore();
    }
    _field(board) {
      const x = this.ctx, r = board.screenRect; x.save();
      x.strokeStyle = C.field; x.lineWidth = 2; x.setLineDash([6, 4]);
      x.strokeRect(r.x, r.y, r.width, r.height);
      // centre line
      const t = board.toScreen({ x: 0.5, y: 0 }), b = board.toScreen({ x: 0.5, y: 1 });
      x.globalAlpha = 0.4; x.beginPath(); x.moveTo(t.x, t.y); x.lineTo(b.x, b.y); x.stroke();
      x.restore();
    }
    _goals(board) {
      for (const side of ["left", "right"]) {
        const g = board.goals[side];
        if (!g) continue;
        this._goalSeg(board, g, false, board.target === side);
      }
    }
    _goalSeg(board, g, preview, isTarget) {
      const x = this.ctx;
      const a = board.toScreen(g.segment.a), b = board.toScreen(g.segment.b);
      x.save();
      x.strokeStyle = preview ? "rgba(34,197,94,0.6)" : isTarget ? C.goalTarget : C.goalOther;
      x.lineWidth = isTarget ? 6 : 4; x.lineCap = "round";
      if (isTarget) { x.shadowColor = "rgba(34,197,94,0.7)"; x.shadowBlur = 12; }
      x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke();
      x.shadowBlur = 0;
      // net hatch inward
      const depth = board.lenToScreen(g.depth || 0.06) * (g.side === "left" ? 1 : -1);
      x.strokeStyle = isTarget ? "rgba(34,197,94,0.35)" : "rgba(148,163,184,0.3)"; x.lineWidth = 1;
      for (let i = 0; i <= 6; i++) {
        const p = V.lerp(a, b, i / 6);
        x.beginPath(); x.moveTo(p.x, p.y); x.lineTo(p.x + depth, p.y); x.stroke();
      }
      x.restore();
    }
    _wall(board, w) {
      const x = this.ctx, a = board.toScreen(w.a), b = board.toScreen(w.b); x.save();
      x.strokeStyle = C.wall; x.lineWidth = Math.max(3, board.lenToScreen(w.thickness || 0.012)); x.lineCap = "round";
      x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke(); x.restore();
    }
    _player(board, p, color, isShooter) {
      const x = this.ctx, c = board.toScreen(p.center), rad = Math.max(7, board.lenToScreen(p.radius)); x.save();
      x.beginPath(); x.arc(c.x, c.y, rad, 0, Math.PI * 2);
      x.fillStyle = color; x.globalAlpha = 0.28; x.fill(); x.globalAlpha = 1;
      x.lineWidth = isShooter ? 4 : 2.5; x.strokeStyle = color;
      if (isShooter) { x.shadowColor = color; x.shadowBlur = 12; }
      x.stroke(); x.shadowBlur = 0;
      if (isShooter) { // ring highlight
        x.beginPath(); x.arc(c.x, c.y, rad + 4, 0, Math.PI * 2); x.strokeStyle = "rgba(255,255,255,0.7)"; x.lineWidth = 1.5; x.stroke();
      }
      x.restore();
    }
    _ball(board, ball) {
      const x = this.ctx, c = board.toScreen(ball.center), rad = Math.max(5, board.lenToScreen(ball.radius)); x.save();
      x.beginPath(); x.arc(c.x, c.y, rad, 0, Math.PI * 2); x.fillStyle = C.ball; x.fill();
      x.lineWidth = 2; x.strokeStyle = C.ballStroke; x.stroke(); x.restore();
    }
    _path(board, path, color, width, glow) {
      if (!path || path.length < 2) return;
      const x = this.ctx; x.save();
      x.strokeStyle = color; x.lineWidth = width; x.lineJoin = "round"; x.lineCap = "round";
      if (glow) { x.shadowColor = color; x.shadowBlur = 8; }
      x.beginPath(); const p0 = board.toScreen(path[0]); x.moveTo(p0.x, p0.y);
      for (let i = 1; i < path.length; i++) { const p = board.toScreen(path[i]); x.lineTo(p.x, p.y); }
      x.stroke();
      if (glow) { const e = board.toScreen(path[path.length - 1]), q = board.toScreen(path[path.length - 2]); this._arrow(q, e, color, width * 2.4); }
      x.restore();
    }
    _bounces(board, bs) {
      if (!bs) return; const x = this.ctx; x.save();
      for (const bp of bs) { const p = board.toScreen(bp.point); x.beginPath(); x.fillStyle = C.bounce; x.arc(p.x, p.y, 5, 0, Math.PI * 2); x.fill(); x.strokeStyle = "#fff"; x.lineWidth = 1.5; x.stroke(); }
      x.restore();
    }
    _goalHit(board, pt) {
      const x = this.ctx, p = board.toScreen(pt); x.save();
      x.beginPath(); x.fillStyle = C.goalHit; x.arc(p.x, p.y, 7, 0, Math.PI * 2); x.fill(); x.strokeStyle = "#fff"; x.lineWidth = 2; x.stroke(); x.restore();
    }
    _pull(board, centerNorm, pullDeg, pullDistNorm, color, dashed) {
      const x = this.ctx, o = board.toScreen(centerNorm);
      const rad = PS.geom.degToRad(pullDeg), len = Math.max(12, board.lenToScreen(pullDistNorm));
      const tip = { x: o.x + Math.cos(rad) * len, y: o.y + Math.sin(rad) * len }; x.save();
      x.strokeStyle = color; x.lineWidth = 4; x.lineCap = "round";
      if (dashed) x.setLineDash([2, 6]); else { x.shadowColor = color; x.shadowBlur = 8; }
      x.beginPath(); x.moveTo(o.x, o.y); x.lineTo(tip.x, tip.y); x.stroke(); x.setLineDash([]); x.shadowBlur = 0;
      this._arrow(o, tip, color, 13);
      x.beginPath(); x.arc(o.x, o.y, 5, 0, Math.PI * 2); x.fillStyle = color; x.fill(); x.restore();
    }
    _arrow(from, to, color, size) {
      const x = this.ctx, a = Math.atan2(to.y - from.y, to.x - from.x); x.save(); x.fillStyle = color;
      x.beginPath(); x.moveTo(to.x, to.y);
      x.lineTo(to.x - size * Math.cos(a - 0.4), to.y - size * Math.sin(a - 0.4));
      x.lineTo(to.x - size * Math.cos(a + 0.4), to.y - size * Math.sin(a + 0.4));
      x.closePath(); x.fill(); x.restore();
    }
  }

  PS.TrajectoryRenderer = TrajectoryRenderer;
  PS.RENDER_COLORS = C;
})(window.PokiSoccer = window.PokiSoccer || {});
