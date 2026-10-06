(function (root) {
  "use strict";

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const toGray = (d) => (0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]) / 255;

  function luma(rgba, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = toGray(rgba.subarray(p, p + 3));
    return g;
  }

  function grayToRgba(g, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      const v = (g[i] * 255) | 0;
      out[p] = out[p + 1] = out[p + 2] = v;
      out[p + 3] = 255;
    }
    return out;
  }

  function kernelInv(len, r) {
    const inv = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const lo = Math.max(i - r, 0);
      const hi = Math.min(i + r, len - 1);
      inv[i] = 1 / (hi - lo + 1);
    }
    return inv;
  }

  function boxBlur(src, w, h, r, dst) {
    dst = dst || new Float32Array(w * h);
    if (r < 1) { dst.set(src); return dst; }
    const tmp = new Float32Array(w * h);
    const invX = kernelInv(w, r);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = 0; x <= Math.min(r, w - 1); x++) acc += src[row + x];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc * invX[x];
        if (x - r < 0) acc += src[row + Math.min(x + r + 1, w - 1)];
        else if (x + r + 1 >= w) acc -= src[row + Math.max(x - r, 0)];
        else acc += src[row + x + r + 1] - src[row + x - r];
      }
    }
    const invY = kernelInv(h, r);
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = 0; y <= Math.min(r, h - 1); y++) acc += tmp[y * w + x];
      for (let y = 0; y < h; y++) {
        dst[y * w + x] = acc * invY[y];
        if (y - r < 0) acc += tmp[Math.min(y + r + 1, h - 1) * w + x];
        else if (y + r + 1 >= h) acc -= tmp[Math.max(y - r, 0) * w + x];
        else acc += tmp[(y + r + 1) * w + x] - tmp[(y - r) * w + x];
      }
    }
    return dst;
  }

  function sobel(gray, w, h) {
    const m = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      const r0 = (y - 1) * w, r1 = y * w, r2 = (y + 1) * w;
      for (let x = 1; x < w - 1; x++) {
        const tl = gray[r0 + x - 1], t = gray[r0 + x], tr = gray[r0 + x + 1];
        const l = gray[r1 + x - 1], r = gray[r1 + x + 1];
        const bl = gray[r2 + x - 1], b = gray[r2 + x], br = gray[r2 + x + 1];
        const gx = tl + 2 * l + bl - tr - 2 * r - br;
        const gy = tl + 2 * t + tr - bl - 2 * b - br;
        m[r1 + x] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    return m;
  }

  function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = i; }
    }
    return thr;
  }

  function edgeBinary(mag, w, h, keepRatio) {
    const total = w * h;
    const sorted = Float32Array.from(mag).sort();
    const p99 = sorted[Math.min(total - 1, Math.floor(total * 0.99))];
    if (p99 <= 1e-9) return new Uint8Array(total);
    const k = 255 / p99;
    const norm = new Uint8Array(total);
    const hist = new Uint32Array(256);
    for (let i = 0; i < total; i++) {
      const v = clamp(Math.round(mag[i] * k), 0, 255);
      norm[i] = v;
      hist[v]++;
    }
    const keep = Math.max(500, Math.round(total * (keepRatio || 0.03)));
    let acc = 0, thr = 255;
    for (let v = 255; v >= 0; v--) {
      acc += hist[v];
      if (acc >= keep) { thr = v; break; }
    }
    const bin = new Uint8Array(total);
    let count = 0;
    for (let i = 0; i < total; i++) {
      if (norm[i] >= thr) { bin[i] = 1; count++; }
    }
    return count < total * 0.004 ? new Uint8Array(total) : bin;
  }

  function morph(bin, w, h, pass) {
    const out = new Uint8Array(w * h);
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : bin[y * w + x]);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v;
        if (pass > 0) {
          v = at(x - 1, y) | at(x, y - 1) | at(x + 1, y) | at(x, y + 1) | at(x, y) | at(x - 1, y - 1) | at(x + 1, y - 1) | at(x - 1, y + 1) | at(x + 1, y + 1);
        } else {
          v = at(x - 1, y) & at(x, y - 1) & at(x + 1, y) & at(x, y + 1) & at(x, y) & at(x - 1, y - 1) & at(x + 1, y - 1) & at(x - 1, y + 1) & at(x + 1, y + 1);
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DY = [0, 1, 1, 1, 0, -1, -1, -1];

  function traceBoundary(bin, w, h, sx, sy) {
    const lit = (x, y) => x >= 0 && y >= 0 && x < w && y < h && bin[y * w + x] === 1;
    const pts = [];
    const cap = 8 * w * h;
    let px = sx, py = sy, bdir = 6;
    for (let step = 0; step < cap; step++) {
      pts.push(px, py);
      let d = -1;
      for (let k = 1; k <= 8; k++) {
        const cand = (bdir + k) & 7;
        if (lit(px + DX[cand], py + DY[cand])) { d = cand; break; }
      }
      if (d < 0) break;
      px += DX[d];
      py += DY[d];
      bdir = (d + 4) & 7;
      if (px === sx && py === sy && step > 2) break;
    }
    return pts;
  }

  function traceContours(bin, w, h) {
    const visited = new Uint8Array(w * h);
    const out = [];
    const minArea = w * h * 0.02;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (bin[i] !== 1 || visited[i]) continue;
        const c = traceBoundary(bin, w, h, x, y);
        if (c.length < 24) continue;
        for (let k = 0; k < c.length; k += 2) visited[c[k + 1] * w + c[k]] = 1;
        if (Math.abs(polyArea(c)) > minArea) out.push(c);
      }
    }
    return out;
  }

  function polyArea(p) {
    let a = 0;
    for (let i = 0, n = p.length / 2; i < n; i++) {
      const j = (i + 1) % n;
      a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
    }
    return a / 2;
  }

  function hullOf(pts) {
    const n = pts.length / 2;
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => pts[a * 2] - pts[b * 2] || pts[a * 2 + 1] - pts[b * 2 + 1]);
    const cross = (o, a, b) => (pts[a * 2] - pts[o * 2]) * (pts[b * 2 + 1] - pts[o * 2 + 1]) - (pts[a * 2 + 1] - pts[o * 2 + 1]) * (pts[b * 2] - pts[o * 2]);
    const lower = [];
    for (const i of idx) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
      lower.push(i);
    }
    const upper = [];
    for (let k = idx.length - 1; k >= 0; k--) {
      const i = idx[k];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
      upper.push(i);
    }
    lower.pop(); upper.pop();
    const out = [];
    for (const i of lower.concat(upper)) out.push(pts[i * 2], pts[i * 2 + 1]);
    return out;
  }

  function bestQuad(hull, w, h) {
    const n = hull.length / 2;
    if (n < 4) return null;
    const stride = Math.max(1, Math.floor(n / 60));
    const pts = [];
    for (let i = 0; i < n; i += stride) pts.push(i);
    let best = null, bestScore = 0;
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        for (let c = b + 1; c < pts.length; c++) {
          for (let d = c + 1; d < pts.length; d++) {
            const q = [pts[a], pts[b], pts[c], pts[d]];
            const ar = Math.abs(polyArea([hull[q[0] * 2], hull[q[0] * 2 + 1], hull[q[1] * 2], hull[q[1] * 2 + 1], hull[q[2] * 2], hull[q[2] * 2 + 1], hull[q[3] * 2], hull[q[3] * 2 + 1]]));
            if (ar > bestScore) {
              bestScore = ar;
              best = [hull[q[0] * 2], hull[q[0] * 2 + 1], hull[q[1] * 2], hull[q[1] * 2 + 1], hull[q[2] * 2], hull[q[2] * 2 + 1], hull[q[3] * 2], hull[q[3] * 2 + 1]];
            }
          }
        }
      }
    }
    return best;
  }

  function orderCorners(pts) {
    const cx = (pts[0] + pts[2] + pts[4] + pts[6]) / 4;
    const cy = (pts[1] + pts[3] + pts[5] + pts[7]) / 4;
    const items = [0, 1, 2, 3].map((i) => ({
      x: pts[i * 2],
      y: pts[i * 2 + 1],
      a: Math.atan2(pts[i * 2 + 1] - cy, pts[i * 2] - cx)
    }));
    items.sort((p, q) => p.a - q.a);
    const out = [];
    items.forEach((it) => out.push(it.x, it.y));
    return out;
  }

  function quadArea(q) {
    return Math.abs(polyArea(q));
  }

  function quadPerimeter(q) {
    let p = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      p += Math.hypot(q[j * 2] - q[i * 2], q[j * 2 + 1] - q[i * 2 + 1]);
    }
    return p;
  }

  function quadQuality(q, w, h) {
    const area = quadArea(q);
    if (area < w * h * 0.12) return 0;
    const per = quadPerimeter(q);
    if (per <= 0) return 0;
    const squareness = (4 * area) / (per * per);
    if (squareness < 0.18) return 0;
    return area * squareness;
  }

  function downsampleAvg(src, w, h, dw, dh) {
    const out = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      const y0 = Math.floor((y * h) / dh);
      const y1 = Math.min(h - 1, Math.ceil(((y + 1) * h) / dh));
      for (let x = 0; x < dw; x++) {
        const x0 = Math.floor((x * w) / dw);
        const x1 = Math.min(w - 1, Math.ceil(((x + 1) * w) / dw));
        let s = 0, n = 0;
        for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) { s += src[yy * w + xx]; n++; }
        out[y * dw + x] = n ? s / n : 0;
      }
    }
    return out;
  }

  function hugsBorder(q, w, h) {
    const mx = w * 0.02, my = h * 0.02;
    let sides = 0;
    if (Math.min(q[1], q[3], q[5], q[7]) <= my) sides++;
    if (Math.max(q[1], q[3], q[5], q[7]) >= h - my) sides++;
    if (Math.min(q[0], q[2], q[4], q[6]) <= mx) sides++;
    if (Math.max(q[0], q[2], q[4], q[6]) >= w - mx) sides++;
    return sides >= 3;
  }

  function detectQuad(gray, w, h) {
    const sw = w > 220 ? 220 : w;
    const sh = Math.max(1, Math.round((h / w) * sw));
    if (sh < 60) return null;
    const small = downsampleAvg(gray, w, h, sw, sh);
    const blurred = boxBlur(small, sw, sh, 1);
    const mag = sobel(blurred, sw, sh);
    let bin = edgeBinary(mag, sw, sh, 0.12);
    if (!bin.length) return null;
    bin = morph(bin, sw, sh, 1);
    bin = morph(bin, sw, sh, -1);
    const contours = traceContours(bin, sw, sh);
    if (!contours.length) return null;
    let bestQ = null, bestScore = 0;
    for (let i = 0; i < contours.length; i++) {
      const hull = hullOf(contours[i]);
      if (hull.length < 8) continue;
      const q = bestQuad(hull, sw, sh);
      if (!q) continue;
      const ordered = orderCorners(q);
      if (hugsBorder(ordered, sw, sh)) continue;
      const score = quadQuality(ordered, sw, sh);
      if (score > bestScore) { bestScore = score; bestQ = ordered; }
    }
    if (!bestQ) return null;
    const out = new Float32Array(8);
    for (let i = 0; i < 8; i++) out[i] = bestQ[i] * ((i % 2 === 0 ? w / sw : h / sh));
    for (let i = 0; i < 8; i++) if (!isFinite(out[i])) return null;
    return out;
  }

  function varianceOfLaplacian(gray, w, h, quad) {
    let n = 0, sum = 0, sum2 = 0;
    let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1;
    if (quad) {
      x0 = w; x1 = 0; y0 = h; y1 = 0;
      for (let i = 0; i < 8; i += 2) {
        x0 = Math.min(x0, quad[i]); x1 = Math.max(x1, quad[i]);
        y0 = Math.min(y0, quad[i + 1]); y1 = Math.max(y1, quad[i + 1]);
      }
      x0 = clamp(Math.floor(x0), 0, w - 2); x1 = clamp(Math.ceil(x1), x0 + 2, w - 1);
      y0 = clamp(Math.floor(y0), 0, h - 2); y1 = clamp(Math.ceil(y1), y0 + 2, h - 1);
    }
    for (let y = y0 + 1; y < y1; y++) {
      for (let x = x0 + 1; x < x1; x++) {
        const i = y * w + x;
        const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        sum += v; sum2 += v * v; n++;
      }
    }
    if (n < 25) return 0;
    const mean = sum / n;
    return (sum2 / n - mean * mean) * 65025;
  }

  function deviation(history) {
    if (history.length < 2) return 1;
    const base = history[history.length - 1];
    let total = 0, worst = 0;
    for (let i = 0; i < history.length - 1; i++) {
      for (let k = 0; k < 8; k++) {
        const d = Math.abs(base[k] - history[i][k]);
        total += d;
        if (d > worst) worst = d;
      }
    }
    return { avg: total / ((history.length - 1) * 8), max: worst };
  }

  function solveLinear(A, b, n) {
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let i = 0; i < n; i++) {
      let piv = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
      if (Math.abs(M[piv][i]) < 1e-12) return null;
      const t = M[i]; M[i] = M[piv]; M[piv] = t;
      const d = M[i][i];
      for (let c = i; c <= n; c++) M[i][c] /= d;
      for (let r = 0; r < n; r++) {
        if (r === i) continue;
        const f = M[r][i];
        if (f === 0) continue;
        for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c];
      }
    }
    return M.map((row) => row[n]);
  }

  function homography(src, dst) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const x = src[i * 2], y = src[i * 2 + 1];
      const u = dst[i * 2], v = dst[i * 2 + 1];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      b.push(v);
    }
    const h = solveLinear(A, b, 8);
    if (!h) return null;
    for (let i = 0; i < 8; i++) if (!isFinite(h[i])) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  function applyHH(H, X, Y, W) {
    const w = H[6] * X + H[7] * Y + H[8] * W;
    return [(H[0] * X + H[1] * Y + H[2] * W) / w, (H[3] * X + H[4] * Y + H[5] * W) / w];
  }

  function invert3(h) {
    const a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], i = h[7], j = h[8];
    const A = e * j - f * i, B = -(d * j - f * g), C = d * i - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    return [
      A / det, (c * i - b * j) / det, (b * f - c * e) / det,
      B / det, (a * j - c * g) / det, (c * d - a * f) / det,
      C / det, (b * g - a * i) / det, (a * e - b * d) / det
    ];
  }

  function outputSize(quad, maxDim, limit) {
    const dist = (a, b) => Math.hypot(quad[b * 2] - quad[a * 2], quad[b * 2 + 1] - quad[a * 2 + 1]);
    let outW = Math.max(dist(0, 1), dist(3, 2));
    let outH = Math.max(dist(0, 3), dist(1, 2));
    if (limit && (outW > limit || outH > limit)) {
      const k = limit / Math.max(outW, outH);
      outW *= k; outH *= k;
    }
    outW = Math.max(16, Math.round(outW));
    outH = Math.max(16, Math.round(outH));
    const max = maxDim || Infinity;
    if (Math.max(outW, outH) > max) {
      const k = max / Math.max(outW, outH);
      outW = Math.max(16, Math.round(outW * k));
      outH = Math.max(16, Math.round(outH * k));
    }
    return { w: outW, h: outH };
  }

  function bilinear(rgba, w, h, x, y) {
    let x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    let x1 = x0 + 1, y1 = y0 + 1;
    x0 = clamp(x0, 0, w - 1); x1 = clamp(x1, 0, w - 1);
    y0 = clamp(y0, 0, h - 1); y1 = clamp(y1, 0, h - 1);
    const p00 = (y0 * w + x0) * 4, p10 = (y0 * w + x1) * 4, p01 = (y1 * w + x0) * 4, p11 = (y1 * w + x1) * 4;
    const r = [0, 0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const top = rgba[p00 + c] * (1 - fx) + rgba[p10 + c] * fx;
      const bot = rgba[p01 + c] * (1 - fx) + rgba[p11 + c] * fx;
      r[c] = top * (1 - fy) + bot * fy;
    }
    return r;
  }

  function warp(rgba, w, h, quad, outW, outH) {
    const dst = [0, 0, outW, 0, outW, outH, 0, outH];
    const H = homography(dst, quad);
    if (!H) return null;
    const out = new Uint8ClampedArray(outW * outH * 4);
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const p = applyH(H, x + 0.5, y + 0.5);
        const o = (y * outW + x) * 4;
        if (p[0] < -2 || p[1] < -2 || p[0] > w + 2 || p[1] > h + 2) {
          out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = 255;
          continue;
        }
        const c = bilinear(rgba, w, h, clamp(p[0], 0, w - 1), clamp(p[1], 0, h - 1));
        out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
      }
    }
    return out;
  }

  function rotateRGBA(rgba, w, h, deg) {
    const d = ((deg % 360) + 360) % 360;
    if (d === 0) return { rgba, w, h };
    if (d === 180) {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 4, t = ((h - 1 - y) * w + (w - 1 - x)) * 4;
        out[t] = rgba[s]; out[t + 1] = rgba[s + 1]; out[t + 2] = rgba[s + 2]; out[t + 3] = rgba[s + 3];
      }
      return { rgba: out, w, h };
    }
    const nw = d === 90 ? h : w;
    const nh = d === 90 ? w : h;
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 4;
        let tx, ty;
        if (d === 90) { tx = h - 1 - y; ty = x; } else { tx = y; ty = w - 1 - x; }
        const t = (ty * nw + tx) * 4;
        out[t] = rgba[s]; out[t + 1] = rgba[s + 1]; out[t + 2] = rgba[s + 2]; out[t + 3] = rgba[s + 3];
      }
    }
    return { rgba: out, w: nw, h: nh };
  }

  function rotateQuad(q, deg, w, h) {
    const d = ((deg % 360) + 360) % 360;
    if (d === 0) return q;
    let out = new Float32Array(8);
    for (let i = 0; i < 4; i++) {
      const x = q[i * 2], y = q[i * 2 + 1];
      let tx, ty;
      if (d === 90) { tx = h - y; ty = x; } else if (d === 180) { tx = w - x; ty = h - y; } else { tx = y; ty = w - x; }
      out[i * 2] = tx; out[i * 2 + 1] = ty;
    }
    return orderCorners(out);
  }

  function histPercentile(g, p) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < g.length; i++) hist[clamp(Math.round(g[i] * 255), 0, 255)]++;
    const want = g.length * p;
    let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= want) return i / 255; }
    return 1;
  }

  function downsamplePercentile(g, w, h, cw, ch, p) {
    const buckets = new Array(cw * ch);
    for (let i = 0; i < buckets.length; i++) buckets[i] = [];
    for (let y = 0; y < h; y++) {
      const cy = Math.min(ch - 1, Math.floor((y * ch) / h));
      for (let x = 0; x < w; x++) {
        const cx = Math.min(cw - 1, Math.floor((x * cw) / w));
        buckets[cy * cw + cx].push(g[y * w + x]);
      }
    }
    const out = new Float32Array(cw * ch);
    for (let i = 0; i < buckets.length; i++) {
      const arr = buckets[i];
      if (!arr.length) { out[i] = NaN; continue; }
      arr.sort((a, b) => a - b);
      out[i] = arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];
    }
    return out;
  }

  function fillHoles(field, width) {
    const n = field.length;
    let known = 0;
    for (let i = 0; i < n; i++) if (isFinite(field[i])) known++;
    if (!known) return null;
    if (known === n) return field;
    const out = Float32Array.from(field);
    for (let pass = 0; pass < 32; pass++) {
      let changed = false;
      for (let y = 0; y < n / width; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          if (isFinite(out[i])) continue;
          let sum = 0, cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= n / width) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= width) continue;
              const v = out[yy * width + xx];
              if (isFinite(v)) { sum += v; cnt++; }
            }
          }
          if (cnt) { out[i] = sum / cnt; changed = true; }
        }
      }
      if (!changed) break;
    }
    let left = 0;
    for (let i = 0; i < n; i++) if (!isFinite(out[i])) left++;
    if (left) return null;
    return out;
  }

  function illuminationField(g, w, h, cell, level) {
    const cs = cell || Math.max(8, Math.round(Math.min(w, h) / 12));
    const cw = Math.max(2, Math.ceil(w / cs));
    const chh = Math.max(2, Math.ceil(h / cs));
    let field = downsamplePercentile(g, w, h, cw, chh, level == null ? 0.8 : level);
    if (!field) return null;
    field = fillHoles(field, cw);
    if (!field) return null;
    const smooth = boxBlur(field, cw, chh, 2);
    for (let i = 0; i < smooth.length; i++) if (!isFinite(smooth[i]) || smooth[i] < 1e-6) smooth[i] = field[i];
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const fy = ((y + 0.5) * chh) / h - 0.5;
      const y0 = clamp(Math.floor(fy), 0, chh - 1);
      const y1 = clamp(y0 + 1, 0, chh - 1);
      const ty = clamp(fy - y0, 0, 1);
      for (let x = 0; x < w; x++) {
        const fx = ((x + 0.5) * cw) / w - 0.5;
        const x0 = clamp(Math.floor(fx), 0, cw - 1);
        const x1 = clamp(x0 + 1, 0, cw - 1);
        const tx = clamp(fx - x0, 0, 1);
        const a = smooth[y0 * cw + x0], b = smooth[y0 * cw + x1];
        const c = smooth[y1 * cw + x0], d = smooth[y1 * cw + x1];
        out[y * w + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
      }
    }
    return out;
  }

  function removeShadow(g, w, h) {
    const pair = shadowPair(g, w, h);
    return pair.flat;
  }

  function shadowPair(g, w, h) {
    const bg = illuminationField(g, w, h);
    if (!bg) return { bg: null, flat: g };
    const flat = new Float32Array(g.length);
    for (let i = 0; i < g.length; i++) {
      const b = bg[i];
      flat[i] = b > 1e-6 ? clamp(g[i] / b, 0, 1.3) : g[i];
    }
    return { bg, flat };
  }

  function grayPercentile(f, p) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < f.length; i++) hist[clamp(Math.round(f[i] * 255), 0, 255)]++;
    const want = f.length * p;
    let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= want) return i / 255; }
    return 1;
  }

  function applyLevels(g, lo, hi) {
    const span = Math.max(0.02, hi - lo);
    const out = new Float32Array(g.length);
    for (let i = 0; i < g.length; i++) out[i] = clamp((g[i] - lo) / span, 0, 1);
    return out;
  }

  function adaptiveThreshold(g, w, h, radius, k, offset) {
    const mean = boxBlur(g, w, h, radius);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      const thr = mean[i] * (k == null ? 0.86 : k) - (offset == null ? 0.08 : offset);
      const v = g[i] < thr ? 0 : 255;
      out[p] = out[p + 1] = out[p + 2] = v;
      out[p + 3] = 255;
    }
    return out;
  }

  const FILTERS = [
    { id: "original", label: "Original", hint: "entzerren & zuschneiden, unverändert" },
    { id: "color", label: "Farbe" },
    { id: "clear", label: "Klar", hint: "ClearScan-Art: weisses Papier, glatter Text" },
    { id: "document", label: "Dokument" },
    { id: "bw", label: "Schwarzweiß" }
  ];

  function despeckle(cov, w, h, maxArea, maxDim) {
    const n = cov.length;
    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    const comp = new Int32Array(maxArea + 1);
    for (let s = 0; s < n; s++) {
      if (seen[s] || cov[s] <= 0.5) continue;
      let top = 0;
      stack[top++] = s;
      seen[s] = 1;
      let count = 0, minX = w, minY = h, maxX = 0, maxY = 0;
      while (top > 0) {
        const q = stack[--top];
        if (count <= maxArea) comp[count] = q;
        count++;
        const x = q % w, y = (q / w) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x > 0 && !seen[q - 1] && cov[q - 1] > 0.5) { seen[q - 1] = 1; stack[top++] = q - 1; }
        if (x < w - 1 && !seen[q + 1] && cov[q + 1] > 0.5) { seen[q + 1] = 1; stack[top++] = q + 1; }
        if (y > 0 && !seen[q - w] && cov[q - w] > 0.5) { seen[q - w] = 1; stack[top++] = q - w; }
        if (y < h - 1 && !seen[q + w] && cov[q + w] > 0.5) { seen[q + w] = 1; stack[top++] = q + w; }
      }
      const small =
        count <= maxArea && maxX - minX + 1 <= maxDim && maxY - minY + 1 <= maxDim;
      if (small) for (let i = 0; i < count; i++) cov[comp[i]] = 0;
    }
    return cov;
  }

  function applyFilter(rgba, w, h, id, params) {
    const out = new Uint8ClampedArray(w * h * 4);
    const p = params || {};

    const g = luma(rgba, w, h);

  if (id === "original") {
    out.set(rgba);
    return out;
  }

    if (id === "clear") {
      const flat = removeShadow(g, w, h);
      const paper = grayPercentile(flat, p.paper == null ? 0.97 : p.paper);
      const ink = grayPercentile(flat, p.ink == null ? 0.02 : p.ink);
      const span = Math.max(0.06, paper - ink);
      const floor = p.floor == null ? 0.08 : p.floor;
      const cov = new Float32Array(flat.length);
      for (let i = 0; i < flat.length; i++) {
        const a = clamp((paper - flat[i]) / span, 0, 1);
        cov[i] = floor > 0 ? clamp((a - floor) / (1 - floor), 0, 1) : a;
      }
      const maxArea = p.speckArea == null ? 4 : p.speckArea;
      if (maxArea > 0) despeckle(cov, w, h, maxArea, p.speckSize == null ? 3 : p.speckSize);
      const radius = p.smooth == null ? 1 : p.smooth;
      const sm = radius > 0 ? boxBlur(cov, w, h, radius) : cov;
      const gain = p.gain == null ? 1.04 : p.gain;
      for (let i = 0, k = 0; i < sm.length; i++, k += 4) {
        const a = clamp(sm[i] * gain, 0, 1);
        const v = (1 - a) * 255;
        out[k] = out[k + 1] = out[k + 2] = v;
        out[k + 3] = 255;
      }
      return out;
    }

    if (id === "color") {
      const sat = p.saturation == null ? 1.32 : p.saturation;
      const con = p.contrast == null ? 1.12 : p.contrast;
      const pair = shadowPair(g, w, h);
      const bg = pair.bg, lum = pair.flat;
      const hi = Math.min(1, grayPercentile(lum, p.whitePoint == null ? 0.98 : p.whitePoint));
      const chanHi = [hi, hi, hi];
      for (let c = 0; c < 3; c++) {
        const flatC = new Float32Array(g.length);
        for (let i = 0; i < g.length; i++) {
          flatC[i] = bg && bg[i] > 1e-6 ? clamp(rgba[i * 4 + c] / 255 / bg[i], 0, 1.3) : rgba[i * 4 + c] / 255;
        }
        chanHi[c] = Math.min(1.3, Math.max(0.05, grayPercentile(flatC, 0.98)));
      }
      for (let i = 0, k = 0; i < lum.length; i++, k += 4) {
        const l = clamp(lum[i] / hi, 0, 1);
        const lc = clamp((l - 0.5) * con + 0.5, 0, 1);
        for (let c = 0; c < 3; c++) {
          const v = bg && bg[i] > 1e-6 ? clamp(rgba[k + c] / 255 / bg[i] / chanHi[c], 0, 1) : rgba[k + c] / 255;
          out[k + c] = clamp((lc + (v - lc) * sat) * 255, 0, 255);
        }
        out[k + 3] = 255;
      }
      return out;
    }

    if (id === "document") {
      const flat = removeShadow(g, w, h);
      const lo = grayPercentile(flat, 0.012);
      const hi = Math.min(1, grayPercentile(flat, 0.97));
      const lev = applyLevels(flat, lo, hi);
      const conv = p.contrast == null ? 1.16 : p.contrast;
      for (let i = 0; i < lev.length; i++) lev[i] = clamp((lev[i] - 0.5) * conv + 0.5, 0, 1);
      for (let i = 0, k = 0; i < lev.length; i++, k += 4) {
        const v = lev[i] * 255;
        out[k] = out[k + 1] = out[k + 2] = v;
        out[k + 3] = 255;
      }
      return out;
    }

    if (id === "bw") {
      const flat = removeShadow(g, w, h);
      const hi = grayPercentile(flat, 0.97);
      for (let i = 0; i < flat.length; i++) flat[i] = clamp(flat[i] / hi, 0, 1);
      const cut = p.bw == null ? 0.5 : p.bw;
      const radius = Math.max(3, Math.round(Math.min(w, h) * (p.bwRadius == null ? 0.03 : p.bwRadius)));
      const spread = p.threshold == null ? 0.14 : p.threshold;
      const thr = grayPercentile(flat, spread);
      const k = clamp(0.78 + (cut - 0.5) * 0.24, 0.6, 0.98);
      return adaptiveThreshold(flat, w, h, radius, k, thr * (1 - k));
    }

    out.set(rgba);
    return out;
  }

  const Vision = {
    clamp, luma, grayToRgba, boxBlur, sobel, otsu, edgeBinary, downsampleAvg, morph,
    traceBoundary, traceContours, polyArea, hullOf, bestQuad, orderCorners, quadArea,
    quadPerimeter, quadQuality, detectQuad, varianceOfLaplacian, deviation, homography,
    applyH, applyHH, invert3, outputSize, warp, rotateRGBA, rotateQuad, histPercentile,
    grayPercentile, applyLevels, downsamplePercentile, fillHoles, illuminationField,
    shadowPair, removeShadow, despeckle, adaptiveThreshold, applyFilter, FILTERS
  };

  if (typeof module !== "undefined" && module.exports) module.exports = Vision;
  if (typeof window !== "undefined") window.Vision = Vision;
})(typeof window !== "undefined" ? window : globalThis);
