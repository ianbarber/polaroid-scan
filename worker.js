// worker.js — runs border detection and fusion off the main thread.
import * as V from './vision.js';

let session = null;           // last fusion inputs, kept so the glare slider can re-fuse without re-aligning
const scratch = {};           // reusable buffers for detection

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'detect') {
      const rgba = new Uint8ClampedArray(m.rgba);
      const n = m.w * m.h;
      if (!scratch.luma || scratch.luma.length !== n) scratch.luma = new Uint8Array(n);
      const luma = V.rgbaToLuma(rgba, n, scratch.luma);
      const result = V.detectBorder(luma, m.w, m.h, { region: m.region, expectedRatio: m.expectedRatio, lastThresh: m.lastThresh, seed: m.seed, borders: m.borders, rgba, scratch });
      self.postMessage({ id: m.id, type: 'detect', result });
    } else if (m.type === 'fuse') {
      const frames = m.frames.map(f => ({ data: new Uint8ClampedArray(f.data), w: f.w, h: f.h, quad: f.quad, sharp: f.sharp }));
      const opts = m.opts;
      const res = V.fusePipeline(frames, { ...opts, onProgress: (stage, f) => self.postMessage({ id: m.id, type: 'progress', stage, f }) });
      session = { frames, opts, Hs: res.Hs, gains: res.gains, diag: res.diag, used: res.used, dropped: res.dropped };
      post(m.id, 'fuse', res);
    } else if (m.type === 'refuse') {
      if (!session) throw new Error('nothing to re-fuse');
      const frames = session.used.map(i => session.frames[i]);
      const opts = { ...session.opts, ...m.opts };
      const { outW, outH } = session.opts;
      const fused = V.fuseAligned(frames, session.Hs, session.gains, outW, outH, { glarePct: opts.glarePct, onProgress: f => self.postMessage({ id: m.id, type: 'progress', stage: 'fuse', f }) });
      const res = V.finishPipeline(fused, { ...opts, Hs: session.Hs, gains: session.gains, diag: session.diag, dropped: session.dropped, used: session.used });
      post(m.id, 'refuse', res);
    } else if (m.type === 'reset') {
      session = null;
    }
  } catch (err) {
    self.postMessage({ id: m.id, type: 'error', error: String((err && err.stack) || err) });
  }
};

function post(id, type, res) {
  const buf = res.data.buffer;
  self.postMessage({
    id, type,
    result: { data: buf, w: res.w, h: res.h, crop: res.crop, diag: res.diag, dropped: res.dropped, used: res.used, timing: res.timing, gains: res.gains },
  }, [buf]);
}
