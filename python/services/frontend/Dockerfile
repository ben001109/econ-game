FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app
ENV UV_PROJECT_ENVIRONMENT=/app/.venv

COPY . .

RUN if [ -f uv.lock ]; then \
      uv sync --frozen --no-dev; \
    else \
      uv sync --no-dev; \
    fi

EXPOSE 3000
CMD ["uv", "run", "frontend-prod"]
