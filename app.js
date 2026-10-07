// app.js — Polaroid Scan: camera, live border detection, burst capture, worker fusion, UI.
// No build step. All processing on-device (vision.js, run inside worker.js).
import * as V from './vision.js';

const FORMATS = {
  'polaroid':      { label: 'Polaroid 600 / i-Type', outerW: 88,   outerH: 107,  borders: { l: 4.5, r: 4.5, t: 6, b: 22 },        note: '88×107 mm · image 79×79' },
  'polaroid-go':   { label: 'Polaroid Go',           outerW: 53.9, outerH: 66.8, borders: { l: 3.45, r: 3.45, t: 5.5, b: 15.3 },  note: '54×67 mm · image 47×46' },
  'instax-mini':   { label: 'Instax Mini',           outerW: 54,   outerH: 86,   borders: { l: 4, r: 4, t: 6, b: 18 },            note: '54×86 mm · image 46×62' },
  'instax-square': { label: 'Instax Square',         outerW: 72,   outerH: 86,   borders: { l: 5, r: 5, t: 6, b: 18 },            note: '72×86 mm · image 62×62' },
  'instax-wide':   { label: 'Instax Wide',           outerW: 108,  outerH: 86,   borders: { l: 4.5, r: 4.5, t: 6, b: 18 },        note: '108×86 mm · image 99×62' },
  'custom':        { label: 'Custom',                outerW: 88,   outerH: 107,  borders: { l: 4.5, r: 4.5, t: 6, b: 22 },        note: 'custom' },
};
for (const f of Object.values(FORMATS)) {
  f.outerRatio = f.outerW / f.outerH;
  f.borderFrac = { l: f.borders.l / f.outerW, r: f.borders.r / f.outerW, t: f.borders.t / f.outerH, b: f.borders.b / f.outerH };
}

const MAX_FRAMES = 12;
const SCAN_TIMEOUT_MS = 9000;
const MAX_CAPTURE_LONG_SIDE = 2600;   // cap stored frame size (memory on phones)
const DETECT_WIDTH = 640;             // detection works on a 640-wide luma image

// ---------------------------------------------------------------- DOM
const $ = s => document.querySelector(s);
const video = $('#video');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const proc = $('#processing');
const pctx = proc.getContext('2d', { willReadFrequently: true });
const guide = $('.guide-frame');
const resultCanvas = $('#resultCanvas');
const rctx = resultCanvas.getContext('2d');
const formatSel = $('#formatSelect');
const startBtn = $('#startBtn');
const captureBtn = $('#captureBtn');
const stopBtn = $('#stopBtn');
const switchBtn = $('#switchBtn');
const editCornersBtn = $('#editCornersBtn');
const glareRange = $('#glareRange');
const glareVal = $('#glareVal');
const strip = $('#captureStrip');
const resultPanel = $('#resultPanel');
const liveStats = $('#liveStats');
const hint = $('#hint');
const autoDetectChk = $('#autoDetect');
const hiResChk = $('#hiRes');
const stillsChk = $('#useStills');
const debugChk = $('#debugSave');
const progressBox = $('#captureProgress');
const progressBar = $('#progressBar');
const progressText = $('#progressText');

// ---------------------------------------------------------------- persisted settings
function persistCheckbox(el, key, def) {
  if (!el) return;
  try {
    const v = localStorage.getItem(key);
    el.checked = v === null ? def : v === '1';
    el.addEventListener('change', () => localStorage.setItem(key, el.checked ? '1' : '0'));
  } catch { }
}
persistCheckbox(debugChk, 'polascan-debugSave', false);
persistCheckbox(hiResChk, 'polascan-hiRes', true);
persistCheckbox(stillsChk, 'polascan-stills', false);
persistCheckbox(autoDetectChk, 'polascan-autoDetect', true);
try { const g = localStorage.getItem('polascan-glare'); if (g !== null) glareRange.value = g; } catch { }
glareVal.textContent = glareRange.value + '%';

// ---------------------------------------------------------------- debug saves (IndexedDB + POST /save)
const DEBUG_DB = 'polascan-debug';
function idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DEBUG_DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('saves', { keyPath: 'id', autoIncrement: true }); };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function saveToIDB(blob, meta) {
  try {
    const db = await idbOpen();
    const tx = db.transaction('saves', 'readwrite');
    const store = tx.objectStore('saves');
    store.add({ blob, meta, ts: Date.now() });
    const countReq = store.count();
    countReq.onsuccess = () => {
      if (countReq.result > 60) {
        let toDelete = countReq.result - 50;
        const c = store.openCursor();
        c.onsuccess = () => { const cur = c.result; if (cur && toDelete > 0) { cur.delete(); toDelete--; cur.continue(); } };
      }
    };
  } catch (e) { console.warn('idb save failed', e); }
}
async function postToServer(blob, filename, meta) {
  try {
    const headers = new Headers();
    headers.set('X-Filename', filename);
    headers.set('X-Meta', JSON.stringify(meta));
    const res = await fetch('/save', { method: 'POST', headers, body: blob });
    if (!res.ok) throw new Error('no server save');
    return await res.json().catch(() => ({}));
  } catch { return null; }
}
function debugEnabled() { return !!(debugChk && debugChk.checked); }
async function saveLocally(blob, filename, meta) {
  if (!debugEnabled()) return;
  await saveToIDB(blob, { filename, ...meta });
  await postToServer(blob, filename, meta);
}
function debugFilename(prefix, ext = 'jpg') {
  const f = currentFormat().label.replace(/[^a-z0-9]+/gi, '_').slice(0, 20);
  return `${prefix}-${f}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`;
}
function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise(res => canvas.toBlob(b => res(b), type, quality));
}

