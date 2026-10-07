// vision.js — pure image math for Polaroid Scan.
// No DOM access: runs identically in the main thread, a Worker, or node (tests).
//
// Pipeline:
//   1. detectBorder()      find the white print border as a true quadrilateral (sub-pixel edges)
//   2. solveHomography()   per-frame dst-rect -> src-quad mapping
//   3. refineAlignment()   multi-scale NCC alignment of every frame against a glare-free median
//   4. fuseAligned()       robust per-pixel fusion that drops specular (bright) outliers
//   5. refineInnerCrop()   locate the image area inside the border on the fused result

// ---------------------------------------------------------------- basics

export function rgbaToLuma(data, n, out) {
  out = out || new Uint8Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) out[p] = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) >> 8;
  return out;
}

export function solveLinear(A, b) {
  // Gaussian elimination with partial pivoting. A: n×n (array of rows), b: n.
  const n = b.length;
  const M = A.map((row, i) => row.concat(b[i]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error('singular');
    [M[col], M[piv]] = [M[piv], M[col]];
    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) if (r !== col) {
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map(r => r[n]);
}

// H maps src points -> dst points (x' = (h0 x + h1 y + h2)/(h6 x + h7 y + 1)).
// Exact for 4 correspondences; weighted least squares for more.
export function solveHomography(src, dst, weights) {
  const n = src.length;
  const rows = [], rhs = [], w = [];
  for (let i = 0; i < n; i++) {
    const sx = src[i].x, sy = src[i].y, dx = dst[i].x, dy = dst[i].y;
    const wi = weights ? weights[i] : 1;
    rows.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]); rhs.push(dx); w.push(wi);
    rows.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]); rhs.push(dy); w.push(wi);
  }
  let h;
  if (n === 4 && !weights) {
    h = solveLinear(rows, rhs);
  } else {
    // normal equations AᵀWA h = AᵀWb
    const M = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const v = new Array(8).fill(0);
    for (let r = 0; r < rows.length; r++) {
      const a = rows[r], wr = w[r];
      for (let i = 0; i < 8; i++) {
        const ai = a[i] * wr;
        if (ai === 0) continue;
        for (let j = 0; j < 8; j++) M[i][j] += ai * a[j];
        v[i] += ai * rhs[r];
      }
    }
    h = solveLinear(M, v);
  }
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyH(H, x, y) {
  const W = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / W, y: (H[3] * x + H[4] * y + H[5]) / W };
}

export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const inv = 1 / det;
  const r = [
    (e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
    (f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
    (d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ];
  const s = 1 / r[8];
  return r.map(v => v * s);
}

export function rectQuad(w, h) { return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]; }

export function quadDrift(a, b) {
  let s = 0;
  for (let i = 0; i < 4; i++) s += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
  return s / 4;
}

// ---------------------------------------------------------------- border detection

function percentile(hist, n, p) {
  let acc = 0; const target = n * p;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
  return 255;
}

function otsu(hist, n) {
  let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = v; }
  }
  return thr;
}

// Robust line fit. pts: [{u,v}] fit v = a*u + b with iterative outlier rejection.
function robustLine(pts) {
  let inl = pts;
  let a = 0, b = 0;
  for (let it = 0; it < 4; it++) {
    const n = inl.length; if (n < 4) return null;
    let su = 0, sv = 0, suu = 0, suv = 0;
    for (const p of inl) { su += p.u; sv += p.v; suu += p.u * p.u; suv += p.u * p.v; }
    const den = n * suu - su * su; if (Math.abs(den) < 1e-9) return null;
    a = (n * suv - su * sv) / den; b = (sv - a * su) / n;
    const res = inl.map(p => Math.abs(p.v - (a * p.u + b)));
    const sorted = res.slice().sort((x, y) => x - y);
    const mad = sorted[sorted.length >> 1];
    const thr = Math.max(1.2, 3 * mad);
    const next = inl.filter((p, i) => res[i] <= thr);
    if (next.length === inl.length) break;
    inl = next;
  }
  const finRes = inl.map(p => Math.abs(p.v - (a * p.u + b))).sort((x, y) => x - y);
  const spread = finRes.length ? finRes[finRes.length >> 1] : 9;
  return { a, b, inliers: inl.length / pts.length, n: inl.length, spread };
}

function intersectHV(hl, vl) {
  // hl: y = a1 x + b1 ; vl: x = a2 y + b2
  const x = (vl.a * hl.b + vl.b) / (1 - hl.a * vl.a);
  return { x, y: hl.a * x + hl.b };
}

// Detect the print border inside `region` of an 8-bit luma image.
// Three passes: bright ring (white borders), dark ring (black frames), then an
// edge-projection fallback (patterned borders) that needs opts.rgba for colour gradients.
// opts.seed = rough rect (guide) used to band the fallback search.
// Returns { quad:[{x,y}×4] (TL,TR,BR,BL in image px), score, thresh, inliers, mode, sharp } or null.
export function detectBorder(luma, W, H, opts) {
  const expected = opts.expectedRatio;
  const reg = {
    x: Math.max(0, Math.floor(opts.region.x)), y: Math.max(0, Math.floor(opts.region.y)),
  };
  reg.w = Math.min(W - reg.x, Math.floor(opts.region.w));
  reg.h = Math.min(H - reg.y, Math.floor(opts.region.h));
  if (reg.w < 40 || reg.h < 40) return null;
  const n = reg.w * reg.h;
  const hist = new Uint32Array(256);
  for (let y = 0; y < reg.h; y++) {
    const row = (reg.y + y) * W + reg.x;
    for (let x = 0; x < reg.w; x++) hist[luma[row + x]]++;
  }
  const p97 = percentile(hist, n, 0.97);
  const p03 = percentile(hist, n, 0.03);
  const ot = otsu(hist, n);
  const bright = [];
  for (const t of [p97 - 12, p97 - 28, p97 - 50, ot, (ot + p97) >> 1]) {
    const tt = Math.round(Math.min(250, Math.max(90, t)));
    if (!bright.includes(tt)) bright.push(tt);
  }
  bright.sort((a, b) => b - a);
  if (opts.lastThresh != null && bright.includes(opts.lastThresh)) {
    bright.splice(bright.indexOf(opts.lastThresh), 1); bright.unshift(opts.lastThresh);
  }
  const dark = [];
  for (const t of [p03 + 12, p03 + 30, p03 + 55, ot]) {
    const tt = Math.round(Math.min(170, Math.max(8, t)));
    if (!dark.includes(tt)) dark.push(tt);
  }
  dark.sort((a, b) => a - b);
  const scratch = opts.scratch || (opts.scratch = {});
  const dbg = opts.debug ? (...a) => console.log('[detect]', ...a) : null;
  let best = null;
  const consider = r => { if (r && (!best || r.score < best.score)) best = r; };
  for (const t of bright) {
    consider(findRing(luma, W, reg, t, expected, scratch, 1));
    if (best && best.score < 0.08) break;
  }
  if (dbg) dbg('after bright:', best ? `${best.mode} score ${best.score.toFixed(3)}` : 'none');
  if (!best || best.score > 0.12) {
    for (const t of dark) {
      consider(findRing(luma, W, reg, t, expected, scratch, -1));
      if (best && best.score < 0.08) break;
    }
    if (dbg) dbg('after dark:', best ? `${best.mode} score ${best.score.toFixed(3)}` : 'none');
  }
  // silhouette: the print as a whole vs a plain table, by colour distance from the table colour.
  // Catches borders whose luma is neither the brightest nor the darkest thing in view — metallic
  // (gold/silver foil) frames whose brightness swings with angle, coloured borders, etc.
  if (!best || best.score > 0.12) {
    const sil = opts.rgba && tableColour(opts.rgba, W, reg);
    if (sil) consider(findRing(luma, W, reg, sil.thr, expected, scratch, 2, sil, opts.rgba));
    if (dbg) dbg('after silhouette:', sil ? `bg ${sil.bg.map(Math.round)} thr ${sil.thr.toFixed(0)}` : 'no plain table', best ? `${best.mode} score ${best.score.toFixed(3)}` : 'none');
  }
  if (!best || best.score > 0.2) {
    consider(findByEdges(luma, opts.rgba, W, H, reg, expected, opts.seed, dbg));
    if (dbg) dbg('after edges:', best ? `${best.mode} score ${best.score.toFixed(3)}` : 'none');
  }
  // photo window: when the outer edge is invisible (black frame on a black table, foil reflecting
  // the table), find the picture itself and extend it outward by the format's border geometry
  const fr = opts.borders;
  if (fr && (!best || best.score > 0.25)) {
    consider(findViaWindow(luma, opts.rgba, W, H, reg, expected, fr, opts.seed, scratch, dbg));
    if (dbg) dbg('after window:', best ? `${best.mode} score ${best.score.toFixed(3)}` : 'none');
  }
  if (!best || best.score > 0.5) { if (dbg) dbg('REJECT final', best && best.score); return null; }
  if (fr && best.mode !== 'window') checkWithWindow(luma, opts.rgba, W, H, best, fr, expected, dbg);
  best.sharp = sharpnessInQuad(luma, W, H, best.quad);
  best.glare = glareStats(luma, W, H, best.quad);
  best.brightFrac = best.glare.frac;
  return best;
}

