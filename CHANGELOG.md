# Changelog

What changed in each release. Versions follow [semver](https://semver.org): the API (`docs/API.md`) and
the database schema are the public surface, and a database always migrates forward on its own.

## 1.0.0-rc.6 (2026-10-27)

- **A focus goes to one session:** a focus, a chunk's or a schedule's message aimed at no session goes to one
  session, not every one: the session already on the issue, else an idle one, else the next to go idle (within a
  day). The issue and chunk menus offer *Ask all N sessions* beside *Ask a session*; through the API it's
  `{session: "*"}`. Comments keep their route: the session on the issue, else every session.
- **One stream per session:** a channel on several projects follows them all on one stream,
  `GET /api/signals/stream?projects=hub,css` (or `*`, which picks up projects made later too), so it registers
  once and marks a signal delivered once. On an older Orrery it falls back to a stream per project.
- **The session limit is a total:** "At most N" counts every session Orrery started or is starting, whatever the
  project; `GET …/launches` adds `total`. **Breaking:** it used to be per project.
- **One Sessions page:** Start session lands on `/sessions`, and the Sessions page has no project picker any more.
  `?project=` and the `/p/:project/sessions` tab are gone; a sidebar row links to `/sessions#session-<id>`.
- **Schedules by project:** each project's schedules sit in a card headed by the project (icon, name, running or
  paused, its own New schedule), and each row says whether it makes an issue or messages sessions, with the first
  line of its notes.

## 1.0.0-rc.5 (2026-10-26)

- **Find the issue to focus on as you type:** Start session's issue and release are the picker the issue page
  uses: type part of an id or title, ↑↓ and ↵ to pick.
- **A run carries on after a clear:** a session Orrery started and then cleared partway through a chunk or
  scope gets a focus on what's left, to it alone, so it carries on instead of waiting. A focus on one issue
  ends the run it was on. A session that won't take any of what's left (blocked, or waiting on the owner) is
  sent it again only when something in it changes, not every few seconds.
- **Faster first load:** each Heroicon loads when it's shown, and each dialog the first time it opens, so a
  page's first load is about a third smaller (510 KB of JS to 340 KB).
- **Watch a started session live:** a session Orrery started shows its screen on the Sessions page, refreshed
  while you look (read-only; its launcher captures the tmux pane).
- **Last sent keeps up:** a session's card on the Sessions page shows a message you just sent it.
- **Session settings on the Sessions page:** Starting sessions, What sessions hear and Presets moved there from
  App settings, beside the sessions they're about, with a contents list on a wide screen.
- **The restart command loads the channel:** the "can't hear signals" command named the server
  `server:<project>`; it names it as the channel reports it's called (`?server=` on the stream, `server` on a
  session), else `orrery-<environment>`, as Connect does.
- **The channel knows it's a channel:** it looks for its Claude Code log under the name Connect gives it, so with an
  environment such as `Work` or `my laptop` it no longer reports `unknown`, and reads the newest log across its
  own names, so a stale one under an old name doesn't hide the current one.
- **A session on several projects is listed once:** the sidebar and the Sessions page show it under its own
  project (the one its hooks name), saying which others it's also on; filtered to one of those, it's still found.
- **Feature freeze:** a release can have a freeze day (`frozen_on`, Freeze features / Thaw on its page). From
  then on it shows "Frozen <day>", its pickers say "· frozen", and a focus on its work tells the session to put a
  new feature on the next release. Nothing is refused. A new migration step adds the column.
- **A focus doesn't take a started issue:** a focus aimed at one session no longer moves an issue another
  listening session has started; the session asked gets the claim's 409 if it tries to start it.
- **Old status words in a focus:** a chunk focus with `doing` or `now` keeps to the issues it means; it matched none.
- **Smaller fixes:** a preset whose name or text is only spaces is refused, not saved empty. Start session's
  preview with only a release picked shows Todo and In progress, as the server sends. A receipt that couldn't be
  saved answers 409 instead of reporting it saved. A starts limit typed just after ticking the box isn't undone by
  the live update.
- **Tick many at once:** drag over the ticks to tick (or untick) a run, tick a whole list group or board column
  from its header, and the bulk bar says how. A drag let go outside the window ends there.
- **Docs A–Z:** a project's docs are listed by title on the Docs page and in `GET …/docs` (and the `docs` tool),
  not in the order they were made.
- **A second launcher leaves the first one's sessions alone:** each session keeps its launcher's pid, so a launcher
  run next to the service no longer takes its sessions over and stops them when it exits. A session is taken back
  only from a launcher that's gone (a reused pid doesn't count), and of two launchers starting together only one
  adopts it.
- **A launcher serves every channel in a repo:** a monorepo whose `.mcp.json` has a channel per project
  (`orrery-hub`, `orrery-css`, …) installs all of them with one `--install`, each project's sessions load the
  channel that serves it, and each on its own channel's Orrery. `--install --list` shows what a repo would register.
  A project `ORRERY_PROJECT` names but no channel lists goes on `ORRERY_URL`, else the first channel's Orrery.
- **Getting started:** a new Orrery opens on a checklist that ticks itself as it happens: a project, a folder
  connected (any folder, an empty one to try it), a session listening, work sent. *Just planning? You're set*
  finishes it after the project. *Try it with a demo project* makes a sample board to look around
  first. Until it's done it's a card at the top of Now; **Hide** puts it away, and ⌘K → *Getting started* brings it
  back (`/getting-started`).
- **The quick start lists everything it needs:** Node 24 and pnpm for the channel, hooks and launcher, which run
  from the clone outside Docker, and tmux only for starting sessions.
