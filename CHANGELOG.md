# Changelog

What changed in each release. Versions follow [semver](https://semver.org): the API (`docs/API.md`) and
the database schema are the public surface, and a database always migrates forward on its own.

## 1.0.0-rc.9 (2026-10-28)

- **Schedules that run when something happens:** a schedule can run `on` an event instead of a clock: an issue
  moving to In review, a release frozen or shipped, a new error, or anything else orrery records, narrowed by
  `on_filter`. The dialog's When is Time or Event. One schedule's failed run is heard by the others, but an outcome
  never sets off another outcome.
- **Schedules that start sessions:** a schedule can start a session with presets, on a clock or an event, and a
  message schedule can send presets, so a preset like Release is written once and runs by itself.
- **Suggested schedules:** Schedules offers a ready-made event schedule for each preset orrery ships (Release and
  Security audit when a release is frozen, a nudge to get the next release going when one ships, Review when an issue
  moves to In review, Debug an error on a new error). **Add** opens New schedule filled in; none runs until you save it.
- **Run now instead:** a schedule's menu has *Run now instead of 09:00*, which runs it now and skips its next run.
- **Untrusted schedules get a locked-down session:** a schedule that brings in what others wrote (the daily
  GitHub-issues review) gets a session of its own for each run, and whatever that session raises becomes a proposal
  for the owner. It stays locked down after a restart, since the session itself says it's untrusted on every
  write, and its writes set off no event schedules.
- **An event log:** orrery keeps a log on the machine of what it did and what went wrong, never sent anywhere.
  Errors are always recorded (`server.error`, `page.error`, a failed schedule or backup), and so is each change to
  the roadmap, a line of its own: who made, moved or commented on which issue, doc, chunk or release. Everything else
  (sessions, launchers, schedule runs, backups) is recorded while **Advanced** is on. Advanced also shows an Events
  page, read like a console with **Resolve** on errors, and counts each new kind of error in the bell. Refused
  requests are logged as warnings, and channels joining and leaving, egress calls, and secret and settings changes
  (never a value) are logged too. The page filters by level and by kind (`issue.*`, or `issue.status`, kept in the
  URL), and the issue ids in its lines link to the issues. Sessions read the log with the channel's `events` and
  `resolve_event` tools.
- **Move to another database:** App settings → Database has **Move to another database…**. Pick a SQLite file or
  Postgres, check it, then copy everything into an empty one or run on another orrery's own as it is. orrery switches
  with no restart, keeps the choice for its next start, and saves it before writing to the new one, so a failed
  save changes nothing. Under Docker, App settings shows where the database and backups are on the computer (the
  folder `ORRERY_DATA` / `ORRERY_BACKUP` names, or the Docker volume), not the paths inside the container.
- **Postgres is backed up:** to the same backup folder, as a SQLite snapshot read in one consistent pass, so a
  backup opens anywhere. App settings → Database shows the database's size, the backups' size, when the latest
  backup was made, and **Back up now** (`POST /backups`).
- **Presets, ready to use:** orrery ships four (Release, Security audit, Review, Debug an error), each with *Reset
  to default*, and *Restore* after removal. A preset is written in a dialog built around its text, which sits in a
  well like the session message box. Presets lead Sessions → Setup. A running session's message box can send one,
  tweaked or not, and it's listed by its name. Sessions can read presets (`presets` and `preset` tools) but not
  write them.
- **Chat:** a Chat button in the corner of every page (and in ⌘K) opens a pane to talk to Claude about a project,
  with no terminal; the first message starts its session. It answers from the project's code, roadmap and docs,
  knows which page you're on as you write ("this" is the issue, doc or schedules in front of you), and makes issues
  and comments when asked, landing its issues in Todo or Backlog as picked beside Send. When you ask, it also changes
  an issue's title, notes, priority, labels, chunk, release or parent (never its status or assignee), messages your
  other sessions as you (idle ones unless you say otherwise, marked as sent through the chat), and asks to change an
  App setting, shown from → to with **Allow** and **Deny** and saved only on your Allow. It works on nothing itself.
  Paste or drop an image to show it. It counts towards no session limit, isn't listed with the sessions, can be made
  larger, and ends when you close its pane. Launchers need restarting to start one; one too old says so.
- **A `guide` tool:** any session with orrery's server, in any repo, can answer how orrery works ("how do schedules
  work?") from `docs/using.md` as the connected orrery serves it.
- **Agents' proposals wait on you:** an agent's pending proposal reads `waiting: "decision"`, with the violet chip
  and tint on the list, the board and My issues, and sits under *Waiting on you* until it's decided.
- **Start a session on every project:** in Start session, with no project ticked, orrery starts one session that
  hears every project, from a launcher whose channel serves them all.
- **Project filter on My issues and Now,** with each project's icon, in the sidebar's order.
- **A cut-off turn lets go of its issues:** when a turn ends on an API error (`StopFailure`: a network drop, a rate
  limit), each issue the session had in progress goes back to Todo with no assignee and a comment saying why. Repos
  connected before need Connect run again, or `StopFailure` added to their hooks.
- **An idle session carries on to its new sub-issues:** one that splits its issue and goes idle is sent on to the
  most urgent sub-issue, as it would be with a chunk.
- **A calmer session card:** one quiet line for the state, time left and folder. Watch, Show screen and Stop are
  out front, with +30 min and the attach command under ⋯. The sidebar's session row leads with its project.
- **An issue's page shows who's on it:** while a session is working the issue, its name and state sit beside the id,
  linking to it on the Sessions page, and it comes first in the Claude sessions panel, marked *on this issue*. The
  panel's rows keep only **Focus on this**: Watch, Stop and the rest stay on the Sessions page, which a session's
  name links to.
- **A pasted tracker page becomes its task link:** App settings → Team tracker turns a link into a tracker workspace
  it recognises into that workspace's task link with `{id}`, and says what it saved.
- **Phone fixes:** the Claude sessions card on an issue or chunk wraps its row; the preset cards on Setup and in
  the Start session and schedule dialogs fit the screen; App settings → Issues keeps status names readable; a doc's
  slug stays on one line under its byline.
- **Smaller fixes:** a mistyped URL is no longer logged as a page error; an unknown URL's tab and a project's
  Schedules tab have the full title; Schedules' empty state names every kind of schedule; a picker near the window's
  edge opens its menu on the side with room; a session's presets menu opens below when the top is cut off; Start
  session loads the presets as it opens; Getting started keeps the Claude steps ticked once done; every button shows
  the pointer; a board card's chunk is plain text, so a click anywhere opens the issue; App settings → Database shows
  whole paths with their Copy buttons lined up.
- **Reaching it from a phone:** `running.md` says how: over a private VPN between your devices, or on your Wi-Fi
  with `ORRERY_HOST=0.0.0.0`.
- **Faster:** the event log, the scheduler and Postgres backups keep what they read until it changes, instead of
  reading the database on every event.
- **The version moves with the branch:** a build of a release branch shows the version being built.
- **Security fixes from the release's audit:** an event schedule's run passes on no words an agent chose (a
  label's text, its name); an untrusted schedule's session can't claim an issue through its hook, and its refused
  writes set off no schedule; a launcher's report can't give a running session a context it wasn't started with,
  or take its stop time away. `SECURITY.md` says what the chat, the event log and a database move can do, and the
  gaps still open.
- **Tests and cleanup:** races where two sessions claim one issue, who may move the database and moves to Postgres,
  two flaky dialog tests split, and component tests that wait for a dialog to close before the next starts. Values used only in their own file stop being exported, the unused StartSession
  component is gone, the example project is Greenhouse, not Larder, and examples use a made-up tracker.

## 1.0.0-rc.8 (2026-10-27)

- **Write docs in the app:** **New doc** (from the docs sidebar, an empty Docs page and ⌘K) takes a title and
  Markdown, with images by paste, drop or pick. **Edit** changes a doc's title and text in place (⌘↵ saves, Esc
  cancels), with a note if it changed while you were editing; **Remove** asks once more, then moves on to the
  project's other docs.
- **A started session hears only the projects picked:** when the projects picked in Start session are served
  from one repo, it offers *One session for all N* or *A session each*; otherwise each session hears only its own
  project, as Start on an issue does. A launch takes `hears` (409 for a project not served from its folder), the
  launcher passes it on as `ORRERY_HEAR`, launchers say their folder (`?dir=`), and `GET …/launches` lists
  `folders`. Sessions opened by hand still hear what the repo lists.
- **A session on several projects goes by its bare name:** a made-up name no longer starts with the project it's
  filed under (`Odin`, not `switchboard · Odin`), and is unique across every session. It gets `<project> · …`
  back once it hears one project; a name the session or its hooks give is kept.
- **Not-found pages in one look:** an unknown URL, project, issue, chunk, release or doc shows the same block
  inside the app, with the sidebar, a way back and a "Not found" tab title, instead of Nuxt's bare 404 and six
  hand-written variants.
- **No native selects left:** the Schedules filter, Sessions setup, project Releases, a chunk's priority and
  status removal use the app's picker, so none opens the system's grey menu.
- **The UI builds on Headless UI:** dialogs and ⌘K, pickers, filter menus, segmented controls and the focus menu
  get their keys, focus trapping and ARIA from `@headlessui/vue`, and look as before. In a picker ↑/↓ stop at
  the ends and Tab picks the lit option; Esc in a dialog always closes it. A chunk's *Focus on all → All N
  sessions* now sends to every session, where it sent to one. `docs/components.md` maps each piece to its part.
- **Proposals wait in the bell:** an agent's proposal waiting on you now leads the bell and *Waiting on you* as a
  decision, with a violet *Proposal: needs your decision · N choices* chip, so one with no comment no longer sits
  unnoticed in Proposed. It goes when you decide it and can't be cleared before. `GET /notices` carries it as
  `{id: 0, asks: "decision", proposal: {choices}}`.
- **One violet for waiting:** the bell's *Needs your decision* chip, and a waiting card's ring, are the same violet
  as on rows, cards and the issue page, where they were amber.
- **Docs first for agents:** every place that tells an agent how to work (the channel, focus and chunk prompts,
  CLAUDE.md, CONTRIBUTING) says to read the docs a task touches before the code, and to fix a doc that turns out
  wrong. `GET /projects/:project/docs` gives each doc a `summary` and takes `?q=` (every word, title hits first,
  each with a `match` snippet); the channel's `docs` tool takes `q` too.
- **A session knows its name:** its signal stream sends a `name` event once Orrery knows it, and again when it
  changes; the channel tells Claude once, and every channel message carries `session="…"`.
- **The waiting question renders its Markdown:** the quote at the top of Activity shows bold, code and links as
  the comment below does, still cut to three lines; a click (not on a link) or Enter shows it in the thread.
- **Phone fixes:** a waiting row shows the chip's violet dot alone and the sub-issue progress steps aside, so the
  title gets the room; the toolbar's search fills its line; an issue's header keeps its id, Copy and Copy ref whole
  (icons alone on a phone), with Team tasks' Edit beside its chips.
- **Connect wraps at spaces:** the line to paste no longer breaks in the middle of words.
- **Schedules' empty state:** a dashed box whose **Make one** opens the New schedule dialog, instead of naming a
  button that's gone.
- **The session limit is over every project:** Starting sessions' guide said per project.
- **The playground seeds again:** since rc.6 `play reset` stopped after Primes; the start limit now goes in the
  settings.
- **Docs brought up to rc.7:** README and `docs/` checked against the code, and `docs/API.md` against every route.
- **The team's tracker, unnamed:** the tracker setting, its hint and the docs give
  `https://tracker.example.com/issue/{id}` as the example.
- **Cleanup:** values only their own file uses are no longer exported, so Nitro stops auto-importing them across
  the server.

## 1.0.0-rc.7 (2026-10-27)

- **Sessions and Setup tabs:** the Sessions page has two tabs. Sessions shows what's running, by project; Setup
  holds starting sessions, what sessions hear and presets. A link to a setup section (Start session's Presets,
  Getting started's *turn it on*) opens Setup, and with no sessions running the empty note links there too.
- **Session settings in one place:** What sessions hear and Presets each have a **For** picker on the Sessions
  page, every project or one project's own, and leave a project's Settings. A project's own standing
  instructions stay editable there.
- **Waiting on you:** when an agent asks you for a decision or feedback, the issue says so until you answer: a
  violet "Needs your decision" (or feedback) chip and tint on its row and card, the question quoted at the top of its
  Activity with Answer, and *Waiting on you* first on My issues. Through the API an issue carries
  `waiting: "decision" | "feedback"`.
- **Sessions across projects:** a session that hears several projects (`ORRERY_PROJECTS=a,b` or `*`) is listed once,
  in an **Across projects** group on the Sessions page with chips for what it hears, and each project says it also
  hears it. The sidebar labels it *All projects* or *N projects*. A focus, chunk focus or schedule message aimed at no
  session goes to one of the project's own idle sessions first; a spanning session takes it only when none is free.
- **A claimed issue stays with its session:** another session's comment, comment edit or issue edit on an issue a
  listening session has started is a 409, as starting it already was. Closing it, and the owner's writes, are never
  refused, and a chunk's issue list tells each session which issues another one holds.
- **New session on this:** an issue's Claude sessions panel can start a fresh session on it, through the launcher,
  while others are listening, when the limit has room; before, it could only start one when none was listening.
- **App settings in tabs:** **You**, **Issues** (statuses, proposals, tracker) and **This Orrery** (tint, secrets,
  database), each saying what it reaches; a link to a section opens its tab. Watching sessions moves to Sessions →
  Setup.
- **Where the data is:** App settings → Database shows the SQLite file and its backups, or the Postgres database as
  `user@host:port/name` (never the password), each with Copy, and how to move. `GET /api/settings` carries
  `database: {kind, where, backup?}`.
- **Skip a message when nothing changed:** a message schedule can skip a run unless an issue or comment in its project
  changed since the last message it sent (`only_if_changed`, off by default), so a frequent nudge stops waking an idle
  session for nothing. *Run now* always sends. The database gains a column for it, migrated on start.
- **New schedule picks its project:** the Schedules toolbar's New schedule is a button, and the project is picked in
  the dialog, with the same searchable picker as its other fields.
- **Remove a schedule without right-clicking:** its dialog has Remove, asking once more, and each row has a ⋯ with the
  right-click menu.
- **Pictures open over the page:** clicking a picture in a description or comment (or a slider's Before/After label)
  opens it larger over the dimmed page; a click, Esc or ✕ closes it. Open original and ⌘-click still open a tab.
- **The board shows only the statuses filtered for:** a status unticked in the Column filter has no column, unless a
  card is still in it. Done and Canceled, unticked by default, are off the board until ticked or the filter is cleared.
- **Release steps look like where they lead:** Freeze features is amber with a snowflake, Thaw features has a sun,
  and Mark shipped today is green with a tick.
- **One Start session on the Sessions page:** the per-project Start session buttons are gone; the toolbar's dialog
  already picks the project and says when one can't start.
- **Play and pause on each schedule:** a round button leads each schedule's row, filled with pause while it runs
  and outlined with play while it's paused, so you can see at a glance whether it runs.
- **A dialog's field is focused the first time:** pressing `c` (or opening New project, chunk or schedule) the
  first time focused nothing, so typing or Esc did nothing; the field is focused from the first open now.
- **A project shows its issues on a slow start:** the issue filters waited for no statuses and ticked Proposed
  alone, so a project could show no issues until Clear. They're set once the statuses arrive.
- **Saved schedules keep running on croner 11:** a step after a number (`5/10`) is still read as from 5 every 10.
- **No local env files in the image's build:** `.env.*` files and the playground's data stay out of the Docker
  build context.
- **Cleanup:** the app and server are linted with eslint in CI, non-null assertions are guards (new ones fail
  lint), helpers only their file uses aren't exported, and an issue's activity is its own component.
- **More tests:** component tests (the proposal choices, the Approve panel, the property picker, the owner, new
  issue, message, start session and schedule dialogs, ⌘K's keys, the row tick, the filter menu and the issue menu),
  e2e for the keys and the phone layout, screenshot checks of the board, the list and an issue's page, and the e2e
  flows run on Postgres as well as SQLite.
- **Dependencies:** `nuxt`, `marked` and the MCP SDK patches, `croner` 11 and `eslint` 10.

## 1.0.0-rc.6 (2026-10-27)

- **Message every session at once:** Message sessions on the Sessions page says one thing to every listening
  session, idle ones by default so a nudge doesn't interrupt work, narrowed to some projects if you like, and shows
  who it reaches before you send. A session that hears several projects gets it once. Through the API it's
  `POST /api/sessions/message {text, projects?, states?}`, the owner's only.
- **Agents keep off a waiting proposal:** while a proposal waits on the owner, an agent can comment on it, edit it
  and put it up again, but changing its status, assignee or release is a 403 until the owner approves it. It's one
  setting in App settings → Proposals, on by default, and the board's Proposed column shows a lock while it's on.
- **Tidier session settings:** each message template on the Sessions page says what it's for and whose it is, with
  Preview and Edit; its text opens on Edit. A project's Settings tab gets the same.
- **Presets read as roles:** each preset has a badge, an icon and colour you pick (its initials until you do), and
  shows as a card: in Presets (click one to edit its name, text and badge; New preset is an empty card) and in
  Start session (picked with a tick). A session started with presets shows their badges by its name. Through the
  API a preset takes `icon` (a Heroicon's name) and `color` (a tint or `#rrggbb`).
- **Pictures in a frame:** a picture in an issue, a comment or a doc sits in a frame (a band of the well colour, a
  hairline and a soft shadow), so a screenshot doesn't read as more of the page. The Before/After slider gets the same.
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
- **Team tasks:** an issue links to its tasks on the team's tracker (`external`: `ENG-1567`, or a URL),
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
