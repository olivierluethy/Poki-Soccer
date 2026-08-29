/**
 * content.js
 * Entry point. Instantiates the AnalysisOverlay, wires up screenshot capture
 * (via the background service worker), auto-detects a likely game region, and
 * routes messages from the popup. This is the ONLY file that talks to the
 * extension messaging layer — the game/overlay modules stay page-agnostic.
 */
(function (PS) {
  "use strict";

  if (window.__pokiSoccerInjected) {
    // Toggle if the user re-triggers on an already-injected page.
    if (window.__pokiSoccerOverlay) window.__pokiSoccerOverlay.toggle();
    return;
  }
  window.__pokiSoccerInjected = true;

  const overlay = new PS.AnalysisOverlay();
  window.__pokiSoccerOverlay = overlay;

  // Provide the CV pipeline with pixels: screenshot -> crop board region -> ImageData.
  overlay.captureFn = async (screenRect) => {
    const dataUrl = await requestScreenshot();
    if (!dataUrl) return null;
    return await cropToImageData(dataUrl, screenRect);
  };

  function requestScreenshot() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "ps-capture" }, (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.dataUrl) return resolve(null);
          resolve(resp.dataUrl);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function cropToImageData(dataUrl, rect) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const dpr = window.devicePixelRatio || 1;
        // captureVisibleTab returns the viewport at device pixels.
        const sx = Math.max(0, rect.x * dpr);
        const sy = Math.max(0, rect.y * dpr);
        const sw = Math.max(1, rect.width * dpr);
        const sh = Math.max(1, rect.height * dpr);
        // Downscale for a fast, robust CV pass.
        const maxDim = 240;
        const scale = Math.min(1, maxDim / Math.max(sw, sh));
        const dw = Math.max(8, Math.round(sw * scale));
        const dh = Math.max(8, Math.round(sh * scale));
        const canvas = document.createElement("canvas");
        canvas.width = dw; canvas.height = dh;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        try {
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
          resolve(ctx.getImageData(0, 0, dw, dh));
        } catch (e) {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  /**
   * Heuristic: the biggest <canvas> (or large game container) is probably the
   * board. Returns a viewport-space rect, or null.
   */
  function autoDetectRegion() {
    let best = null;
    const candidates = Array.from(document.querySelectorAll("canvas, iframe, embed, #game, .game, [class*='game'], [id*='game']"));
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.width < 120 || r.height < 120) continue;
      if (r.width > window.innerWidth * 1.2 || r.height > window.innerHeight * 1.2) continue;
      if (!best || area > best.area) best = { area, rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
    }
    return best ? best.rect : null;
  }

  overlay.autoDetectRegion = autoDetectRegion;

  // When the overlay is shown without a field yet, offer an auto-detected region.
  const origShow = overlay.show.bind(overlay);
  overlay.show = function () {
    origShow();
    if (!overlay.board) {
      const rect = autoDetectRegion();
      if (rect) {
        overlay.board = new PS.GameBoard(rect);
        overlay._updateStatus();
        overlay._banner("Field auto-detected — press Analyze (or Select field to adjust)");
        overlay.render();
      }
    }
  };

  // Popup / background messages.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "ps-toggle": overlay.toggle(); sendResponse({ ok: true, visible: overlay.visible }); break;
      case "ps-show": overlay.show(); sendResponse({ ok: true }); break;
      case "ps-analyze":
        overlay.show();
        Promise.resolve(overlay.runDetection()).then(() => overlay._forceRecompute());
        sendResponse({ ok: true });
        break;
      case "ps-set-mode": overlay.show(); overlay.setMode(msg.mode); sendResponse({ ok: true }); break;
      case "ps-status": sendResponse({ ok: true, visible: overlay.visible, solvable: overlay.board ? overlay.board.isSolvable() : false }); break;
      default: sendResponse({ ok: false });
    }
    return true;
  });
})(window.PokiSoccer = window.PokiSoccer || {});
