#!/usr/bin/env python3
"""Local dev/debug server for Polaroid Scan.

Serves the app statically and accepts POST /save to write scan JPEGs plus metadata
into debug/ for inspection (gallery at /debug/). Entirely optional — the app is
static files and runs on any HTTPS host; this server just adds the debug workflow.

Config: copy config.example.json to config.json (gitignored) and edit. CLI port
overrides the config. By default binds 127.0.0.1 — put HTTPS in front for phones
(e.g. `tailscale serve https / --bg --set-path / --proxy 8000`).

Run:  python3 server.py [port]
"""
import json
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).parent.resolve()
DEBUG_DIR = HERE / "debug"
DEBUG_DIR.mkdir(exist_ok=True)
MAX_UPLOAD = 64 * 1024 * 1024
_save_lock = threading.Lock()

CONFIG = {"port": 8000, "host": "127.0.0.1", "publicUrl": "", "cors": False}
try:
    CONFIG.update(json.loads((HERE / "config.json").read_text()))
except FileNotFoundError:
    pass
except Exception as e:
    print(f"config.json ignored ({e})", file=sys.stderr)


def sanitize_name(name: str) -> str:
    name = Path(name).name
    name = "".join(c if c.isalnum() or c in "._- " else "_" for c in name).strip().replace(" ", "_")
    return name or f"scan-{int(time.time() * 1000)}.jpg"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(HERE), **kw)

    def _cors(self):
        if CONFIG.get("cors"):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "X-Filename, X-Meta, Content-Type")

    def end_headers(self):
        self._cors()
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        if CONFIG.get("cors"):
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_POST(self):
        if urlparse(self.path).path != "/save":
            self.send_error(404, "not found")
            return
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            self.send_error(400, "bad content-length")
            return
        if length <= 0 or length > MAX_UPLOAD:
            self.send_error(413 if length > MAX_UPLOAD else 400, "bad size")
            return
        body = self.rfile.read(length)
        filename = self.headers.get("X-Filename", "")
        meta_raw = self.headers.get("X-Meta", "")
        if "multipart/form-data" in self.headers.get("content-type", ""):
            # minimal single-file multipart extraction
            try:
                import re
                m = re.search(b'filename="([^"]+)"', body)
                if m:
                    filename = m.group(1).decode(errors="replace")
                parts = body.split(b"\r\n\r\n", 1)
                if len(parts) == 2:
                    body = parts[1].rsplit(b"\r\n--", 1)[0]
            except Exception as e:
                print(f"multipart parse error {e}", file=sys.stderr)
        filename = sanitize_name(filename)
        base, dot, ext = filename.rpartition(".")
        with _save_lock:
            out = DEBUG_DIR / filename
            i = 1
            while out.exists():
                out = DEBUG_DIR / (f"{base}_{i}.{ext}" if dot else f"{filename}_{i}")
                i += 1
            out.write_bytes(body)
        if meta_raw:
            try:
                meta = json.loads(meta_raw)
            except Exception:
                meta = {"raw": meta_raw}
            out.with_suffix(out.suffix + ".json").write_text(
                json.dumps({**meta, "filename": out.name, "saved": time.time()}, indent=2))
        print(f"[save] {out.name} ({len(body)} bytes)")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "file": out.name, "url": f"/debug/{out.name}"}).encode())

    def do_GET(self):
        p = urlparse(self.path)
        if p.path == "/debug/list":
            out = []
            for f in sorted(DEBUG_DIR.glob("*.*"), key=lambda x: x.name, reverse=True):
                if f.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp"):
                    continue
                try:
                    st = f.stat()
                    meta = {}
                    j = f.with_suffix(f.suffix + ".json")
                    if j.exists():
                        try:
                            meta = json.loads(j.read_text())
                        except Exception:
                            pass
                    out.append({"file": f.name, "url": f"/debug/{f.name}", "meta": meta,
                                "mtime": st.st_mtime, "size": st.st_size})
                except OSError:
                    continue
            out.sort(key=lambda x: x["mtime"], reverse=True)
            payload = json.dumps(out[:100]).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)
            return
        if p.path in ("/debug", "/debug/"):
            # gallery: all dynamic content is inserted via textContent, never innerHTML
            page = """<!doctype html><meta charset=utf-8><title>Debug saves</title>
<style>body{font-family:system-ui;background:#0a0a0b;color:#eee;margin:0;padding:16px}h1{font-size:16px}a{color:#0a84ff}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.card{border:1px solid #26282c;background:#141518;border-radius:12px;overflow:hidden}
.card img{width:100%;display:block}
.card pre{padding:8px;font:12px/1.4 ui-monospace,monospace;color:#a8adb6;white-space:pre-wrap;word-break:break-word;margin:0}</style>
<h1>Polaroid Scan — debug saves <a href="/debug/list">JSON</a></h1>
<div id="grid"></div>
<script>
fetch('/debug/list').then(r=>r.json()).then(arr=>{
  const g=document.getElementById('grid');
  if(!arr.length){ const p=document.createElement('p'); p.textContent='No saves yet — enable the debug toggle in the app and scan.'; g.appendChild(p); return; }
  for(const it of arr){
    const card=document.createElement('div'); card.className='card';
    const a=document.createElement('a'); a.href=it.url; a.target='_blank';
    const img=document.createElement('img'); img.src=it.url; img.loading='lazy';
    a.appendChild(img); card.appendChild(a);
    const pre=document.createElement('pre');
    pre.textContent=`${it.file} · ${(it.size/1024).toFixed(1)}KB\\n${new Date(it.mtime*1000).toLocaleString()}\\n${JSON.stringify(it.meta,null,2).slice(0,400)}`;
    card.appendChild(pre);
    g.appendChild(card);
  }
});
</script>"""
            body = page.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(CONFIG["port"])
    host = str(CONFIG.get("host") or "127.0.0.1")
    ThreadingHTTPServer.allow_reuse_address = True
    with ThreadingHTTPServer((host, port), Handler) as httpd:
        print(f"Polaroid Scan server on {host}:{port}  dir={HERE}")
        print(f"  http://127.0.0.1:{port}/         (app)")
        print(f"  http://127.0.0.1:{port}/debug/   (debug gallery)")
        if CONFIG.get("publicUrl"):
            print(f"  {CONFIG['publicUrl']}  (public URL from config.json)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
