// The event log (ORR-322): what orrery did and what went wrong, kept in its own `events` table and never sent off
// the machine. Errors are recorded always; warnings, what orrery did (sessions, launchers, schedules, backups,
// migrations) and the changes to the roadmap (ORR-378: issues, comments, milestones, docs, releases) only while the owner
// has Advanced on in App settings, as most never look. Each is a row of its own, as the owner reads it line by line
// (ORR-378); a repeat of an error that isn't resolved is no news, to the bell or the schedules, and resolving one
// resolves its repeats. Old rows go: info after a week, the rest after a month, and past MAX_ROWS (MAX_ACTIVITY for
// the roadmap's, so a busy day can't push errors out) the oldest, so a loop can't fill the database.
// With the Rust API in front, it's the table's one writer (ORR-1088): a line is made here (scrubbed, cut, Advanced
// checked) and sent there (`PUT /api/events/log/lines`), which checks for a repeat, writes it, puts it in the outbox for
// open pages' bells and prunes. Only while the API can't be reached is a line written here, marked `details.local`, so
// the API's own outage (`api.unreachable`) and the errors around it are still kept. Reading the log and resolving a
// line are the API's alone (`GET /api/events/log`, `POST /api/events/log/:event/resolve`), and Advanced is read from
// its settings (ORR-1143).
import type {OrreryEvent} from '#shared/happenings'
import type {EventLevel, LoggedEvent} from '#shared/roadmap'
import {ACTIVITY_FAMILIES, EVENT_LEVELS} from '#shared/roadmap'
import type {Db} from './database'
import {badRequest} from './input'

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

/** A finished line, as it's sent to the API: its texts scrubbed and cut. `activity`: a change to the roadmap, always news. */
interface Line {
    level: EventLevel
    kind: string
    project?: string
    subject?: string
    message: string
    details?: Record<string, unknown>
    activity?: true
}

/** Sends a write to the Rust API (`writeToApi`): its reply, or undefined with no API set up; throws a 503 while it can't
 * be reached. */
export type SendToApi = (method: string, path: string, body?: unknown) => Promise<unknown>

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
    resolved_by: string | null
}

