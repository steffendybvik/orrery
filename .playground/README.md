# The playground

orrery's dev server with a demo database of its own, to try changes on: `nuxt dev` on this checkout (a saved
file reloads the page), as its own compose project, `orrery-playground`, on http://localhost:9001. Its
database is a file in `.playground/data`, so it never touches the Orrerys you use, and throwing it away is
deleting a folder.

```sh
.playground/play          # start it; an empty database gets the demo
.playground/play reset    # throw the database away and start over with a fresh demo
.playground/play down     # stop it, keeping the database
.playground/play logs     # follow the server
```

The demo (`seed.mjs`, through the API) is the owner **Skoll**, the wolf who chases the sun, and his brother **Hate**, who chases the moon
(issues to assign him), with three projects:

- **Primes:** a prime-number library, with shipped releases (0.1.0 to 0.3.0), the current one (1.0.0) and a planned
  one (1.1.0), four chunks, sub-issues, a full board with blocked issues, comment threads, starts allowed, two proposals,
  a question waiting in the bell, docs in sections, and schedules, one with a run behind it
- **Primes CLI:** its command line, shipping in Primes' releases, as a monorepo's app would, with an issue waiting on
  the library, a doc and a schedule
- **Graphs:** graph algorithms, with releases of its own, a doc and a schedule

The seed skips a database that has projects, so `.playground/play reset` is how to get a newer demo. New issues go
after the ones already there: `web/e2e/readme` opens `PRM-3` and `how-the-sieve-works` by id.

After a `pnpm-lock.yaml` change, `docker compose --env-file .playground/compose.env restart orrery`. After a
Dockerfile change, `docker compose --env-file .playground/compose.env up -d --build`. The settings are in
`compose.env`; `ORRERY_PORT` there moves it.
