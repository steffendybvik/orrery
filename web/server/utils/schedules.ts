// A project's schedules: recurring work orrery starts on its own. At each time a schedule makes an issue
// in its project (marked with the schedule) and, with `ask`, points the project's listening Claude
// sessions at it; or, as a `message` schedule, sends its message to the sessions with no issue. An issue
// run is skipped while the last one's issue is still open (`skip_open`), a message run when nothing in the
// project changed since the last one sent (`only_if_changed`). An `untrusted` message schedule brings in what others
// wrote (GitHub issues), so its message is never sent to the project's sessions: each run starts a locked-down
// session for it alone (launches.ts), or fails saying why. The timer
// (server/plugins/schedules.ts) calls `runDue`; a run is claimed by moving `next_run` on first, so two
// servers (a reloading `nuxt dev`) can't run it twice, and after downtime a schedule runs once.
//
// Or a schedule runs `on` an event instead of a clock (ORR-341, shared/happenings.ts): `hear` gets each one, and
// a schedule whose pattern and `on_filter` it fits runs about it, once per subject (an issue bounced in and out of a
// status runs it once), not within a minute of its last run, and never on what a schedule's own run did.
//
// A `session` schedule (ORR-342) starts a session through the project's launcher instead, as Start session does: with
// its `presets` and its words, focused on the issue or release an event was about. A message schedule's `presets` go
// before its words, read at each run, so a preset is written once and sent on a timer (ORR-332).
//
// An `action` schedule (ORR-636) changes the board itself, with no session: on an event it moves the event's issue, or a
// release's issues, to its status (`place`), each with a word from orrery saying why. It's the owner's alone, and it passes
// over what still waits on them: an open ask, a proposal, or (for a pull request's news) another PR still open.
import {AsyncLocalStorage} from 'node:async_hooks'
import {Cron} from 'croner'
import type {OnFilter, OrreryEvent} from '#shared/happenings'
import {EVENT_PATTERN, matchesType} from '#shared/happenings'
import type {Issue, Preset, Priority, Schedule, ScheduleRun} from '#shared/roadmap'
import {CLOSED, EVENT_LEVELS, KINDS, PRIORITIES} from '#shared/roadmap'
import type {Db} from './database'
import {one} from './database'
import type {Field, Input} from './input'
import {badRequest, checkInput, conflict, notFound} from './input'
import type {Actor, Store} from './store'
import {AGENT} from './store'
import {refusedFor} from './permission'
import {startsNone} from './starts-none'

interface ScheduleRow {
    id: number, project: string, kind: Schedule['kind'], title: string, notes: string | null, cron: string | null, at: string | null, timezone: string,
    place: string, chunk: string | null, priority: Priority | null, labels: string, ask: number, skip_open: number, only_if_changed: number, untrusted: number, enabled: number,
    next_run: string | null, on_event: string | null, on_filter: string | null, presets: string, move_from: string, created_by: string, owned: number, created_at: string, updated_at: string
}
interface RunRow { id: number, schedule: number, at: string, outcome: ScheduleRun['outcome'], issue: string | null, note: string | null, subject: string | null }

/** What a session schedule's run starts: as `POST …/launches` takes it. */
export interface SessionStart { presets: number[], instructions: string, issue?: string, release?: string }

/** The schedule whose run is under way, so what its run does (the issue it makes) runs no schedule. */
export const scheduleRunning = new AsyncLocalStorage<number>()

/** How long after a run an event schedule waits before it runs again, so a burst runs it once. */
const COOLDOWN = 60_000

/** `on_filter` as it's sent (`to`, `from`, `by` owner or session, and `level`, each optional), as it's stored. */
function parseFilter(value: unknown): string {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('send an object: {"to": "in-review"}')
    const {to, from, by, level, ...rest} = value as Record<string, unknown>
    const extra = Object.keys(rest)
    if (extra.length) throw new Error(`"${extra[0]}" isn't one; use to, from, by or level`)
    for (const [key, given] of Object.entries({to, from})) if (given !== undefined && typeof given !== 'string') throw new Error(`"${key}" is a value, e.g. "in-review"`)
    if (by !== undefined && by !== 'owner' && by !== 'session') throw new Error('"by" is "owner" or "session"')
    if (level !== undefined && !EVENT_LEVELS.includes(level as never)) throw new Error(`"level" is one of ${EVENT_LEVELS.join(', ')}`)
    return JSON.stringify(Object.fromEntries(Object.entries({to, from, by, level}).filter(([, v]) => v !== undefined && v !== '')))
}

/** `presets` as it's sent (a list of preset ids), as it's stored. */
function parsePresets(value: unknown): string {
    if (!Array.isArray(value) || value.some(id => !Number.isInteger(id))) throw new Error('send a list of preset ids, e.g. [3, 7]')
    return JSON.stringify([...new Set(value as number[])])
}

const SCHEDULE_FIELDS: Record<string, Field> = {
    /** `issue` (the default) makes an issue each run; `message` sends `notes` to the sessions instead; `session` starts
     * a session with `presets` and `notes`; `action` moves what its event is about to `column`. */
    kind: {type: 'string', values: ['issue', 'message', 'session', 'action']},
    title: {type: 'string', required: true},
    notes: {type: 'string', nullable: true},
    /** Five fields (minute hour day month weekday), e.g. `0 9 * * 1-5`; or `at`, once; or `on`, an event. */
    cron: {type: 'string', nullable: true},
    at: {type: 'string', nullable: true},
    /** An event's type, `*` for any part of it: `issue.status`, `release.*`, `*.failed` (shared/happenings.ts). */
    on: {type: 'string', nullable: true},
    on_filter: {type: 'json', nullable: true, parse: parseFilter},
    /** Preset ids (the orrery's or the project's) a message or session schedule is given, before `notes`. */
    presets: {type: 'json', nullable: true, parse: parsePresets},
    /** An IANA zone, e.g. `Europe/Oslo`; the server's when left out. */
    timezone: {type: 'string'},
    /** Where its issues start: an open status's id, or a kind (`todo`). An action schedule's: the status it moves them to. */
    column: {type: 'string'},
    /** The statuses (ids or kinds) an action schedule moves issues out of; none, any open one. */
    move_from: {type: 'strings', nullable: true},
    chunk: {type: 'string', nullable: true},
    priority: {type: 'string', values: PRIORITIES, nullable: true},
    labels: {type: 'strings', nullable: true},
    ask: {type: 'boolean'},
    skip_open: {type: 'boolean'},
    /** A message schedule skips a run when no issue or comment in the project changed since the last one it sent. */
    only_if_changed: {type: 'boolean'},
    /** A message schedule that brings in what others wrote: each run gets a locked-down session of its own. */
    untrusted: {type: 'boolean'},
    enabled: {type: 'boolean'},
}

