// The one store the routes share, and the events it sends: `project` (the project, read again)
// after any change to it, `removed` (its id) once it's deleted, and `signal` (a Signal) when someone
// asks the sessions on a project to focus on an issue, and `schedules` (the project) when its schedules
// change or run. `/api/events` and the signal streams pass them on.
import {EventEmitter} from 'node:events'
import type {H3Event} from 'h3'
import {Schedules} from './schedules'
import {Store} from './store'

export const projectEvents = new EventEmitter()
projectEvents.setMaxListeners(0)

let store: Store | null = null

export function useStore(): Store {
    store ??= new Store(useDb(), id => {
        let project
        try {
            project = store!.project(id)
        } catch {
            projectEvents.emit('removed', id)
            return
        }
        projectEvents.emit('project', project)
    }, signal => projectEvents.emit('signal', signal), notice => projectEvents.emit('notice', notice))
    return store
}

let schedules: Schedules | null = null

export function useScheduler(): Schedules {
    schedules ??= new Schedules(useStore(), project => projectEvents.emit('schedules', project), listening)
    return schedules
}

/** How many sessions are listening for each project's signals right now. */
const listeners = new Map<string, number>()

export function listening(project: string): number {
    return listeners.get(project) ?? 0
}

/** Counts a listener in until `done` is called. */
export function listen(project: string): () => void {
    listeners.set(project, listening(project) + 1)
    projectEvents.emit('listeners', project)
    let counted = true
    return () => {
        if (!counted) return
        counted = false
        listeners.set(project, Math.max(0, listening(project) - 1))
        projectEvents.emit('listeners', project)
    }
}

/** A route's `:name` part, decoded. */
export function param(event: H3Event, name: string): string {
    return decodeURIComponent(getRouterParam(event, name) ?? '')
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
