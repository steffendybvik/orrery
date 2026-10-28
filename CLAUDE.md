# orrery

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
