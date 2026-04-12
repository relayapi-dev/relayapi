from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from yt_dlp.version import __version__ as ytdlp_version

from app.config import settings
from app.routes.download import router as download_router
from app.routes.transcript import router as transcript_router

app = FastAPI(title="RelayAPI Downloader", docs_url=None, redoc_url=None)

PUBLIC_PATHS = {"/health"}


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path in PUBLIC_PATHS:
        return await call_next(request)

    api_key = request.headers.get("X-Internal-Key")
    if not api_key or api_key != settings.INTERNAL_API_KEY:
        return JSONResponse(
            status_code=401,
            content={"error": "Unauthorized", "error_code": "UNAUTHORIZED"},
        )

    return await call_next(request)


@app.get("/health")
async def health():
    return {"status": "ok", "yt_dlp_version": ytdlp_version}


app.include_router(download_router)
app.include_router(transcript_router)
