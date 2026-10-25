# Changelog

What changed in each release. Versions follow [semver](https://semver.org): the API (`docs/API.md`) and
the database schema are the public surface, and a database always migrates forward on its own.

## Unreleased

- **Starting sessions:** a project can let Orrery start sessions itself, in tmux through a launcher on
  the host, when the owner's work finds nobody listening or the owner starts one from the Sessions tab,
  within limits on how many run and for how long. The launcher installs once as a background service
  (`--install`) and serves every project.
- **Stopping sessions:** the owner can stop any session with the Orrery channel running from its Sessions
  tab, terminal ones too: the channel ends its claude process.
- **Notifications:** the Inbox lists every comment newest first; those waiting on you keep their
  mark among them instead of sitting on top.
- **Signals:** an issue the owner makes urgent (`P0`, created as one or raised to it) goes out to the
  listening sessions on its own, to the session working it first. So does a `P0` proposal once committed,
  or a closed `P0` issue reopened.
- **Sessions:** a `/clear` or a compaction keeps the session and its channel, and the fresh context is
  told which issues it had in progress, so it carries on with them.
- **Fixed:** a proposal keeps the owner's picks when a live update comes in before they approve, and a
  choice an option reveals shows its recommendation ticked, as approving sends it.
- **Fixed:** a cleared session keeps its new id when its channel reports with the old one, can be stopped
  by either, and shows its work under both. A launch that ends before its session connects frees its place
  at once. A signal aimed at one session, or already delivered, no longer starts one. Stop is only offered
  when the channel can end its claude process.

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
