# B7-A Python OSV remediation

## Scope

Only the workspace `uv.lock` is changed by this batch. The direct dependency
constraints in the four Python service `pyproject.toml` files remain unchanged.
No Node, Bun, OCI, Docker, Compose, Pterodactyl, schema, migration, or runtime
configuration files are part of this remediation.

## Provenance and result

- Before: `uv.lock` SHA-256
  `4ce39c377114cc1de5753ef88fafd5cbe9cd9e3b11b523dbdd2f2304b55a218b`.
  The B4 evidence recorded 84 OSV matches across 54 resolved packages.
- Source: the official PyPI simple index for resolution and the official OSV
  `v1/querybatch` and `v1/vulns/{id}` APIs for advisory verification.
- After: `uv.lock` SHA-256
  `5d04d9bd51d47884d4dfd25e4e30437ac0d69577eccee1c90ded06e7eb5d1ff6`.
  At `2026-08-16T15:49:22Z`, an OSV `v1/querybatch` POST covering all 54
  locked packages reported 10 matches, all for `starlette==0.49.3`. The query
  is reproducible by parsing every `name`/`version` pair in `uv.lock` into
  `{ "package": { "ecosystem": "PyPI", "name": ... }, "version": ... }`
  entries and posting them to `https://api.osv.dev/v1/querybatch`.

## Targeted updates

| Package | Before | After |
| --- | ---: | ---: |
| aiohttp | 3.13.2 | 3.14.3 |
| click | 8.3.0 | 8.4.2 |
| idna | 3.11 | 3.18 |
| pydantic-settings | 2.12.0 | 2.15.0 |
| pygments | 2.19.2 | 2.20.0 |
| pytest | 9.0.0 | 9.1.1 |
| python-dotenv | 1.2.1 | 1.2.2 |

The resolver evaluated the eight packages identified by B4 using
`--upgrade-package`; it updated the seven packages above and left Starlette
unchanged because no compatible fixed release could be resolved. It did not
update unrelated packages or direct constraints.

## Explicitly unresolved Starlette advisories

The remaining 10 OSV records are five CVEs represented by GHSA/PYSEC aliases:

| CVE | GHSA | PYSEC alias | Official fixed version |
| --- | --- | --- | ---: |
| CVE-2026-48710 | GHSA-86qp-5c8j-p5mr | PYSEC-2026-161 | 1.0.1 |
| CVE-2026-48817 | GHSA-x746-7m8f-x49c | PYSEC-2026-2280 | 1.1.0 |
| CVE-2026-48818 | GHSA-wqp7-x3pw-xc5r | PYSEC-2026-2281 | 1.1.0 |
| CVE-2026-54282 | GHSA-jp82-jpqv-5vv3 | PYSEC-2026-248 | 1.3.0 |
| CVE-2026-54283 | GHSA-82w8-qh3p-5jfq | PYSEC-2026-249 | 1.3.1 |

`fastapi==0.121.1` officially requires `starlette>=0.40.0,<0.50.0`; therefore
the maximum required fixed version is not compatible with the current FastAPI
line. This batch deliberately does not make a speculative framework-major
upgrade. A later, separately reviewed compatibility batch must select a
FastAPI release that supports Starlette 1.3.1 or later, then repeat the OSV
audit.

## Verification completed

1. `uv lock --check --offline` passed for all 54 resolved packages.
2. In an isolated `/private/tmp` copy that excluded `.env*`, Git metadata,
   existing virtual environments, and build artifacts, both `uv sync --frozen`
   and `uv sync --frozen --offline --all-packages --all-extras` passed.
3. `ruff check python/services` passed and `python -m compileall -q
   python/services` passed in that isolated environment. No Python test files
   exist under the four service `tests/` directories, and no mypy or pyright
   configuration/dependency is present; consequently there were no runnable
   Python unit or static type checks to execute.
4. A post-update OSV batch query covered all 54 packages and returned only the
   documented 10 Starlette alias records.
