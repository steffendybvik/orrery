# Using Orrery

What you can do on Orrery's pages, and where it lives. Many actions are tucked into right-click menus and keys, so this is the map. Everything here acts as the owner. Agents do the same through [the API](API.md).

## Right-click

Right-click only opens Orrery's own menus. Anywhere else the browser's menu is held back, except in a text field or on selected text, so copy, paste and spellcheck still work.

| On | Menu |
|---|---|
| An issue (a row in the list, a card on the board) | Move to a column · set its priority · move to a chunk · **ask the listening session(s) to focus on it** · copy id · open · remove (with its sub-issues, asked once more) |
| A chunk's card on the roadmap | Set its priority · **ask the listening session(s) to work through it** · new issue in it · copy id · open · remove (its issues stay, in no chunk) |
| A schedule (or its ⋯) | Run now · run now instead of its next run, which it then skips · pause or resume · edit · remove (the issues it made stay; its dialog has Remove too) |

The "ask the session" items only show when a Claude session is listening on that project and the issue or chunk isn't done.

Tick issues (a row's box, shift-click for a run, `x`, ⌘A for the page) and a bar changes them together: status, priority, assignee, labels, chunk or release, or a decision on proposals.

## Pointing Claude at work

- **An issue**: right-click it, or open its page. The **Claude sessions** panel there lists each session on the project, with **Focus on this** next to each and **Focus all on this** when more than one is listening. With nobody listening, once Orrery may start sessions and a launcher is running, it offers **Focus on this (starts a session)**; with sessions listening, **New session on this** starts another, on this issue alone, while the limit has room. Under it are the focus signals already sent, and who got them.
- **A chunk**: right-click its card on the roadmap, or open the chunk's page (`/p/<project>/roadmap/<chunk>`) for the same sessions panel.
- **A chunk's issues of one status**: on the chunk's page, each status group has **Focus on all Todo** (or In progress, Backlog, …). Pick one session or all, and they work through just those issues, most urgent first.
- **A new issue**: the new-issue dialog (`c`) has a checkbox that sends it to the listening sessions as it's made.
- **One session**: on the **Sessions** page, a listening session's card takes a message that only it hears. The bookmark beside the box sends a preset: picking one fills the box to tweak ("…for rc.9"), and the message is listed by the preset's name.
- **A new session**: **Start session** (on the Sessions page, or `+` by the sidebar's sessions) starts one through the launcher, on one or more projects (a session each, hearing only its project; or, for projects in one repo, one session hearing them all; or none ticked, for one session hearing every project, started where a launcher's channel serves `*`), optionally focused on an issue or a scope (statuses and a release), with presets and your own words as context.
- The sidebar lists every Claude session at the bottom, with the ones waiting on you first. A session's channel tells it the name it has here, so you can both call it that. Only one session works an issue at a time: a second one starting it is told to pick another.

## What changed since you looked

Agents work fast, so whatever changed since you last opened it is marked until you do:

- **Rows and cards**: an issue or doc that changed (an edit, a status move, a new comment) gets an **accent-tinted row with a bar down its left edge**, a dot and a bolder title, in the issues list, on the board, in the docs list and in the doc sidebar. The project in the sidebar gets a dot too, with the count on hover.
- **Inside a doc**: opening a changed doc **tints each paragraph, list item, heading, code block or table row that's new or different** since you last read it, with "N parts changed since you last read it" under the title. It compares against the text as your browser last saw it, so it starts working from your second visit to a doc. Removed text isn't shown.
- **Clearing**: opening an issue or doc clears its mark. **Mark N seen** on a project's Issues page clears the whole project.
- **Your own changes** from the page don't count. What you made yourself starts seen.
- It's remembered in this browser. Another browser keeps its own.

A row that just changed through the API also flashes once, whether you've seen it or not. An issue waiting on your answer to an agent's question has a violet tint and a **Needs your decision** (or feedback) chip instead, until you answer.

## Pictures

Comments, the new-issue dialog and an issue's description take images: **paste** one, **drop** one in, or use the **picture button**. It goes in as Markdown where the cursor is. A click opens it larger over the page (a click, Esc or ✕ closes it; **Open original** or ⌘-click opens the file in a tab). PNG, JPEG, GIF and WebP, up to 10 MB. Orrery keeps them in its own database, so backups and `orrery:copy` take them along. Agents attach screenshots the same way, through `POST /api/uploads`.

## Pages

| Page | What's there |
|---|---|
| **Now** (`/now`) | Everything started, and urgent or high-priority Todo, across projects. Its filters include **Project**, to narrow it to some |
| **My issues** (`/mine`) | **Waiting on you** on top (issues with an agent's question you haven't answered, or an agent's proposal you haven't decided, in any project), then open urgent (P0) issues anywhere, then what's assigned to you, proposals first. Filtered like Now, **Project** included |
| A project's **Issues** | A list (grouped by status or chunk) or a board, with search and filters for priority, column, assignee and label. It starts on the open issues: tick Done or Canceled under **Column** to see those too, and **Clear** to go back. The board has a column only for the statuses ticked |
| An **issue's page** | Its title and description edit in place. Status, priority, assignee, labels and chunk change on the right. A question an agent asked you shows at the top, with **Answer**, until you do. A picture opens larger over the page on a click. Also sub-issues, the sessions panel, and the activity: comments with a quiet line for every change between them (who moved it, assigned it, relabelled it, and when) |
| **Roadmap** | Chunks as cards in their columns. A chunk's page has its summary, priority, progress, issues and the sessions panel |
| **Docs** | The project's Markdown pages, with contents beside them. **New doc** writes one; on a doc, **Edit** changes its title and text in place and **Remove** deletes it. A doc an agent changed since you read it is tinted where it changed |
| **Releases** | For a project that ships: each version, its branch, its issues by progress, and a changelog drafted from them |
| **Sessions** (`/sessions`) | Every Claude session by project, with one that hears several projects listed once under **Across projects**: its state and since when, its time left (one Orrery started) and folder on one line, a message box, then what it's on **Now** (in progress; the rest it worked folded) and the latest thing it was sent (the rest folded). One Orrery started has **Watch** (opens a terminal on it), **Show screen** (a read-only live view of it, on the page) and **Stop** (asked once more), and under **⋯** +30 minutes and the command that attaches to it; one you started yourself has **Stop** while its channel runs. Also each project's launcher state. Its **Setup** tab holds starting sessions (on or off, and the limits) and how it's set up, the terminal **Watch** opens, then what sessions hear (the focus templates, with a preview, and the standing instructions) and presets (Orrery ships a few; **Restore defaults** brings back one removed), for every project or, picked in **For**, one project's own (its templates, its instructions and the Orrery's it switches off, its presets). A contents list sits beside them on a wide screen |
| **Chat** (the button in the bottom right corner of every page, or ⌘K) | Talk to Claude about a project on the page, with no terminal: it answers from the project's code, roadmap and docs, and makes issues and comments when you ask, but works on nothing itself. Ask it to message your sessions ("the sessions are idle, tell them to pick up Todo") and it sends that as yours, idle sessions only unless you say otherwise, after showing you the text; they and the Sessions page see it came through the chat. Ask it to change an App setting (your team tracker, the background tint, keeping agents off proposals, your handle, Advanced) and it shows the change, from → to, with **Allow** and **Deny**: nothing is saved until you press Allow. Secrets, the database, statuses and how sessions start stay yours to change on App settings. It opens ready to type into, with a few things to ask; your first message starts it. Paste, drop or add an image to show it. The project, in its header, is the one you're on (or picked there). It knows which page you're on as you write, so "this" means the issue, doc or schedules in front of you. It needs the project's launcher, and nothing else: it counts towards no session limit and isn't listed with the sessions. Make the pane larger with the button beside ×. Closing the pane (×) ends the chat; Esc closes it only before one starts. A chat still running elsewhere (another tab) shows as a dot on the button |
| **Schedules** (`/schedules`) | Work Orrery starts on its own, at a time or when something happens (an issue moves to In review, a release is frozen, a new error): each run makes an issue, messages the sessions (presets, your own words or both; a message can skip a run when nothing in its project changed) or starts a session. Each project's are a card; **New schedule** picks the project in its dialog. `?project=` keeps to one project. Under them, **Suggested** offers ready-made ones for the presets Orrery ships (Release and Security audit when a release is frozen, a nudge to get the next release going when one ships, Review when an issue moves to In review, Debug an error on a new error): **Add** opens New schedule filled in, and nothing runs until you save it. One the project already has leaves the list |
| A project's **Settings** | Name, sidebar icon and colour, its repo, releases (none, its own, or another project's), deleting the project (type its id to confirm) |
| **App settings** (`/settings`, the cog at the top right, or ⌘K) | Three tabs: **You** (your name and handle), **Issues** (the statuses, proposals and the team tracker, for every project) and **This Orrery** (the tint that tells one Orrery from another, secrets, where its database is, how big, and its latest backup with **Back up now**, moving it to another, and **Advanced**, which records what Orrery does as well as its errors and shows the Events page). A link to a section opens its tab |
| **Events** (`/events`, in the sidebar while Advanced is on) | Orrery's event log, read like a console: a line each, with the time it happened, the newest at the bottom (it follows new lines while you're there), errors in red and warnings in amber. What went wrong (a server or page error, a failed schedule or backup), what it did (sessions, launchers, schedule runs, backups) and each change to the roadmap (who made, moved or commented on which issue, docs, chunks, releases). Filter by project and by kind (a family such as `issue.*`, or one kind such as `issue.status`), both kept in the address so the view can be linked, and switch levels off with ERROR, WARN and INFO; a line opens to its details, and an error or warning has **Resolve** |
| **Connect** (`/connect`) | The line that sets a Claude session up in an app's repo |
| **Getting started** (`/getting-started`, or ⌘K) | A new Orrery opens on it: the steps to a Claude session working from your roadmap (a project, a folder connected, Claude started with the channel, work sent), each ticked once it happens and kept ticked after the sessions that did it end, and *Try it with a demo project* for a sample board to look around first. Any folder connects, an empty one to try it; *Just planning? You're set* finishes it after the project, without the steps for Claude. Until it's done it's a card at the top of Now; **Hide** puts it away |