/** How many runs a schedule shows. */
const RUNS = 10

/** What the schedules reach outside the database through. */
export interface ScheduleHooks {
    /** Hears a project's schedules changed or ran. */
    onChange: (project: string) => void
    /** How many sessions a project has listening. */
    listening: (project: string) => number
    /** Starts an untrusted run's session, with its message for it alone; says its tmux session. */
    startUntrusted: (project: string, schedule: number, text: string, actor: Actor) => Promise<{tmux: string}>
    /** Hears each run, with what came of it. */
    onRan: (schedule: {id: number, project: string, title: string}, run: ScheduleRun, manual: boolean) => void
    /** Starts a session schedule's session; says its tmux session. */
    startSession: (project: string, start: SessionStart, actor: Actor) => Promise<{tmux: string}>
}

/** A run under way: the schedule, what set it off, and how it's recorded. */
interface Run {
    row: ScheduleRow
    now: Date
    manual: boolean
    event?: OrreryEvent
    actor: Actor
    /** What it ran on, said by ids. */
    about: string | null
    presets: Preset[]
    record: (outcome: ScheduleRun['outcome'], issue: string | null, said: string | null) => Promise<ScheduleRun>
}

/** What a message or an issue run says: its presets' text, its notes (a message with neither says its title), and what it
 * ran on. */
function wordsOf({row, presets, about}: Run): string {
    return [...presets.map(p => p.text), row.notes ?? (row.kind === 'message' && !presets.length ? row.title : null), about].filter(Boolean).join('\n\n')
}

export class Schedules {
    private readonly onChange: ScheduleHooks['onChange']
    private readonly listening: ScheduleHooks['listening']
    private readonly startUntrusted: ScheduleHooks['startUntrusted']
    private readonly onRan: ScheduleHooks['onRan']
    private readonly startSession: ScheduleHooks['startSession']

    /** What it isn't given does nothing: nobody hears, nobody listens, and no session can be started. */
    constructor(private readonly store: Store, hooks: Partial<ScheduleHooks> = {}) {
        const none = () => Promise.reject(new Error('orrery starts no sessions here'))
        this.onChange = hooks.onChange ?? (() => {})
        this.listening = hooks.listening ?? (() => 0)
        this.startUntrusted = hooks.startUntrusted ?? none
        this.onRan = hooks.onRan ?? (() => {})
        this.startSession = hooks.startSession ?? none
    }

    private get db() {
        return this.store.db
    }

    /** Every project's schedules, or one project's; soonest first, paused last. */
    async list(project?: string): Promise<Schedule[]> {
        if (project) await this.store.project(project)
        const rows = project
            ? (await this.db.all<ScheduleRow>('SELECT * FROM schedules WHERE project = ?', project))
            : (await this.db.all<ScheduleRow>('SELECT * FROM schedules'))
        return (await Promise.all(rows.map(row => this.scheduleOf(row))))
            .sort((a, b) => (a.next_run ?? '~').localeCompare(b.next_run ?? '~') || a.title.localeCompare(b.title))
    }

    async get(project: string, id: number): Promise<Schedule> {
        return await this.scheduleOf(await this.row(project, id))
    }

    async create(project: string, body: unknown, actor = AGENT): Promise<Schedule> {
        const insert = await this.toCreate(project, body, actor)
        const {id} = await one<{id: number}>(this.db, `INSERT INTO schedules (project, kind, title, notes, cron, at, on_event, on_filter, presets, move_from, timezone, place, chunk, priority, labels, ask, skip_open, only_if_changed,
            untrusted, enabled, next_run, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, ...insert)
        this.listeners = null
        this.onChange(project)
        return await this.get(project, id)
    }

    /** Checks a new schedule (`id` none) or a change to schedule `id` as `create` and `update` would, saving nothing: so
     * the chat's request for one fails when it asks, not once the owner allows it. */
    async check(project: string, body: unknown, actor: Actor, id?: number): Promise<void> {
        if (id === undefined) await this.toCreate(project, body, actor)
        else await this.toUpdate(project, id, body, actor)
    }

    /** A new schedule's row, checked: what `create` inserts. */
    private async toCreate(project: string, body: unknown, actor: Actor): Promise<(string | number | null)[]> {
        await this.store.project(project)
        const input = checkInput(body, SCHEDULE_FIELDS)
        const when = this.when({cron: input.cron, at: input.at, on: input.on, timezone: input.timezone}, true)
        const chunk = await this.chunk(project, input.chunk)
        const now = new Date().toISOString()
        const enabled = input.enabled ?? true
        const kind = String(input.kind ?? 'issue') as Schedule['kind']
        const presets = await this.presets(project, kind, input.presets ?? '[]')
        this.checkKind(kind, text(input.notes), presets, !!input.untrusted, actor, when.on)
        if (kind === 'action' && input.column === undefined) throw badRequest('An action schedule moves issues to a status: send it in "column"')
        return [project, kind, String(input.title).trim(), text(input.notes), when.cron, when.at, when.on, filterOf(when.on, input.on_filter), presets, await this.moveFrom(input.move_from), when.timezone, await this.place(input.column ?? 'todo', kind), chunk,
            text(input.priority), JSON.stringify(input.labels ?? []), Number(input.ask ?? false), Number(input.skip_open ?? true), Number(input.only_if_changed ?? false),
            Number(input.untrusted ?? false), Number(enabled),
            enabled ? nextRun(when, new Date()) : null, actor.name, Number(actor.owner), now, now]
    }

    /** Changing when it runs, or turning it back on, works out its next run again. The owner's schedules are
     * theirs: what one says runs as them, so only they change it. */
    async update(project: string, id: number, body: unknown, actor = AGENT): Promise<Schedule> {
        const fields = await this.toUpdate(project, id, body, actor)
        await this.db.run(`UPDATE schedules SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, ...fields.map(([, v]) => v as string | number | null), id)
        this.listeners = null
        this.onChange(project)
        return await this.get(project, id)
    }