// Near-saturated pixels inside the quad: coverage fraction + centroid in normalized print
// coords (0..1 across the quad). The centroid trail tells the app whether the reflection is
// actually moving between captures — if not, the user needs to tilt a little.
export function glareStats(luma, W, H, quad) {
  const c = quadCenter(quad);
  const hw = Math.abs(quad[1].x - quad[0].x) * 0.42, hh = Math.abs(quad[3].y - quad[0].y) * 0.42;
  const x0 = Math.max(0, Math.floor(c.x - hw)), x1 = Math.min(W - 1, Math.ceil(c.x + hw));
  const y0 = Math.max(0, Math.floor(c.y - hh)), y1 = Math.min(H - 1, Math.ceil(c.y + hh));
  let on = 0, n = 0, sx = 0, sy = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    n++;
    if (luma[y * W + x] > 245) { on++; sx += x; sy += y; }
  }
  if (!n || !on) return { frac: 0, u: 0.5, v: 0.5 };
  let u = 0.5, v = 0.5;
  if (on >= 4) {
    try {
      const Hq = solveHomography(quad, rectQuad(1, 1));
      const p = applyH(Hq, sx / on + 0.5, sy / on + 0.5);
      u = Math.min(1, Math.max(0, p.x)); v = Math.min(1, Math.max(0, p.y));
    } catch { }
  }
  return { frac: on / n, u, v };
}

// Table colour = median RGB of a thin band around the region's perimeter, if that band is plain
// enough (most of it close to the median). Returns { bg, thr } or null.
function tableColour(rgba, W, reg) {
  const m = Math.max(2, Math.round(Math.min(reg.w, reg.h) * 0.03));
  const rs = [], gs = [], bs = [];
  const push = (x, y) => { const i = (y * W + x) * 4; rs.push(rgba[i]); gs.push(rgba[i + 1]); bs.push(rgba[i + 2]); };
  const sx = Math.max(1, Math.round(reg.w / 120)), sy = Math.max(1, Math.round(reg.h / 120));
  for (let d = 0; d < m; d += 2) {
    for (let x = reg.x; x < reg.x + reg.w; x += sx) { push(x, reg.y + d); push(x, reg.y + reg.h - 1 - d); }
    for (let y = reg.y; y < reg.y + reg.h; y += sy) { push(reg.x + d, y); push(reg.x + reg.w - 1 - d, y); }
  }
  const med = a => a.slice().sort((p, q) => p - q)[a.length >> 1];
  const bg = [med(rs), med(gs), med(bs)];
  const dist = rs.map((r, i) => Math.abs(r - bg[0]) + Math.abs(gs[i] - bg[1]) + Math.abs(bs[i] - bg[2])).sort((p, q) => p - q);
  const d50 = dist[dist.length >> 1], d80 = dist[Math.floor(dist.length * 0.8)];
  if (d80 > 60) return null; // busy/patterned surface, or the print fills the frame
  return { bg, thr: Math.max(30, 2.5 * d80, 5 * d50) };
}

// pol: 1 = bright ring (white border), -1 = dark ring (black frame),
// 2 = silhouette: mask = colour far from the table colour sil.bg (needs rgba).
function findRing(luma, W, reg, t, expected, scratch, pol, sil = null, rgba = null) {
  const rw = reg.w, rh = reg.h, n = rw * rh;
  if (!scratch.mask || scratch.mask.length < n) {
    scratch.mask = new Uint8Array(n); scratch.label = new Int32Array(n); scratch.stack = new Int32Array(n);
  }
  const mask = scratch.mask, label = scratch.label, stack = scratch.stack;
  for (let y = 0; y < rh; y++) {
    const row = (reg.y + y) * W + reg.x, o = y * rw;
    if (pol === 2) {
      const [br, bgc, bb] = sil.bg;
      for (let x = 0; x < rw; x++) {
        const i = (row + x) * 4;
        mask[o + x] = Math.abs(rgba[i] - br) + Math.abs(rgba[i + 1] - bgc) + Math.abs(rgba[i + 2] - bb) > t ? 1 : 0;
      }
    } else for (let x = 0; x < rw; x++) mask[o + x] = (pol > 0 ? luma[row + x] > t : luma[row + x] < t) ? 1 : 0;
  }
  label.fill(-1, 0, n);
  const comps = [];
  let nc = 0;
  const minArea = 0.03 * n;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    let sp = 0; stack[sp++] = s; label[s] = nc;
    let area = 0, minX = rw, maxX = 0, minY = rh, maxY = 0;
    let tl = s, tr = s, br = s, bl = s, tlv = 1e9, trv = -1e9, brv = -1e9, blv = 1e9;
    while (sp > 0) {
      const p = stack[--sp]; area++;
      const y = (p / rw) | 0, x = p - y * rw;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      const a = x + y, b = x - y;
      if (a < tlv) { tlv = a; tl = p; } if (a > brv) { brv = a; br = p; }
      if (b > trv) { trv = b; tr = p; } if (b < blv) { blv = b; bl = p; }
      if (x > 0) { const q = p - 1; if (mask[q] && label[q] < 0) { label[q] = nc; stack[sp++] = q; } }
      if (x < rw - 1) { const q = p + 1; if (mask[q] && label[q] < 0) { label[q] = nc; stack[sp++] = q; } }
      if (y > 0) { const q = p - rw; if (mask[q] && label[q] < 0) { label[q] = nc; stack[sp++] = q; } }
      if (y < rh - 1) { const q = p + rw; if (mask[q] && label[q] < 0) { label[q] = nc; stack[sp++] = q; } }
    }
    if (area >= minArea) comps.push({ id: nc, area, minX, maxX, minY, maxY, tl, tr, br, bl });
    nc++;
  }
  let best = null;
  for (const c of comps) {
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    if (bw < 0.22 * rw || bh < 0.22 * rh) continue;
    if (bw > 0.985 * rw && bh > 0.985 * rh) continue; // background
    const P = p => ({ x: p % rw, y: (p / rw) | 0 });
    const TL = P(c.tl), TR = P(c.tr), BR = P(c.br), BL = P(c.bl);
    if (TR.x - TL.x < 0.15 * rw || BR.x - BL.x < 0.15 * rw || BL.y - TL.y < 0.15 * rh || BR.y - TR.y < 0.15 * rh) continue;
    const lumaAt = (x, y) => luma[(reg.y + y) * W + reg.x + x];
    const id = c.id;
    const sub = (off, on) => { // sub-pixel crossing of t between the off pixel and the on pixel
      if (pol === 2) return 0.5; // colour mask: the gradient refinement below does the sub-pixel work
      const d = on - off; return Math.abs(d) > 1e-3 ? Math.min(1, Math.max(0, (t - off) / d)) : 0.5;
    };
    // boundary samples — scan inward from the bbox edge for first pixel of this component
    const top = [], bottom = [], left = [], right = [];
    const yLimT = Math.min(rh - 1, Math.max(TL.y, TR.y) + Math.floor(0.3 * bh));
    const yLimB = Math.max(0, Math.min(BL.y, BR.y) - Math.floor(0.3 * bh));
    const xLimL = Math.min(rw - 1, Math.max(TL.x, BL.x) + Math.floor(0.3 * bw));
    const xLimR = Math.max(0, Math.min(TR.x, BR.x) - Math.floor(0.3 * bw));
    const step = Math.max(1, Math.floor(bw / 140));
    for (let x = Math.min(TL.x, BL.x); x <= Math.max(TR.x, BR.x); x += step) {
      for (let y = c.minY; y <= yLimT; y++) if (label[y * rw + x] === id) {
        const f = y > 0 ? sub(lumaAt(x, y - 1), lumaAt(x, y)) : 0.5;
        top.push({ u: x + 0.5, v: (y - 0.5) + f }); break;
      }
      for (let y = c.maxY; y >= yLimB; y--) if (label[y * rw + x] === id) {
        const f = y < rh - 1 ? sub(lumaAt(x, y + 1), lumaAt(x, y)) : 0.5;
        bottom.push({ u: x + 0.5, v: (y + 1.5) - f }); break;
      }
    }
    const stepY = Math.max(1, Math.floor(bh / 140));
    for (let y = Math.min(TL.y, TR.y); y <= Math.max(BL.y, BR.y); y += stepY) {
      for (let x = c.minX; x <= xLimL; x++) if (label[y * rw + x] === id) {
        const f = x > 0 ? sub(lumaAt(x - 1, y), lumaAt(x, y)) : 0.5;
        left.push({ u: y + 0.5, v: (x - 0.5) + f }); break;
      }
      for (let x = c.maxX; x >= xLimR; x--) if (label[y * rw + x] === id) {
        const f = x < rw - 1 ? sub(lumaAt(x + 1, y), lumaAt(x, y)) : 0.5;
        right.push({ u: y + 0.5, v: (x + 1.5) - f }); break;
      }
    }
    const lt = robustLine(top), lb = robustLine(bottom), ll = robustLine(left), lr = robustLine(right);
    if (!lt || !lb || !ll || !lr) continue;
    let q = [intersectHV(lt, ll), intersectHV(lt, lr), intersectHV(lb, lr), intersectHV(lb, ll)];
    if (q.some(p => !isFinite(p.x) || !isFinite(p.y))) continue;
    // refine every edge on the luma gradient (threshold-independent, sub-pixel)
    const qImg = q.map(p => ({ x: p.x + reg.x, y: p.y + reg.y }));
    let refined;
    if (pol === 2) { // silhouette edge may be a luma step or only a colour step: keep the tighter fit
      const rc = refineQuadByGradient(luma, W, luma.length / W, qImg, 0, rgba), rl = refineQuadByGradient(luma, W, luma.length / W, qImg, 0);
      refined = !rc ? rl : !rl ? rc : (rl.spread - rl.inliers < rc.spread - rc.inliers ? rl : rc);
    } else refined = refineQuadByGradient(luma, W, luma.length / W, qImg, pol);
    if (refined) q = refined.quad.map(p => ({ x: p.x - reg.x, y: p.y - reg.y }));
    // band check: just inside each edge must be "on" (bright border), just outside must be darker
    const band = pol === 2 ? silBandCheck(rgba, W, luma.length / W, q.map(p => ({ x: p.x + reg.x, y: p.y + reg.y })), sil)
      : bandCheck(luma, W, luma.length / W, q.map(p => ({ x: p.x + reg.x, y: p.y + reg.y })), t, pol);
    if (band.insideFrac < 0.7 || band.contrast < 5) continue;
    // geometry sanity: convex-ish, angles in [60°,120°]
    let okGeom = true;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], d = q[(i + 3) % 4];
      const v1x = b.x - a.x, v1y = b.y - a.y, v2x = d.x - a.x, v2y = d.y - a.y;
      const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) + 1e-9);
      if (Math.abs(cos) > 0.5) okGeom = false;
    }
    if (!okGeom) continue;
    const wTop = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), wBot = Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y);
    const hL = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y), hR = Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y);
    const ratio = (wTop + wBot) / (hL + hR);
    const errA = Math.abs(ratio - expected) / expected;
    const errB = Math.abs(ratio - 1 / expected) * expected;
    const rotated = errB < errA;
    const ratioErr = Math.min(errA, errB);
    if (ratioErr > 0.25) continue;
    // ring check: the centre of a print is the photo, not white
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    const hw = 0.2 * (wTop + wBot) / 2, hh = 0.2 * (hL + hR) / 2;
    let on = 0, tot = 0;
    for (let y = Math.max(0, Math.floor(cy - hh)); y < Math.min(rh, cy + hh); y += 2)
      for (let x = Math.max(0, Math.floor(cx - hw)); x < Math.min(rw, cx + hw); x += 2) { tot++; if (mask[y * rw + x]) on++; }
    const centerFill = tot ? on / tot : 1;
    const inliers = refined ? refined.inliers : (lt.inliers + lb.inliers + ll.inliers + lr.inliers) / 4;
    const qImg2 = q.map(p => ({ x: p.x + reg.x, y: p.y + reg.y }));
    const interior = interiorPenalty(luma, W, luma.length / W, qImg2);
    // a silhouette is solid by design (the photo differs from the table too), so no ring check;
    // the small constant keeps a genuine bright/dark ring preferred when both exist
    const fillPen = pol === 2 ? 0.06 : Math.max(0, centerFill - 0.2) * 0.8;
    const score = ratioErr * 1.5 + (1 - inliers) * 0.6 + fillPen + (1 - band.insideFrac) * 0.5 + interior;
    if (!best || score < best.score) {
      best = {
        quad: q.map(p => ({ x: p.x + reg.x, y: p.y + reg.y })),
        score, thresh: pol === 2 ? -2 : t, inliers, centerFill, ratio, band, rotated, mode: pol === 2 ? 'silhouette' : pol > 0 ? 'ring-bright' : 'ring-dark',
      };
    }
  }
  return best;
}

