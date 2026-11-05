# Working on orrery

## Where things are

```
web/          the Nuxt app: app/ (the page), server/ (the API and the store), shared/ (both),
              public/, test/ (unit), e2e/ (browser), scripts/ (copy.ts, claim.mjs, worktrees.mjs), its package.json
channel/      the channel, hooks and launcher Claude sessions run, which orrery serves to their machines
api/          the Rust API (ORR-922), beside the Nuxt server: the domains moved so far, listed in openapi.yaml, its contract
docs/         these docs; docs/API.md is also served to agents (/api/guide, /llms-full.txt)
```

Inside `web/`:

```
app/pages/              one file per page; app/layouts/default.vue holds the sidebar and the dialogs
app/components/         the page's pieces, ui/ the kit (see UI components below)
app/composables/, utils/  shared state and behaviour, auto-imported
server/api/             the routes, one file per method and path (/api/…)
server/store/           the store, a file per domain (issues, milestones, comments, signals, releases, docs, presets…),
                        each class extending the one before; server/utils/store.ts is the last, `Store`, which the routes use
server/utils/           the rest of the server: the database and its migrations, sessions and launches, schedules, secrets
shared/                 types and rules both sides use: roadmap/ a file per area (board, sessions, schedules, settings…),
                        gathered by roadmap.ts, which everything imports from
```

The root is a pnpm workspace with the app as its one package: `pnpm dev`, `pnpm test`,
`pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test:e2e`, `pnpm orrery:copy`, `pnpm orrery:claim` and `pnpm worktrees` run there and work in `web/`. The root's
own dependency is the channel's MCP SDK, so `channel/` keeps working from other repos. The database
stays in the repo's `.data/`.

## The dev server

The [playground](../.playground/README.md) runs the repo with `nuxt dev`, so a saved change shows on the
page straight away and the server reloads itself, with no rebuild. It's a compose project of its own on
http://localhost:9001, with a demo database of its own, so the branch you're on never touches the Orrerys
you use. That database is a SQLite file in `.playground/data`, as the Rust API stays on SQLite until the Nuxt
server is gone. For Postgres, `COMPOSE_PROFILES=postgres` and `ORRERY_DATABASE=postgres://orrery:orrery@postgres:5432/orrery`
in `.playground/compose.env` add a service of the playground's own (its data in the `orrery-playground_orrery-pg` volume):

```sh
.playground/play          # start it, with a demo
.playground/play reset    # start over with a fresh demo
```

It's this machine's only. The container has its own `node_modules` and `.nuxt` (volumes), and installs
packages as it starts.

Without Docker: `pnpm install`, then `pnpm dev` on http://localhost:9000 (Node 24.22.1, pnpm 10.14.0).

## The Rust API

