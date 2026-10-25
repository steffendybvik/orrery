# Orrery API

Orrery keeps every app's roadmap: projects, their chunks (groups of issues: milestones),
issues with sub-issues to any depth, comments, and docs (Markdown pages). The page at `/` only shows them; everything
changes through this API, and open pages update live.

Base URL: `http://localhost:9000/api` (or the `ORRERY_PORT` the container runs on). Bodies are
JSON. Send `Orrery-Actor: <your name>` on writes (e.g. `claude`): it's recorded as `createdBy`.

## Ids

Orrery hands ids out; you can't pick them. An issue is the project's prefix and a number:
`LAR-142` (the prefix is the project's `key`). A chunk is a number in its project: `3`.
Ids never change, and an issue moved to another project gets that project's next id. Ids things
had before (`MOT-5`, the chunk slug `joints`) are kept as **aliases**: every route and every
`parent` or `chunk` you send accepts them, and responses list them in `aliases`.

## Who can delete what

There's no auth. The owner is whoever gave their name when the Orrery was first opened (`GET /api/owner`
→ `{name, display, named}`; `PUT /api/owner {name}` gives it, anyone the first time, then the owner only).
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
| `POST /projects` | `{name, id?, key?, description?}`: `id` defaults to the name as a slug, `key` (the prefix of its issue ids) to its first three letters |
| `GET /projects/:project` | the project with its board |
| `PATCH /projects/:project` | `{name?, key?, description?, icon?, iconColor?, focusPrompt?, chunkPrompt?, instructions?, muted?, starts?}` (the last five the owner's; `starts` is `{limit, minutes}`, see [Starting sessions](#starting-sessions); see [What sessions hear](#what-sessions-hear)): `icon` is a [Heroicon](https://heroicons.com)'s name (`shopping-cart`), shown in the sidebar; `iconColor` is its colour, `slate`, `blue`, `teal`, `green`, `amber`, `rose`, `violet` or a `#rrggbb` (none follows the text); `null` clears either |
| `DELETE /projects/:project` | with its chunks, issues and comments |
| `POST /projects/:project/import` | a roadmap in the `roadmap.json` format (chunks of tasks with `status` `todo`/`doing`/`done` and an optional `plan`); its ids become aliases; `?replace=true` to replace what's there |

## Chunks

| | |
|---|---|
| `GET /projects/:project/chunks` | with column, priority, counts and top-level issue ids |
| `POST /projects/:project/chunks` | `{title, summary?, priority?, position?}`; gets the next number |
| `GET /projects/:project/chunks/:chunk` | with its issues |
| `PATCH /projects/:project/chunks/:chunk` | `{title?, summary?, priority?, position?}`; `priority` is `P0`–`P3` (P0 urgent) or `null` |
| `DELETE /projects/:project/chunks/:chunk` | its issues stay, in no chunk |

## Issues

| | |
|---|---|
| `GET /projects/:project/issues` | flat, sub-issues included; filter with `?status= ?priority= ?column= ?assignee= ?label= ?chunk= ?parent= ?proposal= ?q=` (`none` for unset; `status` and `column` take a status's id or a kind; `?proposal=none` is committed work only) |
| `POST /projects/:project/issues` | `{title, status?, priority?, assignee?, labels?, notes?, proposal?, parent?, chunk?, position?}`; gets the next `KEY-n` |
| `GET /projects/:project/issues/:issue` | with column, counts, sub-issues, parent and chunk |
| `PATCH /projects/:project/issues/:issue` | any of the above, plus `project` to move it; `null` clears |
| `DELETE /projects/:project/issues/:issue` | with its sub-issues and comments |
| `POST /projects/:project/issues/:issue/decide` | `{decision, note?}`, the owner only: `approved`, `changes` or `rejected` a proposal → the issue |

- `status`: a status's id (see [Statuses](#statuses)), `backlog` by default. A kind works too and picks its
  first status: `{"status": "started"}` is In progress. The words from before statuses still work:
  `doing` is started, and `todo` with a `plan` (`now`, `next`, `later`) is Todo, with `plan: null` Backlog
- `priority`: `P0` (urgent, listed under Urgent until done) · `P1` · `P2` · `P3`; `labels`: a list of strings; `assignee`: a name, or `owner` for the owner
  (stored as their id, so it shows under their My issues; `?assignee=owner` finds theirs too)
- A top-level issue is in a `chunk`; a sub-issue (`parent`) is in its parent's chunk, so it takes no `chunk`
- `parent: null` lifts a sub-issue to the top, into the chunk it was in
- `project` moves the issue with its sub-issues and comments; they get that project's ids, their old ones kept as aliases
- `notes` may use inline `` `code` `` and `**bold**`

### Proposals

A proposal is an issue that isn't work yet: something put to the owner to approve. It sits in the
**Proposed** column with its sub-issues, out of the counts' progress, until it's committed.

- `proposal: "pending"` (on `POST` or `PATCH`) makes an issue a proposal, or puts one up again after
  the owner asked for changes (clearing their last decision). It's assigned to the owner (their id)
  while it waits on them, whatever `assignee` the request sends, so it's under their My issues
- The owner decides with `POST …/issues/:issue/decide {decision, note?}`; `proposal` becomes
  `approved`, `changes` or `rejected`, with `decidedBy`, `decidedAt` and `decisionNote`. The decision is
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
- Approving doesn't commit it: `PATCH {proposal: null}` does (with a `status` to place it),
  and the issue keeps `decidedBy` and `decidedAt`. An agent can only commit an approved proposal (403
  otherwise); a rejected one stays in Proposed until the owner deletes or commits it

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
| `GET /projects/:project/docs` | without their text |
| `POST /projects/:project/docs` | `{title, body?, id?, position?}`; `body` is Markdown |
| `GET /projects/:project/docs/:doc` | with its Markdown |
| `PUT /projects/:project/docs/:doc` | `{title, body?, position?}`: creates (201) or replaces, for keeping a repo's `.md` file in sync |
| `PATCH /projects/:project/docs/:doc` | `{title?, body?, position?}` |
| `DELETE /projects/:project/docs/:doc` | |

## Comments

| | |
|---|---|
| `GET /projects/:project/issues/:issue/comments` | oldest first |
| `POST /projects/:project/issues/:issue/comments` | `{body, asks?}`: `asks` is `decision` or `feedback` when it waits on the owner. It leads their bell (Clear read leaves it) until they comment on the issue after it; comments then read `answered: true`. An ask assigns the issue to the owner, and their answer gives it back to the agent who asked |
| `GET` · `PATCH {body}` · `DELETE /projects/:project/issues/:issue/comments/:comment` | |
| `GET /projects/:project/issues/:issue/activity` | who changed what on it, oldest first: `{field, before?, after?, createdBy, createdAt}`, where `field` is `created`, `title`, `status`, `priority`, `assignee`, `labels` (JSON lists), `notes` (no values), `chunk`, `parent`, `proposal` or `project` (moved in from `before`) |
| `GET /notices` | agents' latest 30 comments across projects, those waiting on the owner first (the page's bell). `?list=waiting` is every one still waiting; `?list=inbox` (the rest) and `?list=cleared` (`cleared: true`) come newest first, `limit` at a time (50, at most 200), older than the notice `?before=<id>` |
| `POST /notices/clear` | `{ids}` or `{before}` → `{cleared}`: the owner takes them out of the bell; they stay on their issues |

## Schedules

Recurring work in a project. A `message` schedule sends its message (`notes`) to the project's
listening sessions each run, with no issue (a `message` signal; the run is `sent`). Otherwise, at each
time a schedule makes an issue (its title plus the day, e.g.
`Groom the backlog · Mon 26 Oct`), placed as it says and marked with `schedule`, and with `ask` points
the project's listening sessions at it (the owner's schedules only, as with every signal; if no session
is listening, the next to connect within a day gets it). With `skipOpen` (the default) a run is skipped
while the last run's issue isn't done. Missed runs while Orrery was down run once when it's back.

