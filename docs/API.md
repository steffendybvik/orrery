# Orrery API

Orrery keeps every app's roadmap: projects, their chunks (groups of issues: milestones),
issues with sub-issues to any depth, comments, and docs (Markdown pages). The page at `/` only shows them; everything
changes through this API, and open pages update live.

Base URL: `http://localhost:9000/api` (or the `ORRERY_PORT` the container runs on). Bodies are
JSON, and its fields are snake_case (`created_at`, `icon_color`), as the database's columns are. Send
`Orrery-Actor: <your name>` on writes (e.g. `claude`): it's recorded as `created_by`.

## Ids

Orrery hands ids out; you can't pick them. An issue is the project's prefix and a number:
`GRE-142` (the prefix is the project's `key`). A chunk is a number in its project: `3`.
Ids never change, and an issue moved to another project gets that project's next id. Ids things
had before (`MOT-5`, the chunk slug `joints`) are kept as **aliases**: every route and every
`parent` or `chunk` you send accepts them (and `?parent=`), and responses list them in `aliases`.
A number is handed out once: not again after its issue or chunk is deleted, moved away or replaced by
an import, and not while it's still an alias. Signals follow an issue that moves; those about what's
deleted or replaced go with it.

## Who can delete what

There's no auth. The owner is whoever gave their name when the Orrery was first opened (`GET /api/owner`
→ `{name, display, named}`; `PUT /api/owner {name}` gives it, anyone the first time, then the owner only; not `agent` or `claude`, which agents send).
Their `Orrery-Actor` is that name in lowercase snake case: `Sköll Fenrisson` is `skoll_fenrisson`
(`owner` until a name is given; renaming moves what was theirs to the new id). Don't guess it from
a git name: read it from `GET /api/owner`, or assign to `owner` (below), which always means them. What the owner makes is
`protected`: no one else can delete it, directly or by deleting what holds it (a parent issue,
the project, a replacing import), and no one else can edit the owner's comments. That's a 403.
Docs the owner wrote can still be edited by agents (they keep them current), not deleted.

## Projects

| | |
|---|---|
| `GET /projects` | every project with its counts; `?expand=board` adds boards |
| `POST /projects` | `{name, id?, key?, description?, repo?, release_mode?, releases_from?}`: `id` defaults to the name as a slug, `key` (the prefix of its issue ids) to its first three letters |
| `GET /projects/:project` | the project with its board, docs and releases |
| `PATCH /projects/:project` | `{name?, key?, description?, icon?, icon_color?, repo?, release_mode?, releases_from?, focus_prompt?, chunk_prompt?, instructions?, muted?}` (the last four the owner's; see [What sessions hear](#what-sessions-hear)): `icon` is a [Heroicon](https://heroicons.com)'s name (`shopping-cart`), shown in the sidebar; `icon_color` is its colour, `slate`, `blue`, `teal`, `green`, `amber`, `rose`, `violet` or a `#rrggbb` (none follows the text); `repo` is the web address of its code (`https://github.com/you/shop`), which links a release's branch and PRs; `release_mode` is whether it has releases, `none`, `own` or `shared`, and `releases_from` another project whose releases it ships in (see [Releases](#releases)); `null` clears any of them |
| `DELETE /projects/:project` | with its chunks, issues and comments; a 409 while others take their releases from it |
| `POST /projects/:project/import` | a roadmap in the `roadmap.json` format (chunks of tasks with `status` `todo`/`doing`/`done` and an optional `plan`); its ids become aliases; `?replace=true` to replace what's there (schedules that made issues in a chunk make them in none) |

## Chunks

| | |
|---|---|
| `GET /projects/:project/chunks` | with column, priority, counts and top-level issue ids |
| `POST /projects/:project/chunks` | `{title, summary?, priority?, position?}`; gets the next number |
| `GET /projects/:project/chunks/:chunk` | with its issues |
| `PATCH /projects/:project/chunks/:chunk` | `{title?, summary?, priority?, position?}`; `priority` is `P0`–`P3` (P0 urgent) or `null` |
| `DELETE /projects/:project/chunks/:chunk` | its issues stay, in no chunk |

## Releases

The versions a project ships, and which issues go out in each. Chunks are themes; a release cuts across
them. An issue says which release it ships in with `release` (a version); a sub-issue set for none goes
out with its parent.

Not every project ships, so a project's `release_mode` says whether it has releases: `none` (a new
project's: no releases, and making one or setting an issue's `release` is a 400), its `own`, or `shared`,
another project's. It leaves its own only with none left and nobody drawing on them (a 409), and going
to `none` takes its issues out of the releases they were set for.

A `shared` project takes its releases from another (`releases_from`, which sending alone makes it
`shared`), so a monorepo's apps go out in one shared release: its issues are set for that project's
releases, and it has none of its own. The source must have its own. Its `releases` list
the source's, each counting its own issues; the source's count every project drawing on it. One level
only: a source can't take its releases from another, and a project with releases of its own can't take
another's until they're deleted (a 409; nothing merges). Moving an issue between projects sharing
releases keeps its `release`; changing a project's `releases_from` clears those its new source hasn't.

| | |
|---|---|
| `GET /projects/:project/releases` | in the order they're arranged in, a new one on top: `{version, branch?, notes?, frozen_on?, shipped_on?, issues, kinds}`, where `issues` counts those set for it and `kinds` their progress, sub-issues included (a sub-issue set for another release counts there instead) |
| `POST /projects/:project/releases` | `{version, branch?, notes?, frozen_on?, shipped_on?, position?}` (a 400 on a project taking its releases from another, as for `PATCH` and `DELETE`): `version` is its id (`1.0.0-rc.2`: letters, digits, dots and dashes), `branch` where its work gathers before it ships (`v1.0.0-rc.2`), `frozen_on` the day its features froze (`YYYY-MM-DD`; see below), `shipped_on` the day it shipped (`YYYY-MM-DD`; none while it's being prepared), `position` where it goes in the list (0 the top, the default) |
| `GET /projects/:project/releases/:release` | with the issues set for it as `tasks` (each with its sub-issues), and by project in `projects`: `{project, name, issues, kinds, tasks}`, the project's own first, then on a source each project drawing on it |
| `PATCH /projects/:project/releases/:release` | `{branch?, notes?, frozen_on?, shipped_on?, position?}`; `position` moves it in the list (0 the top); the version doesn't change; `null` clears |
| `DELETE /projects/:project/releases/:release` | its issues stay, set for none, in every project drawing on it too |

A **feature freeze** (`frozen_on`) is a preference, not a lock: from that day the release would rather take
fixes, tests and docs, and a new feature goes on the next one. Nothing is refused. It shows on the release,
in an issue's release picker, and in what sessions hear: a focus on an issue set for it (or a sub-issue going
out with one), or on a release's issues, gets the rule as a line after the standing instructions. It lasts
until the release ships.

## Issues