- **One set of UI components:** buttons, dialogs, menus and confirmations come from a small kit
  (`components/ui/`), listed with the other shared pieces in [docs/components.md](docs/components.md). Disabled
  buttons, quiet icon buttons and the red remove buttons now look the same everywhere.
- **Pickers in New issue and the schedule dialog:** Where, Priority, Chunk and the schedule's Repeats are the
  picker the issue page uses, with the status and priority icons: type to narrow, ↑↓ and ↵ to pick.
- **Cleanup:** one text field style, one way menus close on an outside press, and the store split into a file per
  domain behind the same `Store`. [docs/development.md](docs/development.md) maps where things live now.
- **More e2e:** the flows cover starting sessions, the Sessions page and messaging a session, Focus on this
  starting one, presets, schedules, the bell, Now, My issues, Connect, Getting started and a session on two projects (27 flows, from 18). In CI
  they run in Playwright's own image, rather than installing the browser's system libraries on every run.
- **Dependencies:** `pg` 8.23, `marked` 18.1.1, `dompurify` 3.4.17 and `@playwright/test` 1.64, and the GitHub
  Actions at their current majors.

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
- **Sessions and schedules across projects in the sidebar:** under Connect an agent, Sessions opens every
  project's sessions, and Schedules a new page with every project's schedules in one agenda, each saying
  its project; a new one is made in the project picked.
  Start session and New schedule sit on a toolbar on those pages.
- **Edit and delete your own comments:** the owner's comments on an issue page have Edit and Delete. An edit
  that changes the words goes to the session on the issue again, saying it replaces the earlier comment.
- **Signals don't slip through a reconnect:** a session's stream hears live signals before reading what it
  missed, so one sent in between arrives once; sessions acking a signal at the same time all count; a failed
  re-read of a project no longer clears it from the page.
- **Your own context for a session:** Start session takes presets (a saved name and text, the Orrery's and
  each project's own, under App settings and project Settings) and your own words. They go with every
  signal to the session and come back in its SessionStart brief, as it starts and after a `/clear` or a
  compaction. `/api/presets` and `/api/projects/:project/presets`; `POST …/launches` takes `presets` and
  `instructions`.
- **Started sessions run until stopped:** a session Orrery starts runs until stopped unless a time is set, and a new idle limit (`starts.idle_minutes`) stops one that sits with nothing to do. Neither stops a
  session mid-work: Orrery waits until it's idle with nothing in progress or waiting, then has its launcher
  stop it. `started.stops_at` and a launch's `minutes` are optional. One still not done well past its time
  (stuck on a prompt, or never going idle) is stopped anyway, its minutes again past it (15 minutes to an hour).
- **A fresh context between pieces of work:** once a session Orrery started goes idle with nothing in
  progress and no signal waiting, its launcher types `/clear` into it, and the brief after hands it what's
  left of the chunk or scope it was working through.
- **One session per issue:** starting an issue another listening session holds gets a 409 naming that
  session, so sessions answering the same nudge no longer take the same issue.
- **A session hears about the issues it makes:** an issue a session creates (a proposal included) or moves
  to another project is linked to it, so the owner's decision on it reaches that session.
- **Ids keep their meaning:** a replacing import continues the issue and chunk counters, signals move with an
  issue to its new id, and a new issue skips numbers still in use as aliases.
- **A new issue opens straight away:** its page loads the project before saying "No issue", and a live
  stream the browser gave up on is opened again.
- **PRs link their issue:** the channel's instructions, `/llms.txt` and the API reference ask agents to put the
  issue's page on the owner's Orrery in the PRs they write.
- **Smaller fixes:** `docs/API.md` lists every live event; built-in names (`constructor`) are refused as body
  fields; renaming the owner tells open pages; settings, statuses, secrets and schedules changes are backed
  up; a bad escape in an address gives a 404.
- **Breaking, starting sessions is one setting:** you let Orrery start sessions once, for every project, under
  App settings → Starting sessions, with its limits (at once on each project, minutes, idle minutes). `PATCH
  /settings {starts}` sets it; `PATCH /projects/:project` no longer takes `starts` (a 400), and a project's
  `starts` reads the Orrery's. The database carries over the first project's setting. A project gets sessions
  wherever its repo has a launcher.
- **Watch opens a terminal:** Watch on a session Orrery started has its launcher open a terminal window attached
  to it, in the app picked under App settings → Watching sessions (Terminal, iTerm2, Warp or Ghostty on macOS).
- **One session per issue, even at once:** two sessions starting the same issue at the same moment are taken one
  after the other, so only the first gets it and the other gets the 409.
- **Egress keeps a whole-address secret whole:** a `{{secret:…}}` that starts the url (a webhook) goes in as it
  is, one in the path keeps its `/`, and one in the query is escaped; the hosts check still decides where it may go.
- **Smaller review fixes:** the doc texts kept for change tints are capped, an image upload finishing after its
  field was reopened stays out of it, a chunk's remove prompt resets on another chunk, an oversized upload is
  refused before it's read, and a slow doc reply for a page you've left is let go.
- **Sessions and Schedules in one place each:** a project's Sessions and Schedules tabs are gone. The Sessions
  page shows every session as a full card (Watch, Stop, +30 min, what it's on and was last sent), each project's
  Start session and launcher state, and the setup guide; both pages keep to one project with `?project=`, and
  the old tab addresses go there.
- **Message one session:** a listening session's card takes a message, which goes through its channel to it
  alone. `POST /projects/:project/sessions/:session/message {text}`.
- **Focus on this starts a session:** with nobody listening, when Orrery may start sessions and a launcher is
  there, the issue page offers Focus on this (starts a session), and a chunk Work through this.

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
