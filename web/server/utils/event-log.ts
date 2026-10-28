// The event log (ORR-322): what Orrery did and what went wrong, kept in its own `events` table and never sent off
// the machine. Errors are recorded always; warnings, what Orrery did (sessions, launchers, schedules, backups,
// migrations) and the changes to the roadmap (ORR-378: issues, comments, chunks, docs, releases) only while the owner
// has Advanced on in App settings, as most never look. Each is a row of its own, as the owner reads it line by line
// (ORR-378); a repeat of an error that isn't resolved is no news, to the bell or the schedules, and resolving one
// resolves its repeats. Old rows go: info after a week, the rest after a month, and past MAX_ROWS (MAX_ACTIVITY for
// the roadmap's, so a busy day can't push errors out) the oldest, so a loop can't fill the database.
import type {OrreryEvent} from '#shared/happenings'
import type {EventLevel, LoggedEvent} from '#shared/roadmap'
import {ACTIVITY_FAMILIES, EVENT_LEVELS} from '#shared/roadmap'
import type {Db} from './database'
import {badRequest, notFound} from './input'

/** What's recorded: `details` is kept as JSON, each text in it cut to a few thousand characters. */
export interface EventEntry {
    level: EventLevel
    kind: string
    project?: string | null
    message: string
    details?: Record<string, unknown>
    /** About what an untrusted schedule's session did (a write of its refused): no schedule hears it. */
    untrusted?: boolean
}

export interface EventFilter {
    /** One level or several, comma-separated. */
    level?: string
    /** A kind, or what it starts with up to a dot: `session` is every `session.…`. */
    kind?: string
    project?: string
    /** What a change to the roadmap was to: an issue's id, a release's version. */
    subject?: string
    /** Only those seen since this time. */
    since?: string
    /** Unresolved ones only. */
    open?: boolean
    limit?: number
}

interface EventRow {
    id: number
    level: EventLevel
    kind: string
    project: string | null
    subject: string | null
    message: string
    details: string | null
    count: number
    first_seen: string
    last_seen: string
    resolved_at: string | null
}

const DAY = 24 * 60 * 60 * 1000
/** How long what Orrery did is kept, and how long warnings and errors are. */
export const KEEP_INFO = 7 * DAY
export const KEEP_PROBLEMS = 30 * DAY
/** The most rows kept, the oldest going first: of changes to the roadmap, and of the rest. */
const MAX_ROWS = 5000
const MAX_ACTIVITY = 5000
/** How often (in rows written) old ones are pruned, besides on start. */
const PRUNE_EVERY = 200
const MESSAGE = 1000
const TEXT = 4000
const KIND = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/
/** Whether a row is a change to the roadmap, in SQL: a family's names don't hold `_` or `%`. */
const ACTIVITY = `(${ACTIVITY_FAMILIES.map(family => `kind LIKE '${family}.%'`).join(' OR ')})`

export class EventLog {
    /** `scrub` takes secrets' values out of what's kept; `onLogged` hears each event written, `fresh` when it's a row of its own. */
    constructor(
        /** Changed only when the owner moves the database (`rebindDatabase`). */
        public db: Db,
        /** What takes secrets' values out of a text, made once and kept until `forget`. */
        private readonly scrubber: () => Promise<(text: string) => string> = async () => text => text,
        private readonly onLogged: (event: LoggedEvent, fresh: boolean) => void = () => {},
        private readonly now: () => Date = () => new Date(),
    ) {}

    private written = 0

    /** Hears each kind as it happens, for the schedules that run on it (`backup.failed`, `session.started`): every
     * time when it isn't kept, and only a new one when it is (a repeat of an open error isn't news). The server sets it. */
    happened: (event: OrreryEvent) => void = () => {}

    /** Advanced and the scrubber, as last read: each event would otherwise read the setting and open every secret,
     * and some come often (`backup.made`). The server forgets them when the settings or secrets change. */
    private known: {db: Db, advanced?: Promise<boolean>, scrub?: Promise<(text: string) => string>} | null = null