const DAY = 24 * 60 * 60 * 1000
/** How long what orrery did is kept, and how long warnings and errors are. */
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
        /** The Rust API, the table's one writer when it's there; none in the tests that don't say. */
        private readonly send: SendToApi = async () => undefined,
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

    /** Whether the owner has Advanced on, so more than errors is recorded: read from the API's settings, or the table
     * here with no API set up or while it can't be reached (ORR-1143). */
    advanced(): Promise<boolean> {
        const known = this.read()
        known.advanced ??= this.send('GET', '/api/settings').catch(error => {
            if ((error as {statusCode?: number}).statusCode !== 503) throw error
            return undefined
        }).then(async sent => sent
            ? (sent as {advanced?: unknown}).advanced !== false
            : await this.db.get<{value: string}>("SELECT value FROM settings WHERE key = 'advanced'").then(row => row ? JSON.parse(row.value) === true : true))
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
        const details = entry.details ? clean(entry.details, scrub) as Record<string, unknown> : undefined
        const project = entry.project || null
        const written = await this.keep({level: entry.level, kind: entry.kind, ...project ? {project} : {}, message, ...details ? {details} : {}})
        const {event, fresh} = written
        // Its message isn't passed on: an error's can hold what a page or another site sent. Its row is, to read.
        // What orrery did is passed on each time: each is news.
        if (fresh || entry.level === 'info') this.happened({type: entry.kind, level: entry.level, subject: `event ${event.id}`, ...project ? {project} : {}, ...entry.untrusted ? {untrusted: true} : {}})
        return event
    }

    /** Records it, saying so on the console rather than failing when it can't: logging never breaks what it logs. */
    note(entry: EventEntry): Promise<unknown> {
        return this.record(entry).catch(error => console.error(`[orrery] logging ${entry.kind}:`, error))
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
        return (await this.keep({level: 'info', kind: event.type, ...event.project ? {project: event.project} : {}, ...event.subject ? {subject: event.subject} : {},
            message, ...Object.keys(details).length ? {details} : {}, activity: true})).event
    }

    /** Writes a finished line: sent to the API, its one writer, which puts it in the outbox for open pages' bells.
     * Here only with no API set up, or while it can't be reached, marked `details.local` (ORR-1088): the API's own
     * outage is logged through here too, and a line that can't be kept there isn't lost. `fresh` unless it repeats one
     * not resolved yet (same level, kind, project and message), as a change to the roadmap never does. */
    private async keep(line: Line): Promise<{event: LoggedEvent, fresh: boolean}> {
        let local = false
        try {
            const sent = await this.send('PUT', '/api/events/log/lines', line) as {event: LoggedEvent, fresh: boolean} | undefined
            if (sent) return sent
        } catch (error) {
            if ((error as {statusCode?: number}).statusCode !== 503) throw error
            local = true
        }
        const details = local ? {...line.details, local: true} : line.details
        const at = this.now().toISOString()
        const again = !line.activity && !!await this.db.get(`SELECT id FROM events WHERE level = ? AND kind = ? AND coalesce(project, '') = ? AND message = ?
            AND resolved_at IS NULL LIMIT 1`, line.level, line.kind, line.project ?? '', line.message)
        const row = await this.db.get<EventRow>(`INSERT INTO events (level, kind, project, subject, message, details, count, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING *`, line.level, line.kind, line.project ?? null, line.subject ?? null, line.message,
            details ? JSON.stringify(details) : null, at, at)
        if (!row) throw new Error(`The event log kept no row for ${line.kind}`)
        if (++this.written % PRUNE_EVERY === 0) await this.pruneHere()
        const event = eventOf(row)
        this.onLogged(event, !again)
        return {event, fresh: !again}
    }

    /** Lets go of what's old: info after KEEP_INFO, the rest after KEEP_PROBLEMS, and the oldest past MAX_ACTIVITY
     * changes to the roadmap and past MAX_ROWS of the rest, so many changes can't push an error out. The API's to do
     * when it's there (ORR-1088); while it can't be reached, nothing goes until the next time. */
    async prune(): Promise<number> {
        try {
            const sent = await this.send('POST', '/api/events/log/prune') as {pruned: number} | undefined
            if (sent) return sent.pruned
        } catch (error) {
            if ((error as {statusCode?: number}).statusCode === 503) return 0
            throw error
        }
        return this.pruneHere()
    }

    /** `prune`, on the table here. */
    private async pruneHere(): Promise<number> {
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
 * query, and why, with the permissions table's row that refused it when `authorize` did (ORR-512). Null for what isn't one, and for a start the launches route logs itself (`session.refused`). */
export function refusal(status: number, method: string, path: string, message: string, actor?: string, permission?: string): EventEntry | null {
    if (status !== 403 && status !== 409) return null
    const route = path.split('?')[0] ?? path
    if (status === 409 && method === 'POST' && /^\/api\/projects\/[^/]+\/launches\/?$/.test(route)) return null
    const project = /^\/api\/projects\/([^/]+)/.exec(route)?.[1]
    return {
        level: 'warn', kind: 'request.refused', ...project ? {project: decodeURIComponent(project)} : {},
        message: `Refused ${actor || 'agent'} ${method} ${route}: ${message}`,
        details: {route: `${method} ${route}`, status, by: actor || 'agent', ...permission ? {permission} : {}},
    }
}

/** Passwords in addresses (`postgres://me:…@host`, with no user or an `@` in the password too), as a setting
 * (`?password=…`, `host=db password=…`), and bearer tokens, whoever's they are. */
export function redact(text: string): string {
    return text
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s/]+@/gi, '$1…@')
        .replace(/\b(password\s*=\s*)('[^']*'|"[^"]*"|[^\s&'"]+)/gi, '$1…')
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
        ...row.resolved_by ? {resolved_by: row.resolved_by} : {},
    }
}
