import type {Project, Signal} from '#shared/roadmap'

// `GET /api/events` → server-sent events: `project` (a project read again, as JSON) when its
// roadmap changes, `removed` (its id) when it goes, and `listeners` ({project, count}) when a session
// starts or stops listening for its signals, so open pages update without a reload.
export default defineEventHandler(event => {
    const stream = createEventStream(event)
    const onProject = (project: Project) => stream.push({event: 'project', data: JSON.stringify(project)})
    const onRemoved = (id: string) => stream.push({event: 'removed', data: id})
    const onListeners = (project: string) => stream.push({event: 'listeners', data: JSON.stringify({project, count: listening(project)})})
    const onSessions = (project: string) => stream.push({event: 'sessions', data: JSON.stringify({project, sessions: listSessions(project)})})
    const onSignal = (signal: Signal) => stream.push({event: 'signal', data: JSON.stringify(signal)})
    projectEvents.on('project', onProject)
    projectEvents.on('removed', onRemoved)
    projectEvents.on('listeners', onListeners)
    projectEvents.on('sessions', onSessions)
    projectEvents.on('signal', onSignal)
    // Keeps proxies and the browser from dropping a quiet connection.
    const ping = setInterval(() => stream.push({event: 'ping', data: ''}), 25_000)
    // The headers go out with the first event: without one, the browser waits to call it open. It
    // carries the build, so a tab left open across an update reloads into the new one.
    stream.push({event: 'ready', data: String(useRuntimeConfig().app.buildId ?? '')})

    stream.onClosed(async () => {
        clearInterval(ping)
        projectEvents.off('project', onProject)
        projectEvents.off('removed', onRemoved)
        projectEvents.off('listeners', onListeners)
        projectEvents.off('sessions', onSessions)
        projectEvents.off('signal', onSignal)
        await stream.close()
    })
    return stream.send()
})
