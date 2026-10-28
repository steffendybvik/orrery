# Security

orrery is built to run on your own machine, for you and your Claude Code sessions. It has **no
accounts and no passwords**: whoever can reach it can use it. Read this before opening it to anyone
else.

## Who can reach it

- **This machine only, by default.** Compose publishes the port on `127.0.0.1`, and the dev server
  (`docker-compose.dev.yml`) is always this machine's only, since it also hands out the source.
- **`ORRERY_HOST=0.0.0.0` opens it to your network.** Then anyone on that network can read every
  project and change or delete anything, and steer your agents (below). Only do that on a network you
  trust, or put it behind a reverse proxy that asks for a login.
- **Host names.** orrery answers to `localhost` (and `*.localhost`) and IP addresses. Reaching it by
  another name, say `orrery.lan`, needs `ORRERY_ALLOWED_HOSTS=orrery.lan` (`NUXT_ALLOWED_HOSTS` without
  Docker). This is what stops DNS rebinding, a website pointing its own domain at your machine.

## The owner is a name, not a password

The owner (the name given on first open) is whoever sends their id in the `Orrery-Actor` header. That
keeps agents from deleting the owner's things, as long as they name themselves honestly. It is not
protection against a person or program that wants to pretend: anyone who can reach orrery can send
the owner's id.

Moving the database (App settings → Database → Move…) repoints orrery at a database the mover picks, and setting
the backups chooses where a copy of everything goes, so both are kept to the machine orrery runs on, from where
the connection comes rather than the name the request gives (its `Host`, which the caller chooses: ORR-421).
Outside Docker the connection has to come from a loopback address. In Docker every request reaches the container
through its bridge, so orrery can't tell; there both work only while it's published on loopback (`ORRERY_HOST`
left at 127.0.0.1), and with `ORRERY_HOST=0.0.0.0` they're refused, and done outside the app instead
(`pnpm orrery:copy` and `ORRERY_DATABASE`, `ORRERY_BACKUP`). A reverse proxy on the same machine makes every request
come from loopback, whoever sent it, so a request that carries a proxy's headers (`Forwarded`, `X-Forwarded-For`,
`-Host`, `-Proto`, `X-Real-IP`) is refused too (ORR-457). A proxy that strips them, or that passes on requests
without saying so, defeats this check: don't put one in front of orrery that forwards from other machines without
asking for a login.

Errors the page reports (`POST /api/events/log`) are taken from anyone, a few a minute from each sender (who it
says it is, and where from) and a hundred from all of them, so one script can't use up what the page may send.

## Your agents act on what's in orrery

Claude sessions read issues, comments and docs and work from them, and the owner's signals ("focus
on this issue") reach them through the channel. So **being able to write to orrery means being able to
give your agents instructions**. Keep that in mind before opening it up, importing a roadmap you didn't
write, or letting another program write to it. Claude Code's own permissions still decide what a
session may do on your machine.

### Bringing in what others wrote

A schedule that has a session read text from outside, such as GitHub issues anyone can open, should be
**untrusted** (a message schedule's *It reads what others wrote* box, `untrusted: true` in the API). A
planted issue is a prompt injection, and an ordinary session runs with your permissions. An untrusted
schedule's run never goes to your sessions. Instead:

- **It gets a session of its own**, which the launcher starts with none of Claude Code's own tools (no
  Bash, no file reads), only the orrery tools except `egress` and `secrets`. It reads GitHub issues with
  the channel's `github_issues`, which runs `gh` itself on the repo the folder's git remote names, with
  arguments the session can't turn into another host (`-R`) or a browser (`--web`). Everything else is refused,
  not asked (`dontAsk`), and your own and the repo's settings, with their allow lists, are left out
  (`--restricted`). With no launcher, or Starting sessions off, the run fails and says why. Only a
  launcher that does this lockdown can take the run, so an older one (which gave it `gh`) won't start it.