// ---------------------------------------------------------------- vision client (worker with inline fallback)
class VisionClient {
  constructor() {
    this.pending = new Map(); this.nextId = 1; this.inline = false; this.worker = null; this._scratch = {};
    this._spawn();
  }
  _spawn() {
    try {
      this.worker = new Worker('./worker.js', { type: 'module' });
      this.worker.onmessage = e => this._onMsg(e.data);
      this.worker.onerror = e => { console.warn('vision worker error — falling back to inline', e.message || e); this._fallback(); };
    } catch (e) { this._fallback(); }
  }
  _fallback() {
    this.inline = true;
    if (this.worker) { try { this.worker.terminate(); } catch { } this.worker = null; }
    for (const p of this.pending.values()) p.reject(new Error('worker unavailable'));
    this.pending.clear();
  }
  _onMsg(m) {
    const p = this.pending.get(m.id); if (!p) return;
    if (m.type === 'progress') { p.onProgress && p.onProgress(m.stage, m.f); return; }
    this.pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.error)); else p.resolve(m.result);
  }
  _call(msg, transfer, onProgress) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...msg, id }, transfer || []);
    });
  }
  async detect(rgba, w, h, region, expectedRatio, lastThresh, seed, borders) {
    if (!this.inline) {
      try { return await this._call({ type: 'detect', rgba: rgba.buffer, w, h, region, expectedRatio, lastThresh, seed, borders }, [rgba.buffer]); }
      catch (e) {
        if (!this.inline) throw e;
        return null; // buffer was transferred before the worker died — skip this tick, next one runs inline
      }
    }
    const luma = V.rgbaToLuma(rgba, w * h);
    return V.detectBorder(luma, w, h, { region, expectedRatio, lastThresh, seed, borders, rgba, scratch: this._scratch });
  }
  async fuse(frames, opts, onProgress) {
    if (!this.inline) {
      const msg = { type: 'fuse', frames: frames.map(f => ({ data: f.data.buffer, w: f.w, h: f.h, quad: f.quad, sharp: f.sharp })), opts };
      return this._call(msg, frames.map(f => f.data.buffer), onProgress);
    }
    this._session = { frames, opts };
    const res = V.fusePipeline(frames, { ...opts, onProgress });
    this._session.res = res;
    return res;
  }
  async refuse(opts, onProgress) {
    if (!this.inline) return this._call({ type: 'refuse', opts }, [], onProgress);
    const s = this._session; if (!s) throw new Error('nothing to re-fuse');
    const used = s.res.used.map(i => s.frames[i]);
    const o = { ...s.opts, ...opts };
    const fused = V.fuseAligned(used, s.res.Hs, s.res.gains, s.opts.outW, s.opts.outH, { glarePct: o.glarePct, onProgress: f => onProgress && onProgress('fuse', f) });
    return V.finishPipeline(fused, { ...o, Hs: s.res.Hs, gains: s.res.gains, diag: s.res.diag, dropped: s.res.dropped, used: s.res.used });
  }
  // Free the retained fusion inputs (frames can be 50-100 MB on hi-res scans).
  reset() {
    this._session = null;
    if (this.worker) { try { this.worker.postMessage({ type: 'reset' }); } catch { } }
  }
  // Hard cancel: kill the worker (drops any running fusion) and start a fresh one.
  cancelAll() {
    for (const p of this.pending.values()) p.reject(new Error('cancelled'));
    this.pending.clear();
    if (this.worker) { try { this.worker.terminate(); } catch { } this.worker = null; this._spawn(); }
    this._session = null;
  }
}
const vision = new VisionClient();

// ---------------------------------------------------------------- state
let stream = null;
let facing = 'environment';
let raf = 0;
let imageCapture = null;
let frames = [];                 // captured frames: {data,w,h,quad,sharp,ts}
let capturing = false;
let captureBusy = false;
let fusing = false;
let refusing = false;            // glare-slider re-fuse in progress (quick, not cancellable)
let scanSession = 0;             // bumps on every scan start/cancel so stale async work is ignored
let scanTimer = null;
let scanRotated = false;
let firstArea = 0;
let detectedQuad = null;         // live detection, video px
let detInfo = null;              // {sharp, brightFrac, score, rotated, thresh}
let lastDetectAt = 0;
let detectPending = false;
let lastDetectTick = 0;
let lastThresh = null;
let sharpRef = 0;                // running max of sharpness while border visible (content-adaptive)
let noDetectSince = 0;
let manualQuad = null;           // user-dragged override, video px
let dragIdx = -1;
let currentResult = null;
let lastCap = 0;
let glareTrail = [];             // per-captured-frame glare {frac,u,v} in print coords

// ---------------------------------------------------------------- format / guide
function currentFormat() { return FORMATS[formatSel.value] || FORMATS.polaroid; }
function updateGuideAspect() {
  guide.style.setProperty('--guide-ratio', currentFormat().outerRatio.toString());
}
try { const saved = localStorage.getItem('polascan-format'); if (saved && FORMATS[saved]) formatSel.value = saved; } catch { }
formatSel.addEventListener('change', () => { try { localStorage.setItem('polascan-format', formatSel.value); } catch { } updateGuideAspect(); });
updateGuideAspect();