    /** A change to schedule `id`, checked: the columns `update` sets. */
    private async toUpdate(project: string, id: number, body: unknown, actor: Actor): Promise<[string, unknown][]> {
        const row = await this.row(project, id)
        if (row.owned && !actor.owner) throw refusedFor('schedules.owners', `Changing schedule ${id}: it's the owner's; only they can change it`)
        const input = checkInput(body, SCHEDULE_FIELDS, true)
        const timing = input.cron !== undefined || input.at !== undefined || input.on !== undefined || input.timezone !== undefined
        // Setting one of cron, at and on lets go of the others.
        const when = this.when({
            cron: input.cron !== undefined ? input.cron : input.at || input.on ? null : row.cron,
            at: input.at !== undefined ? input.at : input.cron || input.on ? null : row.at,
            on: input.on !== undefined ? input.on : input.cron || input.at ? null : row.on_event,
            timezone: input.timezone ?? row.timezone,
        }, timing)
        const filter = filterOf(when.on, input.on_filter !== undefined ? input.on_filter : row.on_filter)
        const enabled = input.enabled === undefined ? !!row.enabled : !!input.enabled
        const next = enabled && (timing || !row.enabled || !row.next_run) ? nextRun(when, new Date()) : enabled ? row.next_run : null
        const kind = String(input.kind ?? row.kind) as Schedule['kind']
        const message = input.notes === undefined ? row.notes : text(input.notes)
        const presets = input.presets === undefined && kind === row.kind ? row.presets : await this.presets(project, kind, input.presets === undefined ? row.presets : input.presets ?? '[]')
        const untrusted = input.untrusted === undefined ? !!row.untrusted : !!input.untrusted
        this.checkKind(kind, message, presets, untrusted, actor, when.on, ', or "untrusted": false')
        if (kind === 'action' && row.kind !== 'action' && input.column === undefined) throw badRequest('An action schedule moves issues to a status: send it in "column"')
        const set: Record<string, unknown> = {
            kind: input.kind,
            title: input.title === undefined ? undefined : String(input.title).trim(),
            notes: input.notes === undefined ? undefined : text(input.notes),
            cron: when.cron, at: when.at, on_event: when.on, on_filter: filter, presets, timezone: when.timezone,
            // A status an action schedule moved issues to may be closed, which is no place for another kind's issues to start.
            place: input.column !== undefined ? await this.place(input.column, kind) : kind === row.kind ? undefined : await this.place(row.place, kind),
            move_from: input.move_from === undefined ? undefined : await this.moveFrom(input.move_from),
            chunk: input.chunk === undefined ? undefined : await this.chunk(project, input.chunk),
            priority: input.priority === undefined ? undefined : text(input.priority),
            labels: input.labels === undefined ? undefined : JSON.stringify(input.labels ?? []),
            ask: input.ask === undefined ? undefined : Number(input.ask),
            skip_open: input.skip_open === undefined ? undefined : Number(input.skip_open),
            only_if_changed: input.only_if_changed === undefined ? undefined : Number(input.only_if_changed),
            untrusted: input.untrusted === undefined ? undefined : Number(input.untrusted),
            enabled: Number(enabled),
            next_run: next,
            // An agent's schedule stays the agent's whoever changes it, a pause or a rename by the owner included:
            // only `adopt` makes it theirs, once they've read what it says (ORR-456).
            updated_at: new Date().toISOString(),
        }
        return Object.entries(set).filter(([, v]) => v !== undefined)
    }

    /** The owner making an agent's schedule theirs ("Make it mine", ORR-456): from then on it runs as them (a message
     * reaches the sessions, a session schedule starts one) and only they change it. `seen` is the `updated_at` they
     * read it at: one changed since is refused (409), so they never take on words they haven't seen. Theirs already,
     * it stays as it is. */
    async adopt(project: string, id: number, actor = AGENT, seen?: string): Promise<Schedule> {
        if (!actor.owner) throw refusedFor('schedules.adopt', `Making schedule ${id} yours: only the owner takes a schedule on; send Orrery-Actor: <owner>`)
        const row = await this.row(project, id)
        if (row.owned) return await this.get(project, id)
        if (seen !== undefined && seen !== row.updated_at) throw conflict(`Schedule ${id} changed after you read it: read it again, then make it yours`)
        await this.db.run('UPDATE schedules SET owned = 1, created_by = ?, updated_at = ? WHERE id = ? AND updated_at = ?', actor.name, new Date().toISOString(), id, row.updated_at)
        this.listeners = null
        this.onChange(project)
        const now = await this.get(project, id)
        if (!now.protected) throw conflict(`Schedule ${id} changed as you made it yours: read it again, then make it yours`)
        return now
    }

