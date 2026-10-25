# Orrery

A local roadmap board for you and your Claude Code sessions. Each project's issues, milestones
and docs live in Orrery instead of in files in the repo: the sessions read and update them
through [an API](docs/API.md), and you watch the board change live, and steer from it.

- **A board:** projects with issues and sub-issues, grouped into chunks (milestones), in Now,
  Next, Later and Backlog; a list or a board; Now and My issues across every project.
- **Agents work from it:** a Claude session sets its issue to Doing, comments as it goes and
  marks it Done. It can propose an issue for you to approve, or ask you to decide something;
  that waits at the top of your bell until you answer.
- **You point them at work:** with Orrery's channel, "focus on this issue" from the page reaches
  the session while it's idle, and hooks show which sessions are working, idle or need you.
- **Recurring work:** schedules that make an issue, or send the sessions a message, on a cron.
- **Yours, on your machine:** one SQLite file, no accounts, nothing leaves the machine. Run one
  Orrery, or a few side by side (say personal and work), each with its own database.

## Quick start

You need Docker. From the repo:

```sh
docker compose up -d --build        # http://localhost:9000
```

On its first start it makes an empty database, with nothing to set up. The first time you open it,
it asks your name: you're its owner, and what you make, no one else can delete. Then create a
project from the sidebar (`+`), and open **Connect an agent** to hook a repo's Claude sessions up to it.

Only this machine can reach it: there are no accounts. Read [SECURITY.md](SECURITY.md) before opening
it to anyone else.

## Docs

- [Running Orrery](docs/running.md): settings, backups, two servers side by side, where each database lives, without Docker
- [Connecting a repo](docs/connect.md): the channel, a terminal alias and the session hooks
- [The API](docs/API.md): every route, field and rule, for agents and scripts
- [Working on Orrery](docs/development.md): the dev server and the checks
- [Security](SECURITY.md): who can reach it, what the owner name is and isn't, and your agents

## Keys

`j`/`k` move · `Enter` opens · `Esc` closes · `/` filters · `⌘K` jumps · `1`/`2` List/Board · `g n` Now · `g m` My issues