$('#helpBtn').onclick = () => $('#helpSheet').classList.remove('hidden');
$('#closeHelp').onclick = () => $('#helpSheet').classList.add('hidden');
const settingsToggle = $('#settingsToggle'), settingsDrawer = $('#settingsDrawer');
settingsToggle.addEventListener('click', () => {
  const hidden = settingsDrawer.classList.toggle('hidden');
  settingsToggle.setAttribute('aria-expanded', hidden ? 'false' : 'true');
});
debugChk.addEventListener('change', () => liveStats.classList.toggle('hidden', !(debugChk.checked && stream)));

// ---------------------------------------------------------------- camera
async function startCamera() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); }
  imageCapture = null;
  const constraints = { video: { facingMode: facing, width: { ideal: 4032 }, height: { ideal: 3024 }, frameRate: { ideal: 30 } }, audio: false };
  try { stream = await navigator.mediaDevices.getUserMedia(constraints); }
  catch (e) {
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 } }, audio: false }); }
    catch (e2) { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false }); }
  }
  try {
    const track = stream.getVideoTracks()[0];
    if (track) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous', exposureMode: 'continuous', whiteBalanceMode: 'continuous' }] }).catch(() => { });
      if (stillsChk.checked && 'ImageCapture' in window) { try { imageCapture = new ImageCapture(track); } catch { } }
    }
  } catch { }
  video.srcObject = stream;
  await video.play().catch(() => { });
  await new Promise(r => setTimeout(r, 250));
  resizeOverlay();
  startLoop();
  startBtn.classList.add('hidden');
  captureBtn.classList.remove('hidden');
  stopBtn.classList.remove('hidden');
  stopBtn.textContent = 'Stop';
  liveStats.classList.toggle('hidden', !debugChk.checked);
  progressBox.classList.add('hidden');
  captureBtn.textContent = '● Scan';
  captureBtn.disabled = false;
  sharpRef = 0;
  setStatus('Looking for the print border…', 'bad');
}

function stopCamera() {
  cancelScan(true);
  scanSession++; // invalidate any async work still in flight
  cancelAnimationFrame(raf);
  if (stream) { try { stream.getTracks().forEach(t => t.stop()); } catch { } stream = null; }
  video.srcObject = null;
  detectedQuad = null; detInfo = null;
  liveStats.classList.add('hidden');
  startBtn.classList.remove('hidden');
  captureBtn.classList.add('hidden');
  stopBtn.classList.add('hidden');
  editCornersBtn.classList.add('hidden');
  manualQuad = null;
  octx.clearRect(0, 0, overlay.width, overlay.height);
  setStatus('Camera off — tap Start camera', 'bad');
}

switchBtn.onclick = async () => { facing = facing === 'environment' ? 'user' : 'environment'; if (stream) await startCamera(); };
startBtn.onclick = startCamera;
stopBtn.onclick = () => {
  if (capturing) { cancelScan(false); return; }
  if (fusing) { cancelFusion(); return; }
  stopCamera();
};

function resizeOverlay() {
  const rect = video.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  overlay.width = Math.round(rect.width * dpr);
  overlay.height = Math.round(rect.height * dpr);
  overlay.style.width = rect.width + 'px';
  overlay.style.height = rect.height + 'px';
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vw = video.videoWidth || 4, vh = video.videoHeight || 3;
  proc.width = DETECT_WIDTH; proc.height = Math.round(DETECT_WIDTH * vh / vw);
}
window.addEventListener('resize', resizeOverlay);

// Guide rect in video pixel coordinates, plus the mapping between video px and CSS px.
function computeGuideRect() {
  const vRect = video.getBoundingClientRect();
  const gRect = guide.getBoundingClientRect();
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const vr = vw / vh, er = vRect.width / vRect.height;
  let drawW, drawH, offX, offY;
  if (vr > er) { drawH = vRect.height; drawW = drawH * vr; offX = (vRect.width - drawW) / 2; offY = 0; }
  else { drawW = vRect.width; drawH = drawW / vr; offX = 0; offY = (vRect.height - drawH) / 2; }
  const s = vw / drawW; // video px per CSS px
  return {
    x: (gRect.left - vRect.left - offX) * s, y: (gRect.top - vRect.top - offY) * s, w: gRect.width * s, h: gRect.height * s,
    offX, offY, s,
  };
}
function videoToScreen(p, gr) { return { x: p.x / gr.s + gr.offX, y: p.y / gr.s + gr.offY }; }
function screenToVideo(p, gr) { return { x: (p.x - gr.offX) * gr.s, y: (p.y - gr.offY) * gr.s }; }
function quadFromRect(r) { return [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }]; }
function quadWidth(q) { return (Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / 2; }

// ---------------------------------------------------------------- live detection loop
function startLoop() {
  cancelAnimationFrame(raf);
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!video.videoWidth) return;
    const now = performance.now();
    if (now - lastDetectTick > 100 && !detectPending && !captureBusy) {
      lastDetectTick = now;
      runLiveDetection();
    }
    drawOverlay();
  };
  tick();
}

