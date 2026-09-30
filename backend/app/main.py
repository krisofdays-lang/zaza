"""FastAPI service exposing the Instagram request layer to the Next.js app.

The Next.js server calls these endpoints instead of running the TypeScript
Instagram client in-process. All Instagram traffic still egresses through the Go
uTLS sidecar (TLS_PROXY_URL) so the JA4/HTTP2 fingerprint stays iPhone-shaped.

Routes are defined WITHOUT the /api prefix: the Docker entrypoint launches
uvicorn on loopback and the Next.js server proxies /api/ig/* to it.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from .client import InstagramClient
from .config import TLS_PROXY_REQUIRED, TLS_PROXY_URL
from .models import ReelPublishRequest, ReelPublishResponse
from .reel import publish_reel_flow
from .autoreg.api import router as autoreg_router

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ig.api")

app = FastAPI(title="Instagram Request Service", version="1.0.0")
app.include_router(autoreg_router)


@app.get("/health")
def health() -> dict[str, object]:
    """Liveness + TLS-proxy posture. `tls_proxy_ok` is false when we'd be forced
    to egress with Python's real fingerprint (the primary ban signal)."""
    return {
        "status": "ok",
        "tls_proxy_configured": bool(TLS_PROXY_URL),
        "tls_proxy_required": TLS_PROXY_REQUIRED,
    }


def _decode_video(req: ReelPublishRequest) -> bytes:
    import base64

    try:
        return base64.b64decode(req.video_base64, validate=True)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"invalid video_base64: {err}") from err


@app.post("/reel/publish", response_model=ReelPublishResponse)
def reel_publish(req: ReelPublishRequest) -> ReelPublishResponse:
    """Publish one reel for one account. Mirrors publishReelFlow() end-to-end:
    warmup -> upload_settings -> rupload_igvideo -> cover -> configure_to_clips
    (with 202 retry) -> post-publish. Never raises for expected failures; returns
    ok:false + detail so the caller can log the real reason."""
    video = _decode_video(req)

    with InstagramClient(req.account) as client:
        result = publish_reel_flow(
            client,
            video,
            caption=req.caption or "",
            fallback_width=req.fallback_width,
            fallback_height=req.fallback_height,
            delays=(False if req.delays is False else (req.delays or None)),
        )
        # Surface any claim/rur the server rotated so Next.js can persist it.
        result["claim"] = client.claim
        result["rur"] = client.rur
    return ReelPublishResponse(**result)


@app.exception_handler(Exception)
def _unhandled(_req, exc: Exception) -> JSONResponse:  # noqa: ANN001
    log.exception("unhandled error")
    return JSONResponse(status_code=500, content={"ok": False, "detail": str(exc)})