| | |
|---|---|
| `GET /schedules` | every project's, soonest first, paused last |
| `GET /projects/:project/schedules` | the project's |
| `POST /projects/:project/schedules` | `{kind?, title, notes?, cron or at, timezone?, column?, chunk?, priority?, labels?, ask?, skipOpen?, enabled?}`: `cron` is five fields (`0 9 * * 1-5`), `at` a time to run once, `timezone` an IANA zone (the server's by default), `column` the open status its issues start in (an id or a kind; `todo` by default); `kind` is `issue` (default) or `message` (then `notes` is the message, and the issue fields don't apply) |
| `GET` · `PATCH` · `DELETE /projects/:project/schedules/:schedule` | `PATCH {enabled: false}` pauses it; deleting leaves its issues; the owner's can't be deleted by agents |
| `POST /projects/:project/schedules/:schedule/run` | runs it now, even while the last run's issue is open → the run `{at, outcome, issue?, note?}` |

Each schedule carries `nextRun` and its latest `runs`: `made` (with the issue), `sent` (a message), `skipped` or `failed` (with why).

## Secrets

Keys for outside services (GitHub, Stripe, a deploy hook) that agents use without ever seeing them.
The owner sets a secret; nothing gives its value back, not this API, the events or the guide. An agent
asks Orrery to make the request, with `{{secret:NAME}}` where the value goes, and Orrery fills it in,
sends it, and answers with the value scrubbed out. Secrets need `ORRERY_SECRET_KEY` (`NUXT_SECRET_KEY`
without Docker), which encrypts them; without it these routes answer 503.

