# orrery

## Worktrees

Other sessions share the main checkout, so work in a worktree of your own, under `../orrery-worktrees/` (`git worktree add ../orrery-worktrees/orr-n -b <branch> <base>`). Remove it (`git worktree remove`) once its PR has merged or you've finished with it. `pnpm worktrees` lists what sessions left behind and why any must stay, and `pnpm worktrees --remove` clears what's safe.

## Pull requests

A session's pull request into a release branch (`v1.0.0-rc.*`) merges itself once it's green: open it ready, not as a draft, and run `gh pr merge --auto --squash`, then say so on its issue. A session that runs out of time leaves that set, so it still lands. A red or cancelled check doesn't merge: read what failed, fix it or re-run a cancelled job, and tell the owner on the issue if you can't. A pull request into `main` stays the owner's.

Before opening one, run `pnpm test`, `pnpm typecheck`, `pnpm lint` and only the browser specs the change touches. The whole browser suite belongs to the pull request into `main`, so don't hold a pull request back to run it.

## Roadmap

These lines are for working on orrery with orrery: its own roadmap lives in an orrery, as project `orrery`
(issue ids `ORR-n`), at `$ORRERY_URL` (http://localhost:9000 by default; the repo's `.mcp.json` and hooks
read the same variable, so set it in `.claude/settings.local.json` under `env` when yours runs elsewhere).
Point it at the orrery you use, never the playground (`.playground/play`, :9001): that's a demo, thrown away
with `play reset`.
How to use it: `curl -s $ORRERY_URL/llms-full.txt`. Without an orrery running, skip this section.

- Work from an issue: set it to `in-progress` (assignee `claude`) before starting, comment as it moves, `done` when it ships (`canceled`, with a comment why, when it won't).
- Read the project's docs that the task touches before the code (the `docs` tool lists them with a line each; `q` searches), and fix any that turn out wrong as part of the work.
- Knowledge (decisions, how things work) goes in the project's docs.
- A change to what sets off what (signals, starting or stopping sessions, schedule runs, the event log, their guards) updates the project's `event-flows` doc too.
- A pull request's body links its issue at the orrery's own address, `$ORRERY_URL/p/orrery/issues/ORR-n`, so the owner can jump to it.
- Send `Orrery-Actor: claude` on every write. orrery hands out ids; don't send one.
- With the channel connected, its tools (`issue`, `start_issue`, `comment`, `finish_issue`, …) do all of this without curl.
- When you need the owner to decide or give feedback, ask in a comment on the issue with `"asks": "decision"` (or `"feedback"`), so it waits at the top of their bell until they answer.
