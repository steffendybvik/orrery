# Orrery API

Orrery keeps every app's roadmap: projects, their chunks (groups of issues, Linear's milestones),
issues with sub-issues to any depth, comments, and docs (Markdown pages). The page at `/` only shows them; everything
changes through this API, and open pages update live.

Base URL: `http://localhost:9000/api` (or the `ORRERY_PORT` the container runs on). Bodies are
JSON. Send `Orrery-Actor: <your name>` on writes (e.g. `claude`): it's recorded as `createdBy`.

## Ids

Orrery hands ids out; you can't pick them. An issue is the project's prefix and a number, like
Linear's: `MSH-142` (the prefix is the project's `key`). A chunk is a number in its project: `3`.
Ids never change, and an issue moved to another project gets that project's next id. Ids things
had before (`MOT-5`, the chunk slug `joints`) are kept as **aliases**: every route and every
`parent` or `chunk` you send accepts them, and responses list them in `aliases`.

## Who can delete what

There's no auth. What the owner makes (requests with `Orrery-Actor` set to `NUXT_OWNER`) is
`protected`: no one else can delete it, directly or by deleting what holds it (a parent issue,
the project, a replacing import), and no one else can edit the owner's comments. That's a 403.
Docs the owner wrote can still be edited by agents (they keep them current), not deleted.

## Projects

| | |
|---|---|
| `GET /projects` | every project with its counts; `?expand=board` adds boards |
| `POST /projects` | `{name, id?, key?, description?}`: `id` defaults to the name as a slug, `key` (the prefix of its issue ids) to its first three letters |
| `GET /projects/:project` | the project with its board |
| `PATCH /projects/:project` | `{name?, key?, description?, icon?, iconColor?}`: `icon` is a [Heroicon](https://heroicons.com)'s name (`shopping-cart`), shown in the sidebar; `iconColor` is its colour, `slate`, `blue`, `teal`, `green`, `amber`, `rose`, `violet` or a `#rrggbb` (none follows the text); `null` clears either |
| `DELETE /projects/:project` | with its chunks, issues and comments |
| `POST /projects/:project/import` | a roadmap in mesher's `docs/roadmap.json` format; its ids become aliases; `?replace=true` to replace what's there |

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
| `GET /projects/:project/issues` | flat, sub-issues included; filter with `?status= ?plan= ?priority= ?column= ?assignee= ?label= ?chunk= ?parent= ?proposal= ?q=` (`none` for unset; `?proposal=none` is committed work only) |
| `POST /projects/:project/issues` | `{title, status?, plan?, priority?, assignee?, labels?, notes?, proposal?, parent?, chunk?, position?}`; gets the next `KEY-n` |
| `GET /projects/:project/issues/:issue` | with column, counts, sub-issues, parent and chunk |
| `PATCH /projects/:project/issues/:issue` | any of the above, plus `project` to move it; `null` clears |
| `DELETE /projects/:project/issues/:issue` | with its sub-issues and comments |
| `POST /projects/:project/issues/:issue/decide` | `{decision, note?}`, the owner only: `approved`, `changes` or `rejected` a proposal → the issue |

- `status`: `todo` (default) · `doing` · `done`
- `plan` (open issues): `now` · `next` · `later`; none is the backlog
- `priority`: `P0` (urgent, listed under Urgent until done) · `P1` · `P2` · `P3`; `labels`: a list of strings; `assignee`: a name
- A top-level issue is in a `chunk`; a sub-issue (`parent`) is in its parent's chunk, so it takes no `chunk`
- `parent: null` lifts a sub-issue to the top, into the chunk it was in
- `project` moves the issue with its sub-issues and comments; they get that project's ids, their old ones kept as aliases
- `notes` may use inline `` `code` `` and `**bold**`

### Proposals

A proposal is an issue that isn't work yet: something put to the owner to approve. It sits in the
**Proposed** column with its sub-issues, out of the counts' progress, until it's committed.

- `proposal: "pending"` (on `POST` or `PATCH`) makes an issue a proposal, or puts one up again after
  the owner asked for changes (clearing their last decision)
- The owner decides with `POST …/issues/:issue/decide {decision, note?}`; `proposal` becomes
  `approved`, `changes` or `rejected`, with `decidedBy`, `decidedAt` and `decisionNote`. The decision is
  also left as the owner's comment (`Approved this proposal.` and the note), so the session on it hears
- Approving doesn't commit it: `PATCH {proposal: null}` does (with a `plan` or `status` to place it),
  and the issue keeps `decidedBy` and `decidedAt`. An agent can only commit an approved proposal (403
  otherwise); a rejected one stays in Proposed until the owner deletes or commits it

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
| `POST /projects/:project/issues/:issue/comments` | `{body, asks?}`: `asks` is `decision` or `feedback` when it waits on the owner. It leads their bell (Clear read leaves it) until they comment on the issue after it; comments then read `answered: true` |
| `GET` · `PATCH {body}` · `DELETE /projects/:project/issues/:issue/comments/:comment` | |
| `GET /notices` | agents' latest comments across projects, newest first (the page's bell) |
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
| `POST /projects/:project/schedules` | `{kind?, title, notes?, cron or at, timezone?, column?, chunk?, priority?, labels?, ask?, skipOpen?, enabled?}`: `cron` is five fields (`0 9 * * 1-5`), `at` a time to run once, `timezone` an IANA zone (the server's by default), `column` where its issues start (`backlog`, `later`, `next`, `now` (default), `doing`); `kind` is `issue` (default) or `message` (then `notes` is the message, and the issue fields don't apply) |
| `GET` · `PATCH` · `DELETE /projects/:project/schedules/:schedule` | `PATCH {enabled: false}` pauses it; deleting leaves its issues; the owner's can't be deleted by agents |
| `POST /projects/:project/schedules/:schedule/run` | runs it now, even while the last run's issue is open → the run `{at, outcome, issue?, note?}` |

