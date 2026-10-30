# Connecting a repo

The easy way: open **Connect an agent** in orrery's sidebar and press **Connect a repo**. Your launcher opens this
machine's folder picker; choose the repo, tick its projects (or make one) on the page, and press **Set it up**. The launcher
writes the repo's `CLAUDE.md` section, `.mcp.json` and hooks, keeping what's in them and safe to run again, puts the repo on
its list, and opens Claude there in a terminal, where Claude Code asks once about the folder and the server. Commit the
files with the repo.

It needs the launcher running as a service, once per machine; the page gives the line until it is. macOS has its picker. On
Linux it needs a desktop with `zenity` or `kdialog`. In WSL, or with neither, use the other way: pick (or make) the repo's
project on the same page, and hand the Claude session in that repo the line it gives you, which has it write the same
files. What follows is the same by hand.

The channel and hooks run on macOS and Linux, and on Windows inside WSL: the hook commands set their
variables the POSIX shell way (`ORRERY_PROJECT=shop node …`), and the channel finds its Claude window
with `ps`. orrery itself runs anywhere Docker does.

## 1. Create its project

The `id` is what the repo's sessions name it by; the `key` prefixes its issue ids (`SHP-1`,
`SHP-2`, …), and defaults to the name's first three letters.

```sh
curl -s -X POST http://localhost:9000/api/projects \
  -H 'Content-Type: application/json' -H 'Orrery-Actor: claude' \
  -d '{"name": "Shop", "id": "shop", "key": "SHP", "description": "The storefront"}'
```

## 2. Add the channel