| | |
|---|---|
| `GET /projects/:project/issues` | flat, sub-issues included; filter with `?status= ?priority= ?column= ?assignee= ?label= ?external= ?chunk= ?release= ?parent= ?proposal= ?q=` (`none` for unset; `status` and `column` take a status's id or a kind, or several comma-separated; `?proposal=none` is committed work only) |
| `POST /projects/:project/issues` | `{title, status?, priority?, assignee?, labels?, external?, notes?, proposal?, parent?, chunk?, release?, position?}`; gets the next `KEY-n` |
| `GET /projects/:project/issues/:issue` | with column, counts, sub-issues, parent and chunk |
| `PATCH /projects/:project/issues/:issue` | any of the above, plus `project` to move it; `null` clears |
| `PATCH /projects/:project/issues` | many at once: `{ids, set?: {status?, priority?, assignee?, chunk?, release?}, labels?: {add?, remove?}}` → `[{id, ok, error?}]`, each issue on its own, so one refused doesn't stop the rest; open pages hear the batch once |
| `POST /projects/:project/issues/decide` | the owner's one decision on many proposals: `{ids, decision, note?}` → `[{id, ok, error?}]`; approving takes each one's recommended picks, and skips one with a choice that has none |
| `DELETE /projects/:project/issues` | `{ids}` → `[{id, ok, error?}]`, each with its sub-issues, under the same protections as one |
| `DELETE /projects/:project/issues/:issue` | with its sub-issues and comments |
| `POST /projects/:project/issues/:issue/decide` | `{decision, note?}`, the owner only: `approved`, `changes` or `rejected` a proposal → the issue |

- `status`: a status's id (see [Statuses](#statuses)), `backlog` by default. A kind works too and picks its
  first status: `{"status": "started"}` is In progress. The words from before statuses still work:
  `doing` is started, and `todo` with a `plan` (`now`, `next`, `later`) is Todo, with `plan: null` Backlog
- `priority`: `P0` (urgent, listed under Urgent until done) · `P1` · `P2` · `P3`; `labels`: a list of strings; `assignee`: a name, or `owner` for the owner
  (stored as their id, so it shows under their My issues; `?assignee=owner` finds theirs too)
- A top-level issue is in a `chunk`; a sub-issue (`parent`) is in its parent's chunk, so it takes no `chunk`
- `parent: null` lifts a sub-issue to the top, into the chunk it was in
- `release`: the version of a release of the project, or of the project it takes its releases from (see [Releases](#releases)); moving the issue to a project that doesn't share them takes it out
- `project` moves the issue with its sub-issues and comments; they get that project's ids, their old ones kept as aliases
- `notes` may use inline `` `code` `` and `**bold**`
- `external`: its tasks on the team's tracker, a list of ids (`ENG-1567`) or full URLs; the Orrery's
  `tracker` (`PATCH /settings {tracker}`, a task's web address with `{id}` where its id goes) links an id;
  `?external=ENG-1567` finds the issues linked to a task
- `ref` (read only, on `GET …/issues` and `GET …/issues/:issue`): what says whose board the issue is on,
  `orrery-<handle>: <id>` (`orrery-steffendybvik: DOC-132`), from the Orrery's `handle` (see [For agents](#for-agents))

### Proposals

A proposal is an issue that isn't work yet: something put to the owner to approve. It sits in the
**Proposed** column with its sub-issues, out of the counts' progress, until it's committed.

- `proposal: "pending"` (on `POST` or `PATCH`) makes an issue a proposal, or puts one up again after
  the owner asked for changes (clearing their last decision). It's assigned to the owner (their id)
  while it waits on them, whatever `assignee` the request sends, so it's under their My issues
- The owner decides with `POST …/issues/:issue/decide {decision, note?}`; `proposal` becomes
  `approved`, `changes` or `rejected`, with `decided_by`, `decided_at` and `decision_note`. The decision is
  also left as the owner's comment (`Approved this proposal.` and the note), so the session on it hears,
  and the issue goes back to whoever proposed it
- **Choices:** a proposal can put questions to the owner instead of a plain yes or no. Send
  `choices: [{key, question, pick, options: [{key, title, body?}], recommended?, from?}]` on `POST` or
  `PATCH`. `pick` is `one` or `any`, `recommended` lists the options you'd pick (ticked for the owner
  to start with), and `from: {choice, option}` makes a choice that goes further down an earlier one's
  option (it only counts if that option is picked). The owner approves with
  `POST …/decide {decision: "approved", picks?: {choice: [options]}}`: a choice left out takes its
  recommendation, a pick-one takes exactly one. The issue keeps `picks`, and the decision comment lists
  them. Or they ask for changes with `explore: {choice, option}`: add a choice `from` that option, then
  put the proposal up again with `proposal: "pending"`
- Approving commits it: it leaves Proposed for Todo (the first status of that kind) if it's still in a backlog
  status, else keeps the status its work got to (started, done), keeping `decided_by`,
  `decided_at`, `decision_note` and `picks`, and `proposal` goes to none. `PATCH {proposal: "pending"}` puts it
  up again. The owner can also commit a proposal without deciding, with `PATCH {proposal: null}` (and a
  `status` to place it); an agent can't (403). A rejected one stays in Proposed until the owner deletes or commits it
- **Proposals are the owner's until they decide** (`restrict_proposals` in `GET /settings`, on unless the owner
  turns it off with `PATCH /settings {restrict_proposals: false}`): while one waits (`pending`, or `changes`
  asked for), an agent can't change its `status`, `assignee` or `release` (403), so no session starts or builds it
  before it's approved. Comments, its notes and choices, and putting it up again stay open

## Statuses

One list for the whole Orrery, in board order. An issue stores a status's `id`; each status has a
`kind`, which is what it means, and Orrery's counts, progress, pages and signals go by kinds, never names.

| Kind | Starts with | Means |
|---|---|---|
| `backlog` | `backlog` Backlog | someday, out of the active list |
| `todo` | `todo` Todo | committed, not started; priority and the chunk say what's first |
| `started` | `in-progress` In progress, `in-review` In review | being worked on, or built and waiting on the owner to look, merge or commit |
| `done` | `done` Done | shipped |
| `canceled` | `canceled` Canceled | dropped or folded into another issue: out of the open counts and out of progress |

Set `in-review` when the work is built and waits on the owner, `canceled` (with a comment saying why)
instead of `done` when it won't ship.

| | |
|---|---|
| `GET /statuses` | `[{id, name, kind, color, position}]`, in board order (also in `GET /settings`) |
| `POST /statuses` | `{name, kind, color?, id?, position?}`, the owner only; `id` defaults to the name as a slug, `color` is a tint's name or `#rrggbb` |
| `PATCH /statuses/:status` | `{name?, kind?, color?, position?}`, the owner only; the id never changes |
| `DELETE /statuses/:status?into=` | the owner only; its issues and schedules move to `into`, needed while it has any; every kind keeps one status |

## Docs

| | |
|---|---|
| `GET /projects/:project/docs` | without their text but with a `summary` (the first paragraph as plain text, about 160 characters), by title, A–Z (a `position` sent with a doc is kept but no longer orders them). `?q=` keeps those with every word of it in their title or text (any order or case), the ones with them all in the title first, each with a `match`: about 160 characters of text around its first hit |
| `POST /projects/:project/docs` | `{title, body?, id?}`; `body` is Markdown |
| `GET /projects/:project/docs/:doc` | with its Markdown |
| `PUT /projects/:project/docs/:doc` | `{title, body?}`: creates (201) or replaces, for keeping a repo's `.md` file in sync |
| `PATCH /projects/:project/docs/:doc` | `{title?, body?}` |
| `DELETE /projects/:project/docs/:doc` | |

## Comments

| | |
|---|---|
| `GET /projects/:project/issues/:issue/comments` | oldest first |
| `POST /projects/:project/issues/:issue/comments` | `{body, asks?}`: `asks` is `decision` or `feedback` when it waits on the owner. It leads their bell (Clear read leaves it) until they comment on the issue after it; comments then read `answered: true`. An ask assigns the issue to the owner, and their answer gives it back to the agent who asked. Until then the issue reads `waiting: "decision"` or `"feedback"` (its latest open ask), and the app marks it on its row, card and page. An agent's proposal waiting on the owner (pending, not under another proposal) reads `waiting: "decision"` too, with no ask of its own open, until they decide it |
| `GET` · `PATCH {body}` · `DELETE /projects/:project/issues/:issue/comments/:comment` | |
| `GET /projects/:project/issues/:issue/activity` | who changed what on it, oldest first: `{field, before?, after?, created_by, created_at}`, where `field` is `created`, `title`, `status`, `priority`, `assignee`, `labels` (JSON lists), `notes` (no values), `chunk`, `parent`, `proposal`, `release` or `project` (moved in from `before`) |
| `GET /notices` | agents' latest 30 comments across projects, those waiting on the owner first (the page's bell), led by agents' proposals waiting on the owner: `{id: 0, issue, title, body: <its notes>, asks: "decision", answered: false, proposal: {choices: <how many>}}`, there until the owner decides it (clearing leaves it). `?list=waiting` is every one still waiting, proposals among them; `?list=inbox` (the rest) and `?list=cleared` (`cleared: true`) come newest first, `limit` at a time (50, at most 200), older than the notice `?before=<id>` |
| `POST /notices/clear` | `{ids}` or `{before}` → `{cleared}`: the owner takes them out of the bell; they stay on their issues |

### Images

A comment (or any Markdown: notes, docs) shows an image Orrery keeps: send it, then put the `markdown`
that comes back in the text. Orrery keeps it in its database, so backups and `orrery:copy` take it along.

| | |
|---|---|
| `POST /uploads` | `{data, name?}`: `data` is a PNG, JPEG, GIF or WebP in base64 (a `data:` URL works too), 10 MB at most; no SVG. → `{id, type, size, url, markdown}`, where `url` is `/api/uploads/<id>` and `markdown` is `![name](url)`. A picture whose alt text starts with `Before`, followed by nothing but one starting with `After` (on the next line, or in the next paragraph), shows as a slider between the two |
| `GET /uploads/:id` | the image |

```bash
curl -s -X POST $ORRERY_URL/api/uploads -H 'Content-Type: application/json' -H 'Orrery-Actor: claude' \
  -d "{\"name\": \"board.png\", \"data\": \"$(base64 < board.png | tr -d '\n')\"}"
```

## Schedules

Recurring work in a project. A `message` schedule sends its message (`notes`) to one of the project's
listening sessions each run, the first one free (see `POST …/focus`), with no issue (a `message` signal; the run is `sent`). Otherwise, at each
time a schedule makes an issue (its title plus the day, e.g.
`Groom the backlog · Mon 26 Oct`), placed as it says and marked with `schedule`, and with `ask` points
the project's listening sessions at it (the owner's schedules only, as with every signal; if no session
is listening, the next to connect within a day gets it). With `skip_open` (the default) a run is skipped
while the last run's issue isn't done; with `only_if_changed`, a message run is skipped (`nothing changed`) when no
issue or comment in the project changed since the last run it sent. Missed runs while Orrery was down run once when it's back.
An `untrusted` message schedule, one whose session reads what others wrote (GitHub issues), never messages the project's
sessions: each run has a launcher start a locked-down session for its message alone, or fails saying why (no launcher,
Starting sessions off, the limit). That session's new issues are made proposals labelled `external`, and its other
writes are refused (403), except comments on those proposals (see [SECURITY.md](../SECURITY.md#bringing-in-what-others-wrote)).

**Presets and sessions.** A message schedule's `presets` (ids of [presets](#presets) its project's sessions can have)
are its message, read at each run, before its own `notes` (which it can then do without); the signal's `preset` is
their names. A `session` schedule, the owner's alone to make (403 for an agent), starts a session each run through the
project's launcher, as `POST …/launches` does, with its `presets` and `notes` as the context. On an event it starts
focused on its subject: an `issue.*` event's issue, or the work in a `release.*` event's release; any other event's
ids are in its words. With Starting sessions off, no launcher or the limit reached, the run is `skipped` saying why.
A run that started one is `sent`. A preset a schedule names that's been deleted fails its run.

**On an event.** Instead of `cron` or `at`, a schedule can run `on` something that happens. An event's type is
`thing.what`. Every change to an issue is `issue.<field>` (`issue.created`, `issue.status`, `issue.labels`,
`issue.release`, `issue.proposal`… and `issue.deleted`). Comments are `comment.added` and `comment.asks`, a session
asking the owner. Releases are `release.created`, `.frozen`, `.thawed`, `.shipped`, `.unshipped` and `.deleted`;
chunks `chunk.created`; docs `doc.created`, `.changed` and `.deleted`. Each kind the [event log](#event-log)
records counts too (`server.error`, `page.error`, `backup.failed`, `session.started`, `launcher.gone`…), even with
Advanced off. A repeat of an open error isn't one. `on` is a type or a pattern, `*` for any part (`release.*`,
`*.failed`, `*`). `on_filter` says what the event must also say:
- `to` / `from`: the value it changed to or from (a status's id or kind, a label added, a release's version).
- `by`: `owner` or `session`.
- `level`: the event log's.

Such a schedule runs once per subject (an issue bounced in and out of a status runs it once; a run that was skipped or
failed doesn't count), not within a minute of its last run (events heard together count as one), and never on what a schedule's run did, nor on what an untrusted schedule's session wrote. Its issue's title ends with the subject (`Review · ORR-12`),
and its description or message ends with what happened by ids, never another's words:
`On issue.status: ORR-12 (in-progress → in-review), by claude.` The change is given only where it's ids or fixed
words (status, priority, chunk, release, parent, proposal); a label or an assignee isn't, nor an agent's name that isn't
a handle (`by an agent`), and the owner is `by the owner`. An event about the Orrery as a whole (a server error)
goes to every project's schedules; any other, only its own project's.
A run's outcome (`schedule.failed`, `schedule.ran`, `schedule.skipped`) is the exception: other schedules hear it,
so an alert on `*.failed` hears a schedule fail, except when the run was itself set off by an outcome.

| | |
|---|---|
| `GET /schedules` | every project's, soonest first, paused last |
| `GET /projects/:project/schedules` | the project's |
| `POST /projects/:project/schedules` | `{kind?, title, notes?, presets?, cron, at or on (with on_filter?), timezone?, column?, chunk?, priority?, labels?, ask?, skip_open?, only_if_changed?, untrusted?, enabled?}`: `cron` is five fields (`0 9 * * 1-5`), `at` a time to run once, `on` an event (above); setting one lets go of the others, `timezone` an IANA zone (the server's by default), `column` the open status its issues start in (an id or a kind; `todo` by default); `kind` is `issue` (default), `message` (then `notes` is the message, after any `presets`, and the issue fields don't apply) or `session` (above) |
| `GET` · `PATCH` · `DELETE /projects/:project/schedules/:schedule` | `PATCH {enabled: false}` pauses it; deleting leaves its issues; the owner's can't be changed or deleted by agents (403) |
| `POST /projects/:project/schedules/:schedule/run` | runs it now, even while the last run's issue is open → the run `{at, outcome, issue?, note?, subject?}`; the owner's, only by the owner. `{"instead": true}` runs it in place of its next run, which is skipped (a one-off is then done; 409 when it has none, as one on an event has none) |

Each schedule carries `next_run` (none for one on an event), its `presets` and its latest `runs`: `made` (with the issue), `sent` (a message, or a session started), `skipped` or `failed` (with why), and an event run's `subject`.

## Secrets

Keys for outside services (GitHub, Stripe, a deploy hook) that agents use without ever seeing them.
The owner sets a secret; nothing gives its value back, not this API, the events or the guide. An agent
asks Orrery to make the request, with `{{secret:NAME}}` where the value goes, and Orrery fills it in,
sends it, and answers with the value scrubbed out. Secrets need `ORRERY_SECRET_KEY` (`NUXT_SECRET_KEY`
without Docker), which encrypts them; without it these routes answer 503.

| | |
|---|---|
| `GET /secrets` | every secret by name: `{name, last4, hosts, projects, last_used}`, never a value |
| `GET /secrets/:name` | the secret with its latest `uses` |
| `PUT /secrets/:name` | `{value, hosts, projects?}`, the owner only: sets it, new (201) or replacing. `name` is capitals, digits and `_` (`STRIPE_KEY`); `hosts` the host names it may go to (`api.stripe.com`, with a port if not 443); `projects` the projects that may use it (none: every one) |
| `PATCH /secrets/:name` | `{hosts?, projects?}`, the owner only: only narrows them. Letting it go somewhere new takes the value again (`PUT`), so whoever doesn't know it can't send it elsewhere |
| `DELETE /secrets/:name` | the owner only; its uses go with it |
| `POST /egress` | `{url, method?, headers?, body?, project?, issue?}` → `{status, headers, body, truncated?, secrets}`: the request made with each `{{secret:NAME}}` filled in (in the url, a header or the body) |

- **Only to its hosts.** Every secret in a request must allow the url's host, and it must be https;
  anything else is a 403 and nothing is sent. A secret kept to some `projects` needs the `project` it's for.
  That keeps a key from being used in the wrong project by mistake; it isn't a boundary, as any caller
  can name any project. The hosts are the boundary.
- **Escaped where it goes.** In the url the value is percent-encoded; in a body sent as JSON it's
  JSON-escaped, and in a form body (`application/x-www-form-urlencoded`) form-encoded. In a header, or a
  text body of any other type, it goes as it is.
- **Only with a secret.** A request with no `{{secret:NAME}}` is refused: egress isn't a general proxy.
- **What comes back.** The status, the headers (no `set-cookie`) and the body as text, cut at 1 MB.
  The value is scrubbed out wherever it shows (as it is, URL- or form-encoded, JSON-escaped, or inside
  base64, as in Basic auth with a user name), back to its placeholder, before the answer is cut. Only
  that much of the body is read. Redirects aren't followed: a 3xx comes back with its `location`. A `body` that isn't text
  goes as JSON. 30 seconds at most. An answer that breaks off is a 502, recorded like any use.
- **Every use is recorded:** the secret, method, host, path (placeholders and all), project, issue,
  who sent it, and the status or why it failed. Never the value.

## Signals to sessions

The owner can ask the Claude sessions on a project to work on an issue now, or to work through a
chunk's open issues (**Focus on this** on its page). Only the owner's signals reach sessions. A chunk's
signal has `chunk` instead of `issue`, and the stream adds its open `issues`, most urgent first. With
`status` (**Focus on all Todo** on a status group of its page) it's only the chunk's issues of that status.

The owner's comment on an issue becomes a `comment` signal for the session working it: the last one
whose hook saw it write to the issue (a curl that PATCHes it, comments on it, …), or that was asked to
focus on it. While that session is listening it alone gets the comment; with none known, or that one
gone, every session does. When the owner changes a comment's words, the new version goes the same way,
starting `(Edited: this replaces their earlier comment.)`.

An issue the owner makes urgent (`P0`, created as one or raised to it) goes out as a `focus` the same way,
without their pressing anything: to the session working it, else to every session. It goes when a `P0`
issue becomes open work, so also when a `P0` proposal is committed or a closed `P0` issue reopened; not for
an agent's P0. A schedule that asks the sessions sends its one focus, saying the issue is urgent.

| | |
|---|---|
| `POST /projects/:project/issues/:issue/focus` | `{note?, instructions?}` → `{signal, listeners}`: sends it, and says how many sessions heard |
| `POST /projects/:project/chunks/:chunk/focus` | `{note?, status?, release?, instructions?}` → `{signal, listeners}`: the same, for a chunk (`none`: the issues in no chunk; `all`: every chunk's); `status` (open statuses' ids, or `backlog`, `todo` or `started`, comma-separated) narrows it to those issues, and `release` (a version) to those set for it, at any depth |
| `GET /projects/:project/signals?after=` | the signals after that id, oldest first; `?issue=` or `?chunk=` for the latest about one |
| `GET /projects/:project/signals/stream` | server-sent `signal` events as they're sent (`?after=` or `Last-Event-ID` to catch up), and `name` `{name}`: what Orrery calls the session, once it's known and again when it changes; a schedule's message sent again with the same text comes once in a catch-up, and not again while the session hasn't finished a turn since the last copy (the copies count as delivered); `?format=text` gives one line each, for the Monitor tool |
| `GET /signals/stream?projects=hub,css` | the same for a session on several projects, on one stream: each `signal` says its `project`; `*` follows every project, and each one made later; `404` for a project that doesn't exist |
| `GET /projects/:project/listeners` | `{count}` of sessions listening |

A session listens through Orrery's channel (`channel/orrery-channel.mjs` in this repo, an MCP
server registered in the repo's `.mcp.json` as `orrery-<environment>`, one per Orrery for all of the repo's
projects in `ORRERY_PROJECTS`, followed on one stream; start Claude with `--dangerously-load-development-channels server:orrery-<environment>`),
or by watching the text stream with the Monitor tool. The Connect page at `/connect` hands out both.
`GET /settings` says the Orrery's `id` (made once, when it first starts) and `environment`: a channel given
`ORRERY_ID` refuses an Orrery with another id. It also says where the data is, read only: `database: {kind, where,
host?, volume?, backup?, backup_host?, backup_volume?, backed_up_at?, size?, backup_size?}`, `kind` `sqlite` (`where`
the file's path, as Orrery opens it) or `postgres` (`where` as `user@host:port/name`, never the password), `backup` the
folder it's backed up to, if any (a Postgres one as a SQLite snapshot). Under Docker, `host` is where the SQLite file is
on the computer (from `ORRERY_DATA`, a relative one from the compose folder) or `volume` the Docker volume it's in, and
`backup_host` / `backup_volume` the same for the backup folder (`ORRERY_BACKUP`); `where` and `backup` stay the paths
inside the container. And `backed_up_at` when the latest backup there was made. `size` is how big it is in bytes (a SQLite file with
its `-wal`, or `pg_database_size` on Postgres) and `backup_size` the backup folder's files together; each is left out when
it can't be read. `movable` says the owner can move it (not when `ORRERY_DATABASE` names Postgres), and `moved` that it
was moved there from App settings. `POST /backups` (the owner's) backs it up now and answers with `database`; 409 without
a backup folder. `backups_settable` is what App settings can change about backups: `folder` (whether they run, and
where) or `switch` (only whether, in Docker); left out when `ORRERY_DATABASE` names Postgres. `backups_off` says the
owner turned them off, `backup_folder` the folder they chose (kept while off), and `backup_default` `NUXT_BACKUP_DIR`.
`PUT /backups {on, folder?}` (the owner's, from localhost, 403 from any other address) sets them: `folder` a full path
instead of `NUXT_BACKUP_DIR`, `null` or none back to it. Turned on, it's backed up there at once, and kept only if that
worked (400 when it can't be, or the folder holds the database); 409 for a folder in Docker, on with nowhere to go, or
when `ORRERY_DATABASE` names Postgres. → `database`.

The owner moves it from localhost (403 from any other address): `POST /database/check {kind: "sqlite", path}` or
`{kind: "postgres", url}` says what's there without changing it, `{kind, where, state, projects?}`, `state` `empty`,
`orrery` (an Orrery's own, with its `projects`), `current` (the one it runs on) or `other` (something else's tables);
400 when it can't be reached. A `path` without a leading `/` is in the data folder. `POST /database/move {kind, path |
url, how}` runs on it from then on, no restart: `how: "copy"` copies everything into an empty one, `"use"` runs on an
Orrery's own as it is; → `{check, copied?, database}`, 409 when it doesn't suit `how`. Where it went is saved before
anything is written there, so a move that can't save it (a full disk) fails and leaves everything on the one before.
The one it leaves stays as it was.
A session heard on several projects is listed on each one's
group on the Sessions page, with the others in `also`. A channel that finds the name its server goes by in the
repo's `.mcp.json` sends it (`?server=`), and the session lists it as `server`, for the command that restarts it with
the channel.

## Sessions

The Claude sessions working on a project, live (not stored): their name, what they're doing and
whether they're listening. Hooks report state (`channel/orrery-hook.mjs` on `SessionStart`,
`UserPromptSubmit`, `Stop`, `StopFailure`, `Notification`, `SessionEnd`); the channel's connection says it's
listening. Both identify the window by `CLAUDE_CODE_SESSION_ID`; `ORRERY_SESSION` names it. One with no name of its
own gets one made up, starting with its project, renamed for a project it moves to; one whose channel is heard on
several projects goes by the name alone, unique across every session, and gets its project back once it hears one. A `/clear`
gives the window a new id while its channel stays connected: the session keeps its name and listening,
and its old ids still find it.

| | |
|---|---|
| `GET /sessions` | every session |
| `GET /projects/:project/sessions` | the project's, each `{id, name, state, since, listening, reachable}`; `state` is `idle`, `working`, `waiting` (needs the owner) or `starting`; `reachable` when its channel is open and knows to end it, so it can be stopped |
| `POST /projects/:project/sessions/:session/stop` | the session: the owner stopping it, one Orrery started through its launcher, any other through its channel, which ends its claude process; 409 when it has no channel running |
| `POST /projects/:project/sessions/:session/message` | `{text, preset?}` → 201 the signal: the owner's own words to that one session, a `message` with it as `target` and no `schedule`, which its channel shows as a message to it alone. With `preset` (the id of one its sessions can have, else a 400) the words are that preset's text as the owner sent it, tweaked or not, and the signal's `preset` keeps its name as it was then, to label it by; 404 for a session not on the project, 409 for one that isn't listening. The owner's running [chat](#chats) sends it for them (`via: "chat"` on the signal), to any session but a chat |
| `POST /sessions/message` | `{text, projects?, states?}` → 201 `{sent: [{project, session, name, signal}]}`: the owner's own words to every listening session at once, each a `message` with it as `target`, as above. Only `idle` ones unless `states` lists others (`working`, `waiting`); `projects` narrows it to sessions on or hearing any of them. A session hearing several projects gets it once; nobody listening is an empty `sent`, and starts no session. The owner's running [chat](#chats) sends it for them, as above |
| `GET /projects/:project/sessions/work` | `{<session id>: {issues, signals}}`: what each is on, for its Sessions page: the open issues it worked last (newest first, each `{id, title, column, kind, priority}`) and the last five signals that went to it |
| `POST /sessions` | `{id or pid, project, event, name?, cwd?, message?, command?, reason?, source?, started?, error?}`: what a hook sends. A `SessionEnd` with `reason: "clear"` keeps the session, and the next `SessionStart` with `source: "clear"` in its `cwd` takes it over when no pid ties them; a `SessionStart` with `source` `clear`, `compact` or `resume` answers with `brief` too, the issues it has in progress, for the hook to hand the fresh context; a session Orrery started with context (`started`, its launch id, from `ORRERY_STARTED`) gets that context in `brief` on every `SessionStart`, its first included. A `Stop` from a listening session that a few seconds later is still idle, with no signal waiting, while an issue it has in progress has sub-issues in backlog or todo (it just split it, say), sends it alone a focus on the most urgent of them, as the owner's, so it carries on; not again for a sub-issue that hasn't changed, and never to a session an untrusted schedule's run started. A chunk or scope it was working through stays its run. A `StopFailure` (a turn an API error cut off, with Claude Code's `error`, `rate_limit` say) puts each issue the session has in progress back in Todo with no assignee, with a comment from `claude` saying why |

### Starting sessions

Once the owner lets Orrery start sessions (`PATCH /settings {starts: {limit, minutes?, idle_minutes?}}`, one setting
for every project; `null` stops it), a project gets sessions started for it, with no terminal: when
the owner's signal (a focus, a comment, a schedule's) finds nobody listening on it, Orrery asks the
project's launcher (`channel/orrery-launcher.mjs`, on the host, installed as a service with `--install`) to start one in a detached tmux session.
A project whose repo has no launcher gets none. Each project shows the setting as its `starts`.
At most `limit` run at once, counted over every project. Each
runs until it's stopped: by the owner, or, when the setting has them, once `minutes` are up or it has sat
idle for `idle_minutes` (1 to 1440 each). Neither stops one mid-work: Orrery waits until the session is
idle with no issue in progress and no signal waiting for it, then has its launcher stop it. Several signals at once start one
session, and with several launchers the first to claim a launch starts it. Its channel catches up from the
signal it was started for. The owner can also start one by hand (`POST .../launches`, Start session on the
Sessions page), which catches up from the project's latest signal. Those sessions list with `started: {launch, tmux, stops_at?, context?}` (no `stops_at`: until stopped), and count toward
the limits while their channel is connected.

One started by hand can be given more context: presets the owner picks (any number, the Orrery's and the
project's own) and their own words. Its `context` is `{presets: [names], instructions?, text}`, `text` being the
presets' texts and then the owner's words. Every signal to the session carries it (`context` on the stream's
`signal`, which the channel adds after the message), and its hook's brief hands it back on every `SessionStart`,
so it holds after a `/clear` or a compaction. Orrery doesn't read anything into it: a "review agent" is a preset
with review instructions in it.

| | |
|---|---|
| `GET /projects/:project/launches/stream?dir=&every=1` | for the launcher, running in the folder `dir` (projects whose launchers share one are in one repo), with `every=1` where its channel serves every project (`*`): server-sent `launch` `{id, project, after, minutes?, tmux, context?, hears?, untrusted?, chat?}` (claim it, then start it with `hears` as its session's `ORRERY_HEAR`, then start it; no `minutes`: until stopped), `stop` `{id}` (the owner stopped it, or it's done and past its time or idle too long), `extend` `{id, stops_at}`, and `clear` `{id}`: one of its sessions went idle with nothing in progress and no signal waiting, so it types `/clear` for a fresh context, and the brief after it hands the session what's left of the chunk or scope it was working through; `watch` `{id, terminal}`: the owner pressed Watch, so the launcher running that session opens a terminal on its machine attached to it, in that app; and `view` `{id}`: the owner is viewing that session's screen, so its launcher sends it (`POST …/screen`) about once a second until told nobody is |
| `POST /projects/:project/launches` | `{issue?, statuses?, release?, presets?, instructions?, hears?}` → 201 the launch: the owner starting a session by hand, through its launcher, catching up from the latest signal; with `issue`, from a focus on it that only this session hears (aimed at `launch-<id>`, which the session takes as one of its ids when it connects); with `statuses` (ids or kinds; `todo` and `started` when only `release` is sent) and `release`, from a focus made the same way on the whole project's issues in them (chunk `all`); `presets` (ids, the Orrery's or the project's) and `instructions` (text) give it context; `hears` (project ids) is what the session hears: the project alone, or it and others whose launchers run in the same folder, as one session (without it, what the repo's channel lists); 400 for another project's preset; 409 without the project's opt-in, a launcher or room under the limit, or for a project in `hears` not served from its folder |
| `GET /projects/:project/launches` | `{launchers, folders, every, started, starting, total}`: whether a launcher is there, the folders its launchers run in, whether one serves every project (so a launch without `hears` hears them all), the sessions it started and has on their way, and `total`, those on every project, which the limit counts |
| `POST /projects/:project/launches/:launch/claim` | `{claimed}`: a launcher taking the launch on; only the first gets `true`. An untrusted schedule's launch (`untrusted: true`) goes only to one that sends `?untrusted=yes`, saying it starts it locked down, and a chat's (`chat: true`) only to one that sends `?chat=yes`, saying it starts it able only to read and answer |
| `POST /projects/:project/launches/:launch/ended` | 204: the launcher saying the launch's session stopped |
| `POST /projects/:project/launches/running` | `{launches: [{id, tmux, stops_at?, context?, untrusted?, chat?}]}` → 204: the launcher, each time it connects, saying which sessions it started still run, so a restarted Orrery counts them as started again, with the context they were given (a launch Orrery still knows keeps its own) |
| `POST /projects/:project/launches/:launch/stop` | the session: the owner stopping it, through its launcher |
| `POST /projects/:project/launches/:launch/watch` | the session: the owner watching it; its launcher opens a terminal attached to it, in the app `GET /settings` names (`terminal`: `terminal`, `iterm`, `warp` or `ghostty`, set with `PATCH /settings {terminal}`; on Linux the system's own terminal); 409 when no launcher is running for the project |
| `GET /projects/:project/launches/:launch/screen` | `{screen, at?}`: the owner viewing its screen, read only, polled about once a second; the launcher sends the tmux pane as text for as long as this is asked for, and `screen` is null until the first comes in; 409 when no launcher is running for the project |
| `POST /projects/:project/launches/:launch/screen` | `{screen}` → `{watching}`: the launcher sending the screen of a session it started; it stops once `watching` is false |
| `POST /projects/:project/launches/:launch/extend` | `{minutes}` → the session: the owner giving it longer, from when it would have stopped; a 409 for one that runs until stopped |

`POST …/focus` takes `{session}` to reach one session, or `{session: "*"}` for every session on the project.
Without it, one session gets it, and Orrery picks which: for an issue, the session already on it if that one is
listening; else whichever listening session is idle when it comes; else, with every one busy, the next to go idle
(within a day). The project's own sessions come first: a session whose channel hears several projects
(`ORRERY_PROJECTS`) gets it only while none of the project's own is listening and idle. A schedule's message goes the same way. A focus on one session makes it the issue's session, unless another listening session has the issue started:
then it stays with that one, and the session asked gets the 409 if it tries to start it. Each signal lists the sessions it reached in `delivered_to`
(`POST /projects/:project/signals/:signal/delivered`, sent by the channel).

### Chats

The owner's **chat** is a Claude session started for them to talk to on the page, with no terminal. It answers
questions about the project (from its code, read only, and the roadmap) and makes issues and comments when asked;
it works on nothing. It counts towards nothing either: it needs only the project's launcher, not starts turned on or
room under the limit; it isn't one of the started sessions the limit or `GET …/launches` counts; it isn't in the
event log; and pages leave it out of their session lists (its session lists with `started.chat`). It runs until the
owner ends it, which closing its pane does. Each message says which page the owner is on (`page`), so it knows what
"this" and "here" are; that goes to its session at the end of the message and isn't kept with it.

Its launcher starts it with `Read`, `Grep` and `Glob` and the channel's tools but `start_issue`, `finish_issue`,
`update_issue`, `write_doc`, `egress`, `secrets` and `resolve_event`, and its own: `reply`, its answer, the
only way what it says reaches the page, `image`, which shows it an image the owner pasted, `edit_issue`, which changes
an issue's title, notes, priority, labels, team tasks, chunk, release or parent when the owner asks, `message_sessions` and
`message_session`, which message other sessions for the owner when they ask in the chat (never on its own; for more
than one session, once the owner has said go to its draft), `update_settings`, which asks the owner to change one
App setting (below), and `create_schedule` and `update_schedule`, which ask them to make a schedule in its project or
change one (pause and resume included). It hears only its chat's messages: no focus, no message to
every session, and nobody listening never wakes it. Its writes are held to making issues (with nobody on them, in Todo
or Backlog as the owner picked beside Send, whatever status it asks for; a proposal stays one), changing an issue's
`title`, `notes`, `priority`, `labels`, `external`, `chunk`, `release` and `parent` (`PATCH` with anything else, `status`
or `assignee` say, is a 403, and no other session's claim on it holds it back), commenting, replying, messaging
sessions and asking to change a setting or a schedule. A message it sends goes as the owner's,
with `via: "chat"` on the signal; the session hears it ending `(Sent by the owner through their chat.)`, and the
Sessions page and the event log (`session.messaged`) say it came through the chat. A chat is kept in memory
while it runs, so it's gone after Orrery restarts.

| | |
|---|---|
| `GET /chats` | the chats running, newest first: `{id, project, started_at, messages: [{id, from, text, images, at}], issues, problem?}`, `from` being `owner` or `claude`, and `images` the ids of uploads pasted with a message. `issues` is where the issues it makes land, `todo` or `backlog` (the first status of that kind), whatever status its session sends. `problem` says why its session can't start (a launcher too old to start a chat was refused it: restart the launcher), until the session connects |
| `POST /chats` | `{project, issues?}` → 201 the chat: the owner starting one, its session on its way (its `id` is its launch's), its issues landing in `issues` (`todo` by default, or `backlog`); 409 without a launcher for the project |
| `GET /chats/:chat` | the chat; 404 once it has ended |
| `PATCH /chats/:chat` | `{issues}` → the chat: the owner choosing where the issues it makes land from now on, `todo` or `backlog`; its own session can't (403) |
| `POST /chats/:chat/messages` | `{text, images?, page?}` → 201 the message: the owner writing in it, with the ids of [uploads](#images) pasted and the page they're on, `{path, title?}` (a path on this Orrery, starting with `/`; 400 otherwise); it goes to the chat's session alone, ending `(The owner is on <path>: <title>.)` |
| `POST /chats/:chat/replies` | `{text}` → 201 the message: the chat's session answering, in Markdown; only that session's (`Orrery-Chat: yes` and `Orrery-Launch: <the chat's id>`) |
| `POST /chats/:chat/requests` | `{setting, value, why?}` → 201 the message: the chat's session asking to change one App setting, `tracker`, `tint`, `restrict_proposals`, `handle` or `advanced` (any other is a 400, as is a value the settings wouldn't take), shown in the chat as `request: {setting, from, to, state: "asked"}` with Allow and Deny. Nothing is saved yet; asking again for the same setting expires the one before. Only that session's |
| `POST /chats/:chat/requests` | `{schedule, id?, why?}` → 201 the message: the chat's session asking to make a [schedule](#schedules) in its project, or to change schedule `id` there. `schedule` holds the fields as Schedules takes them: `kind`, `title`, `notes`, `cron`, `at`, `on`, `on_filter`, `timezone`, `presets`, `column`, `chunk`, `priority`, `labels`, `ask`, `skip_open`, `only_if_changed` and `enabled` (any other, `untrusted` say, is a 403). It's checked as Schedules would check it for the owner (a bad cron, a preset that isn't there or an unknown schedule fails here, not on Allow), and shown in the chat as `schedule: {id?, title, changes: [{field, from?, to}], body, state: "asked"}` with Allow and Deny (a change has `from`, the schedule as it is). Nothing is saved yet; asking again about the same schedule expires the one before. Only that session's |
| `POST /chats/:chat/requests/:message` | `{allow}` → the message, its request `allowed` (the setting saved as asked, logged as `settings.changed` with from → to; or the schedule made or changed as the owner's, through their chat, its `id` then the schedule's) or `denied`; the chat's session hears which. The owner's only, and never a chat session's, so a chat can't allow its own request; 409 once answered, or `expired` (30 minutes unanswered, or asked again) |
| `POST /chats/:chat/end` | 204: the owner ending it; its session is stopped |

### What sessions hear

A focus reaches a session as its `prompt`: a template filled in, with standing instructions after it.
The owner sets them (an agent gets a 403):

- `PATCH /settings {focus_prompt?, chunk_prompt?, instructions?, handle?, tracker?, starts?, terminal?, restrict_proposals?, advanced?}`: the Orrery's (`terminal`: the app Watch opens; `restrict_proposals`: see [Proposals](#proposals); `advanced`: see [Event log](#event-log); `starts`: see [Starting sessions](#starting-sessions)). A template is text with
  placeholders (`{issue}`, `{title}`, `{status}`, `{priority}`, `{chunk}`, `{where}`, `{note}`, `{url}`,
  `{actor}`; a chunk's also `{issues}`), and a line whose placeholders all come out empty is left out.
  `null` or `""` goes back to the default. `instructions` is a list of `{text, on?, id?}`, lines such as
  "commit whenever a piece works"; `on` (true unless sent) ticks one by default. They go where
  `{instructions}` is, or at the end.
- `PATCH /projects/:project {focus_prompt?, chunk_prompt?, instructions?, muted?}`: the project's own
  templates (none follows the Orrery's), its own lines, and `muted`, the ids of the Orrery's lines it
  switches off.
- `POST …/focus {instructions: [ids]}` picks the lines for one send (`[]` for none). Left out, it gets
  the ones ticked by default. The signal keeps their texts in `instructions`.
- A focus on work set for a release in [feature freeze](#releases) gets one more line, saying so.

### Presets

Saved pieces of context, `{id, project, name, text, icon, color}`, the owner gives a session as they start it
(`POST …/launches {presets}`), or sends one that's running as a message (`POST …/sessions/:session/message {text, preset}`). The Orrery's (`project: null`) are for any project's sessions; a project's own
for its sessions only. Each reads as a role: a badge with `icon` (a Heroicon's name, e.g. `shield-check`) in
`color` (a tint's name or `#rrggbb`), or its initials without an icon. Orrery ships a few of its own (Release,
Security audit, Review, Debug an error), added once to each Orrery as it starts, new or upgraded; each has `default`
`{key, changed}`. An upgrade never changes one, and one the owner removed isn't added again. Only the owner makes, changes or removes them (an agent gets a 403); a session reads them
(the `presets` and `preset` tools) to help the owner write one.

| | |
|---|---|
| `GET /presets` | the Orrery's, by name |
| `POST /presets` | `{name, text, icon?, color?}` → 201 a new one of the Orrery's |
| `GET /projects/:project/presets` | those its sessions can have: the Orrery's, then the project's own |
| `POST /projects/:project/presets` | `{name, text, icon?, color?}` → 201 a new one of the project's own |
| `PATCH /presets/:preset` | `{name?, text?, icon?, color?}` (null takes the icon or colour off) → the preset, the Orrery's or a project's |
| `DELETE /presets/:preset` | 204; sessions already started with it keep its text |
| `POST /presets/:preset/reset` | → the preset, back to the name, text and badge Orrery ships it with; 409 for one it doesn't ship |
| `POST /presets/defaults` | → the presets Orrery ships that were removed, added back as it ships them (`[]` for none) |

## For agents

`/llms.txt` says how to use Orrery and lists the projects; `/llms-full.txt` adds this reference;
`/api/guide` is this reference alone, and `/api/guide/using` how Orrery works, page by page (docs/using.md), which the
channel's `guide` tool answers with. A Claude session with Orrery's server in its `.mcp.json` also
gets it as tools (`issue`, `start_issue`, `comment`, `finish_issue`, … see Connecting a repo), which
make these calls for it. An untrusted schedule's session (its launcher sets `ORRERY_UNTRUSTED=yes`) sends
`Orrery-Untrusted: yes` on every write and `untrusted=yes` on its streams, and is held to raising proposals and
commenting on them, whether or not Orrery knows its launch. A chat's session (`ORRERY_CHAT=yes`) sends `Orrery-Chat: yes`
and `Orrery-Launch: <its chat>` on every call and `chat=yes` on its streams, and is held to what a [chat](#chats) does. A write that sends `Orrery-Session: <its id>` (the tools do) ties the session
to the issue, so the owner's comments on it go to that session. Such a write to an issue another session has
started (in progress or in review), while that session is still listening, is refused with a 409: starting it, a
comment or an edit alike, so pick another issue. Closing it (done, canceled) is any session's, and the owner's
writes are never refused. A chunk's list marks such an issue `(another session is on it: skip it)` for the
other sessions. Two sessions starting the same issue at once are taken one after the other, so only the first
gets it.

An issue id is only unique within its Orrery, and an Orrery is one person's board. So when a commit body
or PR description names an issue, write its `ref` (`orrery-steffendybvik: DOC-132`) as a trailer on a
line of its own, never a bare id, and never in a title or branch name. The team's tracker
stays the source of truth: its id goes in that repo's own trailer (`Part of ENG-1567`), and in the issue's
`external`, so the board knows which team task the issue serves. A PR description also links the issue's
page on this Orrery (`/p/<project>/issues/<id>` on its address, `http://localhost:9010/p/doc/issues/DOC-132`),
so the owner can jump from the PR to it. The owner sets the
handle with `PATCH /settings {handle}` (their GitHub login, say; `null` uses their id).

## Event log

What Orrery did and what went wrong, kept in its own database and never sent anywhere, for looking into a
problem. **Errors** are recorded always: a 5xx the server answers with (`server.error`), an error in the page
(`page.error`; an unknown URL isn't one, it only shows Not found), a schedule run or backup that failed (`schedule.failed`, `backup.failed`). **What Orrery did** is
recorded only while the owner has Advanced on (`PATCH /settings {advanced: true}`, App settings → This Orrery):
sessions started, stopped and refused (`session.started`, `session.stopping`, `session.stopped`,
`session.refused`), any session's channel joining and leaving the feed (`channel.connected`, `channel.left`),
launchers coming and going (`launcher.connected`, `launcher.gone`) or refused a launch because
their code is older than it (`launcher.outdated`, a warning: one from before chats offered a chat), schedule runs and skips
(`schedule.ran`, `schedule.skipped`), backups, migrations, moves and server starts (`backup.made`, `backup.set`, `migration.ran`,
`database.created` when a move copies into a new one, `database.moved`, `server.started`), calls through egress
(`egress.called`: who, which secrets, the method, host and status, never a value or path), and who changed what
in the settings and secrets (`settings.changed` with the keys, `secret.set`, `secret.narrowed`, `secret.deleted`
with the name and hosts; never a value). Every request refused with a 403 or 409 (an untrusted session's write, a
proposal's move, the owner's own, an issue another session is on) is a warning, `request.refused`, with who asked,
the route without its query, the status and why. So is **each change to the roadmap**, as an `info` line with the change's
type as its kind and what it was to as its `subject`: `issue.<field>` (`issue.created`, `issue.status`,
`issue.priority`…, `issue.deleted`), `comment.added`, `comment.asks`, `chunk.created`, `doc.created`, `doc.changed`,
`doc.deleted` and `release.<what>` (`release.created`, `release.frozen`, `release.shipped`…). Its message says who did
what (`claude moved ORR-12: todo → done`), and its details hold `by`, `owner`, `from`, `to`, `untrusted` and the
`schedule` whose run made it. No titles, notes or comment text are kept. Advanced also shows the Events page and
counts each new kind of error in the bell.

Each event is `{id, level, kind, project?, subject?, message, details?, count, first_seen, last_seen, resolved_at?, resolved_by?}`,
with `level` one of `error`, `warn`, `info`. Each is a line of its own (`count` 1, `last_seen` its `first_seen`); a
repeat of one not resolved yet (level, kind, project and message) is no news to the bell or the schedules. No request
bodies, headers or secret values are kept: secrets are scrubbed out as they are from an answer, and so are passwords
in addresses and bearer tokens. Info is kept a week, warnings and errors a month; at most 5000 changes to the roadmap
and 5000 of the rest, each the oldest going first.

- `GET /events/log?level=&kind=&project=&subject=&since=&open=1&limit=`: newest first. `level` is one or more,
  comma-separated; `kind` one (`server.error`) or every one under a name (`session`, `issue`); `subject` what a change
  was to (`ORR-12`, a release's version); `open=1` leaves out resolved ones. 200 by default, 1000 at most. A daily schedule can ask for `?level=error&open=1&since=…` and turn what's new
  into issues.
- `POST /events/log/:id/resolve`: it's dealt with, and so are its repeats not resolved yet; the next one like it is news.
  Resolved by anyone but the owner, it keeps their name as `resolved_by`, and the bell still counts it until the owner
  has looked, so a session can't hide an error it caused.
- `POST /events/log {message, stack?, page?, build?, kind?}` → 201: the page reporting its own error (`page.error`, or
  another `kind` under `page.`). Anyone can send one, so it's kept with `details.reported: true`, which the `events`
  tool shows as unchecked, and at most 5 of a kind and 20 in all are taken a minute: a 429 past that.

A session reads it with the channel's `events` tool (`details` for stacks) and marks what it fixed with
`resolve_event`, so the owner can hand Claude a problem to debug.

## Columns

Computed, never written: a leaf issue that's a proposal (or under one) is in Proposed, else in its
status. A parent issue or a chunk follows its leaves: while any is open, the least-along open status
among them (started before todo before backlog, each in board order); once all are closed, the first
done status among them, or canceled when none was done; Proposed when it holds only proposals.
`column` comes with its `kind`; `counts` are leaves by status and `kinds` the same by kind. Progress
is done out of backlog, todo, started and done: proposals and canceled leaves are left out.

## Errors

`{statusCode, message}`: 400 for a bad body, with `data: {problems: […]}` listing what's wrong (unknown
fields are refused, so typos show); 403 for the owner's things; 404; 409 for a taken id.

## Live updates

`GET /events` is a server-sent event stream, for pages to stay current without reloading:

- `ready` (the server's build id) first; a page from another build reloads. `ping` every 25 seconds.
- `project` (the whole project, after any change) and `removed` (a deleted project's id)
- `settings` (the settings with the statuses, after either changes)
- `listeners` and `launchers` (`{project, count}`): sessions listening for signals, and launchers that start them
- `sessions` (`{project, sessions}`), `signal` (one sent), and `notice` (a comment for the owner's bell)
- `schedules` (`{project, schedules}`, after a change or a run) and `secrets` (the list, never a value)
- `chat` (the chat, with `ended` on its last): one of the owner's chats changed
- `logged` (`{event, fresh}`): the [event log](#event-log) recorded or resolved one; `fresh` when it's a row of its own

## Example

```sh
H='Content-Type: application/json'; A='Orrery-Actor: claude'; O=http://localhost:9000/api
curl -X POST $O/projects -H "$H" -H "$A" -d '{"name": "Greenhouse", "id": "greenhouse", "key": "GRE"}'
curl -X POST $O/projects/greenhouse/import -H "$H" -H "$A" --data @docs/roadmap.json
curl -X PATCH $O/projects/greenhouse/issues/GRE-42 -H "$H" -H "$A" -d '{"status": "in-progress", "assignee": "claude"}'
curl -X POST $O/projects/greenhouse/issues/GRE-42/comments -H "$H" -H "$A" -d '{"body": "Started on `shelf.ts`"}'
jq -Rs '{title: "README", body: .}' README.md | curl -X PUT $O/projects/greenhouse/docs/readme -H "$H" -H "$A" --data @-
```