Each schedule carries `nextRun` and its latest `runs`: `made` (with the issue), `sent` (a message), `skipped` or `failed` (with why).

## Signals to sessions

The owner can ask the Claude sessions on a project to work on an issue now, or to work through a
chunk's open issues (**Focus on this** on its page). Only the owner's signals reach sessions. A chunk's
signal has `chunk` instead of `issue`, and the stream adds its open `issues`, most urgent first.

| | |
|---|---|
| `POST /projects/:project/issues/:issue/focus` | `{note?}` → `{signal, listeners}`: sends it, and says how many sessions heard |
| `POST /projects/:project/chunks/:chunk/focus` | `{note?}` → `{signal, listeners}`: the same, for a chunk (`none`: the issues in no chunk) |
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
| `POST /sessions` | `{id or pid, project, event, name?, cwd?, message?}`: what a hook sends |

`POST …/focus` takes `{session}` to reach one session; without it, every session gets
it. Each signal lists the sessions it reached in `deliveredTo`
(`POST /projects/:project/signals/:signal/delivered`, sent by the channel).

## For agents

`/llms.txt` says how to use Orrery and lists the projects; `/llms-full.txt` adds this reference;
`/api/guide` is this reference alone.

## Columns

Computed, never written: a leaf issue that's a proposal (or under one) is in Proposed; done is in
Done, doing in Doing, else its plan (Now, Next, Later) or Backlog. A parent issue or a chunk: Done
when every committed leaf is, Doing when any is, else the soonest column of an open leaf, and
Proposed when it holds only proposals. Counts and progress are leaves only, and progress leaves
proposals out.

## Errors

`{statusCode, message, data: {problems: […]}}`: 400 for a bad body (unknown fields are refused,
so typos show), 403 for the owner's things, 404, 409 for a taken id.

## Live updates

`GET /events` is a server-sent event stream: `project` (the whole project, after any change) and
`removed` (a deleted project's id).

## Example

```sh
H='Content-Type: application/json'; A='Orrery-Actor: claude'; O=http://localhost:9000/api
curl -X POST $O/projects -H "$H" -H "$A" -d '{"name": "mesher", "key": "MSH"}'
curl -X POST $O/projects/mesher/import -H "$H" -H "$A" --data @docs/roadmap.json
curl -X PATCH $O/projects/mesher/issues/MSH-42 -H "$H" -H "$A" -d '{"status": "doing", "assignee": "claude"}'
curl -X POST $O/projects/mesher/issues/MSH-42/comments -H "$H" -H "$A" -d '{"body": "Started on `joints.rs`"}'
jq -Rs '{title: "README", body: .}' README.md | curl -X PUT $O/projects/mesher/docs/readme -H "$H" -H "$A" --data @-
```
