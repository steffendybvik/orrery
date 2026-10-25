# Changelog

What changed in each release. Versions follow [semver](https://semver.org): the API (`docs/API.md`) and
the database schema are the public surface, and a database always migrates forward on its own.

## Unreleased

- **Starting sessions:** a project can let Orrery start sessions itself, in tmux through a launcher on
  the host, when the owner's work finds nobody listening, within limits on how many run and for how long.

## 1.0.0 (unreleased)

The first public release.

- **Boards:** projects with issues and sub-issues to any depth, grouped into chunks, as a list or a
  board, with search and filters. **Now** and **My issues** span every project.
- **Statuses:** one list for the whole Orrery (Backlog, Todo, In progress, In review, Done, Canceled),
  each of a kind Orrery reasons about. Add, rename, recolour, reorder or remove them in App settings.
- **Activity:** every issue keeps who changed what and when (status, priority, assignee, labels,
  chunk, title, description, proposal decisions), shown between its comments.
- **For agents:** MCP tools in every connected session (read, start, comment on and finish issues, write docs), a JSON API, `/llms.txt` and `/llms-full.txt`, proposals the owner approves, and
  comments that ask the owner for a decision or feedback and wait at the top of the bell.
- **Steering sessions:** Orrery's channel (a Claude Code research preview) brings "focus on this issue",
  "work through this chunk" or "work through its Todo issues" to a listening session, and hooks show
  which sessions are working, idle or waiting.
- **What sessions hear:** the owner edits the focus message as a template, for the Orrery or a project,
  and adds standing instructions ("commit whenever a piece works") to tick on or off per send.
- **Docs, schedules and more:** Markdown docs per project, schedules that make issues or message the
  sessions on a cron, a ⌘K command palette and keyboard navigation.
- **Running it:** one Docker container with a SQLite database and automatic backups, local only by
  default, several Orrerys side by side.
