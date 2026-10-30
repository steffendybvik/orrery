# Changelog

What changed in each release. Versions follow [semver](https://semver.org): the API (`docs/API.md`) and
the database schema are the public surface, and a database always migrates forward on its own.

Each version's changes are grouped under **Features**, **Changes** and **Fixes**, then **Docs** and
**Internal** where they help, and a group with nothing in it is left out. 1.0.0, the first release's
overview, is one list.

## 1.0.0-rc.16 (2026-10-30)

### Features

- **The chat works with your own Claude Code settings:** it starts with the settings of the machine its launcher runs
  on, so what you allow in a terminal, such as fetching a page, works in the chat, and what you deny stays refused. It
  writes docs, calls `egress` and resolves events itself. A permission prompt shows in its pane with **Allow** and
  **Deny**. This also means a planted comment it reads can try to talk it into whatever those settings allow, and with
  Bash allowed it can reach orrery without its channel's mark, as `SECURITY.md` says.
- **The chat hands issue work to a session:** asked to do work on an issue, it starts a session for it, with no
  **Allow**, and stays free to talk to. Your last message has to name the issue or come from its page.
- **The chat reads GitHub:** the repo's issues and pull requests, including a pull request's diff and why its checks
  failed. It reads outsiders' text unfiltered, as data, so planted text could reach work sessions through what it files.
- **Upload a board's file as a new board:** `POST /api/projects/upload` brings a board's export onto a server, checking
  the file as untrusted, with its schedules paused. It's the API alone: there's no page for it yet, and the old board
  doesn't go read-only.

### Changes

- **Backlog is a safe place to park an issue:** a session out of work now picks from Todo only, and with Todo empty it
  stays idle. Pointing a session at a Backlog issue still works.
- **A limit on a request's size:** a body over 32 MB gets a 413, over 256 MB for a board's file or an import, and over
  64 KB on the login's routes, including a doc or comment that big.

### Fixes

- **Comments and docs load nothing from other sites:** viewing one could send what its writer had read to another site,
  and a style in one could cover the page. A remote image now shows as a link naming its site, and inline styles,
  classes, video and audio in Markdown no longer show, on what's already there too. Every page also has a
  `Content-Security-Policy`, limiting images, media, fonts and styles to orrery and Google Fonts.
- **A session's stream is guarded with a slash on its path:** another site's picture could open a stream as any session
  name.
- **A chat no longer stays on Thinking…** in a repo that keeps its hooks in its local settings.
- **A fresh install no longer offers to restore its own empty backups.**

### Docs

- **Upgrading on Postgres:** Running says to take a `pg_dump` first, as orrery keeps no copy before upgrading there.

### Internal

- **Shipping:** `CHANGELOG.md` is the only place a release's notes are written, and the Release run makes the GitHub
  release from it, so don't make one by hand.
- **The browser suite:** it runs on four workers, grouped by what specs share, and only on pull requests into `main`. A
  session's pull request into a release branch merges itself once `check` and `docker` pass.
- **Test speed history:** each run keeps how the suite ran, and a version isn't compared with one that ran differently
  or had failing tests. Working on orrery says how to benchmark. This version starts a new baseline.
- **Tests:** axe on every page of the walk, a test that fails when a page has no browser test, the components no browser
  test mounted, the routes no spec named, and backups and failed upgrades on Postgres.

## 1.0.0-rc.15 (2026-10-30)

### Features

- **Breaking, a server off loopback needs a login:** a server on anything but loopback, or a plain `docker run`, now
  refuses every `/api` route without a login or key, reads included, and answers nothing but its login page until
  claimed with `orrery:claim`. That includes today's phone setup in Running. Its sessions need an agent key in
  `ORRERY_KEY`. The release's `compose.yml` and `.env.example` change for login. One person on loopback sees no login
  and no keys.
- **Breaking, several people:** with more than one person, an agent can only start, change, close, move or delete an
  issue assigned to its person, writes are held to a board's members, and unassigned work on a shared board isn't
  handed to anyone until someone takes it. An agent can't move or delete an issue with a sub-issue that isn't its
  person's. One person's orrery is unaffected. Reads aren't held to a board yet, so a member can read boards they
  aren't on, and with `ORRERY_AUTH=off`, people are names that stop only honest agents and mistakes.
- **Breaking, only chunks go to every session:** a single issue can no longer be sent to all sessions, and `POST
  …/issues/:issue/focus` with `session: "*"` is a 400. A chunk's **Focus all on this** now really reaches them all.
- **Ids you can paste anywhere:** copying an issue's, chunk's or doc's id now gives its full form
  (`ORR-660-x7k2m9qd`), which finds nothing on another board or server. Short ids keep working. **Copy ref** is gone,
  as **Copy** gives the full id, a new project can't take the key `DOC`, `CHK`, `PST` or `SCH`, and a moved project's
  full ids get a 404 at their old address.
- **People, boards and claims:** App settings adds people, and a board's Settings holds its members. An issue shows
  who holds it and for how long, with **Claim**, **Let go** and **Take over** on its page. Each person's words,
  hand-outs and bell reach only their own agents.
- **Login and keys:** log in with any OIDC provider, with no passwords kept in orrery, or make person and agent keys
  and invites in Settings. `orrery:claim` claims a new server, and `--move-issuer` moves logins when a provider
  changes address.
- **Keep a doc's past:** each change to a doc is a revision that can be read, diffed and restored, a removed doc can
  come back, and a shipped release marks where its docs stood.
- **Artifacts:** a new kind of doc, HTML with Tailwind and the app's theme, drawn in a locked-down frame.
- **Test speed and coverage:** a page in the docs shows how slow the tests are and what's uncovered, for each release.
- **Sessions in ⌘K:** start a session, message every listening one, or message one found by name, from any page.
- **Block and unblock from an issue's page:** **Blocks** is a picker now, as **Blocked by** (was Depends on) is, and
  every link has a × to let it go.
- **Connect a repo with a click:** on Connect an agent, the launcher opens your machine's folder picker, you tick the
  projects the folder holds, and it writes the setup files, puts the repo on its list and opens Claude there.
- **A checklist makes sub-issues:** an issue schedule makes a sub-issue from each top-level `- [ ]` line in its notes,
  so a run's steps can be claimed, moved and reported on alone. Pre-release and Post-release are written this way.
- **The chat offers an issue with a button:** something worth an issue that you didn't ask it to file comes as a card
  marked as not filed, with **File issue** and **Don't file**.
- **A Releases page across projects:** every project that ships has a card, with its releases' state, branch and
  progress, and a shared release listed once with each project's part.
- **Copy a doc's URL:** a doc's page has **Copy URL** beside **Copy id**.
- **Export a board:** download a project as one file from its Settings, with no secrets in it.
- **Run a schedule from a project's issues:** **Run schedule** in the Board and List toolbar runs one, and a run now
  stays on the page and confirms what it did, with a link to any issue it made.

### Changes

- **Sessions you can't act on are off the lists:** a session with no channel and no launch has no message box and no
  Stop, so it no longer shows on the Sessions page, in the sidebar or on an issue. One line per project says how to
  restart it with the channel.
- **Launchers:** one that still works no longer shows a notice on Sessions, and the service updates itself without
  waiting for its sessions to end. On systemd this needs `KillMode=process`, which a running launcher adds to an older
  unit.
- **Event schedules stand out:** a running one has a teal bolt and **On event**, and sorts first.
- **A card being worked pulses:** a board card's status icon fades with its dot while its session is working, and
  stays still with reduced motion.
- **Schema:** new tables `people`, `project_members`, `keys`, `logins`, `identities`, `invites`, `doc_revisions`,
  `notice_clears` and `session_people`, and new columns on `projects`, `issues`, `comments`, `signals`, `docs` and
  `releases`, on both databases.

### Fixes

- **Agents can't touch another person's issue or words:** an agent could move or delete another person's issue, and
  reword or delete what another person's agent said, including a question in their bell.
- **Project names without a login:** with login on, `/llms.txt`, `/llms-full.txt` and `/connect` showed every
  project's name, key and progress to anyone who could reach the server.
- **A second launcher took over a live one:** a launcher run through the bootstrap counted as gone, so another took
  its sessions and stopped them.
- **The image build hanging:** arm64 builds on its own native runner rather than under emulation, and a stuck build
  fails after 30 minutes rather than GitHub's 6 hours.
- **A session's person is fixed at its first report:** a later write naming that session with another person's key is
  a 409, and a key disagreeing with `ORRERY_PERSON` is logged.
- **A proposal under an agent's issue** now waits on the owner, who's the one to decide it, rather than going to that
  agent's person.
- **Connect's brief with login on:** the curl that makes the project got a 401, and now sends `ORRERY_KEY`.
- **On a phone:** a doc's title no longer wraps a word per line beside its buttons, and an issue's description comes
  before its long properties, which wait behind **More**.
- **An empty board** has a **New issue** button and a link to Connect, not a raw API path.
- **The issue picker** is wide enough to tell titles apart, and shows the whole title on hover.
- **An issue's not-found page** has a heading for a screen reader.
- **A docs section** folds even with the open doc inside, and opening a doc in a folded section unfolds it.
- **After a 401,** the page goes to the login rather than staying dead.
- **A plain message** no longer reaches a session tagged `schedule="undefined"`.

### Docs

- **Corrected for this release:** API, Security, Using, Running, Connect, README, Development and Components say what
  rc.15 does.

### Internal

- **Tests:** the attack tests between people and an upgrade from before people, on both databases, the launcher's loop
  against a fake tmux, what the channel tells a session, who may handle keys, the OIDC checks, `orrery:claim`, the
  login page in a browser, and context budgets for the brief, a chunk's focus and the guide.
- **One API client:** every call from the page goes through `apiFetch`, and a test fails on a new `/api/` string or
  `$fetch` in `web/app`.
- **Maintenance:** exports only their own file uses are gone, and the browser suite is back to green.

## 1.0.0-rc.14 (2026-10-30)

### Features

- **The chat can ask to change docs:** the chat can ask to create a doc or change one, and nothing is saved until you
  press **Allow**. The card shows a new doc in full and a change as what differs, never rendered. A change is refused
  if the doc moved on after the chat asked. Removing a doc, and renaming or deleting a section, stay yours.
- **GITHUB_TOKEN ready-made:** App settings lists `GITHUB_TOKEN` as *Not set*, and **Set** asks only for the token,
  with the scopes it needs and a link to make one. A token GitHub turned down says so on its row.
- **The issue a session is on, in the sidebar:** a working or waiting session's row has a second line with its newest
  issue's id and title, linked to it, and `+n` when it holds more.
- **GitHub issues on an issue:** an issue has GitHub issue references of its own, shown as a `#523` chip and on its
  page, and filterable with `?github_issue=`. Links already in Team tasks move there on upgrade.
- **Schedules that move issues:** a new kind, **Moves issues**, moves the issue an event is about, or a release's
  issues, to a status with no session, and comments why. It's yours alone and runs only on an event. It passes over a
  parent, a proposal, an issue waiting on you and, on a pull request's event, an issue with another pull request open.
  Schedules → Suggested offers two, made off: **Merged PR closes its issue** and **Shipped release closes its
  issues**. PR news on its own still moves nothing.
- **Schedules across projects:** New schedule's project picker has **All projects** and **Several projects**. Each
  project gets its own copy with its own runs and guards, and a project added later gets one within 30 seconds. Untick
  a project, or use **Leave this project out** on its copy, to opt it out. A schedule like this is yours alone:
  sessions and the chat can't ask for one yet.
- **Sessions search an issue's text:** `q` on the `issues` tool finds words in descriptions and comments, title
  matches first, each with where it is and the words around it. `?q=` on its own stays the id and title, and `&in=all`
  searches the text. An issue labelled `external` says only where, and an untrusted session gets no quotes.
- **Upgrades follow orrery:** orrery serves the channel, hooks and launcher itself, and Connect has repos run them
  through `~/.orrery/bootstrap.mjs`, so connecting a repo needs Node but no clone, and upgrading orrery upgrades them:
  a session as it starts, the launcher once it has no session running. It fetches only from this machine or over
  https, and checks the orrery's id and each file (see Security). A repo already connected keeps working from its
  checkout until you paste Connect's line into it and run the launcher's install line again.

### Changes

- **The chosen option stands out:** a segmented control fills its chosen option with the accent, everywhere it's used,
  in light and dark.
- **Less for sessions to read:** the `issue` tool gives an approved proposal's questions with only the titles picked
  (`comments: "all"` still gives every option), and the chat ends its turn in a few words after `reply` instead of
  repeating the answer.
- **Code blocks in any text box:** Three backticks then Enter closes the block below the cursor, and inside one Enter
  is a new line, even where it would otherwise send. ⌘E (Ctrl-E) wraps a selection or starts an empty block.
- **An issue's id and copy buttons stay in view:** at the top of the right panel, or in a slim bar when there's no
  panel, stacked under the banner of a session working on the issue.
- **Double-click a description to edit it:** it opens the same editor as **Edit**, which stays. A link, picture or
  button keeps its own click, and a drag still selects.
- **Copy a whole issue:** **Copy issue**, under the description, copies its ref, title, description and every comment
  as Markdown, each comment with who wrote it and when.

### Fixes

- **Usage limits show:** a session that hits its usage limit reads **usage limit reached**, with what Claude Code
  said, on its Sessions card and sidebar row, where before it just read as idle. Being cut off this way also leaves
  issues in review or waiting on you where they are, rather than back in Todo.
- **Event schedules lose nothing to their minute:** a second subject within a schedule's minute was dropped for good.
  It now waits its turn at one a minute, if it still fits, and the schedule's row says how many are waiting.
- **Sessions don't see outsiders' pull request text:** `GET /pulls` and an issue's pulls give a pull request's title
  and branch only to the owner, and its author only when it's a plain login, as an outsider writes those.
- **A GITHUB_TOKEN that can't be used says so:** one saved without `api.github.com` was quietly ignored and the pages
  read as if none was set. Secrets now warns and adds the host on a click, the pages say why it wasn't used, and a
  change to the secrets polls the affected repos at once.
- **Allow warns before overriding newer changes:** a chat's request to move issues, or to change a chunk, release,
  schedule or setting, applied as asked however long it had waited. Allow now shows what changed since, and saves only
  on **Move anyway** or **Allow anyway**. The chat's session hears what had changed.
- **A closed issue isn't waiting:** a done or canceled issue with an unanswered question no longer reads as waiting on
  you. Reopened, it does again.

### Docs

- **Quick start pulls the published image:** it downloads the release's `compose.yml` into a folder of its own and
  runs it, with no clone. Building from source moved to Running orrery.

### Internal

- **Worktrees get tidied:** sessions work under `../orrery-worktrees/` and remove a worktree once its pull request
  merges, and `pnpm worktrees` lists what's safe to remove (`--remove` clears it).

## 1.0.0-rc.13 (2026-10-30)

### Features

- **Events, Context and Pull requests back in the sidebar:** they sit under Schedules while Advanced is on, and
  Advanced now starts on. App settings → Advanced still links all three when it's off.
- **Drag cards on the board:** drag a card to another column to move it, as the menu does; a ticked card takes every
  ticked one with it. The column it would land in lights up, one it can't go to dims, and Done and Canceled show as
  places to drop while you drag. `[` and `]` move the focused or ticked cards a column left or right.
- **First open asks if you're a developer:** the name dialog asks too, and No turns Advanced off, so Events, Context
  and Pull requests stay out of the sidebar.
- **Install the launcher once:** `--install` run outside a repo puts the launcher service in place with no projects
  yet. With pick-up on (the default), a Claude session you open in a connected repo puts that repo's projects on the
  launcher's list, and says so once; `--uninstall` in a repo takes it off and keeps it off. Sessions → Setup lists the
  repos the launcher serves, each marked picked up or installed by hand, and the install hints say to install once.
- **The launcher follows its list while running:** it serves a project added to `~/.config/orrery/launcher.json`
  and lets a removed one go, without a restart, so `--install` in another repo no longer stops every session it runs.
- **Issues depend on others:** set **Depends on** on an issue's page, in New issue, or with **Chain in order** on the
  ticked issues, in its project or another. A blocked issue has a lock chip and a **Blocked** filter, and nothing
  hands it out until each issue it waits on is Done. Then it goes to the session that did the last one, told what each
  was. A canceled blocker keeps it blocked and asks you; a reopened one tells the session working on it.
- **Focus a session on a pull request:** on the Pull requests page, a pull request that names an issue has **Focus on
  this**. It opens the note a session gets, written from where the pull request stands (conflicts, behind, failing
  checks, a review, a draft), for you to add a line to, and **Send** hands it to the session on the issue, or one
  orrery picks or starts. Each repo's name has a copy button.
- **Releases beside GitHub:** a small **Releases** link sits next to GitHub at the foot of the sidebar and opens
  orrery's releases on GitHub.
- **A notice when a newer orrery is out:** the foot of the sidebar says so above the version, with its release notes
  and how to update, and × hides it until the next one. orrery reads its releases on GitHub a few seconds after start
  and every 12 hours; `ORRERY_UPDATE_CHECK=false` turns that off.
- **Secrets with nothing to set up:** with no `ORRERY_SECRET_KEY`, orrery makes a key on its first start and keeps it
  as `orrery.key` beside the database (`/data/orrery.key` in Docker), out of the backups. A key you set still wins;
  Postgres outside Docker still needs one.
- **Pull requests past the first 100:** the Pull requests page shows 50 at a time, with Previous and Next, and orrery
  reads up to 300 open pull requests a repo where it read GitHub's first 100. A repo cut short says so.
- **Review GitHub issues, a suggested schedule:** Schedules → Suggested offers an issue every three hours to sort the
  project's GitHub issues, for projects whose repo is on GitHub.

### Changes

- **Sessions ask you for a schedule:** a working session asked to set up or change a schedule asks on its issue, with
  the schedule (or each field, from → to) and **Allow** and **Deny**, as the chat does. Allowed, it's saved as yours
  and runs; before, the session made it as an agent's, so a message schedule never ran.
- **Pin the chat's project:** picking the chat pane's project pins it, remembered in this browser, so it stays put as
  you browse and ⌘K doesn't move it; the pin beside it lets go. A line under the header says when the page is another
  project's, and the chat files in its own.
- **The chat shows how to install the launcher:** with no launcher running for its project, the pane shows the
  install command to copy, in place of a red error line, and it goes once a launcher connects.
- **Pull requests grouped by repository:** the Pull requests page gives each repo its own card, in the sidebar's
  project order, with its projects and open count in the header. A repo that couldn't be read says why.
- **One session per piece of work:** a sub-issue filed under an issue another session is working on is that session's
  to start, so a follow-up isn't taken up by two. The **Review** preset only reviews: it comments what it found on the
  pull request and its issue, for the session on it to fix, and files what's left after the merge as a sub-issue. A
  Review preset you haven't changed takes the new wording. A session may comment on another session's issue, but not
  edit or start it, and the issue stays with the session on it.
- **Less context for every session:** the chat is given less than half of what it was at connect, its asking tools
  behind `request_fields` and `request`. A work session carries about a third less, its rarer tools loaded on demand
  with `more_tools`, and an untrusted run is offered only what it may do. The Context page counts tools as they're
  sent, so its numbers drop too.
- **Proposals first in App settings → Issues:** the tab opens on Proposals, then the team tracker and the statuses.

### Fixes

- **Security, no forms in rendered Markdown:** a comment or description could draw a form on the issue page that
  posts anywhere ("paste your token again"). Forms and their controls are dropped now; task-list checkboxes stay.
- **Your answers don't start sessions:** allowing or denying a session's schedule request, or rejecting a proposal,
  posts your comment, and with nobody listening that comment started a session, taking a place under the limit. It
  still reaches a listening session but starts none; an event schedule it sets off can still start one.
- **The launcher refuses a repo with no channel:** `--install` in a repo that isn't connected yet stops and says to
  connect it first, instead of serving a project nothing answers for. `--help` prints its usage, an unknown flag is
  refused, and a project nothing answers for is logged once rather than every 30 seconds.
- **Issues assigned to `Claude` are handed out:** picking and the Todo hand-out held back an issue assigned to
  `Claude` with a capital C, though the board shows that name as the agent.
- **The permission popup stays up:** a parallel tool's hook landing just after a permission prompt opened set the
  session back to working, hiding the popup while the prompt was still on screen. Your **Allow** still sends the
  session on at once.
- **The default database is the repo's:** started without `NUXT_DATABASE`, the server made its database relative to
  the folder it started in, so from the repo root it landed in the folder above. It's now always the repo's own
  `.data/orrery.db`; a relative `NUXT_DATABASE` is still taken from the working folder.
- **Context after a `/clear`:** **So far** went on listing and counting what a session had been given before a
  `/clear` or compaction. Those entries now sit greyed under a line of their own, out of the total.
- **Pick several labels in a row:** on an issue's page, the Labels and Team tasks pickers shut while a pick saved, so
  the next Esc left the page. They stay open now, show each pick at once and keep a quick second one.
- **Three pages on a phone:** Events wraps its lines, with the message on a line of its own, Context gives tool names
  room, and a schedule's badge wraps under its name, where each was cut off at the screen's edge.
- **One `<h1>` a page:** Getting started, Connect and a doc's page had two, so a screen reader listed two top-level
  headings. A Markdown `#` heading is now an h2 that looks the same.

### Docs

- The README's screenshots are retaken on this release, and the docs caught up where they had drifted: where App
  settings keeps the database and proposals, which tools are the chat's, running without Docker, and `tint` in the API.

### Internal

- **Code:** `shared/roadmap.ts` is split into a file per area under `shared/roadmap/`, still imported as before.
- **CI:** the browser tests run only on pull requests into `main`, the release's, so a release branch's pull requests
  run the unit tests, typecheck and lint alone.
- **Tests:** every page, sidebar entry and palette go-to is walked in the browser tests. New unit tests cover the hook
  route's untrusted guard and caps, how a feed's signals reach a session's stream, how `events.ts` wires the store,
  and the chat, bell, keys and unseen composables. Coverage counts the routes, middleware and channel, and the
  Postgres run's with SQLite's. The sidebar's Advanced test runs again, and the channel's pick-up has tests of what it
  puts on the launcher's list.
- **Dependencies:** `vue-tsc` 3.3.14.

## 1.0.0-rc.12 (2026-10-29)

### Features

- **What a session has been given so far:** a running session's **Context** page lists, under **So far**, its latest
  30 signals and tool answers, newest first, each with its size and its text folded under it. It's held in memory
  only, so a restart starts it afresh.
- **Doc sections of their own:** **New section** at the foot of the docs list makes one, empty if you like, and
  right-clicking a section's header renames it on all its docs at once or deletes it, keeping its docs under no
  section.
- **An Advanced tab in App settings:** Events, Context and Pull requests leave the sidebar for App settings →
  Advanced, which holds the Advanced switch too, with Events' new errors and the pull requests that need someone
  counted. Old links to them still land there.
- **Permission prompts say what for:** the popup and a waiting session's card name the tool a session asks to use
  and what it would do (the command, file, address or search), an MCP tool as `server · tool`, not only "Claude
  needs your permission".
- **The launcher on Windows:** it installs and runs inside WSL2 with systemd on. `--install` says what to do on
  Windows itself or in a distro without systemd, and when it can't reach a `localhost` orrery from WSL; **Watch**
  opens Windows Terminal on the session.

### Changes

- **Dark mode lifts what floats:** the sidebar, cards, panels and an issue's properties pane sit a step above the
  page, rather than showing only by their borders. Light mode is unchanged.

### Fixes

- **Security, the permission popup shows the screen's prompt:** with rc.12's tool line, it showed what a session's
  hook said it asked for over the prompt on its screen, which another session could fake and a late parallel tool
  could overwrite. The prompt on screen, what **Allow** answers, comes first again; a hook's tool only shows for a
  session with no screen, which has no Allow.
- **Security, egress answers stay out of Context:** **So far** kept the text of what an `egress` call brought back,
  which any caller can read there. It keeps only its size now, and `SECURITY.md` says what the Context page holds and
  who can read it.
- Watch opened two terminal windows, one of them blank, when Terminal or iTerm2 wasn't already running. It opens
  one.
- An issue's read-only fields (Project, Progress, Created by, the dates) sat closer together than the editable ones
  above them.
- Sessions with no sessions said so twice, and showed Message sessions with nobody to message. It says so once, in
  its empty state, and hides Message sessions until there's someone.
- On a phone, My issues' section labels broke onto two lines, and a doc's size toggle and id wrapped onto an
  indented line.

### Internal

- **Tests:** the pull requests e2e test passes when CI's unauthenticated GitHub rate limit is used up.
- **Refactors, no behaviour change:** an issue's fields are listed once, on `Issue`, and a session's brief is built
  in a server util rather than its route.

## 1.0.0-rc.11 (2026-10-29)

### Features

- **Pull requests:** an issue's page shows its open pull requests and where each stands (draft, conflicts, behind,
  checks failing, waiting, ready), matched by the issue's link in the PR's body or its id in the branch. A
  **Pull requests** page lists every project's open PRs, the ones that need you first, with a count in the sidebar.
  **Poll** asks GitHub there and then, and a repo GitHub holds back (a rate limit, a refused token) says why. When
  it couldn't read GitHub the page says so, rather than *None open*. A PR that conflicts, is behind or fails its
  checks has **Send back**, which asks a session to fix it.
