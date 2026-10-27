// The event log (ORR-322): what Orrery did and what went wrong, kept in its own `events` table and never sent off
// the machine. Errors are recorded always; warnings and what Orrery did (sessions, launchers, schedules, backups,
// migrations) only while the owner has Advanced on in App settings, as most never look. The same event again,
// while it isn't resolved, counts on its row instead of taking another, so a loop can't fill the database; and old
// rows go: what Orrery did after a week, the rest after a month, and past MAX_ROWS the oldest.
import type {EventLevel, LoggedEvent} from '#shared/roadmap'
import {EVENT_LEVELS} from '#shared/roadmap'
import type {Db} from './database'
import {badRequest, notFound} from './input'

/** What's recorded: `details` is kept as JSON, each text in it cut to a few thousand characters. */
export interface EventEntry {
    level: EventLevel
    kind: string
    project?: string | null
    message: string
    details?: Record<string, unknown>
}

export interface EventFilter {
    /** One level or several, comma-separated. */
    level?: string
    /** A kind, or what it starts with up to a dot: `session` is every `session.…`. */
    kind?: string
    project?: string
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
/** The most rows kept, the oldest going first. */
export const MAX_ROWS = 5000
/** How often (in rows written) old ones are pruned, besides on start. */
const PRUNE_EVERY = 200
const MESSAGE = 1000
const TEXT = 4000
const KIND = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/

export class EventLog {
    /** `scrub` takes secrets' values out of what's kept; `onLogged` hears each event written, `fresh` when it's a row of its own. */
    constructor(
        private readonly db: Db,
        private readonly scrub: (text: string) => Promise<string> = async text => text,
        private readonly onLogged: (event: LoggedEvent, fresh: boolean) => void = () => {},
        private readonly now: () => Date = () => new Date(),
    ) {}

    private written = 0

    /** Whether the owner has Advanced on, so more than errors is recorded. */
    async advanced(): Promise<boolean> {
        const row = await this.db.get<{value: string}>("SELECT value FROM settings WHERE key = 'advanced'")
        return row ? JSON.parse(row.value) === true : false
    }

    /** Records it, or adds to the same one not yet resolved; null when it isn't kept (Advanced is off and it's no error). */
    async record(entry: EventEntry): Promise<LoggedEvent | null> {
        if (!EVENT_LEVELS.includes(entry.level)) throw badRequest(`"level" is "${entry.level}"; use ${EVENT_LEVELS.join(', ')}`)
        if (!KIND.test(entry.kind)) throw badRequest(`"kind" is "${entry.kind}"; use a dotted name, e.g. page.error`)
        if (entry.level !== 'error' && !await this.advanced()) return null
        const message = cut(redact(await this.scrub(entry.message.trim() || entry.kind)), MESSAGE)
        const details = entry.details ? JSON.stringify(await this.clean(entry.details)) : null
        const project = entry.project || null
        const at = this.now().toISOString()
        const again = await this.db.get<EventRow>(`UPDATE events SET count = count + 1, last_seen = ?, details = ?
            WHERE id = (SELECT id FROM events WHERE level = ? AND kind = ? AND coalesce(project, '') = ? AND message = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1)
            RETURNING *`, at, details, entry.level, entry.kind, project ?? '', message)
        const row = again ?? await this.db.get<EventRow>(`INSERT INTO events (level, kind, project, message, details, count, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?) RETURNING *`, entry.level, entry.kind, project, message, details, at, at)
        if (!row) return null
        if (++this.written % PRUNE_EVERY === 0) await this.prune()
        const event = eventOf(row)
        this.onLogged(event, !again)
        return event
    }

    /** Records it, saying so on the console rather than failing when it can't: logging never breaks what it logs. */
    note(entry: EventEntry) {
        this.record(entry).catch(error => console.error(`[orrery] logging ${entry.kind}:`, error))
    }

    /** Newest first (by when they were last seen). */
    async list(filter: EventFilter = {}): Promise<LoggedEvent[]> {
        const where: string[] = []
        const params: string[] = []
        if (filter.level) {
            const levels = filter.level.split(',').map(l => l.trim()).filter(Boolean)
            const wrong = levels.find(l => !EVENT_LEVELS.includes(l as EventLevel))
            if (wrong) throw badRequest(`"level" has "${wrong}"; use ${EVENT_LEVELS.join(', ')}`)
            where.push(`level IN (${levels.map(() => '?').join(', ')})`)
            params.push(...levels)
        }
        if (filter.kind) {
            where.push("(kind = ? OR kind LIKE ?)")
            params.push(filter.kind, `${filter.kind.replace(/[%_]/g, '')}.%`)
        }
        if (filter.project) {
            where.push('project = ?')
            params.push(filter.project)
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

    /** Marks it dealt with: the next one like it starts a row of its own. */
    async resolve(id: number): Promise<LoggedEvent> {
        const row = await this.db.get<EventRow>('UPDATE events SET resolved_at = coalesce(resolved_at, ?) WHERE id = ? RETURNING *', this.now().toISOString(), id)
        if (!row) throw notFound(`No event ${id}`)
        const event = eventOf(row)
        this.onLogged(event, false)
        return event
    }

    /** Lets go of what's old: what Orrery did after KEEP_INFO, the rest after KEEP_PROBLEMS, and past MAX_ROWS the oldest. */
    async prune(): Promise<number> {
        const now = this.now().getTime()
        const info = await this.db.run("DELETE FROM events WHERE level = 'info' AND last_seen < ?", new Date(now - KEEP_INFO).toISOString())
        const rest = await this.db.run("DELETE FROM events WHERE level <> 'info' AND last_seen < ?", new Date(now - KEEP_PROBLEMS).toISOString())
        const over = await this.db.run(`DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY last_seen DESC, id DESC LIMIT ${MAX_ROWS})`)
        return info.changes + rest.changes + over.changes
    }

    /** Its texts cut short and with no secret in them, any depth down. */
    private async clean(value: unknown, depth = 0): Promise<unknown> {
        if (typeof value === 'string') return cut(redact(await this.scrub(value)), TEXT)
        if (depth > 4 || value === null || typeof value !== 'object') return typeof value === 'bigint' ? Number(value) : value
        if (Array.isArray(value)) return Promise.all(value.slice(0, 50).map(v => this.clean(v, depth + 1)))
        const entries = await Promise.all(Object.entries(value).slice(0, 50).map(async ([k, v]) => [k, await this.clean(v, depth + 1)] as const))
        return Object.fromEntries(entries)
    }
}

/** Passwords in addresses (`postgres://me:…@host`) and bearer tokens, whoever's they are. */
export function redact(text: string): string {
    return text
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1…@')
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 …')
}

const cut = (text: string, length: number) => text.length > length ? `${text.slice(0, length - 1)}…` : text

function eventOf(row: EventRow): LoggedEvent {
    return {
        id: row.id,
        level: row.level,
        kind: row.kind,
        ...row.project ? {project: row.project} : {},
        message: row.message,
        ...row.details ? {details: JSON.parse(row.details) as Record<string, unknown>} : {},
        count: row.count,
        first_seen: row.first_seen,
        last_seen: row.last_seen,
        ...row.resolved_at ? {resolved_at: row.resolved_at} : {},
    }
}
