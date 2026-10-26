# Changelog

What changed in each release. Versions follow [semver](https://semver.org): the API (`docs/API.md`) and
the database schema are the public surface, and a database always migrates forward on its own.

## 1.0.0-rc.4 (2026-10-26)

- **Releases count a sub-issue where it's set:** a sub-issue set for another release than its parent's
  counts toward its own release on the Releases page, and its work comes out of the parent's.
- **A schedule's repeats come once:** when a session catches up, or is still busy, a recurring
  message with the same text reaches it once instead of every copy; the others count as delivered.
- **Start sessions with a scope:** Start session takes several projects (a session each) and, without an
  issue to focus on, what to work through: statuses ticked (Todo and In progress to begin with) and a
  release. The session starts on those issues, most urgent first. `POST …/launches` takes `statuses` and
  `release`; a chunk's focus takes `all` for every chunk, several statuses comma-separated, and `release`.
  `?status=` on the issue list takes several too.
- **One channel server per repo:** a repo's `.mcp.json` needs one Orrery server, not one per project.
  `ORRERY_PROJECTS` lists the projects it serves (`hub,css,pos`, or `*` for every project on the Orrery):
  a tool on an issue finds its project from the id's key, and the others take `project`. The server is
  named after the Orrery (`orrery-<environment>`), and `ORRERY_ID` pins it to that Orrery, whose id
  `GET /api/settings` now says; another Orrery at the address is refused. A session heard on several
  projects shows on each one's Sessions tab (`also`). The Connect page hands out the new entry; a server
  per project (`ORRERY_PROJECT`) works as before.
- **A near miss ticks:** a row's tick takes clicks the row's whole height and a few px either side of
  the box, and a card's a few px around it, so aiming for it no longer opens the issue.

## 1.0.0-rc.3 (2026-10-26)

- **Breaking, the API is snake_case:** every field in requests and responses takes its column's name:
  `created_by`, `created_at`, `updated_at`, `icon_color`, `focus_prompt`, `chunk_prompt`, `shipped_on`,
  `decided_by`, `decided_at`, `decision_note`, `delivered_to`, `sub_issues`, `skip_open`, `next_run`,
  `started_at`, `stops_at`, `last_used`. The pages, the channel's tools and the launcher move with it;
  restart running sessions and launchers after updating, as they still hold the old code. The Orrery's
  own prompt settings migrate on start.
- **Breaking, releases are a project setting:** not every project ships, so a project's `release_mode` is `none`,
  `own` or `shared` (another project's, `releases_from`), under Settings → Releases. New projects have
  none, and no Releases page, until it's turned on. Existing projects with releases, or others drawing on
  them, keep their own. A shared release's page leaves out projects with nothing in it.
- **Rearrange releases:** drag a release on the Releases page (or ⌥↑/⌥↓) to move it; `position` on
  `POST` and `PATCH …/releases/:release` sets where it goes. A new release goes on top, and existing ones
  keep the order they had.
- **Shared releases:** a project can take its releases from another (Settings → Releases, or
  `releases_from`), so a monorepo's apps ship in one release. Their issues are set for it, and its page
  shows each project's issues in a section with its progress; a project drawing on it shows its own part
  and links the whole. `GET …/releases/:release` adds `projects`.
- **Approving a proposal puts it on the roadmap:** no separate Commit. One still in the backlog goes to
  Todo, and one whose work has started or finished keeps its status. It keeps who approved it, the note
  and the picks, and the panel offers Put it up again while it's open. Proposals approved before are
  committed the same way as the database migrates.
- **Team tasks:** an issue links to its tasks on the team's tracker (`external`: `CIR-1567`, or a URL),
  editable under its properties and opening there through App settings → Team tracker
  (`https://linear.app/your-team/issue/{id}`). `?external=` finds the issues linked to a task, and
  `create_issue` and `update_issue` take it.
- **Whose board an issue is on:** every issue has a reference, `orrery-<handle>: DOC-132`, with a Copy
  ref button by its id and `ref` in the API and the `issue` tool, for commit bodies and PR descriptions.
  App settings take the handle (your GitHub login, say); without one it's your id.
- **Many issues at once:** tick issues on any list or board (a row's tick on hover, shift-click for a run,
  `x`, ⌘A for the page, Esc to clear) and a bar changes them together: Approve, Request changes or Reject
  proposals with one note, or set status, priority, assignee, labels, chunk or release, or delete them.
  Each issue goes on its own and the bar lists what was skipped. `PATCH /projects/:project/issues`,
  `POST …/issues/decide` and `DELETE …/issues` take `{ids}`.
- **The version in the sidebar:** its foot says which version the Orrery runs (`v1.0.0-rc.3`), linking to
  that version's changelog, and the dev server adds `· dev`. A release sets it in `web/package.json`.
- **Finished work stays quiet:** a done or canceled issue is never marked as changed, so a comment on one
  lights up no row, no sidebar dot and no Mark seen count.
- **Build from a release:** `ORRERY_BUILD_CONTEXT` builds the image from a ref on GitHub
  (`https://github.com/steffendybvik/orrery.git#main`) instead of this folder, so the Orrerys you use never
  pick up a branch you have checked out to work on.
- **Start a session from anywhere:** a Sessions page lists every project's sessions, and Start session there
  (or the + by the sidebar's Sessions) picks the project, then optionally an open issue for it to focus on
  from the start. Projects that can't start one now say why, with a link to turn starting on.
  `POST …/launches` takes `{issue}`.
- **Fixed:** a session Orrery starts for a project's very first signal now gets that signal: an `after` of 0
  is a catch-up too.

## 1.0.0-rc.2 (2026-10-25)

- **Fixed, the owner's protections:** an agent can no longer change or run the owner's schedules (and
  so send its own message as theirs), or name the owner `claude`; a page can't open a session's stream
  (not even as a picture) to mark it not listening; and a malformed `Origin` is a 403 rather than a 500.
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
