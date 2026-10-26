# The playground

Orrery's dev server with a demo database of its own, to try changes on: `nuxt dev` on this checkout (a saved
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

- **Primes:** a prime-number library with its own releases (1.0.0), two chunks, sub-issues, issues in every
  status, starts allowed, a proposal with choices, a question waiting in the bell, and a doc
- **Primes CLI:** its command line, shipping in Primes' releases, as a monorepo's app would
- **Graphs:** graph algorithms, no releases, just a board

After a `pnpm-lock.yaml` change, `docker compose --env-file .playground/compose.env restart orrery`. After a
Dockerfile change, `docker compose --env-file .playground/compose.env up -d --build`. The settings are in
`compose.env`; `ORRERY_PORT` there moves it.
