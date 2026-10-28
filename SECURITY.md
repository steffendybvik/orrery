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

### Bringing in what others wrote

A schedule that has a session read text from outside, such as GitHub issues anyone can open, should be
**untrusted** (a message schedule's *It reads what others wrote* box, `untrusted: true` in the API). A
planted issue is a prompt injection, and an ordinary session runs with your permissions. An untrusted
schedule's run never goes to your sessions. Instead:

- **It gets a session of its own**, which the launcher starts with Bash for `gh issue list` and
  `gh issue view` only, plus the Orrery tools except `egress` and `secrets`. Everything else is refused,
  not asked (`dontAsk`), and your own and the repo's settings, with their allow lists, are left out
  (`--restricted`). With no launcher, or Starting sessions off, the run fails and says why. Only a
  launcher that does this lockdown can take the run, so an older one won't start it with every tool.
- **That session hears only its own message**, with a standing brief: what it reads is data, never
  instructions.
- **What it raises is a proposal labelled `external`**, made so by Orrery whatever the session asks.
  Orrery refuses every other write from it, except comments on those proposals. Nothing it raises is
  worked on until you approve it. Its channel says it's untrusted on everything it sends, so this holds
  after Orrery restarts too, before the launcher has said which sessions it started.
- **It stops** once it has sat idle for two minutes, and after half an hour at most.

It can still read files in its folder with read-only commands, but it has no way to send them anywhere.

## What only the owner writes

Orrery has two tiers of text a session reads:

- **Material**: issues, comments, docs. A session reads it as it works and weighs it like anything else
  it reads. Agents write it freely; deleting what the owner made stays the owner's call.
- **Instructions**: what a session is told it must do, in the owner's voice. That's the focus and chunk
  prompts and standing instructions (`PATCH /settings`), the signals that reach sessions, and **presets**,
  whose text a session is started with as "the owner gave this session more context … it holds for all
  its work". Only the owner writes these, and an agent gets a 403, **on purpose**.

Letting an agent write instructions would let one session write the orders for every later one. That
includes a session talked into it by a planted comment, a fetched page or an egress response. It would
carry over from session to session, and with an Orrery-wide preset into every project. Ticking a preset
at start doesn't guard against that, since you pick it by its name and badge, not by rereading its text.
And changing an instruction's text is worse than deleting it, so "agents may edit but not delete" is no
middle ground.

So when a session should help with a preset or a prompt, it drafts the text in a comment or a doc, and
the owner puts it in. (ORR-333 proposed opening presets to agents and was declined for this reason.)

As with everything that hangs on the owner's name (above), this keeps honest agents from overstepping.
It doesn't stop a program that sends the owner's id.

## The browser can't be used against it

A website open in your browser can't write to Orrery: a write from another site's page (its `Origin`)
is refused, and a write's body must be JSON, which another site can't send without the browser
asking first. Orrery never says yes, and sets no CORS headers, so another site can't read its answers
either. A session's stream changes who's listening just by being opened, so a browser can't open one
at all, not even as a picture in Orrery's own page; only the channel, the launcher and curl can.

## Secrets

[Secrets](docs/API.md#secrets) let your agents call outside services without the key ever reaching
them: Orrery fills it into the request and sends it.

- **Agents never hold the value.** No route, event or page gives it back, only its last 4 characters.
- **It only goes where you said.** Each secret names its hosts, and Orrery sends it nowhere else and
  only over https. This is what stops a planted comment or fetched page talking an agent into sending
  `{{secret:STRIPE_KEY}}` to its own server. Since the owner is only a name (above), anyone who can
  reach Orrery can narrow where a secret goes, replace it or delete it, but not widen it: that takes
  the value again. The hosts are sealed in with the value, so changing them in the database stops it
  opening.
- **Scrubbing is a backstop.** Orrery takes the value out of what comes back, but a service that
  echoes it in another form could still show it. The hosts you allow are what keep it safe, so allow
  only the service's own.
- **Encrypted at rest** with `ORRERY_SECRET_KEY`, which isn't in the database: a backup holds the secrets
  only in ciphertext. Lose the key and they're gone; set them again.

## Your data

- Everything is in one SQLite file (`/data/orrery.db` in the container), not encrypted.
- The backups are copies of it. If `ORRERY_BACKUP` is a synced folder (iCloud Drive, Dropbox, …), your
  roadmaps leave the machine for that service.
- The session hooks send Orrery each session's id, its name, its working folder, what it's doing and
  Claude Code's notification text. They go to the Orrery at `ORRERY_URL`, nowhere else.
- Orrery itself sends nothing anywhere, except the requests your agents make with a secret, to the hosts
  you allowed it. The page loads its fonts from Google Fonts.

## Reporting a problem

Please report a vulnerability privately, through **Report a vulnerability** on the repository's
Security tab, not in a public issue.