async function runLiveDetection() {
  if (!autoDetectChk.checked) { detectedQuad = null; detInfo = null; updateStatus(); return; }
  detectPending = true;
  try {
    if (proc.height < 10) resizeOverlay();
    pctx.drawImage(video, 0, 0, proc.width, proc.height);
    const img = pctx.getImageData(0, 0, proc.width, proc.height);
    const k = proc.width / video.videoWidth;
    // search the whole frame — the guide only bands the patterned-border fallback
    const region = { x: proc.width * 0.01, y: proc.height * 0.01, w: proc.width * 0.98, h: proc.height * 0.98 };
    const gr0 = computeGuideRect();
    const seed = { x: gr0.x * k, y: gr0.y * k, w: gr0.w * k, h: gr0.h * k };
    const det = await vision.detect(img.data, proc.width, proc.height, region, currentFormat().outerRatio, lastThresh, seed, currentFormat().borderFrac);
    const t = performance.now();
    if (det) {
      detectedQuad = det.quad.map(p => ({ x: p.x / k, y: p.y / k }));
      detInfo = det; lastDetectAt = t; lastThresh = det.thresh; noDetectSince = 0;
      if (det.sharp > sharpRef) sharpRef = det.sharp; else sharpRef = sharpRef * 0.995 + det.sharp * 0.005;
    } else {
      if (t - lastDetectAt > 600) { detectedQuad = null; detInfo = null; }
      if (!noDetectSince) noDetectSince = t;
    }
    if (debugChk.checked) {
      $('#statFrames').textContent = `${frames.length} frames`;
      $('#statSharp').textContent = det ? `sharp ${Math.round(det.sharp)} / ref ${Math.round(sharpRef)}` : 'sharp —';
      $('#statGlare').textContent = det ? `bright ${(det.brightFrac * 100).toFixed(1)}%` : 'bright —';
      $('#statDrift').textContent = det ? `${det.mode} ${det.score.toFixed(2)}${det.rotated ? ' rot' : ''}` : 'no border';
    }
    updateStatus();
    if (capturing && det) maybeAutoCapture(det);
  } catch (e) { console.warn('detect failed', e); }
  finally { detectPending = false; }
}

// ---------------------------------------------------------------- status / overlay
let stickyUntil = 0;
function setStatus(text, state, stickyMs) {
  hint.textContent = text;
  for (const el of [guide, hint]) { el.classList.remove('ok', 'warn', 'bad'); el.classList.add(state); }
  stickyUntil = stickyMs ? performance.now() + stickyMs : 0;
}
function updateStatus() {
  if (!stream) return;
  if (fusing || refusing) return;
  if (performance.now() < stickyUntil) return;
  const fresh = detectedQuad && performance.now() - lastDetectAt < 400;
  if (capturing) {
    if (!fresh) setStatus(`Scanning ${frames.length}/${MAX_FRAMES} — border lost, bring the print back in view`, 'bad');
    else if (detInfo.brightFrac > 0.3) setStatus(`Scanning ${frames.length}/${MAX_FRAMES} — big reflection, move so it shifts`, 'warn');
    else if (detInfo.sharp < 0.5 * sharpRef) setStatus(`Scanning ${frames.length}/${MAX_FRAMES} — slow down, blurry`, 'warn');
    else if (glareStuck()) setStatus(`Scanning ${frames.length}/${MAX_FRAMES} — reflection isn't moving: tilt a little as you circle`, 'warn');
    else setStatus(`Scanning ${frames.length}/${MAX_FRAMES} — keep circling slowly over the print`, 'ok');
    progressBar.style.width = `${(frames.length / MAX_FRAMES) * 100}%`;
    progressText.textContent = `${frames.length} / ${MAX_FRAMES}`;
    return;
  }
  if (manualQuad) { setStatus('Manual corners — drag the yellow dots onto the print corners, then tap Scan', 'warn'); return; }
  if (!fresh) {
    const secs = noDetectSince ? (performance.now() - noDetectSince) / 1000 : 0;
    if (secs > 3) editCornersBtn.classList.remove('hidden');
    setStatus(secs > 3 ? 'No border found — try a plain table that contrasts with the border, or set corners manually (✢)' : 'Fit the print inside the frame', 'bad');
    return;
  }
  editCornersBtn.classList.add('hidden');
  if (detInfo.sharp < 0.5 * sharpRef) setStatus('Hold still — focusing…', 'warn');
  else if (detInfo.brightFrac > 0.25) setStatus('Border found — big reflection, shift or tilt a little', 'warn');
  else setStatus('Border found ✓ — tap Scan, then slowly circle the phone over the print', 'ok');
}

// Reflection present in the last few captured frames but sitting still (in print coords)?
// Level circling normally walks it around; when it doesn't, only extra tilt will.
function glareStuck() {
  const t = glareTrail.slice(-3);
  if (t.length < 3 || t.some(g => g.frac < 0.025)) return false;
  let spread = 0;
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
    spread = Math.max(spread, Math.hypot(t[i].u - t[j].u, t[i].v - t[j].v));
  }
  return spread < 0.09;
}

function drawOverlay() {
  const vW = overlay.width / Math.min(devicePixelRatio || 1, 2), vH = overlay.height / Math.min(devicePixelRatio || 1, 2);
  octx.clearRect(0, 0, vW, vH);
  if (!video.videoWidth) return;
  const gr = computeGuideRect();
  const drawQuad = (q, color, width, dash) => {
    octx.save(); octx.strokeStyle = color; octx.lineWidth = width; octx.setLineDash(dash || []);
    octx.beginPath();
    const s0 = videoToScreen(q[0], gr); octx.moveTo(s0.x, s0.y);
    for (let i = 1; i < 4; i++) { const s = videoToScreen(q[i], gr); octx.lineTo(s.x, s.y); }
    octx.closePath(); octx.stroke(); octx.restore();
  };
  if (manualQuad && !capturing) {
    drawQuad(manualQuad, '#ffd60a', 2, [8, 4]);
    for (const pt of manualQuad) {
      const sc = videoToScreen(pt, gr);
      octx.fillStyle = '#ffd60a'; octx.strokeStyle = '#000'; octx.lineWidth = 1.5;
      octx.beginPath(); octx.arc(sc.x, sc.y, 9, 0, Math.PI * 2); octx.fill(); octx.stroke();
    }
    return;
  }
  if (detectedQuad) {
    const fresh = performance.now() - lastDetectAt < 400;
    drawQuad(detectedQuad, fresh ? 'rgba(46,204,113,.95)' : 'rgba(241,196,15,.8)', 2.5);
    // small corner ticks so it reads as "this is the print I found"
    octx.fillStyle = fresh ? '#2ecc71' : '#f1c40f';
    for (const p of detectedQuad) { const s = videoToScreen(p, gr); octx.beginPath(); octx.arc(s.x, s.y, 4, 0, Math.PI * 2); octx.fill(); }
  }
}

