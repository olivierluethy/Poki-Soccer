/**
 * boardDetector.js
 * Optional CV accelerator over an ImageData crop of the field (downscaled).
 * It detects the UNAMBIGUOUS things — the white ball and the two goal mouths —
 * to speed setup. It deliberately does NOT auto-assign players to teams: which
 * pieces are "mine" vs "opponent" is the user's call, so players are marked by
 * hand (fast multi-click). Nothing depends on detection succeeding; every result
 * carries a confidence and the user annotation is authoritative.
 */
(function (PS) {
  "use strict";

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h, s: max === 0 ? 0 : d / max, v: max };
  }

  class BoardDetector {
    constructor(imageData) {
      this.img = imageData; this.w = imageData.width; this.h = imageData.height; this.data = imageData.data; this._field = null;
    }
    _px(x, y) { const i = (y * this.w + x) * 4, d = this.data; return { r: d[i], g: d[i + 1], b: d[i + 2] }; }
    _norm(x, y) { return { x: x / this.w, y: y / this.h }; }

    fieldColor() {
      if (this._field) return this._field;
      const rs = [], gs = [], bs = [], step = Math.max(1, Math.floor(Math.min(this.w, this.h) / 40));
      for (let y = 0; y < this.h; y += step) for (let x = 0; x < this.w; x += step) { const p = this._px(x, y); rs.push(p.r); gs.push(p.g); bs.push(p.b); }
      const med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
      return (this._field = { r: med(rs), g: med(gs), b: med(bs) });
    }

    _components(pred, minArea) {
      const { w, h } = this, visited = new Uint8Array(w * h), blobs = [], stack = [];
      for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
        const i0 = sy * w + sx;
        if (visited[i0] || !pred(sx, sy)) continue;
        stack.length = 0; stack.push(i0); visited[i0] = 1;
        let area = 0, sX = 0, sY = 0, minX = sx, minY = sy, maxX = sx, maxY = sy;
        while (stack.length) {
          const idx = stack.pop(), x = idx % w, y = (idx / w) | 0;
          area++; sX += x; sY += y;
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (x > 0 && !visited[idx - 1] && pred(x - 1, y)) { visited[idx - 1] = 1; stack.push(idx - 1); }
          if (x < w - 1 && !visited[idx + 1] && pred(x + 1, y)) { visited[idx + 1] = 1; stack.push(idx + 1); }
          if (y > 0 && !visited[idx - w] && pred(x, y - 1)) { visited[idx - w] = 1; stack.push(idx - w); }
          if (y < h - 1 && !visited[idx + w] && pred(x, y + 1)) { visited[idx + w] = 1; stack.push(idx + w); }
        }
        if (area >= minArea) {
          const bw = maxX - minX + 1, bh = maxY - minY + 1;
          const circularity = (area / (bw * bh)) * (Math.min(bw, bh) / Math.max(bw, bh));
          blobs.push({ area, cx: sX / area, cy: sY / area, bw, bh, circularity });
        }
      }
      return blobs;
    }

    detectBall() {
      const total = this.w * this.h;
      const blobs = this._components((x, y) => { const p = this._px(x, y), hsv = rgbToHsv(p.r, p.g, p.b); return hsv.v > 0.72 && hsv.s < 0.28; }, Math.max(6, total * 0.00012));
      const cands = blobs.filter((b) => b.area < total * 0.04 && b.circularity > 0.45).sort((a, b) => b.circularity - a.circularity || a.area - b.area);
      if (!cands.length) return null;
      const b = cands[0], radius = ((b.bw + b.bh) / 4) / ((this.w + this.h) / 2);
      return { center: this._norm(b.cx, b.cy), radius, confidence: b.circularity > 0.62 ? "high" : b.circularity > 0.5 ? "medium" : "low" };
    }

    /** Detect a goal mouth on the given side by finding net-like (greyish, non-field) pixels in the edge band. */
    detectGoalSide(side) {
      const field = this.fieldColor();
      const band = Math.max(2, Math.floor(this.w * 0.06));
      const x0 = side === "left" ? 0 : this.w - band;
      const net = (x, y) => { const p = this._px(x, y), hsv = rgbToHsv(p.r, p.g, p.b), df = Math.abs(p.r - field.r) + Math.abs(p.g - field.g) + Math.abs(p.b - field.b); return hsv.s < 0.28 && df > 55; };
      let count = 0, min = Infinity, max = -Infinity;
      for (let y = 0; y < this.h; y++) for (let x = x0; x < x0 + band; x++) if (net(x, y)) { count++; if (y < min) min = y; if (y > max) max = y; }
      if (count < this.h * 0.08) return null;
      const width = (max - min) / this.h;
      return { center: { x: side === "left" ? 0 : 1, y: (min + max) / 2 / this.h }, width: Math.min(0.9, Math.max(0.08, width)), confidence: "low" };
    }

    detectScene() {
      return {
        ball: this.detectBall(),
        goals: { left: this.detectGoalSide("left"), right: this.detectGoalSide("right") },
        players: null, // teams are user-identified; players marked by hand
      };
    }
  }

  PS.BoardDetector = BoardDetector;
  PS.rgbToHsv = rgbToHsv;
})(window.PokiSoccer = window.PokiSoccer || {});
