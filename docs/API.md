# Orrery API

Orrery keeps every app's roadmap: projects, their chunks (groups of issues, Linear's milestones),
issues with sub-issues to any depth, comments, and docs (Markdown pages). The page at `/` only shows them; everything
changes through this API, and open pages update live.

Base URL: `http://localhost:9000/api` (or the `ORRERY_PORT` the container runs on). Bodies are
JSON. Send `Orrery-Actor: <your name>` on writes (e.g. `claude`): it's recorded as `createdBy`.

## Who can delete what

There's no auth. What the owner makes (requests with `Orrery-Actor` set to `NUXT_OWNER`) is
`protected`: no one else can delete it, directly or by deleting what holds it (a parent issue,
the project, a replacing import), and no one else can edit the owner's comments. That's a 403.
Docs the owner wrote can still be edited by agents (they keep them current), not deleted.

## Projects

| | |
|---|---|
| `GET /projects` | every project with its counts; `?expand=board` adds boards |
| `POST /projects` | `{name, id?, key?, description?}` — `id` defaults to the name as a slug, `key` (issue id prefix) to its first three letters |
| `GET /projects/:project` | the project with its board |
| `PATCH /projects/:project` | `{name?, key?, description?}` |
| `DELETE /projects/:project` | with its chunks, issues and comments |
| `POST /projects/:project/import` | a roadmap in mesher's `docs/roadmap.json` format; `?replace=true` to replace what's there |

## Chunks

| | |
|---|---|
| `GET /projects/:project/chunks` | with column, counts and top-level issue ids |
| `POST /projects/:project/chunks` | `{title, id?, summary?, position?}` |
| `GET /projects/:project/chunks/:chunk` | with its issues |
| `PATCH /projects/:project/chunks/:chunk` | `{title?, summary?, position?}` |
| `DELETE /projects/:project/chunks/:chunk` | its issues stay, in no chunk |

## Issues

| | |
|---|---|
| `GET /projects/:project/issues` | flat, sub-issues included; filter with `?status= ?plan= ?priority= ?column= ?assignee= ?label= ?chunk= ?parent= ?q=` (`none` for unset) |
| `POST /projects/:project/issues` | `{title, id?, status?, plan?, priority?, assignee?, labels?, notes?, parent?, chunk?, position?}` |
| `GET /projects/:project/issues/:issue` | with column, counts, sub-issues, parent and chunk |
| `PATCH /projects/:project/issues/:issue` | any of the above, plus `project` to move it; `null` clears |
| `DELETE /projects/:project/issues/:issue` | with its sub-issues and comments |

- `status`: `todo` (default) · `doing` · `done`
- `plan` (open issues): `now` · `next` · `later`; none is the backlog
- `priority`: `P0` (urgent, listed under Urgent until done) · `P1` · `P2` · `P3`; `labels`: a list of strings; `assignee`: a name
- Without an `id`, an issue gets the project's next `KEY-n`
- A top-level issue is in a `chunk`; a sub-issue (`parent`) is in its parent's chunk, so it takes no `chunk`
- `parent: null` lifts a sub-issue to the top, into the chunk it was in
- `project` moves the issue with its sub-issues and comments; ids stay, so 409 if one is taken there
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
curl -X PATCH $O/projects/mesher/issues/MOT-5 -H "$H" -H "$A" -d '{"status": "doing", "assignee": "claude"}'
curl -X POST $O/projects/mesher/issues/MOT-5/comments -H "$H" -H "$A" -d '{"body": "Started on `joints.rs`"}'
jq -Rs '{title: "README", body: .}' README.md | curl -X PUT $O/projects/mesher/docs/readme -H "$H" -H "$A" --data @-
```