function sampleLuma(luma, W, H, x, y) {
  const sx = x - 0.5, sy = y - 0.5;
  const ix = Math.max(0, Math.min(W - 2, Math.floor(sx))), iy = Math.max(0, Math.min(H - 2, Math.floor(sy)));
  const fx = Math.min(1, Math.max(0, sx - ix)), fy = Math.min(1, Math.max(0, sy - iy));
  const i = iy * W + ix;
  return (luma[i] * (1 - fx) + luma[i + 1] * fx) * (1 - fy) + (luma[i + W] * (1 - fx) + luma[i + W + 1] * fx) * fy;
}

function sampleRGB(rgba, W, H, x, y, out) {
  const sx = x - 0.5, sy = y - 0.5;
  const ix = Math.max(0, Math.min(W - 2, Math.floor(sx))), iy = Math.max(0, Math.min(H - 2, Math.floor(sy)));
  const fx = Math.min(1, Math.max(0, sx - ix)), fy = Math.min(1, Math.max(0, sy - iy));
  const i = (iy * W + ix) * 4, j = i + W * 4;
  for (let c = 0; c < 3; c++) {
    out[c] = (rgba[i + c] * (1 - fx) + rgba[i + 4 + c] * fx) * (1 - fy) + (rgba[j + c] * (1 - fx) + rgba[j + 4 + c] * fx) * fy;
  }
  return out;
}

function quadCenter(q) { return { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 }; }

// For each side, walk along it and find the strongest step along the outward normal.
// pol: 1 = inside brighter than outside, -1 = inside darker, 0 = patterned mode — unsigned COLOUR
// steps (rgba required) with outermost-step preference, since pattern edges flip polarity and can
// vanish in luma while staying strong in colour.
// Fit a robust line through those edge points; intersect adjacent lines.
// o.hw overrides the search half-width; o.strongest takes the strongest colour step instead of the
// outermost (for the photo window, whose edge sits between the border and the picture).
function refineQuadByGradient(luma, W, H, q, pol = 1, rgba = null, o = {}) {
  const colorMode = pol === 0 && !!rgba;
  const c = quadCenter(q);
  const size = Math.min(Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y));
  const hw = o.hw || Math.max(3, Math.min(12, Math.round(size * 0.03)));
  const lines = [];
  let inlSum = 0, strSum = 0;

  function fitSide(p0, p1, sidePol, outermost, hwArg) {
    const hwS = hwArg || hw;
    const L = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    let nx = -(p1.y - p0.y) / L, ny = (p1.x - p0.x) / L; // normal pointing away from centre
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    if ((mx - c.x) * nx + (my - c.y) * ny < 0) { nx = -nx; ny = -ny; }
    const N = Math.max(24, Math.min(120, Math.round(L / 4)));
    const pts = [];
    let strength = 0;
    const P = 2 * hwS + 3;
    const prof = new Float32Array(P * 3);
    const step = new Float32Array(P);
    const px3 = [0, 0, 0];
    for (let s = 0; s < N; s++) {
      const t = (s + 0.5) / N;
      if (t < 0.04 || t > 0.96) continue; // stay clear of corners
      const px = p0.x + (p1.x - p0.x) * t, py = p0.y + (p1.y - p0.y) * t;
      let lo = 1e9, hi = -1e9;
      for (let d = -hwS - 1; d <= hwS + 1; d++) {
        const k = d + hwS + 1;
        if (colorMode) {
          sampleRGB(rgba, W, H, px + nx * d, py + ny * d, px3);
          prof[k * 3] = px3[0]; prof[k * 3 + 1] = px3[1]; prof[k * 3 + 2] = px3[2];
          const v = 0.299 * px3[0] + 0.587 * px3[1] + 0.114 * px3[2];
          if (v < lo) lo = v; if (v > hi) hi = v;
        } else {
          const v = sampleLuma(luma, W, H, px + nx * d, py + ny * d);
          prof[k * 3] = v; if (v < lo) lo = v; if (v > hi) hi = v;
        }
      }
      // step profile: signed luma step, or unsigned colour step in colour mode
      let maxStep = 0;
      for (let d = -hwS; d <= hwS; d++) {
        const k = d + hwS + 1;
        if (colorMode) {
          step[k] = Math.abs(prof[(k - 1) * 3] - prof[(k + 1) * 3]) + Math.abs(prof[(k - 1) * 3 + 1] - prof[(k + 1) * 3 + 1]) + Math.abs(prof[(k - 1) * 3 + 2] - prof[(k + 1) * 3 + 2]);
        } else {
          step[k] = (prof[(k - 1) * 3] - prof[(k + 1) * 3]) * sidePol;
        }
        if (step[k] > maxStep) maxStep = step[k];
      }
      if (colorMode ? maxStep < 12 : hi - lo < 6) continue;
      let bestD = 0, bestG = 0;
      for (let d = -hwS; d <= hwS; d++) {
        const g = step[d + hwS + 1];
        if (g > bestG) { bestG = g; bestD = d; }
      }
      if (!colorMode && bestG < Math.max(4, 0.3 * (hi - lo))) continue; // colour mode already gated on maxStep
      if (outermost) {
        // patterned borders have strong internal edges; the print edge is the OUTERMOST strong step
        const thr = Math.max(colorMode ? 12 : 5, 0.45 * bestG);
        for (let d = hwS; d >= -hwS; d--) {
          if (step[d + hwS + 1] >= thr) { bestD = d; bestG = step[d + hwS + 1]; break; }
        }
      }
      // sub-pixel parabola on the step profile
      let dd = bestD;
      if (bestD > -hwS && bestD < hwS) {
        const gl = step[bestD + hwS], gr = step[bestD + hwS + 2];
        const den = gl - 2 * bestG + gr;
        if (den < 0) dd += 0.5 * (gl - gr) / den;
      }
      pts.push({ u: t * L, v: dd });
      strength += bestG;
    }
    const fit = robustLine(pts);
    if (!fit) return null;
    return { ...fit, strength: pts.length ? strength / pts.length : 0, nx, ny, L, pol: sidePol };
  }

  let spreadSum = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = q[i], p1 = q[(i + 1) % 4];
    let fit;
    if (colorMode) {
      fit = fitSide(p0, p1, 1, !o.strongest); // colour steps are unsigned; polarity arg unused
    } else if (pol === 0) {
      const fp = fitSide(p0, p1, 1, true), fm = fitSide(p0, p1, -1, true);
      fit = !fp ? fm : !fm ? fp : (fm.n > fp.n || (fm.n === fp.n && fm.strength > fp.strength) ? fm : fp);
    } else {
      fit = fitSide(p0, p1, pol);
    }
    if (!fit || fit.n < 8) return null;
    strSum += fit.strength;
    // line from pass 1
    let b0 = { x: p0.x + fit.nx * fit.b, y: p0.y + fit.ny * fit.b };
    let b1 = { x: p1.x + fit.nx * (fit.a * fit.L + fit.b), y: p1.y + fit.ny * (fit.a * fit.L + fit.b) };
    // pass 2: refit in a narrow window around that line — weak-but-real edge steps are no longer
    // out-competed by nearby strong pattern edges, so far more points survive
    const fit2 = fitSide(b0, b1, fit.pol, false, 3);
    if (fit2 && fit2.n >= Math.max(8, fit.n * 0.8)) {
      const c0 = { x: b0.x + fit2.nx * fit2.b, y: b0.y + fit2.ny * fit2.b };
      const c1 = { x: b1.x + fit2.nx * (fit2.a * fit2.L + fit2.b), y: b1.y + fit2.ny * (fit2.a * fit2.L + fit2.b) };
      b0 = c0; b1 = c1;
      inlSum += Math.max(fit.inliers, fit2.inliers);
      spreadSum += fit2.spread;
    } else {
      inlSum += fit.inliers;
      spreadSum += fit.spread;
    }
    lines.push({ p: b0, d: { x: b1.x - b0.x, y: b1.y - b0.y } });
  }
  const X = (A, B) => {
    const den = A.d.x * B.d.y - A.d.y * B.d.x;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((B.p.x - A.p.x) * B.d.y - (B.p.y - A.p.y) * B.d.x) / den;
    return { x: A.p.x + A.d.x * t, y: A.p.y + A.d.y * t };
  };
  const quad = [X(lines[3], lines[0]), X(lines[0], lines[1]), X(lines[1], lines[2]), X(lines[2], lines[3])];
  if (quad.some(p => !p || !isFinite(p.x) || !isFinite(p.y))) return null;
  // reject if refinement moved any corner absurdly far
  for (let i = 0; i < 4; i++) if (Math.hypot(quad[i].x - q[i].x, quad[i].y - q[i].y) > hw * 2.5) return null;
  return { quad, inliers: inlSum / 4, spread: spreadSum / 4, strength: strSum / 4 };
}

