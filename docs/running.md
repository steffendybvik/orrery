# Running orrery

```sh
docker compose up -d --build        # http://localhost:9000
```

That's the built app. On its first start it makes an empty SQLite database in the `orrery-data`
volume, with nothing to set up. The first time you open it, it asks your name: you're its owner,
and what you make no one else can delete. Your `Orrery-Actor` header is that name in lowercase snake
case (`Sköll Fenrisson` is `skoll_fenrisson`); change it in App settings → You. It also asks whether
you're a developer: a no turns **Advanced** off, so Events, Context and Pull requests stay out of the
sidebar (App settings → Advanced turns it back on).

## Updating

1. **Back it up**: App settings → This orrery → **Back up now**, and keep a copy of that backup under a name of its own
   until you're happy with the new version.
2. **Rebuild**: `git pull` in this folder (or nothing, when `ORRERY_BUILD_CONTEXT` names a branch on GitHub), then
   `docker compose up -d --build` again. The database moves to the new schema by itself. On SQLite it keeps a copy
   as it was first, `orrery-pre-<version>-step<n>.db` (`<n>` the schema step it was at, so each step taken under one version gets its own), in the backup folder (beside the database when backups are off).
   An older version won't open a database a newer one has moved on: it stops and says so. To go back, restore that
   copy.
3. **The channel and the launcher** run from this folder on your machine, not in the container, so they're as new as
   what it has checked out: keep it on the version you run (`git pull`). Sessions pick up the channel as they start.
   The launcher only when it restarts, which stops the sessions it started, so do it when nothing's mid-work:
   `launchctl kickstart -k gui/$(id -u)/orrery.launcher` on a Mac, `systemctl --user restart orrery-launcher` on Linux
   (`--install` again restarts it only when its service file changed, such as a new `node` or `PATH`). A launcher older than the server says so in the event log (`launcher.outdated`) when it's refused a launch.
   Since 1.0.0-rc.10 the Sessions page marks a session whose channel is older than the server, and a launcher on older
   code. The launcher service restarts itself on the new code once this folder is pulled (a new version, or a change
   within one) and it has no session running.

## Settings

All optional, in a `.env` beside `docker-compose.yml` (see `.env.example`):

