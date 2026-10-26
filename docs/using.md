# Using Orrery

What you can do on Orrery's pages, and where it lives. Many actions are tucked into right-click menus and keys, so this is the map. Everything here acts as the owner. Agents do the same through [the API](API.md).

## Right-click

Right-click only opens Orrery's own menus. Anywhere else the browser's menu is held back, except in a text field or on selected text, so copy, paste and spellcheck still work.

| On | Menu |
|---|---|
| An issue (a row in the list, a card on the board) | Move to a column · set its priority · move to a chunk · **ask the listening session(s) to focus on it** · copy id · open · remove (with its sub-issues, asked once more) |
| A chunk's card on the roadmap | Set its priority · **ask the listening session(s) to work through it** · new issue in it · copy id · open · remove (its issues stay, in no chunk) |
| A schedule | Run now · pause or resume · edit · remove (the issues it made stay) |

The "ask the session" items only show when a Claude session is listening on that project and the issue or chunk isn't done.

Tick issues (a row's box, shift-click for a run, `x`, ⌘A for the page) and a bar changes them together: status, priority, assignee, labels, chunk or release, or a decision on proposals.

## Pointing Claude at work

- **An issue**: right-click it, or open its page. The **Claude sessions** panel there lists each session on the project, with **Focus on this** next to each and **Focus all on this** when more than one is listening. With nobody listening, once Orrery may start sessions and a launcher is running, it offers **Focus on this (starts a session)**. Under it are the focus signals already sent, and who got them.
- **A chunk**: right-click its card on the roadmap, or open the chunk's page (`/p/<project>/roadmap/<chunk>`) for the same sessions panel.
- **A chunk's issues of one status**: on the chunk's page, each status group has **Focus on all Todo** (or In progress, Backlog, …). Pick one session or all, and they work through just those issues, most urgent first.
- **A new issue**: the new-issue dialog (`c`) has a checkbox that sends it to the listening sessions as it's made.
- **One session**: on the **Sessions** page, a listening session's card takes a message that only it hears.
- **A new session**: **Start session** (on the Sessions page, or `+` by the sidebar's sessions) starts one through the launcher, on one or more projects, optionally focused on an issue or a scope (statuses and a release), with presets and your own words as context.
- The sidebar lists every Claude session at the bottom, with the ones waiting on you first. Only one session works an issue at a time: a second one starting it is told to pick another.

## Pages

| Page | What's there |
|---|---|
| **Now** (`/now`) | Everything started, and urgent or high-priority Todo, across projects |
| **My issues** (`/mine`) | Open urgent (P0) issues anywhere on top, then what's assigned to you, proposals first |
| A project's **Issues** | A list (grouped by status or chunk) or a board, with search and filters for priority, column, assignee and label. It starts on the open issues: tick Done or Canceled under **Column** to see those too, and **Clear** to go back |
| An **issue's page** | Its title and description edit in place. Status, priority, assignee, labels and chunk change on the right. Also sub-issues, the sessions panel, and the activity: comments with a quiet line for every change between them (who moved it, assigned it, relabelled it, and when) |
| **Roadmap** | Chunks as cards in their columns. A chunk's page has its summary, priority, progress, issues and the sessions panel |
| **Docs** | The project's Markdown pages, with contents beside them. A doc an agent changed since you read it is tinted where it changed |
| **Releases** | For a project that ships: each version, its branch, its issues by progress, and a changelog drafted from them |
| **Sessions** (`/sessions`) | Every Claude session by project: its state, the issues it's on, what it was last sent, a message box, and for one Orrery started its time left, **Watch** (opens a terminal on it), **+30 min** and **Stop**. Also each project's launcher state and how starting sessions is set up. `?project=` keeps to one project. Above them, starting sessions (on or off, and the limits) and how it's set up; below, what sessions hear (the focus templates, with a preview, and the standing instructions) and presets. A contents list sits beside them on a wide screen |
| **Schedules** (`/schedules`) | Work Orrery starts on its own: each run makes an issue or messages the sessions. `?project=` keeps to one project |
| A project's **Settings** | Name, sidebar icon and colour, its repo, releases (none, its own, or another project's), what its sessions hear (its own focus templates and standing instructions, or the Orrery's switched off), its presets, deleting the project (type its id to confirm) |
| **App settings** (`/settings`, the cog at the top right, or ⌘K) | Your name and handle, the team tracker, the tint that tells one Orrery (personal, work) from another, the issue statuses, the terminal **Watch** opens, and secrets |
| **Connect** (`/connect`) | The line that sets a Claude session up in an app's repo |

## The bell

Agents' comments land in the bell in every page's header, which counts the new ones and opens **Notifications**: every comment in full, newest first, the ones asking you for a **decision** or **feedback** marked until you answer them on the issue (**Waiting on you** gathers them). A card opens its issue. Clear them one by one, the read ones, or all at once; cleared ones stay under **Cleared**. A proposal's issue has **Approve**, **Request changes** and **Reject**, each with a note the session hears. Approving puts it on the roadmap. Your own comments have **Edit** and **Delete**; an edit goes to the session on the issue again.

## Keys

| Key | Does |
|---|---|
| ⌘K | Command palette: every page, issue, chunk, doc and command (views, grouping, filters, theme, new project) |
| j / k | Next and previous row or card. On an issue's page, the next and previous issue |
| Enter | Open the focused row or card |
| Esc | Back, close, or leave a field |
| / | Search |
| c | New issue (in the chunk, on a chunk's page) |
| 1 / 2 | List / board |
| g n · g m | Go to Now · My issues |
| ⌥↑ / ⌥↓ | Move a project up or down in the sidebar (or drag it by its name) |
| → / ← | Unfold or fold a project's pages in the sidebar |