// Does another strong edge run parallel just OUTSIDE this quad? True for a quad locked onto the
// image area (the real border->table edge lies outside it); false for the true outer edge (table beyond).
// A side counts only if most probe points find a strong step at a consistent distance.
function interiorPenalty(luma, W, H, q) {
  const c = quadCenter(q);
  const size = Math.min(Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y));
  const d0 = Math.max(3, size * 0.035), d1 = size * 0.30;
  let edgedSides = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = q[i], p1 = q[(i + 1) % 4];
    const L = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    let nx = -(p1.y - p0.y) / L, ny = (p1.x - p0.x) / L;
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    if ((mx - c.x) * nx + (my - c.y) * ny < 0) { nx = -nx; ny = -ny; }
    const dists = [];
    for (let sp = 0; sp < 10; sp++) {
      const t = 0.15 + 0.7 * (sp + 0.5) / 10;
      const px = p0.x + (p1.x - p0.x) * t, py = p0.y + (p1.y - p0.y) * t;
      let bestStep = 0, bestD = 0;
      for (let d = d0; d <= d1; d += 1) {
        const step = Math.abs(sampleLuma(luma, W, H, px + nx * (d + 2), py + ny * (d + 2)) - sampleLuma(luma, W, H, px + nx * (d - 2), py + ny * (d - 2)));
        if (step > bestStep) { bestStep = step; bestD = d; }
      }
      if (bestStep >= 18) dists.push(bestD);
    }
    if (dists.length >= 6) {
      dists.sort((a, b) => a - b);
      const med = dists[dists.length >> 1];
      const devs = dists.map(d => Math.abs(d - med)).sort((a, b) => a - b);
      if (devs[devs.length >> 1] <= Math.max(4, 0.25 * med)) edgedSides++;
    }
  }
  return edgedSides >= 3 ? 0.5 : 0;
}

// Fraction of samples just inside the quad on the border side of t, and inside-vs-outside contrast
// signed so that positive always means "border side is border-like" for the given polarity.
function bandCheck(luma, W, H, q, t, pol = 1) {
  const c = quadCenter(q);
  const size = Math.min(Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y));
  const off = Math.max(2.5, Math.min(8, size * 0.02));
  let on = 0, tot = 0, inSum = 0, outSum = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = q[i], p1 = q[(i + 1) % 4];
    const L = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    let nx = -(p1.y - p0.y) / L, ny = (p1.x - p0.x) / L;
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    if ((mx - c.x) * nx + (my - c.y) * ny < 0) { nx = -nx; ny = -ny; }
    for (let s = 0; s < 24; s++) {
      const tt = 0.06 + 0.88 * (s + 0.5) / 24;
      const px = p0.x + (p1.x - p0.x) * tt, py = p0.y + (p1.y - p0.y) * tt;
      const vin = sampleLuma(luma, W, H, px - nx * off, py - ny * off);
      const vout = sampleLuma(luma, W, H, px + nx * off, py + ny * off);
      tot++; if (pol > 0 ? vin > t : vin < t) on++; inSum += vin; outSum += vout;
    }
  }
  return { insideFrac: on / tot, contrast: (inSum - outSum) / tot * (pol > 0 ? 1 : -1) };
}

// bandCheck for silhouettes: just inside each edge must be far from the table colour, just outside near it.
function silBandCheck(rgba, W, H, q, sil) {
  const c = quadCenter(q);
  const size = Math.min(Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y));
  const off = Math.max(2.5, Math.min(8, size * 0.02));
  const px3 = [0, 0, 0];
  const dist = (x, y) => { sampleRGB(rgba, W, H, x, y, px3); return Math.abs(px3[0] - sil.bg[0]) + Math.abs(px3[1] - sil.bg[1]) + Math.abs(px3[2] - sil.bg[2]); };
  let on = 0, tot = 0, inSum = 0, outSum = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = q[i], p1 = q[(i + 1) % 4];
    const L = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    let nx = -(p1.y - p0.y) / L, ny = (p1.x - p0.x) / L;
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    if ((mx - c.x) * nx + (my - c.y) * ny < 0) { nx = -nx; ny = -ny; }
    for (let s = 0; s < 24; s++) {
      const tt = 0.06 + 0.88 * (s + 0.5) / 24;
      const px = p0.x + (p1.x - p0.x) * tt, py = p0.y + (p1.y - p0.y) * tt;
      const din = dist(px - nx * off, py - ny * off), dout = dist(px + nx * off, py + ny * off);
      tot++; if (din > sil.thr && dout < sil.thr) on++; inSum += din; outSum += dout;
    }
  }
  return { insideFrac: on / tot, contrast: (inSum - outSum) / tot };
}

