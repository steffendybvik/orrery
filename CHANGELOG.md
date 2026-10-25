# Changelog

What changed in each release. Versions follow [semver](https://semver.org): the API (`docs/API.md`) and
the database schema are the public surface, and a database always migrates forward on its own.

## 1.0.0-rc.2 (unreleased)

- **Fixed, a window with a channel per project:** only the channel of the window's own project decides
  whether it's listening and whether Stop can reach it, so the other projects' channels (skipped by
  Claude Code) no longer turn it off. A skipped one that connects first no longer files the window under
  the wrong project.
- **Before and after, on a slider:** in a comment, description or doc, a picture whose alt text starts with
  "Before", followed by one starting with "After", shows as one picture at full width with a handle to
  drag between the two (arrow keys too). The labels open each one full size; anywhere else the Markdown
  is still two pictures.
- **Releases:** a project's Releases tab lists the versions it ships, each with the branch its work
  gathers on, how far its issues are and whether it shipped; an issue's Release says which one it goes out
  in. A release's page links its branch and PRs (once Settings says where the code is) and drafts its
  changelog from its issues. `GET/POST /projects/:project/releases`, `?release=` on issues, and a
  `releases` tool for sessions.
- **Phones:** the header no longer carries a project's page tabs (they ran under the bell); the menu
  opens a full-screen drawer with bigger rows instead.
- **Easier to read:** an issue row says its status once, as a pill, rather than three times; comments
  and notifications read a size below a doc, under their header line; and toolbar buttons stay on one line.
- **Starting sessions on the Sessions tab:** whether Orrery may start a project's sessions, and how
  many at once for how long, moved from its Settings to its Sessions tab, next to Start session.
- **Starting sessions, across restarts:** a session Orrery started keeps counting against the limit, with
  its time left and +30 min, after Orrery restarts; a launcher that dies takes its sessions back when it
  starts again; and Stop goes through the session's channel when no launcher is there to stop it.
- **Fixed, sessions across a `/clear`:** `claude --resume` with a cleared window's old id is a session of
  its own instead of taking that window over. A window whose `claude` pid Orrery can't find (an npm
  install) stays one session across a clear, and the pid is now found for those too. What a session
  worked and was sent moves to its new id, so a restart of Orrery doesn't lose it. The resume brief no
  longer goes missing on a big project or gets cut short, and it says what happened (cleared, compacted
  or resumed).
- **Unseen changes, louder:** a changed issue or doc now tints its row with an accent bar, and its dot is
  bigger; and opening a doc tints the parts that are new or changed since you last read it, with a count
  under its title.
- **Images in issues:** the New issue dialog and an issue's description take pasted, dropped or picked
  images too, as the comment box does.
- **Chunks from the page:** New chunk on the roadmap (and in ⌘K) makes one with a title and summary; on
  a chunk's page the title edits in place, the summary has Edit, and the bin removes it (its issues stay,
  in no chunk).
- **Fixed:** the Connect brief quotes a project's name for the shell, keeps a window's session name to
  letters, digits and dashes, and keeps a name on one line, so a crafted `?name=` or `?session=` can't
  run a command or add to the brief. A new project's id and prefix now match what the store makes.
- **Images in comments:** paste, drop or pick an image in the comment box and it goes in as Markdown;
  it opens full size when clicked. Orrery keeps images in its database (`POST /api/uploads`, for agents
  too), so backups and `orrery:copy` take them along. PNG, JPEG, GIF and WebP, up to 10 MB.
- **Fixed:** egress no longer leaks a secret at the 1 MB cut, scrubs its JSON-escaped, form-encoded and
  Basic-auth forms too, reads no more of an answer than it gives back, answers 502 when one breaks off,
  and escapes the value for the url or JSON body it goes in. A deleted secret's uses go with it. A
  secret's projects are now said to be a guard against slips, not a boundary.
- **Unseen changes:** issues and docs that changed since the owner last opened them carry a quiet accent
  dot and a bolder title, on rows, board cards, the docs list and the project in the sidebar, until
  opened or cleared with Mark seen. The owner's own changes from the page don't count.
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
- **Fixed:** `pnpm orrery:copy` takes secrets and their uses across too.
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