| | |
|---|---|
| `GET /secrets` | every secret by name: `{name, last4, hosts, projects, lastUsed}`, never a value |
| `GET /secrets/:name` | the secret with its latest `uses` |
| `PUT /secrets/:name` | `{value, hosts, projects?}`, the owner only: sets it, new (201) or replacing. `name` is capitals, digits and `_` (`STRIPE_KEY`); `hosts` the host names it may go to (`api.stripe.com`, with a port if not 443); `projects` the projects that may use it (none: every one) |
| `PATCH /secrets/:name` | `{hosts?, projects?}`, the owner only: only narrows them. Letting it go somewhere new takes the value again (`PUT`), so whoever doesn't know it can't send it elsewhere |
| `DELETE /secrets/:name` | the owner only; its uses stay on record |
| `POST /egress` | `{url, method?, headers?, body?, project?, issue?}` → `{status, headers, body, truncated?, secrets}`: the request made with each `{{secret:NAME}}` filled in (in the url, a header or the body) |

- **Only to its hosts.** Every secret in a request must allow the url's host, and it must be https;
  anything else is a 403 and nothing is sent. A secret kept to some `projects` needs the `project` it's for.
- **Only with a secret.** A request with no `{{secret:NAME}}` is refused: egress isn't a general proxy.
- **What comes back.** The status, the headers (no `set-cookie`) and the body as text, cut at 1 MB.
  The value is scrubbed out wherever it shows (as it is, URL-encoded, or in base64), back to its
  placeholder. Redirects aren't followed: a 3xx comes back with its `location`. A `body` that isn't text
  goes as JSON. 30 seconds at most.
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
gone, every session does.

| | |
|---|---|
| `POST /projects/:project/issues/:issue/focus` | `{note?, instructions?}` → `{signal, listeners}`: sends it, and says how many sessions heard |
| `POST /projects/:project/chunks/:chunk/focus` | `{note?, status?, instructions?}` → `{signal, listeners}`: the same, for a chunk (`none`: the issues in no chunk); `status` (an open status's id, or `backlog`, `todo` or `started`) narrows it to those issues |
| `GET /projects/:project/signals?after=` | the signals after that id, oldest first; `?issue=` or `?chunk=` for the latest about one |
| `GET /projects/:project/signals/stream` | server-sent `signal` events as they're sent (`?after=` or `Last-Event-ID` to catch up); `?format=text` gives one line each, for the Monitor tool |
| `GET /projects/:project/listeners` | `{count}` of sessions listening |

A session listens through Orrery's channel (`channel/orrery-channel.mjs` in this repo, an MCP
server registered in the repo's `.mcp.json` under the project's id; start Claude with
`--dangerously-load-development-channels server:<project>`), or by watching
the text stream with the Monitor tool. The Connect page at `/connect` hands out both.

## Sessions

The Claude sessions working on a project, live (not stored): their name, what they're doing and
whether they're listening. Hooks report state (`channel/orrery-hook.mjs` on `SessionStart`,
`UserPromptSubmit`, `Stop`, `Notification`, `SessionEnd`); the channel's connection says it's
listening. Both identify the window by `CLAUDE_CODE_SESSION_ID`; `ORRERY_SESSION` names it.

| | |
|---|---|
| `GET /sessions` | every session |
| `GET /projects/:project/sessions` | the project's, each `{id, name, state, since, listening}`; `state` is `idle`, `working`, `waiting` (needs the owner) or `starting` |
| `GET /projects/:project/sessions/work` | `{<session id>: {issues, signals}}`: what each is on, for its Sessions page: the open issues it worked last (newest first, each `{id, title, column, kind, priority}`) and the last five signals that went to it |
| `POST /sessions` | `{id or pid, project, event, name?, cwd?, message?}`: what a hook sends |

### Starting sessions

A project whose owner set `starts: {limit, minutes}` gets sessions started for it, with no terminal: when
the owner's signal (a focus, a comment, a schedule's) finds nobody listening on it, Orrery asks the
project's launcher (`channel/orrery-launcher.mjs`, on the host) to start one in a detached tmux session.
At most `limit` run at once on the project, each stopped after `minutes`; it's set per project, with no
cap over every project. Several signals at once start one
session, and with several launchers the first to claim a launch starts it. Its channel catches up from the
signal it was started for. The owner can also start one by hand (`POST .../launches`, Start session on the
Sessions tab), which catches up from the project's latest signal. Those sessions list with `started: {launch, tmux, stopsAt}`, and count toward
the limits while their channel is connected.

