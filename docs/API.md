# orrery API

orrery keeps every app's roadmap: projects, their milestones (groups of issues: milestones),
issues with sub-issues to any depth, comments, and docs (Markdown pages). The page at `/` only shows them; everything
changes through this API, and open pages update live.

Base URL: `http://localhost:9000/api` (or the `ORRERY_PORT` the container runs on). Bodies are
JSON, and its fields are snake_case (`created_at`, `icon_color`), as the database's columns are. Send
`Orrery-Actor: <your name>` on writes (e.g. `claude`): it's recorded as `created_by`. A session's write that sends
`Orrery-Session: <its id>` (the channel's tools do) also keeps that session's name as it is then, as `session_name` on
the issue it made, its comments and its activity, which the page shows instead of Agent; none for the owner's writes,
older ones, or a session orrery doesn't know.

## Versions

Within a major version, a server keeps answering what it answered: a route, a field it sent or a value it took isn't
taken away or changed in meaning, and what's new is optional, so an older client keeps working (ORR-965). A request
field a server doesn't know is refused (400, naming the fields it takes), so a newer client sends a new field only to a
server whose `version` takes it. The channel and the launcher send their own `version` as they
connect. The launcher's stream's `ready` says the server's `version` and the `oldest` launcher it takes
(`1.0.0-rc.10`, or `1.0.0-rc.15` with more than one person); a launcher older than that says so on its log instead of
half working. The signal streams' `ready` says the server's `version` and the `oldest` channel it takes (the same
versions, today); a channel older than that tells its session so as it connects, and logs it. A client from before
`oldest` was sent hears nothing of it, which is why Sessions still marks one that's behind. The claim flags (`untrusted`, `chat`, `model`, `resume`) say what a launcher can do, so a server never
hands one a launch it can't start safely.

## Which server answered

Every reply carries `X-Served-By`: `rust` when the Rust API answered it (its refusals too), `nuxt` when the server in
front of it did. It's there to look at while the Nuxt server's routes move to the API; a client doesn't act on it.

## Ids

orrery hands ids out; you can't pick them. An issue is the project's prefix and a number:
`GRE-142` (the prefix is the project's `key`). A milestone is a number in its project: `3`.
Ids never change, and an issue moved to another project gets that project's next id. Ids things
had before (`MOT-5`, the milestone slug `joints`) are kept as **aliases**: every route and every
`parent` or `milestone` you send accepts them (and `?parent=`), and responses list them in `aliases`.
A number is handed out once: not again after its issue or milestone is deleted, moved away or replaced by
an import, and not while it's still an alias. Signals follow an issue that moves; those about what's
deleted or replaced go with it.

Each id also has a **full form**, for pasting: on another board or server it gets a 404, never someone else's issue
(a project's `key` is chosen per server, so `GRE-142` alone can mean something else there). It adds a random id, 8
characters of base32: the project's `uid`, or the server's (`uid` on `GET /settings`) for what belongs to the server.

| Kind | Short | Full | Random part |
|---|---|---|---|
| Issue | `GRE-142` | `GRE-142-x7k2m9qd` | the project's |
| Doc | `ideas` | `doc-ideas-x7k2m9qd` | the project's |
| Milestone | `3` or `MLS-3` | `MLS-3-x7k2m9qd` | the project's |
| Epic | `1` or `EPC-1` | `EPC-1-x7k2m9qd` | the server's |
| Preset | `12` | `pst-12-x7k2m9qd` | the server's |
| Schedule | `12` | `sch-12-x7k2m9qd` | the server's |

Every route takes either form, and an alias's full form too. A milestone and an epic are shown the way an issue is
(ORR-995), `MLS-3` and `EPC-1`, while `id` stays the number; routes and the `milestone` and `epic` fields take the
number, the shown id or the full id, their prefixes in any case (so the `mls-3-…` of before still works). Issues read back
with theirs in `full_id`, epics in a list too, and a milestone or doc read on its own (not in a list or a board). A project's `uid` goes with it when the database is copied (`orrery:copy`). An issue
moved to another project has a new full id, and its old one gets a 404. A new project can't take the `key` `MLS`, `EPC`,
`DOC`, `CHK`, `PST` or `SCH`, which read as the start of a milestone's, an epic's or another kind's id (a key made from
its name takes a fourth letter instead: `EPCO` for Epcot); one that has it already keeps it.

## Logging in

On one person's own machine there's no login, and everything below works by name. Otherwise ([when](../SECURITY.md#login-and-keys)) every route under `/api` needs a
credential, reads included: `Authorization: Bearer <agent key>` for sessions and scripts, or a login's cookie on the page. Without one it's a 401, or a 503 while nobody
could log in (the message says what to run), and with one, `Orrery-Actor` and `Orrery-Person` no longer decide who you are: a logged-in person is that person, and an agent key is an agent of its
person, with a label that's a person's name counting as `agent`. A session stays with the person whose key it first reported with, and a write naming it with another person's key is a 409. A logged-in write has to carry an `Origin`. The channel, hooks and launcher send the key from `ORRERY_KEY` or `~/.config/orrery/keys.json`.

| | |
|---|---|
| `GET /phone` | `{reach, docker, port, phone, addresses: [{url, from, machine?, name?}]}`: where a phone can open this orrery, for App settings' QR code. `phone`: it has a port of its own (`port`), which always asks for a login (ORR-837). `reach` is `loopback` while only this machine can, and `addresses` are then where it would be. `from` is `setting` (`ORRERY_PHONE_URL`), `host` (`ORRERY_HOST`'s address), `machine` (this machine's networks, outside Docker) or `launcher` (a connected launcher's report of its machine, named by `machine`). `name`: it's the machine's Bonjour name, `http://<name>.local:<port>`, listed before its IPs (ORR-874) |
| `POST /phone/link` | → 201 `{token, code, expires_at}`: a one-time sign-in link for App settings' QR code, opened as `<address>/login?t=<token>` on the phone's port, and `code`, six letters to type on the phone's login page instead. Good once, either of them, for 5 minutes. The owner's own page alone, on the sessions' address: 403 over the phone's port, to a session, the chat or an untrusted one; 409 before the owner has a name |
| `GET /auth/status` | open: `{mode, person?, via?, can_get_in, oidc, warn_http, phone}`, `mode` `off`, `on` or `closed` (told off on a server others can reach, so refusing); `phone` on the phone's own port |
| `POST /auth/link` | open: `{token}` or `{code}` → 201 `{person}` and this browser's login cookie: signs in with a one-time link from `POST /phone/link`, or its code (any case, dashes and spaces ignored), using up both. 401 once used or run out, or for a wrong code; 5 wrong codes in a row end every code still open, though not the links |
| `POST /auth/login` | open: `{key}`, a person key → `{person}` and the login's cookie; 401 for anything else, an agent key included |
| `POST /auth/logout` | open: 204, ending this browser's login |
| `GET /auth/oidc/start?invite=` | open: a redirect to the login provider; 404 with none set up |
| `GET /auth/oidc/callback` | open: the way back from it, a redirect to the board, logged in. 403 for an account with no invite, 409 for an invite used or run out, 401 for a login that ran out or doesn't match |
| `GET /usage` | the owner's: `{on, allowed, features: [{feature, label, last, days30, days90}]}`, how often each counted feature was used, coldest first (ORR-881). `on` is the owner's switch (`count_use` in `GET /settings`, off by default), `allowed` false with `ORRERY_USAGE=off`. `feature` is a listed one, `page:<route>`, `tool:<name>` or `dialog:<name>` (ORR-1011); `last` is a day, or none. Anyone else: 403 |
| `POST /usage` | `{feature}` → 204: one use, counted only when it's the owner's own (their page, their sessions) and counting is on; anyone else's is taken and ignored |
| `DELETE /usage` | 204: forgets every count. The owner's |
| `GET /logins` | your live logins, or everyone's for the owner: `{id, person, name?, created_at?, last_used_at?, expires_at, current?}`, `current` on the browser asking. `id` is a short part of the login's hash, never its cookie. Only a person, never a session (403) |
| `DELETE /logins/:login` | 204: ends that login at once, such as a lost phone's. Your own, or anyone's for the owner; a 404 for any other |
| `DELETE /logins` | `{ended}`: ends every login but the browser asking, your own or everyone's for the owner |
| `GET /keys` | your keys, or everyone's for the owner: `{id, person, kind, name, created_at, last_used_at?, revoked_at?}`, never the key. Only a person, never a session (403) |
| `POST /keys` | `{kind, name, person?, workspace?}` → 201 the key, with `key` this once only. `kind` is `agent` or `person`; `person` is the owner's to give. An agent key reaches only its `workspace` (`default` unless named), which has to be one its person is in, or it's a 404; a person key is above every workspace, and has none. An agent key from before workspaces has none either, and reaches every workspace its person is in. Only a person, never a session, whatever key it has. 404 for someone who isn't a person here |
| `DELETE /keys/:key` | 204: revokes it at once, with the logins it started (and its person's from before 1.0.0-rc.17, which don't record their key). Your own, or anyone's for the owner; a 404 for any other. Only a person, never a session (403) |
| `POST /invites` | `{person}` → 201 `{url, expires_at}`: the owner's only, a link good once and for a week, whose first login attaches that account to the person. 409 with no login provider |

`GET /healthz`, outside `/api`, answers `{ok: true}` with no credential, for a container's health check, while the Rust API answers too, and 503 with `{ok: false}` when it doesn't, as every board request fails then.

## Who can delete what

With no login, the owner is whoever gave their name when the orrery was first opened (`GET /api/owner`
→ `{name, display, named}`; `PUT /api/owner {name}` gives it, anyone the first time, then the owner only; not `agent` or `claude`, which agents send; a 409 for a member's id).
Their `Orrery-Actor` is that name in lowercase snake case: `Sköll Fenrisson` is `skoll_fenrisson`
(`owner` until a name is given; renaming moves what was theirs to the new id). Don't guess it from
a git name: read it from `GET /api/owner`, or assign to `owner` (below), which always means them. What the owner makes is
`protected`: no one else can delete it, directly or by deleting what holds it (a parent issue,
the project, a replacing import), and no one else can edit the owner's comments. That's a 403.
Docs the owner wrote can still be edited by agents (they keep them current), not deleted.

## People

The owner can add others to an orrery, and each of them has their own sessions. With one person, nothing here changes anything: every session is theirs.

| | |
|---|---|
| `GET /people` | everyone: `{id, name, role, created_at, removed_at?}`, the owner first, `role` `owner` or `member`. The owner is listed once they've given their name |
| `POST /people` | `{name}` → 201 the person, a member: the owner's only. Their `id` is the name in lowercase snake case, and never changes. 400 for `owner`, `agent`, `claude` and `orrery`, or before the owner has a name; 409 for an id someone has, or a removed person had, or while nobody could log in, as a second person turns login on (claim it first, with `orrery:claim`, or `ORRERY_AUTH=off` to only try people out) |
| `PATCH /people/:person` | `{name}` → the person: the owner's only. The id stays, so what they hold stays theirs. The owner's own name goes through `PUT /owner` |
| `DELETE /people/:person` | 204: the owner's only. Their name stays on history, their open issues go back to unassigned, each with an activity line, and their sessions can no longer change an issue. Their keys and logins stop at once. The owner can't be removed |

A session says whose it is with `Orrery-Person: <id>` on its requests: the channel and the hook send `ORRERY_PERSON` from the environment Claude Code starts in, and a session the owner starts through a launcher gets theirs. It's worked out from each request, so it holds across a restart and a `/clear`. The owner and their chat are the owner's, whatever they send, and an untrusted session is nobody's. With more than one person, a session that names nobody, or somebody who isn't here, can read and comment, but changing an issue (`PATCH …/issues/:issue`, or in bulk) is a 409 saying how to set it. With no login this is a name rather than a password, as `Orrery-Actor` is; with one, the credential decides.

Each board has one person holding it, and members. Existing boards are the owner's, and a new one is held by whoever made it, for them and their sessions alone until they add someone. The owner is on every board without being listed.

| | |
|---|---|
| `GET /projects/:project/members` | who's on the board: `[{person, name, role, created_at}]`, its holder (`role` `owner`) first |
| `POST /projects/:project/members` | `{person}` → 201 them on the board, a `member`: its holder's or the owner's, never an agent's (403). 404 for someone who isn't a person here; 409 for someone removed |
| `DELETE /projects/:project/members/:person` | 204: the same. 400 for its holder, who stays. Removing a person from the orrery takes them off every board, and what they held goes to the owner |

With more than one person, every write is checked against the permissions table's `member` column (`GET /permissions`): anything else is the owner's and their sessions' alone (403), and on a board the person isn't on it answers 404, as if the board weren't there. A route the table doesn't name is refused. A session naming nobody gets a 409 for all but commenting and reporting what it's doing. Reads aren't held to a board yet. A session hears only the boards its person is on: a signal stream for any other is a 404, one naming nobody is a 409, and `/signals/stream` with `*` or several projects follows only theirs. With no login these are names, so they keep honest sessions apart and stop nobody else ([Security](../SECURITY.md#with-login-off-the-owner-is-a-name-not-a-password)); with one, the credential decides.

Every board is in a workspace, and reads and writes alike are held to the workspaces you're a member of: a project in any other answers 404, as if it weren't there, and the lists across projects (`GET /projects`, `/releases`, `/schedules`, `/schedules/across`, `/events/log`, `/changes` and its stream, `/notices` and `/notices/changes`) leave its rows out. The owner sees only the workspaces they're in, and a request naming nobody here, as with login off, only `default`. An untrusted session also reaches the project it was started for. A session works in one workspace, the one its calls name in `Orrery-Workspace` (a session orrery starts names its project's): a project you can see in another is a 403 saying which workspace the session is in; a page naming one, from its address, isn't held to it. Within a workspace a member reads every board; writing still follows each board's members. Today everything is in `default` and everyone is a member of it.

What's the workspace's own rather than a project's (epics, statuses, presets, secrets, the event log and schedules across projects so far; settings to follow, ORR-1107) is read and written in one workspace: the one a request names in `Orrery-Workspace`, else `default` when it's yours, else your first. Naming one you aren't in is a 404, as is another workspace's epic, preset, line or schedule across projects asked for by its number. Each workspace has its own statuses: a new one starts with a copy of the set orrery ships, with its id in front of each (`acme-todo`), as a status's id stays unique across the server; an issue takes its project's workspace's statuses alone, by id or by kind. Each workspace has its own secrets, by name: egress and orrery's own requests use the secret of the workspace of the project they're for. A line in the log naming a project is its project's workspace's, a project's own preset too, and a schedule for every project is for every project of its workspace.

| | |
|---|---|
| `GET /workspaces` | the ones you're in, `default` first then by name: `[{id, name, color, role}]`, `role` yours there (`owner` or `member`) |
| `POST /workspaces` | `{name, color?}` → 201 a workspace, you its owner: anyone here can make one. Its id comes from the name, with `-2`, `-3`… when that's taken. `name` is 1 to 60 characters and `color` a tint (`slate`, `blue`, `teal`, `green`, `amber`, `rose`, `violet`) or a `#rrggbb` (400). Nobody signed in can't (403), and sessions and the chat are refused |
| `PATCH /workspaces/:workspace` | `{name?, color?}` → the workspace: its owners' to change. `color` null takes it off. A member gets 403, and one you aren't in 404 |

With more than one person, an agent works only what's assigned to its person (ORR-655). This holds at the store, so every route that writes an issue is held the same way:

- **Starting, editing, closing, moving or deleting** an issue that isn't its person's is a 409 naming who has it, or saying nobody does. An assignee who isn't a person counts as nobody, and `claude` as the owner. An agent's own proposal stays its to edit and put up again, though it waits on the owner. Comments stay open to all.
- **Starting** it records the claim: `claimed_by` on the issue. That ends when the issue is closed or reassigned, and reopening doesn't bring it back. Another of the same person's agents can pick it up once the session on it has gone, and another person's can't.
- **Assigning:** only people assign. An agent can hand an issue it holds to `owner` or let it go, and nothing else.
- **A new issue** with no parent stays unassigned, or goes to `owner` if it asks, so it can't be made started, closed or assigned to its own person. One under an issue its person holds is theirs, unless it's a proposal, which goes to the owner while it waits. A session naming nobody can't make one at all. An untrusted session's proposals are as they were.
- **What orrery reassigns stays with the person:** an agent's question waits on its own person, and only on an issue that's theirs. An approved proposal goes to the person whose agent proposed it. A session cut off leaves its issue with its person.
- **Focus** on an unassigned issue makes it the person's who sent it, and on someone else's is refused. An agent can't assign itself in this way. The owner's focus takes the issue over, which shows in its activity.
- **Importing** a roadmap is a person's.

## Projects

| | |
|---|---|
| `GET /projects` | every project with its counts; `?expand=board` adds boards, and each project's `rev` for the events stream's patches; `&notes=0` leaves the issues' notes out (the page reads an issue's own from `GET …/issues/:issue`); `&closed=0` leaves out closed (done, canceled) issues with no open sub-issue, but for the projects in `&whole=` (comma-separated ids). The page loads that way, with the project it's on whole, and reads another project whole as one of its pages opens; a patch on the events stream for a project it has without them leaves out the closed issues it never had |
| `POST /projects` | `{name, id?, key?, description?, repo?, release_mode?, releases_from?}`, and any other field `PATCH` takes (`icon`, `icon_color`, the owner's prompt fields): `id` defaults to the name as a slug, `key` (the prefix of its issue ids) to its first three letters |
| `GET /projects/:project` | the project with its board, docs and releases, and its `rev`; `?notes=0` leaves the issues' notes out, and `?closed=0` its closed issues with no open sub-issue |
| `PATCH /projects/:project` | `{name?, key?, description?, icon?, icon_color?, repo?, release_mode?, releases_from?, focus_prompt?, milestone_prompt?, instructions?, muted?}` (the last four the owner's; see [What sessions hear](#what-sessions-hear)): `icon` is a [Heroicon](https://heroicons.com)'s name (`shopping-cart`), shown in the sidebar; `icon_color` is its colour, `slate`, `blue`, `teal`, `green`, `amber`, `rose`, `violet` or a `#rrggbb` (none follows the text); `repo` is the web address of its code (`https://github.com/you/shop`), which links a release's branch and PRs; `release_mode` is whether it has releases, `none`, `own` or `shared`, and `releases_from` another project whose releases it ships in (see [Releases](#releases)); `null` clears any of them but `release_mode`; `releases_from: null` gives it its own |
| `DELETE /projects/:project` | with everything in it: milestones, issues, comments, docs, releases, schedules, signals and its presets; a 409 while others take their releases from it |
| `GET /projects/:project/export` | the board as one file (`{format: "orrery-board", format_version, schema_step, exported_at, project, people, statuses, uploads, tables}`), a snapshot that changes nothing: issues, comments, activity, milestones, releases, docs with their history and sections, schedules and their runs, the project's presets, old ids, and the images its text shows (`data` in base64). `people` and `statuses` are only those it uses. A link to another project's issue, or `releases_from`, stays a plain reference. **No secrets**, keys or logins, and no live state: signals, session records, the pull request cache |
| `POST /projects/upload?id=&key=&name=` | a board's file (the export above, 256 MB at most) → 201 and a new board, held by whoever uploaded it; a person's or the owner's alone, never an agent's. It never merges or overwrites: an id or key already taken is a 409, and you choose another with `id` and `key`. All or nothing. An older file is brought up to this schema, and one from a newer orrery is refused. Comments, activity, revisions, schedules and presets get new ids, with what points at them; issue ids stay. The file is untrusted: nothing in it is the owner's, comments show as `<name> (from a file)` and reach no session, asks are dropped, schedules arrive paused, requests waiting on Allow expire, and prompts, instructions, the repo and `starts` are left behind, as are claims. Statuses go by id, else the first of their kind. People go by name, and an open issue whose person isn't here goes unassigned. A link outside the board stays only where it leads to an issue on a board the uploader is on. Each issue's activity says it came from a file |
| `POST /projects/:project/import` | a roadmap in the `roadmap.json` format (milestones of tasks with `status` `todo`/`doing`/`done` and an optional `plan`); its ids become aliases; a 409 when the project already has milestones or issues, unless `?replace=true` replaces what's there (schedules that made issues in a milestone make them in none) |

## Milestones

| | |
|---|---|
| `GET /projects/:project/milestones` | with column, priority, counts and top-level issue ids |
| `POST /projects/:project/milestones` | `{title, summary?, priority?, position?}`; gets the next number |
| `GET /projects/:project/milestones/:milestone` | with its issues |
| `PATCH /projects/:project/milestones/:milestone` | `{title?, summary?, priority?, position?}`; `priority` is `P0`–`P3` (P0 urgent) or `null` |
| `DELETE /projects/:project/milestones/:milestone` | its issues stay, in no milestone |
| `GET` · `POST {body}` `/projects/:project/milestones/:milestone/comments` | its comments, oldest first, or a new one → 201: `{id, project, milestone, body, created_by, session_name?, protected, created_at, updated_at}`. Words on the milestone's page (ORR-977): no `asks`, no bell, no session hears them. Deleted with the milestone |
| `PATCH {body}` · `DELETE /projects/:project/milestones/:milestone/comments/:comment` | as an issue's: the owner's are theirs, and a member's theirs and their agents' |

## Releases

The versions a project ships, and which issues go out in each. Milestones are themes; a release cuts across
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
| `GET /projects/:project/releases` | in the order they're arranged in, a new one on top: `{version, branch?, notes?, frozen_on?, shipped_on?, doc_mark?, issues, kinds}`, where `issues` counts those set for it and `kinds` their progress, sub-issues included (a sub-issue set for another release counts there instead) |
| `GET /releases` | every project with releases of its own, for the Releases page: `[{project, projects, releases}]`, `projects` being it and those taking their releases from it, and each release as above without `notes`, plus `projects` `[{project, issues, kinds}]`, each one's part. A release several projects share is listed once, under the project it's made on; a project with `release_mode` `none` isn't listed. It's read without building the projects' boards |
| `POST /projects/:project/releases` | `{version, branch?, notes?, frozen_on?, shipped_on?, position?}` (a 400 on a project taking its releases from another, as for `PATCH` and `DELETE`): `version` is its id (`1.0.0-rc.2`: letters, digits, dots and dashes), `branch` where its work gathers before it ships (`v1.0.0-rc.2`), `frozen_on` the day its features froze (`YYYY-MM-DD`; see below), `shipped_on` the day it shipped (`YYYY-MM-DD`; none while it's being prepared), `position` where it goes in the list (0 the top, the default) |
| `GET /projects/:project/releases/:release` | with the issues set for it as `tasks` (each with its sub-issues), and by project in `projects`: `{project, name, issues, kinds, tasks}`, the project's own first, then on a source each project drawing on it |
| `PATCH /projects/:project/releases/:release` | `{branch?, notes?, frozen_on?, shipped_on?, position?}`; `position` moves it in the list (0 the top); the version doesn't change; `null` clears |
| `DELETE /projects/:project/releases/:release` | its issues stay, set for none, in every project drawing on it too |

An **artifact** (ORR-677) is a doc with `kind: "artifact"`, whose `body` is HTML: a visual for a person to look at, with
sections and history like any doc. Make one with `POST` or `PUT` (`write_doc` for a session). Its kind is fixed when it's
made (a 400 for another), and a doc's `kind` is otherwise `markdown`. It's only ever drawn in a sandboxed frame on its doc's page, or served
at `…/artifact` with the same lock.

- **What it has:** its own inline scripts and styles, and images and fonts as `data:` addresses. Tailwind is there already,
  so write ordinary classes with no build step, along with the app's theme (`bg-canvas`, `bg-panel`, `text-fg`, `text-muted`,
  `ring-line`, `bg-accent-500`…). `dark:` classes follow the page's dark mode.
- **What it can't do:** make any request, so everything has to be in the HTML: no library from a CDN, no uploaded images,
  no live data. It also can't read orrery's API or the page around it, use storage, open a popup, submit a form or move the
  top tab. An error stays inside its frame.
- It can be a fragment or a whole document, though `class` on its own `<html>` is ignored, as orrery's comes first.

A doc's **revisions** (ORR-675): a save that changes its title or text keeps the whole of both, whether it came from the
page, a session or `PUT`. Moving it to another section, a new position, or the same text saved again doesn't count. A
removal is a revision too (`deleted: true`), holding its last text. `GET …/docs/:doc` always reads the latest. Their ids
run across the orrery.

Shipping a release (setting `shipped_on`) stores the newest revision id on it as `doc_mark`, read-only: a doc as of that
release is its newest revision at or below it. Un-shipping clears it and shipping again sets it anew; a new day on one
already shipped keeps it. A release shipped before revisions were kept has none.

A **feature freeze** (`frozen_on`) is a preference, not a lock: from that day the release would rather take
fixes, tests and docs, and a new feature goes on the next one. Nothing is refused. It shows on the release,
in an issue's release picker, and in what sessions hear: a focus on an issue set for it (or a sub-issue going
out with one), or on a release's issues, gets the rule as a line after the standing instructions. It lasts
until the release ships.

## Epics

One piece of work across projects (ORR-895), such as a feature with a part in each repo: an epic holds issues from any
project, apart from each project's milestones. It has a number of its own across the orrery, shown as `EPC-3` (`/epics/3` or `/epics/EPC-3` on the pages),
a `title` and `notes`, and its progress is its issues', counted the way a release's are. An issue joins one with `epic`
(its number); it's in one at most, and a sub-issue with none goes with its parent's. Moving an issue to another project
keeps its epic.

| | |
|---|---|
| `GET /epics` | in the order they're arranged in, a new one on top: `{id, full_id, title, notes?, issues, kinds, projects: [{project, issues, kinds}], protected}`, `issues` counting those set for it and `kinds` their progress, sub-issues included, across every project it has issues in |
| `POST /epics` | `{title, notes?, position?}` → 201; `position` is where it goes among them (0 the top, the default) |
| `GET /epics/:epic` | as above, with `parts`: a section per project, `{project, name, issues, kinds, tasks}`, the issues set for it there (a sub-issue's when its parent isn't), each with its sub-issues |
| `PATCH /epics/:epic` | `{title?, notes?, position?}`; `null` clears `notes` |
| `DELETE /epics/:epic` | its issues stay where they are, in no epic; one the owner made is theirs to delete |
| `GET` · `POST {body}` `/epics/:epic/comments` | its comments, oldest first, or a new one → 201: `{id, epic, body, created_by, session_name?, protected, created_at, updated_at}`. Words on the epic's page (ORR-977), as a milestone's are. Deleted with the epic. A member can't write them, as epics are the owner's |
| `PATCH {body}` · `DELETE /epics/:epic/comments/:comment` | the owner's are theirs |
| `POST /epics/:epic/focus` | `{note?, session?, status?, instructions?, start?}` → 201 `{signals, listeners}` (ORR-987): Focus on this for an epic. A milestone focus on `all` for each project it has open issues in, narrowed to the epic's issues (`epic` on the signal), so each goes to one session there orrery picks, or with `session` `*` to every one. A named session (ORR-958) gets one for each of those projects it hears, and a 400 when it hears none; a `release` is a 400, as it's one project's. With `status`, only the projects with an open issue of it in the epic get one. `listeners` counts each project's listening sessions. `start: true` from the owner starts a session where nobody's listening, as on an issue |

An issue's `epic` changing is in its activity and the event log as `issue.epic` (`from` and `to` the numbers). A
board's export leaves epics out, as they're the server's: uploading one clears its issues' `epic`.

## Issues

| | |
|---|---|
| `GET /projects/:project/issues` | flat, sub-issues included; filter with `?status= ?priority= ?column= ?assignee= ?label= ?external= ?github_issue= ?milestone= ?release= ?parent= ?proposal= ?blocked= ?q=` (`q` is text in the id or title; with `&in=all`, words in the id and title, the description or one comment, any order or case, orrery's own comments aside: those with them in the id and title first, then the rest with `match_in`, `description` or `comment`, and `match`, the text around the hit, left out for an issue labelled `external`; `none` for unset; `?blocked=true` is what waits on an issue not done yet, `false` what doesn't; `status` and `column` take a status's id or a kind, or several comma-separated; `?proposal=none` is committed work only) |
| `POST /projects/:project/issues` | `{title, status?, priority?, assignee?, labels?, external?, github_issues?, notes?, proposal?, choices?, parent?, milestone?, release?, epic?, depends_on?, model?, effort?, position?}`; gets the next `KEY-n`. `model` (an alias, `best` … `haiku`, or a full id) and `effort` are what a session for it starts on, and what a signal about it needs, over its kind's; `null` (on `PATCH` too) follows its kind again |
| `GET /projects/:project/issues/:issue` | with column, counts, sub-issues, parent and milestone |
| `PATCH /projects/:project/issues/:issue` | any of the above, plus `project` to move it; `null` clears |
| `PATCH /projects/:project/issues` | many at once: `{ids, set?: {status?, priority?, assignee?, milestone?, release?, epic?}, labels?: {add?, remove?}}` → `[{id, ok, error?}]`, each issue on its own, so one refused doesn't stop the rest; open pages hear the batch once |
| `POST /projects/:project/issues/decide` | the owner's one decision on many proposals: `{ids, decision, note?}` → `[{id, ok, error?}]`; approving takes each one's recommended picks, and skips one with a choice that has none |
| `DELETE /projects/:project/issues` | `{ids}` → `[{id, ok, error?}]`, each with its sub-issues, under the same protections as one |
| `DELETE /projects/:project/issues/:issue` | with its sub-issues and comments |
| `POST /projects/:project/issues/:issue/decide` | `{decision, note?}`, the owner only: `approved`, `changes` or `rejected` a proposal → the issue |

- `status`: a status's id (see [Statuses](#statuses)), `backlog` by default. A kind works too and picks its
  first status: `{"status": "started"}` is In progress. The words from before statuses still work:
  `doing` is started, and `todo` with a `plan` (`now`, `next`, `later`) is Todo, with `plan: null` Backlog
- `priority`: `P0` (urgent, listed under Urgent until done) · `P1` · `P2` · `P3`; `labels`: a list of strings; `assignee`: a name, or `owner` for the owner
  (stored as their id, so it shows under their My issues; `?assignee=owner` finds theirs too)
- A top-level issue is in a `milestone`; a sub-issue (`parent`) is in its parent's milestone, so it takes no `milestone`
- `parent: null` lifts a sub-issue to the top, into the milestone it was in
- `release`: the version of a release of the project, or of the project it takes its releases from (see [Releases](#releases)); moving the issue to a project that doesn't share them takes it out. orrery sets it itself when a pull request on the issue merges into the branch of a release being prepared, if the issue and those above it have none
- `epic`: an epic (see [Epics](#epics)), from any project, by its number, `EPC-1` or its full id; `null` takes it out. Moving the issue keeps it
- `project` moves the issue with its sub-issues and comments; they get that project's ids, their old ones kept as aliases
- `depends_on`: the issues it waits on, all of them, replacing the list (`[]` or `null` for none): an id in its project,
  `project/ID` in another. An issue itself, one not there, more than 50, a parent and its own sub-issue, and a loop are
  a 400 (`ORR-3 already depends on ORR-1 (through ORR-2), so ORR-1 can't depend on it`). Read back with `blocked_by`
  (those not Done yet: while there are any it's blocked, and nothing hands it out) and `blocks` (what depends on it),
  each only when there are some. A session starting a blocked issue is a 409 naming its blockers, unless the owner
  focused a session on it in the last day. So is a session starting a sub-issue while another session that's there has
  started an issue above it (ORR-611): a follow-up filed under that issue is that session's, until it stops or the
  issue is done or canceled, unless the owner focused this session on it in the last day. A focus aimed at no
  session, the Todo hand-out and what an issue done unblocks send such a follow-up to that session (ORR-613), and
  picking leaves it out
- `notes` may use inline `` `code` `` and `**bold**`
- `external`: its tasks on the team's tracker, a list of ids (`ENG-1567`) or full URLs; the orrery's
  `tracker` (`PATCH /settings {tracker}`, a task's web address with `{id}` where its id goes) links an id;
  `?external=ENG-1567` finds the issues linked to a task
- `github_issues`: the GitHub issues it came from, kept as `owner/name#523`. Send each as its number on the
  project's `repo` (`523` or `"#523"`, when that's on GitHub), `owner/name#523`, or its link; the issue page and list
  show one on the project's repo as `#523`. `?github_issue=523` (any of those forms) finds the issues that came from
  it. Set it, not `external`, when an issue comes from a GitHub issue: `external` is the team's tracker
- `full_id` (read only, on `GET …/issues` and `GET …/issues/:issue`): its id to paste anywhere (see [Ids](#ids)), which
  is what a commit body or PR description says
- `ref` (read only, the same): the earlier way of saying whose board it's on, `orrery-<handle>: <id>`
  (`orrery-ada: DOC-132`), from the orrery's `handle` (`PATCH /settings {handle}`); kept, but use `full_id`

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

One list for the whole orrery, in board order. An issue stores a status's `id`; each status has a
`kind`, which is what it means, and orrery's counts, progress, pages and signals go by kinds, never names.

| Kind | Starts with | Means |
|---|---|---|
| `backlog` | `backlog` Backlog | someday, out of the active list |
| `todo` | `todo` Todo | committed, not started; priority and the milestone say what's first |
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
| `GET /projects/:project/docs` | without their text but with a `summary` (the first paragraph as plain text, about 160 characters), by title, A–Z (a `position` sent with a doc is kept but no longer orders them; an artifact's `summary` is empty). `?q=` keeps those with every word of it in their title or text (any order or case), the ones with them all in the title first, each with a `match`: about 160 characters of text around its first hit. Each has its `section` when it's filed under one |
| `POST /projects/:project/docs` | `{title, body?, id?, section?, kind?}`; `body` is Markdown (or HTML with `kind: "artifact"`, below), and `section` (up to 60 characters) is the group it's listed under, such as `Decisions` |
| `GET /projects/:project/docs/:doc` | with its `body` and `full_id` |
| `PUT /projects/:project/docs/:doc` | `{title, body?, section?, kind?}`: creates (201) or replaces, for keeping a repo's `.md` file in sync. A `section` left out keeps the one it has |
| `PATCH /projects/:project/docs/:doc` | `{title?, body?, section?}`; `section` `null` or `""` takes it out of one. Moving a doc to another section doesn't count as changing it (its `updated_at` stays) |
| `GET /projects/:project/docs/:doc/artifact` | an artifact's HTML as a page, locked down (below); `?theme=dark` for dark mode. A 404 for a Markdown doc |
| `DELETE /projects/:project/docs/:doc` | its past stays, so it can come back; only deleting the project removes that |
| `GET /projects/:project/docs/:doc/revisions` | its revisions, newest first, without their text: `{id, title, kind, deleted, created_by, session_name?, created_at}`. A deleted doc's too; a 404 when there's never been such a doc |
| `GET /projects/:project/docs/:doc/revisions/:revision` | that revision with its `project`, `doc` and `body` |
| `POST /projects/:project/docs/:doc/revisions/:revision/restore` | the doc with that revision's title and text, kept as a new revision so it can be undone too; 201 when it brings a deleted doc back, where it was filed and with who made it, else 200; 409 when the revision is another kind of doc than the one there now |
| `GET /projects/:project/deleted-docs` | its docs that are gone, the latest removed first: `{id, title, kind, summary, revision, deleted_by, deleted_at}`. Bring one back by restoring its `revision` |
| `GET /projects/:project/doc-sections` | its docs' sections, as arranged, a new one last (A–Z until then): each one a doc is filed under, and the empty ones made with `POST`. A project's own read has them too, as `doc_sections` |
| `POST /projects/:project/doc-sections` | `{name}` (up to 60 characters) → 201 `{name}`: a section with no docs in it yet, kept until it's deleted; 409 when there's one by that name |
| `PATCH /projects/:project/doc-sections/:section` | `{name?, position?}` → `{name}`: `name` renames it on every doc in it at once, without counting as a change to them (their `updated_at` stays), 409 when there's already one by the new name; `position` moves it in the list (0 the top), past the end being last |
| `DELETE /projects/:project/doc-sections/:section` | 204; its docs are kept, under no section |

## Comments

| | |
|---|---|
| `GET /projects/:project/issues/:issue/comments` | oldest first |
| `POST /projects/:project/issues/:issue/comments` | `{body, asks?}`: `asks` is `decision` or `feedback` when it waits on the owner. It leads their bell (Clear read leaves it) until they comment on the issue after it; comments then read `answered: true`. An ask assigns the issue to the owner, and their answer gives it back to the agent who asked. Until then the issue reads `waiting: "decision"` or `"feedback"` (its latest open ask), and the app marks it on its row, card and page. A done or canceled issue doesn't read as waiting, and one reopened does again. An agent's proposal waiting on the owner (pending, not under another proposal) reads `waiting: "decision"` too, with no ask of its own open, until they decide it |
| `GET` · `PATCH {body}` · `DELETE /projects/:project/issues/:issue/comments/:comment` | |
| `POST /projects/:project/issues/:issue/claim` | → the issue, taken up by whoever's asking, with `claimed_by` and `claimed_at`, and shown in its activity: a person's own, or an unassigned one, which it assigns to them; the owner's on anyone's, which takes it over. An agent only its person's. 409 naming the holder for anyone else |
| `DELETE /projects/:project/issues/:issue/claim` | → the issue, let go and still assigned: its holder's or their agents', or the owner's. 409 for anyone else; nothing happens when nobody holds it |
| `GET /projects/:project/issues/:issue/pulls` | its open pull requests on the project's `repo`, when that's on GitHub, and in `done` those merged or closed however long ago, from orrery's own record (`number`, `title`, `url`, `branch`, `base`, `author`, `state`, `merged_at`, `updated_at`; `state` `open` only for a repo the project has left): `{repo, pulls, done, error?, token, token_problem?, checked_at}`; `token_problem` says why a `GITHUB_TOKEN` secret that's set didn't go (its hosts leave out `api.github.com`, its projects leave this one out, or orrery's key can't open it). A PR is the issue's when its body links the issue's page (`…/issues/ORR-12`) or its branch names the issue (`feat/orr-12-…`), by its id or one it had before. Each is `{number, title, url, branch, base, author, state, created_at, updated_at}` for the owner (`Orrery-Actor`). Anyone else, a session or the owner's chat, gets each without `title` and `branch`, which an outsider may have written, and with `author` only when it's a plain login. A PR that's been rated has `risk: {level, why, by}` (see the next row); one that hasn't, none. `state` is `draft`, `conflicting`, `behind` (its base moved on), `failing` (checks), `blocked` (a review or required check), `ready` or `checking` (GitHub hasn't worked it out yet). orrery polls each repo in the background, once a minute with a `GITHUB_TOKEN` [secret](#secrets) that may go to `api.github.com` (`token: true`), and this is read off what the poll kept while it's fresh. A change to the secrets polls at once each repo whose token it changed, so a token set (or set right) shows straight away. Without a token the poll reads only whether PRs merged or closed, every ten minutes, so this asks GitHub itself at most every five minutes (public repos only, and GitHub's 60 an hour); in between, and when GitHub can't be read (`error` says why: its rate limit, a private repo without a token), it's what GitHub said last. `repo: null` for a project with no repo on GitHub, and nothing is asked |
| `PUT /projects/:project/issues/:issue/pulls/:owner/:name/:number/risk` | how risky the issue's PR `number` on GitHub repo `owner/name` is, so reviewing starts with what matters: `{level, why}`, `level` `high`, `medium` or `low`, `why` one line on what decided it ("high: bug fix in signal routing"), up to 300 characters, or `{level: null}` to take the rating away → `{risk}`, with `by` `session` or `owner`. The session that opens the PR rates it, by judgement from the change's context (what it touches, how much it could break, whether it breaks something relied on, a fix or something new, or only copy, styling, docs or tests), and rates it again when the PR changes. The owner's rating stands: a session's doesn't replace or take it away (409). When a PR rated high merges, orrery asks the owner on the issue to review it (`asks: "feedback"`, `pr.risky_merged`), and so it does for a merge that changed a path with `migrat`, `auth`, `permission`, `secret`, `egress` or `untrusted` in its name, whatever it was rated (the poll reads a merged PR's files, a request a merge). The issue's risk is its riskiest PR's, and the project's board has it on the issue as `risk: {level, why, by}` (none until one is rated), read again on every rating. The owner's chat and an untrusted session can't rate (403). 404 when orrery keeps no such PR on the issue: it doesn't name the issue, or the poll hasn't seen it yet |
| `GET /projects/:project/issues/:issue/branches` | the branches its work can carry on from, for sessions as well as the owner (ORR-799): `{repo, base, branches, error?}`, each `{name, sha, committed_at, ahead, pull?, other_session}`, the newest first. A branch is the issue's when its name names it. It leaves out the default and release branches, one whose pull request merged with no commit since or closed unmerged, one with nothing to bring in, and a name that doesn't fit letters, digits and `/._-`. `base` is what `ahead` counts against. `other_session` is whether another listening session has the issue started (`Orrery-Session` says who's asking), as orrery can't see which branch a session has checked out. Without a token `committed_at`, `ahead` and `base` are null. Read as `GET /pulls/branches` reads, at most once a minute (five without a token) |
| `GET /pulls?page=&limit=&q=` | every open pull request on the projects' GitHub repos (the Pull requests page): `{pulls, open, needs, repos}`. Each pull is as an issue's (above) plus `repo` and `issue` `{project, id, title}` when one of the repo's projects has the issue it names (its body's link first, then its branch). Those `conflicting`, `failing` or `behind` come first, oldest first, then the rest, oldest first; `open` counts them all and `needs` the first. With `page` (from 1) or `limit` (50, at most 200), `pulls` is only that page, in the same order, with its `page` and `limit`; a page past the last is the last, and the counts stay totals. With `q`, only those with every word of it (in any case) in their number (`#788`), title, branch, base, author or issue id, paged across all of them, with `matched` counting them, overall and on each repo (ORR-941); only what the asker is sent is searched, so a session's search never finds a title. A repo several projects share is read once: `repos` is `[{repo, projects, token, token_problem?, checked_at, open, needs, cut?, error?, matched?}]`, its counts every page's. Up to 300 open PRs a repo are read, following GitHub's next pages; `cut` says how many were read when it had more. Without a token only each repo's list is read (GitHub allows 60 requests an hour then), so each PR not a draft is `checking` |
| `GET /pulls/:owner/:name/:number` | one pull request by its number, as orrery keeps it, with every issue it's linked to (ORR-880): `{repo, pull, issues}`. `pull` is `{number, title, url, branch, base, author, state, merged_at, updated_at}`, `state` `open`, `merged` or `closed`, merged and closed ones kept for good. `issues` is `[{project, project_name, id, title, status, risk?}]`, on any project, riskiest first, then by project and id (ORR-914): `risk` `{level, why, by}` is the issue's, the riskiest of its rated PRs (this one or its own), as the board has it, and left out when none is rated. Read from orrery's own record, never GitHub: it keeps a PR once a poll finds it naming an issue, and a release PR (from a release's branch) on every issue in that release (ORR-913), so one naming none, or never polled, is a 404. The repo matches in any case. For anyone but the owner, `pull` leaves out its title, branch and an author that isn't a GitHub login, as `GET /pulls` does |
| `GET /pulls/branches` | every branch on the projects' GitHub repos, the owner's alone: `{branches, repos}`. Each branch is `{repo, name, sha, committed_at, ahead, issue?, pull?, verdict, why}`: `verdict` is `remove`, `keep` or `look`, `ahead` the commits not in its repo's `base` (the branch of a release being prepared, else the default). Without a token `committed_at` and `ahead` are null, and `base` too |
| `DELETE /pulls/branches?repo=&name=` | → 204: the owner removes a branch on GitHub. It's read afresh first, and a 409 says why when it no longer reads as `remove`, or when the token can't write |
| `POST /pulls/poll?repo=&page=&limit=` | → `GET /pulls`'s answer, fresh and paged as it pages: the owner's **Poll** (ORR-534). Every repo (or `repo`, `you/shop`) is polled at once, whenever it last was, and what changed is told as the background poll tells it. A repo GitHub is holding (its rate limit, a refused token), or without a token one polled now in the last five minutes or read at all in the last minute, isn't asked: its entry in `repos` has `held` saying why and when; a refused token is tried again once the secrets change. A second ask for the same while one runs gets the same answer. A `repo` no project is on is a 404. The owner's only (`pulls.poll`) |
| `GET /projects/:project/issues/:issue/activity` | who changed what on it, oldest first: `{field, before?, after?, created_by, session_name?, created_at}`, where `field` is `created`, `title`, `status`, `priority`, `assignee`, `labels`, `external` and `github_issues` (JSON lists), `notes` (no values), `milestone`, `parent`, `proposal`, `release`, `depends` (JSON lists of what it depends on; by `orrery` when a blocker was deleted) or `project` (moved in from `before`) |
| `GET /notices` | with more than one person, the bell of whoever's asking (ORR-658): their agents' comments and what others say on what's assigned to them, and proposals only for the owner. Either way only those that are news to them (ORR-1151): asking, on their issue, answering their own comment, naming them (`@<id>`), or the latest on an issue that's done. Otherwise agents' latest 30 such comments across projects, those waiting on the owner first (the page's bell), led by agents' proposals waiting on the owner: `{id: 0, issue, title, body: <its notes>, asks: "decision", answered: false, proposal: {choices: <how many>}}`, there until the owner decides or clears it (clearing leaves it pending; put up again, it's back). `?list=waiting` is every one still waiting, proposals among them; `?list=inbox` (the rest) and `?list=cleared` (`cleared: true`, the cleared proposals still pending on its first page) come newest first, `limit` at a time (50, at most 200), older than the notice `?before=<id>` |
| `GET /notices/changes?since=` | moves into a done status at or after `since` (the other status changes aren't news, ORR-1151) (required, a time) on the issues in the asker's bell, oldest first, the latest 2000: `{id, project, issue, before, after, created_by, session_name?, created_at}`. What the notifications page says happened to them (ORR-803) |
| `POST /notices/clear` | `{ids, proposals}` or `{before}` → `{cleared}`: a person takes them out of their own bell, and never a session's; a member's clears are their own, and `proposals` are the owner's: the comments by `ids`, agents' proposals by `proposals: [{project, issue}]`, or every comment made at or before `before` that isn't waiting on them. Comments stay on their issues, proposals stay pending |
| `POST /notices/read` | `{ids}` → `{read}`: marks comments read, as opening one on the notifications page does, and leaves what the bell counts alone; a person's are their own, and never a session's. `{read: true}` on `POST /notices/clear` clears every one read, leaving those waiting |

### Images

A comment (or any Markdown: notes, docs) shows an image orrery keeps: send it, then put the `markdown`
that comes back in the text. orrery keeps it in its database, so a copy of the database takes it along.

| | |
|---|---|
| `GET /mcp` | `{groups, requests, env}`: what the channel's MCP server offers, from its own code: its tools by what they do and who gets each, what the chat asks the owner first, and the environment it reads. The MCP server tab on Connect shows it |
| `POST /uploads` | `{data, name?}`: `data` is a PNG, JPEG, GIF or WebP in base64 (a `data:` URL works too), 10 MB at most; no SVG. A PNG or JPEG of 16 KB or more is kept as WebP when that's smaller (quality 90 for a PNG, 82 for a JPEG; no wider than 2,560 px or taller than 16,383), and a JPEG WebP doesn't beat is written again as a JPEG at 82 when that's smaller. Either way it loses its metadata (EXIF, a photo's place), so `type` and `size` are what's kept. → `{id, type, size, url, markdown}`, where `url` is `/api/uploads/<id>` and `markdown` is `![name](url)`. A picture whose alt text starts with `Before`, followed by nothing but one starting with `After` (on the next line, or in the next paragraph), shows as a slider between the two |
| `GET /uploads/:id` | the image |

```bash
curl -s -X POST $ORRERY_URL/api/uploads -H 'Content-Type: application/json' -H 'Orrery-Actor: claude' \
  -d "{\"name\": \"board.png\", \"data\": \"$(base64 < board.png | tr -d '\n')\"}"
```

## Schedules

Recurring work in a project. A `message` schedule sends its message (`notes`) to one of the project's
listening sessions each run, the first one free (see `POST …/focus`), with no issue (a `message` signal; the run is `sent`). Otherwise, at each
time a schedule makes an issue (its title plus the day, e.g.
`Groom the backlog · Mon 26 Oct`), placed as it says and marked with `schedule`. Each top-level `- [ ]` line in its `notes` becomes a
sub-issue, in the order written, with the same priority and status and in the same milestone: a bold lead is the title and the rest of the line
its notes (with no lead, the line is the title), and what's indented under it goes with it. The rest stays the issue's `notes`. If one
can't be made the run is `failed` and leaves nothing behind. With `ask` it points
the project's listening sessions at it (the owner's schedules only, as with every signal; if no session
is listening, the next to connect within a day gets it). An agent's message or session schedule doesn't run (each
run is `skipped`) until the owner makes it theirs with `POST …/schedules/:id/adopt {seen?}` (Make it mine), `seen`
being the `updated_at` they read it at: one changed since is a 409, so they never take on words they haven't read.
Changing it, as the owner or not, leaves it the agent's (ORR-456). With `skip_open` (the default) a run is skipped
while the last run's issue isn't done; with `only_if_changed`, a message run is skipped (`nothing changed`) when no
issue or comment in the project changed since the last run it sent. Missed runs while orrery was down run once when it's back.
A schedule's own `model` and `effort` (ORR-869; null takes its kind's) are what its work runs on: a session schedule starts its
session on them, a message schedule's message is taken by no session on a lighter model (and starts one on them when none is
listening), and an issue schedule writes them onto each issue it makes, which then starts its sessions on them.
An `untrusted` message schedule, one whose session reads what others wrote (GitHub issues), never messages the project's
sessions: each run has a launcher start a locked-down session for its message alone, or fails saying why (no launcher,
Starting sessions off, the limit). That session's new issues are made proposals labelled `external` (only that: labels it picks are dropped), and its other
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
`issue.release`, `issue.proposal`, `issue.depends`… and `issue.deleted`). An issue whose blockers are all done, or whose last open one was unlinked, is `issue.unblocked`; one whose blocker was canceled `issue.blocker_canceled` (orrery asks the owner on it), or reopened while it's in progress `issue.blocker_reopened` (orrery tells its session). Comments are `comment.added` and `comment.asks`, a session
asking the owner. Releases are `release.created`, `.frozen`, `.thawed`, `.shipped`, `.unshipped` and `.deleted`;
milestones `milestone.created` and `milestone.changed` (a new title or summary), and epics `epic.changed` (a new title or notes, on each project with an issue in it); a deleted milestone's or epic's issues are each `issue.milestone` or `issue.epic`. orrery tells the session working an issue each of these touches, in a message (ORR-984); docs `doc.created`, `.changed` and `.deleted`. An issue's pull request, as orrery's poll finds it,
is `pr.conflicting`, `pr.behind`, `pr.merged`, `pr.closed` (closed without merging), `pr.checks_failed` and
`pr.changes_requested`, each once per change, with orrery commenting on the issue as it happens (by `orrery`, which
reaches the session on the issue), and `pr.ready` (it can merge again) and `pr.approved`, which it only records. A merge
of one rated high risk (`PUT …/risk`), or one that changed a migration, auth, a permission, secrets or egress whatever it
was rated, is `pr.risky_merged` too, and orrery asks the owner on the issue to review it. One that still needs work an
hour after orrery said so, with no comment on the issue and nothing on the PR since (a push, a comment), is
`pr.unattended`, and orrery asks the owner on the issue once (ORR-1184). With no session on the issue, a PR that
conflicts, fails its checks or is asked for changes is also a `focus` from `orrery` for the next session free to take
it, which isn't one it starts. A merge of the issue's own PR
(its branch names the issue, or it names no other) also moves the issue to Done, as `orrery` (`issue.status`), when
nothing else is open on it: no other PR, no open sub-issue, and not a proposal. The asks left open on it leave the
owner's bell, and orrery's note says so; the review ask comes after, on the Done issue. Its
comments are in its own words: where to read failed checks (`gh pr checks`, `gh run view --log-failed`) and who asked
for changes and where, never a check's output or someone else's review, as a session reads them as the owner's; a
review by the owner's own GitHub handle (`handle`) is quoted. After a PR's checks fail a fourth time, it doesn't tell
the session and asks the owner instead (`asks: feedback`). Later failures are only recorded until the owner answers on the
issue or focuses a session on it; then three more are told before it asks again. Checks going green start the count afresh. Each kind the [event log](#event-log)
records counts too (`server.error`, `page.error`, `session.started`, `launcher.gone`…), even with
Advanced off. A repeat of an open error isn't one. `on` is a type or a pattern, `*` for any part (`release.*`,
`*.failed`, `*`). `on_filter` says what the event must also say:
- `to` / `from`: the value it changed to or from (a status's id or kind, a label added, a release's version).
- `by`: `owner` or `session`.
- `level`: the event log's.

Such a schedule runs once per subject (an issue bounced in and out of a status runs it once; a run that was skipped or
failed doesn't count), not within a minute of its last run (a subject that minute holds back waits its turn, one a minute, and runs if it still fits: an issue that's left the status asked for doesn't; events with no subject heard together count as one), and never on what a schedule's run did (a session it started stopping included, so a session schedule on `session.stopped` can't start itself again), nor on what an untrusted schedule's session wrote. Its issue's title ends with the subject (`Review · ORR-12`),
and its description or message ends with what happened by ids, never another's words:
`On issue.status: ORR-12 (in-progress → in-review), by claude.` The change is given only where it's ids or fixed
words (status, priority, milestone, release, parent, proposal); a label or an assignee isn't, nor an agent's name that isn't
a handle (`by an agent`), and the owner is `by the owner`. An event about the orrery as a whole (a server error)
goes to every project's schedules; any other, only its own project's.
A run's outcome (`schedule.failed`, `schedule.ran`, `schedule.skipped`) is the exception: other schedules hear it,
so an alert on `*.failed` hears a schedule fail, except when the run was itself set off by an outcome.

| | |
|---|---|
| `GET /schedules` | every project's, soonest first, paused last |
| `GET /projects/:project/schedules` | the project's |
| `POST /projects/:project/schedules` | `{kind?, title, notes?, presets?, cron, at or on (with on_filter?), timezone?, column?, milestone?, priority?, labels?, ask?, skip_open?, only_if_changed?, untrusted?, enabled?, model?, effort?}`: `cron` is five fields (`0 9 * * 1-5`), `at` a time to run once, `on` an event (above); setting one lets go of the others, `timezone` an IANA zone (the server's by default), `column` the open status its issues start in (an id or a kind; `todo` by default); `kind` is `issue` (default), `message` (then `notes` is the message, after any `presets`, and the issue fields don't apply) `session` (above) or `action`: it moves what its event is about to `column`, a status it needs and which may be closed, with `move_from` the statuses (ids or kinds) it moves issues out of (any open one when left out). The owner's alone (403), on `on` alone (400): `issue.*`, `comment.*` and `pr.*` move that issue, and `release.*` the release's issues in this project, sub-issues included, at any depth. It passes over a parent (it follows its sub-issues), a proposal, an issue waiting on the owner, and, on `pr.*`, an issue with another pull request open. Each it moves gets orrery's comment saying why, with `notes` after it, which wakes no session. A run by hand has no event, so it's `skipped` |
| `POST /schedules` | `{projects: "*" or [ids], skip?, …the fields above}` → 201 a schedule across projects: the owner's alone (403). Each project it's for gets an ordinary schedule made from it, with `across` set and its own runs and guards, so each run is that project's. `*` takes in a project added later, within 30 s, less those in `skip`. It can't name a `milestone`, or be `at` or `untrusted` (400), and a project's own preset fails unless it's for that project alone. Every project is checked first, and one that can't take it makes none |
| `GET /schedules/across` | those, oldest first: its fields, `id`, `projects`, `skip`, and `on_projects`, the projects it has a schedule on now |
| `PATCH` · `DELETE /schedules/across/:across` | `{projects?, skip?, …the fields}` changes it and every schedule made from it, checked on all first; deleting takes them with it, and their issues stay. The owner's alone |
| `POST /projects/:project/schedules/enabled` | `{enabled}` → `{changed, failed: [{id, title, message}]}`: pauses or activates all the project's schedules at once, the owner's alone (403). A copy of one across projects changes, and that schedule itself doesn't; activating skips a paused one-off, as it may have run; one that fails doesn't stop the rest |
| `GET` · `PATCH` · `DELETE /projects/:project/schedules/:schedule` | One made from a schedule across projects can only be paused here (else 409), and deleting it leaves its project out of that schedule. `PATCH {enabled: false}` pauses it; deleting leaves its issues; the owner's can't be changed or deleted by agents (403) |
| `POST /projects/:project/schedules/:schedule/run` | runs it now, even while the last run's issue is open → the run `{at, outcome, issue?, note?, subject?}`; the owner's, only by the owner. `{"instead": true}` runs it in place of its next run, which is skipped (a one-off is then done; 409 when it has none, as one on an event has none) |
| `POST /projects/:project/schedules/:schedule/adopt` | `{seen?}` → the schedule: the owner making an agent's schedule theirs (Make it mine), so it runs as them and only they change it; `seen` is the `updated_at` they read it at, and one changed since is a 409. 403 for an agent; one already the owner's comes back as it is |
| `POST /projects/:project/issues/:issue/schedule-requests` | `{schedule, id?, why?}` → 201 the comment asking: a working session asking the owner, on the issue it's working, to make a schedule or change schedule `id`. `schedule` holds the fields as above, less `untrusted`, checked as they'd be for the owner. The comment waits on their decision (`asks: "decision"`) and carries the request as `schedule` `{id?, title, changes, body, state}`; nothing is saved until they allow it. Asking again for the same schedule expires the earlier request. Not the chat (it asks in its chat) nor an untrusted session (403) |
| `POST /projects/:project/issues/:issue/schedule-requests/:comment` | `{allow}` → the comment asking, answered: the owner's Allow saves the schedule as theirs, and it runs; Deny saves nothing. Either way their answer is a comment of theirs, which reaches the session. 403 for an agent; 409 once answered or expired |

Each schedule carries `next_run` (none for one on an event), its `presets`, `held` when its minute is holding subjects back (how many), and its latest `runs`: `made` (with the issue), `sent` (a message, or a session started), `skipped` or `failed` (with why), and an event run's `subject`. An action schedule's run that moved anything is `made`, with its `note` saying what, and `issue` when it moved one; one that moved nothing is `skipped`, so the subject's next event can still move it. It also carries `move_from`.

## Secrets

Keys for outside services (GitHub, Stripe, a deploy hook) that agents use without ever seeing them.
The owner sets a secret; nothing gives its value back, not this API, the events or the guide. An agent
asks orrery to make the request, with `{{secret:NAME}}` where the value goes, and orrery fills it in,
sends it, and answers with the value scrubbed out. They're encrypted with
`ORRERY_SECRET_KEY` (`NUXT_SECRET_KEY` without Docker) when it's set, else with a key orrery makes on its first start
and keeps in `orrery.key` beside the database; only when it can't keep one there do these routes answer 503.

| | |
|---|---|
| `GET /secrets` | every secret by name: `{name, last4, hosts, projects, last_used}`, never a value |
| `GET /secrets/:name` | the secret with its latest `uses` |
| `PUT /secrets/:name` | `{value, hosts, projects?}`, the owner only: sets it, new (201) or replacing. `name` is capitals, digits and `_` (`STRIPE_KEY`); `value` at least 8 characters; `hosts` the host names it may go to (`api.stripe.com`, with a port if not 443); `projects` the projects that may use it (none: every one) |
| `PATCH /secrets/:name` | `{hosts?, projects?}`, the owner only: only narrows them. Letting it go somewhere new takes the value again (`PUT`), so whoever doesn't know it can't send it elsewhere |
| `DELETE /secrets/:name` | the owner only; its uses go with it |
| `POST /egress` | `{url, method?, headers?, body?, project, issue?}` → `{status, headers, body, truncated?, secrets}`: the request made with each `{{secret:NAME}}` filled in (in the url, a header or the body) |

- **Only to its hosts.** Every secret in a request must allow the url's host (else a 403), and the url must be
  https (else a 400); either way nothing is sent. Every request names the `project` it's for (else a 400, ORR-1069), and a secret kept to some `projects` is only sent for one of them.
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

orrery uses one secret itself: `GITHUB_TOKEN`, when it may go to `api.github.com` (and be used for the
project), to read pull requests (`GET …/issues/:issue/pulls`, `GET /pulls`), polled in the background. It needs read access to the
repo's pull requests and checks; a fine-grained token with *Pull requests: read* does. App settings lists it ready-made until it's set, with its host filled in ([Running orrery → A GitHub token](running.md#a-github-token)). Its uses are kept as
`orrery`'s (the latest 100), and not in the event log.

## Signals to sessions

The owner can ask the Claude sessions on a project to work on an issue now, or to work through a
milestone's open issues (**Focus on this** on its page). Only the owner's signals reach sessions. A milestone's
signal has `milestone` instead of `issue`, and the stream adds its open `issues`, most urgent first. With
`status` (**Focus on all Todo** on a status group of its page) it's only the milestone's issues of that status.

The owner's comment on an issue becomes a `comment` signal for the session working it: the last one
whose hook saw it write to the issue (a curl that PATCHes it, comments on it, …), or that was asked to
focus on it. While that session is listening it alone gets the comment; with none known, or that one
gone, one session orrery picks does, as a focus goes: an idle one, else the next to go idle. That session
becomes the issue's, so the owner's next comment on it goes there too, and one session answers the thread
(ORR-513). A session that connects catches up on a comment nobody took in a day. When the owner changes a comment's words, the new version goes the same way,
starting `(Edited: this replaces their earlier comment.)`.

An issue the owner makes urgent (`P0`, created as one or raised to it) goes out as a `focus` the same way,
without their pressing anything: to the session working it, else to one session orrery picks. It goes when a `P0`
issue becomes open work, so also when a `P0` proposal is committed or a closed `P0` issue reopened; not for
an agent's P0. A schedule that asks the sessions sends its one focus, saying the issue is urgent.

An issue the owner moves into a Todo status, or makes there, goes to an idle session at once (ORR-515): a
`focus` saying `It just landed in Todo.`, aimed at a listening session that's idle with nothing in progress
and nothing queued, a different one for each issue, the project's own before one hearing several. A burst of
moves (a bulk move) is handed out once, about a second and a half after it, the most urgent first, one per idle
session; the rest wait in Todo. With nobody idle nothing is sent or queued and no session is started. Not for a
proposal, a parent, an issue assigned to anyone but `claude` or waiting on the owner, one moved within Todo, or one with a
focus already on its way (Focus on this, a `P0`'s push); not for an agent's move, a schedule's or an untrusted
session's.

| | |
|---|---|
| `POST /projects/:project/issues/:issue/focus` | `{note?, session?, instructions?, start?}` → `{signal, listeners}`: sends it, and says how many sessions heard; `session` is the one it's for, by its id or its name (`orrery · Nide`, or `Nide`, in any case; a stream with no session by the `name` it gave), a 404 for one the project doesn't know, and left out it goes to the one on the issue or one orrery picks (`*`, every session, is a 400: only a milestone can go to them all); `start: true` (the owner's) starts a session for it when nobody's listening, even with `on_signal` off (see [Starting sessions](#starting-sessions)) |
| `POST /projects/:project/milestones/:milestone/focus` | `{note?, session?, status?, release?, instructions?, start?}` → `{signal, listeners}`: the same, for a milestone (`none`: the issues in no milestone; `all`: every milestone's), which `session` `*` sends to every session; `status` (open statuses' ids, or `backlog`, `todo` or `started`, comma-separated) narrows it to those issues, `release` (a version) to those set for it, at any depth, and `epic` (a number, `EPC-1` or its full id) to those in that epic |
| `GET /projects/:project/signals?after=` | the signals after that id, oldest first, 50 at most; `?issue=` or `?milestone=` for the latest about one; `?waiting=pooled` the owner's and members' from the last day for the one session orrery picks that none has heard yet, `?waiting=scheduled` the owner's unheard messages and scheduled focuses from the last day, `?waiting=focus&issue=` the owner's and members' unheard focuses on that issue from the last ten minutes, `?focused=` the owner's focuses on that issue from the last day, heard or not (`&target=`: aimed at that session) |
| `GET /projects/:project/signals/stream` | first `ready` (`{project, listeners}`), then server-sent `signal` events as they're sent (`?after=` or `Last-Event-ID` to catch up), `name` `{name}`: what orrery calls the session, once it's known and again when it changes, `stop` when the owner stops the session, and `ping` every 25 seconds; a schedule's message sent again with the same text comes once in a catch-up, and not again while the session hasn't finished a turn since the last copy (the copies count as delivered); `?format=text` gives one line each, for the Monitor tool |
| `GET /signals/stream?projects=hub,css` | the same for a session on several projects, on one stream: `ready` is `{projects, listeners: {<project>: n}}` and each `signal` says its `project`; `*` follows every project, and each one made later; `404` for a project that doesn't exist |
| `GET /projects/:project/listeners` | `{count}` of sessions listening |

`GET /version` → `{version, newer}`: the version running, and `newer` (`{version, url}`, the release's page on GitHub) when the
last check of orrery's releases found a newer one; null when there's none, `ORRERY_UPDATE_CHECK=false` turned the check off, or it
hasn't run yet. A pre-release counts only for an orrery running one. A failed check keeps the last answer and goes in the
event log as `update.failed`.

A session listens through orrery's channel (`channel/orrery-channel.mjs` in this repo, served at `/channel`, an MCP
server registered in the repo's `.mcp.json` as `orrery-<environment>`, one per orrery for all of the repo's
projects in `ORRERY_PROJECTS`, followed on one stream; start Claude with `--dangerously-load-development-channels server:orrery-<environment>`),
or by watching the text stream with the Monitor tool. The Connect page at `/connect` hands out both.
`GET /settings` says the orrery's `id` (made once, when it first starts): a channel given `ORRERY_ID` refuses an
orrery with another id. `GET /machine` says what only the running server knows, none of it stored, so it stays this
server's when the stored settings are the Rust API's (ORR-954): its `environment` (`personal`, `work`, …), and where
the data is, read only: `database: {kind, where, host?, volume?, size?}`, `kind` `sqlite` (`where` the file's path, as
orrery opens it) or `postgres` (`where` as `user@host:port/name`, never the password). Under Docker, `host` is where the
SQLite file is on the computer (from `ORRERY_DATA`, a relative one from the compose folder) or `volume` the Docker volume
it's in; `where` stays the path inside the container. `size` is how big it is in bytes (a SQLite file with its `-wal`,
or `pg_database_size` on Postgres), left out when it can't be read. Which database orrery runs on is set only by
`ORRERY_DATABASE`; the API has no way to move it, and orrery takes no backups.
A session heard on several projects is listed on each one's
group on the Sessions page, with the others in `also`. A channel that finds the name its server goes by in the
repo's `.mcp.json` sends it (`?server=`), and the session lists it as `server`, for the command that restarts it with
the channel.

## Sessions

The Claude sessions working on a project, live (not stored): their name, what they're doing and
whether they're listening. Hooks report state (`channel/orrery-hook.mjs` on `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Stop`, `StopFailure`, `Notification`, `SessionEnd`); the channel's connection says it's
listening. Both identify the window by `CLAUDE_CODE_SESSION_ID`; `ORRERY_SESSION` names it. One with no name of its
own gets one made up, starting with its project, renamed for a project it moves to; one whose channel is heard on
several projects goes by the name alone, unique across every session, and gets its project back once it hears one. A `/clear`
gives the window a new id while its channel stays connected: the session keeps its name and listening,
and its old ids still find it.

| | |
|---|---|
| `GET /sessions` | every session |
| `GET /projects/:project/sessions` | the project's, each `{id, name, state, since, listening, reachable, version?}`; `version` is its channel's code, as the channel says on connecting (`?version=` on its stream; one from before 1.0.0-rc.10 doesn't); `state` is `idle`, `working`, `waiting` (at a permission prompt, with `asks`, what Claude Code's notification says it wants, and `asking`, `{name, detail?, questions?}`: the tool and what it would do, or a question's questions, as its hook said) or `starting`; `reachable` when its channel is open and knows to end it, so it can be stopped |
| `POST /projects/:project/sessions/:session/stop` | the session: the owner stopping it, one orrery started through its launcher, any other through its channel, which ends its claude process; 409 when it has no channel running |
| `POST /projects/:project/sessions/:session/forget` | the session: the owner taking one with no channel open off the list (nothing reaches its process; its next hook brings it back if it's still running); 409 when its channel is open. One not listening is also dropped on its own after six quiet hours, or one idle hour with no channel open |
| `POST /projects/:project/sessions/:session/message` | `{text, preset?}` → 201 the signal: the owner's own words to that one session, a `message` with it as `target` and no `schedule`, which its channel shows as a message to it alone. With `preset` (the id of one its sessions can have, else a 400) the words are that preset's text as the owner sent it, tweaked or not, and the signal's `preset` keeps its name as it was then, to label it by; 404 for a session not on the project, 409 for one that isn't listening. Never the owner's [chat](#chats)'s (a 403): it asks the owner instead |
| `POST /sessions/message` | `{text, projects?, states?}` → 201 `{sent: [{project, session, name, signal}]}`: the owner's own words to every listening session at once, each a `message` with it as `target`, as above. Only `idle` ones unless `states` lists others (`working`, `waiting`); `projects` narrows it to sessions on or hearing any of them. A session hearing several projects gets it once; nobody listening is an empty `sent`, and starts no session. Never the owner's [chat](#chats)'s, as above |
| `GET /projects/:project/sessions/:session/next` | `{issues, text}`: a session asking for its next issue itself (the channel's `next`), with what orrery would hand it once it's idle: the issues it may start (each `{id, project, title, column, priority}`, most urgent first, at most 10) and the message they go with. With none, `issues` is empty and `text` says why: it still has work (an issue in progress that isn't parked, or a question waiting on the owner), its run has issues left, it's the chat or an untrusted schedule's, or nothing is free. Counts as handed, so the push doesn't send the same list again. 404 for a session orrery doesn't know on the project |
| `GET /projects/:project/sessions/work` | `{<session id>: {issues, signals}}`: what each is on, for its Sessions page: the open issues it worked last (newest first, each `{id, title, column, kind, priority, since}`, `since` being when it took the issue) and the last five signals that went to it |
| `GET /sessions/work?projects=a,b` | `{<project>: {<session id>: {issues, signals}}}`: the same for every project with sessions (or those named), in one call |
| `GET /projects/:project/context?kind=` | what orrery puts into a session's context on the project, part by part (ORR-549): `{kind, projects, parts, chars, tokens}`, each part `{id, group, title, text, chars, tokens}`: the channel's `instructions`, each of its `tools` as listed, and the `start` context a session was started with. `kind` is `work` (the default), `chat` or `untrusted`; `?session=<id>` gives a running one's, its kind and projects its own, with `sofar`: its latest 30 signals (each payload as its stream sent it) and tool answers, newest first, each `{at, kind, title, text, chars, tokens, before?}` (`before`: given before its last `/clear` or compaction, so no longer in its context), `text` cut at 20,000 characters (an `egress` answer's left empty, its size kept: it's what an outside service sent back), kept in memory since orrery started. Like every read, it's open to anything that reaches orrery, or with login on, to any credential. Tokens are estimated as a quarter of the characters |
| `POST /sessions/:session/calls` | `{tool, text}` → 204: the channel saying what one of its tool calls answered, for the Context page's `sofar` |
| `POST /sessions` | `{id or pid, project, event, name?, cwd?, message?, command?, tool?, reason?, source?, started?, error?, error_text?, model?, effort?, context?, window?}`: what a hook sends. `model` is the model the session runs on (`claude-opus-5-5`): what `SessionStart` says when it does, else on `Stop` and `PreToolUse` the latest reply's in its transcript. It's kept on the session until another report names a new one, and dropped unless it looks like a model id (up to 100 letters, digits and `.:@/[]-_`). `effort` (`low` … `max`) is the effort level it runs at, as its hook says on tool events, kept the same way as the session's `effort`, and dropped unless it's one of those. `context` (ORR-968) is the tokens its context holds, read off its transcript on `Stop` and `PreToolUse` (the latest reply's input, cache read and cache written), a whole number up to 10M: the session reads `context: {tokens, window, compacted?}`, `window` being what the hook sends beside it, its agent's adapter's measure (ORR-1074), and for a hook that sends none the model's as Claude Code's table of models has it (ORR-993): 1M for a `[1m]` model, every Claude 5 model and Opus 4.7 on (whose ids don't say so), and a model it can't tell, or once more than 200k is in use, else 200k (Claude 3, and Claude 4 before them); a `SessionStart` with `source: "compact"` sets `compacted` and one with `source: "clear"` drops `context` until its next count. A session that starts an issue (`PATCH` with a `status` that starts it) out of the scope of the one it started before, since its last clear, with more than 50k tokens in its context, reads `carried_over: {from, to, tokens, at}` until its next clear, and the event log keeps `session.carried_over`. For a session orrery started (not a chat or an untrusted run), the `PATCH` answers with `carried_over: {from, tokens}` beside the issue, and the session is cleared once it goes idle with that issue still in progress, then sent a focus on it alone, as the owner's. The same scope is the same issue, a sub-issue, its parent or a sibling, or the same epic or milestone. `tool` (`{name, detail?, questions?}`, on `PreToolUse` and `PermissionRequest`) is the tool it's about to use or asks for, with the command, file path, address or search cut to 300 characters (nothing from an MCP tool's input); a question to the owner (`AskUserQuestion`, ORR-1155) brings `questions`, each `{question, options}` with its options' labels (at most 4 questions of 300 characters, 6 options of 100; none from an untrusted session), and the page shows the session as having a question rather than needing permission; a permission prompt the session then waits at is for it (`asking`), the `PermissionRequest`'s tool over a `PreToolUse` that lands after it until the prompt is answered. A `PermissionRequest` leaves the state to the `Notification` that comes with it. A `SessionEnd` with `reason: "clear"` keeps the session, and the next `SessionStart` with `source: "clear"` in its `cwd` takes it over when no pid ties them; a `SessionStart` with `source` `clear`, `compact` or `resume` answers with `brief` too, the issues it has in progress, for the hook to hand the fresh context; a session orrery started with context (`started`, its launch id, from `ORRERY_STARTED`) gets that context in `brief` on every `SessionStart`, its first included. Every `SessionStart` answers with `repo` too, the project's address or `null`, which the hook tells the session with the folder's own repo, branch and default branch (ORR-1070). A `Stop` from a listening session that a few seconds later is still idle, with no signal waiting, while an issue it has in progress has sub-issues in backlog or todo (it just split it, say), sends it alone a focus on the most urgent of them, as the owner's, so it carries on; not again for a sub-issue that hasn't changed, and never to a session an untrusted schedule's run started. One orrery started with nothing in progress, whose last issue was a sub-issue now closed, is sent the same way to the most urgent sibling still in backlog or todo, instead of the `clear` (ORR-903; a session opened by hand isn't, as it's never cleared); once it leaves that sibling unchanged, its next idle clears it. A milestone or scope it was working through stays its run. A `StopFailure` (a turn an API error cut off, with Claude Code's `error`, `rate_limit` say) puts each issue the session has in progress back in Todo with no assignee (with more than one person, it keeps its assignee, for another of their agents), with a comment from `claude` saying why, leaving one in review or waiting on the owner. The session reads `cut_off: {error?, text?, at}` until its next turn gets going, and the event log keeps `session.cut_off` as a warning |

### Starting sessions

Once the owner lets orrery start sessions (`PATCH /settings {starts: {limit, min?, minutes?, idle_minutes?, on_signal?}}`, one setting
for every project; `null` stops it), a project gets sessions started for it, with no terminal: when
the owner's signal (a focus, a comment, a schedule's) finds nobody listening on it, orrery asks the
project's launcher (`channel/orrery-launcher.mjs`, on the host, installed as a service with `--install`) to start one in a detached tmux session.
With `on_signal: false` (kept only when false; missing is true), work alone doesn't: it waits for a session the owner
starts, by hand or with a focus sent with `start: true` (Focus on this, with nobody listening). Schedules that start
sessions still do.
A project whose repo has no launcher gets none. Each project shows the setting as its `starts`.
At most `limit` run at once, counted over every project. Each
runs until it's stopped: by the owner, or, when the setting has them, once `minutes` are up or it has sat
idle for `idle_minutes` (1 to 1440 each). Neither stops one mid-work: orrery waits until the session is
idle with no issue in progress and no signal waiting for it, then has its launcher stop it. With `min` (1 to `limit`), orrery keeps that many running over every project: once a
session it stopped that way has ended, it starts one like it in its place, on the same project with the same `context`
and the projects it heard, with a fresh context, unless enough are running without it. One the owner stops isn't
replaced, nor an untrusted schedule's run. A replacement waits, checked every 30 seconds, while its project has no
launcher or the limit has no room. Waiting replacements are kept in memory, so an orrery that restarts forgets them. Several signals at once start one
session, and with several launchers the first to claim a launch starts it. Its channel catches up from the
signal it was started for. The owner can also start one by hand (`POST .../launches`, Start session on the
Sessions page), which catches up from the project's latest signal. Those sessions list with `started: {launch, tmux, stops_at?, context?, hears?, untrusted?, chat?}` (no `stops_at`: until stopped), and count toward
the limits while their channel is connected.

One started by hand can be given more context: presets the owner picks (any number, the orrery's and the
project's own) and their own words. Its `context` is `{presets: [names], instructions?, text}`, `text` being the
presets' texts and then the owner's words. Its hook's brief hands it to the session on every `SessionStart`, its
first included, so it holds after a `/clear` or a compaction; the first signal on its stream carries it too
(`context` on the stream's `signal`, which the channel adds after the message), for a session whose hook didn't get
through. Later signals leave it out. orrery doesn't read anything into it: a "review agent" is a preset
with review instructions in it.

| | |
|---|---|
| `GET /launches/stream?serve=[…]&version=` | for the launcher, one stream for every project it serves on this orrery (ORR-1076), in place of a `…/projects/:project/launches/stream` each. `serve` is a JSON list, an entry a project: `{project, dir?, home?, every?, picked?, connected?}`, each saying what that project's own stream's query would (`home: true` for `home=1`, `every: true` for `every=1`). Each project is counted as one of its launchers, the same as on its own stream. Server-sent `ready` `{projects: {[project]: {starts, token}}, unknown, version, oldest}`: each project's starts and the token its claims on that project send, and the projects asked for that aren't here, or that a member's key isn't on the board of. Then it sends each served project's launches no launcher has taken yet, and every event that project's own stream sends, with its `project` in the data. A project deleted meanwhile is let go, and one made later needs the launcher to connect again. An orrery older than this answers 404, and the launcher then follows a stream per project |
| `GET /projects/:project/launches/stream?dir=&every=1&version=&picked=` | for the launcher, running in the folder `dir` (projects whose launchers share one are in one repo), or with `home=1` and no `dir` from its machine's default folder, for a project with no repo (it's given a launch only while no launcher in the project's repo is connected), with `every=1` where its channel serves every project (`*`), `version` its code's, and `picked` the time a session's channel picked the folder up, when it did (kept only as a time, for `GET …/launches`' `repos`): server-sent `ready` `{project, starts, version, token}` with the orrery's own version (a launcher on other code restarts on its checkout's once that has moved on and it has no session running) and the token its claims send, new on each connection, then a `launch` for each of the project's launches no launcher has taken yet (one an outdated launcher was refused waits for one to restart and take it: half an hour, a chat until it ends), `launch` `{id, project, after, minutes?, tmux, context?, hears?, untrusted?, chat?, global?, person?, model?, effort?}` (claim it, then start it with `hears` as its session's `ORRERY_HEAR`, a `global` one in the orrery's default folder with `ORRERY_GLOBAL=yes` and no `ORRERY_HEAR`, `person` as its `ORRERY_PERSON`, and `model` and `effort` as `claude --model … --effort …`; no `minutes`: until stopped), `stop` `{id}` (the owner stopped it, or it's done and past its time or idle too long), `extend` `{id, stops_at}`, and `clear` `{id}`: one of its sessions went idle with nothing in progress and no signal waiting, so it types `/clear` for a fresh context, and the brief after it hands the session what's left of the milestone or scope it was working through (or the owner cleared their chat's context); `watch` `{id, terminal}`: the owner pressed Watch, so the launcher running that session opens a terminal on its machine attached to it, in that app; `allow` `{id}`: the owner pressed Allow on that session's permission prompt, so its launcher presses Enter, only if its pane still shows one with the cursor on "Yes"; and `view` `{id}`: the owner is viewing that session's screen, so its launcher sends it (`POST …/screen`) about once a second until told nobody is. A launcher on a member's agent key hears only that person's launches and their `stop`, `extend`, `clear`, `watch`, `allow`, `deny` and `view`, which in this release is none, and isn't counted as one of the project's launchers; its claim on anyone else's launch is `false`, its `ended` and `screen` for one are a 403, and `running` drops them |
| `POST /projects/:project/launches` | `{issue?, statuses?, release?, presets?, instructions?, hears?, model?, effort?, global?}` → 201 the launch: the owner starting a session by hand, through its launcher, catching up from the latest signal; with `issue`, from a focus on it that only this session hears (aimed at `launch-<id>`, which the session takes as one of its ids when it connects); with `statuses` (ids or kinds; `todo` and `started` when only `release` is sent) and `release`, from a focus made the same way on the whole project's issues in them (milestone `all`); `presets` (ids, the orrery's or the project's) and `instructions` (text) give it context; `hears` (project ids) is what the session hears: the project alone, or it and others whose launchers run in the same folder, as one session (without it, what the repo's channel lists); `global: true` starts a global session instead: in the orrery's default folder, never the repo, hearing every project and with none of its own, so its calls name theirs; it's kept under this project (`started.global` on its session) and can't go with `hears` (400); `model` (`best`, `opus`, `sonnet`, `haiku`, `fable`, `default`, `opusplan`, or a full id such as `claude-sonnet-5-5`) and `effort` (`low`, `medium`, `high`, `xhigh`, `max`) start it on them, kept as `started.model` and `started.effort` on its session. Without either, one focused on an `issue` starts on its kind's model, its highest-ranked label's (`security`, `release`, `bug`, `feature`, `research`, `maintenance`, then `docs` on `sonnet`; `best`, Claude Code's own pick, asks for none), and any other on Claude Code's default there; 400 for another project's preset, or a model or effort it doesn't take; 409 without the project's opt-in, a launcher or room under the limit, or for a project in `hears` not served from its folder |
| `GET /projects/:project/launches` | `{launchers, versions, minimum, folders, repos, every, started, starting, total}`: how many launchers are connected (0: none to start one), the version each runs (`''` for one too old to say), the oldest version that does all this orrery asks of a launcher, the folders its launchers run in, the same as `repos` (`[{dir, picked_at?, connected_at?}]`, `picked_at` when a session's channel picked the folder up, and `connected_at` when Connect a repo added it, rather than `--install`), whether one serves every project (so a launch without `hears` hears them all), the sessions it started and has on their way, and `total`, those on every project, which the limit counts |
| `POST /projects/:project/launches/:launch/claim` | `{claimed, repo?}`: a launcher taking the launch on; only the first gets `true`, with the project's `repo` (its address, or `null`), which the launcher tells the session with the folder's own repo in its system prompt. It sends the token its stream's `ready` gave it as `Orrery-Launcher`: a claim without the token of a launcher connected for the project is refused (`false`, and a `launcher.outdated` warning, since a launcher running older code sends none; it's offered the launch again once restarted). An untrusted schedule's launch (`untrusted: true`) goes only to one that sends `?untrusted=no-bash`, saying it starts it locked down with no Bash (an older launcher's `?untrusted=yes` is refused), a chat's (`chat: true`) only to one that sends `?chat=yes`, saying it starts it able only to read and answer, one with a `model` or `effort` only to one that sends `?model=yes`, saying it starts it on them, a global session's (`global: true`) only to one that sends `?global=yes`, saying it starts it in the default folder, and an ended chat written in again with `resume` (its Claude session id) takes that session up again (`claude --resume`) only with one that sends `?resume=yes`; to any other it's started fresh, told what was said in the chat |
| `POST /projects/:project/launches/:launch/ended` | 204: the launcher saying the launch's session stopped |
| `POST /projects/:project/launches/running` | `{launches: [{id, tmux, stops_at?, context?, untrusted?, chat?, model?, effort?}]}` → 204: the launcher, each time it connects, saying which sessions it started still run, so a restarted orrery counts them as started again, with the context they were given (a launch orrery still knows keeps its own) |
| `POST /projects/:project/launches/:launch/stop` | the session: the owner stopping it, through its launcher |
| `GET /connects` | `{pickers, current?}`: how many connected launchers can open a folder picker, and the connect request under way |
| `POST /connects` | 201 the request `{id, state}`, `asking`: the owner pressing **Connect a repo** (ORR-708). 409 with no launcher that can. It takes no folder: orrery never names one |
| `GET /connects/:connect` | `{id, state, host?, folder?, projects?, every?, written?, unchanged?, opened?, message?}`. `state` is `asking`, `picking`, `picked`, `writing`, `done`, `canceled` or `failed`; `folder` is only the last part of the path; `projects` what it has on this orrery, and `every` whether its channel serves them all |
| `POST /connects/:connect/write` | `{projects}`, ids on this orrery, to add to the folder chosen → the request, `writing`. The owner's; 400 with none for a repo that has none yet, 404 for a project that isn't here, 409 until a folder is chosen |
| `GET /connects/stream?host=&addresses=&local=` | for a launcher service with a folder picker on its machine (`addresses`: its machine's IPv4 addresses on its networks, comma-separated, and `local` its Bonjour name, `<name>.local`, for `GET /phone`): `ready` `{token, orrery}`, `pick` `{id}`, and `write` `{id, projects: [{id, key}], orrery: {id, environment}, terminal}` to the one that took it. On a server with several people, the owner's alone (403). An older launcher doesn't open it, so it's never asked |
| `POST /connects/:connect/report` | `{state, folder?, projects?, every?, written?, unchanged?, opened?, message?}` with `Orrery-Launcher` (the stream's token) → `{claimed}`: the first to say `picking` holds the request, and any other is told `false`. 403 without a connected launcher's token |
| `POST /projects/:project/launches/:launch/watch` | the session: the owner watching it; its launcher opens a terminal attached to it, in the app `GET /settings` names (`terminal`: `terminal`, `iterm`, `warp` or `ghostty`, set with `PATCH /settings {terminal}`; on Linux the system's own terminal); 409 when no launcher is running for the project |
| `POST /projects/:project/launches/:launch/deny` | the session: the owner denying what it's asking permission for; its launcher answers "No" once, only while the pane still shows the prompt. 409 as for `allow` |
| `POST /projects/:project/launches/:launch/allow` | the session: the owner allowing what it's asking permission for; its launcher answers "Yes" once, only while the pane still shows the prompt ("Yes, and don't ask again" stays in its terminal); 409 when it isn't `waiting`, or no launcher is running for the project |
| `GET /projects/:project/launches/:launch/screen` | `{screen, at?}`: the owner viewing its screen, read only, polled about once a second; the launcher sends the tmux pane as text for as long as this is asked for, and `screen` is null until the first comes in; 409 when no launcher is running for the project |
| `POST /projects/:project/launches/:launch/screen` | `{screen}` → `{watching}`: the launcher sending the screen of a session it started; it stops once `watching` is false |
| `POST /projects/:project/launches/:launch/extend` | `{minutes}` → the session: the owner giving it longer, from when it would have stopped; a 409 for one that runs until stopped |

`POST …/focus` takes `{session}`, an id or a name, to reach one session; a milestone's also takes `{session: "*"}` for every session on the project.
Without it, one session gets it, and orrery picks which: for an issue, the session already on it if that one is
listening; else whichever listening session is idle when it comes; else, with every one busy, the next to go idle
(within a day). The project's own sessions come first: a session whose channel hears several projects
(`ORRERY_PROJECTS`) gets it only while none of the project's own is listening and idle. A schedule's message goes the same way.
A focus or comment about an issue carries `model`, the model its work needs (its kind's; a milestone's focus, the heaviest of
its open issues'), and no session orrery started on a lighter one takes it (`haiku` < `sonnet` < `opus` < `fable` <
`best`; a session on Claude Code's default, or one orrery didn't start, can take anything). With only lighter sessions
listening, it starts one on that model, as it would with nobody listening, and a session carried on to a sub-issue skips
those heavier than its own. A focus on one session makes it the issue's session, unless another listening session has the issue started:
then it stays with that one, and the session asked gets the 409 if it tries to start it. Each signal lists the sessions it reached in `delivered_to`
(`POST /projects/:project/signals/:signal/delivered`, sent by the channel, which also sets a session whose hooks have spoken `working`).

### Chats

The owner's **chat** is a Claude session started for them to talk to on the page, with no terminal. It answers
questions about the project (from its code, read only, and the roadmap) and makes issues and comments when asked;
it works on nothing. It counts towards nothing either: it needs only the project's launcher, not starts turned on or
room under the limit; it isn't one of the started sessions the limit or `GET …/launches` counts; it isn't in the
event log; and pages leave it out of their session lists (its session lists with `started.chat`). It runs until the
owner ends it, which closing its pane does. Each message says which page the owner is on (`page`), so it knows what
"this" and "here" are; that goes to its session at the end of the message and isn't kept with it.

Its launcher starts it with the Claude Code settings of its machine, and the channel's tools but `start_issue`, `finish_issue`,
`update_issue`, `write_doc`, `egress`, `secrets` and `resolve_event`, and its own: `reply`, its answer, the
only way what it says reaches the page, `image`, which shows it an image the owner pasted, `github_issues` and `github_pulls`, which read the GitHub issues and pull requests on the repo its folder's git remote names and write nothing there (`github_pulls {number, part: details | diff | failed_checks, from}`, or a list by `search`, `state` and `limit`), `edit_issue`, which changes
an issue's title, notes, priority, labels, team tasks, GitHub issues, milestone, epic, release, parent or what it depends on when the owner asks, `create_milestone` and `update_milestone`, which make and change a milestone at once (ORR-988), `create_epic`, `update_epic` and `comment_epic`, the same for an epic, `move_issues`, which
moves issues to another status or assigns them, at once, as the owner's, when the owner's last message names each or was sent from its page (ORR-1042), and otherwise asks them (`POST /api/chats/:id/requests` with `{move: {ids, status?, assignee?}}`: the chat's message back, or one with a `move` request), and `delegate_issue`, which starts a session on an issue with no Allow (`POST /api/chats/:id/requests` with `{delegate: {issue}}`; a 409 unless the owner's last message names the issue or was sent from its page, and once per issue per message), and `request`, which asks them for the rest: `start_session`,
`stop_session` and `extend_session`; `message_sessions` and `message_session`, to message other sessions (below);
`update_settings`, one App setting (below); `create_schedule` and `update_schedule` (pause and resume included);
`create_release` and `update_release` (freezing and shipping included); and
`create_doc` and `update_doc` (below); and `offer_issue`. Those
actions aren't listed as tools of their own, so they don't sit in its context until it needs one (ORR-624):
`request_fields {action}` says what an action does and takes, and `request {action, fields, why}` asks. Each asks
only when the owner asked in the chat, never on its own, and nothing happens until they allow it. `offer_issue` is the exception (ORR-711): it offers an issue they
didn't ask for, marked as not filed, with **File issue** and **Don't file**, rather than asking in words. It hears only its chat's messages: no focus, no message to
every session, and nobody listening never wakes it. Its writes are held to making issues (with nobody on them, in Todo
or Backlog as the owner picked beside Send, whatever status it asks for; a proposal stays one), changing an issue's
`title`, `notes`, `priority`, `labels`, `external`, `github_issues`, `milestone`, `epic`, `release`, `parent` and `depends_on` (`PATCH` with anything else, `status`
or `assignee` say, is a 403, and no other session's claim on it holds it back), making and changing milestones and epics
(removing one stays the owner's, a 403) and commenting on an epic (editing or deleting its comments is a 403), commenting, replying, messaging
asking to message sessions, and asking to change a setting, a schedule, a release or a doc, to start, stop or extend a session, or to move or assign issues; it can't message a session itself (both
message routes are a 403 to it), nor write a doc itself (the doc routes are a 403 to it too). A doc it asks to make or
change (`POST /api/chats/:id/requests` with `{doc: {title?, section?, body?}, id?, why?}`, `id` for a change) is saved as
the owner's on their Allow; a change shows as a diff, and is a 409, saving nothing, if the doc changed after it asked.
Removing a doc, and renaming or deleting a section, stay the owner's. A message the owner sends from its request goes as theirs,
with `via: "chat"` on the signal; the session hears it ending `(Sent by the owner through their chat.)`, and the
Sessions page and the event log (`session.messaged`) say it came through the chat. A chat is kept in memory
while it runs, and once ended to read, so it's gone after orrery restarts.

| | |
|---|---|
| `GET /chats` | the chats running and those that have ended (`ended: true`, `ended_at`; one ended before anything was said isn't kept), kept across restarts, newest first by `started_at`: `{id, project, started_at, messages: [{id, from, text, images, at}], issues, problem?, ran_on?}`, `from` being `owner` or `claude`, and `images` the ids of uploads pasted with a message. `issues` is where the issues it makes land, `todo` or `backlog` (the first status of that kind), whatever status its session sends. `problem` says why its session can't start (a launcher too old to start a chat was refused it: restart the launcher), until the session connects. `ran_on`, on an ended chat, is what its session last ran on, `{model?, effort?, started?: {model?, effort?}}`, as a session's own fields are |
| `POST /chats` | `{project, issues?}` → 201 the chat: the owner starting one, its session on its way (its `id` is its launch's), its issues landing in `issues` (`todo` by default, or `backlog`); 409 without a launcher for the project |
| `GET /chats/:chat` | the chat, running or ended (to read: it takes no writes); kept across restarts: one running then is running again once its launcher says its session still runs, and ends after 3 minutes when none does |
| `PATCH /chats/:chat` | `{issues}` → the chat: the owner choosing where the issues it makes land from now on, `todo` or `backlog`; its own session can't (403) |
| `POST /chats/:chat/messages` | `{text, images?, page?}` (or `parts` in place of `text`: a run of messages the pane held and sends together, which the session gets as one, joined by blank lines, and the message keeps as `parts`) → 201 the message: the owner writing in it, with the ids of [uploads](#images) pasted and the page they're on, `{path, title?}` (a path on this orrery, starting with `/`; 400 otherwise); it goes to the chat's session alone, ending `(The owner is on <path>: <title>.)`, plus `That page is on <project>, not this chat's project, <chat's>.` when the path is another project's (`/p/<project>/…`). To an ended chat, it starts its session again on the same chat id (409 with no launcher for its project, the chat left ended): on the Claude session it last ran as (the chat's `claude_session`, kept as it ends) where there is one, else fresh, told what was said; a `chat.resumed` event is logged |
| `POST /chats/:chat/replies` | `{text}` → 201 the message: the chat's session answering, in Markdown; only that session's (`Orrery-Chat: yes` and `Orrery-Launch: <the chat's id>`) |
| `POST /chats/:chat/requests` | `{setting, value, why?}` → 201 the message: the chat's session asking to change one App setting, `tracker`, `tint`, `restrict_proposals`, `handle` or `advanced` (any other is a 400, as is a value the settings wouldn't take), shown in the chat as `request: {setting, from, to, state: "asked"}` with Allow and Deny. Nothing is saved yet; asking again for the same setting expires the one before. Only that session's |
| `POST /chats/:chat/requests` | Any of the schedule, release, milestone, doc, `move` and `issue` requests below can add `project`, another project's id (ORR-1063): it's checked and, on Allow, saved there, and the request shows it as `project`. One orrery doesn't have is a 404. Left out, or the chat's own, it's the chat's project. The chat's session hears the answer on its own project, as always. |
| `POST /chats/:chat/requests` | `{schedule, id?, why?}` → 201 the message: the chat's session asking to make a [schedule](#schedules) in its project, or to change schedule `id` there. `schedule` holds the fields as Schedules takes them: `kind`, `title`, `notes`, `cron`, `at`, `on`, `on_filter`, `timezone`, `presets`, `column`, `milestone`, `priority`, `labels`, `ask`, `skip_open`, `only_if_changed`, `model`, `effort` and `enabled` (any other, `untrusted` say, is a 403). It's checked as Schedules would check it for the owner (a bad cron, a preset that isn't there or an unknown schedule fails here, not on Allow), and shown in the chat as `schedule: {id?, title, changes: [{field, from?, to}], body, state: "asked"}` with Allow and Deny (a change has `from`, the schedule as it is). Nothing is saved yet; asking again about the same schedule expires the one before. Only that session's |
| `POST /chats/:chat/requests` | `{release, version?, why?}` → 201 the message: the chat's session asking to add a [release](#releases) to its project, or to change release `version` there. `release` holds the fields as Releases takes them: `version` (to add one), `branch`, `notes`, `position`, `frozen_on` and `shipped_on` (any other is a 403). It's checked as Releases would check it (a version already there, a bad day, an unknown release, or a project without releases of its own fails here, not on Allow), and shown in the chat as `release: {version, change, changes: [{field, from?, to}], body, state: "asked"}` with Allow and Deny (a change has `from`, the release as it is; a `position` shows as "the top", "2nd from the top"). Nothing is saved yet; asking again about the same release expires the one before. Only that session's |
| `POST /chats/:chat/requests` | `{milestone, id?, why?}` → 201 the message: the chat's session asking to make a milestone in its project, or to change milestone `id` there. `milestone` holds `title`, `summary` and `priority` (any other is a 403), checked as the milestone routes would (no title for a new one, or a priority that isn't one, is a 400; an unknown milestone a 404), and shown in the chat as `milestone: {id?, title, changes: [{field, from?, to}], body, state: "asked"}` with Allow and Deny. Allowed, it's made or changed as the owner's. Nothing is saved yet; asking again about the same milestone expires the one before. The chat's tools no longer ask this way, as it makes and changes milestones straight since ORR-988; a request it asked before still waits for Allow. Only that session's |
| `POST /chats/:chat/requests` | `{doc, id?, why?}` → 201 the message: the chat's session asking to make a doc in its project, or to change doc `id` there (ORR-661). `doc` holds `title`, `section` and `body` (any other is a 403), checked as the doc routes would (no title for a new one is a 400, an unknown doc a 404, and a change that would change nothing a 409), and shown in the chat as `doc: {id?, title, body, was?, state: "asked"}`, `body` holding only what would change and `was` the doc as it stood, for the page's diff. Nothing is saved yet; asking again for the same doc expires the one before. Allowed, it's saved as the owner's, and a new doc takes its id from its title. A change is refused if the doc no longer matches `was`: a 409, whatever `anyway` says, and the request ends `expired` with `stale: true`; the session hears it and can ask again. |
| `POST /chats/:chat/requests` | `{message, why?}` → 201 the message: the chat's session asking to message other sessions as the owner. `message` is `{text, session}` for one session, by its name or id (404 for none, or a chat; 409 for one not listening), or `{text, projects?, states?}` for every listening one that fits, as `POST /sessions/message` takes them (409 when none does). Shown in the chat as `send: {text, session?, project?, projects?, states?, to, state: "asked"}`, `to` the names it would reach, with Send and Don't send. Nothing is sent yet. Only that session's |
| `POST /chats/:chat/requests` | `{session, why?}` → 201 the message: the chat's session asking about a session (ORR-509). `session` is `{action: 'start', project?, issue?, statuses?, release?, presets?, instructions?, hears?}`, as `POST /projects/:project/launches` takes them (on the chat's project unless `project` names another), or `{action: 'stop' \| 'extend', name, minutes?}` for a session by its name or id (`extend` only one orrery started with a stop time, 30 minutes unless `minutes`, 1 to 1440). Checked as those routes would check it, and nothing happens until the owner allows it; an earlier unanswered ask about the same session expires. Watching one stays the owner's |
| `POST /chats/:chat/requests` | `{move: {ids, status?, assignee?}, why?}` → 201 the message: the chat's session asking to move issues in its project to another status (an id or a kind) or assign them (a name, `owner`, or null for nobody), at most 50. Checked as the owner's move would be: an unknown issue is a 404, an unknown status a 400, a proposal waiting on the owner a 403, and nothing to change a 409. Shown in the chat as `move: {changes: [{issue, title, field, from, to}], body, state: "asked"}` with Allow and Deny, `changes` only what would change. Nothing moves yet; asking again about any of the same issues expires the one before. Allowed, each is changed as the owner's (`via: "chat"`); if one fails, those moved stay in `moved` and Allow again moves the rest. `was` keeps each issue's status and assignee when it was asked, and `drifted` lists what has changed on them since (`[{issue, field, from, to}]`). While it isn't empty, Allow moves nothing until the owner sends `anyway: true`, and anything changed further shows and waits again. Whichever they press, the session hears what had changed. Only that session's |
| `POST /chats/:chat/requests/:message` | `{allow, anyway?}` → the message. A setting, milestone, release or schedule request whose values have changed since it asked reads `drifted: [{label, from, to}]`, and Allow saves nothing until the owner sends `anyway: true`, as a move does; the session hears what had changed. Otherwise, its request `allowed` (the issues moved as asked; the setting saved as asked, logged as `settings.changed` with from → to; the schedule made or changed as the owner's, through their chat, its `id` then the schedule's; the release added or changed as the owner's, through their chat; or the message sent as the owner's, through their chat, to the one session or to every one that fits now, `sent` naming them, and a session no longer listening a 409 that leaves it asked, `sent` keeping those it reached, so Send again goes to the rest only; or the session started, stopped or given more time as the owner's, through their chat, under the same limits as the Sessions page, `launch` then the session it started, and one that no longer holds a 409 that leaves it asked) or `denied`; the chat's session hears which. The owner's only, and never a chat session's, so a chat can't allow its own request; 409 once answered, while another answer to it is under way, or `expired` (30 minutes unanswered, or asked again) |
| `POST /chats/:chat/clear` | → 201 the message: the owner clearing the chat's context (`/clear` in the pane). Its launcher types `/clear` into the session, which carries on with a fresh context and hears its brief again; the chat marks the cut with a message that has `cleared: true`. The owner's only |
| `POST /chats/:chat/end` | 204: the owner ending it; its session is stopped |
| `DELETE /chats/:chat` | 204: the owner deleting it (ORR-882), running or ended: one still running is ended first, then it goes with its messages and requests, logged as `chat.deleted`. The issues, comments and docs it made stay. The page hears it as a `chat` event with `deleted: true`. The owner's only, never a chat session's; 404 for none |

### What sessions hear

A focus reaches a session as its `prompt`: a template filled in, with standing instructions after it.
The owner sets them (an agent gets a 403):

- `PATCH /settings {focus_prompt?, milestone_prompt?, instructions?, handle?, tracker?, tint?, starts?, terminal?, agent?, restrict_proposals?, advanced?, count_use?, work_kinds?, starred?, hidden?}`: the orrery's (`work_kinds`: the kinds of work, highest-ranked first, each `{id, name, labels, model, effort?}`, with ids unique and a label in one kind only; an issue's kind is its highest-ranked label's, and a session for it starts on its kind's model, the chat on the `chat` kind's; `GET` gives orrery's own until it's set, and `null` brings them back; `starred` and `hidden`: lists of project ids the sidebar shows first, or folds away under Hidden; only where they show, nothing about the projects changes, and one in both is hidden; `tint`: a tint's name, `#rrggbb`, or null for none; `terminal`: the app Watch opens; `agent`: the AI agent the owner runs, `claude` (the default) or `other`, which Getting started and Connect an agent open on (ORR-1075); `restrict_proposals`: see [Proposals](#proposals); `advanced`: see [Event log](#event-log); `count_use`, false by default: counts the owner's own use of features, for `GET /usage` (ORR-881); `starts`: see [Starting sessions](#starting-sessions)). A template is text with
  placeholders (`{issue}`, `{title}`, `{status}`, `{priority}`, `{milestone}`, `{where}`, `{note}`, `{url}`,
  `{actor}`; a milestone's also `{issues}`), and a line whose placeholders all come out empty is left out.
  `null` or `""` goes back to the default. `instructions` is a list of `{text, on?, id?}`, lines such as
  "commit whenever a piece works"; `on` (true unless sent) ticks one by default. They go where
  `{instructions}` is, or at the end.
- A session out of work picks its next issue, always (ORR-1043; there's no setting, and an older database's `pick_next` is ignored): a listening session with nothing in progress, no run left and nothing waiting on the owner, is sent a message, alone and as the owner's, listing the issues it may start (Todo only, most urgent first, at most 10, from the projects it hears; no proposals, nothing assigned to anyone but `claude` or waiting on the owner, no parents; Backlog is the owner's to point at) to pick one; never the same list twice, and nothing with nothing to pick. One orrery started is sent it after its `/clear`. The idle sessions are tried again a few seconds after the board changes, one at a time.
- `PATCH /projects/:project {focus_prompt?, milestone_prompt?, instructions?, muted?}`: the project's own
  templates (none follows the orrery's), its own lines, and `muted`, the ids of the orrery's lines it
  switches off.
- `POST …/focus {instructions: [ids]}` picks the lines for one send (`[]` for none). Left out, it gets
  the ones ticked by default. The signal keeps their texts in `instructions`.
- A focus on work set for a release in [feature freeze](#releases) gets one more line, saying so.

### Presets

Saved pieces of context, `{id, project, name, text, icon, color}`, the owner gives a session as they start it
(`POST …/launches {presets}`), or sends one that's running as a message (`POST …/sessions/:session/message {text, preset}`). The orrery's (`project: null`) are for any project's sessions; a project's own
for its sessions only. Each reads as a role: a badge with `icon` (a Heroicon's name, e.g. `shield-check`) in
`color` (a tint's name or `#rrggbb`), or its initials without an icon. orrery ships a few of its own (Release,
Security audit, Review, Debug an error), added once to each orrery as it starts, new or upgraded; each has `default`
`{key, changed}`. An upgrade changes one only while its text is still one orrery shipped before, word for word,
taking the new text; one the owner changed stays theirs (Reset to default takes the new text), and one the owner
removed isn't added again. Only the owner makes, changes or removes them (an agent gets a 403); the owner's chat reads them
(the `presets` and `preset` tools) to help the owner write one.

| | |
|---|---|
| `GET /presets` | the orrery's, by name |
| `POST /presets` | `{name, text, icon?, color?}` → 201 a new one of the orrery's |
| `GET /projects/:project/presets` | those its sessions can have: the orrery's, then the project's own |
| `POST /projects/:project/presets` | `{name, text, icon?, color?}` → 201 a new one of the project's own |
| `PATCH /presets/:preset` | `{name?, text?, icon?, color?}` (null takes the icon or colour off) → the preset, the orrery's or a project's |
| `DELETE /presets/:preset` | 204; sessions already started with it keep its text |
| `POST /presets/:preset/reset` | → the preset, back to the name, text and badge orrery ships it with; 409 for one it doesn't ship |
| `POST /presets/defaults` | → the presets orrery ships that were removed, added back as it ships them (`[]` for none) |

## For agents

`/llms.txt` says how to use orrery and lists the projects (with login on, it and `/connect` stay open, and without a credential show none of them: `/connect` then says to ask again with an agent key, whichever project you name); `/llms-full.txt` adds this reference;
`/connect/<project>.md?session=` is the brief for a Claude session in that project's repo (how to set it up);
`/channel/bootstrap.mjs`, `/channel/orrery-channel.mjs`, `orrery-hook.mjs` and `orrery-launcher.mjs` are what a connected
machine runs, with `/channel/manifest.json` (`{id, version, code, files: {<file>: <sha256>}}`) saying what's there; and
for a project that doesn't exist yet `?name=` names it and the brief has the agent make it;
`/api/guide` is this reference alone, and `/api/guide/using` how orrery works, page by page (docs/using.md), which the
channel's `guide` tool answers from: its contents, or the one section or page asked for. A Claude session with orrery's server in its `.mcp.json` also
gets it as tools (`issue`, `start_issue`, `comment`, `finish_issue`, … see Connecting a repo), which
make these calls for it. The same tools are served at the root, `/mcp` (not under `/api`), as MCP over streamable HTTP (ORR-1098): `POST` takes
one JSON-RPC message or a batch and answers as JSON (a notification alone: 202, no body), `DELETE` with
`Mcp-Session-Id` ends the client's session, and `GET` is a 405, as it streams nothing. It's for agents: a browser's
login gets a 403, so with login on a session sends its agent key as the bearer. `Orrery-Session` ties its writes to the
Claude session, as the channel's do; the launcher and the install line set it (see Connecting a repo). The notification
`notifications/orrery/chose` `{id, url, environment?}`, with `Orrery-Session`, says that Claude session chose another orrery with
`choose_app` (ORR-1147): from then on its tool calls here are refused, naming the one it chose. It's kept in memory, so a
restart forgets it. An untrusted schedule's session (its launcher sets `ORRERY_UNTRUSTED=yes`) sends
`Orrery-Untrusted: yes` on every write and `untrusted=yes` on its streams, and is held to raising proposals and
commenting on them, whether or not orrery knows its launch. A chat's session (`ORRERY_CHAT=yes`) sends `Orrery-Chat: yes`
and `Orrery-Launch: <its chat>` on every call and `chat=yes` on its streams, and is held to what a [chat](#chats) does. A write that sends `Orrery-Session: <its id>` (the tools do) ties the session
to the issue, so the owner's comments on it go to that session. Such a write to an issue another session has
started (in progress or in review), while that session is still listening, is refused with a 409: starting it or
an edit alike (a comment's edit too), so pick another issue. A comment isn't (ORR-613): it neither starts nor changes
the issue, and it's how a reviewer's findings reach the session on it. Nor does it tie the commenting session to the
issue (ORR-627): no write moves a started issue off a session that's still listening. Closing it (done, canceled) is any session's, and the owner's
writes are never refused. A milestone's list marks such an issue `(another session is on it: skip it)` for the
other sessions. Two sessions starting the same issue at once are taken one after the other, so only the first
gets it.

`GET /permissions` → `{levels, kinds, permissions}` says what each kind of session may do, and each row's `member` what a member and their sessions may on an orrery with more than one person: for each thing (`id`, `area`,
`action`, `why`, the `routes` that do it), its level for a working session (`session`), the owner's chat (`chat`) and an
untrusted session (`untrusted`), each `{level, note?}`. A level is `free`, `limited` (free within its note), `asks` (the
owner's Allow or Send does it), `owned` (saved, but runs only once it's the owner's), `owner` (the owner's alone: a 403,
or for a focus, no session hears it) or `refused`. Read it before something that might be the owner's, and ask in a
comment instead of trying. The Sessions page's Permissions tab shows the same table, and a test holds it to the code.
The owner-only routes check it as they run, so a 403 from one says which thing refused it: its message names the row,
and its `data` is `{permission: "<id>"}`, kept in the event log's `request.refused`.

An issue's short id can mean something else on another orrery. So when a commit body or PR description names an
issue, write its `full_id` (`DOC-132-x7k2m9qd`) on a line of its own, never a bare id, and never in a title. A branch
can use the short id: it's how a PR finds its issue (see `…/pulls`). The team's tracker
stays the source of truth: its id goes in that repo's own trailer (`Part of ENG-1567`), and in the issue's
`external`, so the board knows which team task the issue serves. An issue taken in from a GitHub issue names it in
`github_issues` instead. A PR description also links the issue's
page on this orrery (`/p/<project>/issues/<id>` on its address, `http://localhost:9010/p/doc/issues/DOC-132`),
so the owner can jump from the PR to it.

## Event log

What orrery did and what went wrong, kept in its own database and never sent anywhere, for looking into a
problem. **Errors** are recorded always: a 5xx the server answers with (`server.error`), an error in the page
(`page.error`; an unknown URL isn't one, it only shows Not found), a schedule run that failed (`schedule.failed`). **What orrery did** is
recorded only while the owner has Advanced on (`PATCH /settings {advanced: true}`, App settings → Advanced; on in an orrery that never set it):
sessions started, stopped and refused (`session.started`, `session.stopping`, `session.stopped`,
`session.refused`), a session that started an issue out of the scope of its last with more than 50k tokens in its context (`session.carried_over`, ORR-968), any session's channel joining and leaving the feed (`channel.connected`, `channel.left`),
launchers coming and going (`launcher.connected`, `launcher.gone`) or refused a launch because
their code is older than it (`launcher.outdated`, a warning: one from before chats offered a chat), GitHub turning down the `GITHUB_TOKEN` secret as pull requests are polled (`github.refused`, a warning, once until it works again), a session whose `Orrery-Person` disagrees with its agent key (`auth.person_mismatch`, a warning, once per session), schedule runs and skips
(`schedule.ran`, `schedule.skipped`), migrations, what orrery cleaned up and server starts (`migration.ran`, `housekeeping.cleaned`,
`database.created` when a move copies into a new one, `database.moved`, `server.started`), calls through egress
(`egress.called`: who, which secrets, the method, host and status, never a value or path), and who changed what
in the settings and secrets (`settings.changed` with the keys, `secret.set`, `secret.narrowed`, `secret.deleted`
with the name and hosts; never a value). Every request refused with a 403 or 409 (an untrusted session's write, a
proposal's move, the owner's own, an issue another session is on) is a warning, `request.refused`, with who asked,
the route without its query, the status and why. So is **each change to the roadmap**, as an `info` line with the change's
type as its kind and what it was to as its `subject`: `issue.<field>` (`issue.created`, `issue.status`,
`issue.priority`…, `issue.deleted`), `comment.added`, `comment.asks`, `milestone.created`, `milestone.changed`, `epic.changed`, `doc.created`, `doc.changed`,
`doc.deleted` and `release.<what>` (`release.created`, `release.frozen`, `release.shipped`…). Its message says who did
what (`claude moved ORR-12: todo → done`), and its details hold `by`, `owner`, `from`, `to`, `untrusted` and the
`schedule` whose run made it. No titles, notes or comment text are kept. Advanced also counts each new kind of error in the
bell and shows Events, Context and Pull requests in the sidebar under Schedules. The Events page is also reached from App settings → Advanced either way.

Each event is `{id, level, kind, project?, subject?, message, details?, count, first_seen, last_seen, resolved_at?, resolved_by?}`,
with `level` one of `error`, `warn`, `info`. Each is a line of its own (`count` 1, `last_seen` its `first_seen`); a
repeat of one not resolved yet (level, kind, project and message) is no news to the bell or the schedules. No request
bodies, headers or secret values are kept: secrets are scrubbed out as they are from an answer, and so are passwords
in addresses and bearer tokens. Info is kept a week, warnings and errors a month; at most 5000 changes to the roadmap
and 5000 of the rest, each the oldest going first.

- `GET /events/log?level=&kind=&project=&subject=&since=&open=1&limit=`: newest first. `level` is one or more,
  comma-separated; `kind` one (`server.error`) or every one under a name (`session`, `issue`); `subject` what a change
  was to (`ORR-12`, a release's version); `since` a time with its zone (`2026-10-27T09:00:00Z`) or a day; `open=1` leaves out resolved ones. 200 by default, 1000 at most. A daily schedule can ask for `?level=error&open=1&since=…` and turn what's new
  into issues.
- `POST /events/log/:id/resolve`: it's dealt with, and so are its repeats not resolved yet; the next one like it is news.
  Resolved by anyone but the owner, it keeps their name as `resolved_by`, and the bell still counts it until the owner
  has looked, so a session can't hide an error it caused.
- `POST /events/log {message, stack?, page?, build?, kind?}` → 201, or 204 when it isn't kept: the page reporting its own error (`page.error`, or
  another `kind` under `page.`). Anyone can send one, so it's kept with `details.reported: true`, which the `events`
  tool shows as unchecked, and at most 5 of a kind and 20 in all a minute are taken from each sender (where it comes from, and whether it sends an `Orrery-Actor`: the page sends none, and every name from one place counts as one), and 100 from all of them: a 429 past that.

A session reads it with the channel's `events` tool (`details` for stacks) and marks what it fixed with
`resolve_event`, so the owner can hand Claude a problem to debug.

## Columns

Computed, never written: a leaf issue that's a proposal (or under one) is in Proposed, else in its
status. A parent issue or a milestone follows its leaves: while any is open, the least-along open status
among them (started before todo before backlog, each in board order); once all are closed, the first
done status among them, or canceled when none was done; Proposed when it holds only proposals.
`column` comes with its `kind`; `counts` are leaves by status and `kinds` the same by kind. Progress
is done out of backlog, todo, started and done: proposals and canceled leaves are left out.

## Errors

`{statusCode, message}`: 400 for a bad body, with `data: {problems: […]}` listing what's wrong (most routes refuse unknown
fields, so typos show); 401 with no credential where login is on; 503 while nobody could log in; 403 for the owner's
things; 404, also for a board you're not on; 409 when the state is in the way (a taken id,
an issue another session is on, a request already answered); 415 for a write whose body isn't
`Content-Type: application/json`; 413 for a body too big, over 1 MB (about 13 MB for an image's upload, 256 MB for a board's file or an import, 64 KB on the login's routes). Creating answers 201 and deleting 204.

orrery answers only to `localhost`, IP addresses, a Bonjour name (`<name>.local`) and the names in `NUXT_ALLOWED_HOSTS` (`ORRERY_ALLOWED_HOSTS` in
Docker), and takes writes only from its own page, a site listed in `NUXT_ALLOWED_ORIGINS` (`ORRERY_ALLOWED_ORIGINS`), or a client
with no `Origin`: anything else is a 403. Only a listed site gets CORS headers, with credentials.

## Live updates

`GET /events` is a server-sent event stream, for pages to stay current without reloading:

- `ready` (the server's build id) first; a page from another build reloads. `ping` every 25 seconds.
- `project` (the whole project, after any change) and `removed` (a deleted project's id). With `?patch=1`, `patch` comes instead of `project`: only what changed since the last one (`{id, base, rev, fields, unset, board, issues}`: the changed issues whole, each changed milestone's tree of issue ids, the unchanged ones by id). Its issues come without their notes. It builds on the `rev` that `GET /projects?expand=board` and `GET /projects/:project` give each project, the revision from before the read, so a push that lands while it's read still applies; a page behind `base` reads the project again. Changes that come in while a project is being read are sent together in one push
- `settings` (the settings with the statuses, after either changes)
- `listeners` and `launchers` (`{project, count}`): sessions listening for signals, and launchers that start them
- `sessions` (`{project, sessions}`), `signal` (one sent), and `notice` (a comment for the owner's bell)
- `schedules` (`{project, schedules}`, after a change or a run) and `secrets` (the list, never a value)
- `chat` (the chat, with `ended` on its last): one of the owner's chats changed
- `epics` (nothing: read `GET /epics` again): an epic was made, changed or deleted
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
