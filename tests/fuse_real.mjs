// Re-run fusion offline on real debug captures: node tests/fuse_real.mjs <dir of .raw+.json> <out.png> [glarePct]
// (.raw = RGBA from jpg2raw.py; .json = the capture's debug JSON with its quad; frames assumed 1950×2600 unless w/h given)
import * as V from '../vision.js';
import { readFileSync, readdirSync } from 'node:fs';
import { writePNG } from './png.mjs';
const [dir, out, gp] = process.argv.slice(2);
const W = +(process.env.W || 1950), H = +(process.env.H || 2600);
const frames = readdirSync(dir).filter(f => f.endsWith('.raw')).sort().map(f => {
  const meta = JSON.parse(readFileSync(`${dir}/${f.replace('.raw', '.json')}`));
  return { data: new Uint8ClampedArray(readFileSync(`${dir}/${f}`).buffer), w: W, h: H, quad: meta.quad.map(([x, y]) => ({ x, y })), sharp: meta.sharp };
});
const outW = 1809, outH = 2200;
const borders = { l: 4.5 / 88, r: 4.5 / 88, t: 6 / 107, b: 22 / 107 };
const t = Date.now();
const res = V.fusePipeline(frames, { outW, outH, glarePct: gp == null ? 65 : +gp, borders, autoCrop: false, sharpen: 0, dehaze: !process.env.NODEHAZE, onProgress: () => { } });
console.log('haze', JSON.stringify(res.hazeInfo));
console.log('sharp', res.diag.map(d => d.sharp).join(' '));
console.log(`${frames.length} frames, ${Date.now() - t}ms, dropped ${JSON.stringify(res.dropped)}`);
writePNG(out, res.data, res.w, res.h);
