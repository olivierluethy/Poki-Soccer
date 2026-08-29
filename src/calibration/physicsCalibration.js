/**
 * physicsCalibration.js
 * Persists and adjusts the PhysicsConfig so the model can be tuned to match the
 * real game later. Nothing here is required for a first solve — it exists so the
 * physics constants are calibratable rather than hard-coded in the solver.
 *
 * Two mechanisms:
 *  - load()/save(): persist overrides in chrome.storage (falls back to memory).
 *  - calibrateFromObservation(): given a shot the user actually performed (pull
 *    distance + observed stopping distance, or observed bounce speed loss), nudge
 *    shotPowerScale / friction / restitution toward the observed behaviour.
 */
(function (PS) {
  "use strict";

  const STORAGE_KEY = "pokiSoccer.physics";

  class PhysicsCalibration {
    constructor() {
      this.overrides = {};
    }

    async load() {
      try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          const got = await chrome.storage.local.get(STORAGE_KEY);
          this.overrides = got[STORAGE_KEY] || {};
        }
      } catch (e) {
        this.overrides = {};
      }
      return this.overrides;
    }

    async save() {
      try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          await chrome.storage.local.set({ [STORAGE_KEY]: this.overrides });
        }
      } catch (e) {
        /* memory-only fallback */
      }
    }

    /** Build a PhysicsConfig with saved overrides applied. */
    buildConfig(base = {}) {
      return new PS.PhysicsConfig(Object.assign({}, base, this.overrides));
    }

    setOverride(key, value) {
      this.overrides[key] = value;
    }

    reset() {
      this.overrides = {};
    }

    /**
     * Calibrate from a single observed shot.
     * @param {object} obs
     *   obs.pullDistanceNorm   the pull distance the user used (normalized)
     *   obs.observedTravelNorm total distance the ball rolled before stopping
     *   obs.observedBounceRetention (optional) speed ratio kept across a bounce (0..1)
     *
     * Uses a simple relationship: with exponential friction, roll distance ≈
     * v0 / friction, and v0 = shotPowerScale * pull. We adjust one unknown while
     * holding the other, converging over repeated observations.
     */
    calibrateFromObservation(obs, currentConfig) {
      const cfg = currentConfig || this.buildConfig();
      if (obs.observedBounceRetention != null && obs.observedBounceRetention > 0) {
        // restitution*wallBounceFactor ≈ retention. Distribute the correction.
        const target = clamp(obs.observedBounceRetention, 0.2, 1.0);
        const current = cfg.restitution * cfg.wallBounceFactor;
        const ratio = target / (current || 1);
        this.overrides.restitution = clamp(cfg.restitution * Math.sqrt(ratio), 0.2, 1.0);
        this.overrides.wallBounceFactor = clamp(cfg.wallBounceFactor * Math.sqrt(ratio), 0.2, 1.0);
      }
      if (obs.pullDistanceNorm > 0 && obs.observedTravelNorm > 0) {
        // predictedTravel = (shotPowerScale * pull) / friction
        const predicted = (cfg.shotPowerScale * obs.pullDistanceNorm) / cfg.friction;
        const err = obs.observedTravelNorm / (predicted || 1);
        // Attribute the whole error to shotPowerScale (gentle, damped step).
        this.overrides.shotPowerScale = clamp(cfg.shotPowerScale * lerp(1, err, 0.5), 1, 40);
      }
      return this.buildConfig();
    }
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  PS.PhysicsCalibration = PhysicsCalibration;
})(window.PokiSoccer = window.PokiSoccer || {});
