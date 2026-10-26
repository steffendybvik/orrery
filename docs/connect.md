# Connecting a repo

The easy way: open **Connect an agent** in Orrery's sidebar, pick (or make) the repo's project, and
hand the Claude session in that repo the line it gives you. It writes the repo's `CLAUDE.md` section,
`.mcp.json` and hooks with this Orrery's address and paths filled in. What follows is the same by hand.

The channel and hooks run on macOS and Linux, and on Windows inside WSL: the hook commands set their
variables the POSIX shell way (`ORRERY_PROJECT=shop node …`), and the channel finds its Claude window
with `ps`. Orrery itself runs anywhere Docker does.

## 1. Create its project

The `id` is what the repo's sessions name it by; the `key` prefixes its issue ids (`SHP-1`,
`SHP-2`, …), and defaults to the name's first three letters.

```sh
curl -s -X POST http://localhost:9000/api/projects \
  -H 'Content-Type: application/json' -H 'Orrery-Actor: claude' \
  -d '{"name": "Shop", "id": "shop", "key": "SHP", "description": "The storefront"}'
```

## 2. Add the channel

In the repo's `.mcp.json`, one server for this Orrery, named after it (`orrery-<environment>`: `orrery-personal`,
`orrery-work`), so the owner's signals reach its sessions:

```json
{
  "mcpServers": {
    "orrery-personal": {
      "command": "node",
      "args": ["/path/to/orrery/channel/orrery-channel.mjs"],
      "env": {
        "ORRERY_URL": "http://localhost:9000",
        "ORRERY_ID": "orr_7f3a9c",
        "ORRERY_PROJECTS": "shop"
      }
    }
  }
}
```

`ORRERY_PROJECTS` lists the repo's projects on it: a monorepo with an app per project has them all in the one
server (`hub,css,pos`), or `*` for every project on the Orrery as the session starts. A tool on an issue finds its
project from the id (`HUB-12` is hub's); the others take `project`, and each `<channel>` message says its project.
`ORRERY_ID` is the Orrery's id (on its Connect page, or `GET /api/settings`): the channel refuses another Orrery at
`ORRERY_URL`, so a repo set up for one never writes to another after an address changes. A repo that works with two
Orrerys has one server for each. An older setup, a server per project with `ORRERY_PROJECT`, works the same.

Channels are a Claude Code research preview, so a session only shows the channel's messages when it
was started with it: `claude --dangerously-load-development-channels server:orrery-personal`. A terminal
alias saves typing that, in `~/.zshrc`:

```sh
alias shop="cd ~/code/shop && claude --dangerously-load-development-channels server:orrery-personal"
```

Then `source ~/.zshrc` and start the session with `shop`.

The same server gives the session **tools** for its projects' roadmaps, so it works without curl:
`issues`, `issue`, `start_issue`, `comment` (with `asks` for a decision or feedback), `finish_issue`,
`create_issue` (a proposal too, with choices), `update_issue`, `chunks`, `docs`, `doc` and
`write_doc`; and `secrets` and `egress`, to call an outside service with a [secret](API.md#secrets) it
never sees. They write as `claude`, from that session, so your comments on an issue it worked go back
to it. Tools work in any session with the server in `.mcp.json`, even one started without the
channels flag; only the pushed messages need the flag.

## 3. Optionally, the hooks

`channel/orrery-hook.mjs` tells Orrery what each session is doing, so the page can show it and aim
work at an idle one. Before a Bash command it also says which issues the command writes to, so the
owner's comment on one goes to the session working it rather than to every session. Register it in the repo's `.claude/settings.json` for `SessionStart`,
`UserPromptSubmit`, `PreToolUse` (with `"async": true`), `Stop`, `Notification` and `SessionEnd`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "ORRERY_PROJECT=${ORRERY_PROJECT:-shop} ORRERY_URL=http://localhost:9000 node /path/to/orrery/channel/orrery-hook.mjs",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The same entry goes under each of the other events. `${ORRERY_PROJECT:-shop}` lets an alias pick the
project; without one, it's `shop`. With a server serving several projects, it's the one a session is filed
under; it shows on the others' Sessions tabs too.

With the hooks, a session can clear its context without losing its place: after a `/clear` (or when
Claude Code compacts it) the channel stays connected, and `SessionStart` hands the fresh context the
issues it had in progress and their latest comment, so it carries on with them.

## 4. Optionally, let Orrery start sessions

Orrery can start a session itself when you send the project work and nobody is listening, or when you
press **Start session** on its Sessions tab, so nobody has to open a terminal. Turn it on once, for every
project, under App settings → Starting sessions (how many at once, how many minutes each; a project's Sessions
tab can give it limits of its own), then install the launcher once, in the repo:

```bash
node /path/to/orrery/channel/orrery-launcher.mjs --install
```

It runs in the background from then on (launchd on macOS, systemd on Linux), starts at login, and serves
every project installed this way; run `--install` again in another repo to add its project, and
`--uninstall` to take one off. It finds the projects and the Orrery in the repo's `.mcp.json` (each one in
its `ORRERY_PROJECTS`; with `*`, name the one with `ORRERY_PROJECT`), or `ORRERY_PROJECT` and `ORRERY_URL`, and keeps its list in `~/.config/orrery/launcher.json`. Its log is
`~/Library/Logs/orrery-launcher.log` on macOS, `journalctl --user -u orrery-launcher` on Linux, where it
stops at logout unless you `loginctl enable-linger`. To run it for a while instead, leave it open in a
terminal: `ORRERY_PROJECT=shop node /path/to/orrery/channel/orrery-launcher.mjs`.

Between pieces of work, a session it started gets a fresh context: once it goes idle with no issue in progress
and no signal waiting, the launcher types `/clear` into it. Its channel stays connected, and the brief after the
clear hands it the issues still in progress and what's left of a chunk or scope it was working through.

It needs [tmux](https://github.com/tmux/tmux) 3.2 or newer: each session runs detached (`tmux attach -t <name>` to
watch it, as the launcher logs), with the channel and the hooks as usual, and is stopped once its minutes
are up, when you press **Stop** beside it (in the sessions panel or the project's settings, with **+30 min**
to give it longer), or when the launcher stops. With launchers on several machines, one of them starts each session. Nobody is there to answer a permission prompt, so it runs in `auto` mode
(`ORRERY_PERMISSION_MODE` picks another). The launcher answers the warning Claude Code shows for the channel
flag; run the channel command by hand once in the repo first, to trust the folder, which it won't do for you.
The limits are the Orrery's, under App settings, unless a project's Sessions tab gives it its own. The cap is time, not cost:
Claude Code only caps spend for non-interactive runs.