    /** Reads Advanced and the secrets again on the next event. */
    forget() {
        this.known = null
    }

    /** Whether the owner has Advanced on, so more than errors is recorded. */
    advanced(): Promise<boolean> {
        const known = this.read()
        known.advanced ??= this.db.get<{value: string}>("SELECT value FROM settings WHERE key = 'advanced'")
            .then(row => row ? JSON.parse(row.value) === true : false)
        return this.kept(known.advanced)
    }

    private scrub(): Promise<(text: string) => string> {
        const known = this.read()
        known.scrub ??= this.scrubber()
        return this.kept(known.scrub)
    }

    /** What's known of the database it's on now (a moved one starts afresh). */
    private read() {
        if (this.known?.db !== this.db) this.known = {db: this.db}
        return this.known
    }

    /** `read`, forgotten when it fails, so the next event tries again. */
    private kept<T>(read: Promise<T>): Promise<T> {
        return read.catch(error => {
            this.forget()
            throw error
        })
    }

    /** Records it, a row of its own; null when it isn't kept (Advanced is off and it's no error). */
    async record(entry: EventEntry): Promise<LoggedEvent | null> {
        if (!EVENT_LEVELS.includes(entry.level)) throw badRequest(`"level" is "${entry.level}"; use ${EVENT_LEVELS.join(', ')}`)
        if (!KIND.test(entry.kind)) throw badRequest(`"kind" is "${entry.kind}"; use a dotted name, e.g. page.error`)
        if (entry.level !== 'error' && !await this.advanced()) {
            this.happened({type: entry.kind, level: entry.level, ...entry.project ? {project: entry.project} : {}, ...entry.untrusted ? {untrusted: true} : {}})
            return null
        }
        const scrub = await this.scrub()
        const message = cut(redact(scrub(entry.message.trim() || entry.kind)), MESSAGE)
        const details = entry.details ? JSON.stringify(clean(entry.details, scrub)) : null
        const project = entry.project || null
        const at = this.now().toISOString()
        // A repeat of one not resolved yet (same level, kind, project and message) is a line too, but no news.
        const again = !!await this.db.get(`SELECT id FROM events WHERE level = ? AND kind = ? AND coalesce(project, '') = ? AND message = ?
            AND resolved_at IS NULL LIMIT 1`, entry.level, entry.kind, project ?? '', message)
        const row = await this.db.get<EventRow>(`INSERT INTO events (level, kind, project, message, details, count, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?) RETURNING *`, entry.level, entry.kind, project, message, details, at, at)
        if (!row) return null
        if (++this.written % PRUNE_EVERY === 0) await this.prune()
        const event = eventOf(row)
        this.onLogged(event, !again)
        // Its message isn't passed on: an error's can hold what a page or another site sent. Its row is, to read.
        // What Orrery did is passed on each time: each is news.
        if (!again || entry.level === 'info') this.happened({type: entry.kind, level: entry.level, subject: `event ${row.id}`, ...project ? {project} : {}, ...entry.untrusted ? {untrusted: true} : {}})
        return event
    }

    /** Records it, saying so on the console rather than failing when it can't: logging never breaks what it logs. */
    note(entry: EventEntry) {
        this.record(entry).catch(error => console.error(`[orrery] logging ${entry.kind}:`, error))
    }