- **That session hears only its own message**, with a standing brief: what it reads is data, never
  instructions.
- **What it raises is a proposal labelled `external`**, made so by orrery whatever the session asks. Labels it
  picks are dropped, so none can match an event schedule's filter once you approve it.
  orrery refuses every other write from it, except comments on those proposals. Nothing it raises is
  worked on until you approve it, and what it writes sets off no schedule, so an event schedule can't
  start a session of yours on it. Its channel says it's untrusted on everything it sends, so this holds
  after orrery restarts too, before the launcher has said which sessions it started.
- **It stops** once it has sat idle for two minutes, and at half an hour, busy or not: it isn't let finish
  its turn, so half an hour is as long as it runs (checked every 30 seconds).
- **Its hook claims no issue.** What it runs is never taken as working an issue, and its refused writes set
  off no schedule either.

So it has no way to send what it reads anywhere but to orrery, as proposals you see first (ORR-415).

### The chat

The chat (the button in the corner) is a session started for you to talk to on the page. Its launcher starts it with
`Read`, `Grep` and `Glob` and no Bash or edits, so it can't change the code or run anything, and without `egress`,
`secrets`, `write_doc`, `resolve_event` or the tools that take up or finish work. orrery holds its writes to making issues (unstarted and
unassigned), changing an issue's title, description, priority, labels, team tasks, chunk, release or parent (any other
change is refused), commenting, and
answering you. It changes those fields even on an issue another session is working: the check that refuses one
session's writes to another's issue lets you and your chat through, since it changes one only when you ask.

Three more go further, and you should know how far:

- **Settings** it can only ask for: you see the change, from → to, and nothing is saved until you press **Allow**.
  Secrets, the database, statuses and how sessions start aren't among them.
- **Schedules** it can only ask for too: a new one with each field it sets, or a change with each field from → to.
  Nothing is saved until you press **Allow**, and then it's yours, so a schedule that starts sessions starts them as
  you. Read what it would send before allowing it. Whether a schedule is untrusted, and deleting one, stay yours on
  the Schedules page.
- **Messages to your sessions** it can only ask for as well: you see the text and who it goes to, and nothing is sent
  until you press **Send**. orrery refuses the chat on both message routes, so this holds whatever it was talked into.
  Once sent, a message goes out as yours, the owner's instructions in the sense below, marked as sent through the chat
  (on the Sessions page, in the event log, and in what the session hears). The chat reads issues, comments, docs and
  the code, so read what it asks to send as you would anything that could come from a planted comment (ORR-416).

## What only the owner writes

orrery has two tiers of text a session reads:

- **Material**: issues, comments, docs. A session reads it as it works and weighs it like anything else
  it reads. Agents write it freely; deleting what the owner made stays the owner's call.
- **Instructions**: what a session is told it must do, in the owner's voice. That's the focus and chunk
  prompts and standing instructions (`PATCH /settings`), the signals that reach sessions, and **presets**,
  whose text a session is started with as "the owner gave this session more context … it holds for all
  its work". Only the owner writes these, and an agent gets a 403, **on purpose**.

