# Contributing

Thanks for looking. Orrery is small and opinionated, so for anything bigger than a fix, open an issue
first and say what you'd change and why; it saves you building something that won't land.

## Running it

[Working on Orrery](docs/development.md) has the details. In short:

```sh
.playground/play   # nuxt dev on http://localhost:9001, with a demo of its own
```

or, without Docker, `pnpm install` and `pnpm dev` (Node 24.22.1, pnpm 10.14.0).

## Before a pull request

- `pnpm test`, `pnpm typecheck` and `pnpm test:e2e` pass (CI runs the first two on every push and pull request, `test:e2e` only on a release tag, and builds the image; a release tag publishes only once they pass)
- A change to the database is a new step at the end of the migrations in `web/server/utils/db.ts` (and Postgres's in `web/server/utils/postgres.ts`); never edit one
- A change to the API updates [docs/API.md](docs/API.md), which is also what agents read
- New behaviour comes with a test where the store or the board rules change

## Style

- Match the code around you: its naming, its comment density, plain words over jargon
- A comment says what something is for or why it's so, not what the next line does
- UI copy is short and in the same voice as the rest of the page

## Commits

`type(scope): what changed`, lowercase and imperative, at most 72 characters:

- **type:** `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore` or `revert`
- **scope:** `orrery` for the app, `repo` for CI, config and tooling

```
fix(orrery): keep a chunk's priority when it's renamed
```

A body only when the why isn't obvious. Pull requests get squashed, so the title is what lands.