// ---------------------------------------------------------------- manual corners
function enableManualEdit() {
  const gr = computeGuideRect();
  manualQuad = quadFromRect(gr);
  editCornersBtn.classList.remove('hidden');
  editCornersBtn.textContent = '✕';
  overlay.style.pointerEvents = 'auto';
  updateStatus();
}
function disableManualEdit() {
  manualQuad = null;
  editCornersBtn.textContent = '✢';
  overlay.style.pointerEvents = 'none';
  updateStatus();
}
editCornersBtn.addEventListener('click', () => { if (manualQuad) disableManualEdit(); else enableManualEdit(); });
overlay.style.pointerEvents = 'none';
overlay.style.touchAction = 'none';
function pointerPos(e) { const r = overlay.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
overlay.addEventListener('pointerdown', e => {
  if (!manualQuad || capturing) return;
  const pos = pointerPos(e), gr = computeGuideRect();
  let best = -1, bestD = 1e9;
  for (let i = 0; i < 4; i++) { const sc = videoToScreen(manualQuad[i], gr); const d = Math.hypot(sc.x - pos.x, sc.y - pos.y); if (d < bestD) { bestD = d; best = i; } }
  if (bestD < 36) { dragIdx = best; overlay.setPointerCapture(e.pointerId); e.preventDefault(); }
});
overlay.addEventListener('pointermove', e => {
  if (dragIdx < 0 || !manualQuad) return;
  manualQuad[dragIdx] = screenToVideo(pointerPos(e), computeGuideRect());
  e.preventDefault();
});
overlay.addEventListener('pointerup', () => { dragIdx = -1; });
overlay.addEventListener('pointercancel', () => { dragIdx = -1; });

// ---------------------------------------------------------------- scanning
captureBtn.addEventListener('click', () => {
  if (!stream) { startCamera(); return; }
  if (capturing) {
    if (frames.length >= 2) finishScan();
    else setStatus('Need at least 2 frames — keep moving over the print', 'warn', 1500);
    return;
  }
  if (fusing) return;
  startScan();
});

function startScan() {
  if (!resultPanel.classList.contains('hidden')) { resultPanel.classList.add('hidden'); currentResult = null; }
  frames = []; strip.innerHTML = ''; glareTrail = [];
  scanSession++;
  capturing = true; firstArea = 0; scanRotated = false; lastCap = 0;
  captureBtn.textContent = 'Finish scan';
  stopBtn.textContent = '✕ Cancel';
  progressBox.classList.remove('hidden');
  progressBar.style.width = '0%';
  progressText.textContent = `0 / ${MAX_FRAMES}`;
  setStatus('Scanning — hold the phone level and circle it slowly over the print, like stirring', 'ok');
  scanTimer = setTimeout(() => { if (capturing) finishScan(); }, SCAN_TIMEOUT_MS);
  if (!autoDetectChk.checked || manualQuad) {
    // no live detection: capture on a timer, rely on alignment refinement for drift
    const sess = scanSession;
    const timed = () => { if (!capturing || sess !== scanSession) return; if (!captureBusy) doCapture(null); setTimeout(timed, 450); };
    setTimeout(timed, 300);
  }
}

function cancelScan(silent) {
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  if (!capturing) return;
  capturing = false; scanSession++;
  frames = []; strip.innerHTML = '';
  progressBox.classList.add('hidden');
  captureBtn.textContent = '● Scan';
  stopBtn.textContent = 'Stop';
  if (!silent) setStatus('Scan cancelled — tap Scan to try again', 'warn', 3000);
}

function cancelFusion() {
  if (!fusing) return;
  scanSession++; // invalidate a finishScan still waiting on captureBusy
  vision.cancelAll();
  fusing = false;
  captureBtn.textContent = currentResult ? 'Scan again' : '● Scan';
  captureBtn.disabled = false;
  stopBtn.textContent = 'Stop';
  progressBox.classList.add('hidden');
  setStatus('Processing cancelled', 'warn', 3000);
}

// Gate auto-capture on a fresh live detection: sharp enough, not blown out, moved since the last frames.
function maybeAutoCapture(det) {
  if (!capturing || captureBusy) return;
  const now = performance.now();
  if (now - lastCap < 280) return;
  if (det.sharp < 0.5 * sharpRef) return;
  if (det.brightFrac > 0.3) return;
  const q = detectedQuad;
  if (frames.length) {
    if (det.rotated !== scanRotated) return;
    const area = V.quadArea(q);
    if (Math.abs(area / firstArea - 1) > 0.2) return;
    // require the print to have moved in the image (= viewpoint changed = reflections moved)
    const qw = quadWidth(q);
    const need = qw * Math.min(0.04, 0.012 + 0.003 * frames.length);
    let minDrift = 1e9;
    for (const f of frames) minDrift = Math.min(minDrift, V.quadDrift(q, f.videoQuad));
    if (minDrift < need) return;
  }
  doCapture(q);
}

// Grab a frame, detect the border on the frame itself (no timing skew), keep a crop around it.
async function doCapture(liveQuad) {
  if (!video.videoWidth || captureBusy) return;
  captureBusy = true;
  const sess = scanSession;
  lastCap = performance.now();
  try {
    let srcW = video.videoWidth, srcH = video.videoHeight, source = video;
    let bmp = null;
    if (imageCapture) {
      try { const blob = await imageCapture.takePhoto(); bmp = await createImageBitmap(blob); source = bmp; srcW = bmp.width; srcH = bmp.height; }
      catch { imageCapture = null; }
    }
    const scale = Math.min(1, MAX_CAPTURE_LONG_SIDE / Math.max(srcW, srcH));
    const cw = Math.round(srcW * scale), ch = Math.round(srcH * scale);
    const cap = document.createElement('canvas'); cap.width = cw; cap.height = ch;
    const cctx = cap.getContext('2d', { willReadFrequently: true });
    cctx.drawImage(source, 0, 0, cw, ch);
    if (bmp) bmp.close();
    if (sess !== scanSession) return;
    // detect on the captured frame at 640 wide
    const k = DETECT_WIDTH / cw, dh = Math.round(ch * k);
    const small = document.createElement('canvas'); small.width = DETECT_WIDTH; small.height = dh;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(cap, 0, 0, DETECT_WIDTH, dh);
    const simg = sctx.getImageData(0, 0, DETECT_WIDTH, dh);
    const luma = V.rgbaToLuma(simg.data, DETECT_WIDTH * dh); // before detect() transfers the buffer away
    // search near where the live detection (or manual quad) says the print is
    const vk = cw / video.videoWidth; // video px -> capture px
    const hintQuad = (liveQuad || manualQuad || quadFromRect(computeGuideRect())).map(p => ({ x: p.x * vk * k, y: p.y * vk * k }));
    const xs = hintQuad.map(p => p.x), ys = hintQuad.map(p => p.y);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const region = { x: bx0 - (bx1 - bx0) * 0.2, y: by0 - (by1 - by0) * 0.2, w: (bx1 - bx0) * 1.4, h: (by1 - by0) * 1.4 };
    let det = null;
    if (autoDetectChk.checked && !manualQuad) det = await vision.detect(simg.data, DETECT_WIDTH, dh, region, currentFormat().outerRatio, lastThresh, region, currentFormat().borderFrac);
    if (sess !== scanSession) return;
    let quad, sharp, approx = false;
    if (det) { quad = det.quad.map(p => ({ x: p.x / k, y: p.y / k })); sharp = det.sharp; }
    else if (manualQuad || !autoDetectChk.checked) { quad = (manualQuad || quadFromRect(computeGuideRect())).map(p => ({ x: p.x * vk, y: p.y * vk })); sharp = V.sharpnessInQuad(luma, DETECT_WIDTH, dh, hintQuad); approx = true; }
    else if (liveQuad && performance.now() - lastDetectAt < 200) { quad = liveQuad.map(p => ({ x: p.x * vk, y: p.y * vk })); sharp = detInfo ? detInfo.sharp : 0; approx = true; }
    else return; // print not found on this frame — skip it
    if (frames.length === 0) { firstArea = V.quadArea(quad.map(p => ({ x: p.x / vk, y: p.y / vk }))); scanRotated = !!(det && det.rotated); }
    else if (det && det.rotated !== scanRotated) return;
    // crop to the quad bbox (+6%) to keep memory down
    const qx = quad.map(p => p.x), qy = quad.map(p => p.y);
    const pad = 0.06 * Math.max(Math.max(...qx) - Math.min(...qx), Math.max(...qy) - Math.min(...qy));
    const x0 = Math.max(0, Math.floor(Math.min(...qx) - pad)), y0 = Math.max(0, Math.floor(Math.min(...qy) - pad));
    const x1 = Math.min(cw, Math.ceil(Math.max(...qx) + pad)), y1 = Math.min(ch, Math.ceil(Math.max(...qy) + pad));
    const img = cctx.getImageData(x0, y0, x1 - x0, y1 - y0);
    const frame = {
      data: img.data, w: img.width, h: img.height,
      quad: quad.map(p => ({ x: p.x - x0, y: p.y - y0 })),
      videoQuad: quad.map(p => ({ x: p.x / vk, y: p.y / vk })),
      sharp, approx, ts: Date.now(),
    };
    frames.push(frame);
    if (det && det.glare) glareTrail.push(det.glare);
    const dot = document.createElement('span');
    dot.className = 'frame-dot' + (approx ? ' approx' : '');
    dot.title = `sharp ${Math.round(sharp)}${approx ? ' (approx quad)' : ''}`;
    strip.appendChild(dot);
    if (navigator.vibrate) navigator.vibrate(10);
    updateStatus();
    if (debugEnabled()) {
      const blob = await canvasToBlob(cap, 'image/jpeg', 0.9);
      if (blob) saveLocally(blob, debugFilename(`cap${String(frames.length).padStart(2, '0')}`), {
        kind: 'capture', frame: frames.length, sharp: Math.round(sharp), approx, photo: !!bmp, format: currentFormat().label,
        quad: quad.map(p => [Math.round(p.x), Math.round(p.y)]), det: det ? { score: +det.score.toFixed(3), thresh: det.thresh, inliers: +det.inliers.toFixed(2), rotated: det.rotated } : null,
        ts: new Date().toISOString(),
      });
    }
    if (frames.length >= MAX_FRAMES) finishScan();
  } catch (e) { console.warn('capture failed', e); }
  finally { captureBusy = false; }
}

async function finishScan() {
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  if (!capturing || fusing) return;
  capturing = false;
  fusing = true; // claim the pipeline NOW: blocks re-entry and routes Stop to cancelFusion
  captureBtn.textContent = 'Processing…'; captureBtn.disabled = true;
  stopBtn.textContent = '✕ Cancel';
  const sess = scanSession;
  // wait for an in-flight capture to land
  for (let i = 0; i < 40 && captureBusy; i++) await new Promise(r => setTimeout(r, 50));
  if (sess !== scanSession) return; // cancelled or camera stopped while waiting
  if (frames.length < 2) {
    fusing = false;
    progressBox.classList.add('hidden');
    captureBtn.textContent = '● Scan'; captureBtn.disabled = false; stopBtn.textContent = 'Stop';
    setStatus(frames.length === 0 ? 'No usable frames — keep the border in view and move slowly' : 'Only 1 frame — move the phone around more while scanning', 'warn', 4000);
    frames = []; strip.innerHTML = '';
    return;
  }
  const fmt = currentFormat();
  const longSide = hiResChk.checked ? 2200 : 1400;
  let outW, outH;
  if (fmt.outerRatio >= 1) { outW = longSide; outH = Math.round(longSide / fmt.outerRatio); }
  else { outH = longSide; outW = Math.round(longSide * fmt.outerRatio); }
  if (scanRotated) [outW, outH] = [outH, outW];
  const opts = {
    outW, outH, glarePct: +glareRange.value, borders: fmt.borderFrac,
    sharpen: 0.35, landscape: scanRotated,
  };
  const N = frames.length;
  const toFuse = frames; frames = [];
  const t0 = performance.now();
  try {
    const res = await vision.fuse(toFuse, opts, (stage, f) => {
      setStatus(stage === 'align' ? `Aligning ${N} frames…` : `Removing glare… ${Math.round(f * 100)}%`, 'ok');
      progressBar.style.width = `${Math.round((stage === 'align' ? 0.2 * (f || 0.5) : 0.2 + 0.8 * f) * 100)}%`;
      progressText.textContent = stage === 'align' ? 'aligning' : 'fusing';
    });
    res.N = N; res.ms = Math.round(performance.now() - t0);
    showResult(res);
  } catch (e) {
    console.error(e);
    if (String(e.message).includes('cancelled')) return;
    setStatus('Processing failed: ' + e.message, 'bad', 6000);
  } finally {
    fusing = false;
    captureBtn.disabled = false;
    progressBox.classList.add('hidden');
    stopBtn.textContent = 'Stop';
    if (!currentResult) captureBtn.textContent = '● Scan';
  }
}

// ---------------------------------------------------------------- result
let frameMode = 'frame'; // 'frame' = whole print incl. border, 'image' = image area only
try { const fm = localStorage.getItem('polascan-frameMode'); if (fm === 'image' || fm === 'frame') frameMode = fm; } catch { }
function syncFrameSeg() {
  document.querySelectorAll('#frameSeg button').forEach(b => b.classList.toggle('seg-active', b.dataset.v === frameMode));
}
document.querySelectorAll('#frameSeg button').forEach(b => b.addEventListener('click', () => {
  frameMode = b.dataset.v;
  try { localStorage.setItem('polascan-frameMode', frameMode); } catch { }
  syncFrameSeg(); redrawResult();
}));
syncFrameSeg();

function showResult(res) {
  const full = document.createElement('canvas'); full.width = res.w; full.height = res.h;
  full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(res.data), res.w, res.h), 0, 0);
  currentResult = { canvas: full, w: res.w, h: res.h, crop: res.crop, N: res.N, used: res.used, dropped: res.dropped, diag: res.diag, timing: res.timing, ms: res.ms };
  resultPanel.classList.remove('hidden');
  redrawResult();
  resultPanel.scrollIntoView({ behavior: 'smooth' });
  const used = res.used ? res.used.length : res.N;
  const dropped = res.dropped && res.dropped.length ? ` (${res.dropped.length} dropped: ${res.dropped.map(d => d.why).join(', ')})` : '';
  setStatus(`Done — ${used} of ${res.N} frames fused${dropped}. Scan again or save below.`, 'ok', 6000);
  captureBtn.textContent = 'Scan again';
  $('#metaText').textContent = `${currentFormat().label} · ${res.w}×${res.h} · ${used}/${res.N} frames · glare ${glareRange.value}% · ${hiResChk.checked ? 'hi-res' : 'standard'}${res.ms ? ` · ${(res.ms / 1000).toFixed(1)}s` : ''}`;
  const diag = (res.diag || []).map((d, i) => `f${res.used ? res.used[i] : i}: shift ${d.shift.toFixed(1)}px conf ${d.conf.toFixed(2)}`).join(' · ');
  $('#diagText').textContent = debugEnabled() ? `${diag}${res.timing ? ` · align ${Math.round(res.timing.align)}ms fuse ${Math.round(res.timing.fuse)}ms` : ''}` : '';
  if (debugEnabled()) {
    canvasToBlob(full, 'image/jpeg', 0.93).then(blob => blob && saveLocally(blob, debugFilename('fused'), {
      kind: 'fused', w: res.w, h: res.h, N: res.N, used: res.used, dropped: res.dropped, diag: res.diag, timing: res.timing, crop: res.crop,
      format: currentFormat().label, glareDiscard: glareRange.value, ms: res.ms,
    }));
  }
}