    /** Records a change to the roadmap, as the store says it (`issue.status`, `release.frozen`), while Advanced is on:
     * a row each, never folded. `cause` is the schedule whose run made it. The schedules heard it from the store already. */
    async activity(event: OrreryEvent, cause?: number): Promise<LoggedEvent | null> {
        if (!KIND.test(event.type) || !await this.advanced()) return null
        const scrub = await this.scrub()
        const message = cut(redact(scrub(describe(event))), MESSAGE)
        const details = clean({
            ...event.by ? {by: event.by.name, owner: event.by.owner} : {},
            ...event.from === undefined ? {} : {from: event.from},
            ...event.to === undefined ? {} : {to: event.to},
            ...event.untrusted ? {untrusted: true} : {},
            ...cause === undefined ? {} : {schedule: cause},
        }, scrub) as Record<string, unknown>
        const at = this.now().toISOString()
        const row = await this.db.get<EventRow>(`INSERT INTO events (level, kind, project, subject, message, details, count, first_seen, last_seen)
            VALUES ('info', ?, ?, ?, ?, ?, 1, ?, ?) RETURNING *`, event.type, event.project ?? null, event.subject ?? null, message,
            Object.keys(details).length ? JSON.stringify(details) : null, at, at)
        if (!row) return null
        if (++this.written % PRUNE_EVERY === 0) await this.prune()
        const logged = eventOf(row)
        this.onLogged(logged, true)
        return logged
    }

    /** Newest first (by when they were last seen). */
    async list(filter: EventFilter = {}): Promise<LoggedEvent[]> {
        const where: string[] = []
        const params: string[] = []
        if (filter.level) {
            const levels = filter.level.split(',').map(l => l.trim()).filter(Boolean)
            const wrong = levels.find(l => !EVENT_LEVELS.includes(l as EventLevel))
            if (wrong) throw badRequest(`"level" has "${wrong}"; use ${EVENT_LEVELS.join(', ')}`)
            if (levels.length) {
                where.push(`level IN (${levels.map(() => '?').join(', ')})`)
                params.push(...levels)
            }
        }
        if (filter.kind) {
            where.push("(kind = ? OR kind LIKE ? ESCAPE '\\')")
            params.push(filter.kind, `${filter.kind.replace(/[\\%_]/g, '\\$&')}.%`)
        }
        if (filter.project) {
            where.push('project = ?')
            params.push(filter.project)
        }
        if (filter.subject) {
            where.push('subject = ?')
            params.push(filter.subject)
        }
        if (filter.since) {
            const since = new Date(filter.since)
            if (Number.isNaN(since.getTime())) throw badRequest(`"since" is "${filter.since}", not a time (e.g. 2026-10-27T09:00:00Z)`)
            where.push('last_seen >= ?')
            params.push(since.toISOString())
        }
        if (filter.open) where.push('resolved_at IS NULL')
        const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 200)), 1000)
        const rows = await this.db.all<EventRow>(`SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY last_seen DESC, id DESC LIMIT ${limit}`, ...params)
        return rows.map(eventOf)
    }

    /** Marks it dealt with, and its repeats not resolved yet: the next one like it is news again. */
    async resolve(id: number): Promise<LoggedEvent> {
        const at = this.now().toISOString()
        const row = await this.db.get<EventRow>('UPDATE events SET resolved_at = coalesce(resolved_at, ?) WHERE id = ? RETURNING *', at, id)
        if (!row) throw notFound(`No event ${id}`)
        const repeats = await this.db.all<EventRow>(`UPDATE events SET resolved_at = ? WHERE resolved_at IS NULL AND level = ? AND kind = ?
            AND coalesce(project, '') = ? AND message = ? RETURNING *`, at, row.level, row.kind, row.project ?? '', row.message)
        for (const repeat of repeats) this.onLogged(eventOf(repeat), false)
        const event = eventOf(row)
        this.onLogged(event, false)
        return event
    }

    /** Lets go of what's old: info after KEEP_INFO, the rest after KEEP_PROBLEMS, and the oldest past MAX_ACTIVITY
     * changes to the roadmap and past MAX_ROWS of the rest, so many changes can't push an error out. */
    async prune(): Promise<number> {
        const now = this.now().getTime()
        const info = await this.db.run("DELETE FROM events WHERE level = 'info' AND last_seen < ?", new Date(now - KEEP_INFO).toISOString())
        const rest = await this.db.run("DELETE FROM events WHERE level <> 'info' AND last_seen < ?", new Date(now - KEEP_PROBLEMS).toISOString())
        let over = 0
        for (const [which, most] of [[ACTIVITY, MAX_ACTIVITY], [`NOT ${ACTIVITY}`, MAX_ROWS]] as const) {
            over += (await this.db.run(`DELETE FROM events WHERE ${which} AND id NOT IN
                (SELECT id FROM events WHERE ${which} ORDER BY last_seen DESC, id DESC LIMIT ${most})`)).changes
        }
        return info.changes + rest.changes + over
    }
}

