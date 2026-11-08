"""Suit Up backend.

- Serves the frontend (static) at /
- POST /api/clips    save a recorded clip, returns a shareable link
- GET  /c/{id}       public share page for a clip
All motion capture + costume rendering runs in the browser; nothing about the camera feed reaches the server
unless the user records and saves a clip.
"""
import asyncio
import logging
import os
import re
import urllib.request
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
CLIPS = ROOT / "storage" / "clips"
FRONTEND = ROOT.parent / "frontend"
CLIPS.mkdir(parents=True, exist_ok=True)

MAX_CLIP_BYTES = 100 * 1024 * 1024
CLIP_EXT = {"video/webm": "webm", "video/mp4": "mp4", "video/quicktime": "mov"}
ID_RE = re.compile(r"^[0-9a-f]{32}$")
FILE_RE = re.compile(r"^[0-9a-f]{32}\.(webm|mp4|mov)$")

# where the frontend lives when deployed separately (Vercel); used for the "suit up yourself" link
FRONTEND_URL = os.environ.get("FRONTEND_URL", "/")

# ---------- keep-alive cron ----------
# Render's free plan sleeps a service after 15 min with no incoming requests. Every 10 min we call our own
# public URL; it goes through Render's proxy, so it counts as traffic and the service stays awake.
# RENDER_EXTERNAL_URL is set by Render automatically, so this only runs there (never locally).
PUBLIC_URL = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")
PING_EVERY = int(os.environ.get("KEEPALIVE_SECONDS", "600"))
log = logging.getLogger("uvicorn.error")


def _ping() -> int:
    with urllib.request.urlopen(f"{PUBLIC_URL}/api/health", timeout=30) as r:
        return r.status


async def _keepalive():
    while True:
        await asyncio.sleep(PING_EVERY)
        try:
            log.info("keep-alive ping -> %s", await asyncio.to_thread(_ping))
        except Exception as e:  # never let a failed ping kill the loop
            log.warning("keep-alive ping failed: %s", e)


@asynccontextmanager
async def lifespan(_app):
    task = asyncio.create_task(_keepalive()) if PUBLIC_URL else None
    yield
    if task:
        task.cancel()


app = FastAPI(title="Suit Up", lifespan=lifespan)
# the Vercel frontend calls this API cross-origin
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=os.environ.get("ALLOWED_ORIGIN_REGEX", r"https://.*\.vercel\.app|http://(localhost|127\.0\.0\.1)(:\d+)?"),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/clips")
async def upload_clip(file: UploadFile = File(...)):
    ext = CLIP_EXT.get((file.content_type or "").split(";")[0].strip().lower())
    if not ext:
        raise HTTPException(415, "Unsupported video type")
    data = await file.read(MAX_CLIP_BYTES + 1)
    if len(data) > MAX_CLIP_BYTES:
        raise HTTPException(413, "Clip too large (max 100 MB)")
    id_ = uuid.uuid4().hex
    (CLIPS / f"{id_}.{ext}").write_bytes(data)
    return {"id": id_, "url": f"/media/clips/{id_}.{ext}", "share_url": f"/c/{id_}"}


def _clip_path(id_: str) -> Path:
    if ID_RE.match(id_):
        for ext in CLIP_EXT.values():
            p = CLIPS / f"{id_}.{ext}"
            if p.exists():
                return p
    raise HTTPException(404, "Clip not found")


@app.get("/c/{id_}", response_class=HTMLResponse)
def share_page(id_: str):
    p = _clip_path(id_)
    return f"""<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Suit Up clip</title>
<body style="margin:0;background:#0b0b12;display:grid;place-items:center;min-height:100vh;font-family:sans-serif;color:#fff">
<div style="max-width:480px;width:100%;padding:16px">
<video src="/media/clips/{p.name}" controls autoplay loop playsinline style="width:100%;border-radius:14px"></video>
<p><a style="color:#ff3d8b" href="{FRONTEND_URL}">Suit up yourself →</a></p></div>"""


@app.get("/media/clips/{name}")
def get_clip(name: str):
    p = CLIPS / name
    if not FILE_RE.match(name) or not p.exists():
        raise HTTPException(404)
    return FileResponse(p)  # supports Range requests, so the video can seek


# local dev: serve the frontend too (on Render the frontend is on Vercel instead)
if FRONTEND.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