function redrawResult() {
  if (!currentResult) return;
  const crop = +$('#cropRange').value, exp = +$('#expRange').value, warm = +$('#warmRange').value;
  const src = currentResult.canvas;
  // source rect: whole print (frame included) or just the located image area
  let sx = 0, sy = 0, sw = src.width, sh = src.height;
  if (frameMode === 'image' && currentResult.crop) ({ x: sx, y: sy, w: sw, h: sh } = currentResult.crop);
  const inset = Math.round(Math.min(sw, sh) * (crop / 400));
  const cw = sw - inset * 2, ch = sh - inset * 2;
  resultCanvas.width = cw; resultCanvas.height = ch;
  resultCanvas.style.aspectRatio = cw + '/' + ch;
  rctx.clearRect(0, 0, cw, ch);
  rctx.drawImage(src, sx + inset, sy + inset, cw, ch, 0, 0, cw, ch);
  if (exp !== 0 || warm !== 0) {
    const img = rctx.getImageData(0, 0, cw, ch), d = img.data;
    const f = Math.pow(2, exp / 42);
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i] * f, g = d[i + 1] * f, b = d[i + 2] * f;
      if (warm !== 0) { r += warm * 1.8; b -= warm * 1.4; }
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
    rctx.putImageData(img, 0, 0);
  }
}
$('#cropRange').addEventListener('input', redrawResult);
$('#expRange').addEventListener('input', redrawResult);
$('#warmRange').addEventListener('input', redrawResult);

