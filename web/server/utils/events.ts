// The one store the routes share, and the events it sends: `project` (the project, read again)
// after any change to it, `removed` (its id) once it's deleted, and `signal` (a Signal) when someone
// asks the sessions on a project to focus on an issue, `schedules` (the project) when its schedules
// change or run, `secrets` (the list, no values) when they change or one is used, and `logged` ({event, fresh}) when the
// event log records or resolves one. `/api/events` and the signal streams pass them on.
import {EventEmitter} from 'node:events'
import type {H3Event} from 'h3'
import type {LoggedEvent} from '#shared/roadmap'
import {EventLog} from './event-log'
import {Schedules} from './schedules'
import {Secrets} from './secrets'
import {Store} from './store'

export const projectEvents = new EventEmitter()
projectEvents.setMaxListeners(0)

let store: Store | null = null

/** Each project's latest re-read, so one that finishes after a newer one doesn't push a stale board. */
const reads = new Map<string, number>()

export function useStore(): Store {
    store ??= new Store(useDatabase(), id => {
        const read = (reads.get(id) ?? 0) + 1
        reads.set(id, read)
        useStore().project(id).then(project => {
            if (reads.get(id) === read) projectEvents.emit('project', project)
        }, error => {
            // Only a project that's gone is removed; any other failure leaves the pages as they are.
            if ((error as {statusCode?: number}).statusCode === 404) {
                reads.delete(id)
                projectEvents.emit('removed', id)
            } else console.error(`[orrery] reading ${id} again:`, error)
        })
    }, signal => projectEvents.emit('signal', signal), notice => projectEvents.emit('notice', notice), settings => projectEvents.emit('settings', settings))
    store.hears = hearing
    return store
}

let secrets: Secrets | null = null

/** The secrets, sealed with ORRERY_SECRET_KEY (NUXT_SECRET_KEY); `secrets` (the list) goes out when they change or one is used. */
export function useSecrets(): Secrets {
    secrets ??= new Secrets(useStore(), () => String(useRuntimeConfig().secretKey ?? ''), list => projectEvents.emit('secrets', list))
    return secrets
}

let log: EventLog | null = null

/** The event log, secrets' values scrubbed out of what it keeps. */
export function useEventLog(): EventLog {
    log ??= new EventLog(useDatabase(), text => useSecrets().scrub(text),
        (event: LoggedEvent, fresh: boolean) => projectEvents.emit('logged', {event, fresh}))
    return log
}

let schedules: Schedules | null = null

export function useScheduler(): Schedules {
    schedules ??= new Schedules(useStore(), project => projectEvents.emit('schedules', project), listening, (schedule, run, manual) => useEventLog().note({
        level: run.outcome === 'failed' ? 'error' : 'info',
        kind: run.outcome === 'skipped' ? 'schedule.skipped' : run.outcome === 'failed' ? 'schedule.failed' : 'schedule.ran',
        project: schedule.project,
        message: `${schedule.title}: ${run.outcome === 'made' ? `made ${run.issue}` : run.outcome}${run.note ? `, ${run.note}` : ''}`,
        details: {schedule: schedule.id, ...run, ...manual ? {manual} : {}},
    }))
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
