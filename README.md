# Polaroid Scan — glare-free instant-photo scanner

Scan Polaroids and Instax prints with a phone camera, **without the glare**. Point the phone at the print, tap Scan, and slowly circle the phone over it for a few seconds — reflections drift across the glossy surface while the print stays put, and the app fuses the clean parts of every viewpoint into one flat, glare-free scan.

Everything runs on-device in the browser (Canvas + a Web Worker). No dependencies, no build step, no uploads.

## Quick start

```bash
git clone https://github.com/ianbarber/polaroid-scan
cd polaroid-scan
python3 server.py          # http://127.0.0.1:8000
```

Phones require **HTTPS** for camera access (localhost is exempt). Any HTTPS front works, e.g. on a tailnet:

```bash
tailscale serve https / --bg --set-path / --proxy 8000
```

Optional: `cp config.example.json config.json` and set `publicUrl` (shown in the in-app help), `host`/`port`, or `cors`. `config.json` is machine-local and gitignored.

To run the server permanently, `deploy/polaroid-scan.service` is a systemd user unit — install instructions are in the file.

The app itself is static files: it also works on any static host (GitHub Pages, Caddy, nginx). The server only adds the debug-capture workflow.

## Using it

1. Lay the print flat on a plain surface that **contrasts with its border** (dark table for white borders, light table for black frames) in soft, diffuse light. White, black, and patterned borders all work.
2. **Start camera** and fit the print in the frame; a **green outline** appears when the border is locked.
3. Tap **Scan**, hold the phone level, and slowly circle it over the print like stirring a pot. The app auto-captures ~12 frames and asks for a little tilt only if it sees the reflection isn't moving. Finishes on its own; **Finish scan** stops early, **✕ Cancel** discards.
4. The result appears below: **With frame** (default) or **Image only** — an instant toggle. Save to Photos (share sheet on iOS), Download, or Copy. Edge trim / exposure / warmth are display-only; the **glare rejection** slider re-processes the same scan.
5. If no border is found after a few seconds, tap **✢** and drag the four corners manually — alignment refinement still corrects hand wobble.

## How it works

1. **Border detection** (`vision.js → detectBorder`, ~10 Hz in a worker). Three passes: a **bright-ring** pass (white borders: threshold candidates → flood fill → the component shaped like a ring of the right aspect), a mirrored **dark-ring** pass (black frames), and an **edge fallback** for patterned borders (per-side line search over colour gradients, keeping the outermost strong line). The winner's four edges are refined to sub-pixel with robust line fits, validated by band contrast, geometry, aspect (either orientation), and an interior-edge test that rejects locks onto the image area. ~0.1–0.4 px corner accuracy at 640 px on the synthetic suite.
2. **Capture** (`app.js`). Frames auto-fire when the border is sharp, unsaturated, and has moved against every previous frame (viewpoint change = reflections moved). The border is re-detected on each captured frame itself, so there's no timing skew. The glare blob's centroid is tracked in print coordinates to drive the "tilt a little" hint.
3. **Alignment** (`refineAlignment`). Frames are warped to the canonical print rectangle, then refined against a glare-free per-pixel **median** of all frames using multi-scale NCC on gradient images over a 3×3 patch grid (saturated pixels masked). Patch displacements re-solve each homography by weighted least squares; frames that can't be aligned confidently are dropped.
4. **Fusion** (`fuseAligned`). Per-frame exposure gains are matched (median of ratios). Per pixel, samples sort by luminance and a low percentile is the reference — glare is always brighter, so it's excluded, while clean pixels still average all frames for noise reduction. The **glare rejection** slider sets the percentile.
5. **Finish**. The output keeps the full print; the image area is located inside it (per-format border fractions + edge search) for the instant crop toggle. Sideways prints are rotated so the thick border lands at the bottom.

## Files

- `index.html` / `style.css` — UI
- `app.js` — camera, live loop, capture gating, result panel, share/save
- `vision.js` — all image math (pure functions: worker, main thread, or node)
- `worker.js` — runs detection and fusion off the main thread
- `sw.js` + `manifest.json` — PWA, offline-capable, network-first
- `server.py` — optional local server: static files + debug capture gallery (`/debug/`)
- `deploy/` — systemd user unit
- `tests/` — node test harness (no framework)

## Film formats

Polaroid 600 / i-Type / SX-70, Polaroid Go, Instax Mini / Square / Wide — selectable in the top bar; border geometries are in `FORMATS` in `app.js`. The final crop self-corrects small errors in those numbers by finding the actual border→image edge.

## Tests

No test framework — plain node scripts (node ≥ 18).

```bash
# synthetic end-to-end of the vision pipeline: renders a textured print under random
# tilts with moving glare; reports detection error and fused PSNR vs ground truth
node tests/synthetic.mjs /tmp/out wood 9 white     # table: wood|beige · border: white|black|pattern

# detector against a real capture (needs pillow+numpy for jpg → raw)
python3 tests/jpg2raw.py debug/cap01-*.jpg /tmp/cap.raw
node tests/detect_real.mjs /tmp/cap.raw 1280 960 /tmp/cap.det.png

# drive the real app headlessly with a fake camera (needs ffmpeg + playwright: npm i playwright)
node tests/gen_video.mjs 1280 960 60 wood white | ffmpeg -f rawvideo -pix_fmt rgba -s 1280x960 -r 10 -i - -pix_fmt yuv420p /tmp/synth.y4m
node tests/e2e.cjs /tmp/synth.y4m /tmp/e2e_out http://localhost:8000/
```

`tests/gen_video.mjs` also takes a `fixed` glare mode (7th arg) to exercise the stuck-reflection hint.

## Privacy

All processing happens on-device. The only network writes are the optional debug captures to your own `server.py` when the debug toggle is on.

## License

MIT — see [LICENSE](LICENSE).
