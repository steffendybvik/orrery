// The one store the routes share, and the events it sends: `project` (the project, read again)
// after any change to it and `removed` (its id) once it's deleted. `/api/events` passes them on.
import {EventEmitter} from 'node:events'
import type {H3Event} from 'h3'
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
    })
    return store
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
