// Synthetic end-to-end test for vision.js
import * as V from '../vision.js';
import { writePNG } from './png.mjs';
// ---- deterministic RNG
let seed = 12345;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

// ---- ground-truth print texture (outer 880×1070 px = 88×107mm @10px/mm)
const PW = 880, PH = 1070, BORD = { l: 45, r: 45, t: 55, b: 225 };
const style = process.argv[5] || 'white'; // white | black | pattern
function borderCol(x, y) {
  if (style === 'black') { const v = 22 + 4 * Math.sin(x * 0.02 + y * 0.013); return [v, v, v + 3]; }
  if (style === 'pattern') {
    const k = Math.floor((x + y) / 42) % 3;
    return k === 0 ? [242, 240, 236] : k === 1 ? [208, 64, 76] : [46, 112, 168];
  }
  return [248, 247, 243];
}
const print = new Uint8ClampedArray(PW * PH * 4);
for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
  const o = (y * PW + x) * 4;
  const inImg = x >= BORD.l && x < PW - BORD.r && y >= BORD.t && y < PH - BORD.b;
  let [r, g, b] = borderCol(x, y);
  if (inImg) {
    const u = (x - BORD.l) / 790, v = (y - BORD.t) / 790;
    // textured scene: gradient sky + stripes + checker detail + fine lines
    r = 60 + 120 * u; g = 90 + 100 * v; b = 170 - 80 * v;
    if (((x >> 4) + (y >> 4)) & 1 && v > 0.55) { r *= 0.75; g *= 0.8; b *= 0.7; }
    if (Math.sin(x * 0.35) > 0.9 && v < 0.5) { r += 60; g += 60; b += 40; }
    if ((x % 97) < 3 || (y % 89) < 3) { r *= 0.5; g *= 0.5; b *= 0.5; }
    if (Math.hypot(x - 450, y - 400) < 90) { r = 250; g = 210; b = 90; }
    // fine text-like detail
    if (((x * 7 + y * 13) % 101) < 2 && u > 0.6 && v > 0.6) { r = 20; g = 20; b = 20; }
  }
  print[o] = r; print[o + 1] = g; print[o + 2] = b; print[o + 3] = 255;
}
writePNG(process.argv[2] + '/gt.png', print, PW, PH);

// ---- camera frame renderer: maps camera px -> print px via inverse homography
const CW = 1920, CH = 1440;
function renderFrame(cornersCam, glare, tableRGB, noise, blur) {
  // cornersCam: TL,TR,BR,BL in camera coords where print corners land
  const Hc2p = V.solveHomography(cornersCam, V.rectQuad(PW, PH)); // camera -> print
  const out = new Uint8ClampedArray(CW * CH * 4);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const p = V.applyH(Hc2p, x + 0.5, y + 0.5);
    const o = (y * CW + x) * 4;
    let r, g, b;
    if (p.x >= 0 && p.y >= 0 && p.x < PW && p.y < PH) {
      // bilinear sample of print
      const sx = p.x - 0.5, sy = p.y - 0.5;
      const ix = Math.max(0, Math.min(PW - 2, Math.floor(sx))), iy = Math.max(0, Math.min(PH - 2, Math.floor(sy)));
      const fx = Math.min(1, Math.max(0, sx - ix)), fy = Math.min(1, Math.max(0, sy - iy));
      const i00 = (iy * PW + ix) * 4, i10 = i00 + 4, i01 = i00 + PW * 4, i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      r = print[i00] * w00 + print[i10] * w10 + print[i01] * w01 + print[i11] * w11;
      g = print[i00 + 1] * w00 + print[i10 + 1] * w10 + print[i01 + 1] * w01 + print[i11 + 1] * w11;
      b = print[i00 + 2] * w00 + print[i10 + 2] * w10 + print[i01 + 2] * w01 + print[i11 + 2] * w11;
      // specular glare (camera space gaussian) only on the glossy print
      for (const gl of glare) {
        const d2 = ((x - gl.x) ** 2) / (gl.rx ** 2) + ((y - gl.y) ** 2) / (gl.ry ** 2);
        const a = gl.amp * Math.exp(-d2 * 1.5);
        r += a; g += a; b += a * 0.95;
      }
      // tilt shading: gentle gradient
      const sh = 1 - 0.08 * (x / CW);
      r *= sh; g *= sh; b *= sh;
    } else {
      const tn = (rnd() - 0.5) * 18;
      r = tableRGB[0] + tn; g = tableRGB[1] + tn; b = tableRGB[2] + tn;
      // wood-grain lines
      if (Math.sin(y * 0.07 + x * 0.004) > 0.95) { r -= 15; g -= 12; b -= 10; }
    }
    r += (rnd() - 0.5) * noise; g += (rnd() - 0.5) * noise; b += (rnd() - 0.5) * noise;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
  }
  return { data: out, w: CW, h: CH };
}

