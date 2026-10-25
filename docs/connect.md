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

In the repo's `.mcp.json`, named after the project (`orrery-<project>`, or plain `orrery`), so the
owner's signals reach its sessions:

```json
{
  "mcpServers": {
    "orrery-shop": {
      "command": "node",
      "args": ["/path/to/orrery/channel/orrery-channel.mjs"],
      "env": {
        "ORRERY_URL": "http://localhost:9000",
        "ORRERY_PROJECT": "shop"
      }
    }
  }
}
```

Channels are a Claude Code research preview, so a session only shows the channel's messages when it
was started with it: `claude --dangerously-load-development-channels server:orrery-shop`. A terminal
alias saves typing that, in `~/.zshrc`:

```sh
alias shop="cd ~/code/shop && ORRERY_PROJECT=shop claude --dangerously-load-development-channels server:orrery-shop"
```

Then `source ~/.zshrc` and start the session with `shop`. A repo with several projects (a monorepo,
one per app) gets one server and one alias for each.

The same server gives the session **tools** for its project's roadmap, so it works without curl:
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
project; without one, it's `shop`.

## 4. Optionally, let Orrery start sessions

Orrery can start a session itself when you send the project work and nobody is listening, or when you
press **Start session** on its Sessions tab, so nobody has to open a terminal. Turn it on under **Starting
sessions** on the project's Settings tab (how many at once, how many minutes each), then install the launcher
once, in the repo:

```bash
node /path/to/orrery/channel/orrery-launcher.mjs --install
```

It runs in the background from then on (launchd on macOS, systemd on Linux), starts at login, and serves
every project installed this way; run `--install` again in another repo to add its project, and
`--uninstall` to take one off. It finds the project and the Orrery in the repo's `.mcp.json` (or
`ORRERY_PROJECT` and `ORRERY_URL`), and keeps its list in `~/.config/orrery/launcher.json`. Its log is
`~/Library/Logs/orrery-launcher.log` on macOS, `journalctl --user -u orrery-launcher` on Linux, where it
stops at logout unless you `loginctl enable-linger`. To run it for a while instead, leave it open in a
terminal: `ORRERY_PROJECT=shop node /path/to/orrery/channel/orrery-launcher.mjs`.

It needs [tmux](https://github.com/tmux/tmux) 3.2 or newer: each session runs detached (`tmux attach -t <name>` to
watch it, as the launcher logs), with the channel and the hooks as usual, and is stopped once its minutes
are up, when you press **Stop** beside it (in the sessions panel or the project's settings, with **+30 min**
to give it longer), or when the launcher stops. With launchers on several machines, one of them starts each session. Nobody is there to answer a permission prompt, so it runs in `auto` mode
(`ORRERY_PERMISSION_MODE` picks another). The launcher answers the warning Claude Code shows for the channel
flag; run the channel command by hand once in the repo first, to trust the folder, which it won't do for you.
The limits are per project, on its Settings tab. The cap is time, not cost:
Claude Code only caps spend for non-interactive runs.
