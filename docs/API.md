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
| `PATCH /projects/:project` | `{name?, key?, description?}` |
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
| `GET /projects/:project/issues` | flat, sub-issues included; filter with `?status= ?plan= ?priority= ?column= ?assignee= ?label= ?chunk= ?parent= ?q=` (`none` for unset) |
| `POST /projects/:project/issues` | `{title, status?, plan?, priority?, assignee?, labels?, notes?, parent?, chunk?, position?}`; gets the next `KEY-n` |
| `GET /projects/:project/issues/:issue` | with column, counts, sub-issues, parent and chunk |
| `PATCH /projects/:project/issues/:issue` | any of the above, plus `project` to move it; `null` clears |
| `DELETE /projects/:project/issues/:issue` | with its sub-issues and comments |

- `status`: `todo` (default) · `doing` · `done`
- `plan` (open issues): `now` · `next` · `later`; none is the backlog
- `priority`: `P0` (urgent, listed under Urgent until done) · `P1` · `P2` · `P3`; `labels`: a list of strings; `assignee`: a name
- A top-level issue is in a `chunk`; a sub-issue (`parent`) is in its parent's chunk, so it takes no `chunk`
- `parent: null` lifts a sub-issue to the top, into the chunk it was in
- `project` moves the issue with its sub-issues and comments; they get that project's ids, their old ones kept as aliases
- `notes` may use inline `` `code` `` and `**bold**`

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
| `POST /projects/:project/issues/:issue/comments` | `{body}` |
| `GET` · `PATCH {body}` · `DELETE /projects/:project/issues/:issue/comments/:comment` | |
| `GET /notices` | agents' latest comments across projects, newest first (the page's bell) |
| `POST /notices/clear` | `{ids}` or `{before}` → `{cleared}`: the owner takes them out of the bell; they stay on their issues |

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

A session listens through the `orrery` channel (`channel/orrery-channel.mjs` in this repo, an MCP
server; start Claude with `--dangerously-load-development-channels server:orrery`), or by watching
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

Computed, never written: a leaf issue that's done is in Done, doing in Doing, else its plan (Now,
Next, Later) or Backlog. A parent issue or a chunk: Done when every leaf is, Doing when any is,
else the soonest column of an open leaf. Counts and progress are leaves only.

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
