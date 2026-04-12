import asyncio
from typing import Any

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

from app.config import settings

FORMAT_MAP = {
    "best": "best[ext=mp4]/best",
    "audio": "bestaudio[ext=m4a]/bestaudio",
    "720p": "best[height<=720][ext=mp4]/best[height<=720]",
    "1080p": "best[height<=1080][ext=mp4]/best[height<=1080]",
    "4k": "best[height<=2160][ext=mp4]/best[height<=2160]",
}

ALLOWED_EXTENSIONS = {"mp4", "webm", "m4a", "mp3", "ogg"}


def _sync_extract(url: str, ydl_opts: dict[str, Any]) -> dict[str, Any]:
    with YoutubeDL(ydl_opts) as ydl:
        return ydl.extract_info(url, download=False)


def _build_formats(info: dict[str, Any]) -> list[dict[str, Any]]:
    formats = []
    for f in info.get("formats") or []:
        if not f.get("url") or f.get("ext") not in ALLOWED_EXTENSIONS:
            continue
        formats.append(
            {
                "format_id": f.get("format_id"),
                "ext": f.get("ext"),
                "resolution": f"{f.get('width', '?')}x{f.get('height', '?')}",
                "filesize": f.get("filesize") or f.get("filesize_approx"),
                "url": f.get("url"),
            }
        )
    return formats


def _pick_download_url(info: dict[str, Any]) -> str | None:
    if info.get("url"):
        return info["url"]
    raw_formats = info.get("formats") or []
    if raw_formats:
        return raw_formats[-1].get("url")
    return None


async def extract_info(
    url: str, platform: str, format: str = "best"
) -> dict[str, Any]:
    ydl_opts: dict[str, Any] = {
        "extract_flat": False,
        "no_warnings": True,
        "quiet": True,
        "format": FORMAT_MAP.get(format, FORMAT_MAP["best"]),
    }

    if settings.PROXY_URL:
        ydl_opts["proxy"] = settings.PROXY_URL

    try:
        loop = asyncio.get_event_loop()
        info = await loop.run_in_executor(None, _sync_extract, url, ydl_opts)
    except DownloadError as exc:
        return {
            "success": False,
            "error": str(exc),
            "error_code": "CONTENT_UNAVAILABLE",
        }

    return {
        "success": True,
        "title": info.get("title"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "author": info.get("uploader") or info.get("channel"),
        "formats": _build_formats(info),
        "download_url": _pick_download_url(info),
    }
