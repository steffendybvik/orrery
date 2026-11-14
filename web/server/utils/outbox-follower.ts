// The local app following the board's outbox (ORR-983, step 4 of ORR-929's `rust-api-events`): what the Rust API's
// writes set off, read from its feed (`GET /api/changes?after=`) instead of from the reply headers the router relays.
// Dead code until the swap: it runs only while the API does (NUXT_API_BIN or NUXT_API_URL, plugins/outbox.ts), and with
// none set this server hears its own writes from the store's hooks, as ever. This server's own rows are skipped, as its
// hooks heard those in-process; the rest go to the same hooks, inside `relaying`, so none gets a second row.
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import type {Actor, Store} from './store'
import {projectEvents} from './events'
import {inDocker} from './backup-choice'

/** A row of the outbox, as the feed gives it. */
export interface Change {
    id: number
    kind: string
    project: string | null
    subject: string | null
    actor: string | null
    owner: boolean | number
    session: string | null
    untrusted: boolean | number
    payload: string | Record<string, unknown> | null
}

/** A page of the feed: the rows after a cursor, the id to ask after next, and `gap` when the cursor's row is gone. */
export interface Page {
    changes: Change[]
    last: number
    gap?: boolean
}

/** Where the follower keeps its cursor, with the database it's for: beside a SQLite file; on Postgres, in Docker's data
 * volume, as `orrery.key` is (ORR-1182: the image starts in `/`, where `.data` can't be made), else in `.data`. */
export function cursorFile(database: string, docker = inDocker()): string {
    if (!/^postgres(ql)?:\/\//.test(database)) return `${resolve(database)}.outbox-cursor.json`
    return docker ? '/data/outbox-cursor.json' : resolve('.data/outbox-cursor.json')
}

/** The cursor saved for `database`; none when there's none, or it's for another one (the owner moved it). */
export function readCursor(file: string, database: string): number | undefined {
    if (!existsSync(file)) return undefined
    try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as {database?: string, after?: number}
        return saved.database === database && Number.isInteger(saved.after) ? saved.after : undefined
    } catch {
        return undefined
    }
}

export function saveCursor(file: string, database: string, after: number) {
    mkdirSync(dirname(file), {recursive: true})
    writeFileSync(file, JSON.stringify({database, after}))
}

/** Whose a row is, as the store's hooks take an actor. */
function actorOf(change: Change, payload: Record<string, unknown>): Actor {
    return {
        name: change.actor ?? 'agent',
        owner: !!change.owner,
        ...change.session ? {session: change.session} : {},
        ...change.untrusted ? {untrusted: true} : {},
        ...typeof payload.person === 'string' ? {person: payload.person} : {},
    }
}

/** Tells the store's hooks what one row from elsewhere set off. A signal or a bell's notice is the API's row for a write
 * this server asked of it (ORR-1174), which it has passed on already (`signalled`, `handOn`), so it's left: delivering
 * one another server asked for is ORR-983's. */
async function apply(store: Store, change: Change) {
    const payload = (typeof change.payload === 'string' ? JSON.parse(change.payload) : change.payload ?? {}) as Record<string, unknown>
    if (change.kind === 'project.changed') {
        if (change.project) store.changed(change.project)
    } else if (change.kind === 'settings') {
        await store.settingsChanged()
    } else if (change.kind === 'epics') {
        store.epicsChanged()
    } else if (change.kind === 'schedules') {
        if (change.project) useScheduler().changedElsewhere(change.project)
    } else if (change.kind === 'event.logged') {
        // A line of the event log the API wrote or resolved (ORR-1088): open pages' bells hear it, a new one that's news
        // (`fresh`, said beside the line) counted again.
        const {fresh, ...event} = payload
        projectEvents.emit('logged', {event, fresh: fresh === true})
    } else if (change.kind === 'chat') {
        // A chat's messages the API added or changed (ORR-1100): this server runs the chat, so it reads them again.
        if (change.subject) await chatHeard(change.subject)
    } else if (change.kind === 'signal' || change.kind === 'notice') {
        // Passed on already, by the request that wrote it.
    } else if (change.project) {
        const text = (value: unknown) => typeof value === 'string' ? value : null
        store.told(change.kind, change.project, change.subject ?? '', actorOf(change, payload), {from: text(payload.from), to: text(payload.to)})
    }
}

