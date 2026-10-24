# Orrery

A Linear-style board for every app I'm building: what's being worked on, what's next, what's done.
Apps (and the Claude sessions in their repos) keep their roadmaps here through the API in
[docs/API.md](docs/API.md); the page shows them read-only and updates live.

## Run

```sh
docker compose up -d --build        # http://localhost:9000, data in the orrery-data volume
ORRERY_PORT=9010 docker compose up -d   # if 9000 is taken
```

Locally (Node 24.22.1, pnpm 10.14.0): `pnpm install`, then `pnpm dev` on http://localhost:9000.
The database is `.data/orrery.db` (`NUXT_DATABASE`).

The container keeps a copy of the database in iCloud Drive's `Orrery` folder (`ORRERY_BACKUP`), a few
seconds after each change plus one a day for two weeks, and a new volume starts from it. The live
file stays out of iCloud: a synced SQLite file gets corrupted, a snapshot doesn't. `NUXT_OWNER` (`ORRERY_OWNER` in compose) is the
name whose things no one else can delete.

## Keys

`j`/`k` move · `Enter` opens · `Esc` closes · `/` filters · `⌘K` jumps · `1`/`2` List/Board · `g n` Now · `g u` Urgent

## Checks

`pnpm test` (column rules, store) · `pnpm typecheck`
