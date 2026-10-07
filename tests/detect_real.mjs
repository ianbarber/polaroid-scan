// Run detector on real captures (raw RGBA from jpg2raw.py); draw quad; write PNG
import * as V from '../vision.js';
import { readFileSync } from 'node:fs';
import { writePNG } from './png.mjs';

const [raw, w, h, outPng] = [process.argv[2], +process.argv[3], +process.argv[4], process.argv[5]];
const data = new Uint8ClampedArray(readFileSync(raw).buffer);
// downscale to 640 wide (box)
const tw = 640, s = w / tw, th = Math.round(h / s);
const luma = new Uint8Array(tw * th);
const rgba = new Uint8ClampedArray(tw * th * 4);
for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
  const x0 = Math.floor(x * s), y0 = Math.floor(y * s), x1 = Math.floor((x + 1) * s), y1 = Math.floor((y + 1) * s);
  let sr = 0, sg = 0, sb = 0, c = 0;
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * w + xx) * 4; sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; c++; }
  const o = (y * tw + x) * 4;
  rgba[o] = sr / c; rgba[o + 1] = sg / c; rgba[o + 2] = sb / c; rgba[o + 3] = 255;
  luma[y * tw + x] = 0.299 * sr / c + 0.587 * sg / c + 0.114 * sb / c;
}
// region: the app's guide is ~72% of viewport width, centred. Here just use the central 90%.
const region = { x: tw * 0.05, y: th * 0.03, w: tw * 0.9, h: th * 0.94 };
const t0 = Date.now();
const seed = { x: tw * 0.15, y: th * 0.1, w: tw * 0.7, h: th * 0.8 };
const det = V.detectBorder(luma, tw, th, { region, expectedRatio: 88 / 107, rgba, seed, borders: process.env.NOWIN ? null : { l: 4.5 / 88, r: 4.5 / 88, t: 6 / 107, b: 22 / 107 } });
console.log(`${raw}: ${Date.now() - t0}ms`, det ? { mode: det.mode, thresh: det.thresh, score: det.score.toFixed(3), inliers: det.inliers.toFixed(2), ratio: det.ratio.toFixed(3), centerFill: det.centerFill.toFixed(2), band: det.band, sharp: det.sharp.toFixed(0), quad: det.quad.map(p => `${(p.x * s).toFixed(0)},${(p.y * s).toFixed(0)}`).join(' ') } : 'NO DETECTION');
if (det && outPng) {
  const out = data.slice();
  const q = det.quad.map(p => ({ x: p.x * s, y: p.y * s }));
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], L = Math.hypot(b.x - a.x, b.y - a.y);
    for (let t = 0; t < L; t += 0.5) {
      const x = Math.round(a.x + (b.x - a.x) * t / L), y = Math.round(a.y + (b.y - a.y) * t / L);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const o = (yy * w + xx) * 4; out[o] = 0; out[o + 1] = 255; out[o + 2] = 0;
      }
    }
  }
  writePNG(outPng, out, w, h);
}
