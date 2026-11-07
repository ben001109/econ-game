FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim@sha256:e5b65587bce7de595f299855d7385fe7fca39b8a74baa261ba1b7147afa78e58

WORKDIR /app
ENV UV_PROJECT_ENVIRONMENT=/app/.venv

COPY . .

RUN if [ -f uv.lock ]; then \
      uv sync --frozen --no-dev; \
    else \
      uv sync --no-dev; \
    fi

ENV HOME=/tmp UV_CACHE_DIR=/tmp/uv-cache UV_NO_SYNC=1 PYTHONDONTWRITEBYTECODE=1
USER 65532:65532
EXPOSE 4000
CMD ["uv", "run", "api-prod"]
