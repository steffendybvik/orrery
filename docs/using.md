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

## Pointing Claude at work

- **An issue**: right-click it, or open its page. The **Claude sessions** panel there lists each session on the project, with **Focus on this** next to each and **Focus all on this** when more than one is listening. Under it are the focus signals already sent, and who got them.
- **A chunk**: right-click its card on the roadmap, or open the chunk's page (`/p/<project>/roadmap/<chunk>`) for the same sessions panel.
- **A chunk's issues of one status**: on the chunk's page, each status group has **Focus on all Todo** (or In progress, Backlog, …). Pick one session or all, and they work through just those issues, most urgent first.
- **A new issue**: the new-issue dialog (`c`) has a checkbox that sends it to the listening sessions as it's made.
- The sidebar lists every Claude session at the bottom, with the ones waiting on you first.

## Pages

| Page | What's there |
|---|---|
| **Now** (`/now`) | Everything started, and urgent or high-priority Todo, across projects |
| **My issues** (`/mine`) | Open urgent (P0) issues anywhere on top, then what's assigned to you, proposals first |
| A project's **Issues** | A list (grouped by status or chunk) or a board, with search and filters for priority, column, assignee and label. It starts on the open issues: tick Done or Canceled under **Column** to see those too, and **Clear** to go back |
| An **issue's page** | Its title and description edit in place. Status, priority, assignee, labels and chunk change on the right. Also sub-issues, the sessions panel, and the activity: comments with a quiet line for every change between them (who moved it, assigned it, relabelled it, and when) |
| **Roadmap** | Chunks as cards in their columns. A chunk's page has its summary, priority, progress, issues and the sessions panel |
| **Docs** | The project's Markdown pages, with contents beside them |
| **Schedules** | Work Orrery starts on its own: each run makes an issue or messages the sessions |
| A project's **Settings** | Name, sidebar icon and colour, what its sessions hear (its own focus templates and standing instructions, or the Orrery's switched off), deleting the project (type its id to confirm) |
| **App settings** (`/settings`) | Your name, the tint that tells one Orrery (personal, work) from another, the issue statuses (add, rename, recolour, reorder or remove them), and what sessions hear: the focus templates, with a preview, and the standing instructions |
| **Connect** (`/connect`) | The line that sets a Claude session up in an app's repo |

## The bell

Agents' comments land in the bell in every page's header, which counts the new ones and opens **Notifications**: every comment in full, the ones asking you for a **decision** or **feedback** on top until you answer them on the issue. A card opens its issue. Clear them one by one, the read ones, or all at once; cleared ones stay under **Cleared**. A proposal's issue has **Approve**, **Request changes** and **Reject**, each with a note the session hears. Once approved, **Commit to the roadmap** makes it real work.

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
