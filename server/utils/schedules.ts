// A project's schedules: recurring work Orrery starts on its own. At each time a schedule makes an issue
// in its project (marked with the schedule) and, with `ask`, points the project's listening Claude
// sessions at it. A run is skipped while the last one's issue is still open (`skipOpen`). The timer
// (server/plugins/schedules.ts) calls `runDue`; a run is claimed by moving `next_run` on first, so two
// servers (a reloading `nuxt dev`) can't run it twice, and after downtime a schedule runs once.
import {Cron} from 'croner'
import type {Place, Priority, Schedule, ScheduleRun} from '#shared/roadmap'
import {PLACES, PRIORITIES} from '#shared/roadmap'
import type {Field} from './input'
import {badRequest, checkInput, forbidden, notFound} from './input'
import type {Actor, Store} from './store'
import {AGENT} from './store'

interface ScheduleRow {
    id: number, project: string, title: string, notes: string | null, cron: string | null, at: string | null, timezone: string,
    place: Place, chunk: string | null, priority: Priority | null, labels: string, ask: number, skip_open: number, enabled: number,
    next_run: string | null, created_by: string, owned: number, created_at: string, updated_at: string
}
interface RunRow { id: number, schedule: number, at: string, outcome: ScheduleRun['outcome'], issue: string | null, note: string | null }