| | |
|---|---|
| `GET /projects/:project/launches/stream` | for the launcher: server-sent `launch` `{id, project, after, minutes, tmux}` (claim it, then start it), `stop` `{id}` and `extend` `{id, stopsAt}` |
| `POST /projects/:project/launches` | 201 the launch: the owner starting a session by hand, through its launcher, catching up from the latest signal; 409 without the project's opt-in, a launcher or room under its limit |
| `GET /projects/:project/launches` | `{launchers, started, starting}`: whether a launcher is there, and the sessions it started and has on their way |
| `POST /projects/:project/launches/:launch/claim` | `{claimed}`: a launcher taking the launch on; only the first gets `true` |
| `POST /projects/:project/launches/:launch/ended` | 204: the launcher saying the launch's session stopped |
| `POST /projects/:project/launches/:launch/stop` | the session: the owner stopping it, through its launcher |
| `POST /projects/:project/launches/:launch/extend` | `{minutes}` → the session: the owner giving it longer, from when it would have stopped |

`POST …/focus` takes `{session}` to reach one session; without it, every session gets
it. Each signal lists the sessions it reached in `deliveredTo`
(`POST /projects/:project/signals/:signal/delivered`, sent by the channel).

### What sessions hear

A focus reaches a session as its `prompt`: a template filled in, with standing instructions after it.
The owner sets them (an agent gets a 403):

- `PATCH /settings {focusPrompt?, chunkPrompt?, instructions?}`: the Orrery's. A template is text with
  placeholders (`{issue}`, `{title}`, `{status}`, `{priority}`, `{chunk}`, `{where}`, `{note}`, `{url}`,
  `{actor}`; a chunk's also `{issues}`), and a line whose placeholders all come out empty is left out.
  `null` or `""` goes back to the default. `instructions` is a list of `{text, on?, id?}`, lines such as
  "commit whenever a piece works"; `on` (true unless sent) ticks one by default. They go where
  `{instructions}` is, or at the end.
- `PATCH /projects/:project {focusPrompt?, chunkPrompt?, instructions?, muted?}`: the project's own
  templates (none follows the Orrery's), its own lines, and `muted`, the ids of the Orrery's lines it
  switches off.
- `POST …/focus {instructions: [ids]}` picks the lines for one send (`[]` for none). Left out, it gets
  the ones ticked by default. The signal keeps their texts in `instructions`.

## For agents

`/llms.txt` says how to use Orrery and lists the projects; `/llms-full.txt` adds this reference;
`/api/guide` is this reference alone. A Claude session with Orrery's server in its `.mcp.json` also
gets it as tools (`issue`, `start_issue`, `comment`, `finish_issue`, … see Connecting a repo), which
make these calls for it. A write that sends `Orrery-Session: <its id>` (the tools do) ties the session
to the issue, so the owner's comments on it go to that session.

## Columns

Computed, never written: a leaf issue that's a proposal (or under one) is in Proposed, else in its
status. A parent issue or a chunk follows its leaves: while any is open, the least-along open status
among them (started before todo before backlog, each in board order); once all are closed, the first
done status among them, or canceled when none was done; Proposed when it holds only proposals.
`column` comes with its `kind`; `counts` are leaves by status and `kinds` the same by kind. Progress
is done out of backlog, todo, started and done: proposals and canceled leaves are left out.

## Errors

`{statusCode, message, data: {problems: […]}}`: 400 for a bad body (unknown fields are refused,
so typos show), 403 for the owner's things, 404, 409 for a taken id.

## Live updates

`GET /events` is a server-sent event stream: `project` (the whole project, after any change),
`removed` (a deleted project's id) and `settings` (the settings with the statuses, after either changes).

## Example

```sh
H='Content-Type: application/json'; A='Orrery-Actor: claude'; O=http://localhost:9000/api
curl -X POST $O/projects -H "$H" -H "$A" -d '{"name": "Larder", "id": "larder", "key": "LAR"}'
curl -X POST $O/projects/larder/import -H "$H" -H "$A" --data @docs/roadmap.json
curl -X PATCH $O/projects/larder/issues/LAR-42 -H "$H" -H "$A" -d '{"status": "in-progress", "assignee": "claude"}'
curl -X POST $O/projects/larder/issues/LAR-42/comments -H "$H" -H "$A" -d '{"body": "Started on `shelf.ts`"}'
jq -Rs '{title: "README", body: .}' README.md | curl -X PUT $O/projects/larder/docs/readme -H "$H" -H "$A" --data @-
```