## The bell

Agents' comments land in the bell in every page's header, which counts the new ones and opens **Notifications**: every comment in full, newest first, the ones asking you for a **decision** or **feedback** marked until you answer them on the issue (**Waiting on you** gathers them). An agent's proposal waits there too, first in the bell, until you approve it, ask for changes or reject it; put up again, it waits again. A card opens its issue. Clear comments one by one, the read ones, or all at once (a proposal goes only when you decide it); cleared ones stay under **Cleared**. A proposal's issue has **Approve**, **Request changes** and **Reject**, each with a note the session hears. Approving puts it on the roadmap. Your own comments have **Edit** and **Delete**; an edit goes to the session on the issue again.

## Keys

| Key | Does |
|---|---|
| ⌘K | Command palette: every page, issue, chunk, doc and command (views, grouping, filters, theme, new project, chat) |
| j / k | Next and previous row or card. On an issue's page, the next and previous issue |
| Enter | Open the focused row or card |
| Esc | Back, close, or leave a field |
| / | Search |
| c | New issue (in the chunk, on a chunk's page) |
| 1 / 2 | List / board |
| g n · g m | Go to Now · My issues |
| ⌥↑ / ⌥↓ | Move a project up or down in the sidebar (or drag it by its name) |
| → / ← | Unfold or fold a project's pages in the sidebar |
