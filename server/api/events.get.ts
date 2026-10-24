import type {Project} from '#shared/roadmap'

// `GET /api/events` → server-sent events: `project` (a project read again, as JSON) when its
// roadmap changes and `removed` (its id) when it goes, so open pages update without a reload.
export default defineEventHandler(event => {
    const stream = createEventStream(event)
    const onProject = (project: Project) => stream.push({event: 'project', data: JSON.stringify(project)})
    const onRemoved = (id: string) => stream.push({event: 'removed', data: id})
    projectEvents.on('project', onProject)
    projectEvents.on('removed', onRemoved)
    // Keeps proxies and the browser from dropping a quiet connection.
    const ping = setInterval(() => stream.push({event: 'ping', data: ''}), 25_000)
    // The headers go out with the first event: without one, the browser waits to call it open.
    stream.push({event: 'ready', data: ''})

    stream.onClosed(async () => {
        clearInterval(ping)
        projectEvents.off('project', onProject)
        projectEvents.off('removed', onRemoved)
        await stream.close()
    })
    return stream.send()
})
