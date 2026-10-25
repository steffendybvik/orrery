# Running Orrery

```sh
docker compose up -d --build        # http://localhost:9000
```

That's the built app. On its first start it makes an empty SQLite database in the `orrery-data`
volume, with nothing to set up. The first time you open it, it asks your name: you're its owner,
and what you make no one else can delete. Your `Orrery-Actor` header is that name in lowercase snake
case (`Sköll Fenrisson` is `skoll_fenrisson`); change it in App settings.

### Without building

Each release is also an image, `ghcr.io/steffendybvik/orrery` (`:latest`, or a version like `:1.0.0`),
for Intel and Apple silicon:

```sh
docker run -d --name orrery --restart unless-stopped -p 127.0.0.1:9000:9000 \
  -v orrery-data:/data -v orrery-backup:/backup -e NUXT_BACKUP_DIR=/backup \
  ghcr.io/steffendybvik/orrery:latest
```

The channel and hooks a Claude session runs (`channel/`) come from a clone of this repo all the same,
so keep one for **Connect an agent**; set `NUXT_PUBLIC_REPO_DIR` to its path for the page to fill it in.

After pulling a new version, `docker compose up -d --build` again; the database moves to the new
schema by itself.

## Settings

All optional, in a `.env` beside `docker-compose.yml` (see `.env.example`):

| Variable | What it does | Default |
|---|---|---|
| `ORRERY_PORT` | the port on this machine | `9000` |
| `ORRERY_HOST` | who can reach it: `0.0.0.0` opens it to the network (there are no accounts) | `127.0.0.1` |
| `ORRERY_BACKUP` | a folder for the backups (one that syncs off the machine is best) | the `orrery-backup` volume |
| `ORRERY_ALLOWED_HOSTS` | host names it answers to besides `localhost` and IP addresses, comma-separated, e.g. `orrery.lan` (see [SECURITY.md](../SECURITY.md)) | none |
| `ORRERY_ENVIRONMENT` | this Orrery's name when you run more than one, e.g. `work`: a chip by its name, and the start of every tab's title | `personal` |

## Backups

A copy a few seconds after each change, `orrery.db`, plus one a day for two weeks. A new, empty
volume starts from the latest one. The live file never goes in the backup folder: a synced SQLite
file gets corrupted, a snapshot doesn't.

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

A repo's channel and hook point at the server its projects are on, by `ORRERY_URL`:
`http://localhost:9010` for a personal repo, `http://localhost:9020` for a work one.

## Where each database is

Nothing names the database directly: it's always `/data/orrery.db` in the container, and `/data` is
the project's `orrery-data` volume, `<project>_orrery-data`. The project is `COMPOSE_PROJECT_NAME`,
or the folder's name (`orrery`) without one. So a new project name is a new, empty database, and two
env files with the same one (or both without one) share a container and a database: give every
server its own. `docker compose --env-file .env.work down -v` deletes that server's volumes, its
database with them; plain `down` keeps them.

## Without Docker

Node 24.22.1 and pnpm 10.14.0: `pnpm install && pnpm build`, then

```sh
NUXT_DATABASE=/path/to/orrery.db PORT=9000 node .output/server/index.mjs
```

The database file is made if it isn't there (by default `.data/orrery.db`). The other settings are
`NUXT_BACKUP_DIR`, `NUXT_ALLOWED_HOSTS` and `NUXT_PUBLIC_ENVIRONMENT`.
