# Contributing to Econ Game

Thanks for considering a contribution. Econ Game is evolving toward a modular economic simulation with separate game, API, worker, web, and Discord-facing components.

## Before you start

- For bug fixes, open or reference an issue that describes the problem and expected behavior.
- For larger features or architecture changes, open an issue first so the scope can be discussed before implementation.
- Keep pull requests focused. Avoid mixing unrelated refactors with behavior changes.

## Development setup

The quickest path is Docker Compose:

```bash
docker compose up --build
```

For local development, use Node 20 as specified by `.nvmrc`. Service-specific commands live in each package/service directory.

## Quality checks

Before opening a pull request, run the checks relevant to the area you changed. Typical checks include:

```bash
npm run lint
npm run build
npm test
```

For infrastructure changes, also validate Docker Compose configuration when applicable.

## Pull requests

A good pull request should include:

- what changed and why;
- affected services/packages;
- verification performed;
- screenshots or API examples when behavior is user-visible;
- migration or compatibility notes when data/schema behavior changes.

## Security

Please do not report suspected security vulnerabilities in a public issue. See `SECURITY.md` for the preferred reporting process.

## Licensing

A repository-wide open-source license has not yet been selected. Contributions should not add third-party code unless its license and attribution requirements are clearly compatible with the license the maintainer ultimately chooses.