- **PR news on the issue:** orrery polls each GitHub repo in the background (every minute with a `GITHUB_TOKEN`, every
  ten without) and comments on the issue when its PR conflicts, falls behind, fails its checks, gets changes
  requested, merges or closes. The session on the issue hears it. The comment says where to read a failure or a review
  (`gh pr checks`, `gh pr view --comments`) and never quotes them, as whoever opened the PR wrote them; nor does a
  session see a PR's branch name. After three failed runs in a row, the fourth asks the owner and the session hears no
  more until the owner answers or focuses one on it; checks passing start the count afresh. A repo's first poll
  only records, so adding a token doesn't comment on every open PR at once.
- **Who's on an issue:** a banner on top of an issue's page, staying as it scrolls, names the session working it, its
  state and how long it's been on it, with **Watch** for one orrery started. Its dot shows on the issue's row in
  lists and on its board card too.
- **Permission prompts pop up:** a session at a permission prompt shows at the top right of any page, with what it
  asks word for word from its screen. For one orrery started, **Allow** answers "Yes" once, only while that prompt
  is still on its screen, and **Open tmux** opens a terminal on it.
- **Sessions find their own work:** with **picks its next issue** on (Sessions → Setup, off by default), a session
  out of work is handed the issues it may start, Todo or else Backlog, most urgent first, and picks one. An issue you
  move into Todo, or make there, goes straight to an idle session, setting or not. An issue assigned to anyone but
  `claude` stays put, a busy session is never interrupted, and with nobody idle nothing is queued or started.
