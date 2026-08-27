// Generate raw RGBA frames of a wobbling glossy print on a table -> stdout (pipe to ffmpeg -> y4m)
import * as V from '../vision.js';
import { writeSync } from 'node:fs';

let seed = 777;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

const PW = 880, PH = 1070, BORD = { l: 45, r: 45, t: 60, b: 220 };
const style = process.argv[6] || 'white'; // white | black | pattern
function borderCol(x, y) {
  if (style === 'black') { const v = 22 + 4 * Math.sin(x * 0.02 + y * 0.013); return [v, v, v + 3]; }
  if (style === 'pattern') {
    const k = Math.floor((x + y) / 42) % 3;
    return k === 0 ? [242, 240, 236] : k === 1 ? [208, 64, 76] : [46, 112, 168];
  }
  return [250, 249, 245];
}
const print = new Uint8ClampedArray(PW * PH * 4);
for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
  const o = (y * PW + x) * 4;
  const inImg = x >= BORD.l && x < PW - BORD.r && y >= BORD.t && y < PH - BORD.b;
  let [r, g, b] = borderCol(x, y);
  if (inImg) {
    const u = (x - BORD.l) / 790, v = (y - BORD.t) / 790;
    r = 40 + 150 * u; g = 70 + 120 * v; b = 180 - 100 * v;
    if (((x >> 5) + (y >> 5)) & 1 && v > 0.5) { r *= 0.7; g *= 0.75; b *= 0.7; }
    if ((x % 120) < 4 || (y % 110) < 4) { r *= 0.45; g *= 0.45; b *= 0.45; }
    if (Math.hypot(x - 440, y - 380) < 100) { r = 245; g = 205; b = 80; }
    if (Math.abs(y - 700) < 30 && ((x >> 3) & 1)) { r = 30; g = 30; b = 30; }
  }
  print[o] = r; print[o + 1] = g; print[o + 2] = b; print[o + 3] = 255;
}

const CW = +(process.argv[2] || 1280), CH = +(process.argv[3] || 960), N = +(process.argv[4] || 60);
const table = (process.argv[5] === 'beige') ? [228, 220, 200] : [120, 95, 70];
const out = new Uint8ClampedArray(CW * CH * 4);
// base placement: print ~ 62% of frame height, centred
const ph = CH * 0.8, pw = ph * PW / PH;
const cx = CW / 2, cy = CH / 2;
for (let f = 0; f < N; f++) {
  const t = f / N * Math.PI * 2;
  // orbit: phone tilts -> corners shift differently (perspective), whole print drifts a bit
  const dx = Math.cos(t) * 28, dy = Math.sin(t) * 22;
  const kx = Math.sin(t) * 0.035, ky = Math.cos(t) * 0.03;
  const corners = [
    { x: cx - pw / 2 * (1 - kx) + dx, y: cy - ph / 2 * (1 - ky) + dy },
    { x: cx + pw / 2 * (1 + kx) + dx, y: cy - ph / 2 * (1 + ky) + dy },
    { x: cx + pw / 2 * (1 - kx) + dx, y: cy + ph / 2 * (1 + ky) + dy },
    { x: cx - pw / 2 * (1 + kx) + dx, y: cy + ph / 2 * (1 - ky) + dy },
  ];
  const glareMode = process.argv[7] || 'moving'; // moving | fixed (fixed = stays put in PRINT coords; tests the stuck-glare hint)
  const glare = glareMode === 'fixed'
    ? [{ x: cx + dx + 40, y: cy - 60 + dy, rx: 150, ry: 120, amp: 220 }] // rides with the print
    : [{ x: cx + Math.cos(t * 1.3) * 170, y: cy - 60 + Math.sin(t * 1.3) * 200, rx: 150, ry: 120, amp: 220 }];
  const Hc2p = V.solveHomography(corners, V.rectQuad(PW, PH));
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const p = V.applyH(Hc2p, x + 0.5, y + 0.5);
    const o = (y * CW + x) * 4;
    let r, g, b;
    if (p.x >= 0 && p.y >= 0 && p.x < PW && p.y < PH) {
      const ix = Math.min(PW - 1, p.x | 0), iy = Math.min(PH - 1, p.y | 0), i = (iy * PW + ix) * 4;
      r = print[i]; g = print[i + 1]; b = print[i + 2];
      for (const gl of glare) { const d2 = ((x - gl.x) ** 2) / (gl.rx ** 2) + ((y - gl.y) ** 2) / (gl.ry ** 2); const a = gl.amp * Math.exp(-d2 * 1.5); r += a; g += a; b += a * 0.95; }
      const sh = 0.97 - 0.05 * (x / CW); r *= sh; g *= sh; b *= sh;
    } else {
      const tn = (rnd() - 0.5) * 14; r = table[0] + tn; g = table[1] + tn; b = table[2] + tn;
      if (Math.sin(y * 0.05 + x * 0.003) > 0.93) { r -= 14; g -= 12; b -= 9; }
    }
    const nz = (rnd() - 0.5) * 8;
    out[o] = r + nz; out[o + 1] = g + nz; out[o + 2] = b + nz; out[o + 3] = 255;
  }
  writeSync(1, out);
  process.stderr.write(`frame ${f + 1}/${N}\r`);
}
