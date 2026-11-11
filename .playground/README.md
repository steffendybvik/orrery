# The playground

orrery's dev server with a demo database of its own, to try changes on: `nuxt dev` on this checkout (a saved
file reloads the page), as its own compose project, `orrery-playground`, on http://localhost:9001. Its
database is a SQLite file of its own in `.playground/data`, so it never touches the Orrerys you use, and `reset`
throws it away. For Postgres instead, add `COMPOSE_PROFILES=postgres` and
`ORRERY_DATABASE=postgres://orrery:orrery@postgres:5432/orrery` to `compose.env`: its data goes in the project's
`orrery-pg` volume, which `reset` throws away too.

It runs on the Rust API, which serves the board's data (ORR-1041): the dev image builds it from this checkout, and
the server starts it beside itself on the same database. `play` builds the image each start, so a change in `api/` is
in it. With the API down, the board's requests fail with a 503 that says why, in the log too. The API publishes no
port, and the Nuxt server's is `127.0.0.1` only. A database move from App settings starts the API again on the new
file.

```sh
.playground/play          # start it (building the image, so a change in api/ is in it); an empty database gets the demo
.playground/play reset    # throw the database away and start over with a fresh demo
.playground/play down     # stop it, keeping the database
.playground/play logs     # follow the server, the Rust API inside it included
```

The demo (`seed.mjs`, through the API) is the owner **Skoll**, the wolf who chases the sun, and his brother **Hate**, who chases the moon
(issues to assign him), with three projects:

- **Primes:** a prime-number library, with shipped releases (0.1.0 to 0.3.0), the current one (1.0.0) and a planned
  one (1.1.0), four milestones, sub-issues, a full board with blocked issues, comment threads, starts allowed, two proposals,
  a question waiting in the bell, docs in sections, and schedules, one with a run behind it
- **Primes CLI:** its command line, shipping in Primes' releases, as a monorepo's app would, with an issue waiting on
  the library, a doc and a schedule
- **Graphs:** graph algorithms, with releases of its own, a doc and a schedule

The seed skips a database that has projects, so `.playground/play reset` is how to get a newer demo. New issues go
after the ones already there: `web/e2e/readme` opens `PRM-3` and `how-the-sieve-works` by id.

After a `pnpm-lock.yaml` change, `docker compose --env-file .playground/compose.env restart orrery`. After a
Dockerfile change, `.playground/play` again, as it builds. The settings are in
`compose.env`; `ORRERY_PORT` there moves it.