// glare slider: live label; on release re-fuse the last scan (alignment is reused, so it's quick)
glareRange.addEventListener('input', () => { glareVal.textContent = glareRange.value + '%'; });
let refuseTimer = null;
glareRange.addEventListener('change', () => {
  try { localStorage.setItem('polascan-glare', glareRange.value); } catch { }
  if (!currentResult || fusing || refusing) return;
  clearTimeout(refuseTimer);
  refuseTimer = setTimeout(async () => {
    if (!currentResult || fusing || refusing) return;
    refusing = true;
    const N = currentResult.N, t0 = performance.now();
    try {
      const res = await vision.refuse({ glarePct: +glareRange.value, sharpen: 0.35 }, (stage, f) => setStatus(`Re-fusing at ${glareRange.value}%… ${Math.round(f * 100)}%`, 'ok'));
      res.N = N; res.ms = Math.round(performance.now() - t0);
      showResult(res);
    } catch (e) {
      const lost = /nothing to re-fuse|cancelled|worker unavailable/.test(String(e.message));
      setStatus(lost ? 'Re-processing unavailable — scan again to change glare rejection' : 'Re-fuse failed: ' + e.message, 'warn', 4000);
    }
    finally { refusing = false; }
  }, 150);
});

// ---------------------------------------------------------------- save / share
$('#downloadBtn').onclick = async () => {
  if (!currentResult) return;
  redrawResult();
  const blob = await canvasToBlob(resultCanvas, 'image/jpeg', 0.93);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `polascan-${new Date().toISOString().slice(0, 10)}-${currentFormat().label.replace(/[^a-z0-9]+/gi, '_')}.jpg`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
};
$('#saveBtn').onclick = async () => {
  if (!currentResult) return;
  redrawResult();
  const blob = await canvasToBlob(resultCanvas, 'image/jpeg', 0.93);
  const file = new File([blob], `polascan-${Date.now()}.jpg`, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Polaroid scan' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
};
$('#copyBtn').onclick = async () => {
  if (!currentResult) return;
  redrawResult();
  try {
    const blob = await canvasToBlob(resultCanvas, 'image/png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    $('#copyBtn').textContent = 'Copied ✓';
    setTimeout(() => $('#copyBtn').textContent = 'Copy', 1500);
  } catch { alert('Copy not supported in this browser — use Save or Download instead.'); }
};
$('#retakeBtn').onclick = () => {
  resultPanel.classList.add('hidden');
  currentResult = null; frames = []; strip.innerHTML = '';
  vision.reset();
  captureBtn.textContent = '● Scan';
  setStatus('Ready — fit the border in the frame and tap Scan', 'ok');
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

// space bar = manual capture (desktop testing)
window.addEventListener('keydown', e => { if (e.code === 'Space' && stream && capturing) { e.preventDefault(); doCapture(detectedQuad); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAnimationFrame(raf); else if (stream) startLoop(); });

// ---------------------------------------------------------------- local server integration
// config.json is optional and machine-local (gitignored; see config.example.json). It exists
// when the bundled server.py is running; a plain static deploy simply won't have one.
(async () => {
  try {
    const res = await fetch('config.json', { cache: 'no-store' });
    if (res.ok) {
      const cfg = await res.json();
      if (cfg && cfg.publicUrl) {
        const el = document.getElementById('publicUrl');
        if (el) { el.textContent = cfg.publicUrl; document.getElementById('publicUrlLine')?.classList.remove('hidden'); }
      }
    }
  } catch { }
  try {
    const r = await fetch('debug/list', { cache: 'no-store' });
    if (r.ok) document.getElementById('debugLink')?.classList.remove('hidden');
  } catch { }
})();

// ---------------------------------------------------------------- PWA
if ('serviceWorker' in navigator) { navigator.serviceWorker.register('./sw.js').catch(() => { }); }
