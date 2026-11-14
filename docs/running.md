# Running orrery

In a folder of its own:

```sh
curl -LO https://github.com/steffendybvik/orrery/releases/download/v1.0.0-rc.19/compose.yml
docker compose up -d        # http://localhost:9000
```

That's the published image. On its first start it makes an empty SQLite database in the `orrery-data`
volume, with nothing to set up. The first time you open it, it asks your name: you're its owner,
and what you make no one else can delete. Your `Orrery-Actor` header is that name in lowercase snake
case (`Sköll Fenrisson` is `skoll_fenrisson`); change it in App settings → You. It also asks whether
you're a developer: a no turns **Advanced** off, so Events, Context and Pull requests stay out of the
sidebar (App settings → Advanced turns it back on).

## Updating

1. **Back it up yourself** (see [Backups](#backups)), and keep that copy until you're happy with the new version.
   orrery takes no copy of its own before it upgrades.
2. **Pull the new image**: change the version in `compose.yml`'s `image:`, then
   `docker compose pull && docker compose up -d`. The database moves to the new schema by itself. An older version
   won't open a database a newer one has moved on: it stops and says so. To go back, restore the copy you took: a
   failed upgrade leaves the database as it was, but one that worked can't be undone.
3. **Everything else follows.** Each connected repo's channel and hooks, and the launcher, run on your machine through
   `~/.orrery/bootstrap.mjs`, which fetches what orrery serves (`/channel`) and keeps it in `~/.orrery`. A session gets the
   new channel as it starts, and its hooks within a minute. The launcher restarts itself on the new code of the orrery it was
   installed from (never another on its list, ORR-960) and takes its sessions back, so they go on, and the Sessions page says something only about one too old for this orrery. A session already open keeps its channel until it
   restarts, and the Sessions page marks it. It fetches only from this machine or over https: see
   [what running served code means](../SECURITY.md#the-code-orrery-serves-your-machine).

   **A repo connected before 1.0.0-rc.14** runs them from a checkout (`/path/to/orrery/channel/…`), which keeps working
   and stays as new as that checkout (`git pull`). To switch it, paste the line from **Connect an agent** into a session in
   that repo, and run the launcher's install line from the Sessions page's **Setup** tab once.

## Building from source

For working on orrery, or running a branch. `docker-compose.yml` builds the image instead of pulling it. Name it when
there's a `compose.yml` beside it, which Compose would use first:

```sh
docker compose -f docker-compose.yml up -d --build
```

To update, `git pull` in this folder (or nothing, when `ORRERY_BUILD_CONTEXT` names a branch on GitHub), then run it
again.

## Settings

All optional, in a `.env` beside `docker-compose.yml` (see `.env.example`):

| Variable | What it does | Default |
|---|---|---|
| `ORRERY_PORT` | the port on this machine | `9000` |
| `ORRERY_HOST` | who can reach the sessions' address: anything but loopback asks for a login, once [claimed](#claiming-it-and-logging-in). A phone has a port of its own: see [Reach it from your phone](#reach-it-from-your-phone) | `127.0.0.1` |
| `ORRERY_AUTH` | `on` always asks for a login; `off` never, on loopback only, for trying people out; unset, see [Logging in](#claiming-it-and-logging-in) | unset |
| `ORRERY_OIDC_ISSUER`, `ORRERY_OIDC_CLIENT_ID`, `ORRERY_OIDC_CLIENT_SECRET` | any standard OIDC provider to log in through | unset |
| `ORRERY_DATA` | a folder for the database, `orrery.db` (with its `-wal` and `-shm` files beside it); on Linux it must be writable by uid 1000, the image's `node` user. Not a synced folder: syncing a live SQLite file corrupts it | the `orrery-data` volume |
| `ORRERY_PHONE_PORT` | the phone's own port, which always asks for a login (see [Reach it from your phone](#reach-it-from-your-phone)) | `1` before `ORRERY_PORT`: `19000` |
| `ORRERY_PHONE_HOST` | who can reach the phone's port: `127.0.0.1` keeps it to this machine | `0.0.0.0` |
| `ORRERY_PHONE_URL` | the address to open it at from a phone, for App settings' link and QR code, when it's one orrery can't see for itself: an https name, a VPN's (see [Reach it from your phone](#reach-it-from-your-phone)) | none |
| `ORRERY_USAGE` | `off` stops anyone counting feature use on this server, whatever App settings → Usage says (ORR-881) | none |
| `ORRERY_ALLOWED_HOSTS` | host names it answers to besides `localhost`, IP addresses and a `<name>.local`, comma-separated, e.g. `orrery.lan` (see [SECURITY.md](../SECURITY.md)) | none |
| `ORRERY_ALLOWED_ORIGINS` | other sites whose pages may use the API from a browser, for orrery's page hosted there: exact origins, comma-separated, e.g. `https://app.example.com` (see [Hosting the page on its own](#hosting-the-page-on-its-own)) | none |
| `ORRERY_PAGES` | `off` serves the API alone, without the pages (see [Hosting the page on its own](#hosting-the-page-on-its-own)) | the pages are served |
| `ORRERY_DATABASE` | a `postgres://` URL to keep the orrery in Postgres instead (see [Postgres](#postgres)) | the SQLite file |
| `ORRERY_SECRET_KEY` | encrypts the [secrets](API.md#secrets) your agents use without seeing: a long random string (`openssl rand -base64 32`). Keep it apart from your copies of the database; without the same key, secrets set with it won't open | made on first start, kept in `orrery.key` beside the database (`/data` in Docker; none outside Docker on Postgres, so set it there) |
| `ORRERY_BUILD_CONTEXT` | what the image is built from: a ref on GitHub, e.g. `https://github.com/steffendybvik/orrery.git#main`, so a branch switched in this folder never ends up in it | this folder |
| `ORRERY_UPDATE_CHECK` | `false` stops orrery asking GitHub for its own releases (at start, then every 12 hours), which it does to show a notice above the version in the sidebar when a newer one is out. A pre-release is offered only to an orrery running one | on |
| `ORRERY_REPO_DIR` | the folder a relative `ORRERY_DATA` is under, when `compose.yml` runs from another one | the folder orrery starts in |
| `ORRERY_ENVIRONMENT` | this orrery's name when you run more than one, e.g. `work`: a chip by its name, and the start of every tab's title | `personal` |

## A GitHub token

orrery reads each project's pull requests off GitHub (the Pull requests page, an issue's PRs, and the comments it
leaves when one conflicts, fails or merges). A public repo works without a token, but only its list, every ten
minutes. With a token, a private repo works too, and orrery reads where each pull request stands every minute.

1. On GitHub, [make a fine-grained token](https://github.com/settings/personal-access-tokens/new) with
   *Pull requests: Read-only* on the repos your projects point at (a classic token needs `repo`). The Branches view
   also needs *Contents: Read-only* to read them, and *Contents: Read and write* to remove one from the page.
2. In **App settings → This orrery → Secrets**, `GITHUB_TOKEN` is listed as *Not set*. Press **Set** and paste the
   token: its name and its host, `api.github.com`, are filled in.

orrery polls straight away. The row then shows when it was last used, or that GitHub turned it down. A token saved
some other way is only used when its hosts include `api.github.com`; the Pull requests page says so when they don't.

## Backups

orrery takes no backups: backing the database up is up to whoever runs it. On SQLite, stop orrery
(`docker compose stop`) and copy `orrery.db` with its `-wal` and `-shm` files, from `ORRERY_DATA` or, in the default
volume, with `docker compose cp orrery:/data/orrery.db ./orrery-copy.db`; or take a copy while it runs with SQLite's own
`sqlite3 orrery.db ".backup orrery-copy.db"`. Never put the live file in a folder that syncs: a synced SQLite file gets
corrupted. On Postgres, use its own means: `pg_dump` on a
schedule (`docker compose exec postgres pg_dump -U orrery orrery > orrery.sql`), or a managed service's backups.

To restore, stop orrery, put the copy where the database was (or point `ORRERY_DATABASE` at it), and start it again.
Keep `orrery.key` (or `ORRERY_SECRET_KEY`) apart from the copies: without it, the secrets in them won't open.

## Postgres

SQLite suits one machine. To keep the orrery in Postgres instead (a server shared by a team, or a
database you already back up), set it as orrery starts: the app has no setting for which database it runs on. Put this
in `.env`:

```sh
COMPOSE_PROFILES=postgres
ORRERY_DATABASE=postgres://orrery:orrery@postgres:5432/orrery
```

and `docker compose up -d`: the `postgres` profile adds a Postgres 17 service, its data in the
`orrery-pg` volume, and orrery waits for it, then lays down its tables. Set `ORRERY_PG_PASSWORD` to
change the bundled database's password (it's only reachable from orrery's container). For a Postgres
of your own, leave out the profile and point `ORRERY_DATABASE` at it.

Back it up with Postgres's own means (see [Backups](#backups)).

### Moving from SQLite to Postgres

To move an orrery between SQLite and Postgres, stop it and copy it across, ids and all, into an empty
one (both ends are brought up to the latest schema first):

```sh
pnpm orrery:copy /path/to/orrery.db postgres://orrery:orrery@localhost:5432/orrery
pnpm orrery:copy postgres://orrery:orrery@localhost:5432/orrery ./orrery.db   # and back
```

The bundled Postgres isn't reachable from the machine, so copy into it with the profile's port opened
for the copy, or into a Postgres of your own. Then set `ORRERY_DATABASE` to it and start orrery again.

## Two servers: personal and work

Each orrery is its own server with its own database, so work and personal projects never mix. Run
each as its own compose project with its own env file:

```sh
# .env.personal
COMPOSE_PROJECT_NAME=orrery-personal
ORRERY_ENVIRONMENT=personal
ORRERY_PORT=9010
```

```sh
# .env.work
COMPOSE_PROJECT_NAME=orrery-work
ORRERY_ENVIRONMENT=work
ORRERY_PORT=9020
```

```sh
docker compose --env-file .env.personal up -d --build   # http://localhost:9010, chip: personal
docker compose --env-file .env.work up -d --build       # http://localhost:9020, chip: work
```

The project name keeps them apart: each gets its own volumes (`orrery-personal_orrery-data`,
`orrery-work_orrery-data`), container and port, so stopping, rebuilding or wiping one leaves the
other alone (`docker compose --env-file .env.work down`). Env files other than `.env.example` are git-ignored.

In a checkout you also work on orrery in, build them from a release rather than the folder:
`ORRERY_BUILD_CONTEXT=https://github.com/steffendybvik/orrery.git#main` in each env file, then
`docker compose --env-file … up -d --build` when a release lands on `main`. Try changes in the
[playground](../.playground/README.md) instead.

A repo's channel and hook point at the server its projects are on, by `ORRERY_URL`:
`http://localhost:9010` for a personal repo, `http://localhost:9020` for a work one.

## Claiming it and logging in

On your own machine, alone, none of this applies: it opens straight to the board. Login comes on when the server is reachable from
other machines, with a plain `docker run`, or when you add a second person ([what exactly](../SECURITY.md#login-and-keys)). Until it's been
claimed, such a server answers nothing but its login page. A phone needs none of this: it has a port of its own (see
[Reach it from your phone](#reach-it-from-your-phone)).

Claim it from a shell on the server, for a hosted box, or to replace a lost key:

```sh
pnpm orrery:claim --name "Your Name"                                      # from a checkout: its own .data database, not a container's
docker compose exec orrery node /app/server/claim.mjs --name "Your Name"  # in Docker
```

`--name` is only needed before you've given orrery your name. It prints your person key once: sign in with it on the page. On a server
already claimed it refuses, unless given `--replace`, which revokes your person keys and ends the logins they started, for when you've lost yours.

**Sessions.** On a server others reach, each machine's sessions need an agent key: make one under App settings → You → Your keys: it comes with a line
to run in a terminal there that adds it to `~/.config/orrery/keys.json` (mode 0600) for this address, as `{"https://orrery.example": "orrery_agent_…"}`.
The launcher needs the file: it runs as a service with nothing from your shell but `PATH`, so it and the sessions it starts find a key only there.
`ORRERY_KEY` where you start Claude Code does for sessions you start from a terminal, but it goes to any server that machine talks to.
Never commit a key in `.mcp.json`. A person key won't work there: the channel refuses to start with one.

**Other people.** Claim it first, then add them (App settings → This orrery → People, or `POST /api/people`, refused before that unless `ORRERY_AUTH=off`) and put them on a board
(its Settings → Members, or `POST /api/projects/<project>/members`). Then either invite them through a login provider (`POST /api/invites`, a link good once and for a week), or, with
no provider, give them a person key (`POST /api/keys` with `kind: "person"`, `name` and `person`). To try people out on one machine with no logins, start orrery with `ORRERY_AUTH=off`, loopback only.

**With more than one person,** an issue's page shows who holds it, for how long and which session is on it, with **Claim**, **Let go** and, for the owner, **Take over**, each in its activity, and a list and a board show the holder. A person's agents only take up what's assigned to them, and their comments, focuses and Todo moves reach only their own sessions. **Work unassigned on a board with more than one person isn't handed to anyone** until someone takes it. The bell and My issues are each person's own. With `ORRERY_AUTH=off`, the sidebar's **Acting as** picks who this browser is, remembered here: it's a name, not a login, and anyone who can reach orrery can say they're anyone.

**A login provider** is any standard OIDC one: set the three `ORRERY_OIDC_…` settings, with `<orrery>/api/auth/oidc/callback` as its redirect address. orrery sends its client secret as HTTP Basic (`client_secret_basic`), or in the request's body for a provider whose discovery offers only `client_secret_post`. Its address has to be https unless it's on this machine. orrery asks it for `openid profile`, so allow both scopes for its client. **On a new orrery, the first person to sign in becomes its owner**, named as the provider names them, with no claim step, and the login page then shows only the provider's button. Everyone after that needs an invite from the owner, so sign in yourself before you share the address.

**If the provider's address changes,** move the logins, and nobody needs a new invite:

```sh
pnpm orrery:claim --move-issuer https://old.example https://new.example                                      # from a checkout
docker compose exec orrery node /app/server/claim.mjs --move-issuer https://old.example https://new.example  # in Docker
```

Then set `ORRERY_OIDC_ISSUER` to the new address and restart orrery. It's only for the same provider at a new address. **For a different provider, don't:** its accounts can have the same subjects as someone else's on the old one, so a stranger could log in as that person. Just change the setting and invite everyone again. Keys carry on working either way.

## Reach it from your phone

**Scan the QR code in App settings → You → Open on your phone** (also ⌘K → *Open on your phone*, and Getting started's
last step) with the phone's camera, and you're signed in. Nothing
to claim, type or run, and nothing runs on the phone: it opens the orrery on this machine, so the chat, the sessions and
Allow there all work on this machine's Claude sessions.

orrery listens twice. `ORRERY_PORT` on `127.0.0.1` is the sessions' address, as before: trusted, with no keys. The
phone's own port (`ORRERY_PHONE_PORT`, `19000`, or `19010` for an `ORRERY_PORT` of `9010`, so two orrerys on one
machine don't clash) is published on every address and **always asks for a login**, whatever the other does. orrery
tells them apart by the port a request came in on inside it, never by who sent it, as in Docker every caller looks the same.

The QR code carries a one-time sign-in link to the phone's port: good once, for 5 minutes, and a new one shows as it
runs out. Opened, it signs the phone in as you, with a login of its own, listed under App settings → You → Signed in.
Lost the phone? Press **End** beside it there, or **End every other login**, and it has to sign in again. The address
alone, without the link, asks for a login. Only your own page on this machine makes a link: never a session, the chat,
or anything on the phone's port. Over the phone's port nothing counts as this machine, so moving the database and the
like are refused there.

The address is this machine's on its networks: in Docker, where orrery sees only its container's, the launcher on
this machine tells it (a VM's or Docker's own networks are left out). On a Mac its Bonjour name comes first,
`http://<name>.local:<port>` (its LocalHostName, under System Settings → General → Sharing → Local hostname): short
enough to type, and it keeps working when the Mac's IP changes. iPhones find it with no setup; an older Android may not,
so its IPs are listed under it. Set `ORRERY_PHONE_URL` for one orrery can't see
for itself, such as an https name in front of it; it's shown first. `ORRERY_PHONE_HOST=127.0.0.1` keeps the phone's
port to this machine.

**On the Wi-Fi** it only works at home, and it's plain http, so the link and the login's cookie travel unencrypted, and
anyone else on the Wi-Fi could read them. App settings says so beside the code. **Away from home**, host orrery on a
server behind https, claimed from its shell ([above](#claiming-it-and-logging-in)): it answers while this machine sleeps.

## Hosting the page on its own

orrery serves its page and its API together, and that's the way to run it. The page can also be built on its own, as
static files, and hosted apart from the server it uses (ORR-667). It's the same server and image either way.

**Build the page** for the server it's to use, from a checkout. The address is built in:

```sh
NUXT_PUBLIC_API_BASES='{"/": "https://orrery.example.com/api"}' pnpm --dir web exec nuxt generate
```

That leaves the page in `web/.output/public`. Host it as a single-page app: any address that isn't a file gets `200.html`.

**Set the server** to let that page in, and, if you like, to serve its API alone:

```sh
ORRERY_ALLOWED_ORIGINS=https://app.example.com   # the page's origin, exactly: scheme, host and port
ORRERY_PAGES=off                                  # optional: no pages here, only /api, /channel, /connect, /llms* and /healthz
```

**Keep both on one site,** such as `app.example.com` and `orrery.example.com`. The login's cookie is `SameSite=Lax`, so a
browser only sends it to the server from a page on the same site. A page on another site would load, but couldn't sign in.

What changes, and what doesn't:
- **Signing in** is on the page as usual. With a provider, give it the server's callback, `https://orrery.example.com/api/auth/oidc/callback`,
  and it returns to the page's origin when that's listed.
- **The addresses it shows** for sessions, the launcher and keys (Connect, Sessions, Your keys) are the server's, not the page's.
- **A new server version** doesn't reload the page, as the page is a build of its own. Rebuild it with each update of the server.
- **The page's own headers** come from where it's hosted. Give it a `Content-Security-Policy` like the server's, with
  the server added to `img-src` for uploads.
- **The things kept to the server's own machine** still are.

Only exact origins are allowed: no wildcards, and never `null`. Each one listed can read and write the board of
whoever is signed in there, and so instruct their agents ([SECURITY.md](../SECURITY.md)).

## Where each database is

It's always `/data/orrery.db` in the container, and `/data` is `ORRERY_DATA` when it's set, else the
project's `orrery-data` volume, `<project>_orrery-data`. The project is `COMPOSE_PROJECT_NAME`,
or the folder's name (`orrery`) without one. So a new project name is a new, empty database, and two
env files with the same one (or both without one) share a container and a database: give every
server its own. `docker compose --env-file .env.work down -v` deletes that server's volumes, its
database with them; plain `down` keeps them.

## Without Docker

Node 24.22.1, pnpm 10.14.0 and Rust 1.88 or later: `pnpm install && pnpm build`, and `cargo build --release` in
`api/`. Then, in `web/`,

```sh
NUXT_DATABASE=/path/to/orrery.db NUXT_API_BIN=../api/target/release/orrery-api PORT=9000 node .output/server/index.mjs
```

`NUXT_API_BIN` is the Rust API, which serves the board's data: the server starts it beside itself, on the same
database, and stops it with itself. Without it, the board doesn't load (its requests answer 503). The Docker image
has it built in.

The database file is made if it isn't there (by default the repo's `.data/orrery.db`, wherever the server starts). A
relative `NUXT_DATABASE` is taken from the folder the server starts in, so give it an absolute one. It can also be a
Postgres URL (`postgres://user:password@host:5432/orrery`): orrery lays down its tables on an empty
database. The other settings are `NUXT_ALLOWED_HOSTS`, `NUXT_ALLOWED_ORIGINS`, `NUXT_PAGES`, `NUXT_USAGE`, `NUXT_SECRET_KEY`, `NUXT_UPDATE_CHECK`, `NUXT_AUTH`, `NUXT_OIDC_ISSUER`, `NUXT_OIDC_CLIENT_ID`, `NUXT_OIDC_CLIENT_SECRET` and `NUXT_PUBLIC_ENVIRONMENT`.
