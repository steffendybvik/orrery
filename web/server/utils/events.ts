// The one store the routes share, and the events it sends: `project` (the project, read again)
// after any change to it, and `patch` (what changed in it since the last, see shared/patch.ts), `removed` (its id) once it's deleted, and `signal` (a Signal) when someone
// asks the sessions on a project to focus on an issue, `schedules` (the project) when its schedules
// change or run, `secrets` (the list, no values) when they change or one is used, `logged` ({event, fresh}) when the
// event log records or resolves one, and `happened` ({event, cause}) for what the schedules can run on (ORR-341), `cause`
// the schedule whose run did it. `/api/events` and the signal streams pass them on.
import {EventEmitter} from 'node:events'
import type {H3Event} from 'h3'
import type {OrreryEvent} from '#shared/happenings'
import type {LoggedEvent, Project} from '#shared/roadmap'
import {diffProject, withoutNotes} from '#shared/patch'
import type {Db} from './database'
import {EventLog} from './event-log'
import {GITHUB_SECRET, Pulls} from './pulls'
import {commentOnPull} from './pull-comments'
import {PullPoll} from './pull-poll'
import {Schedules, scheduleRunning} from './schedules'
import {Secrets} from './secrets'
import {Store} from './store'

export const projectEvents = new EventEmitter()
projectEvents.setMaxListeners(0)

let store: Store | null = null

/** The projects being read again: `again` when another change came in during the read, so a burst of writes reads
 * each project once more when the read in hand finishes, not once per write (ORR-440). */
const reading = new Map<string, 'reading' | 'again'>()

/** Each project as it was last pushed, without its issues' notes, and its revision, which the next `patch` is made from
 * (ORR-440); and, once a patch was made from it, each issue's JSON, so the next needn't write the old project out again
 * (ORR-483). */
const pushed = new Map<string, {rev: number, project: Project, issues?: Map<string, string>}>()

/** Labels the projects a page reads whole, from a read that starts now, with the revision the patches after it build
 * on: each one's as it is now, before the read (ORR-482). A push while it's read is then still newer than the label,
 * and the page takes its patch; labelled once the read was done, the older read would have the newer revision, and
 * the page would drop the patch it lacks. One not pushed since the server started is kept as revision 0, so the first
 * change to it is a patch from what the page read, not the whole project; but not while it's being read again, as
 * that read may be older or newer than this one: its push is then the whole project, which any page can take. */
export function revLabel(): (project: Project) => Project & {rev: number} {
    const revs = new Map([...pushed].map(([id, last]) => [id, last.rev]))
    return project => {
        if (!pushed.has(project.id) && !reading.has(project.id)) pushed.set(project.id, {rev: 0, project: withoutNotes(project)})
        return {...project, rev: revs.get(project.id) ?? 0}
    }
}

/** Reads `id` again and pushes it, as `project` and as a `patch` from the last push. Exported for its tests. */
export function reread(id: string) {
    if (reading.has(id)) {
        reading.set(id, 'again')
        return
    }
    reading.set(id, 'reading')
    useStore().project(id).then(project => {
        const last = pushed.get(id)
        const rev = (last?.rev ?? 0) + 1
        // The page reads an issue's notes on its own page (ORR-439); a changed issue says so by its `updated_at`.
        const bare = withoutNotes(project)
        const issues = new Map<string, string>()
        pushed.set(id, {rev, project: bare, issues})
        projectEvents.emit('project', project)
        projectEvents.emit('patch', diffProject(last?.project, bare, last?.rev ?? 0, rev, {before: last?.issues, after: issues}))
    }, error => {
        // Only a project that's gone is removed; any other failure leaves the pages as they are.
        if ((error as {statusCode?: number}).statusCode === 404) {
            pushed.delete(id)
            projectEvents.emit('removed', id)
        } else console.error(`[orrery] reading ${id} again:`, error)
    }).finally(() => {
        const again = reading.get(id) === 'again'
        reading.delete(id)
        if (again) reread(id)
    })
}

export function useStore(): Store {
    store ??= new Store(useDatabase(), reread, signal => projectEvents.emit('signal', signal), notice => projectEvents.emit('notice', notice), settings => projectEvents.emit('settings', settings))
    store.hears = hearing
    store.happened = changed
    return store
}

let secrets: Secrets | null = null

/** The secrets, sealed with ORRERY_SECRET_KEY (NUXT_SECRET_KEY); `secrets` (the list) goes out when they change or one is used. */
export function useSecrets(): Secrets {
    secrets ??= new Secrets(useStore(), () => String(useRuntimeConfig().secretKey ?? ''), list => projectEvents.emit('secrets', list), undefined,
        entry => useEventLog().note(entry))
    return secrets
}

let pulls: Pulls | null = null

/** Issues' open pull requests, read from GitHub with the GITHUB_TOKEN secret when there's one that may go there. */
export function usePulls(): Pulls {
    pulls ??= new Pulls(useStore(), (url, project, headers, init) => useSecrets().own(url, GITHUB_SECRET, project, headers, init))
    return pulls
}

let pullPoll: PullPoll | null = null

