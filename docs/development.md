# Working on Orrery

`docker-compose.dev.yml` runs the repo with `nuxt dev` in place of the built app, on the same port
and database: a saved change shows on the page straight away and the server reloads itself, with no
rebuild. It's this machine's only.

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

Or put `COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml` in `.env` so plain `docker compose`
commands use it. The container has its own `node_modules` and `.nuxt` (volumes), and installs
packages as it starts, so after a `pnpm-lock.yaml` change, `docker compose restart orrery`. Change
the Dockerfile and it's `docker compose up -d --build`.

Without Docker: `pnpm install`, then `pnpm dev` on http://localhost:9000 (Node 24.22.1, pnpm 10.14.0).

## Checks

`pnpm test` (the column rules, the store, schedules) · `pnpm typecheck`

`pnpm test:e2e` runs the main flows in a real browser with Playwright: naming the owner, a project,
issues moved on the board, sub-issues, ⌘K, a proposal approved, a change showing up live in a second
tab. It starts `nuxt dev` on port 3199 with a fresh `.data/e2e.db`, so your own database isn't
touched. The first time, get its browser with `pnpm exec playwright install chromium`. A failed run
leaves a trace to replay with `pnpm exec playwright show-trace test-results/…/trace.zip`.

The database's migrations are numbered steps in `server/utils/db.ts`: add a step, never edit one.
