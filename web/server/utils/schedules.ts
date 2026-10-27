// A project's schedules: recurring work Orrery starts on its own. At each time a schedule makes an issue
// in its project (marked with the schedule) and, with `ask`, points the project's listening Claude
// sessions at it; or, as a `message` schedule, sends its message to the sessions with no issue. An issue
// run is skipped while the last one's issue is still open (`skip_open`), a message run when nothing in the
// project changed since the last one sent (`only_if_changed`). The timer
// (server/plugins/schedules.ts) calls `runDue`; a run is claimed by moving `next_run` on first, so two
// servers (a reloading `nuxt dev`) can't run it twice, and after downtime a schedule runs once.
import {Cron} from 'croner'
import type {Priority, Schedule, ScheduleRun} from '#shared/roadmap'
import {CLOSED, PRIORITIES} from '#shared/roadmap'
import {one} from './database'
import type {Field, Input} from './input'
import {badRequest, checkInput, forbidden, notFound} from './input'
import type {Actor, Store} from './store'
import {AGENT} from './store'

interface ScheduleRow {
    id: number, project: string, kind: 'issue' | 'message', title: string, notes: string | null, cron: string | null, at: string | null, timezone: string,
    place: string, chunk: string | null, priority: Priority | null, labels: string, ask: number, skip_open: number, only_if_changed: number, enabled: number,
    next_run: string | null, created_by: string, owned: number, created_at: string, updated_at: string
}
interface RunRow { id: number, schedule: number, at: string, outcome: ScheduleRun['outcome'], issue: string | null, note: string | null }

const SCHEDULE_FIELDS: Record<string, Field> = {
    /** `issue` (the default) makes an issue each run; `message` sends `notes` to the sessions instead. */
    kind: {type: 'string', values: ['issue', 'message']},
    title: {type: 'string', required: true},
    notes: {type: 'string', nullable: true},
    /** Five fields (minute hour day month weekday), e.g. `0 9 * * 1-5`; or `at`, once. */
    cron: {type: 'string', nullable: true},
    at: {type: 'string', nullable: true},
    /** An IANA zone, e.g. `Europe/Oslo`; the server's when left out. */
    timezone: {type: 'string'},
    /** Where its issues start: an open status's id, or a kind (`todo`). */
    column: {type: 'string'},
    chunk: {type: 'string', nullable: true},
    priority: {type: 'string', values: PRIORITIES, nullable: true},
    labels: {type: 'strings', nullable: true},
    ask: {type: 'boolean'},
    skip_open: {type: 'boolean'},
    /** A message schedule skips a run when no issue or comment in the project changed since the last one it sent. */
    only_if_changed: {type: 'boolean'},
    enabled: {type: 'boolean'},
}

/** How many runs a schedule shows. */
const RUNS = 10

