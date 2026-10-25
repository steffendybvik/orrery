# Orrery

A Linear-style board for every app I'm building: what's being worked on, what's next, what's done.
Apps (and the Claude sessions in their repos) keep their roadmaps here through the API in
[docs/API.md](docs/API.md); the page shows them read-only and updates live.

## Run

```sh
docker compose up -d                # http://localhost:9000, data in the orrery-data volume
ORRERY_PORT=9010 docker compose up -d   # if 9000 is taken (or set it in .env)
```

That runs the repo with `nuxt dev`: it's mounted into the container, so a saved change shows on the
page straight away and the server reloads itself, with no rebuild. Only this Mac can reach it. The
container has its own `node_modules` and `.nuxt` (volumes), and installs packages as it starts, so
after a `pnpm-lock.yaml` change, `docker compose restart orrery`. Change the Dockerfile and it's
`docker compose up -d --build`.

The built app, for when nothing's being worked on (same port and database, so one at a time):

```sh
docker compose stop orrery && docker compose --profile prod up -d --build orrery-prod
```

A second Orrery for work runs beside it, apart in everything: `orrery-work` on http://localhost:9020
(`ORRERY_WORK_PORT`), the built app, with its own database (the `orrery-work-data` volume) and its
own backups on this Mac (`~/Library/Application Support/Orrery Work`, or `ORRERY_WORK_BACKUP`), not
in iCloud. It's badged **Work**. A repo's sessions use it when its `.mcp.json` sets
`ORRERY_URL=http://localhost:9020`. It changes only when rebuilt: `docker compose up -d --build orrery-work`.

Locally (Node 24.22.1, pnpm 10.14.0): `pnpm install`, then `pnpm dev` on http://localhost:9000.
The database is `.data/orrery.db` (`NUXT_DATABASE`).

The container keeps a copy of the database in iCloud Drive's `Orrery` folder (`ORRERY_BACKUP`), a few
seconds after each change plus one a day for two weeks, and a new volume starts from it. The live
file stays out of iCloud: a synced SQLite file gets corrupted, a snapshot doesn't. `NUXT_OWNER` (`ORRERY_OWNER` in compose) is the
name whose things no one else can delete.

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
