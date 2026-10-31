# orrery

A self-hosted roadmap board for working with Claude Code sessions. Each project has issues, chunks
(milestones), releases and docs. Sessions read and update them through an HTTP API or MCP tools, and
the owner directs sessions from the board. It runs locally, in Docker, on SQLite or Postgres.

<table>
<tr>
<td width="50%"><img alt="A project's board in orrery: issues in In progress, Todo and Proposed columns, one waiting on the owner's decision and a proposal with choices, and the Claude sessions in the sidebar, one needing the owner" src="docs/images/board-light.png"></td>
<td width="50%"><img alt="An issue's page: a banner naming the session working on it, that session in its Sessions panel, its sub-issues, and a question waiting on the owner's decision" src="docs/images/issue-light.png"></td>
</tr>
<tr>
<td><img alt="The Sessions page: each project's Claude sessions with their state, folder and a message box, and what the working one is on now" src="docs/images/sessions-light.png"></td>
<td><img alt="The chat pane open over a project's issue list, ready for a first question, with suggestions and new issues going to Todo" src="docs/images/chat-light.png"></td>
</tr>
<tr>
<td><img alt="A project's docs: a page on how its sieve works, with the project's other docs and new ones listed beside it" src="docs/images/docs-light.png"></td>
<td><img alt="The Schedules page: two running schedules with when each runs next, and ready-made ones suggested for the project" src="docs/images/schedules-light.png"></td>
</tr>
</table>

## Features

- **Issues:** sub-issues to any depth, grouped into chunks, shown as a list or a board. The statuses
  are configurable, and every change is kept as activity. **My issues**, the home page, spans all projects.
- **Agent access:** a JSON API, MCP tools (`issue`, `start_issue`, `comment`, `finish_issue`, …) and
  `/llms.txt`. Agents can propose issues for the owner to approve, and ask for a decision or feedback.
- **Directing sessions:** through a Claude Code channel, the owner can ask a session to focus on an
  issue, work through a chunk, or read a message. Hooks report whether each session is working, idle
  or waiting. Only one session can work on an issue at a time, and its page shows who's on it.
- **Starting sessions:** optionally, a launcher on the host starts Claude sessions in tmux when work
  arrives with nobody listening, or when you start one, within limits set on the Sessions page.
- **Presets:** standing words a session is started or messaged with. orrery ships Release, Security audit, Review and
  Debug an error; you write the rest.
- **Schedules:** at a time or when something happens (an issue moves, a release is frozen, an error), make an
  issue, send the sessions a message, or start a session.
- **Chat:** Claude on every page, about the project you're on, with no terminal. It answers from the code, roadmap and
  docs, files and edits issues, messages your sessions for you, and asks before it changes a setting.
- **Releases:** versions with their issues and a drafted changelog, shared across a monorepo's projects
  if wanted.
- **Docs:** Markdown pages for each project, with every version kept, and HTML artifacts drawn in a locked-down frame. Comments and descriptions accept images.
- **Secrets:** API keys that agents use through orrery's egress, without ever seeing the value.
- **Event log:** orrery's errors and each change to the roadmap, and with Advanced on what it did, kept on the machine,
  on an Events page that sessions can read too.
- **Storage:** one SQLite file or Postgres, both backed up automatically, picked when you first open it or moved to
  later from App settings. Alone on your machine there's no login; with a second person or from another machine it asks for one. The first name given becomes the owner.

[Using orrery](docs/using.md) describes each page, menu and shortcut. A session in any connected repo can ask the same
through the `guide` tool.


## Keep your data safe

- **Your data is in Docker; your backups are in `ORRERY_BACKUP`.** The database lives in a Docker volume
  (`orrery_orrery-data`). A checked copy goes to the backup folder a few seconds after each change, plus one a day for
  two weeks.
- **Put `ORRERY_BACKUP` somewhere that leaves this computer:** iCloud Drive, Dropbox, or a folder Time Machine covers.
  Without it the backups sit in a Docker volume on the same disk, and App settings says so.
- **Never `docker compose down -v`**, and don't clear Docker Desktop's data, without a recent backup: both delete the
  database. Plain `docker compose down` keeps it.
- **To update:** change the version in `compose.yml`'s `image:` and run `docker compose pull && docker compose up -d`
  (see [Running orrery](docs/running.md#updating)). orrery takes a copy before it upgrades the database, and the
  channel, hooks and launcher follow.
- **To move to a new computer:** set it up the same way, point `ORRERY_BACKUP` at the same folder, and choose the
  backup to restore when it first opens.
- **If your data looks gone after an update:** run `docker volume ls`. A volume with another name (from an older setup
  in a folder with another name) may hold it. App settings → This orrery → Database → **Restore a backup…** brings back any backup
  in the folder.

## Quick start

You need:

- **Docker**, which runs orrery itself
- **Node 24**: the channel, hooks and launcher that connect Claude sessions run on your machine, outside Docker. orrery
  serves them itself, so they upgrade with it
- **Claude Code**
- **tmux 3.2+**, only if orrery should start sessions itself

1. Start orrery from the published image, in a folder of its own:

   ```sh
   mkdir orrery && cd orrery
   curl -LO https://github.com/steffendybvik/orrery/releases/download/v1.0.0-rc.16/compose.yml
   docker compose up -d        # http://localhost:9000
   ```

   To [build from source](docs/running.md#building-from-source) instead, clone this repo.

2. Open it and give your name (that makes you the owner). It opens on **Getting started**, which ticks off the
   steps below as they happen. Create a project there or from the sidebar (`+`).
3. Paste the line Getting started (or **Connect an agent**) gives you into a Claude session in that
   project's repo. The session writes the repo's `.mcp.json`, hooks and `CLAUDE.md` section itself.
4. From then on, start Claude in that repo with the channel, so orrery can send it work:

   ```sh
   claude --dangerously-load-development-channels server:orrery-personal
   ```

   The name after `server:` is the one in the repo's `.mcp.json`; Connect shows it. A shell alias saves typing it
   (see [Connecting a repo](docs/connect.md#2-add-the-channel)).

## Requirements and limits

- **Local by default.** Only this machine can reach it. Read [SECURITY.md](SECURITY.md) before
  exposing it.
- **Channels are a Claude Code research preview**, hence the long flag in step 4. Without it a session still
  has the tools and can read and update the roadmap, but orrery can't send it work.
- **Starting sessions** needs tmux 3.2 or newer, and the launcher installed once
  (Connect and the Sessions page give the line); a Claude session opened in a repo then adds it. On Windows it runs inside WSL
  ([On Windows](docs/connect.md#on-windows)).

## Documentation

- [Using orrery](docs/using.md): pages, menus, directing sessions, keys
- [Running orrery](docs/running.md): configuration, backups, Postgres, several instances, running without Docker
- [Connecting a repo](docs/connect.md): the MCP server and channel, hooks, the launcher
- [API](docs/API.md): every route and field
- [Development](docs/development.md): where things are, the dev server and checks
- [UI components](docs/components.md): the kit and shared pieces the page is built from
- [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