orrery's API is moving to Rust a domain at a time (ORR-921, ORR-922), the Nuxt server staying in front. Anything kept in
the database goes there; what touches the machine (sessions, tmux, the launcher, local files) stays. So far it serves the
**docs** domain (a project's docs, their sections and revisions), the orrery's **statuses** (`/api/statuses`,
ORR-926), **reading milestones and releases** (ORR-926: a project's, one of each, and `/api/releases`), **reading
issues and their comments** (ORR-927: the list with its filters, one issue, its comments) and **people, invites, keys
and logins** (ORR-928, removing a person aside) **reading the secrets** (ORR-953, never a value) and **reading one pull request** (ORR-952,
`/api/pulls/:owner/:name/:number`): the routes in
`api/openapi.yaml`. An artifact's page (`…/docs/:doc/artifact`), a milestone's focus, and writing an issue, a comment, a
milestone or a release stay in Nuxt, and so do setting, narrowing and deleting a secret and egress.

How it fits together:

- **One database, one writer per table.** The API opens the database the Nuxt server is on and runs no migrations: those
  stay in `web/server/utils/migrations`, and it refuses to start on a schema without the columns it reads, so start the
  Nuxt server on a new database first. Their port is ready for when the last domain has moved (ORR-931): see
  [Migrations in Rust](#migrations-in-rust). While it serves docs, the docs routes write through it alone. What still writes
  docs in Nuxt, not through a route (the chat's doc requests, a board's upload or copy, deleting a project), works on
  the same rows.
- **Nuxt checks, then forwards.** `web/server/middleware/zz-api.ts` runs after every other middleware (login, the board's
  permissions, the chat's and untrusted rails, the browser guards), works out who's asking (`actorOf`) and sends the
  request on with a token both were given, the database it's on, and that actor (`web/server/utils/api-router.ts`).
  The API listens on loopback and answers nothing else.
- **A line per domain.** `DOMAINS` in `api-router.ts` lists what goes to the API, one line each, matched on the path
  after `/api/`. A domain moves there by adding its line once the parity test passes, and goes back to Nuxt by taking
  the line out (ORR-925). A line can name its `methods`, so a domain's reads move before its writes, which share their
  paths. The contract test holds `openapi.yaml` to whatever the lines send on, method by method.
- **What a write sets off stays Nuxt's.** The API's reply says what changed (`Orrery-Changed`, a comma-separated list
  of projects; `Orrery-Settings: 1`; `Orrery-Told`), and the router tells it as the store would: open pages read each
  project again, they get the settings again when a status changed (every board has them), and the event log and
  schedules hear `doc.created`, `doc.changed`, `doc.deleted` ([Event flows](/p/orrery/docs/event-flows)).
- **Falling back.** When the API is down, not started yet, or on another database (the owner moved it in App settings),
  the request goes on to the Nuxt routes, which still answer it.

**The page's side (ORR-943).** The page reaches the API through `web/app/utils/api.ts` alone, so where it sends a path is one
setting: `NUXT_PUBLIC_API_BASES`, a JSON object of path prefix to base (`{"/projects/atlas/docs": "https://api.example.com/api"}`).
The longest prefix a path is under wins, and the rest stay on the page's own `/api`, which is the default with nothing set.
The live feed (`/events`) and upload and export addresses go by the same table. A base on another address gets the
browser's login with each call (`credentials: 'include'`, `withCredentials`), so it has to allow that: CORS for the
page's origin, with credentials, and the `Orrery-Actor` header.

The Rust API can't take the page's calls straight yet, so leave its prefixes unset: it trusts the token it shares with
Nuxt and the actor Nuxt sends, so a page calling it would need that token, and could say it's anyone. Before a page talks
to it directly it has to check the login itself ([ORR-928](/p/orrery/issues/ORR-928)), answer CORS, and apply the rails
Nuxt applies before forwarding (the board's permissions, the chat's and untrusted rails, the browser guards). Until then
the way in stays through Nuxt (`zz-api.ts`).

Running it: `cargo build` in `api/` (Rust 1.80 or later), then start the Nuxt server with
`NUXT_API_BIN=../api/target/debug/orrery-api`, which starts it beside itself on its own database with a fresh token,
and stops it with itself. Or run one yourself and point at it: `NUXT_API_TOKEN` (16 characters or more) and
`NUXT_DATABASE` for both, `ORRERY_API_LISTEN` for the API (`127.0.0.1:9100` by default), `NUXT_API_URL` for Nuxt.
`ORRERY_API_LOG=1` has the API say each request it answers. Without any of these, Nuxt answers every route as before.

Its checks: `cargo fmt --check`, `cargo clippy -- -D warnings` and `cargo test` in `api/`. `web/test/api-parity.test.ts`
runs the same steps through the store and through the API on one database (SQLite, or Postgres with
`TEST_POSTGRES_URL`) and compares the replies, failures and what each said changed; it skips without a built binary,
and CI's `api` job builds one first. It also holds `openapi.yaml` to the routes the router sends on. No browser spec runs
through the API yet: they all start Nuxt without `NUXT_API_BIN`.

A change to a docs, statuses or issue-reading route is now a change in three places: the store
(`web/server/store/docs.ts`, `statuses.ts`, `issues.ts`), the API (`api/src/docs.rs`, `statuses.rs`, `issues.rs`) and the
contract, with the parity test saying when they differ. That includes how the board is built: a field `readBoard` or
`buildBoard` adds to an issue, or a change to how its column rolls up, goes into `issues.rs` too. The statuses are the orrery's, not a project's, so their parity steps run on each side in turn, with the table
put back between.

People, invites, keys and logins (ORR-928, `api/src/people.rs`) are the same: a change to `web/server/store/people.ts`'s
`people`, `addPerson` or `renamePerson`, or to `keys.ts`, goes into `people.rs` too. Removing a person stays in the Nuxt
server, as it unassigns their issues (ORR-929). What only the Nuxt server's settings say (a login provider,
ORRERY_AUTH=off, the address for an invite's link) goes along as `Orrery-Login-Ways` and `Orrery-Origin`. Checking a key or a login cookie on each request stays in the Nuxt
server (`web/server/utils/auth.ts`), which sends the API what it found (`Orrery-Who`) and the asking browser's login only
hashed, so the API never sees a secret it didn't make. Who may handle people, keys and logins (`authorize`, `key-rights.ts`) is checked on
both sides, the credential having the last word over the actor, so the parity test compares the refusals with the permissions table's own words.

The secrets (ORR-953, `api/src/secrets.rs`) are read there and written here. A secret's value is sealed with the key
in `orrery.key`, which stays with the local app (Decision: secrets and settings in the Rust API), so the API never reads
the `value` column, and setting, narrowing (which seals it again) and deleting one stay in
`web/server/utils/secrets.ts`, as do egress and orrery's own requests. A change to its `list` or `get`, or to
`secretOf` or `useOf`, goes into `secrets.rs` too.

One pull request as orrery keeps it (ORR-952, `api/src/pulls.rs`) is read there: `forPull` in
`web/server/utils/pulls.ts`, with `pullForSession` for anyone but the owner. The router sends the asker's kind
(`Orrery-Actor-Kind`, as `kindOf` has it), so the chat naming the owner still doesn't get a PR's title or branch. The
list of PRs and the branches stay here, as they ask GitHub when what the poll kept is stale, and so does every write
to the pull tables (the poll, a rating), which waits on how the local app hears the board (ORR-929).

The outbox (ORR-929, `api/src/changes.rs`, the `rust-api-events` decision): each write the API makes adds a row to
`changes` for each thing it set off (a project changed, the settings, each event told), and `GET /api/changes?after=<id>`
reads them, oldest first, a page at a time, with `last` to ask after next. Asked with `Accept: text/event-stream`, the
same path streams them as server-sent events, oldest first, then live, each with its id, so a reader reconnecting with
`Last-Event-ID` carries on from it. A write's reply wakes the open streams (`changes::wake()`, once the write is
committed), and they look every second anyway, for writes from another process. A cursor whose row isn't kept answers
`gap: true` (a `gap` event on the stream) with the newest id: the reader has missed rows, so it reads the board again.
Rows older than a week are pruned hourly, keeping the newest. So far the rows go in just after the write, on its
connection, rather than in its transaction, and only the API's writes add them. Nothing reads them yet: the reply headers
still carry what changed to the Nuxt server.

## The page's pieces

Buttons, dialogs, menus and confirmations come from a small kit in `web/app/components/ui/`, and the
rest of the shared pieces (pickers, icons, chips) are one component each. [UI components](components.md)
lists them and when to use which: reach for one before writing the markup again.

The page reaches the API only through `web/app/utils/api.ts`: `apiFetch` by its path under `/api`, which sends a write as
the owner unless the call gives its own `headers`, and `apiUrl` for an address that isn't a fetch. `test/api-client.test.ts`
fails on a new `/api/` string or `$fetch` anywhere else in `web/app`.

## Checks

`pnpm test` (the column rules, the store, schedules, and the components in a Nuxt environment) · `pnpm typecheck` ·
`pnpm lint` (eslint; a non-null assertion is an error)

With `TEST_POSTGRES_URL` set (`postgres://orrery:orrery@localhost:5432/orrery`), the unit tests run on that Postgres,
each test in a schema of its own, and the ones that only make sense there run too. CI runs every unit test both ways.

`pnpm test:e2e` runs the flows in a real browser with Playwright, a file per area in `web/e2e/` (issues, proposals,
roadmap, releases, sessions, schedules, the keys, the phone layout…). The page walks go over the whole app from one
list of pages, `e2e/pages.ts`: `navigation.spec.ts` checks each renders with no error and that the sidebar, ⌘K and App
settings → Advanced lead to it, and `a11y.spec.ts` that it breaks no WCAG A or AA rule axe checks beyond the known ones
listed there (`wcag-light.spec.ts`, `wcag-dark.spec.ts`), scrolls by keyboard on a phone and leaves nothing under the Agent button.
These read-only walks are a test per page (`eachPage` in `e2e/walks.ts`), so a slow browser can't run one out of time partway and a retry runs only the page that failed (ORR-916). A new page is a line in
`pages.ts`, and `test/page-specs.test.ts` fails on a page that isn't, unless it names the spec that opens it. `a11y.spec.ts`
sets Advanced on the settings its page reads, not the shared one, so it needn't take turns with the specs that change them. `first-run.spec.ts` (naming the owner, the first
project) runs first as a project the others depend on; each other file makes a project of its own, with the helpers in
`e2e/support.ts`, so it can run alone. The whole suite runs on four workers, grouped in `playwright.config.ts` by what specs share on the one orrery: specs in no group run side by side, the `sessions` and `settings` groups each take turns inside themselves, and the specs that affect everyone (`people`, `settings-database`, `visual`) run alone, last, and are skipped if an earlier spec fails. A spec that changes something others read goes in a group, as a new spec is in none unless it's named there. `pnpm exec playwright test e2e/x.spec.ts` runs one spec, a test at a time, rather than `pnpm test:e2e e2e/x.spec.ts`, which runs the suite before it. It starts `nuxt dev` with a fresh `web/.data/e2e.db`, so your own database isn't
touched, on a port of the checkout's own (3100–3299, from its path, `web/e2e-port.ts`; `E2E_PORT` picks one), so
sessions running it from their own worktrees at once don't share a server (`pnpm worktrees` tidies up those left behind). The first time, and after `@playwright/test` is bumped, get its browser with `pnpm exec playwright install
chromium`. With `E2E_POSTGRES_URL` set it runs on that Postgres instead, emptied first, so its database's name
has to say e2e (`postgres://orrery:orrery@localhost:5432/orrery_e2e`). `E2E_BROWSER=webkit` or `firefox` runs it in that browser
instead of Chrome. `E2E_SHARD=2/3` runs one shard of the whole suite (ORR-920): first-run, then its share of each group's
specs, as the whole suite runs them, on a server of its own. `web/e2e-shards.ts` shares them out by how long each took
(`e2e/durations.json`; a spec it doesn't list counts as a middling one), and `test/e2e-shards.test.ts` checks every spec
lands in one shard. When the shards drift apart, refresh the times from a run's report with
`node scripts/e2e-durations.mjs e2e-results.json`. Playwright's own `--shard` doesn't do here: the last group depends on
the others, so it would run them whole in every shard. CI runs it in Playwright's own image of that version, once on
each database, then on SQLite in each of those two, each as three shards at once, and its `e2e-report` job merges the
SQLite and Chrome shards' results and coverage into the one `test-results-e2e` artifact. A failed run leaves a trace to replay with `pnpm exec playwright show-trace test-results/…/trace.zip`.

`e2e/visual.spec.ts` compares the board, the list and an issue's page to stored images. They're Linux's, so off
Linux the spec skips; `pnpm test:e2e:visual` (in `web/`) runs it in CI's Playwright image through Docker, and
`pnpm test:e2e:visual -- --update-snapshots` remakes the images after a change that's meant to show.

`pnpm test:e2e:login` runs `e2e/login/` on an orrery of its own with `ORRERY_AUTH=on` and a fresh `web/.data/e2e-login.db`, as
the flows' stays one person's: the login page, signing in with a key, Settings' keys and logging out.

`pnpm test:e2e:restart` builds the app and runs `e2e/restart/` on it, with a fresh `web/.data/e2e-restart.db`: the spec
stops and starts the server itself, to check what outlives a restart (the owner's chats). `RESTART_NO_BUILD=1` skips the build.

`pnpm images:readme` takes the README's images into `docs/images`, all 1440×900, from the playground's demo on an orrery of
its own with a fresh `web/.data/readme.db`. It's a script rather than a test, so it isn't part of `pnpm test:e2e`. It rewrites only the images that differ by more than a run's own noise. A machine that isn't Linux renders every image differently, so the real ones come from the **Images** workflow, in CI's Playwright image: `gh workflow run images.yml --ref v<version>`, on a release branch. Any that changed go on `images/v<version>`, as one commit on that branch's tip, and the run's summary links the pull request to open. Actions can't open it here, and its checks wouldn't start if it did. Someone looks at the images, so it doesn't merge itself. A later run updates an open one and starts its checks again.

`pnpm test:e2e:perf` times the pages on a big orrery. `e2e/perf/seed.ts` fills a fresh `web/.data/perf.db` (or, with
`E2E_POSTGRES_URL`, that Postgres) through the store: 20 projects, about 3,000 issues, 20,000 comments, 50,000
history rows, plus proposals, events, docs and schedules. The `PERF_*` variables change the sizes (`PERF_ISSUES=10000`).
Then it builds the app and runs it on a port of the checkout's own (3400–3599), and `e2e/perf/perf.spec.ts` opens each page fresh: the first load,
a big project's list, board and roadmap, an issue with a long thread, My issues, the bell, Notifications, Events,
Sessions, Releases, the search, a dropped stream reconnecting, and a change arriving live. Each one has a budget in
milliseconds, and a page over its budget fails the run. `web/perf-report/report.md` (and `report.json`) gives each
step's time, the API calls behind it and their sizes, and the slowest routes. CI runs it on both databases with the
e2e flows and keeps the report as an artifact. `PERF_NO_BUILD=1` reuses the last build when you're trying it again.

`pnpm soak`, after `pnpm build`, runs the built app on a fresh `web/.data/soak.db` and works it faster than real use: sessions listening, their streams and the page's live feed dropping and coming back, hooks, comments, edits and a backup every five minutes. `web/soak-report/` keeps its memory, open files and the project list's time every 15 seconds, and `summary.json` the totals. It fails on a request that errors or when open files keep growing, and memory is for reading. `SOAK_MINUTES` (30), `SOAK_SESSIONS` (8) and `SOAK_PORT` (3360) change it. A short run catches a fast leak, and says nothing of what only shows after days.

The database's migrations are numbered steps in `web/server/utils/migrations/sqlite.ts`, with Postgres's after its baseline
beside them in `web/server/utils/migrations/postgres.ts`: add a step to both, never edit one. `test/schema-parity.test.ts` checks that both end
on the same step with the same tables, columns, indexes and checks, and that a step changing data does the same on
each; a step that changes data gets an upgrade test there. Before a SQLite file takes steps it's copied to
`orrery-pre-<version>-step<n>.db`, and a database past the newest step the code knows (from a newer orrery) isn't opened.

### Migrations in Rust

The Rust API has the same steps (ORR-931): each SQL step as a numbered file in `api/migrations/sqlite` and
`api/migrations/postgres` (Postgres's baseline as `023-baseline.sql`), listed in `api/src/steps.rs`, and the steps that are
code here written again in `api/src/migrate.rs`. `orrery-api migrate` brings `NUXT_DATABASE` up to the newest step, counted
as the Node app counts them, so a database either one migrated carries on with the other. Nothing runs it yet: the Node
app migrates until the last domain has moved. Like Node, it copies a SQLite file before upgrading it, and won't upgrade
without the copy: `orrery-pre-<ORRERY_VERSION>-step<n>.db` in `ORRERY_API_BACKUP_DIR`, or beside the file. An owner
setting that isn't JSON stops the step that moves the owner to `people`. It leaves a database from before step 4 (when
issues were renumbered per board) to the Node app.

A new step is still written in `web/server/utils/migrations` first, then ported with

```sh
ORRERY_WRITE_MIGRATIONS=1 pnpm --dir web exec vitest run --project unit test/rust-migrations.test.ts
```

which writes the files. A step that's code needs its arm in `migrate.rs` by hand. `test/rust-migrations.test.ts` fails
until both are done, and with the binary built it checks that `orrery-api migrate` makes the database Node makes: from
empty, and carrying on from a step Node stopped at, on SQLite and (with `TEST_POSTGRES_URL`) on Postgres.

## Benchmarking the browser suite

[Test speed and coverage](/p/orrery/docs/test-speed-and-coverage) is the history: one run per version, so a slowdown shows when it arrives. It only means something if the runs are alike, so:

**What goes in the history.** The run CI makes of the release pull request, which Releasing's *Keep its test numbers* step records with `--source ci`: the SQLite job, in Chrome, in Playwright's image. A local run can hold a version's place until then, and CI's replaces it. The times on GitHub's runners move a little from run to run, so read a few percent as nothing, and a trend over versions as real.

**What the page holds apart.** A version isn't compared with the one before it when one is local and one on CI, when tests failed in either, or when the browser suite ran differently (its workers, and `metadata.server` in `playwright.config.ts`, kept with each run). Changing how the suite runs starts a new baseline: say so in the release's notes, and change `metadata.server` if it's the server that changed.

**Trying a change locally.** Don't add these runs to the history. To compare two ways of running the suite:

1. Use one machine, and one worktree, with nothing but the change between the runs. A commit from later on brings different tests.
2. Run nothing else: no other session's suite (check `pnpm worktrees` and Sessions), and at least 5 GB free on the disk. A full disk fails tests with `ENOSPC`, and looks like flaky tests.
3. Throw away the first run of each way, as it warms Vite's cache, then run each three times and take the median:
   ```sh
   E2E_WHOLE=1 PLAYWRIGHT_JSON_OUTPUT_NAME=run.json pnpm exec playwright test --reporter=line,json
   ```
4. Read `stats.duration` in `run.json`, in milliseconds, and time the whole command too: a build a way needs is paid on every CI run, so count it.
5. Count a run only if every test passed and the same tests ran. A way that's faster but fails tests isn't faster.
6. Put the numbers on the issue, with the commit, the machine and how many workers, so the result can be checked later.