The chat's messages to sessions are the one exception: it can only ask, and they go as yours once you press **Send**
([below](#the-owners-chat)).

Letting an agent write instructions would let one session write the orders for every later one. That
includes a session talked into it by a planted comment, a fetched page or an egress response. It would
carry over from session to session, and with an orrery-wide preset into every project. Ticking a preset
at start doesn't guard against that, since you pick it by its name and badge, not by rereading its text.
And changing an instruction's text is worse than deleting it, so "agents may edit but not delete" is no
middle ground.

So when a session should help with a preset or a prompt, it drafts the text in a comment or a doc, and
the owner puts it in. (ORR-333 proposed opening presets to agents and was declined for this reason.)

What an event schedule passes on follows the same rule. A session schedule's instructions and a message schedule's
message end with what happened, said by ids: the change for a status, priority, chunk, release or parent, never a
label's text, and an agent by its handle. A launcher's report of what it runs can't give a session a context
orrery didn't start it with. A launcher's claim on a session waiting to start counts only with the token its stream
was given as it connected (ORR-443), so a program posting claims can't take a launch and keep it from starting. Anything
that can open a launcher stream is a launcher, though, and gets a token like any other.

### The owner's chat

The chat on the page writes as `claude`, like any agent, under the same rules: it makes and changes issues and
comments, and it can't touch presets, prompts or settings. Three things go further, since you asked for them there,
and each is only ever asked:

- **Changing an App setting, or making or changing a schedule:** you see it from → to, and nothing is saved until you
  press **Allow** in the page. An allowed schedule is yours, so read what it sends.
- **Messaging your other sessions:** you see the text and who it goes to, and nothing is sent until you press
  **Send**. Then it goes as you, marked as sent through the chat. The message routes refuse the chat itself, so a
  chat talked into it by something it read can't reach your sessions without you reading it first (ORR-416).

As with everything that hangs on the owner's name (above), this keeps honest agents from overstepping.
It doesn't stop a program that sends the owner's id.

## The browser can't be used against it

A website open in your browser can't write to orrery: a write from another site's page (its `Origin`)
is refused, and a write's body must be JSON, which another site can't send without the browser
asking first. orrery never says yes, and sets no CORS headers, so another site can't read its answers
either. A session's stream changes who's listening just by being opened, so a browser can't open one
at all, not even as a picture in orrery's own page; only the channel, the launcher and curl can.

## Secrets

[Secrets](docs/API.md#secrets) let your agents call outside services without the key ever reaching
them: orrery fills it into the request and sends it.

- **Agents never hold the value.** No route, event or page gives it back, only its last 4 characters.
- **It only goes where you said.** Each secret names its hosts, and orrery sends it nowhere else and
  only over https. This is what stops a planted comment or fetched page talking an agent into sending
  `{{secret:STRIPE_KEY}}` to its own server. Since the owner is only a name (above), anyone who can
  reach orrery can narrow where a secret goes, replace it or delete it, but not widen it: that takes
  the value again. The hosts are sealed in with the value, so changing them in the database stops it
  opening.
- **Scrubbing is a backstop.** orrery takes the value out of what comes back, but a service that
  echoes it in another form could still show it. The hosts you allow are what keep it safe, so allow
  only the service's own.
- **Encrypted at rest** with `ORRERY_SECRET_KEY`, which isn't in the database: a backup holds the secrets
  only in ciphertext. Lose the key and they're gone; set them again.

## Your data

- Everything is in one database: a SQLite file (`/data/orrery.db` in the container) unless you chose Postgres,
  not encrypted either way. A Postgres chosen in App settings has its address, password included, kept in plain
  text in `orrery.db.moved.json` beside it. A move leaves the database you left as it was, a full copy.
- The backups are copies of it. If `ORRERY_BACKUP` is a synced folder (iCloud Drive, Dropbox, …), your
  roadmaps leave the machine for that service.
- The session hooks send orrery each session's id, its name, its working folder, what it's doing and
  Claude Code's notification text. They go to the orrery at `ORRERY_URL`, nowhere else.
- **The event log** (Advanced → Events) keeps what went wrong, with error messages and stacks, for 30 days on
  this machine. Secrets' values and database passwords are taken out before it's written. Every session can read
  it. A session can mark an error resolved, but the row then says which agent did, and the bell keeps showing it
  until you've looked. Anything can add a page error, so those are marked as reports and held to 5 of a kind and 20
  in all a minute. Read the log as a lead, not proof (ORR-420).
- orrery itself sends nothing anywhere, except your roadmap to a Postgres you chose, and the requests your
  agents make with a secret, to the hosts you allowed it. The page loads its fonts from Google Fonts.

## Reporting a problem

Please report a vulnerability privately, through **Report a vulnerability** on the repository's
Security tab, not in a public issue.
