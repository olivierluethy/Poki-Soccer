/**
 * overlay.js
 * AnalysisOverlay — the fast visual-annotation UI + real-time aim guidance.
 *
 * Primary workflow (a few seconds):
 *   FIELD → GOALS → BALL → MY PLAYERS → OPPONENTS → pick TARGET → SOLVE
 * Everything else (walls, precise adjustment) is optional/advanced.
 *
 * This file does UI + input routing only; geometry/physics live in game/*,
 * drawing in trajectoryRenderer.js. The game is treated as a pure visual surface
 * — no DOM game objects are queried.
 */
(function (PS) {
  "use strict";
  const { V } = PS.geom;
  const G = PS.geom;

  const MODE = {
    IDLE: "idle",
    SELECT_FIELD: "selectField",
    MARK_GOAL_L: "markGoalL",
    MARK_GOAL_R: "markGoalR",
    MARK_BALL: "markBall",
    MARK_MINE: "markMine",
    MARK_OPP: "markOpp",
    AIM: "aim",
    ADJUST: "adjust",
    DRAW_WALL: "drawWall",
  };
  const BALL_R = 0.02;

  class AnalysisOverlay {
    constructor() {
      this.board = null;
      this.calibration = new PS.PhysicsCalibration();
      this.physics = PS.PhysicsConfig.defaults();
      this.solver = null;
      this.solutions = [];
      this.selectedIndex = 0;
      this.mode = MODE.IDLE;
      this.showAlternatives = true;
      this.visible = false;
      this.live = null;           // real-time drag evaluation
      this._lastSignature = "";
      this._drag = null;
      this.captureFn = null;

      this._buildDOM();
      this._bindEvents();
      this._loadCalibration();
    }

    async _loadCalibration() {
      await this.calibration.load();
      this.physics = this.calibration.buildConfig();
    }

    // ---- DOM ---------------------------------------------------------------
    _buildDOM() {
      const root = document.createElement("div");
      root.id = "ps-overlay-root";
      root.innerHTML = `
        <canvas class="ps-canvas ps-draw"></canvas>
        <canvas class="ps-canvas ps-hit"></canvas>
        <div class="ps-banner"></div>
        <div class="ps-panel">
          <div class="ps-header">
            <div class="ps-logo">⚽</div>
            <div><div class="ps-title">Soccer 5 Analyzer</div><div class="ps-subtitle">Mark · Simulate · Aim</div></div>
            <button class="ps-close" title="Close">✕</button>
          </div>

          <div class="ps-section">
            <div class="ps-steps">
              <button class="ps-step" data-mode="selectField"><span class="ps-step-num">1</span><span>Field</span><span class="ps-step-meta" data-meta="field"></span></button>
              <button class="ps-step" data-mode="markGoalL"><span class="ps-step-num">2</span><span>Goals (drag across each mouth)</span><span class="ps-step-meta" data-meta="goals"></span></button>
              <button class="ps-step" data-mode="markBall"><span class="ps-step-num">3</span><span>Ball</span><span class="ps-step-meta" data-meta="ball"></span></button>
              <button class="ps-step" data-mode="markMine"><span class="ps-step-num">4</span><span>Your players</span><span class="ps-step-meta" data-meta="mine"></span></button>
              <button class="ps-step" data-mode="markOpp"><span class="ps-step-num">5</span><span>Opponents</span><span class="ps-step-meta" data-meta="opp"></span></button>
            </div>
          </div>

          <div class="ps-section">
            <div class="ps-section-label">Target goal</div>
            <div class="ps-target">
              <button class="ps-btn ps-btn-ghost" data-target="left">◀ Left</button>
              <button class="ps-btn ps-btn-ghost" data-target="right">Right ▶</button>
            </div>
          </div>

          <div class="ps-section">
            <button class="ps-btn ps-btn-primary" data-act="solve">⚡ Solve shots</button>
            <div class="ps-btn-row">
              <button class="ps-btn ps-btn-ghost" data-act="autodetect">◎ Auto-detect</button>
              <button class="ps-btn ps-btn-ghost" data-mode="aim">🎯 Aim guide</button>
            </div>
          </div>

          <div class="ps-section">
            <div class="ps-section-label">Best shots</div>
            <div class="ps-solutions"></div>
          </div>

          <div class="ps-instruction" style="display:none"></div>
          <div class="ps-live" style="display:none"></div>

          <details class="ps-adv">
            <summary>Advanced</summary>
            <button class="ps-btn ps-btn-ghost" data-mode="adjust">✥ Adjust markers</button>
            <button class="ps-btn ps-btn-ghost" data-mode="drawWall">／ Add wall</button>
            <button class="ps-btn ps-btn-ghost" data-act="clear">🗑 Clear all</button>
          </details>
          <div class="ps-hint">Drag the field, drag across each goal mouth, click the ball, click your players then the opponents, pick a target, and Solve. Use 🎯 Aim guide to rehearse the drag.</div>
        </div>`;
      document.documentElement.appendChild(root);
      this.root = root;
      this.panel = root.querySelector(".ps-panel");
      this.drawCanvas = root.querySelector(".ps-draw");
      this.hitCanvas = root.querySelector(".ps-hit");
      this.banner = root.querySelector(".ps-banner");
      this.solutionsEl = root.querySelector(".ps-solutions");
      this.instructionEl = root.querySelector(".ps-instruction");
      this.liveEl = root.querySelector(".ps-live");
      this.renderer = new PS.TrajectoryRenderer(this.drawCanvas.getContext("2d"));
      this._resize();
      root.style.display = "none";
    }

    _resize() {
      const dpr = window.devicePixelRatio || 1;
      for (const c of [this.drawCanvas, this.hitCanvas]) {
        c.width = Math.round(window.innerWidth * dpr);
        c.height = Math.round(window.innerHeight * dpr);
        c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      this.render();
    }

    _bindEvents() {
      window.addEventListener("resize", () => this._resize());
      this.root.querySelector(".ps-close").addEventListener("click", () => this.hide());
      this.panel.addEventListener("click", (e) => {
        const act = e.target.closest("[data-act]");
        const mode = e.target.closest("[data-mode]");
        const tgt = e.target.closest("[data-target]");
        if (act) this._action(act.dataset.act);
        else if (mode) this.setMode(mode.dataset.mode === this.mode ? MODE.IDLE : mode.dataset.mode);
        else if (tgt) { if (this.board) { this.board.setTarget(tgt.dataset.target); this._forceRecompute(); } }
      });
      this.hitCanvas.addEventListener("mousedown", (e) => this._down(e));
      window.addEventListener("mousemove", (e) => this._move(e));
      window.addEventListener("mouseup", (e) => this._up(e));
      this.hitCanvas.addEventListener("contextmenu", (e) => { if (this.mode !== MODE.IDLE) e.preventDefault(); });
    }

    // ---- Visibility --------------------------------------------------------
    show() { this.visible = true; this.root.style.display = "block"; this._resize(); this._updateStatus(); }
    hide() { this.visible = false; this.setMode(MODE.IDLE); this.root.style.display = "none"; }
    toggle() { this.visible ? this.hide() : this.show(); }

    // ---- Modes -------------------------------------------------------------
    setMode(mode) {
      this.mode = mode;
      this.hitCanvas.classList.toggle("ps-interactive", mode !== MODE.IDLE);
      this.panel.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("ps-active", b.dataset.mode === mode));
      const prompts = {
        [MODE.SELECT_FIELD]: "Drag a rectangle around the pitch",
        [MODE.MARK_GOAL_L]: "Drag along the LEFT edge across the goal mouth",
        [MODE.MARK_GOAL_R]: "Drag along the RIGHT edge across the goal mouth",
        [MODE.MARK_BALL]: "Click the ball (drag to size it)",
        [MODE.MARK_MINE]: "Click each of YOUR players · click one again to remove",
        [MODE.MARK_OPP]: "Click each OPPONENT · click one again to remove",
        [MODE.AIM]: "Press your highlighted player and drag to rehearse the shot",
        [MODE.ADJUST]: "Drag any marker to correct it",
        [MODE.DRAW_WALL]: "Drag to add a wall",
      };
      // Goals step drives left first, then right.
      if (mode === MODE.MARK_GOAL_L && this.board && this.board.goals.left && !this.board.goals.right) {
        this.mode = MODE.MARK_GOAL_R;
      }
      this._banner(prompts[this.mode] || "");
      this.liveEl.style.display = this.mode === MODE.AIM ? "block" : "none";
      if (this.mode === MODE.AIM) this._renderLive(null);
      this.render();
    }
    _banner(t) { this.banner.textContent = t; this.banner.classList.toggle("ps-show", !!t); }

    // ---- Actions -----------------------------------------------------------
    async _action(act) {
      if (act === "solve") {
        if (!this.board) { this.setMode(MODE.SELECT_FIELD); return; }
        this._forceRecompute();
      } else if (act === "autodetect") {
        await this.runDetection();
        this._forceRecompute();
      } else if (act === "clear") {
        if (this.board) { const r = this.board.screenRect; this.board = new PS.GameBoard(r); this.live = null; this._forceRecompute(); }
      }
    }

    // ---- Detection (optional accelerator) ---------------------------------
    async runDetection() {
      if (!this.board || !this.captureFn) { this._banner("Select the field first"); return; }
      this._banner("Scanning…");
      let img;
      try { img = await this.captureFn(this.board.screenRect); } catch (e) { img = null; }
      if (!img) { this._banner("Auto-detect unavailable — mark objects by hand"); return; }
      const det = new PS.BoardDetector(img).detectScene();
      if (det.ball && (!this.board.ball || this.board.ball.confidence !== "manual")) {
        this.board.setBall(det.ball.center, Math.max(0.012, det.ball.radius), det.ball.confidence);
      }
      // Only auto-add players if the user hasn't marked any yet.
      if (this.board.players.length === 0 && det.players) {
        for (const p of det.players) this.board.addPlayer(p.center, p.team, p.radius, p.confidence);
      }
      for (const side of ["left", "right"]) {
        if (det.goals && det.goals[side] && !this.board.goals[side]) {
          this.board.setGoalSide(side, det.goals[side].center, det.goals[side].width, det.goals[side].confidence);
        }
      }
      this._banner(det.ball || (det.players && det.players.length) ? "Auto-detect done — review and correct as needed" : "Nothing detected confidently — mark by hand");
      this._updateStatus();
    }

    _forceRecompute() { this._lastSignature = ""; this.recompute(); }

    recompute() {
      if (!this.board) { this.render(); return; }
      const sig = this.board.signature() + "|" + JSON.stringify(this.calibration.overrides);
      if (sig === this._lastSignature) { this.render(); return; }
      this._lastSignature = sig;
      this._updateStatus();
      if (!this.board.isSolvable()) { this.solutions = []; this._renderSolutions(); this.render(); return; }
      const solverPhysics = this.physics.clone({ ballRadius: this.board.ball.radius });
      this.solver = new PS.TrajectorySolver(this.board, solverPhysics);
      const t0 = performance.now();
      const res = this.solver.solve();
      const ms = Math.round(performance.now() - t0);
      this.solutions = res.solutions;
      this.selectedIndex = 0;
      this._renderSolutions(ms);
      this.render();
    }

    // ---- Status ------------------------------------------------------------
    _updateStatus() {
      const b = this.board;
      const meta = (k, v) => { const el = this.panel.querySelector(`[data-meta="${k}"]`); if (el) el.textContent = v; };
      const done = (mode, ok) => {
        const el = this.panel.querySelector(`[data-mode="${mode}"]`);
        if (el) el.classList.toggle("ps-done", ok);
      };
      meta("field", b ? "✓" : "");
      done("selectField", !!b);
      const goalsN = b ? ["left", "right"].filter((s) => b.goals[s]).length : 0;
      meta("goals", goalsN ? `${goalsN}/2` : "");
      done("markGoalL", goalsN > 0);
      meta("ball", b && b.ball ? "✓" : "");
      done("markBall", !!(b && b.ball));
      meta("mine", b ? String(b.myPlayers().length) : "");
      done("markMine", !!(b && b.myPlayers().length));
      meta("opp", b ? String(b.oppPlayers().length) : "");
      done("markOpp", !!(b && b.oppPlayers().length));
      this.panel.querySelectorAll("[data-target]").forEach((el) =>
        el.classList.toggle("ps-on", b && b.target === el.dataset.target));
    }

    _renderSolutions(ms) {
      if (!this.board || !this.board.isSolvable()) {
        const missing = this.board ? this.board.missingElements() : ["field"];
        this.solutionsEl.innerHTML = `<div class="ps-empty">Need: <b>${missing.join(", ")}</b>. Mark them above (or Auto-detect), then Solve.</div>`;
        this.instructionEl.style.display = "none";
        return;
      }
      if (!this.solutions.length) {
        this.solutionsEl.innerHTML = `<div class="ps-empty">No goal-scoring shot found. Try the other target goal, reposition a player, or add a wall, then Solve again.</div>`;
        this.instructionEl.style.display = "none";
        return;
      }
      this.solutionsEl.innerHTML = this.solutions.map((s, i) => this._card(s, i)).join("");
      this.solutionsEl.querySelectorAll(".ps-solution").forEach((el) =>
        el.addEventListener("click", () => { this.selectedIndex = +el.dataset.i; this._renderSolutions(ms); this.render(); }));
      this._renderInstruction(this.solutions[this.selectedIndex]);
    }

    _card(s, i) {
      const title = s.bounces === 0 ? "Direct shot" : `${s.bounces}-bounce`;
      const pullPx = Math.round(this.board.lenToScreen(s.pullDistanceNorm));
      const sel = i === this.selectedIndex ? " ps-selected" : "";
      const pIdx = this.board.myPlayers().findIndex((p) => p.id === s.shooterId) + 1;
      return `<div class="ps-solution${sel}" data-i="${i}">
        <div class="ps-sol-top"><span class="ps-sol-rank">${i + 1}</span><span class="ps-sol-title">${title} · Player ${pIdx}</span><span class="ps-diff ${s.difficulty.label}" style="margin-left:auto">${s.difficulty.label}</span></div>
        <div class="ps-sol-grid">
          <span>Pull: <b>${Math.round(s.pullDirectionDeg)}°</b></span>
          <span>Distance: <b>${pullPx}px</b></span>
          <span>Power: <b>${Math.round(s.power * 100)}%</b></span>
          <span>Tolerance: <b>±${(s.window.widthDeg / 2).toFixed(1)}°</b></span>
        </div>
        <div class="ps-bar"><span style="width:${Math.round(s.power * 100)}%"></span></div>
      </div>`;
    }

    _renderInstruction(s) {
      if (!s) { this.instructionEl.style.display = "none"; return; }
      const pullPx = Math.round(this.board.lenToScreen(s.pullDistanceNorm));
      const arrow = arrowGlyph(s.pullDirectionDeg);
      const pIdx = this.board.myPlayers().findIndex((p) => p.id === s.shooterId) + 1;
      this.instructionEl.style.display = "block";
      this.instructionEl.innerHTML = `
        <div class="ps-section-label" style="margin-bottom:6px">Recommended shot</div>
        <div class="ps-instr-row"><span class="ps-instr-arrow">${arrow}</span><span>Move <b>Player ${pIdx}</b> (highlighted): pull <b>${arrow}</b> ${Math.round(s.pullDirectionDeg)}°</span></div>
        <div class="ps-instr-row">↔ Pull distance: <b>${pullPx}px</b> · Power <b>${Math.round(s.power * 100)}%</b></div>
        <div class="ps-instr-row">⟳ Bounces: <b>${s.bounces}</b> · Confidence: <b>${s.confidence}</b></div>
        <div class="ps-hint">The red line is the predicted ball path; orange dots are rebounds; green marks the goal. Press 🎯 Aim guide to rehearse the drag on the highlighted player.</div>`;
    }

    _renderLive(info) {
      const rec = this.solutions[this.selectedIndex];
      if (!info) {
        this.liveEl.innerHTML = `<div class="ps-section-label" style="color:#94a3b8;margin-bottom:4px">Aim guide</div><div class="ps-live-row"><span>Press your highlighted player and drag.</span></div>`;
        return;
      }
      let alignHtml = "";
      if (rec) {
        const dAng = signedAngleDiff(info.launchDeg, rec.launchDeg);
        const dPow = info.power - rec.power;
        const good = Math.abs(dAng) < 3.5 && Math.abs(dPow) < 0.09 && info.outcome === "goal";
        if (good) alignHtml = `<div class="ps-align good">✓ Excellent alignment — take the shot</div>`;
        else {
          const rot = Math.abs(dAng) < 1 ? "" : `Rotate ${Math.abs(dAng).toFixed(1)}° ${dAng > 0 ? "clockwise" : "counter-cw"}`;
          const pw = Math.abs(dPow) < 0.05 ? "" : (dPow < 0 ? `pull +${Math.round(this.board.lenToScreen((rec.power - info.power) * this.physics.maxVelocity / this.physics.shotPowerScale))}px` : `ease off pull`);
          alignHtml = `<div class="ps-align off">${[rot, pw].filter(Boolean).join(" · ") || (info.outcome === "goal" ? "On target" : "Off target")}</div>`;
        }
      }
      const recDeg = rec ? Math.round(rec.launchDeg) : "–";
      const recPow = rec ? Math.round(rec.power * 100) : "–";
      this.liveEl.innerHTML = `
        <div class="ps-section-label" style="color:#94a3b8;margin-bottom:4px">Aim guide ${info.outcome === "goal" ? "· GOAL ✓" : ""}</div>
        <div class="ps-live-row"><span>Your aim</span><b>${Math.round(info.launchDeg)}°</b></div>
        <div class="ps-live-row"><span>Recommended</span><b>${recDeg}°</b></div>
        <div class="ps-live-row"><span>Power</span><b>${Math.round(info.power * 100)}% <span style="color:#64748b">(rec ${recPow}%)</span></b></div>
        ${alignHtml}`;
    }

    // ---- Rendering ---------------------------------------------------------
    render() {
      this.renderer.clear(window.innerWidth, window.innerHeight);
      this.renderer.render(this.board, {
        solutions: this.solutions,
        selectedIndex: this.selectedIndex,
        showAlternatives: this.showAlternatives,
        selectionRect: this._drag && this._drag.kind === "selectField" ? this._drag.rect : null,
        previewGoal: this._drag && this._drag.previewGoal ? this._drag.previewGoal : null,
        live: this.live,
        mode: this.mode,
      });
    }

    // ---- Pointer -----------------------------------------------------------
    _pt(e) { return { x: e.clientX, y: e.clientY }; }

    _down(e) {
      if (this.mode === MODE.IDLE) return;
      e.preventDefault();
      const p = this._pt(e);
      if (this.mode === MODE.SELECT_FIELD) { this._drag = { kind: "selectField", start: p, rect: { x: p.x, y: p.y, width: 0, height: 0 } }; return; }
      if (!this.board) { this._banner("Select the field first"); return; }
      const n = this.board.toNorm(p);

      switch (this.mode) {
        case MODE.MARK_GOAL_L: this._drag = { kind: "goalL", start: n }; break;
        case MODE.MARK_GOAL_R: this._drag = { kind: "goalR", start: n }; break;
        case MODE.MARK_BALL: this.board.setBall(n, BALL_R, "manual"); this._drag = { kind: "sizeBall", center: n }; break;
        case MODE.MARK_MINE: this._togglePlayer(n, "mine"); break;
        case MODE.MARK_OPP: this._togglePlayer(n, "opp"); break;
        case MODE.DRAW_WALL: this._drag = { kind: "wall", start: n }; break;
        case MODE.ADJUST: this._drag = this._grab(n); break;
        case MODE.AIM: this._drag = this._startAim(n); break;
      }
      this.render();
    }

    _move(e) {
      if (!this._drag) return;
      const p = this._pt(e);
      const d = this._drag;
      if (d.kind === "selectField") { d.rect = rectOf(d.start, p); this.render(); return; }
      if (!this.board) return;
      const n = this.board.toNorm(p);
      switch (d.kind) {
        case "goalL": case "goalR": {
          const side = d.kind === "goalL" ? "left" : "right";
          const cy = (d.start.y + n.y) / 2, w = Math.max(0.05, Math.abs(d.start.y - n.y) || 0.28);
          d.previewGoal = { side, segment: { a: { x: side === "left" ? 0 : 1, y: cy - w / 2 }, b: { x: side === "left" ? 0 : 1, y: cy + w / 2 } }, depth: 0.06 };
          break;
        }
        case "sizeBall": this.board.ball.radius = Math.max(0.008, V.dist(d.center, n)) || BALL_R; break;
        case "wall": d.previewWall = { a: d.start, b: n, thickness: 0.012 }; break;
        case "moveBall": this.board.ball.center = n; this.board.ball.confidence = "manual"; break;
        case "movePlayer": if (d.ref) { d.ref.center = n; d.ref.confidence = "manual"; } break;
        case "moveGoal": this._moveGoalEndpoint(d, n); break;
        case "aim": this._aimUpdate(d, n); break;
      }
      this.render();
    }

    _up() {
      if (!this._drag) return;
      const d = this._drag;
      if (d.kind === "selectField") {
        const r = d.rect;
        if (r.width > 30 && r.height > 30) { this.board = new PS.GameBoard(r); this.setMode(MODE.MARK_GOAL_L); this._banner("Field set — now the goals"); }
      } else if ((d.kind === "goalL" || d.kind === "goalR") && d.previewGoal) {
        const g = d.previewGoal, side = g.side;
        const cy = (g.segment.a.y + g.segment.b.y) / 2, w = Math.abs(g.segment.a.y - g.segment.b.y);
        this.board.setGoalSide(side, { x: side === "left" ? 0 : 1, y: cy }, w || 0.28, "manual");
        if (side === "left" && !this.board.goals.right) this.setMode(MODE.MARK_GOAL_R);
      } else if (d.kind === "wall" && d.previewWall && V.dist(d.previewWall.a, d.previewWall.b) > 0.02) {
        this.board.addWall(d.previewWall.a, d.previewWall.b, 0.012);
      }
      const wasAim = d.kind === "aim";
      this._drag = null;
      if (this.board && !wasAim) this.recompute();
      this.render();
    }

    _togglePlayer(n, team) {
      const near = this.board.players.find((p) => p.team === team && V.dist(p.center, n) < Math.max(0.04, p.radius));
      if (near) this.board.removePlayer(near.id);
      else this.board.addPlayer(n, team, this.board.defaultPlayerRadius, "manual");
      this._updateStatus();
      this.recompute();
    }

    _grab(n) {
      const b = this.board, tol = 0.05;
      if (b.ball && V.dist(b.ball.center, n) < Math.max(tol, b.ball.radius)) return { kind: "moveBall" };
      for (const p of b.players) if (V.dist(p.center, n) < Math.max(tol, p.radius)) return { kind: "movePlayer", ref: p };
      for (const side of ["left", "right"]) {
        const g = b.goals[side];
        if (!g) continue;
        if (V.dist(g.segment.a, n) < tol) return { kind: "moveGoal", side, end: "a" };
        if (V.dist(g.segment.b, n) < tol) return { kind: "moveGoal", side, end: "b" };
      }
      return { kind: "none" };
    }
    _moveGoalEndpoint(d, n) {
      const g = this.board.goals[d.side];
      const other = d.end === "a" ? g.segment.b : g.segment.a;
      const cy = (other.y + n.y) / 2, w = Math.max(0.05, Math.abs(other.y - n.y));
      this.board.setGoalSide(d.side, { x: d.side === "left" ? 0 : 1, y: cy }, w, "manual");
    }

    // ---- Real-time aim -----------------------------------------------------
    _startAim(n) {
      // Prefer the selected solution's shooter; else nearest of my players.
      let shooter = null;
      const sel = this.solutions[this.selectedIndex];
      if (sel) shooter = this.board.playerById(sel.shooterId);
      let nearest = null, nd = Infinity;
      for (const p of this.board.myPlayers()) { const dd = V.dist(p.center, n); if (dd < nd) { nd = dd; nearest = p; } }
      if (nearest && nd < 0.12) shooter = nearest;
      if (!shooter) { this._banner("Mark and select a shot first"); return { kind: "none" }; }
      return { kind: "aim", shooter };
    }
    _aimUpdate(d, mouseNorm) {
      if (!d.shooter) return;
      if (!this.solver) { const sp = this.physics.clone({ ballRadius: this.board.ball.radius }); this.solver = new PS.TrajectorySolver(this.board, sp); }
      const pull = V.sub(mouseNorm, d.shooter.center);
      const info = this.solver.evaluateDrag(d.shooter, pull);
      this.live = {
        ballPath: info.ballPath,
        outcome: info.outcome,
        shooterCenter: d.shooter.center,
        pullDeg: G.normDeg(G.radToDeg(V.angle(pull))),
        pullDist: V.len(pull),
        launchDeg: info.launchDeg,
        power: info.power,
      };
      this._renderLive({ launchDeg: info.launchDeg, power: info.power, outcome: info.outcome });
    }
  }

  // ---- helpers -------------------------------------------------------------
  function rectOf(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }; }
  function arrowGlyph(deg) { const d = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"]; return d[Math.round(G.normDeg(deg) / 45) % 8]; }
  function signedAngleDiff(from, to) { let d = G.normDeg(to) - G.normDeg(from); if (d > 180) d -= 360; if (d < -180) d += 360; return d; }

  PS.AnalysisOverlay = AnalysisOverlay;
  PS.MODE = MODE;
})(window.PokiSoccer = window.PokiSoccer || {});
