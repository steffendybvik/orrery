# Working on Orrery

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

`pnpm test` (the column rules, the store, schedules) · `pnpm typecheck`

`pnpm test:e2e` runs the main flows in a real browser with Playwright: naming the owner, a project,
issues moved on the board, sub-issues, ⌘K, a proposal approved, a change showing up live in a second
tab. It starts `nuxt dev` on port 3199 with a fresh `web/.data/e2e.db`, so your own database isn't
touched. The first time, and after `@playwright/test` is bumped, get its browser with `pnpm exec playwright install
chromium`. CI runs it in Playwright's own image of that version. A failed run
leaves a trace to replay with `pnpm exec playwright show-trace test-results/…/trace.zip`.

The database's migrations are numbered steps in `web/server/utils/db.ts`, with Postgres's after its baseline in
`web/server/utils/postgres.ts`: add a step to both, never edit one.