    /** The owner's schedules are theirs: an agent can't delete them. Its issues stay. */
    async delete(project: string, id: number, actor = AGENT) {
        const row = await this.row(project, id)
        if (row.owned && !actor.owner) throw refusedFor('schedules.owners', `Deleting schedule ${id}: it's the owner's; only they can delete it`)
        await this.db.run('DELETE FROM schedules WHERE id = ?', id)
        await this.db.run('UPDATE issues SET schedule = NULL WHERE schedule = ?', id)
        this.listeners = null
        this.onChange(project)
    }

    /** Runs what's due, each once, and says how many ran. */
    async runDue(now = new Date()): Promise<number> {
        const due = (await this.db.all<ScheduleRow>('SELECT * FROM schedules WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?', now.toISOString()))
        let ran = 0
        for (const row of due) {
            // Claimed by moving its next run on: if another server got there first, nothing changes here.
            if (!await this.claimNext(row, now)) continue
            await this.run(row, now, false)
            ran++
        }
        return ran + await this.catchUp(now)
    }

    /** Runs what an event schedule's minute held back (ORR-357): for each schedule whose minute is up, its oldest held
     * subject that still fits, so a burst goes through at one a minute and none is lost. Says how many ran. */
    private async catchUp(now: Date): Promise<number> {
        const held = await this.db.all<{schedule: number, subject: string, event: string}>('SELECT schedule, subject, event FROM schedule_held ORDER BY at, subject')
        let ran = 0
        const done = new Set<number>()
        for (const {schedule, subject, event: sent} of held) {
            if (done.has(schedule)) continue
            const row = await this.db.get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', schedule)
            // Switched off, what it held back goes: switched on again, it starts from what happens then.
            if (!row?.enabled || !row.on_event) {
                await this.db.run('DELETE FROM schedule_held WHERE schedule = ?', schedule)
                done.add(schedule)
                continue
            }
            if (await this.inCooldown(schedule, now)) {
                done.add(schedule)
                continue
            }
            // Claimed by taking it out: if another server got there first, nothing changes here.
            if (!(await this.db.run('DELETE FROM schedule_held WHERE schedule = ? AND subject = ?', schedule, subject)).changes) continue
            const event = await this.stillFits(row, JSON.parse(sent) as OrreryEvent)
            if (!event || await this.ranFor(schedule, subject)) continue
            done.add(schedule)
            await this.run(row, now, false, event)
            ran++
        }
        return ran
    }

    /** The held event as it stands now, when it still does what the schedule asks: an issue's status is read again, so
     * one that's left In review isn't reviewed, and an issue since deleted or moved away is dropped. */
    private async stillFits(row: ScheduleRow, event: OrreryEvent): Promise<OrreryEvent | null> {
        let current = event
        if (event.type.startsWith('issue.') && event.subject) {
            const issue = await this.store.issue(row.project, event.subject).catch(() => null)
            if (!issue) return null
            if (event.type === 'issue.status') current = {...event, to: issue.status}
        }
        return await this.fits(row, current) ? current : null
    }

    /** Whether it ran in the last minute: events in that time wait their turn, or count as one when they have no subject. */
    private async inCooldown(schedule: number, now: Date): Promise<boolean> {
        const last = await this.db.get<{at: string}>('SELECT at FROM schedule_runs WHERE schedule = ? ORDER BY id DESC LIMIT 1', schedule)
        return !!last && now.getTime() - new Date(last.at).getTime() < COOLDOWN
    }

    /** Whether a run did it for the subject. A run that was skipped or failed didn't, so a later event can. */
    private async ranFor(schedule: number, subject: string): Promise<boolean> {
        return !!await this.db.get("SELECT 1 FROM schedule_runs WHERE schedule = ? AND subject = ? AND outcome IN ('made', 'sent')", schedule, subject)
    }

    /** Runs it now, whatever its time, and even while the last run's issue is open; the owner's, only by them.
     * `instead` runs it in place of its next run, which is skipped (claimed as `runDue` claims one): a daily
     * 09:00 run at 07:00 next runs tomorrow at 09:00, and a one-off is done. */
    async runNow(project: string, id: number, actor = AGENT, instead = false): Promise<ScheduleRun> {
        const row = await this.row(project, id)
        if (row.owned && !actor.owner) throw refusedFor('schedules.owners', `Running schedule ${id}: it's the owner's; only they can run it`)
        if (!instead) return await this.run(row, new Date(), true)
        if (!row.enabled || !row.next_run) throw conflict(`Running schedule ${id} instead of its next run: it has none, so run it now`)
        const skipped = new Date(row.next_run)
        if (!await this.claimNext(row, skipped)) throw conflict(`Running schedule ${id} instead of its next run: that run has just started`)
        return await this.run(row, new Date(), true, undefined, `instead of ${day(skipped, row.timezone)} ${time(skipped, row.timezone)}`)
    }

    /** Takes its next run, moving it on to the one after `from` (a one-off is done): false when another server, or
     * another call, took it first. */
    private async claimNext(row: ScheduleRow, from: Date): Promise<boolean> {
        const next = row.at ? null : nextRun(row, from)
        return !!(await this.db.run('UPDATE schedules SET next_run = ?, enabled = ? WHERE id = ? AND next_run = ?', next, row.at ? 0 : 1, row.id, row.next_run)).changes
    }

    /** What `hear` is on: events are heard one at a time, so a burst of them can't each pass a schedule's checks
     * before any has recorded its run. */
    private hearing: Promise<unknown> = Promise.resolve()

    /** Runs the event schedules `event` is for, each once per subject and not within a minute of its last run; none when a
     * schedule's run (`cause`) did it, so one can't set another off, or itself, nor when an untrusted schedule's session
     * did, so what outsiders wrote can't start a session with the owner's permissions. Says how many ran. */
    hear(event: OrreryEvent, cause?: number, now = new Date()): Promise<number> {
        const heard = this.hearing.then(() => this.hearOne(event, cause, now))
        this.hearing = heard.catch(() => {})
        return heard
    }

