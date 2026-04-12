from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from app.services import downloader as downloader_service

router = APIRouter()


class DownloadRequest(BaseModel):
    url: str
    platform: Literal[
        "youtube",
        "tiktok",
        "instagram",
        "twitter",
        "facebook",
        "linkedin",
        "bluesky",
    ]
    format: Literal["best", "audio", "720p", "1080p", "4k"] = "best"


@router.post("/download")
async def download(body: DownloadRequest):
    return await downloader_service.extract_info(
        url=body.url, platform=body.platform, format=body.format
    )
