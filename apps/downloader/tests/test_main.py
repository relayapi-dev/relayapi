from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)
AUTH_HEADERS = {"X-Internal-Key": "test-internal-key"}


def test_health_is_public() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert isinstance(body["yt_dlp_version"], str)


def test_protected_route_requires_internal_key() -> None:
    response = client.post(
        "/download",
        json={"url": "https://example.com/video", "platform": "youtube"},
    )

    assert response.status_code == 401
    assert response.json() == {
        "error": "Unauthorized",
        "error_code": "UNAUTHORIZED",
    }


def test_invalid_download_request_returns_validation_error() -> None:
    response = client.post(
        "/download",
        headers=AUTH_HEADERS,
        json={"url": "https://example.com/video", "platform": "unsupported"},
    )

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "platform"]
