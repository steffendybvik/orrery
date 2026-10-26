# Working on Orrery

## Where things are

```
web/          the Nuxt app: app/ (the page), server/ (the API and the store), shared/ (both),
              public/, test/ (unit), e2e/ (browser), scripts/ (copy.ts), its package.json
channel/      the channel and hooks Claude sessions run, by path, from every connected repo
docs/         these docs; docs/API.md is also served to agents (/api/guide, /llms-full.txt)
```

The root is a pnpm workspace with the app as its one package: `pnpm dev`, `pnpm test`,
`pnpm typecheck`, `pnpm test:e2e` and `pnpm orrery:copy` run there and work in `web/`. The root's
own dependency is the channel's MCP SDK, so `channel/` keeps working from other repos. The database
stays in the repo's `.data/`.

## The dev server

`docker-compose.dev.yml` runs the repo with `nuxt dev`: a saved change shows on the page straight away
and the server reloads itself, with no rebuild. Run it as a compose project of its own, beside the
Orrerys you use, with a demo database, so the branch you're on never touches their data. A `.env.dev`:

```sh
COMPOSE_PROJECT_NAME=orrery-dev
COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml
ORRERY_ENVIRONMENT=dev
ORRERY_SEED=1
```

```sh
docker compose --env-file .env.dev up -d
```

It's on http://localhost:9000 (this machine's only). `ORRERY_SEED` fills its empty database with a demo
on start: a few projects, a monorepo sharing a release, proposals waiting on you and a question in the
bell. One that has projects is left as it is; `docker compose --env-file .env.dev down -v` starts it
over. The container has its own `node_modules` and `.nuxt` (volumes), and installs packages as it starts,
so after a `pnpm-lock.yaml` change, `docker compose --env-file .env.dev restart orrery`. Change the
Dockerfile and it's `up -d --build`.

The Orrerys you use run the built app, each its own compose project (`.env`, `.env.work`). Build them
from a release on GitHub rather than this folder, so a switched branch never ends up in them:
`ORRERY_BUILD_CONTEXT=https://github.com/steffendybvik/orrery.git#main` in their `.env`, then
`docker compose up -d --build` when a release lands on `main`.

Without Docker: `pnpm install`, then `pnpm dev` on http://localhost:9000 (Node 24.22.1, pnpm 10.14.0).

## Checks

`pnpm test` (the column rules, the store, schedules) · `pnpm typecheck`

`pnpm test:e2e` runs the main flows in a real browser with Playwright: naming the owner, a project,
issues moved on the board, sub-issues, ⌘K, a proposal approved, a change showing up live in a second
tab. It starts `nuxt dev` on port 3199 with a fresh `web/.data/e2e.db`, so your own database isn't
touched. The first time, get its browser with `pnpm exec playwright install chromium`. A failed run
leaves a trace to replay with `pnpm exec playwright show-trace test-results/…/trace.zip`.

The database's migrations are numbered steps in `web/server/utils/db.ts`, with Postgres's after its baseline in
`web/server/utils/postgres.ts`: add a step to both, never edit one.