/** The background poll of the projects' pull requests: each change goes out as `pull-change` (a `PullChange`), and one
 * that's told is said on its issue (pull-comments.ts). */
export function usePullPoll(): PullPoll {
    pullPoll ??= new PullPoll(useStore(), usePulls(), project => useSecrets().ownsFor('https://api.github.com/graphql', GITHUB_SECRET, project),
        change => {
            projectEvents.emit('pull-change', change)
            void commentOnPull(useStore(), change)
        }, entry => useEventLog().note(entry))
    return pullPoll
}

let log: EventLog | null = null

/** The event log, secrets' values scrubbed out of what it keeps. */
export function useEventLog(): EventLog {
    if (!log) {
        const made = new EventLog(useDatabase(), () => useSecrets().scrubber(),
            (event: LoggedEvent, fresh: boolean) => projectEvents.emit('logged', {event, fresh}))
        // Advanced and the secrets are read once, and again after either changes.
        projectEvents.on('settings', () => made.forget())
        projectEvents.on('secrets', () => made.forget())
        log = made
    }
    log.happened = happened
    return log
}

/** Points what holds the database at the one the owner moved to (server/utils/move.ts); the secrets and schedules
 * reach it through the store. It gets the presets orrery ships that it hasn't had yet, as a start would give it. */
export function rebindDatabase(db: Db) {
    if (store) store.db = db
    if (log) log.db = db
    store?.seedPresets().catch(error => console.error('[orrery] adding the presets orrery ships:', error))
}

/** Passes it on once what did it is done (the write's transaction has committed, and nothing when it rolls back),
 * with the schedule whose run did it, if one did. */
function happened(event: OrreryEvent) {
    const cause = scheduleRunning.getStore()
    useDatabase().afterCommit(() => projectEvents.emit('happened', {event, cause}))
}

/** A change to the roadmap: the schedules hear it, and the event log keeps it (ORR-378), once its write has
 * committed. The log's own kinds go through `happened` alone, as it records them itself. */
function changed(event: OrreryEvent) {
    happened(event)
    const cause = scheduleRunning.getStore()
    useDatabase().afterCommit(() => useEventLog().activity(event, cause)
        .catch(error => console.error(`[orrery] logging ${event.type}:`, error)))
}

let schedules: Schedules | null = null

export function useScheduler(): Schedules {
    schedules ??= new Schedules(useStore(), {
        onChange: project => projectEvents.emit('schedules', project),
        listening,
        startUntrusted,
        onRan: (schedule, run, manual) => useEventLog().note({
            level: run.outcome === 'failed' ? 'error' : 'info',
            kind: run.outcome === 'skipped' ? 'schedule.skipped' : run.outcome === 'failed' ? 'schedule.failed' : 'schedule.ran',
            project: schedule.project,
            message: `${schedule.title}: ${run.outcome === 'made' ? `made ${run.issue}` : run.outcome}${run.note ? `, ${run.note}` : ''}`,
            details: {schedule: schedule.id, ...run, ...manual ? {manual} : {}},
        }),
        startSession: async (project, {presets, instructions, issue, release}, actor) =>
            await startLaunch(project, {issue, release, context: await contextFor(project, presets, instructions), actor}),
    })
    return schedules
}

/** A count per project of things that are there until they say they're done (a listening session, a
 * launcher), emitting `event` with the project each time it changes. `done` counts once however often it's called. */
export function counter(event: string) {
    const counts = new Map<string, number>()
    const count = (project: string): number => counts.get(project) ?? 0
    const add = (project: string): (() => void) => {
        counts.set(project, count(project) + 1)
        projectEvents.emit(event, project)
        let counted = true
        return () => {
            if (!counted) return
            counted = false
            counts.set(project, Math.max(0, count(project) - 1))
            projectEvents.emit(event, project)
        }
    }
    return {count, add}
}

const listeners = counter('listeners')
/** How many sessions are listening for each project's signals right now. */
export const listening = listeners.count
/** Counts a listener in until `done` is called. */
export const listen = listeners.add

/** A route's `:name` part, decoded. */
export function param(event: H3Event, name: string): string {
    return decoded(getRouterParam(event, name) ?? '')
}

/** A part of an address, decoded; as it is when it's no valid escape (`ORR-%E0`), so it's simply not found. */
export function decoded(part: string): string {
    try {
        return decodeURIComponent(part)
    } catch {
        return part
    }
}

export function commentId(event: H3Event): number {
    const id = Number(param(event, 'comment'))
    if (!Number.isInteger(id)) throw notFound(`No comment ${param(event, 'comment')}`)
    return id
}

export function scheduleId(event: H3Event): number {
    const id = Number(param(event, 'schedule'))
    if (!Number.isInteger(id)) throw notFound(`No schedule ${param(event, 'schedule')}`)
    return id
}

/** Answers a create with 201 Created. */
export function created<T>(event: H3Event, value: T): T {
    setResponseStatus(event, 201)
    return value
}

/** Answers a delete with 204 No Content. */
export function deleted(event: H3Event): null {
    setResponseStatus(event, 204)
    return null
}