    /** The event schedules switched on, `{project, on_event}`, as last read from the database they were read from: a
     * bulk edit makes hundreds of events, most for no schedule, and they're turned away without a query. Read again
     * once a schedule is made, changed or deleted. */
    private listeners: {db: Db, read: Promise<{project: string, on_event: string}[]>} | null = null

    private async eventSchedules(): Promise<{project: string, on_event: string}[]> {
        let listeners = this.listeners
        if (listeners?.db !== this.db) {
            const read = this.db.all<{project: string, on_event: string}>('SELECT project, on_event FROM schedules WHERE enabled = 1 AND on_event IS NOT NULL')
            listeners = this.listeners = {db: this.db, read}
            read.catch(() => {
                if (this.listeners?.read === read) this.listeners = null
            })
        }
        return await listeners.read
    }

    private async hearOne(event: OrreryEvent, cause: number | undefined, now: Date): Promise<number> {
        if (cause !== undefined || event.untrusted) return 0
        if (!(await this.eventSchedules()).some(s => (!event.project || s.project === event.project) && matchesType(s.on_event, event.type))) return 0
        const rows = await this.db.all<ScheduleRow>(`SELECT * FROM schedules WHERE enabled = 1 AND on_event IS NOT NULL${event.project ? ' AND project = ?' : ''}`,
            ...event.project ? [event.project] : [])
        let ran = 0
        for (const row of rows) {
            if (!matchesType(row.on_event ?? '', event.type) || !await this.fits(row, event)) continue
            if (event.subject && await this.ranFor(row.id, event.subject)) continue
            if (await this.inCooldown(row.id, now)) {
                // Its turn comes once the minute is up (`catchUp`); with no subject, it counts as the run just made.
                if (event.subject) {
                    await this.db.run(`INSERT INTO schedule_held (schedule, subject, event, at) VALUES (?, ?, ?, ?)
                        ON CONFLICT (schedule, subject) DO UPDATE SET event = excluded.event`, row.id, event.subject, JSON.stringify(event), now.toISOString())
                }
                continue
            }
            await this.run(row, now, false, event)
            ran++
        }
        return ran
    }

    /** Whether the event says what the schedule's `on_filter` asks for. */
    private async fits(row: ScheduleRow, event: OrreryEvent): Promise<boolean> {
        const filter = row.on_filter ? JSON.parse(row.on_filter) as OnFilter : {}
        if (filter.by && (!event.by || event.by.owner !== (filter.by === 'owner'))) return false
        if (filter.level && event.level !== filter.level) return false
        if (filter.to !== undefined && !await this.valueFits(event.type, event.to, filter.to, event.from)) return false
        if (filter.from !== undefined && !await this.valueFits(event.type, event.from, filter.from, event.to)) return false
        return true
    }

    /** A value fits as it is, as a status of the kind asked for (`done`), or as one a list gained (a label added) or
     * lost against `other`, the value on the change's far side. */
    private async valueFits(type: string, value: string | undefined, want: string, other: string | undefined): Promise<boolean> {
        if (value === undefined) return false
        if (value === want) return true
        if (type === 'issue.status' && KINDS.includes(want as never)) return (await this.store.status(value).catch(() => null))?.kind === want
        if (value.startsWith('[')) {
            const list = (raw: string | undefined) => raw?.startsWith('[') ? JSON.parse(raw) as unknown[] : []
            return list(value).includes(want) && !list(other).includes(want)
        }
        return false
    }

    /** Makes the issue and asks the sessions; the run is recorded whatever happens, its note ending with `aside`. What
     * it does runs no schedule. It's work of its own, so it may start a session even when an owner's answer that starts
     * none set it off (ORR-606). */
    private run(row: ScheduleRow, now: Date, manual: boolean, event?: OrreryEvent, aside?: string): Promise<ScheduleRun> {
        return startsNone.exit(() => scheduleRunning.run(row.id, () => this.runIt(row, now, manual, event, aside)))
    }

    private async runIt(row: ScheduleRow, now: Date, manual: boolean, event?: OrreryEvent, aside?: string): Promise<ScheduleRun> {
        const record = async (outcome: ScheduleRun['outcome'], issue: string | null, said: string | null): Promise<ScheduleRun> => {
            const note = [said, aside].filter(Boolean).join('; ') || null
            await this.db.run('INSERT INTO schedule_runs (schedule, at, outcome, issue, note, subject) VALUES (?, ?, ?, ?, ?, ?)',
                row.id, now.toISOString(), outcome, issue, note, event?.subject ?? null)
            this.onChange(row.project)
            const run = {at: now.toISOString(), outcome, issue: issue ?? undefined, note: note ?? undefined, ...event?.subject ? {subject: event.subject} : {}}
            // What came of it is told outside the run, so other schedules hear it (an alert on `*.failed`); not when
            // another run's outcome set this one off, so outcomes can't set each other off without end.
            if (event?.type.startsWith('schedule.')) this.onRan(row, run, manual)
            else scheduleRunning.exit(() => this.onRan(row, run, manual))
            return run
        }
        const actor: Actor = {name: row.created_by, owner: !!row.owned}
        // What it ran on, said by ids for the session to read with its tools, never another's words.
        const about = event ? aboutEvent(event) : null
        let presets: Preset[]
        try {
            presets = await this.store.presetsFor(row.project, JSON.parse(row.presets) as number[])
        } catch (error) {
            return await record('failed', null, error instanceof Error ? error.message : String(error))
        }
        const run: Run = {row, now, manual, event, actor, about, presets, record}
        return row.kind === 'session' ? await this.runSession(run) : row.kind === 'message' ? await this.runMessage(run) : row.kind === 'action' ? await this.runAction(run) : await this.runIssue(run)
    }