- **Start several at once:** Start session takes a count, up to the room under the session limit.
- **The chat does more, asking first:** it can ask to add or change a release, make or change a chunk, move issues to
  another status or assign them, and start, stop or give more time to a session. Each shows with Allow and Deny,
  and nothing happens until you allow it. `/clear` clears its context and marks the cut, keeping what was said.
  Minimize (–, or Esc) hides the pane with the chat still running. A run of quick messages shows as sent, with the
  thinking dots, and goes as one once you stop typing, so it answers the whole thought (⌘-Enter sends at once).
  Closing the chat puts what's still held back in the box, and a run that couldn't go waits for **Retry**.
- **Docs in sections:** the docs list groups into sections, each folding away. Drag a doc onto one, or right-click →
  Move to section, which can make a new one; `write_doc` takes a `section` too.
- **What a session is given:** a **Context** page (Advanced) lists what orrery puts into a session's context as it
  connects (the server's instructions, each tool, the start context), each with its size and share, biggest first.
  A session's card opens it for that session.
- **Grouped release notes:** a release's drafted changelog is grouped under Features, Changes, Fixes, Docs and
  Internal by the issues' labels, and the Release preset asks a session for the same layout.

### Changes

- **Sessions carry less of orrery:** a work session gets only the tools it uses, with shorter descriptions and
  instructions (over a quarter less each turn), and its start context comes once a stream, not with every signal.
  `issues` leaves backlog out for a work session, `releases` and `chunks` leave out shipped releases and done chunks,
  and `issue` lists open sub-issues and the latest comments in full, each saying what it left out and how to get it.
- **The chat button** is a quiet **Agent** button in the same corner, drawn like the app's own, with a sparkles mark
  that pulses while a chat runs. The chat's working dots stay up until its turn ends, even after a reply.
- **The owner's comment on an issue nobody is on** goes to one session (idle first), which then owns the thread,
  instead of every listening session answering it at once.
- **The permissions table is what's enforced:** the owner-only routes, the store's owner checks, and the chat's and
  an untrusted session's guards now check it, and a refusal names its row. A chat or untrusted session naming the
  owner is still refused.
- **Smaller:** ⌘/Ctrl-Enter sends a session's message too, and App settings → Issues puts Team tracker first.

### Fixes

- Every use of a secret, orrery's own PR poll with a `GITHUB_TOKEN` included, set off a backup; with a token that was
  one a minute, rotating the real history out. Only a change to the secrets does now.
- Two quick edits to App settings could undo each other when an older save's answer landed late.
- The owner's comment on an issue nobody was on was never handed to a session once orrery had commented after it.
- On a phone, the Agent button covered the end of every page.
- A reconnecting session's stream whose catch-up hit a database error lost what it missed; it now sends it.
- Using an older orrery's SQLite file now copies it before upgrading it, as starting does.
- A second doc with a long title got an id too long for repo sync to reach.
- A backup worker that exited without answering stalled every backup after it.
- Stopping due sessions could raise an unhandled error when a check failed.

### Docs

- The using guide and the API caught up with the sessions changes, and the 1.0.0-rc.10 changelog with #355.
- Every earlier version in this changelog is grouped under Features, Changes and Fixes too.

### Internal

- **Tests:** SQLite and Postgres are checked to end on the same schema, with upgrades run on real rows, and CI runs
  every unit test on Postgres too. New unit tests cover a chunk focus's scope, what a signal tells a session,
  reading a project again, the backup timer, an issue's release on a move, and that what a write sets off waits for
  its commit. Budget tests fail when what orrery puts into a session's context grows. The store's tests are split by
  what they test, and the store counts in coverage. Each checkout's browser tests serve on a port of their own, and
  a rate-limit test no longer fails across a minute boundary.
- **Refactors, no behaviour change:** launches held one way, each kind of schedule in a function of its own, the
  schedules' hooks by name, one lookup of a launch's session, the session claims in a store of their own, the
  database-only reads out of the store's base, one check of whether a session is busy, the text signal stream
  through the same feed as the other, both migration lists side by side in `server/utils/migrations/`, and helpers
  only their own file uses no longer exported. Listing or reading issues reads only the board.

## 1.0.0-rc.10 (2026-10-28)

### Features

- **Backups, your way:** App settings → Database turns backups on or off and, outside Docker, picks their folder in
  place of `ORRERY_BACKUP`. Turned on, it backs up there at once, so a folder that won't take one says so on the spot.
  It backs up a few seconds after a change, or at most every 15 minutes, hour or day, and keeps as many daily copies
  as you choose (14 unless you say otherwise).
- **Back up into Postgres:** either database can be backed up into a Postgres database instead of a folder, from App
  settings or `ORRERY_BACKUP_DATABASE`. It keeps the latest only, replaced in one transaction so a failed backup
  leaves the one before whole, and it only writes into an empty database or its own earlier backup, never another
  orrery's or the one it runs on. The password is never shown or logged.
- **Restore from the app:** a new, empty orrery no longer starts from the latest backup on its own. It asks *Found
  backups. Restore one?*, or you **Start fresh**. App settings → Database → **Restore a backup…** brings back any copy,
  checked first, with the database it replaces set aside. A backup never writes over another orrery's.
- **Keep sessions running:** *Let orrery start sessions* has **Keep at least N running**, across every project. A
  session that stops because its time is up or it sat idle is replaced by a fresh one with the same presets, notes and
  projects. One you stop isn't.
- **Start sessions only when you say:** a switch, **Start a session when work arrives and nobody's listening**, on
  by default. Turned off, work waits for a session you start, and *Focus on this (starts a session)* still starts
  one. A line says what starts sessions, and how many schedules do.
- **Know when code is old:** the channel and the launcher tell orrery their version. Sessions marks a session or
  launcher running older code, with the command to restart it, and a launcher service restarts itself on the new code
  once its checkout changes, within a version too, and it has no session running. A launch refused for an outdated
  launcher waits for one that can take it, so restarting the launcher starts the session or chat.
- **A compose file with each release:** `release/compose.yml` runs the published image and backs up to the
  `orrery-backup` volume, so no `./backups` folder shows up beside it, or to the folder `ORRERY_BACKUP` names. App
  settings says when the backups are only in a Docker volume on this computer.
- **The chat asks for schedules too:** it can set up a schedule or change one (pause and resume included), shown with
  **Allow** and **Deny**; once allowed it's yours. Under each of its replies, **Copy** takes the reply's Markdown.
- **What sessions may do:** Sessions → **Permissions** shows, for a working session, the chat and an untrusted
  session, what each may do freely, what asks you first and what's yours alone, with why. Agents read the same table
  at `GET /api/permissions`.
- **Which session wrote it:** comments, activity lines and *Created by* name the session that wrote them
  (`orrery · Frøya`), kept with the write. Older ones, and an agent's writes with no session, say **Agent**. The page
  no longer says Claude: sessions are just sessions.
- **Drop an image anywhere:** drag one over the chat, the comment box, a description or doc being edited, or the new
  issue or doc dialog, and the whole area says *Drop image to add*. Pasted anywhere inside it goes in too, and you're
  back to typing after.

### Changes

- **Backups you can trust:** each copy is checked before it takes the last one's place, so one cut short or damaged
  never replaces a good one. App settings → Database marks the latest backup when it's over two days old or the last
  try failed, and says why.
- **Safer upgrades:** before a SQLite database takes an upgrade's steps, it's copied as it was to
  `orrery-pre-<version>-step<n>.db` (the three newest stay). A database newer than the code is refused and left
  alone, with a message on how to go back.
- **Make it mine:** an agent's message or session schedule runs only once you press **Make it mine** in its dialog,
  after reading it. Pausing, renaming or retiming it leaves it the agent's. Its row says it isn't running yet, and is
  tinted as unseen until you open it.
- **Faster on a big orrery:** a change sends open pages only what changed (4.2 kB instead of 859 kB for one renamed
  issue), pages load the boards without the issues' descriptions (2.3 MB down to 1.5 MB) and other projects' closed
  issues until one of their pages opens (1,474 kB down to 995 kB), and the bell reads agents' comments off an index
  (37 ms down to 0.2 ms with 20,000 comments).
- **Smaller images:** uploaded PNGs and JPEGs are kept as WebP (photos at quality 82, screenshots at 90 for crisp
  text), and the ones already there are converted once on start, links unchanged. A rewritten image loses its
  metadata, a photo's place included. SQLite's WAL is cut back once it's written through. On a real orrery the
  database, and every backup, shrank from 69 MB to 27 MB.
- **My issues is home:** Now is gone, and `/` (and `/now`, for old links) opens My issues.
- **One notifications list:** Notifications is one list, with what waits on you ringed among the rest. Clearing an
  agent's proposal there hides it from the bell and its count, and leaves it pending on its issue. Put up again, it
  comes back.
- **Forget a session nothing can reach:** a session started without the channel gets a × on its card, and one idle an
  hour with no channel open goes on its own, rather than after six.
- **Getting started mentions the launcher:** its last step says when none is running, with the line that installs it,
  and so does an issue's sessions panel. On Sessions → Setup, Starting sessions comes first and opens with the
  install command.
- **Plainer waiting words:** an issue waiting on you says **Decision needed** or **Feedback needed**, and a session at
  a permission prompt says **permission needed**.
- **Events read like a console:** each event stays one line; clicking it opens nothing.
- **Connected:** the sidebar's live indicator says *Connected*, *Reconnecting…* or *Offline*, with a tooltip.
- **The name is lowercase:** "orrery" is written the way its logo reads, everywhere.

### Fixes

- **Security, from the rc.9 audit:** an untrusted schedule's session gets no Bash: a `github_issues` tool reads the
  repo's issues for it, so it can't point `gh` at another host (#305). The chat asks you before it messages your
  sessions, and only **Send** sends (#294). An agent can't quietly resolve an error or flood the event log with page
  errors (#297). A database move or backup setting has to come from this machine by its connection, not its `Host`
  header (#308). A session schedule can't restart itself on its own session stopping, and an untrusted session stops
  at its 30 minutes, busy or not (#301). Plus four smaller fixes: the moved-database file kept private, more ways of
  writing a Postgres password scrubbed from the log, a dropped Postgres connection no longer ending the server, and
  an untrusted proposal keeping only `external` (#300). A launch waiting to start can be claimed only by a
  connected launcher, by the token its stream gives it (#325).
- **Fixes from the rc.10 review:** a Postgres backup target holding anything but orrery's tables is refused before
  it's opened, so nothing is written into it (#331). A chat request answered twice at once acts once, and a send that
  failed partway goes again only to the sessions that missed it (#330). A request through a proxy isn't taken as from
  this machine, and page-error reports are limited per sender (#332). Sessions orrery starts keep their launch again,
  so their limit, stop timers and context after a `/clear` work (#340). Pruning keeps its hands off the copy kept
  before a restore and another orrery's set-aside latest: only upgrade copies go (#349). Events lines and tooltips say
  **Agent** too (#350). Lowering *Sessions at once* below *Keep at least N running* lowers the minimum with it, rather
  than refusing the save (#351). The chat's **Send** reaches a session that `/clear`ed since it asked (#352). A
  stopped session still closing no longer counts toward the minimum, so its replacement isn't dropped (#353). A page
  that read a project while a change went out no longer misses that change (#354). A backup holds up writes only
  while it copies, patches don't write the old project out again, the backup list doesn't reopen every copy, and
  page-error caps count one address as one sender whatever name it sends (#355).

### Internal

- **Performance tests:** `pnpm test:e2e:perf` times every page on a big seeded orrery, on SQLite and Postgres, in CI.

## 1.0.0-rc.9 (2026-10-28)

### Features

- **Schedules that run when something happens:** a schedule can run `on` an event instead of a clock: an issue
  moving to In review, a release frozen or shipped, a new error, or anything else orrery records, narrowed by
  `on_filter`. The dialog's When is Time or Event. One schedule's failed run is heard by the others, but an outcome
  never sets off another outcome.
- **Schedules that start sessions:** a schedule can start a session with presets, on a clock or an event, and a
  message schedule can send presets, so a preset like Release is written once and runs by itself.
- **Chat:** a Chat button in the corner of every page (and in ⌘K) opens a pane to talk to Claude about a project,
  with no terminal; the first message starts its session. It answers from the project's code, roadmap and docs,
  knows which page you're on as you write ("this" is the issue, doc or schedules in front of you), and makes issues
  and comments when asked, landing its issues in Todo or Backlog as picked beside Send. When you ask, it also changes
  an issue's title, notes, priority, labels, chunk, release or parent (never its status or assignee), messages your
  other sessions as you (idle ones unless you say otherwise, marked as sent through the chat), and asks to change an
  App setting, shown from → to with **Allow** and **Deny** and saved only on your Allow. It works on nothing itself.
  Paste or drop an image to show it. It counts towards no session limit, isn't listed with the sessions, can be made
  larger, and ends when you close its pane. Launchers need restarting to start one; one too old says so.
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
- **Untrusted schedules get a locked-down session:** a schedule that brings in what others wrote (the daily
  GitHub-issues review) gets a session of its own for each run, and whatever that session raises becomes a proposal
  for the owner. It stays locked down after a restart, since the session itself says it's untrusted on every
  write, and its writes set off no event schedules.
- **Suggested schedules:** Schedules offers a ready-made event schedule for each preset orrery ships (Release and
  Security audit when a release is frozen, a nudge to get the next release going when one ships, Review when an issue
  moves to In review, Debug an error on a new error). **Add** opens New schedule filled in; none runs until you save it.
- **Run now instead:** a schedule's menu has *Run now instead of 09:00*, which runs it now and skips its next run.
- **A `guide` tool:** any session with orrery's server, in any repo, can answer how orrery works ("how do schedules
  work?") from `docs/using.md` as the connected orrery serves it.
- **Start a session on every project:** in Start session, with no project ticked, orrery starts one session that
  hears every project, from a launcher whose channel serves them all.
- **A cut-off turn lets go of its issues:** when a turn ends on an API error (`StopFailure`: a network drop, a rate
  limit), each issue the session had in progress goes back to Todo with no assignee and a comment saying why. Repos
  connected before need Connect run again, or `StopFailure` added to their hooks.
- **An idle session carries on to its new sub-issues:** one that splits its issue and goes idle is sent on to the
  most urgent sub-issue, as it would be with a chunk.
- **Project filter on My issues and Now,** with each project's icon, in the sidebar's order.

### Changes

- **Agents' proposals wait on you:** an agent's pending proposal reads `waiting: "decision"`, with the violet chip
  and tint on the list, the board and My issues, and sits under *Waiting on you* until it's decided.
- **An issue's page shows who's on it:** while a session is working the issue, its name and state sit beside the id,
  linking to it on the Sessions page, and it comes first in the Claude sessions panel, marked *on this issue*. The
  panel's rows keep only **Focus on this**: Watch, Stop and the rest stay on the Sessions page, which a session's
  name links to.
- **A calmer session card:** one quiet line for the state, time left and folder. Watch, Show screen and Stop are
  out front, with +30 min and the attach command under ⋯. The sidebar's session row leads with its project.
- **A pasted tracker page becomes its task link:** App settings → Team tracker turns a link into a tracker workspace
  it recognises into that workspace's task link with `{id}`, and says what it saved.
- **Faster:** the event log, the scheduler and Postgres backups keep what they read until it changes, instead of
  reading the database on every event.
- **The version moves with the branch:** a build of a release branch shows the version being built.

### Fixes

- **Security fixes from the release's audit:** an event schedule's run passes on no words an agent chose (a
  label's text, its name); an untrusted schedule's session can't claim an issue through its hook, and its refused
  writes set off no schedule; a launcher's report can't give a running session a context it wasn't started with,
  or take its stop time away. `SECURITY.md` says what the chat, the event log and a database move can do, and the
  gaps still open.
- **Phone fixes:** the Claude sessions card on an issue or chunk wraps its row; the preset cards on Setup and in
  the Start session and schedule dialogs fit the screen; App settings → Issues keeps status names readable; a doc's
  slug stays on one line under its byline.
- **Smaller fixes:** a mistyped URL is no longer logged as a page error; an unknown URL's tab and a project's
  Schedules tab have the full title; Schedules' empty state names every kind of schedule; a picker near the window's
  edge opens its menu on the side with room; a session's presets menu opens below when the top is cut off; Start
  session loads the presets as it opens; Getting started keeps the Claude steps ticked once done; every button shows
  the pointer; a board card's chunk is plain text, so a click anywhere opens the issue; App settings → Database shows
  whole paths with their Copy buttons lined up.

### Docs

- **Reaching it from a phone:** `running.md` says how: over a private VPN between your devices, or on your Wi-Fi
  with `ORRERY_HOST=0.0.0.0`.

### Internal

- **Tests and cleanup:** races where two sessions claim one issue, who may move the database and moves to Postgres,
  two flaky dialog tests split, and component tests that wait for a dialog to close before the next starts. Values used only in their own file stop being exported, the unused StartSession
  component is gone, the example project is Greenhouse, not Larder, and examples use a made-up tracker.

## 1.0.0-rc.8 (2026-10-27)

### Features

- **Write docs in the app:** **New doc** (from the docs sidebar, an empty Docs page and ⌘K) takes a title and
  Markdown, with images by paste, drop or pick. **Edit** changes a doc's title and text in place (⌘↵ saves, Esc
  cancels), with a note if it changed while you were editing; **Remove** asks once more, then moves on to the
  project's other docs.
- **A session knows its name:** its signal stream sends a `name` event once Orrery knows it, and again when it
  changes; the channel tells Claude once, and every channel message carries `session="…"`.

### Changes

- **A started session hears only the projects picked:** when the projects picked in Start session are served
  from one repo, it offers *One session for all N* or *A session each*; otherwise each session hears only its own
  project, as Start on an issue does. A launch takes `hears` (409 for a project not served from its folder), the
  launcher passes it on as `ORRERY_HEAR`, launchers say their folder (`?dir=`), and `GET …/launches` lists
  `folders`. Sessions opened by hand still hear what the repo lists.
- **Proposals wait in the bell:** an agent's proposal waiting on you now leads the bell and *Waiting on you* as a
  decision, with a violet *Proposal: needs your decision · N choices* chip, so one with no comment no longer sits
  unnoticed in Proposed. It goes when you decide it and can't be cleared before. `GET /notices` carries it as
  `{id: 0, asks: "decision", proposal: {choices}}`.
- **Docs first for agents:** every place that tells an agent how to work (the channel, focus and chunk prompts,
  CLAUDE.md, CONTRIBUTING) says to read the docs a task touches before the code, and to fix a doc that turns out
  wrong. `GET /projects/:project/docs` gives each doc a `summary` and takes `?q=` (every word, title hits first,
  each with a `match` snippet); the channel's `docs` tool takes `q` too.
- **A session on several projects goes by its bare name:** a made-up name no longer starts with the project it's
  filed under (`Odin`, not `switchboard · Odin`), and is unique across every session. It gets `<project> · …`
  back once it hears one project; a name the session or its hooks give is kept.
- **The UI builds on Headless UI:** dialogs and ⌘K, pickers, filter menus, segmented controls and the focus menu
  get their keys, focus trapping and ARIA from `@headlessui/vue`, and look as before. In a picker ↑/↓ stop at
  the ends and Tab picks the lit option; Esc in a dialog always closes it. A chunk's *Focus on all → All N
  sessions* now sends to every session, where it sent to one. `docs/components.md` maps each piece to its part.
- **Not-found pages in one look:** an unknown URL, project, issue, chunk, release or doc shows the same block
  inside the app, with the sidebar, a way back and a "Not found" tab title, instead of Nuxt's bare 404 and six
  hand-written variants.
- **No native selects left:** the Schedules filter, Sessions setup, project Releases, a chunk's priority and
  status removal use the app's picker, so none opens the system's grey menu.
- **One violet for waiting:** the bell's *Needs your decision* chip, and a waiting card's ring, are the same violet
  as on rows, cards and the issue page, where they were amber.
- **The waiting question renders its Markdown:** the quote at the top of Activity shows bold, code and links as
  the comment below does, still cut to three lines; a click (not on a link) or Enter shows it in the thread.

### Fixes

- **Phone fixes:** a waiting row shows the chip's violet dot alone and the sub-issue progress steps aside, so the
  title gets the room; the toolbar's search fills its line; an issue's header keeps its id, Copy and Copy ref whole
  (icons alone on a phone), with Team tasks' Edit beside its chips.
- **Connect wraps at spaces:** the line to paste no longer breaks in the middle of words.
- **Schedules' empty state:** a dashed box whose **Make one** opens the New schedule dialog, instead of naming a
  button that's gone.
- **The playground seeds again:** since rc.6 `play reset` stopped after Primes; the start limit now goes in the
  settings.

### Docs

- **Docs brought up to rc.7:** README and `docs/` checked against the code, and `docs/API.md` against every route.
- **The session limit is over every project:** Starting sessions' guide said per project.
- **The team's tracker, unnamed:** the tracker setting, its hint and the docs give
  `https://tracker.example.com/issue/{id}` as the example.

### Internal

- **Cleanup:** values only their own file uses are no longer exported, so Nitro stops auto-importing them across
  the server.

## 1.0.0-rc.7 (2026-10-27)

### Features

- **Waiting on you:** when an agent asks you for a decision or feedback, the issue says so until you answer: a
  violet "Needs your decision" (or feedback) chip and tint on its row and card, the question quoted at the top of its
  Activity with Answer, and *Waiting on you* first on My issues. Through the API an issue carries
  `waiting: "decision" | "feedback"`.
- **Sessions across projects:** a session that hears several projects (`ORRERY_PROJECTS=a,b` or `*`) is listed once,
  in an **Across projects** group on the Sessions page with chips for what it hears, and each project says it also
  hears it. The sidebar labels it *All projects* or *N projects*. A focus, chunk focus or schedule message aimed at no
  session goes to one of the project's own idle sessions first; a spanning session takes it only when none is free.
- **New session on this:** an issue's Claude sessions panel can start a fresh session on it, through the launcher,
  while others are listening, when the limit has room; before, it could only start one when none was listening.
- **Skip a message when nothing changed:** a message schedule can skip a run unless an issue or comment in its project
  changed since the last message it sent (`only_if_changed`, off by default), so a frequent nudge stops waking an idle
  session for nothing. *Run now* always sends. The database gains a column for it, migrated on start.
- **Where the data is:** App settings → Database shows the SQLite file and its backups, or the Postgres database as
  `user@host:port/name` (never the password), each with Copy, and how to move. `GET /api/settings` carries
  `database: {kind, where, backup?}`.
- **Pictures open over the page:** clicking a picture in a description or comment (or a slider's Before/After label)
  opens it larger over the dimmed page; a click, Esc or ✕ closes it. Open original and ⌘-click still open a tab.

### Changes

- **Sessions and Setup tabs:** the Sessions page has two tabs. Sessions shows what's running, by project; Setup
  holds starting sessions, what sessions hear and presets. A link to a setup section (Start session's Presets,
  Getting started's *turn it on*) opens Setup, and with no sessions running the empty note links there too.
- **Session settings in one place:** What sessions hear and Presets each have a **For** picker on the Sessions
  page, every project or one project's own, and leave a project's Settings. A project's own standing
  instructions stay editable there.
- **A claimed issue stays with its session:** another session's comment, comment edit or issue edit on an issue a
  listening session has started is a 409, as starting it already was. Closing it, and the owner's writes, are never
  refused, and a chunk's issue list tells each session which issues another one holds.
- **App settings in tabs:** **You**, **Issues** (statuses, proposals, tracker) and **This Orrery** (tint, secrets,
  database), each saying what it reaches; a link to a section opens its tab. Watching sessions moves to Sessions →
  Setup.
- **The board shows only the statuses filtered for:** a status unticked in the Column filter has no column, unless a
  card is still in it. Done and Canceled, unticked by default, are off the board until ticked or the filter is cleared.
- **New schedule picks its project:** the Schedules toolbar's New schedule is a button, and the project is picked in
  the dialog, with the same searchable picker as its other fields.
- **Remove a schedule without right-clicking:** its dialog has Remove, asking once more, and each row has a ⋯ with the
  right-click menu.
- **Play and pause on each schedule:** a round button leads each schedule's row, filled with pause while it runs
  and outlined with play while it's paused, so you can see at a glance whether it runs.
- **One Start session on the Sessions page:** the per-project Start session buttons are gone; the toolbar's dialog
  already picks the project and says when one can't start.
- **Release steps look like where they lead:** Freeze features is amber with a snowflake, Thaw features has a sun,
  and Mark shipped today is green with a tick.

### Fixes

- **A project shows its issues on a slow start:** the issue filters waited for no statuses and ticked Proposed
  alone, so a project could show no issues until Clear. They're set once the statuses arrive.
- **A dialog's field is focused the first time:** pressing `c` (or opening New project, chunk or schedule) the
  first time focused nothing, so typing or Esc did nothing; the field is focused from the first open now.
- **Saved schedules keep running on croner 11:** a step after a number (`5/10`) is still read as from 5 every 10.
- **No local env files in the image's build:** `.env.*` files and the playground's data stay out of the Docker
  build context.

### Internal

- **More tests:** component tests (the proposal choices, the Approve panel, the property picker, the owner, new
  issue, message, start session and schedule dialogs, ⌘K's keys, the row tick, the filter menu and the issue menu),
  e2e for the keys and the phone layout, screenshot checks of the board, the list and an issue's page, and the e2e
  flows run on Postgres as well as SQLite.
- **Cleanup:** the app and server are linted with eslint in CI, non-null assertions are guards (new ones fail
  lint), helpers only their file uses aren't exported, and an issue's activity is its own component.
- **Dependencies:** `nuxt`, `marked` and the MCP SDK patches, `croner` 11 and `eslint` 10.

## 1.0.0-rc.6 (2026-10-27)

### Features

- **Message every session at once:** Message sessions on the Sessions page says one thing to every listening
  session, idle ones by default so a nudge doesn't interrupt work, narrowed to some projects if you like, and shows
  who it reaches before you send. A session that hears several projects gets it once. Through the API it's
  `POST /api/sessions/message {text, projects?, states?}`, the owner's only.
- **Agents keep off a waiting proposal:** while a proposal waits on the owner, an agent can comment on it, edit it
  and put it up again, but changing its status, assignee or release is a 403 until the owner approves it. It's one
  setting in App settings → Proposals, on by default, and the board's Proposed column shows a lock while it's on.
- **Presets read as roles:** each preset has a badge, an icon and colour you pick (its initials until you do), and
  shows as a card: in Presets (click one to edit its name, text and badge; New preset is an empty card) and in
  Start session (picked with a tick). A session started with presets shows their badges by its name. Through the
  API a preset takes `icon` (a Heroicon's name) and `color` (a tint or `#rrggbb`).

### Changes

- **The session limit is a total:** "At most N" counts every session Orrery started or is starting, whatever the
  project; `GET …/launches` adds `total`. **Breaking:** it used to be per project.
- **A focus goes to one session:** a focus, a chunk's or a schedule's message aimed at no session goes to one
  session, not every one: the session already on the issue, else an idle one, else the next to go idle (within a
  day). The issue and chunk menus offer *Ask all N sessions* beside *Ask a session*; through the API it's
  `{session: "*"}`. Comments keep their route: the session on the issue, else every session.
- **One stream per session:** a channel on several projects follows them all on one stream,
  `GET /api/signals/stream?projects=hub,css` (or `*`, which picks up projects made later too), so it registers
  once and marks a signal delivered once. On an older Orrery it falls back to a stream per project.
- **One Sessions page:** Start session lands on `/sessions`, and the Sessions page has no project picker any more.
  `?project=` and the `/p/:project/sessions` tab are gone; a sidebar row links to `/sessions#session-<id>`.
- **Schedules by project:** each project's schedules sit in a card headed by the project (icon, name, running or
  paused, its own New schedule), and each row says whether it makes an issue or messages sessions, with the first
  line of its notes.
- **Tidier session settings:** each message template on the Sessions page says what it's for and whose it is, with
  Preview and Edit; its text opens on Edit. A project's Settings tab gets the same.
- **Pictures in a frame:** a picture in an issue, a comment or a doc sits in a frame (a band of the well colour, a
  hairline and a soft shadow), so a screenshot doesn't read as more of the page. The Before/After slider gets the same.

## 1.0.0-rc.5 (2026-10-26)

### Features

- **Getting started:** a new Orrery opens on a checklist that ticks itself as it happens: a project, a folder
  connected (any folder, an empty one to try it), a session listening, work sent. *Just planning? You're set*
  finishes it after the project. *Try it with a demo project* makes a sample board to look around
  first. Until it's done it's a card at the top of Now; **Hide** puts it away, and ⌘K → *Getting started* brings it
  back (`/getting-started`).
- **Feature freeze:** a release can have a freeze day (`frozen_on`, Freeze features / Thaw on its page). From
  then on it shows "Frozen <day>", its pickers say "· frozen", and a focus on its work tells the session to put a
  new feature on the next release. Nothing is refused. A new migration step adds the column.
- **Watch a started session live:** a session Orrery started shows its screen on the Sessions page, refreshed
  while you look (read-only; its launcher captures the tmux pane).
- **A launcher serves every channel in a repo:** a monorepo whose `.mcp.json` has a channel per project
  (`orrery-hub`, `orrery-css`, …) installs all of them with one `--install`, each project's sessions load the
  channel that serves it, and each on its own channel's Orrery. `--install --list` shows what a repo would register.
  A project `ORRERY_PROJECT` names but no channel lists goes on `ORRERY_URL`, else the first channel's Orrery.
- **Tick many at once:** drag over the ticks to tick (or untick) a run, tick a whole list group or board column
  from its header, and the bulk bar says how. A drag let go outside the window ends there.

### Changes

- **A run carries on after a clear:** a session Orrery started and then cleared partway through a chunk or
  scope gets a focus on what's left, to it alone, so it carries on instead of waiting. A focus on one issue
  ends the run it was on. A session that won't take any of what's left (blocked, or waiting on the owner) is
  sent it again only when something in it changes, not every few seconds.
- **Session settings on the Sessions page:** Starting sessions, What sessions hear and Presets moved there from
  App settings, beside the sessions they're about, with a contents list on a wide screen.
- **Faster first load:** each Heroicon loads when it's shown, and each dialog the first time it opens, so a
  page's first load is about a third smaller (510 KB of JS to 340 KB).
- **Find the issue to focus on as you type:** Start session's issue and release are the picker the issue page
  uses: type part of an id or title, ↑↓ and ↵ to pick.
- **Pickers in New issue and the schedule dialog:** Where, Priority, Chunk and the schedule's Repeats are the
  picker the issue page uses, with the status and priority icons: type to narrow, ↑↓ and ↵ to pick.
- **One set of UI components:** buttons, dialogs, menus and confirmations come from a small kit
  (`components/ui/`), listed with the other shared pieces in [docs/components.md](docs/components.md). Disabled
  buttons, quiet icon buttons and the red remove buttons now look the same everywhere.
- **Last sent keeps up:** a session's card on the Sessions page shows a message you just sent it.
- **Docs A–Z:** a project's docs are listed by title on the Docs page and in `GET …/docs` (and the `docs` tool),
  not in the order they were made.

### Fixes

- **A second launcher leaves the first one's sessions alone:** each session keeps its launcher's pid, so a launcher
  run next to the service no longer takes its sessions over and stops them when it exits. A session is taken back
  only from a launcher that's gone (a reused pid doesn't count), and of two launchers starting together only one
  adopts it.
- **A focus doesn't take a started issue:** a focus aimed at one session no longer moves an issue another
  listening session has started; the session asked gets the claim's 409 if it tries to start it.
- **The restart command loads the channel:** the "can't hear signals" command named the server
  `server:<project>`; it names it as the channel reports it's called (`?server=` on the stream, `server` on a
  session), else `orrery-<environment>`, as Connect does.
- **The channel knows it's a channel:** it looks for its Claude Code log under the name Connect gives it, so with an
  environment such as `Work` or `my laptop` it no longer reports `unknown`, and reads the newest log across its
  own names, so a stale one under an old name doesn't hide the current one.
- **A session on several projects is listed once:** the sidebar and the Sessions page show it under its own
  project (the one its hooks name), saying which others it's also on; filtered to one of those, it's still found.
- **Old status words in a focus:** a chunk focus with `doing` or `now` keeps to the issues it means; it matched none.
- **Smaller fixes:** a preset whose name or text is only spaces is refused, not saved empty. Start session's
  preview with only a release picked shows Todo and In progress, as the server sends. A receipt that couldn't be
  saved answers 409 instead of reporting it saved. A starts limit typed just after ticking the box isn't undone by
  the live update.

### Docs

- **The quick start lists everything it needs:** Node 24 and pnpm for the channel, hooks and launcher, which run
  from the clone outside Docker, and tmux only for starting sessions.

### Internal

- **More e2e:** the flows cover starting sessions, the Sessions page and messaging a session, Focus on this
  starting one, presets, schedules, the bell, Now, My issues, Connect, Getting started and a session on two projects (27 flows, from 18). In CI
  they run in Playwright's own image, rather than installing the browser's system libraries on every run.
- **Cleanup:** one text field style, one way menus close on an outside press, and the store split into a file per
  domain behind the same `Store`. [docs/development.md](docs/development.md) maps where things live now.
- **Dependencies:** `pg` 8.23, `marked` 18.1.1, `dompurify` 3.4.17 and `@playwright/test` 1.64, and the GitHub
  Actions at their current majors.

## 1.0.0-rc.4 (2026-10-26)

### Features

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
- **Focus on this starts a session:** with nobody listening, when Orrery may start sessions and a launcher is
  there, the issue page offers Focus on this (starts a session), and a chunk Work through this.
- **Your own context for a session:** Start session takes presets (a saved name and text, the Orrery's and
  each project's own, under App settings and project Settings) and your own words. They go with every
  signal to the session and come back in its SessionStart brief, as it starts and after a `/clear` or a
  compaction. `/api/presets` and `/api/projects/:project/presets`; `POST …/launches` takes `presets` and
  `instructions`.
- **A fresh context between pieces of work:** once a session Orrery started goes idle with nothing in
  progress and no signal waiting, its launcher types `/clear` into it, and the brief after hands it what's
  left of the chunk or scope it was working through.
- **Message one session:** a listening session's card takes a message, which goes through its channel to it
  alone. `POST /projects/:project/sessions/:session/message {text}`.
- **Watch opens a terminal:** Watch on a session Orrery started has its launcher open a terminal window attached
  to it, in the app picked under App settings → Watching sessions (Terminal, iTerm2, Warp or Ghostty on macOS).
- **Edit and delete your own comments:** the owner's comments on an issue page have Edit and Delete. An edit
  that changes the words goes to the session on the issue again, saying it replaces the earlier comment.
- **Sessions and schedules across projects in the sidebar:** under Connect an agent, Sessions opens every
  project's sessions, and Schedules a new page with every project's schedules in one agenda, each saying
  its project; a new one is made in the project picked.
  Start session and New schedule sit on a toolbar on those pages.

### Changes

- **Breaking, starting sessions is one setting:** you let Orrery start sessions once, for every project, under
  App settings → Starting sessions, with its limits (at once on each project, minutes, idle minutes). `PATCH
  /settings {starts}` sets it; `PATCH /projects/:project` no longer takes `starts` (a 400), and a project's
  `starts` reads the Orrery's. The database carries over the first project's setting. A project gets sessions
  wherever its repo has a launcher.
- **Started sessions run until stopped:** a session Orrery starts runs until stopped unless a time is set, and a new idle limit (`starts.idle_minutes`) stops one that sits with nothing to do. Neither stops a
  session mid-work: Orrery waits until it's idle with nothing in progress or waiting, then has its launcher
  stop it. `started.stops_at` and a launch's `minutes` are optional. One still not done well past its time
  (stuck on a prompt, or never going idle) is stopped anyway, its minutes again past it (15 minutes to an hour).
- **One session per issue:** starting an issue another listening session holds gets a 409 naming that
  session, so sessions answering the same nudge no longer take the same issue.
- **Sessions and Schedules in one place each:** a project's Sessions and Schedules tabs are gone. The Sessions
  page shows every session as a full card (Watch, Stop, +30 min, what it's on and was last sent), each project's
  Start session and launcher state, and the setup guide; both pages keep to one project with `?project=`, and
  the old tab addresses go there.
- **A session hears about the issues it makes:** an issue a session creates (a proposal included) or moves
  to another project is linked to it, so the owner's decision on it reaches that session.
- **Ids keep their meaning:** a replacing import continues the issue and chunk counters, signals move with an
  issue to its new id, and a new issue skips numbers still in use as aliases.
- **Releases count a sub-issue where it's set:** a sub-issue set for another release than its parent's
  counts toward its own release on the Releases page, and its work comes out of the parent's.
- **PRs link their issue:** the channel's instructions, `/llms.txt` and the API reference ask agents to put the
  issue's page on the owner's Orrery in the PRs they write.
- **A near miss ticks:** a row's tick takes clicks the row's whole height and a few px either side of
  the box, and a card's a few px around it, so aiming for it no longer opens the issue.

### Fixes

- **One session per issue, even at once:** two sessions starting the same issue at the same moment are taken one
  after the other, so only the first gets it and the other gets the 409.
- **Signals don't slip through a reconnect:** a session's stream hears live signals before reading what it
  missed, so one sent in between arrives once; sessions acking a signal at the same time all count; a failed
  re-read of a project no longer clears it from the page.
- **A schedule's repeats come once:** when a session catches up, or is still busy, a recurring
  message with the same text reaches it once instead of every copy; the others count as delivered.
- **Egress keeps a whole-address secret whole:** a `{{secret:…}}` that starts the url (a webhook) goes in as it
  is, one in the path keeps its `/`, and one in the query is escaped; the hosts check still decides where it may go.
- **A new issue opens straight away:** its page loads the project before saying "No issue", and a live
  stream the browser gave up on is opened again.
- **Smaller fixes:** `docs/API.md` lists every live event; built-in names (`constructor`) are refused as body
  fields; renaming the owner tells open pages; settings, statuses, secrets and schedules changes are backed
  up; a bad escape in an address gives a 404.
- **Smaller review fixes:** the doc texts kept for change tints are capped, an image upload finishing after its
  field was reopened stays out of it, a chunk's remove prompt resets on another chunk, an oversized upload is
  refused before it's read, and a slow doc reply for a page you've left is let go.

## 1.0.0-rc.3 (2026-10-26)

### Features

- **Start a session from anywhere:** a Sessions page lists every project's sessions, and Start session there
  (or the + by the sidebar's Sessions) picks the project, then optionally an open issue for it to focus on
  from the start. Projects that can't start one now say why, with a link to turn starting on.
  `POST …/launches` takes `{issue}`.
- **Many issues at once:** tick issues on any list or board (a row's tick on hover, shift-click for a run,
  `x`, ⌘A for the page, Esc to clear) and a bar changes them together: Approve, Request changes or Reject
  proposals with one note, or set status, priority, assignee, labels, chunk or release, or delete them.
  Each issue goes on its own and the bar lists what was skipped. `PATCH /projects/:project/issues`,
  `POST …/issues/decide` and `DELETE …/issues` take `{ids}`.
- **Shared releases:** a project can take its releases from another (Settings → Releases, or
  `releases_from`), so a monorepo's apps ship in one release. Their issues are set for it, and its page
  shows each project's issues in a section with its progress; a project drawing on it shows its own part
  and links the whole. `GET …/releases/:release` adds `projects`.
- **Team tasks:** an issue links to its tasks on the team's tracker (`external`: `ENG-1567`, or a URL),
  editable under its properties and opening there through App settings → Team tracker
  (`https://linear.app/your-team/issue/{id}`). `?external=` finds the issues linked to a task, and
  `create_issue` and `update_issue` take it.
- **Rearrange releases:** drag a release on the Releases page (or ⌥↑/⌥↓) to move it; `position` on
  `POST` and `PATCH …/releases/:release` sets where it goes. A new release goes on top, and existing ones
  keep the order they had.
- **Whose board an issue is on:** every issue has a reference, `orrery-<handle>: DOC-132`, with a Copy
  ref button by its id and `ref` in the API and the `issue` tool, for commit bodies and PR descriptions.
  App settings take the handle (your GitHub login, say); without one it's your id.
- **The version in the sidebar:** its foot says which version the Orrery runs (`v1.0.0-rc.3`), linking to
  that version's changelog, and the dev server adds `· dev`. A release sets it in `web/package.json`.
- **Build from a release:** `ORRERY_BUILD_CONTEXT` builds the image from a ref on GitHub
  (`https://github.com/steffendybvik/orrery.git#main`) instead of this folder, so the Orrerys you use never
  pick up a branch you have checked out to work on.

### Changes

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
- **Approving a proposal puts it on the roadmap:** no separate Commit. One still in the backlog goes to
  Todo, and one whose work has started or finished keeps its status. It keeps who approved it, the note
  and the picks, and the panel offers Put it up again while it's open. Proposals approved before are
  committed the same way as the database migrates.
- **Finished work stays quiet:** a done or canceled issue is never marked as changed, so a comment on one
  lights up no row, no sidebar dot and no Mark seen count.

### Fixes

- A session Orrery starts for a project's very first signal now gets that signal: an `after` of 0
  is a catch-up too.

## 1.0.0-rc.2 (2026-10-25)

### Features

- **Starting sessions:** a project can let Orrery start sessions itself, in tmux through a launcher on
  the host, when the owner's work finds nobody listening or the owner starts one from the Sessions tab,
  within limits on how many run and for how long. The launcher installs once as a background service
  (`--install`) and serves every project.
- **Stopping sessions:** the owner can stop any session with the Orrery channel running from its Sessions
  tab, terminal ones too: the channel ends its claude process.
- **Releases:** a project's Releases tab lists the versions it ships, each with the branch its work
  gathers on, how far its issues are and whether it shipped; an issue's Release says which one it goes out
  in. A release's page links its branch and PRs (once Settings says where the code is) and drafts its
  changelog from its issues. `GET/POST /projects/:project/releases`, `?release=` on issues, and a
  `releases` tool for sessions.
- **Unseen changes:** issues and docs that changed since the owner last opened them carry a quiet accent
  dot and a bolder title, on rows, board cards, the docs list and the project in the sidebar, until
  opened or cleared with Mark seen. The owner's own changes from the page don't count.
- **Signals:** an issue the owner makes urgent (`P0`, created as one or raised to it) goes out to the
  listening sessions on its own, to the session working it first. So does a `P0` proposal once committed,
  or a closed `P0` issue reopened.
- **Images in comments:** paste, drop or pick an image in the comment box and it goes in as Markdown;
  it opens full size when clicked. Orrery keeps images in its database (`POST /api/uploads`, for agents
  too), so backups and `orrery:copy` take them along. PNG, JPEG, GIF and WebP, up to 10 MB.
- **Images in issues:** the New issue dialog and an issue's description take pasted, dropped or picked
  images too, as the comment box does.
- **Before and after, on a slider:** in a comment, description or doc, a picture whose alt text starts with
  "Before", followed by one starting with "After", shows as one picture at full width with a handle to
  drag between the two (arrow keys too). The labels open each one full size; anywhere else the Markdown
  is still two pictures.
- **Chunks from the page:** New chunk on the roadmap (and in ⌘K) makes one with a title and summary; on
  a chunk's page the title edits in place, the summary has Edit, and the bin removes it (its issues stay,
  in no chunk).

### Changes

- **Starting sessions, across restarts:** a session Orrery started keeps counting against the limit, with
  its time left and +30 min, after Orrery restarts; a launcher that dies takes its sessions back when it
  starts again; and Stop goes through the session's channel when no launcher is there to stop it.
- **Sessions:** a `/clear` or a compaction keeps the session and its channel, and the fresh context is
  told which issues it had in progress, so it carries on with them.
- **Starting sessions on the Sessions tab:** whether Orrery may start a project's sessions, and how
  many at once for how long, moved from its Settings to its Sessions tab, next to Start session.
- **Unseen changes, louder:** a changed issue or doc now tints its row with an accent bar, and its dot is
  bigger; and opening a doc tints the parts that are new or changed since you last read it, with a count
  under its title.
- **Notifications:** the Inbox lists every comment newest first; those waiting on you keep their
  mark among them instead of sitting on top.
- **Easier to read:** an issue row says its status once, as a pill, rather than three times; comments
  and notifications read a size below a doc, under their header line; and toolbar buttons stay on one line.
- **Phones:** the header no longer carries a project's page tabs (they ran under the bell); the menu
  opens a full-screen drawer with bigger rows instead.

### Fixes

- **The owner's protections:** an agent can no longer change or run the owner's schedules (and
  so send its own message as theirs), or name the owner `claude`; a page can't open a session's stream
  (not even as a picture) to mark it not listening; and a malformed `Origin` is a 403 rather than a 500.
- The Connect brief quotes a project's name for the shell, keeps a window's session name to
  letters, digits and dashes, and keeps a name on one line, so a crafted `?name=` or `?session=` can't
  run a command or add to the brief. A new project's id and prefix now match what the store makes.
- Egress no longer leaks a secret at the 1 MB cut, scrubs its JSON-escaped, form-encoded and
  Basic-auth forms too, reads no more of an answer than it gives back, answers 502 when one breaks off,
  and escapes the value for the url or JSON body it goes in. A deleted secret's uses go with it. A
  secret's projects are now said to be a guard against slips, not a boundary.
- **A window with a channel per project:** only the channel of the window's own project decides
  whether it's listening and whether Stop can reach it, so the other projects' channels (skipped by
  Claude Code) no longer turn it off. A skipped one that connects first no longer files the window under
  the wrong project.
- **Sessions across a `/clear`:** `claude --resume` with a cleared window's old id is a session of
  its own instead of taking that window over. A window whose `claude` pid Orrery can't find (an npm
  install) stays one session across a clear, and the pid is now found for those too. What a session
  worked and was sent moves to its new id, so a restart of Orrery doesn't lose it. The resume brief no
  longer goes missing on a big project or gets cut short, and it says what happened (cleared, compacted
  or resumed).
- A cleared session keeps its new id when its channel reports with the old one, can be stopped
  by either, and shows its work under both. A launch that ends before its session connects frees its place
  at once. A signal aimed at one session, or already delivered, no longer starts one. Stop is only offered
  when the channel can end its claude process.
- A proposal keeps the owner's picks when a live update comes in before they approve, and a
  choice an option reveals shows its recommendation ticked, as approving sends it.
- `pnpm orrery:copy` takes secrets and their uses across too.

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