| Variable | What it does | Default |
|---|---|---|
| `ORRERY_PORT` | the port on this machine | `9000` |
| `ORRERY_HOST` | who can reach it: `0.0.0.0` opens it to the network (there are no accounts); see [Reach it from your phone](#reach-it-from-your-phone) | `127.0.0.1` |
| `ORRERY_DATA` | a folder for the database, `orrery.db` (with its `-wal` and `-shm` files beside it); on Linux it must be writable by uid 1000, the image's `node` user. Not a synced folder: syncing a live SQLite file corrupts it | the `orrery-data` volume |
| `ORRERY_BACKUP` | a folder for the backups (one that syncs off the machine is best). Without it they stay on this computer, and orrery says so once, and in App settings | the `orrery-backup` volume |
| `ORRERY_BACKUP_DATABASE` | a `postgres://` URL to back up into instead of the folder: an empty database, or this orrery's backup from before (see [Backups](#backups)) | none |
| `ORRERY_ALLOWED_HOSTS` | host names it answers to besides `localhost` and IP addresses, comma-separated, e.g. `orrery.lan` (see [SECURITY.md](../SECURITY.md)) | none |
| `ORRERY_DATABASE` | a `postgres://` URL to keep the orrery in Postgres instead (see [Postgres](#postgres)) | the SQLite file |
| `ORRERY_SECRET_KEY` | encrypts the [secrets](API.md#secrets) your agents use without seeing: a long random string (`openssl rand -base64 32`). Keep it out of the backups; without the same key, secrets set with it won't open | made on first start, kept in `orrery.key` beside the database (`/data` in Docker; none outside Docker on Postgres, so set it there) |
| `ORRERY_BUILD_CONTEXT` | what the image is built from: a ref on GitHub, e.g. `https://github.com/steffendybvik/orrery.git#main`, so a branch switched in this folder never ends up in it | this folder |
| `ORRERY_UPDATE_CHECK` | `false` stops orrery asking GitHub for its own releases (at start, then every 12 hours), which it does to show a notice above the version in the sidebar when a newer one is out. A pre-release is offered only to an orrery running one | on |
| `ORRERY_ENVIRONMENT` | this orrery's name when you run more than one, e.g. `work`: a chip by its name, and the start of every tab's title | `personal` |

## A GitHub token

orrery reads each project's pull requests off GitHub (the Pull requests page, an issue's PRs, and the comments it
leaves when one conflicts, fails or merges). A public repo works without a token, but only its list, every ten
minutes. With a token, a private repo works too, and orrery reads where each pull request stands every minute.

1. On GitHub, [make a fine-grained token](https://github.com/settings/personal-access-tokens/new) with
   *Pull requests: Read-only* on the repos your projects point at (a classic token needs `repo`).
2. In **App settings → This orrery → Secrets**, `GITHUB_TOKEN` is listed as *Not set*. Press **Set** and paste the
   token: its name and its host, `api.github.com`, are filled in.

orrery polls straight away. The row then shows when it was last used, or that GitHub turned it down. A token saved
some other way is only used when its hosts include `api.github.com`; the Pull requests page says so when they don't.

## Backups

A copy a few seconds after each change, `orrery.db`, plus one a day for two weeks (both can be changed, below). The live file never goes in the backup folder: a synced SQLite
file gets corrupted, a snapshot doesn't. On Postgres it's a SQLite snapshot of the database, made a minute after
a change, or at most ten minutes after the first while changes keep coming (the whole database is copied each time), so a backup opens anywhere and a new SQLite orrery starts from
it. App settings → This orrery → Database says when the latest was made, with **Back up now**. It marks the latest
when it's over two days old, and says why when the last try failed.

Every copy is written beside the one it replaces and checked (SQLite's `quick_check`) before it takes that one's place.
A copy that fails the check is let go, the one before stays, and the failure goes in the event log as `backup.failed`.
The copy taken before an upgrade (`orrery-pre-<version>-step<n>.db`) is made the same way. If it can't be made, orrery stops
with the reason instead of upgrading a database it has no copy of.

### Restoring

A new orrery whose database is empty (no projects, no owner yet) never starts from a backup by itself. When its backup
folder has backups, the first page asks: **Found backups. Restore one?** It lists them with their date, size, projects
and the orrery each is a copy of (its name, `ORRERY_ENVIRONMENT`, and id), and marks one from another orrery. Pick one,
or **Start fresh**. Until you've chosen, the empty one isn't backed up over them. In Docker, an orrery that starts
empty with no backups says (on that page and in the log) that its data may be in another volume: a folder with
another name gives another one, see `docker volume ls`.

On a SQLite orrery, App settings → This orrery → Database → **Restore a backup…** does the same at any time. It
checks the backup whole first (`integrity_check`), then copies the database as it is now into the backup folder
(`orrery-pre-restore-<time>.db`). It then runs on a copy of the backup, `orrery-restored-<time>.db` beside the
database, from then on (as a move does, without a restart). The file it ran on stays as it was. On Postgres, restore
with Postgres's own tools.

When the latest backup in the folder is another orrery's (one started fresh over a folder of backups, or two sharing a
folder), it's set aside as `orrery-pre-other-<time>.db` rather than written over. Give each orrery its own folder all
the same.

The backups can be set there too, from this machine: **Back up this orrery** turns them off or on, and, outside
Docker, a folder takes them instead of `NUXT_BACKUP_DIR` (**Back up here** makes one there at once, so a folder that
won't take it says so). **How often** backs up a few seconds after a change (as above), or at most once every 15
minutes, hour or day, and then only when something changed. Each backup writes the whole database again, so a folder
that syncs (iCloud Drive) uploads all of it each time: back up less often to upload less. **Daily copies kept**
(14 unless changed, up to 365) is most of what the folder takes on disk. Of the copies taken before an upgrade
migrates the database (`orrery-pre-<version>-step<n>.db`), the three newest stay. Copies kept before a restore and
another orrery's latest set aside are never deleted: remove those yourself once you no longer need them. The choice is
kept beside the database, in `orrery.db.backups.json`. In Docker they always go to `/backup`, whose folder on the machine is `ORRERY_BACKUP`. When `ORRERY_DATABASE` names Postgres, backups are set
only as orrery starts.

### Backing up into Postgres

Either database can be backed up into a Postgres database instead of a folder: App settings → This orrery → Database, **Postgres**
under Back up this orrery, with its URL (**Back up there** backs up into it at once), or `ORRERY_BACKUP_DATABASE` as
orrery starts. It's copied the way a move copies, a minute after a change, and each backup takes the place of the last
in one go, so a backup that fails leaves the one before whole; there are no daily copies. It has to be an empty database
or this orrery's backup from before: orrery marks it as its backup (`backup_of` in its settings) and won't write into
one holding another orrery, or any other tables (it checks before it lays its own down), or into the one it runs on. Its password is kept in `orrery.db.backups.json`, readable by
you alone, and never shown or logged. To restore, run on it: **Move to another database…**, then run on it as it is, or
`ORRERY_DATABASE`.

## Postgres

SQLite suits one machine. To keep the orrery in Postgres instead (a server shared by a team, or a
database you already back up), the simplest way is to pick it when you first open orrery on its machine (localhost).
Before it asks your name, it asks where to keep the data: **On this machine** (SQLite) or **Postgres**, a URL or its
details. orrery checks it's empty and sets it up, or picks up an orrery's own from before, as
[Moving it from the app](#moving-it-from-the-app) does. Or set it as orrery starts, which skips that question: put this
in `.env`:

```sh
COMPOSE_PROFILES=postgres
ORRERY_DATABASE=postgres://orrery:orrery@postgres:5432/orrery
```

and `docker compose up -d`: the `postgres` profile adds a Postgres 17 service, its data in the
`orrery-pg` volume, and orrery waits for it, then lays down its tables. Set `ORRERY_PG_PASSWORD` to
change the bundled database's password (it's only reachable from orrery's container). For a Postgres
of your own, leave out the profile and point `ORRERY_DATABASE` at it.

orrery backs it up to `ORRERY_BACKUP` as a SQLite snapshot (see [Backups](#backups)). For a large database,
or to restore into Postgres as it was, back it up with Postgres's own means as well: `pg_dump` on a
schedule (`docker compose exec postgres pg_dump -U orrery orrery > orrery.sql`), or a managed service's
backups.

### Moving it from the app

App settings → This orrery → Database → **Move to another database…**, on the orrery's own machine (localhost;
in Docker only while `ORRERY_HOST` keeps it to this machine, as it does by default):
pick a SQLite file or Postgres (its URL, or host, port, name, user and password), and orrery checks it first. An
empty one has everything copied in, ids and all; an orrery's own (one you ran on before, or after a reinstall) is
run on as it is. orrery switches at once, no restart, and keeps the choice beside its SQLite file
(`orrery.db.moved.json`, in Docker in the data volume, with the URL's password in it), so it starts on it again.
If it can't save that (a full disk, say), the move fails and orrery stays on the one before, all of it there.
The database it leaves stays as it was: moving back to it runs on it as it was then. A SQLite file named without a
leading `/` goes in the data folder; in Docker only the data volume outlives the container.

When `ORRERY_DATABASE` names Postgres it's set there, and the app can't move it.

### From the command line

To move an orrery between SQLite and Postgres without the app, stop it and copy it across, ids and all, into an empty
one (both ends are brought up to the latest schema first):

```sh
pnpm orrery:copy /path/to/orrery.db postgres://orrery:orrery@localhost:5432/orrery
pnpm orrery:copy postgres://orrery:orrery@localhost:5432/orrery ./orrery.db   # and back
```

The bundled Postgres isn't reachable from the machine, so copy into it with the profile's port opened
for the copy, or into a Postgres of your own.

## Two servers: personal and work

Each orrery is its own server with its own database, so work and personal projects never mix. Run
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

In a checkout you also work on orrery in, build them from a release rather than the folder:
`ORRERY_BUILD_CONTEXT=https://github.com/steffendybvik/orrery.git#main` in each env file, then
`docker compose --env-file … up -d --build` when a release lands on `main`. Try changes in the
[playground](../.playground/README.md) instead.

A repo's channel and hook point at the server its projects are on, by `ORRERY_URL`:
`http://localhost:9010` for a personal repo, `http://localhost:9020` for a work one.

## Reach it from your phone

Compose publishes orrery on `127.0.0.1`, so only this machine can open it. orrery has no accounts:
whoever can reach it can read everything, change it and give your agents instructions (see
[SECURITY.md](../SECURITY.md)). Open it only as far as you need.

**Your own devices only (best).** Put this machine and the phone on a private VPN: a free app on
each that links your own devices, so the phone reaches the machine from anywhere, as if both were
on the same Wi-Fi. It isn't the paid kind that hides your browsing, and several are free for a
handful of devices. Then publish orrery on this machine's address on that VPN, and nowhere else:

```sh
# .env.personal
ORRERY_HOST=100.64.0.7               # this machine's address on the VPN
ORRERY_ALLOWED_HOSTS=mac.my-vpn.net  # only to open it by the VPN's name for the machine
```

`docker compose --env-file .env.personal up -d` again, then open `http://100.64.0.7:9010` (or
`http://mac.my-vpn.net:9010`) on the phone. Nobody else on the Wi-Fi can reach it. The VPN has to
be connected when Docker starts the container, since that's when the address is taken.

**Your Wi-Fi (quickest, nothing to install).** `ORRERY_HOST=0.0.0.0`, then open
`http://<this machine's IP>:9010` on the phone. It only works at home, and anyone else on that
Wi-Fi, guests included, can use orrery too.

Either way, the database is still moved only from this machine: App settings → This orrery → Database refuses a
move from any other address.

## Where each database is

App settings → This orrery → Database shows it for the orrery you're on: the SQLite file, or the Postgres database
(never its password), and its backup folder with when the latest backup was made, with how big each is. One moved
from the app says so. Under Docker it shows where each is on your computer: the folder `ORRERY_DATA` or
`ORRERY_BACKUP` names (a relative one from this folder), or, without one, the Docker volume it's in, which isn't a
folder you can open. The path inside the container (`/data/orrery.db`, `/backup`) is beneath it, in small type.

It's always `/data/orrery.db` in the container, and `/data` is `ORRERY_DATA` when it's set, else the
project's `orrery-data` volume, `<project>_orrery-data`. The project is `COMPOSE_PROJECT_NAME`,
or the folder's name (`orrery`) without one. So a new project name is a new, empty database, and two
env files with the same one (or both without one) share a container and a database: give every
server its own. `docker compose --env-file .env.work down -v` deletes that server's volumes, its
database with them; plain `down` keeps them.

## Without Docker

Node 24.22.1 and pnpm 10.14.0: `pnpm install && pnpm build`, then, in `web/`,

```sh
NUXT_DATABASE=/path/to/orrery.db PORT=9000 node .output/server/index.mjs
```

The database file is made if it isn't there (by default the repo's `.data/orrery.db`, wherever the server starts). A
relative `NUXT_DATABASE` is taken from the folder the server starts in, so give it an absolute one. It can also be a
Postgres URL (`postgres://user:password@host:5432/orrery`): orrery lays down its tables on an empty
database, and backs it up as a SQLite snapshot when `NUXT_BACKUP_DIR` is set. The other settings are
`NUXT_BACKUP_DIR`, `NUXT_BACKUP_DATABASE`, `NUXT_ALLOWED_HOSTS`, `NUXT_SECRET_KEY`, `NUXT_UPDATE_CHECK` and `NUXT_PUBLIC_ENVIRONMENT`.
