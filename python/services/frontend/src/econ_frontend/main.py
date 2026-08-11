"""Frontend shim that surfaces API health."""

import logging
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from .config import get_settings

settings = get_settings()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("econ_frontend")

templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))
app = FastAPI(title="Econ Frontend (Python)", version="0.1.0")


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    health: dict[str, str] = {"status": "unknown"}
    try:
        async with httpx.AsyncClient(base_url=settings.api_base_url, timeout=5) as client:
            response = await client.get("/health")
            response.raise_for_status()
            health = response.json()
    except httpx.HTTPError as exc:  # pragma: no cover - network error
        logger.warning("Health fetch failed: %s", exc)
        health = {"status": "down"}

    return templates.TemplateResponse(
        "index.html",
        {"request": request, "health": health, "api_base_url": settings.api_base_url},
    )


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("econ_frontend.main:app", host="0.0.0.0", port=settings.port, reload=True)
