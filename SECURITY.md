# Security

Orrery is built to run on your own machine, for you and your Claude Code sessions. It has **no
accounts and no passwords**: whoever can reach it can use it. Read this before opening it to anyone
else.

## Who can reach it

- **This machine only, by default.** Compose publishes the port on `127.0.0.1`, and the dev server
  (`docker-compose.dev.yml`) is always this machine's only, since it also hands out the source.
- **`ORRERY_HOST=0.0.0.0` opens it to your network.** Then anyone on that network can read every
  project and change or delete anything, and steer your agents (below). Only do that on a network you
  trust, or put it behind a reverse proxy that asks for a login.
- **Host names.** Orrery answers to `localhost` (and `*.localhost`) and IP addresses. Reaching it by
  another name, say `orrery.lan`, needs `ORRERY_ALLOWED_HOSTS=orrery.lan` (`NUXT_ALLOWED_HOSTS` without
  Docker). This is what stops DNS rebinding, a website pointing its own domain at your machine.

## The owner is a name, not a password

The owner (the name given on first open) is whoever sends their id in the `Orrery-Actor` header. That
keeps agents from deleting the owner's things, as long as they name themselves honestly. It is not
protection against a person or program that wants to pretend: anyone who can reach Orrery can send
the owner's id.

## Your agents act on what's in Orrery

Claude sessions read issues, comments and docs and work from them, and the owner's signals ("focus
on this issue") reach them through the channel. So **being able to write to Orrery means being able to
give your agents instructions**. Keep that in mind before opening it up, importing a roadmap you didn't
write, or letting another program write to it. Claude Code's own permissions still decide what a
session may do on your machine.

## The browser can't be used against it

A website open in your browser can't write to Orrery: a write from another site's page (its `Origin`)
is refused, and a write's body must be JSON, which another site can't send without the browser
asking first. Orrery never says yes, and sets no CORS headers, so another site can't read its answers
either.

## Your data

- Everything is in one SQLite file (`/data/orrery.db` in the container), not encrypted.
- The backups are copies of it. If `ORRERY_BACKUP` is a synced folder (iCloud Drive, Dropbox, …), your
  roadmaps leave the machine for that service.
- The session hooks send Orrery each session's id, its name, its working folder, what it's doing and
  Claude Code's notification text. They go to the Orrery at `ORRERY_URL`, nowhere else.
- Orrery itself sends nothing anywhere. The page loads its fonts from Google Fonts.

## Reporting a problem

Please report a vulnerability privately, through **Report a vulnerability** on the repository's
Security tab, not in a public issue.
