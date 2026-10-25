# Orrery

A Linear-style board for every app I'm building: what's being worked on, what's next, what's done.
Apps (and the Claude sessions in their repos) keep their roadmaps here through the API in
[docs/API.md](docs/API.md); the page shows them read-only and updates live.

## Run

You need Docker. From the repo:

```sh
docker compose up -d --build        # http://localhost:9000
```

That's the built app. On its first start it makes an empty SQLite database in the `orrery-data`
volume, with nothing to set up. The first time you open it, it asks your name: you're its owner,
and what you make no one else can delete. Your `Orrery-Actor` header is that name in lowercase snake
case (`Steffen Dybvik` is `steffen_dybvik`); change it in Settings. Then create your first project from
the sidebar (`+`) or as in [Connect a repo](#connect-a-repo). Everything below is optional, in a `.env` beside
`docker-compose.yml` (see `.env.example`):

| Variable | What it does | Default |
|---|---|---|
| `ORRERY_PORT` | the port on this machine | `9000` |
| `ORRERY_HOST` | who can reach it: `0.0.0.0` opens it to the network (there are no accounts) | `127.0.0.1` |
| `ORRERY_BACKUP` | a folder for the backups (one that syncs off the machine is best) | the `orrery-backup` volume |
| `ORRERY_ENVIRONMENT` | this Orrery's name when you run more than one, e.g. `work`: a chip by its name, and the start of every tab's title | `personal` |

After pulling a new version, `docker compose up -d --build` again; the database moves to the new
schema by itself.

The backups are a copy a few seconds after each change, `orrery.db`, plus one a day for two weeks.
A new, empty volume starts from the latest one. The live file never goes in the backup folder: a
synced SQLite file gets corrupted, a snapshot doesn't.

Without Docker (Node 24.22.1, pnpm 10.14.0): `pnpm install && pnpm build`, then
`NUXT_DATABASE=/path/to/orrery.db PORT=9000 node .output/server/index.mjs`. The database file is
made if it isn't there (by default `.data/orrery.db`). The same settings are
`NUXT_BACKUP_DIR` and `NUXT_PUBLIC_ENVIRONMENT`.

### Two servers: personal and work

Each Orrery is its own server with its own database, so work and personal projects never mix. Run
each as its own compose project with its own env file:

```sh
# .env.personal
COMPOSE_PROJECT_NAME=orrery-personal
ORRERY_ENVIRONMENT=personal
ORRERY_PORT=9010
ORRERY_BACKUP=/path/to/backups/personal
```

```sh
# .env.work
COMPOSE_PROJECT_NAME=orrery-work
ORRERY_ENVIRONMENT=work
ORRERY_PORT=9020
ORRERY_BACKUP=/path/to/backups/work
```

```sh
docker compose --env-file .env.personal up -d --build   # http://localhost:9010, chip: personal
docker compose --env-file .env.work up -d --build       # http://localhost:9020, chip: work
```

The project name keeps them apart: each gets its own volumes (`orrery-personal_orrery-data`,
`orrery-work_orrery-data`), container and port, so stopping, rebuilding or wiping one leaves the
other alone (`docker compose --env-file .env.work down`). Give each its own backup folder, too: a
backup folder holds one database. Env files other than `.env.example` are git-ignored.

A repo's channel and hook point at the server its projects are on, by `ORRERY_URL`:
`http://localhost:9010` for a personal repo, `http://localhost:9020` for a work one.

### Working on Orrery

`docker-compose.dev.yml` runs the repo with `nuxt dev` in place of the built app, on the same port
and database: a saved change shows on the page straight away and the server reloads itself, with no
rebuild. It's this machine's only.

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

Or put `COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml` in `.env` so plain `docker compose`
commands use it. The container has its own `node_modules` and `.nuxt` (volumes), and installs
packages as it starts, so after a `pnpm-lock.yaml` change, `docker compose restart orrery`. Change
the Dockerfile and it's `docker compose up -d --build`. Locally instead: `pnpm install`, then
`pnpm dev` on http://localhost:9000.

## Connect a repo

**1. Create its project.** The `id` is what the repo's sessions name it by; the `key` prefixes its
issue ids (`SHP-1`, `SHP-2`, …), and defaults to the name's first three letters.

```sh
curl -s -X POST http://localhost:9000/api/projects \
  -H 'Content-Type: application/json' -H 'Orrery-Actor: claude' \
  -d '{"name": "Shop", "id": "shop", "key": "SHP", "description": "The storefront"}'
```

**2. Add the channel** to the repo's `.mcp.json`, named after the project (`orrery-<project>`, or
plain `orrery`), so the owner's signals reach its sessions:

```json
{
  "mcpServers": {
    "orrery-shop": {
      "command": "node",
      "args": ["/path/to/orrery/channel/orrery-channel.mjs"],
      "env": {
        "ORRERY_URL": "http://localhost:9000",
        "ORRERY_PROJECT": "shop"
      }
    }
  }
}
```

Channels are a research preview, so Claude Code only shows the channel's messages in a session
started with it: `claude --dangerously-load-development-channels server:orrery-shop`. A terminal alias
saves typing that, in `~/.zshrc`:

```sh
alias shop="cd ~/code/shop && ORRERY_PROJECT=shop claude --dangerously-load-development-channels server:orrery-shop"
```

Then `source ~/.zshrc` and start the session with `shop`. A repo with several projects (a monorepo,
one per app) gets one server and one alias for each.

**3. Optionally, the hook** (`channel/orrery-hook.mjs`) tells Orrery what each session is doing, so
the page can show it and aim work at an idle one. Register it in the repo's `.claude/settings.json`
for `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification` and `SessionEnd`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "ORRERY_PROJECT=${ORRERY_PROJECT:-shop} ORRERY_URL=http://localhost:9000 node /path/to/orrery/channel/orrery-hook.mjs",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The same entry goes under each of the other events. `${ORRERY_PROJECT:-shop}` lets an alias pick
the project; without one, it's `shop`.

## Keys

`j`/`k` move · `Enter` opens · `Esc` closes · `/` filters · `⌘K` jumps · `1`/`2` List/Board · `g n` Now · `g u` Urgent · `g m` My issues

## Checks

`pnpm test` (column rules, store) · `pnpm typecheck`
