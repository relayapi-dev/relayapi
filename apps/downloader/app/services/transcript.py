import asyncio
from typing import Any

from youtube_transcript_api import (
    NoTranscriptFound,
    TranscriptsDisabled,
    VideoUnavailable,
    YouTubeTranscriptApi,
)


def _sync_fetch(video_id: str, lang: str | None) -> dict[str, Any]:
    ytt_api = YouTubeTranscriptApi()
    kwargs: dict[str, Any] = {}
    if lang:
        kwargs["languages"] = [lang]
    transcript = ytt_api.fetch(video_id, **kwargs)

    segments = [
        {"text": entry.text, "start": entry.start, "duration": entry.duration}
        for entry in transcript
    ]

    return {
        "success": True,
        "video_id": video_id,
        "language": transcript.language,
        "is_auto_generated": transcript.is_generated,
        "segments": segments,
        "full_text": " ".join(s["text"] for s in segments),
    }


async def get_transcript(
    video_id: str, lang: str | None = None
) -> dict[str, Any]:
    try:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _sync_fetch, video_id, lang)
    except TranscriptsDisabled:
        return {
            "success": False,
            "error": "Transcripts are disabled for this video",
            "error_code": "TRANSCRIPTS_DISABLED",
        }
    except NoTranscriptFound:
        return {
            "success": False,
            "error": "No transcript found for the requested language",
            "error_code": "NO_TRANSCRIPT_FOUND",
        }
    except VideoUnavailable:
        return {
            "success": False,
            "error": "Video is unavailable",
            "error_code": "VIDEO_UNAVAILABLE",
        }