function downscaleLuma(frame, tw) {
  const s = frame.w / tw, th = Math.round(frame.h / s);
  const luma = new Uint8Array(tw * th);
  const rgba = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    // box average of s×s
    const x0 = Math.floor(x * s), y0 = Math.floor(y * s), x1 = Math.floor((x + 1) * s), y1 = Math.floor((y + 1) * s);
    let sr = 0, sg = 0, sb = 0, c = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * frame.w + xx) * 4; sr += frame.data[i]; sg += frame.data[i + 1]; sb += frame.data[i + 2]; c++; }
    const o = (y * tw + x) * 4;
    rgba[o] = sr / c; rgba[o + 1] = sg / c; rgba[o + 2] = sb / c; rgba[o + 3] = 255;
    luma[y * tw + x] = 0.299 * sr / c + 0.587 * sg / c + 0.114 * sb / c;
  }
  return { luma, rgba, w: tw, h: th, scale: s };
}

// ---- scenario
const outDir = process.argv[2];
const table = process.argv[3] === 'beige' ? [232, 225, 208] : [130, 105, 75];
const K = +(process.argv[4] || 9);
const base = [{ x: 560, y: 140 }, { x: 1360, y: 140 }, { x: 1360, y: 1300 }, { x: 560, y: 1300 }];
const frames = [], gtQuads = [];
let detErr = [], detFail = 0;
const t0 = Date.now();
for (let k = 0; k < K; k++) {
  const jit = 45;
  const corners = base.map(p => ({ x: p.x + (rnd() - 0.5) * jit * 2, y: p.y + (rnd() - 0.5) * jit * 2 }));
  const ang = k / K * Math.PI * 2;
  const glare = [{ x: 960 + Math.cos(ang) * 260, y: 720 + Math.sin(ang) * 300, rx: 170 + rnd() * 80, ry: 140 + rnd() * 80, amp: 210 }];
  const f = renderFrame(corners, glare, table, 10, 0);
  gtQuads.push(corners);
  if (k === 0) writePNG(outDir + '/frame0.png', f.data, f.w, f.h);
  // detection at 640-wide preview (like the app)
  const ds = downscaleLuma(f, 640);
  const region = { x: 640 * 0.2, y: ds.h * 0.02, w: 640 * 0.6, h: ds.h * 0.96 };
  const td = Date.now();
  const seed = {
    x: (base[0].x - 60) / ds.scale, y: (base[0].y - 60) / ds.scale,
    w: (base[1].x - base[0].x + 120) / ds.scale, h: (base[3].y - base[0].y + 120) / ds.scale,
  };
  const det = V.detectBorder(ds.luma, ds.w, ds.h, { region, expectedRatio: 88 / 107, rgba: ds.rgba, seed, debug: !!process.env.DBG });
  const dt = Date.now() - td;
  if (!det) { detFail++; console.log(`frame ${k}: DETECT FAIL (${dt}ms)`); continue; }
  const q = det.quad.map(p => ({ x: p.x * ds.scale, y: p.y * ds.scale }));
  const err = q.map((p, i) => Math.hypot(p.x - corners[i].x, p.y - corners[i].y));
  detErr.push(...err);
  console.log(`frame ${k}: ${det.mode} t${det.thresh} score ${det.score.toFixed(3)} inl ${det.inliers.toFixed(2)} ratio ${det.ratio.toFixed(3)} sharp ${det.sharp.toFixed(0)} corner err px: ${err.map(e => e.toFixed(1)).join(' ')} (${dt}ms)`);
  frames.push({ data: f.data, w: f.w, h: f.h, quad: q, sharp: det.sharp });
}
console.log(`render+detect: ${Date.now() - t0}ms, detect fails ${detFail}/${K}, mean corner err ${(detErr.reduce((a, b) => a + b, 0) / detErr.length).toFixed(2)}px, max ${Math.max(...detErr).toFixed(2)}px`);

