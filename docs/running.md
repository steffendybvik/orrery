# Running Orrery

```sh
docker compose up -d --build        # http://localhost:9000
```

That's the built app. On its first start it makes an empty SQLite database in the `orrery-data`
volume, with nothing to set up. The first time you open it, it asks your name: you're its owner,
and what you make no one else can delete. Your `Orrery-Actor` header is that name in lowercase snake
case (`Sköll Fenrisson` is `skoll_fenrisson`); change it in App settings → You.

After pulling a new version, `docker compose up -d --build` again; the database moves to the new
schema by itself.

## Settings

All optional, in a `.env` beside `docker-compose.yml` (see `.env.example`):

| Variable | What it does | Default |
|---|---|---|
| `ORRERY_PORT` | the port on this machine | `9000` |
| `ORRERY_HOST` | who can reach it: `0.0.0.0` opens it to the network (there are no accounts) | `127.0.0.1` |
| `ORRERY_DATA` | a folder for the database, `orrery.db` (with its `-wal` and `-shm` files beside it); on Linux it must be writable by uid 1000, the image's `node` user. Not a synced folder: syncing a live SQLite file corrupts it | the `orrery-data` volume |
| `ORRERY_BACKUP` | a folder for the backups (one that syncs off the machine is best) | the `orrery-backup` volume |
| `ORRERY_ALLOWED_HOSTS` | host names it answers to besides `localhost` and IP addresses, comma-separated, e.g. `orrery.lan` (see [SECURITY.md](../SECURITY.md)) | none |
| `ORRERY_DATABASE` | a `postgres://` URL to keep the Orrery in Postgres instead (see [Postgres](#postgres)) | the SQLite file |
| `ORRERY_SECRET_KEY` | encrypts the [secrets](API.md#secrets) your agents use without seeing: a long random string (`openssl rand -base64 32`). Keep it out of the backups; without the same key, secrets set with it won't open | none (no secrets) |
| `ORRERY_BUILD_CONTEXT` | what the image is built from: a ref on GitHub, e.g. `https://github.com/steffendybvik/orrery.git#main`, so a branch switched in this folder never ends up in it | this folder |
| `ORRERY_ENVIRONMENT` | this Orrery's name when you run more than one, e.g. `work`: a chip by its name, and the start of every tab's title | `personal` |

## Backups

A copy a few seconds after each change, `orrery.db`, plus one a day for two weeks. A new, empty
volume starts from the latest one. The live file never goes in the backup folder: a synced SQLite
file gets corrupted, a snapshot doesn't. On Postgres it's a SQLite snapshot of the database, made a minute after
a change (the whole database is copied each time), so a backup opens anywhere and a new SQLite Orrery starts from
it. App settings → This Orrery → Database says when the latest was made, with **Back up now**.

## Postgres

SQLite suits one machine. To keep the Orrery in Postgres instead (a server shared by a team, or a
database you already back up), put this in `.env`:

```sh
COMPOSE_PROFILES=postgres
ORRERY_DATABASE=postgres://orrery:orrery@postgres:5432/orrery
```

and `docker compose up -d`: the `postgres` profile adds a Postgres 17 service, its data in the
`orrery-pg` volume, and Orrery waits for it, then lays down its tables. Set `ORRERY_PG_PASSWORD` to
change the bundled database's password (it's only reachable from Orrery's container). For a Postgres
of your own, leave out the profile and point `ORRERY_DATABASE` at it.

Orrery backs it up to `ORRERY_BACKUP` as a SQLite snapshot (see [Backups](#backups)). For a large database,
or to restore into Postgres as it was, back it up with Postgres's own means as well: `pg_dump` on a
schedule (`docker compose exec postgres pg_dump -U orrery orrery > orrery.sql`), or a managed service's
backups.

To move an Orrery between SQLite and Postgres, stop it and copy it across, ids and all, into an empty
one (both ends are brought up to the latest schema first):

```sh
pnpm orrery:copy /path/to/orrery.db postgres://orrery:orrery@localhost:5432/orrery
pnpm orrery:copy postgres://orrery:orrery@localhost:5432/orrery ./orrery.db   # and back
```

The bundled Postgres isn't reachable from the machine, so copy into it with the profile's port opened
for the copy, or into a Postgres of your own.

## Two servers: personal and work

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

In a checkout you also work on Orrery in, build them from a release rather than the folder:
`ORRERY_BUILD_CONTEXT=https://github.com/steffendybvik/orrery.git#main` in each env file, then
`docker compose --env-file … up -d --build` when a release lands on `main`. Try changes in the
[playground](../.playground/README.md) instead.

A repo's channel and hook point at the server its projects are on, by `ORRERY_URL`:
`http://localhost:9010` for a personal repo, `http://localhost:9020` for a work one.

## Where each database is

App settings → This Orrery → Database shows it for the Orrery you're on: the SQLite file, or the Postgres database
(never its password), and its backup folder with when the latest backup was made, with how big each is.

It's always `/data/orrery.db` in the container, and `/data` is `ORRERY_DATA` when it's set, else the
project's `orrery-data` volume, `<project>_orrery-data`. The project is `COMPOSE_PROJECT_NAME`,
or the folder's name (`orrery`) without one. So a new project name is a new, empty database, and two
env files with the same one (or both without one) share a container and a database: give every
server its own. `docker compose --env-file .env.work down -v` deletes that server's volumes, its
database with them; plain `down` keeps them.

## Without Docker

Node 24.22.1 and pnpm 10.14.0: `pnpm install && pnpm build`, then

```sh
NUXT_DATABASE=/path/to/orrery.db PORT=9000 node .output/server/index.mjs
```

The database file is made if it isn't there (by default `.data/orrery.db`). A relative path is taken
from the folder the server starts in, so give `NUXT_DATABASE` an absolute one. It can also be a
Postgres URL (`postgres://user:password@host:5432/orrery`): Orrery lays down its tables on an empty
database, and backs it up as a SQLite snapshot when `NUXT_BACKUP_DIR` is set. The other settings are
`NUXT_BACKUP_DIR`, `NUXT_ALLOWED_HOSTS`, `NUXT_SECRET_KEY` and `NUXT_PUBLIC_ENVIRONMENT`.
