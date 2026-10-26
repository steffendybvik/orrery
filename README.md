# Orrery

A self-hosted roadmap board for working with Claude Code sessions. Each project has issues, chunks
(milestones), releases and docs. Sessions read and update them through an HTTP API or MCP tools, and
the owner directs sessions from the board. It runs locally, in Docker, on SQLite or Postgres.

<img alt="A project's board in Orrery: issues in In progress, In review, Todo, Backlog and Proposed columns, with sub-issue progress, labels, assignees and comment counts, and the Claude sessions working on them in the sidebar" src="docs/images/board-light.png">

## Features

- **Issues:** sub-issues to any depth, grouped into chunks, shown as a list or a board. The statuses
  are configurable, and every change is kept as activity. **Now** and **My issues** span all projects.
- **Agent access:** a JSON API, MCP tools (`issue`, `start_issue`, `comment`, `finish_issue`, …) and
  `/llms.txt`. Agents can propose issues for the owner to approve, and ask for a decision or feedback.
- **Directing sessions:** through a Claude Code channel, the owner can ask a session to focus on an
  issue, work through a chunk, or read a message. Hooks report whether each session is working, idle
  or waiting. Only one session can work on an issue at a time.
- **Starting sessions:** optionally, a launcher on the host starts Claude sessions in tmux when work
  arrives with nobody listening, within limits set in App settings.
- **Schedules:** cron jobs that create an issue or send the sessions a message.
- **Releases:** versions with their issues and a drafted changelog, shared across a monorepo's projects
  if wanted.
- **Docs:** Markdown pages for each project. Comments and descriptions accept images.
- **Secrets:** API keys that agents use through Orrery's egress, without ever seeing the value.
- **Storage:** one SQLite file with automatic backups, or Postgres. There are no accounts; the first
  name given becomes the owner.

[Using Orrery](docs/using.md) describes each page, menu and shortcut.

## Quick start

Requires Docker.

```sh
docker compose up -d --build        # http://localhost:9000
```

Open it and give your name, which makes you the owner. Create a project from the sidebar (`+`), then
open **Connect an agent** and paste the line it gives you into a Claude session in that project's
repo. The session sets the repo up itself.

## Requirements and limits

- **Local by default.** Only this machine can reach it. Read [SECURITY.md](SECURITY.md) before
  exposing it.
- **Channels are a Claude Code research preview.** For Orrery to send a session messages, the session
  has to be started with `claude --dangerously-load-development-channels server:orrery-<environment>`
  (the server registered in the repo's `.mcp.json`). Everything else works without it.
- **Starting sessions** needs tmux 3.2 or newer, and the launcher installed once per repo
  (`node /path/to/orrery/channel/orrery-launcher.mjs --install`).

## Documentation

- [Using Orrery](docs/using.md): pages, menus, directing sessions, keys
- [Running Orrery](docs/running.md): configuration, backups, Postgres, several instances, running without Docker
- [Connecting a repo](docs/connect.md): the MCP server and channel, hooks, the launcher
- [API](docs/API.md): every route and field
- [Development](docs/development.md): where things are, the dev server and checks
- [UI components](docs/components.md): the kit and shared pieces the page is built from
- [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