/** Reads the board again after a gap: every project's page, the settings and the epics, as nothing says what was missed. */
async function readAgain(store: Store) {
    for (const {id} of await store.listProjects()) store.changed(id)
    await store.settingsChanged()
    store.epicsChanged()
}

/** Follows the feed from `after` (`newest` when there's no cursor, which the first page answers with the newest id), a
 * page at a time, until `stop`. `read` gets a page, or null while there's no API to read; `saved` keeps the cursor.
 * Pages come once a second, as the feed's own stream looks, or at once while there's more. */
export async function followOutbox(store: Store, options: {
    read: (after: number | 'newest') => Promise<Page | null>
    after: number | 'newest'
    saved: (after: number) => void
    stopped: () => boolean
    every?: number
}) {
    let after = options.after
    let failing = false
    // Those waiting on a page read after they asked (`caughtUp`), told once the feed has nothing more.
    const served: (() => void)[] = []
    while (!options.stopped()) {
        let full = false
        served.push(...waiting.splice(0))
        try {
            const page = await options.read(after)
            failing = false
            if (page) {
                await store.relaying(async () => {
                    if (page.gap) await readAgain(store)
                    for (const change of page.changes) if (!store.wroteChange(change.id)) await apply(store, change)
                })
                full = page.changes.length > 0 && after !== 'newest' && page.last > after
                if (page.last !== after) options.saved(after = page.last)
            }
        } catch (error) {
            if (!failing) console.warn("[orrery] can't read the Rust API's outbox, trying again:", (error as Error).message)
            failing = true
        }
        if (!full) {
            for (const done of served.splice(0)) done()
            if (!waiting.length) await new Promise<void>(resolve => {
                wake = resolve
                setTimeout(resolve, options.every ?? 1000)
            })
            wake = null
        }
    }
    for (const done of [...served, ...waiting.splice(0)]) done()
}

/** Who's waiting for the follower to read the outbox as it is now, and how to wake it from its pause. */
const waiting: (() => void)[] = []
let wake: (() => void) | null = null

/** Resolves once the follower has read every change in the outbox as it is now, so a write forwarded to the API is
 * told to open pages before its own reply goes back, as a write here is (ORR-1029): else the page that made it acts
 * on a board that doesn't have it yet. At once when not following; after `within` ms at most, so a feed that can't be
 * read never holds a reply. */
export function caughtUp(within = 2000): Promise<void> {
    if (!on) return Promise.resolve()
    return new Promise(resolve => {
        const timer = setTimeout(done, within)
        function done() {
            clearTimeout(timer)
            resolve()
        }
        waiting.push(done)
        wake?.()
    })
}

/** A page from the API at `url`, with its token and the mark of the database this server is on (`databaseMark`). */
export async function readPage(api: {url: string, token: string}, database: string, after: number | 'newest'): Promise<Page> {
    // This server's own work, so no login is checked (`OWN_WORK` in api-router.ts, which imports this file).
    const response = await fetch(`${api.url.replace(/\/+$/, '')}/api/changes?after=${after}`, {headers: {'Orrery-Api-Token': api.token, 'Orrery-Database': database, 'Orrery-Came': 'server'}})
    if (!response.ok) throw new Error(`the outbox answered ${response.status}`)
    return await response.json() as Page
}

/** Whether this server is following the outbox now, so the router leaves the reply headers to it. */
let on = false

export function followingOutbox(): boolean {
    return on
}

export function setFollowingOutbox(value: boolean) {
    on = value
}