// ---- fuse
if (frames.length < 2) { console.log('fewer than 2 frames detected — skipping fusion'); process.exit(1); }
const outW = 1809, outH = 2200;
const borders = { l: 45 / 880, r: 45 / 880, t: 55 / 1070, b: 225 / 1070 };
const t1 = Date.now();
const res = V.fusePipeline(frames, { outW, outH, glarePct: 65, borders, autoCrop: false, sharpen: 0, onProgress: () => { } });
console.log(`fuse pipeline: ${Date.now() - t1}ms  (align ${res.timing.align.toFixed(0)}ms fuse ${res.timing.fuse.toFixed(0)}ms)`);
for (let k = 0; k < frames.length; k++) console.log(`  frame ${k}: align shift ${res.diag[k].shift.toFixed(2)}px conf ${res.diag[k].conf.toFixed(2)} cells ${res.diag[k].cells} gains ${res.gains[k].map(g => g.toFixed(3)).join(',')}`);
writePNG(outDir + '/fused.png', res.data, res.w, res.h);

// ---- compare against ground-truth rendered directly into out space (no glare, no noise)
const Hgt = V.solveHomography(V.rectQuad(outW, outH), V.rectQuad(PW, PH));
const gtOut = new Float32Array(outW * outH * 3);
V.warpPatch({ data: print, w: PW, h: PH }, Hgt, 0, 0, outW, outH, 1, gtOut, null);
function psnr(img, label, maskShade) {
  let se = 0, n = 0;
  for (let y = 40; y < outH - 40; y++) for (let x = 40; x < outW - 40; x++) {
    const p = y * outW + x;
    for (let c = 0; c < 3; c++) { const d = img[p * 4 + c] - gtOut[p * 3 + c]; se += d * d; n++; }
  }
  const mse = se / n; console.log(`${label}: RMSE ${Math.sqrt(mse).toFixed(2)}  PSNR ${(10 * Math.log10(255 * 255 / mse)).toFixed(2)} dB`);
}
psnr(res.data, 'fused (aligned, robust)');
// naive: plain average with initial homographies, for comparison
const Hs0 = frames.map(f => V.solveHomography(V.rectQuad(outW, outH), f.quad));
const naive = V.fuseAligned(frames, Hs0, null, outW, outH, { glarePct: 0 });
psnr(naive.data, 'naive mean, detection-only alignment');
writePNG(outDir + '/naive.png', naive.data, outW, outH);
const single = V.fuseAligned([frames[0]], [Hs0[0]], null, outW, outH, { glarePct: 0 });
psnr(single.data, 'single frame 0');
// crop test
const crop = V.refineInnerCrop(res.data, res.w, res.h, borders);
console.log('inner crop', crop, 'nominal', { x: Math.round(borders.l * outW), y: Math.round(borders.t * outH), w: Math.round((1 - borders.l - borders.r) * outW), h: Math.round((1 - borders.t - borders.b) * outH) });
const cropped = V.cropRGBA(res.data, res.w, res.h, crop);
writePNG(outDir + '/cropped.png', cropped.data, cropped.w, cropped.h);
