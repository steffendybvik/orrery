# Working on orrery

## Where things are

```
web/          the Nuxt app: app/ (the page), server/ (the API and the store), shared/ (both),
              public/, test/ (unit), e2e/ (browser), scripts/ (copy.ts), its package.json
channel/      the channel and hooks Claude sessions run, by path, from every connected repo
docs/         these docs; docs/API.md is also served to agents (/api/guide, /llms-full.txt)
```

Inside `web/`:

```
app/pages/              one file per page; app/layouts/default.vue holds the sidebar and the dialogs
app/components/         the page's pieces, ui/ the kit (see UI components below)
app/composables/, utils/  shared state and behaviour, auto-imported
server/api/             the routes, one file per method and path (/api/…)
server/store/           the store, a file per domain (issues, chunks, comments, signals, releases, docs, presets…),
                        each class extending the one before; server/utils/store.ts is the last, `Store`, which the routes use
server/utils/           the rest of the server: the database and its migrations, sessions and launches, schedules, secrets
shared/                 types and rules both sides use (roadmap.ts)
```

The root is a pnpm workspace with the app as its one package: `pnpm dev`, `pnpm test`,
`pnpm typecheck`, `pnpm test:e2e` and `pnpm orrery:copy` run there and work in `web/`. The root's
own dependency is the channel's MCP SDK, so `channel/` keeps working from other repos. The database
stays in the repo's `.data/`.

## The dev server

The [playground](../.playground/README.md) runs the repo with `nuxt dev`, so a saved change shows on the
page straight away and the server reloads itself, with no rebuild. It's a compose project of its own on
http://localhost:9001, with a demo database in `.playground/data`, so the branch you're on never touches
the Orrerys you use:

```sh
.playground/play          # start it, with a demo
.playground/play reset    # start over with a fresh demo
```

It's this machine's only. The container has its own `node_modules` and `.nuxt` (volumes), and installs
packages as it starts.

Without Docker: `pnpm install`, then `pnpm dev` on http://localhost:9000 (Node 24.22.1, pnpm 10.14.0).

## The page's pieces

Buttons, dialogs, menus and confirmations come from a small kit in `web/app/components/ui/`, and the
rest of the shared pieces (pickers, icons, chips) are one component each. [UI components](components.md)
lists them and when to use which: reach for one before writing the markup again.

## Checks

`pnpm test` (the column rules, the store, schedules, and the components in a Nuxt environment) · `pnpm typecheck` ·
`pnpm lint` (eslint; a non-null assertion is an error)

`pnpm test:e2e` runs the flows in a real browser with Playwright, a file per area in `web/e2e/` (issues, proposals,
roadmap, releases, sessions, schedules, the keys, the phone layout…). `first-run.spec.ts` (naming the owner, the first
project) runs first as a project the others depend on; each other file makes a project of its own, with the helpers in
`e2e/support.ts`, so it can run alone. It starts `nuxt dev` with a fresh `web/.data/e2e.db`, so your own database isn't
touched, on a port of the checkout's own (3100–3299, from its path, `web/e2e-port.ts`; `E2E_PORT` picks one), so
sessions running it from their own worktrees at once don't share a server. The first time, and after `@playwright/test` is bumped, get its browser with `pnpm exec playwright install
chromium`. With `E2E_POSTGRES_URL` set it runs on that Postgres instead, emptied first, so its database's name
has to say e2e (`postgres://orrery:orrery@localhost:5432/orrery_e2e`). CI runs it in Playwright's own image of that
version, once on each database. A failed run leaves a trace to replay with `pnpm exec playwright show-trace test-results/…/trace.zip`.

`e2e/visual.spec.ts` compares the board, the list and an issue's page to stored images. They're Linux's, so off
Linux the spec skips; `pnpm test:e2e:visual` runs it in CI's Playwright image through Docker, and
`pnpm test:e2e:visual -- --update-snapshots` remakes the images after a change that's meant to show.

`pnpm test:e2e:perf` times the pages on a big orrery. `e2e/perf/seed.ts` fills a fresh `web/.data/perf.db` (or, with
`E2E_POSTGRES_URL`, that Postgres) through the store: 20 projects, about 3,000 issues, 20,000 comments, 50,000
history rows, plus proposals, events, docs and schedules. The `PERF_*` variables change the sizes (`PERF_ISSUES=10000`).
Then it builds the app and runs it on port 3398, and `e2e/perf/perf.spec.ts` opens each page fresh: the first load,
a big project's list, board and roadmap, an issue with a long thread, My issues, the bell, Notifications, Events,
Sessions, Releases, the search, a dropped stream reconnecting, and a change arriving live. Each one has a budget in
milliseconds, and a page over its budget fails the run. `web/perf-report/report.md` (and `report.json`) gives each
step's time, the API calls behind it and their sizes, and the slowest routes. CI runs it on both databases with the
e2e flows and keeps the report as an artifact. `PERF_NO_BUILD=1` reuses the last build when you're trying it again.

The database's migrations are numbered steps in `web/server/utils/db.ts`, with Postgres's after its baseline in
`web/server/utils/postgres.ts`: add a step to both, never edit one. Before a SQLite file takes steps it's copied to
`orrery-pre-<version>-step<n>.db`, and a database past the newest step the code knows (from a newer orrery) isn't opened.
