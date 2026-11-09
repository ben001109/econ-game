# B8-B FastAPI/Starlette remediation

## Scope

This batch changes only the API and frontend framework constraints, the
workspace `uv.lock`, the frontend Starlette 1 template-response invocation,
targeted frontend tests, and generated supply-chain evidence. It does not
change runtime configuration, schemas, migrations, Node dependencies, Bun,
OCI, images, or deployment inputs.

## Minimal compatible resolution

Official PyPI metadata confirms that FastAPI 0.121.1 requires
`starlette>=0.40.0,<0.50.0`, while FastAPI 0.133.1 requires `starlette>=0.40.0`
and supports Python 3.12. Both API and frontend now pin FastAPI 0.133.1 and
Starlette 1.3.1. The explicit Starlette pin avoids a resolver jump to a newer
unreviewed 1.x release while covering the five remaining CVEs / ten OSV alias
records fixed no later than 1.3.1.

The lock remains 54 packages. The only resolved version updates are:

| Package | Before | After |
| --- | ---: | ---: |
| FastAPI | 0.121.1 | 0.133.1 |
| Starlette | 0.49.3 | 1.3.1 |

Starlette 1 uses the request-first `TemplateResponse` API. The frontend call
now names `request`, `name`, and `context` explicitly, without altering the
existing settings or strict request-content behavior.

## Verification

An isolated temporary workspace excluded every `.env*` path, including
examples. `uv sync --frozen --all-packages --all-extras` and a second offline
frozen sync both passed. Targeted API/frontend `ruff check` and `compileall`
passed; frontend pytest passed 2/2. The new contract accepts an
`application/json` request body (200) and continues to reject the identical
`text/plain` body (422), so strict Content-Type handling was not disabled.

The whole Python ruff command remains blocked by a pre-existing, out-of-scope
unused `asyncio` import in `python/services/bot/src/econ_bot/main.py`; no B8-B
file caused that finding. The B7 generator is rerun rather than editing audit
or OSV counts manually.