/** Its texts cut short and with no secret in them, any depth down. */
function clean(value: unknown, scrub: (text: string) => string, depth = 0): unknown {
    if (typeof value === 'string') return cut(redact(scrub(value)), TEXT)
    if (depth > 4 || value === null || typeof value !== 'object') return typeof value === 'bigint' ? Number(value) : value
    if (Array.isArray(value)) return value.slice(0, 50).map(v => clean(v, scrub, depth + 1))
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([k, v]) => [k, clean(v, scrub, depth + 1)]))
}

/** A request the server refused (403: not theirs to do, e.g. an untrusted session's write, a proposal's move or the
 * owner's own; 409: not now, e.g. an issue another session is on) as a warning: who asked, the route without its
 * query, and why. Null for what isn't one, and for a start the launches route logs itself (`session.refused`). */
export function refusal(status: number, method: string, path: string, message: string, actor?: string): EventEntry | null {
    if (status !== 403 && status !== 409) return null
    const route = path.split('?')[0] ?? path
    if (status === 409 && method === 'POST' && /^\/api\/projects\/[^/]+\/launches\/?$/.test(route)) return null
    const project = /^\/api\/projects\/([^/]+)/.exec(route)?.[1]
    return {
        level: 'warn', kind: 'request.refused', ...project ? {project: decodeURIComponent(project)} : {},
        message: `Refused ${actor || 'agent'} ${method} ${route}: ${message}`,
        details: {route: `${method} ${route}`, status, by: actor || 'agent'},
    }
}

/** Passwords in addresses (`postgres://me:…@host`) and bearer tokens, whoever's they are. */
export function redact(text: string): string {
    return text
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1…@')
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 …')
}

/** A change to the roadmap in a line: who did what to which, and what it went from and to. */
export function describe(event: OrreryEvent): string {
    const who = event.by?.name ?? 'Someone'
    const subject = event.subject ?? ''
    const [family, what = ''] = event.type.split('.', 2) as [string, string?]
    const change = event.from !== undefined || event.to !== undefined ? `: ${event.from ?? 'none'} → ${event.to ?? 'none'}` : ''
    if (family === 'issue') {
        if (what === 'created') return `${who} made ${subject}`
        if (what === 'deleted') return `${who} deleted ${subject}`
        if (what === 'status') return `${who} moved ${subject}${change}`
        return `${who} changed ${subject}'s ${what}${change}`
    }
    if (family === 'comment') return what === 'asks' ? `${who} asked the owner for ${event.to ? `a ${event.to}` : 'an answer'} on ${subject}` : `${who} commented on ${subject}`
    const thing = family === 'release' ? `release ${subject}` : `${family} ${subject}`
    if (what === 'created') return `${who} made ${thing}`
    if (what === 'deleted') return `${who} deleted ${thing}`
    if (what === 'changed') return `${who} wrote ${thing}`
    return `${who} set ${thing} ${what}${change}`
}

const cut = (text: string, length: number) => text.length > length ? `${text.slice(0, length - 1)}…` : text

function eventOf(row: EventRow): LoggedEvent {
    return {
        id: row.id,
        level: row.level,
        kind: row.kind,
        ...row.project ? {project: row.project} : {},
        ...row.subject ? {subject: row.subject} : {},
        message: row.message,
        ...row.details ? {details: JSON.parse(row.details) as Record<string, unknown>} : {},
        count: row.count,
        first_seen: row.first_seen,
        last_seen: row.last_seen,
        ...row.resolved_at ? {resolved_at: row.resolved_at} : {},
    }
}