export class Schedules {
    /** `onChange` hears a project's schedules changed or ran; `listening` says how many sessions a project has listening. */
    constructor(
        private readonly store: Store,
        private readonly onChange: (project: string) => void = () => {},
        private readonly listening: (project: string) => number = () => 0,
    ) {}

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
        await this.store.project(project)
        const input = checkInput(body, SCHEDULE_FIELDS)
        const when = this.when({cron: input.cron, at: input.at, timezone: input.timezone}, true)
        const chunk = await this.chunk(project, input.chunk)
        const now = new Date().toISOString()
        const enabled = input.enabled ?? true
        const kind = String(input.kind ?? 'issue')
        if (kind === 'message' && !text(input.notes)?.trim()) throw badRequest('A message schedule needs its message in "notes"')
        const {id} = await one<{id: number}>(this.db, `INSERT INTO schedules (project, kind, title, notes, cron, at, timezone, place, chunk, priority, labels, ask, skip_open, only_if_changed,
            enabled, next_run, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            project, kind, String(input.title).trim(), text(input.notes), when.cron, when.at, when.timezone, await this.place(input.column ?? 'todo'), chunk,
            text(input.priority), JSON.stringify(input.labels ?? []), Number(input.ask ?? false), Number(input.skip_open ?? true), Number(input.only_if_changed ?? false), Number(enabled),
            enabled ? nextRun(when, new Date()) : null, actor.name, Number(actor.owner), now, now)
        this.onChange(project)
        return await this.get(project, id)
    }

    /** Changing when it runs, or turning it back on, works out its next run again. The owner's schedules are
     * theirs: what one says runs as them, so only they change it. */
    async update(project: string, id: number, body: unknown, actor = AGENT): Promise<Schedule> {
        const row = await this.row(project, id)
        if (row.owned && !actor.owner) throw forbidden(`Changing schedule ${id}: it's the owner's; only they can change it`)
        const input = checkInput(body, SCHEDULE_FIELDS, true)
        const timing = input.cron !== undefined || input.at !== undefined || input.timezone !== undefined
        const when = this.when({
            cron: input.cron !== undefined ? input.cron : input.at ? null : row.cron,
            at: input.at !== undefined ? input.at : input.cron ? null : row.at,
            timezone: input.timezone ?? row.timezone,
        }, timing)
        const enabled = input.enabled === undefined ? !!row.enabled : !!input.enabled
        const next = enabled && (timing || !row.enabled || !row.next_run) ? nextRun(when, new Date()) : enabled ? row.next_run : null
        const kind = String(input.kind ?? row.kind)
        const message = input.notes === undefined ? row.notes : text(input.notes)
        if (kind === 'message' && !message?.trim()) throw badRequest('A message schedule needs its message in "notes"')
        const set: Record<string, unknown> = {
            kind: input.kind,
            title: input.title === undefined ? undefined : String(input.title).trim(),
            notes: input.notes === undefined ? undefined : text(input.notes),
            cron: when.cron, at: when.at, timezone: when.timezone,
            place: input.column === undefined ? undefined : await this.place(input.column),
            chunk: input.chunk === undefined ? undefined : await this.chunk(project, input.chunk),
            priority: input.priority === undefined ? undefined : text(input.priority),
            labels: input.labels === undefined ? undefined : JSON.stringify(input.labels ?? []),
            ask: input.ask === undefined ? undefined : Number(input.ask),
            skip_open: input.skip_open === undefined ? undefined : Number(input.skip_open),
            only_if_changed: input.only_if_changed === undefined ? undefined : Number(input.only_if_changed),
            enabled: Number(enabled),
            next_run: next,
            updated_at: new Date().toISOString(),
        }
        const fields = Object.entries(set).filter(([, v]) => v !== undefined)
        await this.db.run(`UPDATE schedules SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, ...fields.map(([, v]) => v as string | number | null), id)
        this.onChange(project)
        return await this.get(project, id)
    }

    /** The owner's schedules are theirs: an agent can't delete them. Its issues stay. */
    async delete(project: string, id: number, actor = AGENT) {
        const row = await this.row(project, id)
        if (row.owned && !actor.owner) throw forbidden(`Deleting schedule ${id}: it's the owner's; only they can delete it`)
        await this.db.run('DELETE FROM schedules WHERE id = ?', id)
        await this.db.run('UPDATE issues SET schedule = NULL WHERE schedule = ?', id)
        this.onChange(project)
    }

    /** Runs what's due, each once, and says how many ran. */
    async runDue(now = new Date()): Promise<number> {
        const due = (await this.db.all<ScheduleRow>('SELECT * FROM schedules WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?', now.toISOString()))
        let ran = 0
        for (const row of due) {
            // Claimed by moving its next run on: if another server got there first, nothing changes here.
            const next = row.at ? null : nextRun(row, now)
            const claimed = (await this.db.run('UPDATE schedules SET next_run = ?, enabled = ? WHERE id = ? AND next_run = ?', next, row.at ? 0 : 1, row.id, row.next_run)).changes
            if (!claimed) continue
            await this.run(row, now, false)
            ran++
        }
        return ran
    }

    /** Runs it now, whatever its time, and even while the last run's issue is open; the owner's, only by them. */
    async runNow(project: string, id: number, actor = AGENT): Promise<ScheduleRun> {
        const row = await this.row(project, id)
        if (row.owned && !actor.owner) throw forbidden(`Running schedule ${id}: it's the owner's; only they can run it`)
        return await this.run(row, new Date(), true)
    }

    /** Makes the issue and asks the sessions; the run is recorded whatever happens. */
    private async run(row: ScheduleRow, now: Date, manual: boolean): Promise<ScheduleRun> {
        const record = async (outcome: ScheduleRun['outcome'], issue: string | null, note: string | null): Promise<ScheduleRun> => {
            await this.db.run('INSERT INTO schedule_runs (schedule, at, outcome, issue, note) VALUES (?, ?, ?, ?, ?)', row.id, now.toISOString(), outcome, issue, note)
            this.onChange(row.project)
            return {at: now.toISOString(), outcome, issue: issue ?? undefined, note: note ?? undefined}
        }
        const actor: Actor = {name: row.created_by, owner: !!row.owned}
        if (row.kind === 'message') {
            // Only the owner's signals reach sessions, as with every signal.
            if (!actor.owner) return await record('skipped', null, "made by an agent, so its message doesn't reach the sessions")
            if (row.only_if_changed && !manual && !await this.changedSinceSent(row)) return await record('skipped', null, 'nothing changed')
            await this.store.message(row.project, row.id, row.notes ?? row.title, actor)
            const heard = this.listening(row.project)
            return await record('sent', null, heard ? `sent to ${heard} listening` : 'nobody listening; the next session to connect gets it')
        }
        if (row.skip_open && !manual) {
            const open = await this.lastOpenIssue(row)
            if (open) return await record('skipped', null, `${open} from the last run isn't done yet`)
        }
        try {
            const issue = await this.store.createIssue(row.project, {
                title: `${row.title} · ${day(now, row.timezone)}`,
                ...row.notes ? {notes: row.notes} : {},
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

    /** The open status a schedule's issues start in, from an id or a kind. */
    private async place(column: Input[string]): Promise<string> {
        const status = await this.store.status(await this.store.resolveStatus(column))
        if (CLOSED.includes(status.kind)) throw badRequest(`A schedule's issues start open, not in ${status.name}`)
        return status.id
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

    /** Exactly one of a cron (that parses) and a time to run once (in the future, when `strict`), in a known zone. */
    private when(given: {cron: unknown, at: unknown, timezone: unknown}, strict: boolean): {cron: string | null, at: string | null, timezone: string} {
        const timezone = given.timezone ? String(given.timezone) : Intl.DateTimeFormat().resolvedOptions().timeZone
        try {
            new Intl.DateTimeFormat('en', {timeZone: timezone})
        } catch {
            throw badRequest(`"timezone" is "${timezone}", not a timezone Orrery knows (e.g. Europe/Oslo)`)
        }
        const cron = given.cron ? String(given.cron).trim() : null
        const at = given.at ? String(given.at) : null
        const either = 'Send "cron" (when it repeats) or "at" (once), not both or neither'
        if (cron && at) throw badRequest(either)
        if (cron) {
            if (cron.split(/\s+/).length !== 5) throw badRequest(`"cron" is "${cron}"; use five fields: minute hour day month weekday, e.g. "0 9 * * 1-5"`)
            try {
                new Cron(cron, {timezone, paused: true, sloppyRanges: true})
            } catch (error) {
                throw badRequest(`"cron" is "${cron}": ${error instanceof Error ? error.message : error}`)
            }
            return {cron, at: null, timezone}
        }
        if (!at) throw badRequest(either)
        const time = new Date(at)
        if (Number.isNaN(time.getTime())) throw badRequest(`"at" is "${at}", not a time (e.g. 2026-10-26T09:00:00+01:00)`)
        if (strict && time.getTime() <= Date.now()) throw badRequest(`"at" is ${time.toISOString()}, which has passed`)
        return {cron: null, at: time.toISOString(), timezone}
    }

    private async scheduleOf(row: ScheduleRow): Promise<Schedule> {
        const runs = (await this.db.all<RunRow>('SELECT * FROM schedule_runs WHERE schedule = ? ORDER BY id DESC LIMIT ?', row.id, RUNS))
        return {
            id: row.id, project: row.project, kind: row.kind, title: row.title, notes: row.notes ?? undefined,
            cron: row.cron ?? undefined, at: row.at ?? undefined, timezone: row.timezone,
            column: row.place, chunk: row.chunk ?? undefined, priority: row.priority ?? undefined, labels: JSON.parse(row.labels) as string[],
            ask: !!row.ask, skip_open: !!row.skip_open, only_if_changed: !!row.only_if_changed, enabled: !!row.enabled, next_run: row.next_run ?? undefined,
            runs: runs.map(r => ({at: r.at, outcome: r.outcome, issue: r.issue ?? undefined, note: r.note ?? undefined})),
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

function text(value: unknown): string | null {
    return value === undefined || value === null || value === '' ? null : String(value)
}