// Fallback for patterned/low-contrast borders: for each side, search (offset × slope) candidate
// lines over the colour gradient inside a band around the guide, keep the OUTERMOST strong line,
// intersect them into a seed quad, then refine each edge sub-pixel with per-side polarity.
// Handles tilted prints (unlike axis projections, which smear tilted edges). Needs rgba.
function findByEdges(luma, rgba, W, H, reg, expected, seed, dbg) {
  if (!rgba) return null;
  const s = seed && seed.w > 40 && seed.h > 40 ? seed : { x: reg.x + reg.w * 0.15, y: reg.y + reg.h * 0.15, w: reg.w * 0.7, h: reg.h * 0.7 };
  const SLOPES = [-0.12, -0.09, -0.06, -0.03, 0, 0.03, 0.06, 0.09, 0.12];
  const NS = 30;
  // axis 'v': near-vertical line x = off + slope·(y−cMid), scored by horizontal colour gradient.
  // axis 'h': near-horizontal line y = off + slope·(x−cMid).
  function lineSearch(axis, offLo, offHi, cLo, cHi, outerDir) {
    const cMid = (cLo + cHi) / 2;
    const perOff = new Map();
    let best = 0;
    for (let off = Math.ceil(offLo); off <= offHi; off += 2) {
      let bestSl = null, bestSum = -1;
      for (const sl of SLOPES) {
        let sum = 0;
        for (let i = 0; i < NS; i++) {
          const cPos = cLo + (cHi - cLo) * (i + 0.5) / NS;
          const p = off + sl * (cPos - cMid);
          const x = (axis === 'v' ? p : cPos) | 0, y = (axis === 'v' ? cPos : p) | 0;
          if (x < 3 || y < 3 || x >= W - 3 || y >= H - 3) { sum = -1; break; }
          const idx = (y * W + x) * 4, d = axis === 'v' ? 8 : W * 8; // ±2 px across the line
          sum += Math.abs(rgba[idx + d] - rgba[idx - d]) + Math.abs(rgba[idx + d + 1] - rgba[idx - d + 1]) + Math.abs(rgba[idx + d + 2] - rgba[idx - d + 2]);
        }
        if (sum > bestSum) { bestSum = sum; bestSl = sl; }
      }
      if (bestSum > 0) { perOff.set(off, { sum: bestSum, sl: bestSl }); if (bestSum > best) best = bestSum; }
    }
    const thr = Math.max(best * 0.55, NS * 20);
    let pick = null;
    for (const [off, v] of perOff) {
      if (v.sum < thr) continue;
      if (!pick || (outerDir < 0 ? off < pick.off : off > pick.off)) pick = { off, sl: v.sl, cMid };
    }
    return pick;
  }
  const yLo = s.y + 0.10 * s.h, yHi = s.y + 0.90 * s.h;
  const xLo = s.x + 0.10 * s.w, xHi = s.x + 0.90 * s.w;
  const L = lineSearch('v', s.x - 0.30 * s.w, s.x + 0.22 * s.w, yLo, yHi, -1);
  const R = lineSearch('v', s.x + 0.78 * s.w, s.x + 1.30 * s.w, yLo, yHi, 1);
  const T = lineSearch('h', s.y - 0.30 * s.h, s.y + 0.22 * s.h, xLo, xHi, -1);
  const B = lineSearch('h', s.y + 0.78 * s.h, s.y + 1.30 * s.h, xLo, xHi, 1);
  if (dbg) dbg('edges lines', ['L','R','T','B'].map((k,i)=>{const v=[L,R,T,B][i]; return v?`${k}:${v.off}@${v.sl}`:`${k}:null`;}).join(' '));
  if (!L || !R || !T || !B) return null;
  if (R.off - L.off < 0.5 * s.w || B.off - T.off < 0.5 * s.h) { if (dbg) dbg('edges: span too small'); return null; }
  // corner = intersection of near-vertical (o,a,cMid=ym) and near-horizontal (p,b,cMid=xm) lines
  function corner(v, h) {
    const x = (v.off + v.sl * (h.off - h.sl * h.cMid - v.cMid)) / (1 - v.sl * h.sl);
    const y = h.off + h.sl * (x - h.cMid);
    return { x, y };
  }
  const seedQuad = [corner(L, T), corner(R, T), corner(R, B), corner(L, B)];
  if (seedQuad.some(p => !isFinite(p.x) || !isFinite(p.y))) return null;
  if (dbg) dbg('edges seedQuad', seedQuad.map(p=>`${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' '));
  const refined = refineQuadByGradient(luma, W, H, seedQuad, 0, rgba);
  if (!refined) { if (dbg) dbg('edges: refine failed'); return null; }
  const q = refined.quad;
  let okGeom = true;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], d = q[(i + 3) % 4];
    const v1x = b.x - a.x, v1y = b.y - a.y, v2x = d.x - a.x, v2y = d.y - a.y;
    const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) + 1e-9);
    if (Math.abs(cos) > 0.5) okGeom = false;
  }
  if (!okGeom) { if (dbg) dbg('edges: bad geometry'); return null; }
  const wTop = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), wBot = Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y);
  const hL = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y), hR = Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y);
  const ratio = (wTop + wBot) / (hL + hR);
  const errA = Math.abs(ratio - expected) / expected;
  const errB = Math.abs(ratio - 1 / expected) * expected;
  const rotated = errB < errA;
  const ratioErr = Math.min(errA, errB);
  if (ratioErr > 0.22) { if (dbg) dbg('edges: ratio reject', ratio.toFixed(3)); return null; }
  const interior = interiorPenalty(luma, W, H, q);
  if (dbg) dbg('edges: refined ok, inliers', refined.inliers.toFixed(2), 'spread', refined.spread.toFixed(2), 'ratioErr', ratioErr.toFixed(3), 'interior', interior);
  const score = ratioErr * 1.2 + (1 - refined.inliers) * 0.35 + Math.min(3, refined.spread) * 0.06 + 0.10 + interior;
  return { quad: q, score, thresh: -1, inliers: refined.inliers, centerFill: -1, band: null, ratio, rotated, mode: 'edges' };
}

// ---------------------------------------------------------------- photo window (inner frame)
// fr = border widths as fractions of the outer size {l,r,t,b} for the print upright (chin = b).
// Orientation k = quarter turns clockwise of the print in the image: chin on bottom/left/top/right.
function orientFr(fr, k) {
  let { l, r, t, b } = fr;
  for (let i = 0; i < k; i++) [l, t, r, b] = [b, l, t, r];
  return { l, r, t, b };
}
const winUnit = f => [{ x: f.l, y: f.t }, { x: 1 - f.r, y: f.t }, { x: 1 - f.r, y: 1 - f.b }, { x: f.l, y: 1 - f.b }];
function windowFromOuter(outer, f) {
  const Hm = solveHomography(rectQuad(1, 1), outer);
  return winUnit(f).map(p => applyH(Hm, p.x, p.y));
}
function outerFromWindow(win, f) {
  const Hm = solveHomography(winUnit(f), win);
  return rectQuad(1, 1).map(p => applyH(Hm, p.x, p.y));
}
function quadRatio(q, expected) {
  const wTop = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), wBot = Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y);
  const hL = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y), hR = Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y);
  const ratio = (wTop + wBot) / (hL + hR);
  const errA = Math.abs(ratio - expected) / expected, errB = Math.abs(ratio - 1 / expected) * expected;
  return { ratio, err: Math.min(errA, errB), rotated: errB < errA, w: (wTop + wBot) / 2, h: (hL + hR) / 2 };
}
// How far side i of quad B strays from the line of side i of quad A (px, max of two probe points).
function sideGap(A, B, i) {
  const a0 = A[i], a1 = A[(i + 1) % 4], b0 = B[i], b1 = B[(i + 1) % 4];
  const L = Math.hypot(a1.x - a0.x, a1.y - a0.y) || 1;
  let worst = 0;
  for (const t of [0.25, 0.75]) {
    const px = b0.x + (b1.x - b0.x) * t, py = b0.y + (b1.y - b0.y) * t;
    worst = Math.max(worst, Math.abs((a1.x - a0.x) * (py - a0.y) - (a1.y - a0.y) * (px - a0.x)) / L);
  }
  return worst;
}
// Median colour step across the segment p0→p1 (how much of a real edge lies exactly there).
function lineSupport(rgba, W, H, p0, p1) {
  const L = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
  const nx = -(p1.y - p0.y) / L, ny = (p1.x - p0.x) / L;
  const a = [0, 0, 0], b = [0, 0, 0], vals = [];
  for (let s = 0; s < 20; s++) {
    const t = 0.1 + 0.8 * (s + 0.5) / 20;
    const px = p0.x + (p1.x - p0.x) * t, py = p0.y + (p1.y - p0.y) * t;
    let best = 0;
    for (let d = -1; d <= 1; d++) {
      sampleRGB(rgba, W, H, px + nx * (d + 2), py + ny * (d + 2), a);
      sampleRGB(rgba, W, H, px + nx * (d - 2), py + ny * (d - 2), b);
      best = Math.max(best, Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]));
    }
    vals.push(best);
  }
  vals.sort((x, y) => x - y);
  return vals[vals.length >> 1];
}
function lineX(a0, a1, b0, b1) {
  const dax = a1.x - a0.x, day = a1.y - a0.y, dbx = b1.x - b0.x, dby = b1.y - b0.y;
  const den = dax * dby - day * dbx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b0.x - a0.x) * dby - (b0.y - a0.y) * dbx) / den;
  return { x: a0.x + dax * t, y: a0.y + day * t };
}

// Given an accepted outer quad, look for the photo window where the format says it should be.
// Agreement confirms the detection. If exactly one outer side disagrees with the side the window
// implies, and the window is crisp and the implied line sits on a stronger edge, that side was
// mis-fitted (e.g. dark foil fading into a wood table) — replace it.
function checkWithWindow(luma, rgba, W, H, best, fr, expected, dbg) {
  if (!rgba) return;
  const q = best.quad, g = quadRatio(q, expected);
  let win = null;
  for (const k of best.rotated ? [1, 3] : [0, 2]) {
    const f = orientFr(fr, k);
    const minB = Math.min(f.l * g.w, f.r * g.w, f.t * g.h, f.b * g.h);
    const hw = Math.max(3, Math.min(10, Math.round(0.45 * minB)));
    const pred = windowFromOuter(q, f);
    const r = refineQuadByGradient(luma, W, H, pred, 0, rgba, { hw, strongest: true });
    if (!r) continue;
    // the right orientation needs little adjustment; a wrong chin side drags edges a long way
    const move = r.quad.reduce((a, p, j) => a + Math.hypot(p.x - pred[j].x, p.y - pred[j].y), 0) / 4;
    const qual = r.inliers - 0.1 * r.spread - 0.4 * move / hw;
    if (!win || qual > win.qual) win = { ...r, k, qual };
  }
  if (!win) { if (dbg) dbg('window: not found'); return; }
  const implied = outerFromWindow(win.quad, orientFr(fr, win.k));
  const tol = Math.max(2, 0.025 * Math.min(g.w, g.h));
  const gaps = [0, 1, 2, 3].map(i => sideGap(q, implied, i));
  const bad = [0, 1, 2, 3].filter(i => gaps[i] > tol);
  const strong = win.inliers >= 0.8 && win.spread <= 1.2;
  if (dbg) dbg(`window k${win.k} inl ${win.inliers.toFixed(2)} spread ${win.spread.toFixed(2)} gaps ${gaps.map(v => v.toFixed(1)).join(' ')} tol ${tol.toFixed(1)}`);
  if (!bad.length) { best.inner = win.quad; best.score = Math.max(0, best.score - 0.05); best.mode += '+win'; return; }
  if (!strong) return;
  // replace a disagreeing side only where the detected line is not on a clearly real edge — so a
  // wrong format choice (every detected side crisp, implied ones off-edge) never moves anything
  const swap = bad.filter(i => {
    const supDet = lineSupport(rgba, W, H, q[i], q[(i + 1) % 4]), supImp = lineSupport(rgba, W, H, implied[i], implied[(i + 1) % 4]);
    if (dbg) dbg(`window: side ${i} support detected ${supDet.toFixed(0)} implied ${supImp.toFixed(0)}`);
    return supDet < 20 || supImp >= 1.15 * supDet + 3;
  });
  if (swap.length !== bad.length) return; // mixed evidence: trust neither
  const side = j => swap.includes(j) ? [implied[j], implied[(j + 1) % 4]] : [q[j], q[(j + 1) % 4]];
  const q2 = [0, 1, 2, 3].map(j => { const A = side((j + 3) % 4), B = side(j); return lineX(A[0], A[1], B[0], B[1]); });
  if (q2.some(p => !p || !isFinite(p.x) || !isFinite(p.y))) return;
  // snap the replaced side onto the real (weak) edge if there is one within a few px
  const r = refineQuadByGradient(luma, W, H, q2, 0, rgba, { hw: 3 });
  const fixed = r && r.quad.every((p, j) => Math.hypot(p.x - q2[j].x, p.y - q2[j].y) < tol) ? r.quad : q2;
  const g2 = quadRatio(fixed, expected);
  best.quad = fixed; best.inner = win.quad; best.ratio = g2.ratio; best.rotated = g2.rotated; best.mode += '+fixed';
}

// No usable outer edge: find the photo window (a quad with the picture's aspect ratio) and
// extend it by the border geometry. The chin side is chosen by edge evidence at the implied
// outer edge, defaulting to chin-at-bottom when there is none (black frame on black table).
function findViaWindow(luma, rgba, W, H, reg, expected, fr, seed, scratch, dbg) {
  if (!rgba) return null;
  const innerRatio = expected * (1 - fr.l - fr.r) / (1 - fr.t - fr.b);
  const cands = [];
  const sil = tableColour(rgba, W, reg);
  if (sil) cands.push(findRing(luma, W, reg, sil.thr, innerRatio, scratch, 2, sil, rgba));
  cands.push(findByEdges(luma, rgba, W, H, reg, innerRatio, seed, null));
  let best = null;
  for (const c of cands) {
    if (!c) continue;
    const gi = quadRatio(c.quad, innerRatio), go = quadRatio(c.quad, expected);
    if (gi.err >= go.err) continue; // shaped like a whole print, not a window
    const ks = Math.abs(innerRatio - 1) > 0.08 ? (gi.rotated ? [1, 3] : [0, 2]) : [0, 1, 2, 3];
    let pick = null;
    for (const k of ks) {
      const O = outerFromWindow(c.quad, orientFr(fr, k));
      if (O.some(p => p.x < -0.03 * W || p.y < -0.03 * H || p.x > 1.03 * W || p.y > 1.03 * H)) continue;
      let sup = 0;
      for (let i = 0; i < 4; i++) sup += lineSupport(rgba, W, H, O[i], O[(i + 1) % 4]) / 4;
      const v = sup + (k === 0 ? 6 : 0);
      if (!pick || v > pick.v) pick = { O, v, k, sup };
    }
    if (!pick) continue;
    const r = refineQuadByGradient(luma, W, H, pick.O, 0, rgba, { hw: 3 });
    const quad = r && r.inliers > 0.7 ? r.quad : pick.O;
    const g = quadRatio(quad, expected);
    const score = c.score + 0.1;
    if (dbg) dbg(`window cand ${c.mode} score ${c.score.toFixed(3)} chin k${pick.k} support ${pick.sup.toFixed(0)}`);
    if (!best || score < best.score) best = { quad, score, thresh: -3, inliers: c.inliers, centerFill: -1, band: null, ratio: g.ratio, rotated: g.rotated, mode: 'window', inner: c.quad };
  }
  return best;
}

// Laplacian variance inside the quad (shrunk) — same scale as the luma passed in.
export function sharpnessInQuad(luma, W, H, quad) {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4, cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const hw = Math.abs(quad[1].x - quad[0].x) * 0.35, hh = Math.abs(quad[3].y - quad[0].y) * 0.35;
  const x0 = Math.max(1, Math.floor(cx - hw)), x1 = Math.min(W - 2, Math.ceil(cx + hw));
  const y0 = Math.max(1, Math.floor(cy - hh)), y1 = Math.min(H - 2, Math.ceil(cy + hh));
  let sum = 0, sum2 = 0, N = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * W + x;
    const lap = -4 * luma[i] + luma[i - 1] + luma[i + 1] + luma[i - W] + luma[i + W];
    sum += lap; sum2 += lap * lap; N++;
  }
  if (!N) return 0;
  const mean = sum / N;
  return Math.max(0, sum2 / N - mean * mean);
}

// Shrink an outer quad to the image area using border fractions {l,r,t,b} (of outer width/height).
export function innerQuad(outer, fr) {
  const [tl, tr, br, bl] = outer;
  // bilinear interpolation in the unit square of the outer quad
  const at = (u, v) => {
    const ax = tl.x + (tr.x - tl.x) * u, ay = tl.y + (tr.y - tl.y) * u;
    const bx = bl.x + (br.x - bl.x) * u, by = bl.y + (br.y - bl.y) * u;
    return { x: ax + (bx - ax) * v, y: ay + (by - ay) * v };
  };
  return [at(fr.l, fr.t), at(1 - fr.r, fr.t), at(1 - fr.r, 1 - fr.b), at(fr.l, 1 - fr.b)];
}

// ---------------------------------------------------------------- warping

// Warp a patch of the canonical (dst) plane from src RGBA via H (dst->src).
// dst pixel (i,j) of the patch sits at full-res dst coords (dx0 + (i+0.5)*scale, dy0 + (j+0.5)*scale).
// Writes RGB into out (Uint8ClampedArray or Float32Array, 3 per px) and 1/0 into valid.
export function warpPatch(src, H, dx0, dy0, pw, ph, scale, out, valid) {
  const sd = src.data, sw = src.w, sh = src.h;
  const h0 = H[0] * scale, h3 = H[3] * scale, h6 = H[6] * scale;
  for (let j = 0; j < ph; j++) {
    const y = dy0 + (j + 0.5) * scale;
    let X = H[0] * (dx0 + 0.5 * scale) + H[1] * y + H[2];
    let Y = H[3] * (dx0 + 0.5 * scale) + H[4] * y + H[5];
    let Wd = H[6] * (dx0 + 0.5 * scale) + H[7] * y + H[8];
    let o = j * pw * 3, v = j * pw;
    for (let i = 0; i < pw; i++, o += 3, v++, X += h0, Y += h3, Wd += h6) {
      const sx = X / Wd - 0.5, sy = Y / Wd - 0.5;
      const ix = Math.floor(sx), iy = Math.floor(sy);
      if (ix < 0 || iy < 0 || ix >= sw - 1 || iy >= sh - 1) { out[o] = out[o + 1] = out[o + 2] = 0; if (valid) valid[v] = 0; continue; }
      const fx = sx - ix, fy = sy - iy;
      const idx = (iy * sw + ix) * 4, idx2 = idx + sw * 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      out[o] = sd[idx] * w00 + sd[idx + 4] * w10 + sd[idx2] * w01 + sd[idx2 + 4] * w11;
      out[o + 1] = sd[idx + 1] * w00 + sd[idx + 5] * w10 + sd[idx2 + 1] * w01 + sd[idx2 + 5] * w11;
      out[o + 2] = sd[idx + 2] * w00 + sd[idx + 6] * w10 + sd[idx2 + 2] * w01 + sd[idx2 + 6] * w11;
      if (valid) valid[v] = 1;
    }
  }
}

function lumaOfRGB(rgb, n, out) {
  out = out || new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 3, p++) out[p] = 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
  return out;
}

function gradMag(l, w, h, out) {
  out = out || new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const gx = (x > 0 && x < w - 1) ? l[i + 1] - l[i - 1] : 0;
    const gy = (y > 0 && y < h - 1) ? l[i + w] - l[i - w] : 0;
    out[i] = Math.abs(gx) + Math.abs(gy);
  }
  return out;
}

function medianInto(arrs, n, out) {
  const K = arrs.length, tmp = new Float32Array(K);
  for (let p = 0; p < n; p++) {
    for (let k = 0; k < K; k++) tmp[k] = arrs[k][p];
    // insertion sort (K small)
    for (let a = 1; a < K; a++) { const v = tmp[a]; let b = a - 1; while (b >= 0 && tmp[b] > v) { tmp[b + 1] = tmp[b]; b--; } tmp[b + 1] = v; }
    out[p] = K & 1 ? tmp[K >> 1] : 0.5 * (tmp[(K >> 1) - 1] + tmp[K >> 1]);
  }
  return out;
}

// ---------------------------------------------------------------- alignment refinement

// frames: [{data,w,h}] RGBA sources; Hs: per-frame dst->src homographies (mutated copy returned).
// Returns { Hs, diag:[{shift, conf}] }.
export function refineAlignment(frames, Hs, outW, outH, opts = {}) {
  const K = frames.length;
  Hs = Hs.map(h => h.slice());
  const diag = frames.map(() => ({ shift: 0, conf: 0, cells: 0 }));
  if (K < 2) return { Hs, diag };
  const levels = opts.levels || [
    { scale: 8, R: 6, patch: 0 },
    { scale: 4, R: 3, patch: 128 },
    { scale: 2, R: 2, patch: 128 },
  ];
  const grid = 3;
  const bright = 238;
  for (const lv of levels) {
    const s = lv.scale;
    const lw = Math.floor(outW / s), lh = Math.floor(outH / s);
    let pw = lv.patch ? Math.min(lv.patch, Math.floor(lw / grid)) : Math.floor(lw / grid);
    let ph = lv.patch ? Math.min(lv.patch, Math.floor(lh / grid)) : Math.floor(lh / grid);
    const R = lv.R, ew = pw + 2 * R, eh = ph + 2 * R;
    const fr = new Float32Array(ew * eh * 3), fv = new Uint8Array(ew * eh);
    const cellLuma = [], cellValid = [];
    for (let k = 0; k < K; k++) { cellLuma.push(new Float32Array(ew * eh)); cellValid.push(new Uint8Array(ew * eh)); }
    const refL = new Float32Array(pw * ph), refG = new Float32Array(pw * ph);
    const center = new Float32Array(pw * ph);
    const centers = [];
    const frameG = new Float32Array(ew * eh);
    // per-frame correspondences
    const corr = frames.map(() => ({ pts: [], dst: [], w: [] }));
    for (let gy = 0; gy < grid; gy++) for (let gx = 0; gx < grid; gx++) {
      const cx = (gx + 0.5) * outW / grid, cy = (gy + 0.5) * outH / grid;
      const dx0 = cx - (pw / 2 + R) * s, dy0 = cy - (ph / 2 + R) * s;
      for (let k = 0; k < K; k++) {
        warpPatch(frames[k], Hs[k], dx0, dy0, ew, eh, s, fr, fv);
        lumaOfRGB(fr, ew * eh, cellLuma[k]);
        const cv = cellValid[k], cl = cellLuma[k];
        for (let p = 0; p < ew * eh; p++) cv[p] = fv[p] && cl[p] < bright ? 1 : 0;
      }
      // reference = per-pixel median of the central pw×ph region
      const centrals = cellLuma.map(cl => {
        const c = new Float32Array(pw * ph);
        for (let j = 0; j < ph; j++) for (let i = 0; i < pw; i++) c[j * pw + i] = cl[(j + R) * ew + i + R];
        return c;
      });
      medianInto(centrals, pw * ph, refL);
      gradMag(refL, pw, ph, refG);
      // ref validity: majority of frames valid & ref not bright
      const refV = new Uint8Array(pw * ph);
      let energy = 0, cnt = 0;
      for (let j = 0; j < ph; j++) for (let i = 0; i < pw; i++) {
        let vcount = 0; for (let k = 0; k < K; k++) vcount += cellValid[k][(j + R) * ew + i + R];
        const ok = vcount * 2 >= K && refL[j * pw + i] < bright && i > 1 && j > 1 && i < pw - 2 && j < ph - 2;
        refV[j * pw + i] = ok ? 1 : 0;
        if (ok) { energy += refG[j * pw + i]; cnt++; }
      }
      if (!cnt || energy / cnt < 1.0) continue; // textureless cell: no information
      for (let k = 0; k < K; k++) {
        gradMag(cellLuma[k], ew, eh, frameG);
        const cv = cellValid[k];
        let bestV = -1, bestDx = 0, bestDy = 0;
        const scores = new Float32Array((2 * R + 1) * (2 * R + 1));
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          let sab = 0, saa = 0, sbb = 0;
          for (let j = 0; j < ph; j++) {
            const ro = j * pw, fo = (j + R + dy) * ew + R + dx;
            for (let i = 0; i < pw; i++) {
              if (!refV[ro + i] || !cv[fo + i]) continue;
              const a = refG[ro + i], b = frameG[fo + i];
              sab += a * b; saa += a * a; sbb += b * b;
            }
          }
          const v = sab / (Math.sqrt(saa * sbb) + 1e-6);
          scores[(dy + R) * (2 * R + 1) + dx + R] = v;
          if (v > bestV) { bestV = v; bestDx = dx; bestDy = dy; }
        }
        if (bestV < 0.25) continue;
        // sub-pixel parabola
        let sx = bestDx, sy = bestDy;
        const S = (dx, dy) => scores[(dy + R) * (2 * R + 1) + dx + R];
        if (bestDx > -R && bestDx < R) {
          const l = S(bestDx - 1, bestDy), r = S(bestDx + 1, bestDy), d = l - 2 * bestV + r;
          if (d < 0) sx += 0.5 * (l - r) / d;
        }
        if (bestDy > -R && bestDy < R) {
          const u = S(bestDx, bestDy - 1), dn = S(bestDx, bestDy + 1), d = u - 2 * bestV + dn;
          if (d < 0) sy += 0.5 * (u - dn) / d;
        }
        const c = corr[k];
        c.pts.push({ x: cx, y: cy });
        c.dst.push(applyH(Hs[k], cx + sx * s, cy + sy * s));
        c.w.push(bestV);
        c.shift = (c.shift || 0) + Math.hypot(sx * s, sy * s);
      }
    }
    for (let k = 0; k < K; k++) {
      const c = corr[k];
      if (c.pts.length === 0) continue;
      if (c.pts.length >= 5) {
        try { Hs[k] = solveHomography(c.pts, c.dst, c.w); } catch { /* keep */ }
      } else {
        // translation-only update in dst space: weighted mean shift
        let sx = 0, sy = 0, sw = 0;
        for (let i = 0; i < c.pts.length; i++) {
          const back = applyH(invertH(Hs[k]), c.dst[i].x, c.dst[i].y);
          sx += (back.x - c.pts[i].x) * c.w[i]; sy += (back.y - c.pts[i].y) * c.w[i]; sw += c.w[i];
        }
        sx /= sw; sy /= sw;
        const T = [1, 0, sx, 0, 1, sy, 0, 0, 1];
        Hs[k] = composeH(Hs[k], T);
      }
      diag[k].shift = c.shift / c.pts.length;
      diag[k].conf = c.w.reduce((a, b) => a + b, 0) / c.w.length;
      diag[k].cells = c.pts.length;
    }
    if (opts.onLevel) opts.onLevel(lv);
  }
  return { Hs, diag };
}

// (A∘B)(p) = A(B(p))
export function composeH(A, B) {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  const s = 1 / r[8];
  return r.map(v => v * s);
}

// Per-frame per-channel gains so exposures match the median frame (computed at 1/8 res).
export function estimateGains(frames, Hs, outW, outH) {
  const K = frames.length;
  const s = 8, lw = Math.floor(outW / s), lh = Math.floor(outH / s), n = lw * lh;
  const bufs = [], valids = [];
  for (let k = 0; k < K; k++) {
    const b = new Float32Array(n * 3), v = new Uint8Array(n);
    warpPatch(frames[k], Hs[k], 0, 0, lw, lh, s, b, v);
    bufs.push(b); valids.push(v);
  }
  const gains = [];
  if (K < 2) return frames.map(() => [1, 1, 1]);
  const ref = new Float32Array(n * 3);
  for (let c = 0; c < 3; c++) {
    const chans = bufs.map(b => { const o = new Float32Array(n); for (let p = 0; p < n; p++) o[p] = b[p * 3 + c]; return o; });
    const m = new Float32Array(n); medianInto(chans, n, m);
    for (let p = 0; p < n; p++) ref[p * 3 + c] = m[p];
  }
  const ratios = new Float32Array(n);
  for (let k = 0; k < K; k++) {
    const g = [1, 1, 1], b = bufs[k], v = valids[k];
    for (let c = 0; c < 3; c++) {
      let m = 0;
      for (let p = 0; p < n; p++) {
        if (!v[p]) continue;
        const rv = ref[p * 3 + c], fvv = b[p * 3 + c];
        if (rv > 235 || fvv > 235 || rv < 12 || fvv < 12) continue;
        ratios[m++] = rv / fvv;
      }
      if (m > 50) {
        const sub = ratios.subarray(0, m); sub.sort();
        g[c] = Math.min(1.5, Math.max(0.66, sub[m >> 1]));
      }
    }
    gains.push(g);
  }
  return gains;
}

// ---------------------------------------------------------------- fusion

// Robust per-pixel fusion. glarePct 0..100 — how aggressively bright samples are rejected.
export function fuseAligned(frames, Hs, gains, outW, outH, opts = {}) {
  const K = frames.length;
  const glarePct = opts.glarePct == null ? 65 : opts.glarePct;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const BAND = 64;
  const bufs = [], valids = [];
  for (let k = 0; k < K; k++) { bufs.push(new Float32Array(outW * BAND * 3)); valids.push(new Uint8Array(outW * BAND)); }
  const refPct = Math.min(0.5, Math.max(0.02, 0.5 - glarePct / 200));
  const refIdx = Math.round((K - 1) * refPct);
  const lum = new Float32Array(K), idx = new Uint8Array(K);
  for (let y0 = 0; y0 < outH; y0 += BAND) {
    const bh = Math.min(BAND, outH - y0);
    for (let k = 0; k < K; k++) {
      warpPatch(frames[k], Hs[k], 0, y0, outW, bh, 1, bufs[k], valids[k]);
      const g = gains ? gains[k] : null;
      if (g && (g[0] !== 1 || g[1] !== 1 || g[2] !== 1)) {
        const b = bufs[k];
        for (let p = 0, e = outW * bh * 3; p < e; p += 3) { b[p] *= g[0]; b[p + 1] *= g[1]; b[p + 2] *= g[2]; }
      }
    }
    for (let j = 0; j < bh; j++) {
      let lastR = 235, lastG = 235, lastB = 235; // fill for uncovered pixels: smear along the row
      for (let i = 0; i < outW; i++) {
        const p = j * outW + i, p3 = p * 3, o = ((y0 + j) * outW + i) * 4;
        let S = 0;
        for (let k = 0; k < K; k++) {
          if (!valids[k][p]) continue;
          const b = bufs[k];
          lum[S] = 0.299 * b[p3] + 0.587 * b[p3 + 1] + 0.114 * b[p3 + 2];
          idx[S] = k; S++;
        }
        if (S === 0) { out[o] = lastR; out[o + 1] = lastG; out[o + 2] = lastB; out[o + 3] = 255; continue; }
        // sort indices by luma (insertion)
        for (let a = 1; a < S; a++) {
          const lv = lum[a], iv = idx[a]; let b = a - 1;
          while (b >= 0 && lum[b] > lv) { lum[b + 1] = lum[b]; idx[b + 1] = idx[b]; b--; }
          lum[b + 1] = lv; idx[b + 1] = iv;
        }
        const ri = Math.min(S - 1, S === K ? refIdx : Math.round((S - 1) * refPct));
        const refL = lum[ri];
        const hi = refL + 9 + 0.06 * refL, lo = refL - 10 - 0.05 * refL;
        let r = 0, g = 0, bb = 0, c = 0;
        for (let a = 0; a < S; a++) {
          const L = lum[a];
          if (L < lo) continue;
          if (L > hi) break;
          const b = bufs[idx[a]];
          r += b[p3]; g += b[p3 + 1]; bb += b[p3 + 2]; c++;
        }
        out[o] = lastR = r / c; out[o + 1] = lastG = g / c; out[o + 2] = lastB = bb / c; out[o + 3] = 255;
      }
    }
    if (opts.onProgress) opts.onProgress((y0 + bh) / outH);
  }
  return { data: out, w: outW, h: outH };
}

// ---------------------------------------------------------------- post

// Find the image area inside a fused outer-border image. nominal = {l,r,t,b} fractions.
export function refineInnerCrop(rgba, W, H, nominal) {
  const luma = rgbaToLuma(rgba, W * H);
  const nomL = nominal.l * W, nomR = W - nominal.r * W, nomT = nominal.t * H, nomB = H - nominal.b * H;
  const tol = 0.035;
  function edge(axis, nom) {
    // axis 'x': scan columns; 'y': scan rows. Border->image transition, either polarity.
    const span = Math.round((axis === 'x' ? W : H) * tol);
    const lo = Math.max(3, Math.round(nom - span)), hi = Math.min((axis === 'x' ? W : H) - 4, Math.round(nom + span));
    const a0 = axis === 'x' ? Math.round(nomT + 0.1 * (nomB - nomT)) : Math.round(nomL + 0.1 * (nomR - nomL));
    const a1 = axis === 'x' ? Math.round(nomB - 0.1 * (nomB - nomT)) : Math.round(nomR - 0.1 * (nomR - nomL));
    const prof = new Float32Array(hi - lo + 1);
    for (let p = lo; p <= hi; p++) {
      let s = 0, c = 0;
      for (let q = a0; q < a1; q += 2) { s += axis === 'x' ? luma[q * W + p] : luma[p * W + q]; c++; }
      prof[p - lo] = s / c;
    }
    let best = nom, bestG = 0;
    for (let p = lo + 2; p <= hi - 2; p++) {
      const g = Math.abs(prof[p - lo - 2] - prof[p - lo + 2]); // border -> image transition, either polarity
      if (g > bestG) { bestG = g; best = p; }
    }
    return bestG >= 10 ? best : nom;
  }
  const x0 = edge('x', nomL), x1 = edge('x', nomR);
  const y0 = edge('y', nomT), y1 = edge('y', nomB);
  const pad = Math.max(2, Math.round(Math.min(W, H) * 0.004));
  return { x: Math.round(x0) + pad, y: Math.round(y0) + pad, w: Math.round(x1 - x0) - 2 * pad, h: Math.round(y1 - y0) - 2 * pad };
}

export function cropRGBA(rgba, W, H, r) {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) out.set(rgba.subarray(((r.y + y) * W + r.x) * 4, ((r.y + y) * W + r.x + r.w) * 4), y * r.w * 4);
  return { data: out, w: r.w, h: r.h };
}

export function unsharp(rgba, W, H, amount) {
  const out = new Uint8ClampedArray(rgba.length);
  const tmp = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const xm = Math.max(0, x - 1), xp = Math.min(W - 1, x + 1);
    const i0 = (y * W + xm) * 4, i1 = (y * W + x) * 4, i2 = (y * W + xp) * 4, o = (y * W + x) * 3;
    tmp[o] = (rgba[i0] + rgba[i1] + rgba[i2]) / 3; tmp[o + 1] = (rgba[i0 + 1] + rgba[i1 + 1] + rgba[i2 + 1]) / 3; tmp[o + 2] = (rgba[i0 + 2] + rgba[i1 + 2] + rgba[i2 + 2]) / 3;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ym = Math.max(0, y - 1), yp = Math.min(H - 1, y + 1);
    const i0 = (ym * W + x) * 3, i1 = (y * W + x) * 3, i2 = (yp * W + x) * 3, o = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) {
      const blur = (tmp[i0 + c] + tmp[i1 + c] + tmp[i2 + c]) / 3;
      out[o + c] = rgba[o + c] + (rgba[o + c] - blur) * amount;
    }
    out[o + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------- full pipeline

// frames: [{data,w,h,quad:[4 pts in src px],sharp}]
// opts: {outW,outH,glarePct,borders:{l,r,t,b},autoCrop,sharpen,onProgress}
export function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) { const p = q[i], r = q[(i + 1) % 4]; a += p.x * r.y - r.x * p.y; }
  return Math.abs(a) / 2;
}

export function fusePipeline(framesIn, opts) {
  if (!framesIn.length) throw new Error('no frames to fuse');
  const { outW, outH } = opts;
  const prog = (stage, f) => opts.onProgress && opts.onProgress(stage, f);
  const dropped = [];
  // 1. drop frames whose border quad disagrees in size with the consensus (bad detections)
  let frames = framesIn.map((f, i) => ({ ...f, idx: i }));
  if (frames.length >= 3) {
    const areas = frames.map(f => quadArea(f.quad)).sort((a, b) => a - b);
    const med = areas[areas.length >> 1];
    const keep = frames.filter(f => Math.abs(quadArea(f.quad) / med - 1) < 0.2);
    if (keep.length >= 2) { for (const f of frames) if (!keep.includes(f)) dropped.push({ idx: f.idx, why: 'border size outlier' }); frames = keep; }
  }
  const dstQ = rectQuad(outW, outH);
  let Hs = frames.map(f => solveHomography(dstQ, f.quad));
  prog('align', 0);
  const t0 = now();
  const ref = refineAlignment(frames, Hs, outW, outH, { onLevel: () => prog('align', 0.5) });
  Hs = ref.Hs;
  let diag = ref.diag;
  // 2. drop frames that could not be aligned confidently
  if (frames.length >= 3) {
    const keepIdx = [];
    for (let k = 0; k < frames.length; k++) {
      if (diag[k].cells >= 3 && diag[k].conf >= 0.4) keepIdx.push(k);
      else dropped.push({ idx: frames[k].idx, why: `alignment conf ${diag[k].conf.toFixed(2)}` });
    }
    if (keepIdx.length >= 2 && keepIdx.length < frames.length) {
      frames = keepIdx.map(k => frames[k]); Hs = keepIdx.map(k => Hs[k]); diag = keepIdx.map(k => diag[k]);
    } else if (keepIdx.length < 2) { dropped.length = 0; }
  }
  const tAlign = now() - t0;
  const gains = estimateGains(frames, Hs, outW, outH);
  prog('fuse', 0);
  const t1 = now();
  const fused = fuseAligned(frames, Hs, gains, outW, outH, { glarePct: opts.glarePct, onProgress: f => prog('fuse', f) });
  const tFuse = now() - t1;
  return finishPipeline(fused, { ...opts, Hs, gains, diag, dropped, used: frames.map(f => f.idx), timing: { align: tAlign, fuse: tFuse } });
}

// Rotate RGBA by 90° clockwise (dir=1) or counter-clockwise (dir=-1).
export function rotateRGBA(img, dir) {
  const { data, w, h } = img;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const nx = dir === 1 ? (h - 1 - y) : y, ny = dir === 1 ? x : (w - 1 - x);
    const i = (y * w + x) * 4, o = (ny * h + nx) * 4;
    out[o] = data[i]; out[o + 1] = data[i + 1]; out[o + 2] = data[i + 2]; out[o + 3] = 255;
  }
  return { data: out, w: h, h: w };
}

// Which side of the fused outer image has the thickest border? Returns 'left'|'right'|'top'|'bottom'.
export function thickSide(img) {
  const { data, w, h } = img;
  const luma = rgbaToLuma(data, w * h);
  function depth(side) {
    // walk inward from the edge along the middle 60% of the side, find the first big jump in mean luma
    const len = side === 'left' || side === 'right' ? h : w;
    const a0 = Math.round(len * 0.2), a1 = Math.round(len * 0.8);
    const maxD = Math.round((side === 'left' || side === 'right' ? w : h) * 0.45);
    let prev = null;
    for (let d = 2; d < maxD; d++) {
      let s = 0, c = 0;
      for (let a = a0; a < a1; a += 3) {
        const x = side === 'left' ? d : side === 'right' ? w - 1 - d : a;
        const y = side === 'top' ? d : side === 'bottom' ? h - 1 - d : a;
        s += luma[y * w + x]; c++;
      }
      const m = s / c;
      if (prev !== null && Math.abs(prev - m) > 22) return d;
      prev = m;
    }
    return maxD;
  }
  const ds = { left: depth('left'), right: depth('right'), top: depth('top'), bottom: depth('bottom') };
  return Object.keys(ds).reduce((a, b) => ds[a] >= ds[b] ? a : b);
}

export function finishPipeline(fused, opts) {
  let img = fused, crop = null;
  if (opts.landscape) {
    // print was scanned sideways: rotate so the thick border ends up at the bottom
    const side = thickSide(fused);
    if (side === 'left') img = fused = rotateRGBA(fused, -1);
    else if (side === 'right') img = fused = rotateRGBA(fused, 1);
    else if (side === 'top') img = fused = rotateRGBA(rotateRGBA(fused, 1), 1); // 180°
    // side === 'bottom': already upright
  }
  // Always keep the full print (frame included). The located image area is returned as a
  // rect so the UI can offer frame/no-frame instantly without re-processing.
  if (opts.borders) crop = refineInnerCrop(fused.data, fused.w, fused.h, opts.borders);
  if (opts.sharpen) img = { data: unsharp(img.data, img.w, img.h, opts.sharpen), w: img.w, h: img.h };
  return { data: img.data, w: img.w, h: img.h, crop, Hs: opts.Hs, gains: opts.gains, diag: opts.diag, dropped: opts.dropped || [], used: opts.used, timing: opts.timing };
}

function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
