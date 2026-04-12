from fastapi import APIRouter
from pydantic import BaseModel

from app.services import transcript as transcript_service

router = APIRouter()


class TranscriptRequest(BaseModel):
    video_id: str
    lang: str | None = None


@router.post("/transcript")
async def transcript(body: TranscriptRequest):
    return await transcript_service.get_transcript(
        video_id=body.video_id, lang=body.lang
    )