    /** A session schedule's run: starts a session with its presets and notes, on the issue or release it ran on. */
    private async runSession({row, event, actor, about, presets, record}: Run): Promise<ScheduleRun> {
        if (!actor.owner) return await record('skipped', null, 'made by an agent, so it starts no session')
        const subject = event?.subject && event.type !== 'issue.deleted' && event.type !== 'release.deleted' ? event.subject : undefined
        try {
            const {tmux} = await this.startSession(row.project, {
                presets: presets.map(p => p.id),
                instructions: [row.notes, about].filter(Boolean).join('\n\n'),
                ...subject && event?.type.startsWith('issue.') ? {issue: subject} : {},
                ...subject && event?.type.startsWith('release.') ? {release: subject} : {},
            }, actor)
            return await record('sent', null, `started a session (${tmux})`)
        } catch (error) {
            // No room, no launcher or no opt-in is a run that waits for another time, not a fault.
            const why = error instanceof Error ? error.message : String(error)
            return await record((error as {statusCode?: number}).statusCode === 409 ? 'skipped' : 'failed', null, why)
        }
    }

    /** A message schedule's run: its words to the project's listening sessions, or to a locked-down one of its own. */
    private async runMessage(run: Run): Promise<ScheduleRun> {
        const {row, manual, event, actor, presets, record} = run
        // Only the owner's signals reach sessions, as with every signal.
        if (!actor.owner) return await record('skipped', null, "made by an agent, so its message doesn't reach the sessions")
        if (row.only_if_changed && !manual && !event && !await this.changedSinceSent(row)) return await record('skipped', null, 'nothing changed')
        const words = wordsOf(run)
        if (row.untrusted) {
            // Never to the project's sessions: to one started for it, or nowhere.
            try {
                const {tmux} = await this.startUntrusted(row.project, row.id, words, actor)
                return await record('sent', null, `started a locked-down session for it (${tmux})`)
            } catch (error) {
                return await record('failed', null, `untrusted, so it needs a session of its own: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
        await this.store.message(row.project, row.id, words, actor, undefined, presets.map(p => p.name).join(', ') || undefined)
        const heard = this.listening(row.project)
        return await record('sent', null, heard ? `sent to ${heard} listening` : 'nobody listening; the next session to connect gets it')
    }

    /** An issue schedule's run: makes its issue, and asks the sessions to take it when it says to. */
    private async runIssue(run: Run): Promise<ScheduleRun> {
        const {row, now, manual, event, actor, record} = run
        if (row.skip_open && !manual) {
            const open = await this.lastOpenIssue(row)
            if (open) return await record('skipped', null, `${open} from the last run isn't done yet`)
        }
        const words = wordsOf(run)
        try {
            const issue = await this.store.createIssue(row.project, {
                title: `${row.title} · ${event ? event.subject ?? event.type : day(now, row.timezone)}`,
                ...words ? {notes: words} : {},
                ...row.chunk ? {chunk: row.chunk} : {},
                ...row.priority ? {priority: row.priority} : {},
                ...row.labels !== '[]' ? {labels: JSON.parse(row.labels) as string[]} : {},
                status: row.place,
            }, actor, {urgent: !row.ask})
            await this.db.run('UPDATE issues SET schedule = ? WHERE project = ? AND id = ?', row.id, row.project, issue.id)
            this.store.changed(row.project)
            let note: string | null = null
            if (row.ask) {
                await this.store.focus(row.project, issue.id, {note: `Scheduled: ${row.title}${row.priority === 'P0' ? ". It's urgent (P0)." : ''}`}, actor)
                note = actor.owner ? `asked the sessions (${this.listening(row.project)} listening)` : "made by an agent, so it didn't ask the sessions"
            }
            return await record('made', issue.id, note)
        } catch (error) {
            return await record('failed', null, error instanceof Error ? error.message : String(error))
        }
    }

    /** An action schedule's run: moves what its event is about to its status, as the owner, with no session. What it
     * passes over it says, and a run that moved nothing is `skipped`, so the subject's next event can still move it. */
    private async runAction({row, event, actor, about, record}: Run): Promise<ScheduleRun> {
        if (!actor.owner) return await record('skipped', null, 'made by an agent, so it moves nothing')
        if (!event?.subject) return await record('skipped', null, 'it moves what an event is about, and this run has no event')
        const to = await this.store.status(row.place).catch(() => null)
        if (!to) return await record('failed', null, `its status ${row.place} is gone`)
        const issues = await this.actionIssues(row, event).catch(() => null)
        if (!issues) return await record('skipped', null, `${event.subject} is gone`)
        if (!issues.length) return await record('skipped', null, `${event.type} on ${event.subject} has no issues to move`)
        const statuses = new Map((await this.store.statuses()).map(s => [s.id, s.name]))
        const moved: string[] = []
        const passed: string[] = []
        const failed: string[] = []
        for (const issue of issues) {
            const why = await this.passesOver(row, event, issue, to.id)
            if (why) {
                passed.push(`${issue.id} ${why}`)
                continue
            }
            try {
                await this.store.updateIssue(row.project, issue.id, {status: to.id}, actor)
                await this.store.systemNote(row.project, issue.id, [
                    `Moved from ${statuses.get(issue.column) ?? issue.column} to ${to.name} by the schedule "${row.title}". ${about ?? ''}`.trim(),
                    row.notes,
                ].filter(Boolean).join('\n\n'))
                moved.push(issue.id)
            } catch (error) {
                failed.push(`${issue.id}: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
        const said = [moved.length ? `moved ${moved.join(', ')} to ${to.name}` : '', ...passed, ...failed].filter(Boolean).join('; ')
        return await record(moved.length ? 'made' : failed.length ? 'failed' : 'skipped', moved.length === 1 ? moved[0] ?? null : null, said)
    }

    /** What an action schedule's event would move: a release's issues, at any depth (a parent follows its sub-issues, so
     * not it), or the issue itself. None for an event about anything else. It throws when the subject has gone. */
    private async actionIssues(row: ScheduleRow, event: OrreryEvent): Promise<Issue[]> {
        const subject = String(event.subject)
        if (event.type.startsWith('release.')) {
            const leaves = (issue: Issue): Issue[] => issue.tasks.length ? issue.tasks.filter(t => !t.release || t.release === subject).flatMap(leaves) : [issue]
            return (await this.store.release(row.project, subject)).tasks.flatMap(leaves)
        }
        return ['issue.', 'pr.', 'comment.'].some(thing => event.type.startsWith(thing)) ? [await this.store.issue(row.project, subject)] : []
    }

    /** Why an action schedule leaves this issue where it is, in a few words; none when it moves it. What waits on the
     * owner stays for them, and a closed issue stays closed unless `move_from` names its status. */
    private async passesOver(row: ScheduleRow, event: OrreryEvent, issue: Issue, to: string): Promise<string | null> {
        if (issue.column === to) return 'is there already'
        if (issue.tasks.length) return 'has sub-issues, and follows them'
        if (issue.proposal) return 'is a proposal'
        if (issue.waiting) return 'waits on the owner'
        const from = JSON.parse(row.move_from) as string[]
        const fits = from.length ? from.some(f => f === issue.column || f === issue.kind) : !CLOSED.includes(issue.kind as never)
        if (!fits) return `is in ${issue.column}`
        if (event.type.startsWith('pr.') && await this.db.get("SELECT 1 FROM pull_states WHERE merged = 0 AND closed = 0 AND names LIKE ?", `%"${issue.id}"%`)) return 'has another pull request open'
        return null
    }

    /** Whether an issue or comment in its project changed since its last sent run (or it never sent one). */
    private async changedSinceSent(row: ScheduleRow): Promise<boolean> {
        const sent = await this.db.get<{at: string}>("SELECT at FROM schedule_runs WHERE schedule = ? AND outcome = 'sent' ORDER BY id DESC LIMIT 1", row.id)
        if (!sent) return true
        const changed = await this.db.get<{at: string | null}>(`SELECT MAX(at) AS at FROM (
            SELECT MAX(updated_at) AS at FROM issues WHERE project = ? UNION ALL SELECT MAX(updated_at) FROM comments WHERE project = ?) AS changes`, row.project, row.project)
        return !!changed?.at && changed.at > sent.at
    }

    /** The issue from its last run, if that's still there and not done. */
    private async lastOpenIssue(row: ScheduleRow): Promise<string | null> {
        const last = await this.db.get<{issue: string}>("SELECT issue FROM schedule_runs WHERE schedule = ? AND outcome = 'made' ORDER BY id DESC LIMIT 1", row.id)
        if (!last?.issue) return null
        try {
            return CLOSED.includes((await this.store.issue(row.project, last.issue)).kind as never) ? null : last.issue
        } catch {
            return null
        }
    }

    /** The presets a message or session schedule is given, checked as its project's sessions can have them; none for an issue's. */
    private async presets(project: string, kind: Schedule['kind'], given: Input[string]): Promise<string> {
        if (kind === 'issue' || kind === 'action') return '[]'
        const ids = JSON.parse(String(given)) as number[]
        await this.store.presetsFor(project, ids)
        return JSON.stringify(ids)
    }

    /** What each kind needs: a message has words, its own or a preset's; a session is the owner's to start, as it works
     * as them; an action is too, and needs an event to move what it's about; only a message is untrusted. */
    private checkKind(kind: Schedule['kind'], notes: string | null, presets: string, untrusted: boolean, actor: Actor, on: string | null, orElse = '') {
        if (kind === 'message' && !notes?.trim() && presets === '[]') throw badRequest('A message schedule needs its message in "notes", or a preset in "presets"')
        if (kind === 'session' && !actor.owner) throw refusedFor('schedules.session', 'Only the owner makes a session schedule: it starts work as them; send Orrery-Actor: <owner>')
        if (kind === 'action' && !actor.owner) throw refusedFor('schedules.action', 'Only the owner makes an action schedule: it moves issues as them; send Orrery-Actor: <owner>')
        if (kind === 'action' && !on) throw badRequest('An action schedule moves what an event is about: send "on", not "cron" or "at"')
        if (untrusted && kind !== 'message') throw badRequest(`Only a message schedule is untrusted: send "kind": "message"${orElse}`)
    }

    /** The open status a schedule's issues start in, from an id or a kind; an action schedule's may be closed, as it's where it moves them. */
    private async place(column: Input[string], kind: Schedule['kind']): Promise<string> {
        const status = await this.store.status(await this.store.resolveStatus(column))
        if (kind !== 'action' && CLOSED.includes(status.kind)) throw badRequest(`A schedule's issues start open, not in ${status.name}`)
        return status.id
    }

    /** `move_from` as it's sent, checked and stored: statuses' ids or kinds, as a filter names them. */
    private async moveFrom(given: Input[string]): Promise<string> {
        const from = (given ?? []) as string[]
        for (const status of from) if (!KINDS.includes(status as never)) await this.store.status(status)
        return JSON.stringify([...new Set(from)])
    }

    private async row(project: string, id: number): Promise<ScheduleRow> {
        const row = (await this.db.get<ScheduleRow>('SELECT * FROM schedules WHERE project = ? AND id = ?', project, id))
        if (!row) throw notFound(`No schedule ${id} in ${project}`)
        return row
    }

    /** The chunk its issues go in, checked: its id, or one it had before. */
    private async chunk(project: string, chunk: unknown): Promise<string | null> {
        if (chunk === undefined || chunk === null || chunk === '') return null
        return (await this.store.chunk(project, String(chunk))).id
    }

    /** Exactly one of a cron (that parses), a time to run once (in the future, when `strict`) and an event, in a known zone. */
    private when(given: {cron: unknown, at: unknown, on: unknown, timezone: unknown}, strict: boolean): {cron: string | null, at: string | null, on: string | null, timezone: string} {
        const timezone = given.timezone ? String(given.timezone) : Intl.DateTimeFormat().resolvedOptions().timeZone
        try {
            new Intl.DateTimeFormat('en', {timeZone: timezone})
        } catch {
            throw badRequest(`"timezone" is "${timezone}", not a timezone orrery knows (e.g. Europe/Oslo)`)
        }
        const cron = given.cron ? String(given.cron).trim() : null
        const at = given.at ? String(given.at) : null
        const on = given.on ? String(given.on).trim() : null
        const either = 'Send one of "cron" (when it repeats), "at" (once) and "on" (an event)'
        if ([cron, at, on].filter(Boolean).length > 1) throw badRequest(either)
        if (on) {
            if (!EVENT_PATTERN.test(on)) throw badRequest(`"on" is "${on}"; use an event's type, with * for any part: issue.status, release.*, *.failed`)
            return {cron: null, at: null, on, timezone}
        }
        if (cron) {
            if (cron.split(/\s+/).length !== 5) throw badRequest(`"cron" is "${cron}"; use five fields: minute hour day month weekday, e.g. "0 9 * * 1-5"`)
            try {
                new Cron(cron, {timezone, paused: true, sloppyRanges: true})
            } catch (error) {
                throw badRequest(`"cron" is "${cron}": ${error instanceof Error ? error.message : error}`)
            }
            return {cron, at: null, on: null, timezone}
        }
        if (!at) throw badRequest(either)
        const time = new Date(at)
        if (Number.isNaN(time.getTime())) throw badRequest(`"at" is "${at}", not a time (e.g. 2026-10-26T09:00:00+01:00)`)
        if (strict && time.getTime() <= Date.now()) throw badRequest(`"at" is ${time.toISOString()}, which has passed`)
        return {cron: null, at: time.toISOString(), on: null, timezone}
    }

    private async scheduleOf(row: ScheduleRow): Promise<Schedule> {
        const runs = (await this.db.all<RunRow>('SELECT * FROM schedule_runs WHERE schedule = ? ORDER BY id DESC LIMIT ?', row.id, RUNS))
        const held = Number((await this.db.get<{n: number}>('SELECT count(*) AS n FROM schedule_held WHERE schedule = ?', row.id))?.n ?? 0)
        return {
            id: row.id, project: row.project, kind: row.kind, title: row.title, notes: row.notes ?? undefined,
            cron: row.cron ?? undefined, at: row.at ?? undefined, on: row.on_event ?? undefined,
            ...row.on_filter ? {on_filter: JSON.parse(row.on_filter) as OnFilter} : {}, presets: JSON.parse(row.presets) as number[], move_from: JSON.parse(row.move_from) as string[], timezone: row.timezone,
            column: row.place, chunk: row.chunk ?? undefined, priority: row.priority ?? undefined, labels: JSON.parse(row.labels) as string[],
            ask: !!row.ask, skip_open: !!row.skip_open, only_if_changed: !!row.only_if_changed, untrusted: !!row.untrusted, enabled: !!row.enabled, next_run: row.next_run ?? undefined,
            runs: runs.map(r => ({at: r.at, outcome: r.outcome, issue: r.issue ?? undefined, note: r.note ?? undefined, ...r.subject ? {subject: r.subject} : {}})),
            ...held ? {held} : {},
            created_by: row.created_by, protected: !!row.owned, created_at: row.created_at, updated_at: row.updated_at,
        }
    }
}

/** When it runs next after `from`: the cron's next time, or a one-off's time if that's still ahead. */
function nextRun(when: {cron: string | null, at: string | null, timezone: string}, from: Date): string | null {
    if (when.at) return new Date(when.at) > from ? when.at : null
    if (!when.cron) return null
    // `sloppyRanges` reads a step after a number (`5/10`) as croner 9 did, so a schedule saved with one still runs.
    return new Cron(when.cron, {timezone: when.timezone, paused: true, sloppyRanges: true}).nextRun(from)?.toISOString() ?? null
}

/** The day a run is for, as its issue's title ends: `Mon 26 Oct`. */
function day(at: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-GB', {timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short'}).format(at).replace(',', '')
}

/** The time of day a run is at, as `09:00`. */
function time(at: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-GB', {timeZone: timezone, hour: '2-digit', minute: '2-digit'}).format(at)
}

function text(value: unknown): string | null {
    return value === undefined || value === null || value === '' ? null : String(value)
}

/** The filter kept with an event schedule, as stored; none on a clock's. */
function filterOf(on: string | null, filter: unknown): string | null {
    return on && typeof filter === 'string' && filter !== '{}' ? filter : null
}

/** The changes whose values are ids or fixed words, so passing them on passes on nobody's text: a label or an
 * assignee is whatever an agent typed. */
const SAID_BY_ID = new Set(['issue.status', 'issue.priority', 'issue.chunk', 'issue.release', 'issue.parent', 'issue.proposal', 'issue.project', 'comment.asks'])

/** A name as a handle (`claude`, `ada_lovelace`): one with spaces or more could be words to a session. */
const HANDLE = /^[\w.-]{1,40}$/

/** What an event run was about, as its issue's description or message ends: the event, its subject and the change,
 * said by ids, since a session reads it as the owner's words. */
function aboutEvent(event: OrreryEvent): string {
    const change = SAID_BY_ID.has(event.type) && (event.from !== undefined || event.to !== undefined) ? ` (${event.from ?? 'none'} → ${event.to ?? 'none'})` : ''
    const by = !event.by ? '' : `, by ${event.by.owner ? 'the owner' : HANDLE.test(event.by.name) ? event.by.name : 'an agent'}`
    return `On ${event.type}${event.subject ? `: ${event.subject}` : ''}${change}${by}.`
}