export const SCHEDULE_FIELDS: Record<string, Field> = {
    title: {type: 'string', required: true},
    notes: {type: 'string', nullable: true},
    /** Five fields (minute hour day month weekday), e.g. `0 9 * * 1-5`; or `at`, once. */
    cron: {type: 'string', nullable: true},
    at: {type: 'string', nullable: true},
    /** An IANA zone, e.g. `Europe/Oslo`; the server's when left out. */
    timezone: {type: 'string'},
    column: {type: 'string', values: PLACES},
    chunk: {type: 'string', nullable: true},
    priority: {type: 'string', values: PRIORITIES, nullable: true},
    labels: {type: 'strings', nullable: true},
    ask: {type: 'boolean'},
    skipOpen: {type: 'boolean'},
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
    list(project?: string): Schedule[] {
        if (project) this.store.project(project)
        const rows = project
            ? this.db.prepare('SELECT * FROM schedules WHERE project = ?').all(project) as unknown as ScheduleRow[]
            : this.db.prepare('SELECT * FROM schedules').all() as unknown as ScheduleRow[]
        return rows.map(row => this.scheduleOf(row))
            .sort((a, b) => (a.nextRun ?? '~').localeCompare(b.nextRun ?? '~') || a.title.localeCompare(b.title))
    }

    get(project: string, id: number): Schedule {
        return this.scheduleOf(this.row(project, id))
    }

    create(project: string, body: unknown, actor = AGENT): Schedule {
        this.store.project(project)
        const input = checkInput(body, SCHEDULE_FIELDS)
        const when = this.when({cron: input.cron, at: input.at, timezone: input.timezone}, true)
        const chunk = this.chunk(project, input.chunk)
        const now = new Date().toISOString()
        const enabled = input.enabled ?? true
        const {lastInsertRowid} = this.db.prepare(`INSERT INTO schedules (project, title, notes, cron, at, timezone, place, chunk, priority, labels, ask, skip_open, enabled,
            next_run, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            project, String(input.title).trim(), text(input.notes), when.cron, when.at, when.timezone, String(input.column ?? 'now'), chunk,
            text(input.priority), JSON.stringify(input.labels ?? []), Number(input.ask ?? false), Number(input.skipOpen ?? true), Number(enabled),
            enabled ? nextRun(when, new Date()) : null, actor.name, Number(actor.owner), now, now)
        this.onChange(project)
        return this.get(project, Number(lastInsertRowid))
    }

    /** Changing when it runs, or turning it back on, works out its next run again. */
    update(project: string, id: number, body: unknown): Schedule {
        const row = this.row(project, id)
        const input = checkInput(body, SCHEDULE_FIELDS, true)
        const timing = input.cron !== undefined || input.at !== undefined || input.timezone !== undefined
        const when = this.when({
            cron: input.cron !== undefined ? input.cron : input.at ? null : row.cron,
            at: input.at !== undefined ? input.at : input.cron ? null : row.at,
            timezone: input.timezone ?? row.timezone,
        }, timing)
        const enabled = input.enabled === undefined ? !!row.enabled : !!input.enabled
        const next = enabled && (timing || !row.enabled || !row.next_run) ? nextRun(when, new Date()) : enabled ? row.next_run : null
        const set: Record<string, unknown> = {
            title: input.title === undefined ? undefined : String(input.title).trim(),
            notes: input.notes === undefined ? undefined : text(input.notes),
            cron: when.cron, at: when.at, timezone: when.timezone,
            place: input.column,
            chunk: input.chunk === undefined ? undefined : this.chunk(project, input.chunk),
            priority: input.priority === undefined ? undefined : text(input.priority),
            labels: input.labels === undefined ? undefined : JSON.stringify(input.labels ?? []),
            ask: input.ask === undefined ? undefined : Number(input.ask),
            skip_open: input.skipOpen === undefined ? undefined : Number(input.skipOpen),
            enabled: Number(enabled),
            next_run: next,
            updated_at: new Date().toISOString(),
        }
        const fields = Object.entries(set).filter(([, v]) => v !== undefined)
        this.db.prepare(`UPDATE schedules SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...fields.map(([, v]) => v as string | number | null), id)
        this.onChange(project)
        return this.get(project, id)
    }

    /** The owner's schedules are theirs: an agent can't delete them. Its issues stay. */
    delete(project: string, id: number, actor = AGENT) {
        const row = this.row(project, id)
        if (row.owned && !actor.owner) throw forbidden(`Deleting schedule ${id}: it's the owner's; only they can delete it`)
        this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id)
        this.db.prepare('UPDATE issues SET schedule = NULL WHERE schedule = ?').run(id)
        this.onChange(project)
    }

    /** Runs what's due, each once, and says how many ran. */
    runDue(now = new Date()): number {
        const due = this.db.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?')
            .all(now.toISOString()) as unknown as ScheduleRow[]
        let ran = 0
        for (const row of due) {
            // Claimed by moving its next run on: if another server got there first, nothing changes here.
            const next = row.at ? null : nextRun(row, now)
            const claimed = this.db.prepare('UPDATE schedules SET next_run = ?, enabled = ? WHERE id = ? AND next_run = ?')
                .run(next, row.at ? 0 : 1, row.id, row.next_run).changes
            if (!claimed) continue
            this.run(row, now, false)
            ran++
        }
        return ran
    }

    /** Runs it now, whatever its time, and even while the last run's issue is open. */
    runNow(project: string, id: number): ScheduleRun {
        return this.run(this.row(project, id), new Date(), true)
    }

    /** Makes the issue and asks the sessions; the run is recorded whatever happens. */
    private run(row: ScheduleRow, now: Date, manual: boolean): ScheduleRun {
        const record = (outcome: ScheduleRun['outcome'], issue: string | null, note: string | null): ScheduleRun => {
            this.db.prepare('INSERT INTO schedule_runs (schedule, at, outcome, issue, note) VALUES (?, ?, ?, ?, ?)').run(row.id, now.toISOString(), outcome, issue, note)
            this.onChange(row.project)
            return {at: now.toISOString(), outcome, issue: issue ?? undefined, note: note ?? undefined}
        }
        if (row.skip_open && !manual) {
            const open = this.lastOpenIssue(row)
            if (open) return record('skipped', null, `${open} from the last run isn't done yet`)
        }
        const actor: Actor = {name: row.created_by, owner: !!row.owned}
        try {
            const issue = this.store.createIssue(row.project, {
                title: `${row.title} · ${day(now, row.timezone)}`,
                ...row.notes ? {notes: row.notes} : {},
                ...row.chunk ? {chunk: row.chunk} : {},
                ...row.priority ? {priority: row.priority} : {},
                ...row.labels !== '[]' ? {labels: JSON.parse(row.labels) as string[]} : {},
                ...row.place === 'doing' ? {status: 'doing'} : row.place === 'backlog' ? {} : {plan: row.place},
            }, actor)
            this.db.prepare('UPDATE issues SET schedule = ? WHERE project = ? AND id = ?').run(row.id, row.project, issue.id)
            this.store.changed(row.project)
            let note: string | null = null
            if (row.ask) {
                this.store.focus(row.project, issue.id, {note: `Scheduled: ${row.title}`}, actor)
                note = actor.owner ? `asked the sessions (${this.listening(row.project)} listening)` : "made by an agent, so it didn't ask the sessions"
            }
            return record('made', issue.id, note)
        } catch (error) {
            return record('failed', null, error instanceof Error ? error.message : String(error))
        }
    }

    /** The issue from its last run, if that's still there and not done. */
    private lastOpenIssue(row: ScheduleRow): string | null {
        const last = this.db.prepare("SELECT issue FROM schedule_runs WHERE schedule = ? AND outcome = 'made' ORDER BY id DESC LIMIT 1").get(row.id) as {issue: string} | undefined
        if (!last?.issue) return null
        try {
            return this.store.issue(row.project, last.issue).column === 'done' ? null : last.issue
        } catch {
            return null
        }
    }

    private row(project: string, id: number): ScheduleRow {
        const row = this.db.prepare('SELECT * FROM schedules WHERE project = ? AND id = ?').get(project, id) as ScheduleRow | undefined
        if (!row) throw notFound(`No schedule ${id} in ${project}`)
        return row
    }

    /** The chunk its issues go in, checked: its id, or one it had before. */
    private chunk(project: string, chunk: unknown): string | null {
        if (chunk === undefined || chunk === null || chunk === '') return null
        return this.store.chunk(project, String(chunk)).id
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
        if (!cron === !at) throw badRequest('Send "cron" (when it repeats) or "at" (once), not both or neither')
        if (cron) {
            if (cron.split(/\s+/).length !== 5) throw badRequest(`"cron" is "${cron}"; use five fields: minute hour day month weekday, e.g. "0 9 * * 1-5"`)
            try {
                new Cron(cron, {timezone, paused: true})
            } catch (error) {
                throw badRequest(`"cron" is "${cron}": ${error instanceof Error ? error.message : error}`)
            }
            return {cron, at: null, timezone}
        }
        const time = new Date(at!)
        if (Number.isNaN(time.getTime())) throw badRequest(`"at" is "${at}", not a time (e.g. 2026-10-26T09:00:00+01:00)`)
        if (strict && time.getTime() <= Date.now()) throw badRequest(`"at" is ${time.toISOString()}, which has passed`)
        return {cron: null, at: time.toISOString(), timezone}
    }

    private scheduleOf(row: ScheduleRow): Schedule {
        const runs = this.db.prepare('SELECT * FROM schedule_runs WHERE schedule = ? ORDER BY id DESC LIMIT ?').all(row.id, RUNS) as unknown as RunRow[]
        return {
            id: row.id, project: row.project, title: row.title, notes: row.notes ?? undefined,
            cron: row.cron ?? undefined, at: row.at ?? undefined, timezone: row.timezone,
            column: row.place, chunk: row.chunk ?? undefined, priority: row.priority ?? undefined, labels: JSON.parse(row.labels) as string[],
            ask: !!row.ask, skipOpen: !!row.skip_open, enabled: !!row.enabled, nextRun: row.next_run ?? undefined,
            runs: runs.map(r => ({at: r.at, outcome: r.outcome, issue: r.issue ?? undefined, note: r.note ?? undefined})),
            createdBy: row.created_by, protected: !!row.owned, createdAt: row.created_at, updatedAt: row.updated_at,
        }
    }
}

/** When it runs next after `from`: the cron's next time, or a one-off's time if that's still ahead. */
export function nextRun(when: {cron: string | null, at: string | null, timezone: string}, from: Date): string | null {
    if (when.at) return new Date(when.at) > from ? when.at : null
    return new Cron(when.cron!, {timezone: when.timezone, paused: true}).nextRun(from)?.toISOString() ?? null
}

/** The day a run is for, as its issue's title ends: `Mon 26 Oct`. */
function day(at: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-GB', {timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short'}).format(at).replace(',', '')
}

function text(value: unknown): string | null {
    return value === undefined || value === null || value === '' ? null : String(value)
}
