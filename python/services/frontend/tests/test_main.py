from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from econ_frontend import main


class _HealthResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, str]:
        return {"status": "ok"}


class _HealthClient:
    async def __aenter__(self) -> "_HealthClient":
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    async def get(self, path: str) -> _HealthResponse:
        assert path == "/health"
        return _HealthResponse()


def test_index_uses_starlette_one_template_response_signature(monkeypatch) -> None:
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _HealthClient())

    response = TestClient(main.app).get("/")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "Status: ok" in response.text


def test_strict_content_type_accepts_application_json_and_rejects_plain_text() -> None:
    app = FastAPI()

    @app.post("/echo")
    async def echo(payload: dict[str, str]) -> dict[str, str]:
        return payload

    client = TestClient(app)
    accepted = client.post(
        "/echo", content='{"status":"ok"}', headers={"content-type": "application/json"}
    )
    rejected = client.post(
        "/echo", content='{"status":"ok"}', headers={"content-type": "text/plain"}
    )

    assert accepted.status_code == 200
    assert accepted.json() == {"status": "ok"}
    assert rejected.status_code == 422