The channel, hooks and launcher are served by orrery and run through one small script per machine, which stays the same
across versions, so they upgrade with orrery ([what that means](../SECURITY.md#the-code-orrery-serves-your-machine)). Put it there once:

```bash
mkdir -p ~/.orrery && curl -fsS http://localhost:9000/channel/bootstrap.mjs -o ~/.orrery/bootstrap.mjs
```

A repo running a checkout's scripts (`/path/to/orrery/channel/orrery-channel.mjs`) keeps working; change its `args` and hooks to these to switch.

In the repo's `.mcp.json`, one server for this orrery, named after it (`orrery-<environment>`: `orrery-personal`,
`orrery-work`), so the owner's signals reach its sessions:

```json
{
  "mcpServers": {
    "orrery-personal": {
      "command": "node",
      "args": ["${HOME}/.orrery/bootstrap.mjs", "channel"],
      "env": {
        "ORRERY_URL": "http://localhost:9000",
        "ORRERY_ID": "orr_7f3a9c",
        "ORRERY_PROJECTS": "shop",
        "ORRERY_PERSON": "${ORRERY_PERSON:-}"
      }
    }
  }
}
```

`ORRERY_PROJECTS` lists the repo's projects on it: a monorepo with an app per project has them all in the one
server (`hub,css,pos`), or `*` for every project on the orrery as the session starts. A tool on an issue finds its
project from the id (`HUB-12` is hub's); the others take `project`, and each `<channel>` message says its project.
`ORRERY_HEAR` in a session's environment narrows that to the projects it names (`ORRERY_HEAR=hub claude …` hears only
hub); a session orrery starts gets it from Start session, so one started for Hub hears Hub alone, and one started
with no project ticked gets none, so where the channel lists `*` it hears every project.
`ORRERY_ID` is the orrery's id (on its Connect page, or `GET /api/settings`): the channel refuses another orrery at
`ORRERY_URL`, so a repo set up for one never writes to another after an address changes. A repo that works with two
Orrerys has one server for each. An older setup, a server per project with `ORRERY_PROJECT`, works the same.
`ORRERY_PERSON` says whose the session is, on an orrery with more than one person and login off (`ORRERY_AUTH=off`): your
id from `GET /api/people`, set in your own environment. With login on, the agent key says whose it is, and this is ignored, with a warning in the event log if it disagrees. It's written as `${ORRERY_PERSON:-}` because this file is committed, and a name in it would
make every clone that person. With one person, there's nothing to set.

Channels are a Claude Code research preview, so a session only shows the channel's messages when it
was started with it: `claude --dangerously-load-development-channels server:orrery-personal`. A terminal
alias saves typing that, in `~/.zshrc`:

```sh
alias shop="cd ~/code/shop && claude --dangerously-load-development-channels server:orrery-personal"
```

Then `source ~/.zshrc` and start the session with `shop`.

The same server gives the session **tools** for its projects' roadmaps, so it works without curl:
`issues`, `issue`, `start_issue`, `comment` (with `asks` for a decision or feedback), `finish_issue`,
`create_issue` (a proposal too, with choices), `update_issue`, `releases`, `docs`, `doc` and
`write_doc`; `sessions`, to read who's working on what; and `guide`, how orrery itself works ([Using orrery](using.md),
from the orrery it's connected to), so a session in any repo can answer "how do schedules work?". Those it needs less
often wait behind `more_tools`, so they don't take up its context until it asks for them: `create_schedule` and
`update_schedule`, to ask you on its issue for a schedule (saved only once you allow it); `secrets` and `egress`, to
call an outside service with a [secret](API.md#secrets) it never sees; and `events` and `resolve_event`, to debug
orrery from its [event log](API.md#event-log). `chunks`, `presets`, `preset` and `schedules`, which read the project's chunks, presets and schedules,
are the [chat](API.md#chats)'s. They write as `claude`, from that session, so your comments on an issue it worked go back
to it. Tools work in any session with the server in `.mcp.json`, even one started without the
channels flag; only the pushed messages need the flag.

An orrery that asks for a login ([when it does](../SECURITY.md#login-and-keys)) needs an agent key from App settings → You → Your keys. Set `ORRERY_KEY`
where you start Claude Code, or keep it in `~/.config/orrery/keys.json`, and never in `.mcp.json`, which is committed ([how](running.md#claiming-it-and-logging-in)). The
channel, hooks and launcher all send it. A session on your own machine, alone, needs none. Without a key, the brief at
`/connect` says only to get one and read it again, and `/llms.txt` leaves out the projects, so send `Authorization: Bearer $ORRERY_KEY` with those `curl`s.

## 3. Optionally, the hooks

The hook (`channel/orrery-hook.mjs`, run through the bootstrap) tells orrery what each session is doing, so the page can show it and aim
work at an idle one. Before a Bash command it also says which issues the command writes to, so the
owner's comment on one goes to the session working it rather than to every session. Before each tool, and when a
permission dialog opens, it says which tool and, in short, what it would do (the command, the file, the address), so a
permission prompt says what it's for. Register it in the repo's `.claude/settings.json` for `SessionStart`,
`UserPromptSubmit`, `PreToolUse` and `PermissionRequest` (both with `"async": true`, so they never hold up a tool or
answer its prompt), `Stop`, `StopFailure`, `Notification` and `SessionEnd`.
`StopFailure` is a turn an API error cut off (the network, a rate limit): the issues that session had in progress go
back to Todo with nobody on it, and a comment says why. One in review or waiting on you stays where it is. The Sessions
page and the sidebar mark the session (**usage limit reached**, with what Claude Code said) until its next turn gets going.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "ORRERY_PROJECT=${ORRERY_PROJECT:-shop} ORRERY_URL=http://localhost:9000 ORRERY_ID=orr_7f3a9c node \"$HOME/.orrery/bootstrap.mjs\" hook",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The same entry goes under each of the other events. `${ORRERY_PROJECT:-shop}` lets an alias pick the
project; without one, it's `shop`. (Connect writes the project plainly, `ORRERY_PROJECT=shop`; the `:-` form is for
when you want an alias to pick.) With a server serving several projects, it's the one a session is filed
under; it shows under the others on the Sessions page too.

With the hooks, a session can clear its context without losing its place: after a `/clear` (or when
Claude Code compacts it) the channel stays connected, and `SessionStart` hands the fresh context the
issues it had in progress and their latest comment, so it carries on with them.

## 4. Optionally, let orrery start sessions

orrery can start a session itself when you send the project work and nobody is listening, when you
press **Start session** on the Sessions page, or **New session on this** on an issue, so nobody has to open a terminal.
Turn it on once, for every project, under Starting sessions on the Sessions page's **Setup** tab (how many at once, how
many minutes each), then install the
launcher once, from the repo or anywhere:

```bash
node ~/.orrery/bootstrap.mjs launcher --install
```

It runs in the background from then on (launchd on macOS, systemd on Linux; on Windows, inside WSL, see
[On Windows](#on-windows)), starts at login, and serves
every project installed this way; run `--install` again in another repo to add its projects, and
`--uninstall` to take them off. Run outside a repo whose `.mcp.json` registers the channel, `--install` installs the
service with no project yet, and `--uninstall` removes the service, keeping its projects on the list for the next `--install`.
`--install` also turns on **pick-up** (`--no-pick-up` leaves it off): from then on, a Claude session you open in a repo
whose `.mcp.json` registers the channel puts that repo's projects on the list, by the same rules as `--install` there, and
the session is told once. Only the channel, running in that folder on your machine, does this; orrery itself never
names a folder for the launcher. A project orrery doesn't have, or one already served from another repo, is left
off, and `--uninstall` in a repo keeps it off until you `--install` there again. Connect the repo first (steps 1 and 2):
with no channel in its `.mcp.json`, `--install` there with `ORRERY_PROJECT` set refuses, rather than adding a project
whose sessions couldn't hear orrery, at an address it would have to guess. `--help` lists the flags, and an unknown one
is refused. A project on the list nothing answers for (its orrery gone, or a project it doesn't have) is logged once,
with the `--uninstall` that takes it off, and tried again quietly every 30 seconds. It finds the projects and their Orrerys in the repo's `.mcp.json`: every
channel there, each with the projects in its `ORRERY_PROJECTS` (or its `ORRERY_PROJECT`), so a monorepo with a
channel per project gets all of them, and each project's sessions load the channel that serves it. With `*`, or to
pick one, name it with `ORRERY_PROJECT`. `ORRERY_URL` stands in for a channel's address only where `.mcp.json` doesn't write
one out (`${ORRERY_URL:-…}`); a written address wins, so a session's own `ORRERY_URL` can't send a monorepo's projects to
another orrery. A project no channel names goes on `ORRERY_URL`, else the first channel's orrery. A project already served from another repo (a monorepo's channel to your
personal orrery) is left there unless `ORRERY_PROJECT` names it. `--list` shows what a repo would register, and
with which channel, without changing anything. The list is kept in `~/.config/orrery/launcher.json`, which the
running launcher follows: a project added there is served within a few seconds, and one taken off is let go, with its
sessions, while every other project's sessions go on. `--install` restarts the service only the first time, or when its
service file changes (a new `node` or `PATH`). Its log is
`~/Library/Logs/orrery-launcher.log` on macOS, `journalctl --user -u orrery-launcher` on Linux, where it
stops at logout unless you `loginctl enable-linger`. To run it for a while instead, leave it open in a
terminal: `ORRERY_PROJECT=shop node ~/.orrery/bootstrap.mjs launcher`. Next to the installed one, it leaves
that launcher's sessions alone: each session keeps its launcher's pid, and only a gone launcher's sessions are taken over.

Between pieces of work, a session it started gets a fresh context: once it goes idle with no issue in progress
and no signal waiting, the launcher types `/clear` into it. Its channel stays connected, and the brief after the
clear hands it the issues still in progress and what's left of a chunk or scope it was working through. When some of that
chunk or scope is left, orrery also sends it a focus on the rest, to it alone, so it carries on rather than waiting. A
focus on a single issue ends the chunk or scope it was working through.

It needs [tmux](https://github.com/tmux/tmux) 3.2 or newer: each session runs detached (`tmux attach -t <name>` to
watch it, as the launcher logs), with the channel and the hooks as usual, and is stopped once its minutes
are up, when you press **Stop** beside it (on the Sessions page, with **+30 minutes** to give it longer), or when the launcher stops. With launchers on several machines, one of them starts each session. Nobody is there to answer a permission prompt, so it runs in `auto` mode
(`ORRERY_PERMISSION_MODE` picks another). An untrusted schedule's session is the exception: it's locked down to
the orrery tools, which read GitHub issues for it (see [SECURITY.md](../SECURITY.md#bringing-in-what-others-wrote)), so a
launcher from before rc.10 needs restarting before it will take one. So is your [chat](API.md#chats): it gets `Read`,
`Grep`, `Glob` and the orrery tools that read, make issues, change an issue's fields, comment, message sessions and ask you to change a setting or a schedule when you ask, and answers with its own `reply` tool, so a
launcher that predates chats needs restarting before it will start one. The launcher answers the warning Claude Code shows for the channel
flag; run the channel command by hand once in the repo first, to trust the folder, which it won't do for you.
The limits are the orrery's, on the Sessions page's Setup tab: how many at once counts every project's sessions together. The cap is time, not cost:
Claude Code only caps spend for non-interactive runs.

### On Windows

The launcher, like the channel and hooks, runs inside [WSL](https://learn.microsoft.com/windows/wsl/) 2, with Claude
Code, tmux and the repo installed in the distro. Run `--install` from the distro, in the repo there. Started on Windows
itself, `--install` says to do this instead.

- **systemd on:** the service is systemd's, so turn it on once. Put `[boot]` and `systemd=true` in the distro's
  `/etc/wsl.conf`, run `wsl --shutdown` in Windows, and open the distro again. Without it, `--install` says the same.
- **Reaching orrery:** inside WSL, `localhost` is the distro's own. An orrery in Docker Desktop with WSL integration
  on is reached there anyway. One running on Windows outside Docker needs `networkingMode=mirrored` under `[wsl2]` in
  Windows' `%UserProfile%\.wslconfig`, or the Windows host's address in `.mcp.json`. When the launcher can't reach a
  `localhost` address, it says so.
- **While the distro runs:** the service starts with the distro, not at Windows sign-in. Windows starts the distro
  when you open it, and can stop it a while after its last window closes, so keep a WSL window open while sessions
  should start.
- **Watch** opens a Windows Terminal window on the session (`wt.exe`, through WSL's interop), whatever the terminal
  setting says. If it can't, the launcher's log has the `tmux attach` line to run by hand.
